// Reads your private "Personal Game Data" match history pages on Steam Community
// (steamcommunity.com/my/gcpd/730/?tab=matchhistoryscrimmage …). That is the only place Valve lists
// Scrimmage and Rush replays. Uses a dedicated, persistent Electron session that you sign in to once
// through Steam's own login page; the app never sees your password.
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:steamcommunity';
const BASE = 'https://steamcommunity.com/my/gcpd/730/';

class SignedOut extends Error {
  constructor() { super('Not signed in to Steam Community. Click "Sign in to Steam" in the Downloads tab.'); this.signedOut = true; }
}

const isLoginUrl = u => /steamcommunity\.com\/login|store\.steampowered\.com\/login/.test(u);
const isGcpdUrl = u => /steamcommunity\.com\/(id|profiles)\/[^/]+\/gcpd\/730/.test(u);

const STEAM_DOMAIN = /(^|\.)(steamcommunity\.com|steampowered\.com)$/;
const KEEP_DAYS = 60;

// Cookies that make up a Steam login (names only are ever logged, never values).
const LOGIN_COOKIES = new Set(['steamLoginSecure', 'steamRefresh_steam', 'sessionid', 'steamCountry']);
let cookieLog = () => {};

// Steam's login cookies (steamLoginSecure, sessionid…) are session cookies, which Chromium drops
// when the app closes. Re-save them with an expiry date so the sign-in survives restarts.
async function persistCookie(c) {
  const host = c.domain.replace(/^\./, '');
  if (!c.session || !STEAM_DOMAIN.test(host)) return;
  try {
    await session.fromPartition(PARTITION).cookies.set({
      url: `https://${host}${c.path || '/'}`,
      name: c.name, value: c.value, path: c.path || '/',
      ...(c.hostOnly ? {} : { domain: c.domain }),
      secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite || 'unspecified',
      expirationDate: Math.floor(Date.now() / 1000) + KEEP_DAYS * 86400,
    });
  } catch (e) {
    cookieLog(`could not keep cookie ${c.name} (${host}): ${e.message}`);
  }
}

async function persistCookies() {
  const ses = session.fromPartition(PARTITION);
  for (const c of await ses.cookies.get({})) await persistCookie(c);
  await ses.cookies.flushStore();
}

// Called once at startup: keeps every Steam cookie as soon as it is set (including renewed login
// tokens) and logs when a login cookie disappears, so a lost sign-in can be explained.
let flushTimer = null;
function watchCookies(log) {
  cookieLog = log;
  const ses = session.fromPartition(PARTITION);
  ses.cookies.on('changed', (_e, c, cause, removed) => {
    if (!STEAM_DOMAIN.test(c.domain.replace(/^\./, ''))) return;
    if (removed) {
      if (cause !== 'overwrite' && LOGIN_COOKIES.has(c.name)) log(`login cookie ${c.name} removed (${cause})`);
      return;
    }
    if (c.session) persistCookie(c);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => ses.cookies.flushStore().catch(() => {}), 1000);
  });
}

async function loginCookieSummary() {
  const cs = await session.fromPartition(PARTITION).cookies.get({});
  return cs.filter(c => LOGIN_COOKIES.has(c.name)).map(c => `${c.name}@${c.domain}${c.session ? '(session)' : ''}`).join(', ') || 'none';
}

// Opens Steam's login page (password or QR + Steam Guard happen there); resolves true once Steam has
// sent you back to your match history. The window is only closed after that page has fully loaded,
// never in the middle of Steam's redirects.
// A standalone window (not a modal child): closing modal children on Windows is fragile in Electron.
function signIn(log = () => {}) {
  return new Promise(resolve => {
    const w = new BrowserWindow({
      width: 520, height: 780, autoHideMenuBar: true, title: 'Sign in to Steam',
      backgroundColor: '#171a21',
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const where = u => { try { const x = new URL(u); return x.host + x.pathname; } catch { return '?'; } };
    let done = false;
    const finish = async ok => {
      if (done) return;
      done = true;
      if (ok) await persistCookies().catch(e => log('persistCookies failed', e.message));
      log('sign-in finished', ok, '- login cookies:', await loginCookieSummary().catch(() => '?'));
      setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 50);
      resolve(ok);
    };
    w.webContents.on('did-navigate', (_e, url) => log('sign-in page', where(url)));
    w.webContents.on('render-process-gone', (_e, d) => log('sign-in page crashed', d.reason));
    w.webContents.setWindowOpenHandler(({ url }) => { log('sign-in popup blocked', where(url)); return { action: 'deny' }; });
    w.webContents.on('did-stop-loading', () => {
      if (!w.isDestroyed() && isGcpdUrl(w.webContents.getURL())) setTimeout(() => finish(true), 300);
    });
    w.on('closed', () => { if (!done) { done = true; log('sign-in window closed by user'); resolve(false); } });
    w.loadURL(`https://steamcommunity.com/login/home/?goto=${encodeURIComponent('my/gcpd/730/?tab=matchhistoryscrimmage')}`);
  });
}

async function signOut() {
  await session.fromPartition(PARTITION).clearStorageData();
}

// Loads a URL and lets Steam finish any client-side redirects (it refreshes expired logins with a
// JS redirect through login.steampowered.com). Resolves with the final URL.
async function settle(w, url, ms = 12000) {
  await w.loadURL(url).catch(() => {}); // aborted loads (redirects) are fine
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (isGcpdUrl(w.webContents.getURL()) && !w.webContents.isLoading()) break;
    await new Promise(r => setTimeout(r, 250));
  }
  return w.webContents.getURL();
}

