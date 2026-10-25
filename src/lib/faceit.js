// FACEIT matches. The match list comes from faceit.com's own web API (the endpoints its pages use).
// Demos are private on FACEIT's cloud and the signed link may need a captcha, so DemoLab never asks
// for that link itself: it opens the match room in a window of a dedicated, persistent session that
// you signed in to once, you click FACEIT's own "Watch demo", and DemoLab catches that download,
// unpacks it (.dem.zst / .dem.gz) and puts it next to your other demos.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:faceit';
const SITE = 'https://www.faceit.com';
const HISTORY_DAYS = 60;
const HISTORY_SIZE = 30;
const ROOM_TIMEOUT = 15 * 60000;

const ses = () => session.fromPartition(PARTITION);
const isFaceitPage = u => { try { return /(^|\.)faceit\.com$/.test(new URL(u).hostname); } catch { return false; } };
const roomUrl = matchId => `${SITE}/en/cs2/room/${matchId}`;
const prettyMap = id => (id || '').replace(/^(de|cs|ar)_/, '').replace(/^./, c => c.toUpperCase());
// What the history endpoint expects: ISO time with a "+0000" suffix.
const stamp = t => new Date(t).toISOString().replace(/\.\d+Z$/, '+0000');

async function api(url) {
  const res = await ses().fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) { const e = new Error('Not signed in to FACEIT.'); e.signedOut = true; throw e; }
  if (res.status === 429) throw new Error('FACEIT is rate limiting requests. Try again in a minute.');
  if (!res.ok) throw new Error(`FACEIT answered HTTP ${res.status}.`);
  const j = await res.json();
  return j?.payload ?? j;
}

// The signed-in FACEIT account: { id, nickname } or null when signed out.
async function me() {
  try {
    const p = await api(`${SITE}/api/users/v1/sessions/me`);
    const u = p?.user || p;
    return u?.id ? { id: u.id, nickname: u.nickname || '' } : null;
  } catch (e) {
    if (e.signedOut) return null;
    throw e;
  }
}