// Runs inside the Steam page. Clicks "Load More History" while the newest batch still has replay
// links (older matches have expired demos anyway), then extracts one record per match.
const EXTRACT = maxLoads => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const DATE = /\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} GMT/;
  const rows = () => [...document.querySelectorAll('tr')].filter(tr => tr.children.length >= 2 && DATE.test(tr.children[0].innerText || ''));
  const hasLink = list => list.some(r => r.querySelector('a[href*=".dem"]'));
  let batch = rows();
  for (let i = 0; i < ${maxLoads} && hasLink(batch); i++) {
    const btn = document.querySelector('#load_more_clickable');
    if (!btn || btn.offsetParent === null) break;
    const before = rows().length;
    btn.click();
    for (let t = 0; t < 40 && rows().length === before; t++) await sleep(250);
    batch = rows().slice(before);
  }
  const tabs = [...document.querySelectorAll('a[href*="tab=matchhistory"]')].map(a => ({ id: new URL(a.href).searchParams.get('tab'), label: a.innerText.trim() }));
  const matches = rows().map(tr => {
    const left = tr.children[0], right = tr.children[1];
    const cells = [...left.querySelectorAll('td')].map(td => td.innerText.trim()).filter(Boolean);
    const date = (cells.find(c => DATE.test(c)) || '').match(DATE)?.[0] || null;
    const times = cells.filter(c => !DATE.test(c) && /\\d+:\\d{2}\\s*$/.test(c));
    const score = (right.innerText.match(/(\\d+)\\s*:\\s*(\\d+)/) || []).slice(1).map(Number);
    const players = [...new Set([...right.querySelectorAll('a[href*="/id/"], a[href*="/profiles/"]')].map(a => a.innerText.trim()).filter(Boolean))];
    return {
      label: cells[0] || '', date,
      duration: times.length ? times[times.length - 1].match(/(\\d+:\\d{2})\\s*$/)[1] : null,
      link: tr.querySelector('a[href*=".dem"]')?.href || null,
      score, players,
    };
  });
  return { url: location.href, tabs, matches };
})()`;

class Community {
  constructor() { this.win = null; }

  window() {
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    }
    return this.win;
  }

  async scrape(tab, maxLoads) {
    const w = this.window();
    const target = `${BASE}?tab=${tab}&l=english`;
    let url = await settle(w, target);
    if (!isGcpdUrl(url)) {
      // Login token expired: ask Steam to refresh it from the long-lived "remember me" cookie.
      url = await settle(w, `https://login.steampowered.com/jwt/refresh?redir=${encodeURIComponent(target)}`);
    }
    if (isLoginUrl(url) || !isGcpdUrl(url)) throw new SignedOut();
    return w.webContents.executeJavaScript(EXTRACT(maxLoads));
  }

  // Returns parsed matches from every match-history tab that has replays (Scrimmage, Rush, Premier…).
  async fetchAll({ maxLoads = 4 } = {}) {
    try {
      const first = await this.scrape('matchhistoryscrimmage', maxLoads);
      const tabs = first.tabs.filter(t => t.id && t.id !== 'matchhistoryscrimmage');
      const results = [{ tab: { id: 'matchhistoryscrimmage', label: 'Scrimmage Matches' }, ...first }];
      for (const tab of tabs) {
        try { results.push({ tab, ...(await this.scrape(tab.id, maxLoads)) }); } catch (e) { if (e.signedOut) throw e; }
      }
      await persistCookies().catch(() => {}); // keep any refreshed login token
      // Only matches whose replay can still be downloaded (older ones have expired on Valve's side).
      return results.flatMap(r => r.matches.filter(m => m.link).map(m => toEntry(r.tab, m)));
    } finally {
      const w = this.win;
      this.win = null;
      // Destroy on the next tick, never while a navigation callback is still running.
      if (w && !w.isDestroyed()) setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 100);
    }
  }
}

function toEntry(tab, m) {
  const mode = tab.label.replace(/\s*Matches$/i, '').trim() || tab.id.replace(/^matchhistory/, '');
  const u = m.link && /replay(\d+)\.valve\.net\/730\/([0-9_]+)\.dem/.exec(m.link);
  const [min, sec] = (m.duration || '').split(':').map(Number);
  // The label reads "<queue> <map>", e.g. "Competitive Dust II".
  const mapLabel = m.label.replace(/^(Premier|Competitive|Wingman|Scrimmage|Rush|Casual|Deathmatch|Ranked)\s+/i, '');
  return {
    source: 'community',
    id: u ? `match730_${u[2]}_${u[1]}` : `community_${tab.id}_${m.date}`,
    fileBase: u ? `match730_${u[2]}_${u[1]}` : null,
    url: m.link,
    time: m.date ? Date.parse(m.date.replace(' GMT', 'Z').replace(' ', 'T')) : null,
    mode, mapLabel,
    score: m.score,
    rounds: m.score.length === 2 ? m.score[0] + m.score[1] : null,
    durationMin: Number.isFinite(min) ? Math.round(min + (sec || 0) / 60) : null,
    players: m.players,
  };
}

module.exports = { Community, signIn, signOut, watchCookies, loginCookieSummary, PARTITION, EXTRACT, toEntry };