// Opens faceit.com; resolves with the account once FACEIT says you are signed in, or null if you
// close the window first. Popups stay allowed: FACEIT's login can hand off to Steam / Google there.
function signIn(log = () => {}) {
  return new Promise(resolve => {
    const w = new BrowserWindow({
      width: 1100, height: 820, autoHideMenuBar: true, title: 'Sign in to FACEIT', backgroundColor: '#1f1f1f',
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let done = false;
    const finish = account => {
      if (done) return;
      done = true;
      clearInterval(poll);
      log('FACEIT sign-in finished', account ? account.nickname || account.id : 'without an account');
      setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 50);
      resolve(account);
    };
    const poll = setInterval(async () => {
      const a = await me().catch(() => null);
      if (a) finish(a);
    }, 2500);
    w.on('closed', async () => { if (!done) finish(await me().catch(() => null)); });
    w.loadURL(`${SITE}/en/login`).catch(() => {});
  });
}

async function signOut() {
  await ses().clearStorageData();
}

// Map, score and players of one match, from the same payload FACEIT's match room uses.
async function matchInfo(matchId) {
  const p = await api(`${SITE}/api/match/v2/match/${encodeURIComponent(matchId)}`);
  const results = Array.isArray(p.results) ? p.results[0] : p.results;
  const sc = p.detailedResults?.[0]?.factions || results?.factions;
  const score = [sc?.faction1?.score, sc?.faction2?.score].map(Number);
  const map = p.voting?.map?.pick?.[0] || null;
  const players = ['faction1', 'faction2'].flatMap(f => (p.teams?.[f]?.roster || []).map(r => r.nickname)).filter(Boolean);
  const time = Date.parse(p.startedAt || p.configuredAt || '') || null;
  return {
    url: p.demoURLs?.[0] || null,
    map, mapLabel: map ? prettyMap(map) : '',
    score: score.every(Number.isFinite) ? score : [],
    players, time, competition: p.competitionName || '',
    finished: p.status ? p.status === 'FINISHED' : true,
  };
}

// Your recent finished CS2 matches as Downloads entries. known(id) returns an entry from an earlier
// check: its details don't change, so only new matches cost a match request.
async function fetchMatches(playerId, known = () => null) {
  const now = Date.now();
  const list = await api(`${SITE}/api/match-history/v5/players/${encodeURIComponent(playerId)}/history/?from=${encodeURIComponent(stamp(now - HISTORY_DAYS * 86400000))}&to=${encodeURIComponent(stamp(now))}&page=0&size=${HISTORY_SIZE}`);
  const items = Array.isArray(list) ? list : list?.items || [];
  const out = [];
  for (const m of items) {
    const matchId = m.matchId || m.match_id;
    if (!matchId || (m.game && m.game !== 'cs2')) continue;
    const id = `faceit_${matchId}`;
    const old = known(id);
    if (old?.mapLabel) { out.push(old); continue; }
    let info;
    try { info = await matchInfo(matchId); } catch (e) { if (e.signedOut) throw e; continue; }
    if (!info.finished) continue;
    out.push({
      source: 'faceit', id, fileBase: id, matchid: matchId, url: info.url, room: roomUrl(matchId),
      time: info.time || Date.parse(m.startedAt || m.started_at || '') || null,
      mode: info.competition ? `FACEIT ${info.competition}` : 'FACEIT',
      mapLabel: info.mapLabel, score: info.score,
      rounds: info.score.length === 2 ? info.score[0] + info.score[1] : null,
      players: info.players,
    });
    await new Promise(r => setTimeout(r, 300)); // FACEIT's limits are shared with its own pages
  }
  return out;
}

// FACEIT ships demos zstd- or gzip-compressed; plain demos are copied as they are.
async function unpack(src, dest) {
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const steps = [fs.createReadStream(src)];
  if (head.readUInt32LE(0) === 0xFD2FB528) steps.push(zlib.createZstdDecompress());
  else if (head[0] === 0x1f && head[1] === 0x8b) steps.push(zlib.createGunzip());
  const part = dest + '.part';
  try {
    await pipeline(...steps, fs.createWriteStream(part));
    fs.renameSync(part, dest);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
}

class Faceit {
  /**
   * dir(): the folder demos go to. events: onProgress(id, received, total), onDone(id, file),
   * onClosed(id) (window closed without a download), onError(id, message).
   */
  constructor({ dir, log = () => {}, ...events }) {
    this.dir = dir;
    this.log = log;
    this.events = events;
    this.rooms = new Map(); // matchId -> { win, entry, timer, downloads }
    this.hooked = false;
  }

  hook() {
    if (this.hooked) return;
    this.hooked = true;
    ses().on('will-download', (_e, item, wc) => {
      const room = [...this.rooms.values()].find(r => !r.win.isDestroyed() && r.win.webContents === wc)
        || [...this.rooms.values()].pop(); // started from a popup of the room
      if (!room) return;
      this.save(room, item);
    });
  }

  // Opens the match room; you click "Watch demo" there.
  open(entry) {
    this.hook();
    const old = this.rooms.get(entry.matchid);
    if (old && !old.win.isDestroyed()) { old.win.show(); old.win.focus(); return; }
    const w = new BrowserWindow({
      width: 1280, height: 860, autoHideMenuBar: true, title: 'FACEIT – click "Watch demo"', backgroundColor: '#1f1f1f',
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const room = { win: w, entry, downloads: 0, active: 0 };
    room.timer = setTimeout(() => { if (!room.active && !w.isDestroyed()) w.close(); }, ROOM_TIMEOUT);
    this.rooms.set(entry.matchid, room);
    // The demo link may open in a new tab: download it from this window instead.
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (isFaceitPage(url)) w.loadURL(url).catch(() => {});
      else w.webContents.downloadURL(url);
      return { action: 'deny' };
    });
    w.on('closed', () => {
      clearTimeout(room.timer);
      if (!room.active) {
        this.rooms.delete(entry.matchid);
        if (!room.downloads) this.events.onClosed?.(entry.id);
      }
    });
    w.loadURL(entry.room || roomUrl(entry.matchid)).catch(() => {});
  }

  save(room, item) {
    const { entry } = room;
    const n = ++room.downloads;
    room.active++;
    const base = n > 1 ? `${entry.fileBase}_map${n}` : entry.fileBase; // best of 3: one demo per map
    const dir = this.dir();
    fs.mkdirSync(dir, { recursive: true });
    const raw = path.join(dir, base + '.faceit-download');
    item.setSavePath(raw);
    this.log('FACEIT download started', entry.matchid, item.getFilename(), item.getTotalBytes());
    let last = 0;
    item.on('updated', () => {
      if (Date.now() - last < 400) return;
      last = Date.now();
      this.events.onProgress?.(entry.id, item.getReceivedBytes(), item.getTotalBytes());
    });
    item.once('done', async (_e, state) => {
      const end = () => {
        room.active--;
        if (!room.active) {
          if (!room.win.isDestroyed()) room.win.close();
          this.rooms.delete(entry.matchid);
        }
      };
      if (state !== 'completed') {
        fs.rmSync(raw, { force: true });
        this.events.onError?.(entry.id, `Download ${state}.`);
        return end();
      }
      const target = path.join(dir, base + '.dem');
      try {
        await unpack(raw, target);
        if (entry.time) try { fs.utimesSync(target, new Date(), new Date(entry.time)); } catch {}
        this.events.onDone?.(entry.id, target);
      } catch (e) {
        this.events.onError?.(entry.id, `Could not unpack the demo: ${e.message}`);
      } finally {
        fs.rmSync(raw, { force: true });
        end();
      }
    });
  }

  waiting(id) {
    return [...this.rooms.values()].some(r => r.entry.id === id && !r.active);
  }
}

module.exports = { Faceit, fetchMatches, matchInfo, me, signIn, signOut, unpack, PARTITION };
