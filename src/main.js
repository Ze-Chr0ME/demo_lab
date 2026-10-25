const { app, BrowserWindow, ipcMain, dialog, shell, Menu, crashReporter, screen, net, nativeImage, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const steam = require('./lib/steam');
const ffmpeg = require('./lib/ffmpeg');
const { Settings } = require('./lib/settings');
const { Library } = require('./lib/library');
const { Recorder, Cancelled, demoRef } = require('./lib/recorder');
const { buildHighlights, weaponName } = require('./lib/highlights');
const { DATA_VERSION } = require('./lib/demo');
const { DemoStore } = require('./lib/store');
const { buildMatchStats } = require('./lib/stats');
const { buildWeapons } = require('./lib/weapons');
const { heatPoints } = require('./lib/heat');
const { matchSummary, gameMode, PROFILE_VERSION } = require('./lib/profile');
const { unpackTrack } = require('./lib/track');
const { INTEGRITY_VERSION, scoreIntegrity } = require('./lib/integrity');
const { AIM_VERSION, summarizeAim, aimTotals } = require('./lib/aim');
const { ROUNDS_VERSION } = require('./lib/rounds');
const { buildRounds, roundPositions } = require('./lib/economy');
const { reviewDeaths, DEATHS_VERSION } = require('./lib/deaths');
const share = require('./lib/share');
const { ensureGeometry } = require('./lib/geometry');
const { MatchDownloader, fetchGcMatches } = require('./lib/matches');
const { decode } = require('./lib/proto');
const { Community, signIn, signOut, watchCookies, loginCookieSummary, PARTITION } = require('./lib/community');
const faceitLib = require('./lib/faceit');
const hlae = require('./lib/hlae');
const { UtilityStore, steamScreenshots, shareCode, shortCode, readCodes, sameLineup } = require('./lib/utility');
const { AvatarStore } = require('./lib/avatars');
const { ThemeArt } = require('./lib/themeArt');
const { Updater } = require('./lib/updater');
const { Gallery, SHORT_URL: GALLERY_SHORT, isPageLink } = require('./lib/gallery');
const { InventoryStore, localCurrency } = require('./lib/inventory');

let win;
let settings;
let env;
let recorder = null;
let viewer = null;   // HLAE session left open by "Watch in CS2": { session, demo }
let watching = null; // the "Watch in CS2" request being opened
let ffmpegFound = null;
let encoderReady = Promise.resolve();
let downloader;
const community = new Community();
let communityState = 'unknown'; // 'ok' | 'signedOut' | 'unknown' (not checked yet)
let faceit; // Faceit: match rooms where you click "Watch demo", and catching those downloads
let faceitState = 'unknown'; // same values as communityState
let store; // DemoStore: parsed data, failures and custom names, keyed by demo content
let utility; // UtilityStore: the Utility page's lineups
let avatars; // AvatarStore: Steam profile pictures
let themeArt; // ThemeArt: map screenshots and team logos from the CS2 install, for the themes
let updater; // Updater: new DemoLab releases from GitHub
let gallery; // Gallery: the "My highlights" web page (clips on catbox.moe)
let inventory; // InventoryStore: Steam inventories and their prices
let updating = false; // "Restart to update" was clicked: the quit must not start a second installer

// The data folder is %APPDATA%\cs2-demolab whether DemoLab runs from the source or installed (Electron
// would otherwise name it after the installed app's product name, "CS2 DemoLab").
// Dev aid: DEMOLAB_USERDATA=<folder> runs on a copy of the data folder (tests that must not touch the real one).
app.setPath('userData', process.env.DEMOLAB_USERDATA || path.join(app.getPath('appData'), 'cs2-demolab'));

// The app used to be called CS2 ClipMaker: its data folder (parsed demos, settings, HLAE, Steam sign-in,
// lineups) moves over once. Electron has already created the new folder, empty, by the time this runs.
(function adoptOldDataFolder() {
  const dir = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'cs2-clipmaker');
  try {
    if (!fs.existsSync(old) || fs.readdirSync(dir).length) return;
    fs.rmdirSync(dir);
    fs.renameSync(old, dir);
    try { fs.renameSync(path.join(dir, 'clipmaker.log'), path.join(dir, 'demolab.log')); } catch {}
  } catch {
    app.setPath('userData', old); // something holds a file open: keep using the old folder this time
  }
})();

// Diagnostics: crashes, unexpected quits and sign-in steps go to <userData>/demolab.log.
function log(...parts) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'demolab.log'), `[${new Date().toISOString()}] ${parts.join(' ')}\n`); } catch {}
}
crashReporter.start({ uploadToServer: false });
process.on('uncaughtException', e => log('uncaughtException', e.stack || e));
process.on('unhandledRejection', e => log('unhandledRejection', (e && e.stack) || e));
app.on('render-process-gone', (_e, wc, d) => log('renderer gone', d.reason, d.exitCode));
app.on('child-process-gone', (_e, d) => log('child process gone', d.type, d.reason, d.exitCode));
app.on('before-quit', () => log('app quitting'));

function s() { return settings.get(); }
function refreshEnv() {
  env = steam.detect();
  const custom = s().cs2Dir;
  if (custom && fs.existsSync(path.join(custom, 'game', 'csgo'))) { env.cs2Dir = custom; env.csgoDir = path.join(custom, 'game', 'csgo'); }
}
// HLAE location: the folder set in Settings, else the first complete install among the app data folder
// and the project's tools/hlae; a fresh install goes to the app data folder.
function hlaeDir() {
  if (s().hlae.path) return s().hlae.path;
  const candidates = [path.join(app.getPath('userData'), 'hlae'), path.join(__dirname, '..', 'tools', 'hlae')];
  return candidates.find(d => hlae.isInstalled(d)) || candidates[0];
}
function outputDir() { return s().outputDir || path.join(app.getPath('videos'), 'CS2 Clips'); }
function library() { return new Library(outputDir()); }
function mySteamId() { return s().steamId || env.steamUser?.steamid || ''; }
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function createWindow() {
  Menu.setApplicationMenu(null);
  // Most of the screen: the dashboard and the maps are made for 1080p and 1440p.
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.max(1100, Math.round(area.width * 0.88)), height: Math.max(700, Math.round(area.height * 0.9)), minWidth: 1100, minHeight: 680,
    backgroundColor: '#0a0e16',
    show: !process.env.DEMOLAB_HIDDEN, // dev aid: screenshots without a window popping up
    title: 'CS2 DemoLab',
    // The screenshot dev aid (below) needs painting to continue while the window is in the background.
    // DEMOLAB_HIDDEN renders offscreen: a hidden normal window repaints about once a second and misses late changes.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: !process.env.DEMOLAB_SCREENSHOT, offscreen: !!process.env.DEMOLAB_HIDDEN },
  });
  if (process.env.DEMOLAB_HIDDEN) win.webContents.setFrameRate(30);
  // Dev aid: DEMOLAB_SIZE=2560x1440 sets the window's content size (layout checks for other monitors).
  if (process.env.DEMOLAB_SIZE) win.setContentSize(...process.env.DEMOLAB_SIZE.split('x').map(Number));
  win.on('closed', () => log('main window closed'));
  win.on('focus', () => win.flashFrame(false));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Dev aid: DEMOLAB_SCREENSHOT=<file.png> saves a capture of the window after load.
  if (process.env.DEMOLAB_SCREENSHOT) {
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log('[renderer]', message); });
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.DEMOLAB_EVAL) { await win.webContents.executeJavaScript(process.env.DEMOLAB_EVAL).catch(e => console.log('[eval]', e.message)); await new Promise(r => setTimeout(r, 2500)); }
      fs.writeFileSync(process.env.DEMOLAB_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
      if (!process.env.DEMOLAB_KEEP_OPEN) app.quit();
    }, +(process.env.DEMOLAB_DELAY || 6000)));
  }
}

// ---------- Demo discovery & parsing ----------

function demoFolders() {
  const dirs = [];
  if (env.csgoDir) dirs.push(path.join(env.csgoDir, 'replays'), env.csgoDir);
  dirs.push(...s().demoFolders);
  return [...new Set(dirs)].filter(d => fs.existsSync(d));
}

// When the match was played. The file date is only when it was downloaded (or last copied), so
// prefer the match time from CS2's .info file, then from the match list we downloaded it from.
const infoTimes = new Map();
function matchDate(file, st) {
  const info = file + '.info';
  try {
    const ist = fs.statSync(info);
    const key = `${info}|${ist.mtimeMs}`;
    if (!infoTimes.has(key)) {
      let t = null;
      try { const v = decode(fs.readFileSync(info))[2]?.[0]; if (v) t = Number(v) * 1000; } catch {}
      infoTimes.set(key, t);
    }
    if (infoTimes.get(key)) return infoTimes.get(key);
  } catch {}
  return downloader?.matchTime(path.basename(file, path.extname(file))) || st.mtimeMs;
}

// Core data of a demo that was already parsed (by any path), or null.
function readCache(file) {
  return store.readCore(store.idOf(file));
}

function failMessage(f) {
  return /^rush/i.test(f.map || '')
    ? `This Rush match (${f.map}) could not be read (${f.error}), so its highlights can't be found.`
    : `Could not read this demo: ${f.error}`;
}

// Low-end PC (setting): the parser's own thread pool gets 2 threads instead of one per core. It is
// sized the first time a demo is read, so a change applies from the next start of DemoLab. Parsing
// jobs also use fewer helper threads then (lowEnd in the track and integrity workers).
function parserThreads(lowEnd) {
  if (lowEnd) process.env.RAYON_NUM_THREADS = '2';
  else delete process.env.RAYON_NUM_THREADS;
}

// Parses each demo at most once: results (and failures) are stored under the demo's content id.
// Demos are parsed one at a time so a full rescan never runs several parsers at once.
let parseQueue = Promise.resolve();
const parsing = new Map(); // id -> pending job, so two callers share one parse
function parseDemo(file) {
  const id = store.idOf(file);
  const cached = store.readCore(id);
  if (cached) return Promise.resolve(cached);
  const failed = store.failure(id);
  if (failed) return Promise.reject(new Error(failMessage(failed)));
  if (parsing.has(id)) return parsing.get(id);
  const job = parseQueue.then(() => new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'lib', 'parseWorker.js'), { workerData: { file } });
    w.once('message', msg => {
      w.terminate();
      if (!msg.ok) {
        const f = { map: msg.map, error: msg.error };
        store.setFailure(id, f);
        log('parse failed', path.basename(file), msg.map || '', msg.error);
        return reject(new Error(failMessage(f)));
      }
      store.write(id, msg.data);
      resolve(msg.data.core);
    });
    w.once('error', reject);
  })).finally(() => parsing.delete(id));
  parsing.set(id, job);
  parseQueue = job.catch(() => {});
  return job;
}

// Player positions for the 2D replay: built once per demo (in the same one-at-a-time queue as
// parsing), then read from <id>.track.bin.
const tracking = new Map();
async function demoTrack(file) {
  const core = await parseDemo(file);
  const id = store.idOf(file);
  const trackFile = store.trackFile(id);
  try { const t = unpackTrack(fs.readFileSync(trackFile)); if (t) return t; } catch {}
  if (!tracking.has(id)) {
    const job = parseQueue.then(() => new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'lib', 'parseWorker.js'), { workerData: { file, mode: 'track', core, lowEnd: s().lowEnd } });
      w.once('message', msg => {
        w.terminate();
        if (!msg.ok) return reject(new Error(`Could not read player positions: ${msg.error}`));
        const buf = Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
        fs.writeFileSync(trackFile, buf);
        resolve(unpackTrack(buf));
      });
      w.once('error', reject);
    })).finally(() => tracking.delete(id));
    tracking.set(id, job);
    parseQueue = job.catch(() => {});
  }
  return tracking.get(id);
}

// Map collision meshes for line of sight (see lib/geometry.js): downloaded once, the first time a
// match is checked. Without them (offline, unknown map) the check falls back on radar spotting.
let geometryJob = null;
function geometryDir() {
  const dir = path.join(app.getPath('userData'), 'geometry');
  if (!geometryJob) geometryJob = ensureGeometry(dir, net.fetch, m => log('geometry:', m))
    .catch(err => { log('geometry: unavailable', err.message); geometryJob = null; return null; });
  return geometryJob;
}
const meshFor = (dir, map) => dir && fs.existsSync(path.join(dir, `${map}.mesh`));

// Aim and visibility facts for the Integrity and Aim tabs: one pass over every tick, built once per
// demo (same queue), then read from <id>.integrity.json and <id>.aim.json. Progress goes to the
// renderer as integrity:progress. Facts made without map geometry are rebuilt once the geometry is there.
const checking = new Map();
async function demoIntegrity(file, { gentle = false } = {}) {
  const core = await parseDemo(file);
  const id = store.idOf(file);
  const out = store.integrityFile(id);
  const cached = store.readExtra(out, INTEGRITY_VERSION);
  const cachedAim = store.readExtra(store.aimFile(id), AIM_VERSION);
  if (cached?.los && cachedAim) return { core, facts: cached, aim: cachedAim };
  if (!checking.has(id)) {
    const job = (async () => {
      if (!fs.existsSync(path.join(app.getPath('userData'), 'geometry', 'manifest.json'))) send('integrity:progress', { id, progress: 0, phase: 'geometry' });
      const dir = await geometryDir();
      if (cached && cachedAim && !meshFor(dir, core.map)) return { facts: cached, aim: cachedAim };
      const run = parseQueue.then(() => new Promise((resolve, reject) => {
        const w = new Worker(path.join(__dirname, 'lib', 'parseWorker.js'), { workerData: { file, mode: 'integrity', core, geometryDir: dir, lowEnd: s().lowEnd || gentle } });
        w.on('message', msg => {
          if (msg.progress != null) return send('integrity:progress', { id, progress: msg.progress, phase: 'demo' });
          w.terminate();
          if (!msg.ok) return reject(new Error(`Could not check this demo: ${msg.error}`));
          fs.writeFileSync(out, JSON.stringify(msg.data));
          fs.writeFileSync(store.aimFile(id), JSON.stringify(msg.aim));
          resolve({ facts: msg.data, aim: msg.aim });
        });
        w.once('error', reject);
      }));
      parseQueue = run.catch(() => {});
      return run;
    })().finally(() => checking.delete(id));
    checking.set(id, job);
  }
  return { core, ...(await checking.get(id)) };
}

// Money, loadouts and callouts per round (lib/rounds.js). New demos get them with the first parse;
// demos read before that get them here, in the same one-at-a-time queue (about a second each).
const roundsJobs = new Map();
async function demoRounds(file) {
  const core = await parseDemo(file);
  const id = store.idOf(file);
  const cached = store.readExtra(store.roundsFile(id), ROUNDS_VERSION);
  if (cached) return cached;
  if (!roundsJobs.has(id)) {
    const job = parseQueue.then(() => new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'lib', 'parseWorker.js'), { workerData: { file, mode: 'rounds', core } });
      w.once('message', msg => {
        w.terminate();
        if (!msg.ok) return reject(new Error(`Could not read the money and positions: ${msg.error}`));
        fs.writeFileSync(store.roundsFile(id), JSON.stringify(msg.data));
        resolve(msg.data);
      });
      w.once('error', reject);
    })).finally(() => roundsJobs.delete(id));
    roundsJobs.set(id, job);
    parseQueue = job.catch(() => {});
  }
  return roundsJobs.get(id);
}

// The CS2 that "View in CS2" and "Practice in CS2" drive through HLAE: reused while it stays open.
async function viewerSession() {
  const cfg = s();
  let session = viewer?.session;
  if (!session?.sock) {
    session = new hlae.HlaeSession({
      dir: hlaeDir(), cs2Dir: env.cs2Dir, port: cfg.hlae.port, width: cfg.hlae.width, height: cfg.hlae.height,
      ffmpegPath: ffmpegFound || 'ffmpeg', log: m => log('watch:', m),
    });
    const { launched } = await session.start(() => false);
    viewer = { session, demo: null, map: null };
    if (launched) await new Promise(r => setTimeout(r, cfg.timing.startupWait * 1000));
  }
  return session;
}

// A private practice server: no bots, infinite grenades, grenade trajectory preview, buy anywhere.
const PRACTICE = ['sv_cheats 1', 'bot_kick', 'mp_warmup_end', 'mp_freezetime 0', 'mp_roundtime_defuse 60', 'mp_buy_anywhere 1', 'mp_buytime 9999',
  'mp_maxmoney 60000', 'mp_startmoney 60000', 'sv_infinite_ammo 1', 'ammo_grenade_limit_total 5', 'sv_grenade_trajectory_prac_pipreview 1', 'mp_restartgame 1'];
const GIVE = { smoke: 'weapon_smokegrenade', flash: 'weapon_flashbang', he: 'weapon_hegrenade', molotov: 'weapon_molotov' };

async function demoData(file) {
  let core = await parseDemo(file);
  let events = store.readEvents(store.idOf(file));
  if (!events) {
    // Only the events file is gone (deleted by hand?): read the demo again.
    store.forget(store.idOf(file));
    core = await parseDemo(file);
    events = store.readEvents(store.idOf(file));
  }
  return { core, events };
}

// Heatmap points per demo and player (null = everyone), kept in memory: the "all matches on this map"
// view and the Maps page reuse them.
const heatCache = new Map();
function heatOf(id, steamid) {
  const key = id + '|' + (steamid || 'all');
  if (heatCache.has(key)) return heatCache.get(key);
  const core = store.readCore(id), events = store.readEvents(id);
  if (!core || !events) return null;
  const pts = heatPoints(core, events, steamid);
  heatCache.set(key, pts);
  if (heatCache.size > 200) heatCache.delete(heatCache.keys().next().value);
  return pts;
}

// Every .dem in the demo folders, with its content id (one entry per file, so a copied demo appears twice).
function scanDemos() {
  const out = [];
  const seen = new Set();
  for (const dir of demoFolders()) {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.dem$/i.test(name)) continue;
      const file = path.join(dir, name);
      if (seen.has(file.toLowerCase())) continue;
      seen.add(file.toLowerCase());
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      let id;
      try { id = store.idOf(file, st); } catch { continue; }
      out.push({ id, path: file, name, folder: dir, size: st.size, mtime: st.mtimeMs, date: matchDate(file, st), customName: store.name(id) });
    }
  }
  return out.sort((a, b) => b.date - a.date);
}

// My numbers in one demo, computed once from the stored facts and kept in derived.json.
function summaryOf(id, steamid) {
  const key = id + '|' + steamid;
  const cached = store.derived(key, PROFILE_VERSION);
  if (cached !== undefined) return cached;
  const core = store.readCore(id), events = core && store.readEvents(id);
  if (!core || !events) return undefined; // not parsed yet
  const value = matchSummary(core, events, steamid);
  store.setDerived(key, PROFILE_VERSION, value);
  return value;
}

// Where I played each round (Maps page) and my aim counts (overview): also computed once per demo and
// kept in derived.json, but only once the extra facts they come from exist.
const POS_VERSION = 1, AIM_SUM_VERSION = 1;
function positionsOf(id, steamid) {
  const key = `pos|${id}|${steamid}`;
  const cached = store.derived(key, POS_VERSION);
  if (cached !== undefined) return cached;
  const facts = store.readExtra(store.roundsFile(id), ROUNDS_VERSION);
  const core = facts && store.readCore(id), events = core && store.readEvents(id);
  if (!events) return undefined;
  const value = roundPositions(core, events, facts, steamid);
  store.setDerived(key, POS_VERSION, value);
  return value;
}
function aimSummaryOf(id, steamid) {
  const key = `aim|${id}|${steamid}`;
  const cached = store.derived(key, AIM_SUM_VERSION);
  if (cached !== undefined) return cached;
  const facts = store.readExtra(store.aimFile(id), AIM_VERSION);
  if (!facts) return undefined;
  const value = aimTotals(facts, steamid);
  store.setDerived(key, AIM_SUM_VERSION, value);
  return value;
}

// A player's death review in one demo (lib/deaths.js), kept in derived.json. undefined while the round
// facts it needs (positions and grenades at each kill) don't exist yet; redone once the match is measured,
// as the aim facts add who saw whom.
function deathsOf(id, steamid) {
  const key = `dth|${id}|${steamid}`;
  const hasAim = fs.existsSync(store.aimFile(id));
  const cached = store.derived(key, DEATHS_VERSION);
  if (cached !== undefined && (cached === null || cached.measured || !hasAim)) return cached;
  const facts = store.readExtra(store.roundsFile(id), ROUNDS_VERSION);
  const core = facts && store.readCore(id), events = core && store.readEvents(id);
  if (!events) return undefined;
  const aim = hasAim ? store.readExtra(store.aimFile(id), AIM_VERSION) : null;
  const value = reviewDeaths(core, events, facts, aim, steamid);
  store.setDerived(key, DEATHS_VERSION, value);
  return value;
}
// Everyone's numbers in one demo, for the Compare page's "your lobbies" benchmark (percentiles over every
// player of every demo you have). One row per player:
//   [steamid, rounds, rating, kills, deaths, assists, damage, kastRounds, hsKills, firstKills, firstDeaths,
//    tradeKills, utilityDamage, enemiesFlashed, multi-kill rounds, clutches won, clutches played, won (1/0),
//    death tags {tag: n} or null when the round facts aren't there yet]
const LOBBY_VERSION = 1;
function lobbyOf(id) {
  const key = `lob|${id}`;
  const hasFacts = !!store.readExtra(store.roundsFile(id), ROUNDS_VERSION);
  const cached = store.derived(key, LOBBY_VERSION);
  if (cached !== undefined && (cached === null || cached.deaths || !hasFacts)) return cached;
  const core = store.readCore(id), events = core && store.readEvents(id);
  if (!events) return undefined;
  const st = buildMatchStats(core, events, null);
  const facts = hasFacts ? store.readExtra(store.roundsFile(id), ROUNDS_VERSION) : null;
  const rows = [];
  for (const t of st.teams) {
    for (const p of t.players) {
      let tags = null;
      if (facts) {
        tags = {};
        for (const d of reviewDeaths(core, events, facts, null, p.steamid)?.deaths || []) for (const g of d.tags) tags[g] = (tags[g] || 0) + 1;
      }
      const other = st.teams.find(x => x !== t);
      rows.push([p.steamid, p.rounds, p.rating == null ? null : Math.round(p.rating * 1000) / 1000, p.kills, p.deaths, p.assists, p.damage, p.kastRounds, p.hsKills,
        p.firstKills, p.firstDeaths, p.tradeKills, p.utilityDamage, p.enemiesFlashed, Object.values(p.multi).reduce((a, b) => a + b, 0),
        p.clutches.won, p.clutches.played, t.score > (other?.score ?? 0) ? 1 : 0, tags]);
    }
  }
  const value = { map: core.map, mode: gameMode(core), deaths: !!facts, rows };
  store.setDerived(key, LOBBY_VERSION, value);
  return value;
}

// Per tag, how many of the deaths have it (for the overview, which adds matches up).
function deathCounts(v) {
  if (!v) return null;
  const tags = {};
  for (const d of v.deaths) for (const t of d.tags) tags[t] = (tags[t] || 0) + 1;
  return { n: v.deaths.length, measured: v.measured, tags };
}

// A player's weapon numbers in one demo for the Aim page, per side and weapon (from the Weapons tab rows),
// also kept in derived.json. null when they didn't play in it, undefined when it isn't parsed yet.
//   rows: [side, weapon, kills, hs, wall, smoke, noscope, blind, air, distSum, distN, dmg, hits, bodyHits,
//          headHits, shotHits, shots, groups {hitgroup: [hits, dmg]}]
const WEAPON_SUM_VERSION = 1;
function weaponTotalsOf(id, steamid) {
  const key = `wpn|${id}|${steamid}`;
  const cached = store.derived(key, WEAPON_SUM_VERSION);
  if (cached !== undefined) return cached;
  const core = store.readCore(id), events = core && store.readEvents(id);
  if (!events) return undefined;
  let value = null;
  if (core.players.some(p => p.steamid === steamid)) {
    const v = buildWeapons(core, events);
    const by = new Map();
    const row = (side, w) => by.get(`${side}|${w}`) || by.set(`${side}|${w}`, [side, w, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, {}]).get(`${side}|${w}`);
    for (const [, id2, side, w, flags, dist] of v.kills) {
      if (id2 !== steamid) continue;
      const r = row(side, w);
      r[2]++;
      for (let b = 0; b < 6; b++) if (flags & (1 << b)) r[3 + b]++;
      if (dist != null) { r[9] += dist; r[10]++; }
    }
    for (const [, id2, side, w, group, dmg, , first] of v.hits) {
      if (id2 !== steamid) continue;
      const r = row(side, w);
      r[11] += dmg; r[12]++;
      if (group !== 'generic') {
        r[13]++; r[15] += first;
        if (group === 'head') r[14]++;
        const g = r[17][group] ||= [0, 0];
        g[0]++; g[1] += dmg;
      }
    }
    for (const [, id2, side, w, n] of v.shots) if (id2 === steamid) row(side, w)[16] += n;
    for (const r of by.values()) r[9] = Math.round(r[9] * 10) / 10;
    value = { map: core.map, rows: [...by.values()] };
  }
  store.setDerived(key, WEAPON_SUM_VERSION, value);
  return value;
}

// Demos read before the round facts existed get them in the background; the renderer reloads the
// profile once they are done.
let roundsFill = null;
const roundsFailed = new Set(); // demo ids whose round facts could not be read (not retried until restart)
function fillRounds(files) {
  files = files.filter(f => !roundsFailed.has(store.idOf(f)));
  if (roundsFill || !files.length) return;
  let added = 0;
  roundsFill = (async () => {
    for (const f of files) {
      try { await demoRounds(f); added++; } catch (e) { roundsFailed.add(store.idOf(f)); log('rounds failed', path.basename(f), e.message); }
    }
  })().finally(() => { roundsFill = null; if (added) send('profile:changed', {}); });
}

// "Analyze aim" on the overview: the tick pass for every match of the shown player (me by default) that
// doesn't have it yet, one by one.
let aimBatch = null;
function aimBatchStatus() { return aimBatch ? { running: true, total: aimBatch.total, done: aimBatch.done, current: aimBatch.current, steamid: aimBatch.steamid, stopping: aimBatch.cancelled } : { running: false }; }
async function runAimBatch(steamid) {
  const me = steamid || mySteamId();
  const seen = new Set();
  const todo = scanDemos().filter(d => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return summaryOf(d.id, me) && !store.readExtra(store.aimFile(d.id), AIM_VERSION);
  });
  aimBatch = { total: todo.length, done: 0, current: null, cancelled: false, steamid: me };
  send('aim:batch', aimBatchStatus());
  try {
    for (const d of todo) {
      if (aimBatch.cancelled) break;
      aimBatch.current = d.id;
      send('aim:batch', aimBatchStatus());
      try { await demoIntegrity(d.path); } catch (e) { log('aim batch:', path.basename(d.path), e.message); }
      aimBatch.done++;
      send('aim:batch', aimBatchStatus());
    }
  } finally {
    const { cancelled, done, total } = aimBatch;
    aimBatch = null;
    send('aim:batch', { running: false, finished: true, stopped: cancelled && done < total, done, total });
  }
}

// ---------- New matches: read, measure and announce ----------
// A demo that shows up while DemoLab runs (downloaded by the Downloads tab or by CS2, or copied into a demo
// folder), or that arrived since the last time DemoLab ran, is read, measured (the tick pass behind Aim
// and Integrity) and checked for highlights and deaths in the background, then summed up in a Windows
// notification. While CS2 is running this runs at below-normal priority on fewer threads, so a game
// keeps its frames. Demos that were already there when the feature first ran are left to the normal
// background reading, without notifications.
const auto = { known: new Set(), watchers: [], timers: new Map(), queue: Promise.resolve(), running: null, icon: null, waiting: 0 };
const autoKey = file => file.toLowerCase();
const prettyMap = m => ({ de_dust2: 'Dust II', cs_office: 'Office', cs_italy: 'Italy' })[m] || (m || '?').replace(/^(de|cs|ar)_/, '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

function startAutoProcessing() {
  const cfg = s().autoProcess;
  const firstRun = !cfg.lastScan;
  const since = cfg.lastScan || Date.now();
  const backlog = [];
  for (const d of scanDemos()) {
    auto.known.add(autoKey(d.path));
    // Arrived while DemoLab was closed: the newest few get the same treatment as live arrivals.
    if (!firstRun && d.mtime > since && !store.readCore(d.id) && !store.failure(d.id)) backlog.push(d.path);
  }
  settings.update({ autoProcess: { lastScan: Date.now() } });
  setInterval(() => settings.update({ autoProcess: { lastScan: Date.now() } }), 10 * 60000);
  for (const f of backlog.slice(0, 5)) autoEnqueue(f);
  watchDemoFolders();
}

// fs.watch on every demo folder; a new .dem is looked at once its size has stopped changing.
function watchDemoFolders() {
  for (const w of auto.watchers) w.close();
  auto.watchers = [];
  for (const dir of demoFolders()) {
    try {
      auto.watchers.push(fs.watch(dir, (_ev, name) => {
        if (name && /\.dem$/i.test(name)) autoCandidate(path.join(dir, name));
      }));
    } catch (e) { log('auto: cannot watch', dir, e.message); }
  }
}

function autoCandidate(file) {
  const key = autoKey(file);
  if (auto.known.has(key) || auto.timers.has(key)) return;
  let last = -1, same = 0;
  const poll = () => {
    let size = -1;
    try { size = fs.statSync(file).size; } catch { auto.timers.delete(key); return; }
    same = size === last && size > 1048576 ? same + 1 : 0;
    last = size;
    if (same >= 2) { auto.timers.delete(key); auto.known.add(key); autoEnqueue(file); return; }
    auto.timers.set(key, setTimeout(poll, 2000));
  };
  auto.timers.set(key, setTimeout(poll, 1500));
}

function autoEnqueue(file) {
  auto.known.add(autoKey(file));
  if (!s().autoProcess.enabled) return;
  auto.waiting++;
  send('auto:update', autoStatus());
  auto.queue = auto.queue.then(() => autoProcess(file)).catch(e => log('auto:', path.basename(file), e.message))
    .finally(() => { auto.waiting--; auto.running = null; send('auto:update', autoStatus()); });
}
const autoStatus = () => ({ running: auto.running, waiting: auto.waiting });

async function autoProcess(file) {
  if (!fs.existsSync(file)) return;
  const cfg = s().autoProcess;
  const id = store.idOf(file);
  auto.running = { file, name: path.basename(file), step: 'reading' };
  send('auto:update', autoStatus());
  const gentle = hlae.cs2Pids().length > 0;
  const os = require('os');
  let before = null;
  try { before = os.getPriority(0); } catch {}
  // Priorities are niceness-like: a bigger number is lower. Never raise one the app was started with.
  if (gentle && before != null && before < os.constants.priority.PRIORITY_BELOW_NORMAL) try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  try {
    const core = await parseDemo(file);
    try { await demoRounds(file); } catch {}
    const me = mySteamId();
    let measured = false;
    if (cfg.measure && me && core.players.some(p => p.steamid === me)) {
      auto.running.step = 'measuring';
      send('auto:update', autoStatus());
      try { await demoIntegrity(file, { gentle }); measured = true; } catch (e) { log('auto: measuring failed', path.basename(file), e.message); }
    }
    const sum = me ? summaryOf(id, me) : null;
    const a = analysis(file, core, me);
    const dth = me ? deathsOf(id, me) : null;
    const result = { id, path: file, map: core.map, summary: sum, highlights: a.highlights?.length || 0, measured, deaths: deathCounts(dth) };
    log('auto: processed', path.basename(file), core.map, sum ? `${sum.kills}-${sum.deaths} ${sum.rating?.toFixed(2)}` : 'not in it');
    send('auto:done', result);
    if (cfg.notify) notifyMatch(result);
  } finally {
    if (before != null) try { if (os.getPriority(0) !== before) os.setPriority(0, before); } catch {}
  }
}

const DEATH_HINT = { alone: 'died alone', untraded: 'not traded', nades: 'died with grenades', caught: 'caught off guard', dry: 'entries without utility', lowhp: 'fought on low HP' };
function notifyMatch(r) {
  const sm = r.summary;
  const title = sm
    ? `${prettyMap(r.map)} ${sm.score[0]}:${sm.score[1]} · ${sm.result === 'W' ? 'Win' : sm.result === 'L' ? 'Loss' : 'Draw'}`
    : `${prettyMap(r.map)} · new demo read`;
  const lines = [];
  if (sm) lines.push(`${sm.kills}–${sm.deaths}${sm.rating != null ? ` · rating ${sm.rating.toFixed(2)}` : ''} · ADR ${Math.round(sm.damage / Math.max(1, sm.rounds))}`);
  const top = r.deaths && Object.entries(r.deaths.tags).filter(([t]) => DEATH_HINT[t]).sort((a, b) => b[1] - a[1])[0];
  lines.push([r.highlights ? `${r.highlights} highlight${r.highlights > 1 ? 's' : ''} to clip` : null,
    top && top[1] >= 2 ? `${top[1]} of ${r.deaths.n} deaths: ${DEATH_HINT[top[0]]}` : null].filter(Boolean).join(' · ') || 'Open it in DemoLab');
  // In the app already: a toast there (sent with auto:done) is enough; just get attention otherwise.
  if (win && !win.isDestroyed() && win.isFocused()) return;
  if (win && !win.isDestroyed()) win.flashFrame(true);
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: lines.join('\n'), icon: auto.icon || undefined, silent: false });
  n.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    send('auto:open', { path: r.path, id: r.id });
  });
  n.show();
}

function highlightOpts() {
  const d = s().detection, t = s().timing;
  return { ...d, padBefore: t.padBefore, padAfter: t.padAfter, mergeGap: t.mergeGap };
}

function analysis(file, data, steamid) {
  const id = steamid && data.players.some(p => p.steamid === steamid) ? steamid : null;
  const res = id ? buildHighlights(data, id, highlightOpts()) : null;
  return {
    path: file, map: data.map, server: data.server, rounds: data.rounds.length,
    players: data.players, playerFound: !!id, ...res,
  };
}

// ---------- IPC ----------

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
}

function registerIpc() {
  // The taskbar icon: the logo in the theme's colors, drawn by the renderer (windowIcon in app.js).
  handle('window:icon', async png => { const img = nativeImage.createFromDataURL(png); if (img.isEmpty()) return; auto.icon = img; if (win && !win.isDestroyed()) win.setIcon(img); });
  handle('env:get', async () => (await encoderReady, {
    ...env, ffmpeg: ffmpegFound, encoder: ffmpeg.encoder,
    outputDir: outputDir(), mySteamId: mySteamId(), cs2Running: hlae.cs2Pids().length > 0,
    hlae: { dir: hlaeDir(), installed: hlae.isInstalled(hlaeDir()), version: hlae.hlaeVersion(hlaeDir()) },
  }));

  handle('settings:get', () => s());
  handle('settings:set', patch => {
    const old = s();
    const next = settings.update(patch);
    if (patch.ffmpegPath !== undefined) ffmpegFound = ffmpeg.resolve(next.ffmpegPath);
    if (patch.cs2Dir !== undefined) refreshEnv();
    if (patch.encoder !== undefined && patch.encoder !== old.encoder) encoderReady = ffmpeg.pickEncoder(next.encoder);
    if (patch.lowEnd !== undefined) parserThreads(next.lowEnd);
    if (patch.demoFolders !== undefined || patch.cs2Dir !== undefined) watchDemoFolders();
    return next;
  });

  handle('dialog:folder', async title => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:file', async (title, filters) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('demos:list', () => scanDemos().map(d => {
    const data = store.readCore(d.id);
    let summary = null;
    if (data) {
      const a = analysis(d.path, data, mySteamId());
      summary = { map: data.map, highlights: a.highlights?.length ?? null, best: a.highlights?.reduce((m, h) => Math.max(m, h.score), 0) ?? 0, score: a.score || null, stats: a.stats || null };
    }
    const failure = store.failure(d.id);
    return { ...d, summary, failure: failure && { map: failure.map } };
  }));

  // The overview dashboard: a player's summary (me unless another SteamID is given) for every parsed demo
  // they played in (each demo once, even if copied). Demos that aren't parsed yet are skipped; the renderer
  // asks again as the background parsing goes on. Positions are only needed for my Maps page.
  handle('profile:get', steamid => {
    const self = mySteamId();
    const me = steamid || self;
    const mine = me === self;
    const matches = [];
    const seen = new Set();
    const noRounds = [];
    let aimMissing = 0;
    for (const d of scanDemos()) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const sum = me ? summaryOf(d.id, me) : null;
      if (!sum) continue;
      const positions = mine ? positionsOf(d.id, me) : null;
      if (positions === undefined && !roundsFailed.has(d.id)) noRounds.push(d.path);
      const aim = aimSummaryOf(d.id, me);
      if (aim === undefined) aimMissing++;
      const deaths = deathsOf(d.id, me);
      if (deaths === undefined && !roundsFailed.has(d.id) && !noRounds.includes(d.path)) noRounds.push(d.path);
      matches.push({ id: d.id, path: d.path, date: d.date, customName: d.customName, ...sum, positions: positions || null, aim: aim || null, review: deathCounts(deaths) });
    }
    fillRounds(noRounds);
    return { steamid: me, mine, name: matches[0]?.name || (mine && env.steamUser?.name) || '', matches, aimMissing, aimBatch: aimBatchStatus(), positionsPending: noRounds.length };
  });
  // Everyone in my parsed demos, for the player search: names they used, how many matches, and how many
  // of those were with me or against me.
  // A player's inventory (me unless another SteamID is given) with prices from the chosen source.
  handle('inventory:get', (steamid, refresh) => inventory.get(steamid || mySteamId(), { source: s().inventory.source, stickerShare: s().inventory.stickerShare, refresh: !!refresh }));
  handle('inventory:market', name => inventory.market(name));
  handle('inventory:defaults', () => ({ currency: localCurrency(app.getLocaleCountryCode()) }));
  handle('avatars:get', ids => avatars.get(Array.isArray(ids) ? ids : []));
  handle('players:list', () => {
    const self = mySteamId();
    const by = new Map();
    const seen = new Set();
    for (const d of scanDemos()) { // newest first, so the first name seen is the latest one
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const core = store.readCore(d.id);
      if (!core) continue;
      const myTeam = {}; // round -> my team letter
      for (const r of core.rounds) if (r.roster[self]) myTeam[r.num] = r.roster[self].team;
      for (const p of core.players) {
        const x = by.get(p.steamid) || by.set(p.steamid, { steamid: p.steamid, name: p.name, names: [], matches: 0, with: 0, against: 0, last: d.date, maps: {} }).get(p.steamid);
        if (p.name && !x.names.includes(p.name)) x.names.push(p.name);
        x.matches++;
        x.maps[core.map] = (x.maps[core.map] || 0) + 1;
        const r = core.rounds.find(r => r.roster[p.steamid] && myTeam[r.num]);
        if (r && p.steamid !== self) x[r.roster[p.steamid].team === myTeam[r.num] ? 'with' : 'against']++;
      }
    }
    return { self, players: [...by.values()] };
  });
  handle('auto:status', () => autoStatus());
  // Compare page: everyone's numbers in every parsed demo (lobbyOf), for "better than N % of your lobbies".
  handle('lobby:get', () => {
    const matches = [];
    const seen = new Set();
    let pending = 0;
    for (const d of scanDemos()) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const v = lobbyOf(d.id);
      if (v === undefined) { if (!store.failure(d.id)) pending++; continue; }
      if (v) matches.push({ id: d.id, date: d.date, ...v });
    }
    return { matches, pending };
  });
  handle('aim:batch', (action, steamid) => {
    if (action === 'start' && !aimBatch) runAimBatch(steamid).catch(e => log('aim batch failed', e.message));
    if (action === 'cancel' && aimBatch) aimBatch.cancelled = true;
    if (action === 'resume' && aimBatch) aimBatch.cancelled = false;
    return aimBatchStatus();
  });

  // Death review of every parsed demo a player played (me unless a SteamID is given), newest first, for the
  // overview's drill-down. Demos without the round facts yet are counted in pending.
  handle('deaths:all', steamid => {
    const me = steamid || mySteamId();
    const matches = [];
    const seen = new Set();
    let pending = 0;
    for (const d of scanDemos()) {
      if (seen.has(d.id) || !me) continue;
      seen.add(d.id);
      const sum = summaryOf(d.id, me);
      if (!sum) continue;
      const v = deathsOf(d.id, me);
      if (v === undefined) { pending++; continue; }
      if (v) matches.push({ id: d.id, path: d.path, date: d.date, customName: d.customName, map: sum.map, mode: sum.mode, result: sum.result, score: sum.score, ...v });
    }
    return { steamid: me, matches, pending };
  });

  // Aim page: a player's weapon numbers in every parsed demo they played (me unless a SteamID is given).
  handle('weapons:all', steamid => {
    const me = steamid || mySteamId();
    const matches = [];
    const seen = new Set();
    let pending = 0;
    for (const d of scanDemos()) {
      if (seen.has(d.id) || !me) continue;
      seen.add(d.id);
      const v = weaponTotalsOf(d.id, me);
      if (v === undefined) { if (!store.failure(d.id)) pending++; continue; }
      if (v) matches.push({ id: d.id, date: d.date, customName: d.customName, mode: summaryOf(d.id, me)?.mode || null, ...v });
    }
    return { steamid: me, matches, pending };
  });

  // Heatmap points of every parsed demo on one map, for me (who = steamid) or for everyone (who = 'all').
  handle('map:heat', (map, who) => {
    const steamid = who === 'all' ? null : who || mySteamId();
    const points = [];
    const seen = new Set();
    let matches = 0;
    for (const d of scanDemos()) {
      if (seen.has(d.id) || store.readCore(d.id)?.map !== map) continue;
      seen.add(d.id);
      const pts = heatOf(d.id, steamid);
      if (!pts?.length) continue;
      matches++;
      for (const p of pts) points.push(p);
    }
    return { map, matches, points };
  });

  handle('demo:analyze', async (file, steamid) => analysis(file, await parseDemo(file), steamid || mySteamId()));
  handle('demo:stats', async file => {
    const { core, events } = await demoData(file);
    return buildMatchStats(core, events, mySteamId(), { sides: true });
  });
  // Weapons tab: every hit, kill and shot as rows the renderer filters and adds up.
  handle('demo:weapons', async file => {
    const { core, events } = await demoData(file);
    return buildWeapons(core, events);
  });
  // Heatmap points for a player in this demo, or in every already-analyzed demo of the same map
  // (scope 'map'; demos not parsed yet are skipped rather than parsed now).
  handle('demo:heat', async (file, steamid, scope) => {
    const core = await parseDemo(file);
    const ids = new Set([store.idOf(file)]);
    if (scope === 'map') for (const d of scanDemos()) if (store.readCore(d.id)?.map === core.map) ids.add(d.id);
    const points = [];
    let matches = 0;
    for (const id of ids) {
      const pts = heatOf(id, steamid);
      if (!pts) continue;
      if (pts.length) matches++;
      for (const p of pts) points.push(p);
    }
    return { map: core.map, matches, points };
  });
  // Everything the 2D replay needs: sampled positions, grenade paths, shots and bomb events from the
  // track file, plus kills, damage, flashes and grenade effects from the stored events.
  handle('demo:replay', async file => {
    const { core, events } = await demoData(file);
    const track = await demoTrack(file);
    const { extra, ...header } = track.header;
    return {
      map: core.map, tickrate: core.tickrate, players: core.players,
      rounds: core.rounds.map(({ roster, ...r }) => r),
      kills: core.kills.map(k => ({ tick: k.tick, round: k.round, attacker: k.attacker, victim: k.victim, attackerTeam: k.attackerTeam, victimTeam: k.victimTeam, weapon: weaponName(k.weapon), headshot: k.headshot, wallbang: k.wallbang, smoke: k.smoke, victimPos: k.victimPos })),
      // [tick, attacker, victim, damage, hitgroup, weapon, victim x, victim y]
      damage: events.damage.filter(d => d.victimPos).map(d => [d.tick, d.attacker, d.victim, d.dmg, d.hitgroup, d.weapon || '', d.victimPos[0], d.victimPos[1]]),
      blinds: events.blinds.map(b => [b.tick, b.victim, b.duration, b.attacker]),
      grenades: events.grenades, nades: extra.nades, shots: extra.shots, timers: extra.timers,
      bomb: [...events.bomb, ...extra.bomb].sort((a, b) => a.tick - b.tick),
      track: { header, data: new Uint8Array(track.data.buffer, track.data.byteOffset, track.data.byteLength) },
    };
  });
  // Integrity tab: per player, how unusual their aim and game sense look, and the moments behind it.
  handle('demo:integrity', async file => {
    const { core, facts } = await demoIntegrity(file);
    return scoreIntegrity(facts, core, mySteamId());
  });
  // Aim tab: counter-strafing, accuracy, crosshair placement and time to damage (same pass as Integrity).
  handle('demo:aim', async file => {
    const { core, aim } = await demoIntegrity(file);
    return summarizeAim(aim, core, mySteamId());
  });
  // Deaths tab: one player's deaths in this match with what went wrong (point-of-view player by default: me).
  handle('demo:deaths', async (file, steamid) => {
    await demoRounds(file);
    const id = store.idOf(file);
    const v = deathsOf(id, steamid || mySteamId());
    if (v === undefined) throw new Error('The positions at each kill could not be read from this demo.');
    return v;
  });
  // Round strip and Economy tab. Without the money facts (unreadable) the rounds still come back, without buys.
  handle('demo:rounds', async (file, steamid) => {
    const { core, events } = await demoData(file);
    let facts = null;
    try { facts = await demoRounds(file); } catch (e) { log('rounds:', e.message); }
    return buildRounds(core, events, facts, steamid || mySteamId());
  });
  handle('art:list', () => themeArt.list());
  handle('art:shot', (name, thumb) => themeArt.shot(name, thumb));
  handle('art:team', code => themeArt.team(code));
  handle('art:teamSvg', code => themeArt.teamSvg(code));
  handle('art:weapon', code => themeArt.weapon(code));
  handle('art:mapIcon', map => themeArt.mapIcon(map));
  handle('radar:maps', () => JSON.parse(fs.readFileSync(path.join(__dirname, 'renderer', 'radar', 'maps.json'), 'utf8')));
  handle('demo:rename', (file, name) => { const id = store.idOf(file); store.setName(id, name); return store.name(id); });

  handle('hlae:check', () => checkHlaeUpdate(true));
  handle('hlae:update', async () => {
    if (recorder) throw new Error('Wait until the recording is finished.');
    if (hlae.cs2Pids().length) throw new Error('Close CS2 before updating HLAE.');
    const latest = hlaeLatest || await hlae.latestRelease();
    const version = await hlae.installRelease(latest, hlaeDir(), ffmpegFound || 'ffmpeg');
    log('HLAE updated to', version);
    hlaeLatest = latest;
    return { version };
  });

  handle('update:state', () => updater.state());
  handle('update:check', async () => {
    const r = await updater.check();
    if (r.status === 'error') throw new Error(r.error);
    if (r.status === 'available' && r.installed && s().updates.auto) updater.download().catch(() => {});
    return updater.state();
  });
  handle('update:download', () => updater.download());
  handle('update:page', () => { const p = updater.state().page; if (p?.startsWith('https://github.com/')) shell.openExternal(p); return true; });
  handle('update:install', () => {
    if (recorder) throw new Error('Wait until the recording is finished.');
    if (auto.running) throw new Error('DemoLab is still reading a new match. Try again in a moment.');
    updater.install({ relaunch: true });
    updating = true;
    setTimeout(() => app.quit(), 300);
    return true;
  });

  handle('downloads:list', () => ({ ...downloader.list(), community: communityState, faceit: faceitInfo() }));
  handle('downloads:check', () => checkMatches(true));
  handle('downloads:get', id => {
    const m = downloader.state.matches.find(x => x.id === id);
    if (m?.source === 'faceit') openFaceitRoom(m);
    else downloader.enqueue(id);
    return downloader.list();
  });
  handle('faceit:signIn', async () => {
    const account = await faceitLib.signIn(log);
    if (!account) return null;
    settings.update({ faceit: { playerId: account.id, nickname: account.nickname } });
    faceitState = 'ok';
    return account;
  });
  handle('faceit:signOut', async () => {
    await faceitLib.signOut();
    settings.update({ faceit: { playerId: '', nickname: '' } });
    faceitState = 'signedOut';
    log('signed out of FACEIT (button)');
    return true;
  });
  handle('community:signIn', async () => {
    const ok = await signIn(log);
    if (ok) communityState = 'ok';
    return ok;
  });
  handle('community:signOut', async () => { await signOut(); communityState = 'signedOut'; log('signed out of Steam Community (button)'); return true; });

  handle('record:start', async (items, steamid, opts = {}) => {
    if (recorder) throw new Error('A recording is already running.');
    if (watching) throw new Error('CS2 is still opening a demo for watching. Try again in a moment.');
    // The recording reuses a CS2 left open by "Watch in CS2" and closes it at the end.
    viewer?.session.sock?.destroy();
    viewer = null;
    // Never let CS2 start while the Steam helper is pretending to be CS2.
    while (downloader.checking) await new Promise(r => setTimeout(r, 500));
    if (!env.csgoDir) throw new Error('CS2 installation not found. Set it in Settings.');
    if (!ffmpegFound) throw new Error('ffmpeg not found. Set its path in Settings.');
    const missing = hlae.missingFiles(hlaeDir());
    if (missing.length) {
      let listing = '';
      try { listing = fs.readdirSync(hlaeDir()).length + ' entries'; } catch (e) { listing = e.code; }
      log('HLAE check failed in', hlaeDir(), '- missing/unreadable:', missing.join(', '), '- folder:', listing);
      throw new Error(`HLAE_MISSING: HLAE is not installed or incomplete in ${hlaeDir()} (missing or unreadable: ${missing.join(', ')}). If it was installed before, an antivirus may have removed or locked it. Click "Install HLAE" to download it, or choose another folder in Settings → Recording.`);
    }

    const jobs = [];
    for (const it of items) {
      const data = await parseDemo(it.demoPath);
      const a = analysis(it.demoPath, data, steamid || mySteamId());
      const h = a.highlights?.find(x => x.id === it.highlightId);
      if (!h) continue;
      jobs.push({ demoPath: it.demoPath, demoId: store.idOf(it.demoPath), demoDate: matchDate(it.demoPath, fs.statSync(it.demoPath)), map: data.map, player: a.player, highlight: h });
    }
    if (!jobs.length) throw new Error('Nothing to record.');

    recorder = new Recorder({
      settings: { ...s(), outputDir: outputDir(), hlae: { ...s().hlae, path: hlaeDir() }, targetMB: +opts.mb || 0 }, env,
      emit: u => send('record:update', u),
    });
    const r = recorder;
    send('record:update', { state: 'running', total: jobs.length, step: 'Starting…', progress: 0 });
    r.run(jobs).then(clips => {
      const lib = library();
      clips.forEach(c => lib.add(c));
      send('record:update', { state: 'done', clips: clips.length, progress: 1, step: `Done – ${clips.length} clip${clips.length === 1 ? '' : 's'} saved` });
    }).catch(err => {
      send('record:update', err instanceof Cancelled ? { state: 'cancelled', step: 'Cancelled' } : { state: 'error', error: err.message, step: 'Failed' });
    }).finally(() => { recorder = null; });
    return { started: true, count: jobs.length };
  });

  handle('record:cancel', () => { recorder?.cancel(); return true; });

  // "View demo" / "Watch in CS2": opens the demo in CS2 through HLAE, as for recording, and jumps to
  // a moment in one player's eyes.
  //   tick   where to go (default: the start of the first round); playback starts `lead` seconds before it
  //   name   player to spectate (optional)
  //   pause  pause on `tick` (e.g. the moment a grenade leaves the hand)
  // CS2 stays open afterwards; the next request reuses it.
  handle('demo:watch', async (file, { tick = null, name = '', lead = 0, pause = false } = {}) => {
    if (recorder) throw new Error('A recording is running. Wait until it has finished.');
    if (watching) throw new Error('CS2 is still opening the demo. Wait a moment.');
    if (!env.csgoDir) throw new Error('CS2 installation not found. Set it in Settings.');
    const missing = hlae.missingFiles(hlaeDir());
    if (missing.length) throw new Error(`HLAE_MISSING: Viewing demos in CS2 needs HLAE, which is not installed or incomplete in ${hlaeDir()} (missing: ${missing.join(', ')}). Install it from the Highlights & clips tab or Settings → Recording.`);
    watching = (async () => {
      const session = await viewerSession();
      if (viewer.demo !== file) {
        session.mark();
        await session.send([`playdemo "${demoRef(env.csgoDir, file, path.join(env.csgoDir, 'demolab_watch'))}"`]);
        if (!(await session.waitFor(/Demo is version|Signon traffic "DEMO"/, 180000, () => false))) throw new Error('CS2 did not load the demo within 3 minutes.');
        await new Promise(r => setTimeout(r, 3000));
        viewer.demo = file;
        viewer.map = null;
      }
      if (tick == null) tick = (await parseDemo(file)).rounds[0]?.startTick ?? 1;
      const who = String(name || '').replace(/[";]/g, '');
      const start = Math.max(1, Math.round(tick - lead * 64));
      await session.send([
        'demo_pause', 'mirv_cmd clear', 'demo_timescale 1',
        ...(who ? [`mirv_cmd addAtTick ${start + 32} spec_player "${who}"`, `mirv_cmd addAtTick ${start + 36} spec_mode 2`] : []),
        ...(pause ? [`mirv_cmd addAtTick ${Math.round(tick)} demo_pause`] : []),
        `demo_gototick ${start}`, 'demo_resume',
      ]);
    })();
    try { await watching; } finally { watching = null; }
    return true;
  });

  // "Practice in CS2": opens the lineup's map on a private practice server in the HLAE CS2 and puts the
  // player on the throw spot, aiming the same way, with the grenade in hand. Later lineups on the same
  // map only teleport.
  handle('practice:goto', async ({ map, from, angle, type, side }) => {
    if (recorder) throw new Error('A recording is running. Wait until it has finished.');
    if (watching) throw new Error('CS2 is still busy with the previous request. Wait a moment.');
    if (!env.csgoDir) throw new Error('CS2 installation not found. Set it in Settings.');
    if (!/^[a-z0-9_]+$/i.test(map || '') || !Array.isArray(from) || from.length < 3 || from.some(v => !Number.isFinite(v))) throw new Error('This lineup has no exact throw spot (paste the getpos line in Edit).');
    const missing = hlae.missingFiles(hlaeDir());
    if (missing.length) throw new Error(`HLAE_MISSING: Practicing in CS2 needs HLAE, which is not installed or incomplete in ${hlaeDir()} (missing: ${missing.join(', ')}). Install it from Settings → Recording.`);
    const ang = Array.isArray(angle) && angle.every(Number.isFinite) ? angle : [0, 0];
    watching = (async () => {
      const session = await viewerSession();
      if (viewer.map !== map) {
        await session.send([`map ${map}`]);
        // Loaded once the player exists: getpos answers with a setpos line.
        let ready = false;
        for (const until = Date.now() + 150000; !ready && Date.now() < until;) {
          await new Promise(r => setTimeout(r, 3000));
          session.mark();
          await session.send(['sv_cheats 1', 'getpos']);
          ready = !!(await session.waitFor(/setpos(?:_exact)?\s+-?\d/, 2500, () => false));
        }
        if (!ready) throw new Error(`CS2 did not finish loading ${map} within 2.5 minutes.`);
        await session.send([...PRACTICE, `jointeam ${side === 'CT' ? 3 : 2} 1`]);
        await new Promise(r => setTimeout(r, 2500));
        viewer.map = map;
        viewer.demo = null;
      }
      const give = type === 'molotov' && side === 'CT' ? 'weapon_incgrenade' : GIVE[type];
      await session.send([
        ...(give ? [`give ${give}`, `use ${give}`] : []),
        `setpos ${from.map(v => v.toFixed(2)).join(' ')}`, `setang ${ang[0]} ${ang[1]} 0`,
      ]);
    })();
    try { await watching; } finally { watching = null; }
    return true;
  });

  handle('utility:list', () => ({ items: utility.list(), imageDir: utility.imageDir }));
  handle('utility:save', item => utility.save(item));
  handle('utility:patch', (id, fields) => utility.patch(id, fields));
  handle('utility:delete', id => utility.remove(id));
  handle('utility:addImage', img => utility.addImage(img));
  handle('utility:screenshots', () => steamScreenshots(env.steamPath, mySteamId()));
  // Share codes (lib/utility.js): the code of some lineups, and the lineups in a pasted code (not saved yet;
  // dupe = already in the library).
  handle('utility:code', async ids => {
    const items = utility.list();
    const list = ids.map(id => items.find(x => x.id === id)).filter(Boolean);
    if (!list.length) throw new Error('No lineup to share.');
    try { return await shortCode(list, { upload: file => gallery.upload(file, {}), cacheFile: path.join(utility.dir, 'codes.json') }); }
    catch (e) { log('utility: short code failed', e.message); return shareCode(list); }
  });
  const fetchLineupFile = async id => {
    let res;
    try { res = await net.fetch(`https://files.catbox.moe/${id}.json`, { cache: 'no-store' }); }
    catch (e) { throw new Error(`Could not reach catbox.moe, where DLU2- codes keep their lineups (${e.message}). Some internet providers block it: changing your DNS to 1.1.1.1 usually fixes that.`); }
    if (res.status === 404) throw new Error(`The lineups of DLU2-${id} are no longer on catbox.moe. Ask for the code again.`);
    if (!res.ok) throw new Error(`catbox.moe did not send the lineups of DLU2-${id} (HTTP ${res.status}). Try again later.`);
    const text = await res.text();
    try { if (text.length <= 4 * 1048576) return JSON.parse(text); } catch {}
    throw new Error(`DLU2-${id} is not a lineup code.`);
  };
  handle('utility:readCode', async text => {
    const items = utility.list();
    return (await readCodes(text, { fetchShort: fetchLineupFile })).map(x => ({ ...x, dupe: items.some(y => sameLineup(x, y)) }));
  });
  handle('utility:import', list => {
    let n = 0;
    for (const x of (Array.isArray(list) ? list : []).slice(0, 500)) {
      if (utility.list().some(y => sameLineup(x, y))) continue;
      const { id, dupe, ...fields } = x;
      utility.save({ ...fields, source: null, fav: false });
      n++;
    }
    return n;
  });

  handle('clips:list', () => library().list());
  handle('clips:delete', async id => {
    const item = library().remove(id);
    if (item) {
      await shell.trashItem(item.file).catch(() => {});
      if (item.thumb) await shell.trashItem(item.thumb).catch(() => {});
    }
    return true;
  });
  handle('shell:reveal', file => { shell.showItemInFolder(file); return true; });
  handle('shell:open', file => shell.openPath(file));
  handle('shell:github', () => { shell.openExternal('https://github.com/Ze-Chr0ME/demo_lab'); return true; });
  handle('shell:market', name => {
    if (typeof name !== 'string' || !name || name.length > 200) return false;
    shell.openExternal(`https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}`);
    return true;
  });
  handle('shell:steamProfile', steamid => {
    if (!/^7656\d{13}$/.test(String(steamid))) return false; // bots and unknown players have no profile
    shell.openExternal(`https://steamcommunity.com/profiles/${steamid}`);
    return true;
  });

  // "My highlights" web page (lib/gallery.js). look: { theme, stats } from the renderer (galleryLook), so
  // the page wears the app's theme and shows the Overview's numbers.
  // The pictures it shows: my Steam picture (hidden with "show my Steam profile" off) and the theme's
  // team logo or map screenshot, as files on this PC.
  const galleryFiles = look => {
    const me = mySteamId();
    const t = look?.theme || {};
    let artFile = null;
    try {
      if (t.scene === 'team' && /^\w+$/.test(t.logo || '')) artFile = themeArt.team(t.logo);
      else if (t.scene === 'map' && /^\w+$/.test(t.shot || '')) artFile = themeArt.shot(t.shot);
    } catch {}
    const show = gallery.load().showSteam !== false && /^7656\d{13}$/.test(me);
    return { avatarFile: show ? avatars.get([me])[me] || null : null, artFile };
  };
  const galleryOpts = look => {
    const me = mySteamId();
    const show = gallery.load().showSteam !== false && /^7656\d{13}$/.test(me);
    return { steamid: show ? me : undefined, look, files: galleryFiles(look) };
  };
  const galleryState = look => {
    const g = gallery.load();
    const opts = galleryOpts(look);
    return {
      name: g.name, showSteam: g.showSteam !== false, hasUserhash: !!g.userhash, items: g.items, busy: gallery.busy, featured: g.featured || null,
      // not ready yet (new clip, theme, Steam picture, stats or Discord copy): gallery:sync uploads what's
      // missing and the page's data and the shortener's link, which give the short link
      missing: gallery.picturesMissing(opts.files) || g.items.some(x => !x.ctx || x.dc === undefined) || !gallery.isTiny(opts) || !gallery.fullLink(opts)?.startsWith(GALLERY_SHORT),
      short: gallery.isShort(opts),
      link: gallery.link(opts),
    };
  };
  // What the page tells about a clip: its kills (time in the clip, weapon, victim, headshot, wallbang…,
  // where on the map) and its round (side, score before it, both teams' buys, won or lost).
  async function clipContext(c) {
    if (c?.kind !== 'clip' || !c.demoId || !c.highlightId) return {};
    const d = scanDemos().find(x => x.id === c.demoId);
    if (!d) return {};
    const data = await parseDemo(d.path);
    const h = analysis(d.path, data, c.steamid).highlights?.find(x => x.id === c.highlightId);
    if (!h || Math.abs(h.duration - (c.duration || 0)) > 0.75) return {};
    let round = null, eco = null;
    try {
      const { core, events } = await demoData(d.path);
      let facts = null;
      try { facts = await demoRounds(d.path); } catch {}
      eco = buildRounds(core, events, facts, c.steamid);
      round = eco.rounds.find(r => r.num === h.round) || null;
    } catch (e) { log('gallery: round of', c.id, e.message); }
    const kl = share.clipKills(h, data.tickrate || 64).map(k => {
      const place = round?.kills.find(x => x.tick === k.tick)?.place;
      return { t: Math.round(k.t * 10) / 10, w: k.weapon, v: k.victim, f: [k.headshot ? 'Headshot' : null, ...(k.flags || [])].filter(Boolean), p: place && place !== 'Unknown' ? place : undefined };
    });
    let cx;
    if (round) {
      const us = round.teams[eco.myTeam], them = round.teams[eco.otherTeam];
      const before = { ...round.score };
      if (round.winner) before[round.winner]--;
      cx = { s: us.side, sc: [before[eco.myTeam], before[eco.otherTeam]], b: us.type || undefined, eb: them.type || undefined, w: round.winner ? +(round.winner === eco.myTeam) : undefined };
    }
    return { kl, cx };
  }
  // Uploads what the page still needs, then the page's data (the short link). Clips published before
  // kills and rounds were shown, or before Discord copies, get them here, once.
  async function gallerySync(look) {
    if (!gallery.load().items.length) return;
    const lib = library().list();
    for (const x of gallery.load().items.filter(i => !i.ctx)) {
      const extra = await clipContext(lib.find(c => c.id === x.id)).catch(e => { log('gallery: context', x.id, e.message); return {}; });
      gallery.patch(x.id, { ...extra, ctx: true });
    }
    if (ffmpegFound && gallery.load().items.some(i => i.dc === undefined)) {
      await encoderReady;
      for (const x of gallery.load().items.filter(i => i.dc === undefined)) {
        await gallery.addDiscordCopy(x.id, lib.find(c => c.id === x.id)?.file).catch(e => log('gallery: Discord copy', x.id, e.message));
      }
    }
    const opts = galleryOpts(look);
    await gallery.syncAssets(opts.files);
    await gallery.syncShort(opts);
  }
  handle('gallery:get', look => galleryState(look));
  handle('gallery:sync', async look => { await gallerySync(look); return galleryState(look); });
  handle('gallery:publish', async (id, look) => {
    const c = library().list().find(x => x.id === id);
    if (!c) throw new Error('This clip is no longer in the library.');
    if (!ffmpegFound) throw new Error('ffmpeg not found. Set its path in Settings.');
    await encoderReady;
    try {
      const extra = await clipContext(c).catch(e => { log('gallery: context', id, e.message); return {}; });
      await gallery.publish(c, { extra, onProgress: p => send('gallery:update', { id, ...p }) });
      send('gallery:update', { id, step: 'Making the short link…', progress: 1 });
      await gallerySync(look);
    } catch (e) {
      log('gallery: publish failed', id, e.message);
      send('gallery:update', { id, error: e.message });
      throw e;
    }
    return galleryState(look);
  });
  handle('gallery:remove', async (id, look) => { const r = await gallery.unpublish(id); return { ...galleryState(look), deleted: r.deleted }; });
  handle('gallery:move', (id, delta, look) => { gallery.move(id, delta); return galleryState(look); });
  handle('gallery:feature', (id, look) => { gallery.feature(id); return galleryState(look); });
  handle('gallery:set', (patch, look) => { gallery.set(patch); return galleryState(look); });
  handle('gallery:open', url => { if (isPageLink(url)) shell.openExternal(url); return true; });

  // Kill times of a clip for "Export for sharing". Clips recorded before kill times were saved get them
  // from their highlight, as long as it still has the clip's length (the timing settings may have changed).
  async function clipKillsOf(c) {
    if (c.kills) return c.kills;
    if (!c.demoId || !c.highlightId) return null;
    const d = scanDemos().find(x => x.id === c.demoId);
    if (!d) return null;
    const data = await parseDemo(d.path);
    const h = analysis(d.path, data, c.steamid).highlights?.find(x => x.id === c.highlightId);
    if (!h || Math.abs(h.duration - (c.duration || 0)) > 0.75) return null;
    return share.clipKills(h, data.tickrate || 64).map(k => ({ t: k.t, victim: k.victim, weapon: k.weapon, headshot: k.headshot }));
  }
  handle('clips:shareInfo', async id => {
    const c = library().list().find(x => x.id === id);
    if (!c) throw new Error('This clip is no longer in the library.');
    return { kills: c.kind === 'clip' ? await clipKillsOf(c).catch(() => null) : null };
  });
  // opts: { format, slowmo, speed, title, subtitle, feed, music: { file, volume, gameVolume } | null }
  handle('clips:share', async (id, opts) => {
    const lib = library();
    const c = lib.list().find(x => x.id === id);
    if (!c) throw new Error('This clip is no longer in the library.');
    if (!ffmpegFound) throw new Error('ffmpeg not found. Set its path in Settings.');
    if (opts.music?.file && !fs.existsSync(opts.music.file)) throw new Error('The music file was not found.');
    const kills = c.kind === 'clip' ? await clipKillsOf(c).catch(() => null) : null;
    const lastKill = kills?.at(-1);
    const dir = path.join(outputDir(), 'Shared');
    fs.mkdirSync(dir, { recursive: true });
    const label = { vertical: 'vertical', verticalFit: 'vertical', square: 'square' }[opts.format] || 'share';
    const base = `${path.basename(c.file, '.mp4')} (${label})`.replace(/[<>:"/\\|?*]/g, '');
    let file = path.join(dir, base + '.mp4');
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} ${n}.mp4`);
    send('share:update', { state: 'running', progress: 0 });
    try {
      const r = await share.exportShare(c.file, file, {
        format: opts.format,
        slowmo: opts.slowmo && lastKill ? { at: lastKill.t, speed: opts.speed || 0.5 } : null,
        title: (opts.title || '').trim(), subtitle: (opts.subtitle || '').trim(),
        feed: opts.feed && kills ? kills.map(k => ({ t: k.t, text: `${c.player || 'You'}  [${k.weapon}]  ${k.victim}${k.headshot ? '  (HS)' : ''}` })) : [],
        music: opts.music?.file ? opts.music : null,
        onProgress: p => send('share:update', { state: 'running', progress: p }),
      });
      const thumb = path.join(outputDir(), '.thumbs', path.basename(file, '.mp4') + '.jpg');
      fs.mkdirSync(path.dirname(thumb), { recursive: true });
      await ffmpeg.thumbnail(file, thumb, Math.min(2, r.duration / 2)).catch(() => {});
      const item = lib.add({
        ...c, id: `s${Date.now().toString(36)}`, kind: 'share', sourceId: c.id, sourceKind: c.kind, file, thumb: fs.existsSync(thumb) ? thumb : null,
        format: opts.format || 'original', width: r.width, height: r.height, duration: r.duration, createdAt: Date.now(),
        title: c.title,
      });
      send('share:update', { state: 'done', progress: 1 });
      return item;
    } catch (e) {
      send('share:update', { state: 'error', error: e.message });
      throw e;
    }
  });

  // What a target size gives: bitrate, resolution and fps for each length (seconds). For a montage (ids),
  // the length is the clips together and the source size is the first clip's.
  handle('video:sizePlan', async ({ mb, seconds = [], ids }) => {
    let src = { width: s().hlae.width, height: s().hlae.height, fps: s().hlae.fps };
    if (ids?.length) {
      const all = library().list();
      const clips = ids.map(id => all.find(c => c.id === id)).filter(Boolean);
      const first = clips[0] && await ffmpeg.probe(clips[0].file).catch(() => null);
      if (first?.width) src = first;
      seconds = [clips.reduce((t, c) => t + (c.duration || 0), 0)];
    }
    return seconds.map(t => ({ seconds: t, ...ffmpeg.sizePlan(mb, t, src) }));
  });

  handle('montage:make', async (ids, name, opts = {}) => {
    const lib = library();
    const all = lib.list();
    const clips = ids.map(id => all.find(c => c.id === id)).filter(Boolean);
    if (clips.length < 2) throw new Error('Pick at least 2 clips.');
    const dir = path.join(outputDir(), 'Montages');
    fs.mkdirSync(dir, { recursive: true });
    const base = (name || `Montage ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h')}`).replace(/[<>:"/\\|?*]/g, '');
    let file = path.join(dir, base + '.mp4');
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n}).mp4`);
    send('montage:update', { state: 'running', progress: 0 });
    try {
      const { duration } = await ffmpeg.montage(clips.map(c => c.file), file, {
        fade: s().montage.fade, mb: +opts.mb || 0, onProgress: p => send('montage:update', { state: 'running', progress: p }),
      });
      const thumb = path.join(outputDir(), '.thumbs', path.basename(file, '.mp4') + '.jpg');
      fs.mkdirSync(path.dirname(thumb), { recursive: true });
      await ffmpeg.thumbnail(file, thumb, 1).catch(() => {});
      const item = lib.add({
        id: `m${Date.now().toString(36)}`, kind: 'montage', file, thumb: fs.existsSync(thumb) ? thumb : null,
        title: base, tags: [`${clips.length} clips`], score: clips.reduce((a, c) => a + (c.score || 0), 0),
        map: [...new Set(clips.map(c => c.map))].join(', '), duration, createdAt: Date.now(), clipIds: ids,
      });
      send('montage:update', { state: 'done', progress: 1 });
      return item;
    } catch (e) {
      send('montage:update', { state: 'error', error: e.message });
      throw e;
    }
  });
}

// ---------- Match downloads ----------

// Two sources:
//  - Steam Community match history pages (Scrimmage, Rush, Premier, Wingman…): needs a one-time sign-in.
//  - Valve's recent-match list through the Steam client (gcWorker). Only while CS2 is closed: the
//    helper identifies itself to Steam as CS2, and two CS2 sessions would fight over the GC.
async function checkMatches(manual) {
  if (!env.cs2Dir) throw new Error('CS2 installation not found. Set it in Settings.');
  const cs2Open = hlae.cs2Pids().length > 0;
  const r = await downloader.check({
    autoDownload: s().downloads.auto,
    sources: {
      community: async () => {
        try {
          const entries = await community.fetchAll();
          communityState = 'ok';
          return entries;
        } catch (e) {
          if (e.signedOut) communityState = 'signedOut';
          throw e;
        }
      },
      gc: cs2Open || recorder ? null : () => fetchGcMatches(env),
      faceit: s().faceit.playerId ? async () => {
        try {
          const known = id => downloader.state.matches.find(m => m.id === id);
          const entries = await faceitLib.fetchMatches(s().faceit.playerId, known);
          faceitState = 'ok';
          return entries;
        } catch (e) {
          if (e.signedOut) faceitState = 'signedOut';
          throw e;
        }
      } : null,
    },
  });
  if (cs2Open) r.notes.push('Valve match list skipped while CS2 is open.');
  log(`check: ${r.matches.length} matches, ${r.newCount} new, community=${communityState}, faceit=${faceitState}${r.notes.length ? ', notes: ' + r.notes.join(' | ') : ''}`);
  existingCache.clear();
  if (!manual && r.newCount) send('downloads:update', { found: r.newCount });
  // New FACEIT demos need your click on FACEIT's page: say so outside the app too.
  const fresh = r.matches.filter(m => m.source === 'faceit' && m.status === 'available' && r.newIds.includes(m.id));
  if (!manual && fresh.length && s().autoProcess.notify) notifyFaceit(fresh);
  return { ...r, community: communityState, faceit: faceitInfo() };
}

function faceitInfo() {
  const f = s().faceit;
  return { state: f.playerId ? faceitState : 'signedOut', nickname: f.nickname };
}

function openFaceitRoom(m) {
  if (!m.url) throw new Error('FACEIT no longer has a demo for this match.');
  downloader.externalStep(m.id, { waiting: true });
  faceit.open(m);
}

function notifyFaceit(list) {
  if (!Notification.isSupported()) { if (win && !win.isDestroyed()) win.flashFrame(true); return; }
  const m = list[0];
  const title = list.length > 1 ? `${list.length} new FACEIT matches` : `New FACEIT match${m.mapLabel ? ` · ${m.mapLabel}` : ''}${m.score?.length === 2 ? ` ${m.score[0]}:${m.score[1]}` : ''}`;
  const n = new Notification({ title, body: 'Click, then press "Watch demo" on FACEIT: DemoLab reads it as soon as it arrives.', icon: auto.icon || undefined });
  n.on('click', () => { try { openFaceitRoom(m); } catch (e) { log('FACEIT room:', e.message); } });
  n.show();
}

// HLAE has to keep up with CS2 updates: look for a newer release at startup and every 6 hours.
let hlaeLatest = null;
async function checkHlaeUpdate(manual) {
  hlaeLatest = await hlae.latestRelease();
  const installed = hlae.hlaeVersion(hlaeDir());
  const updateAvailable = !installed || hlae.cmpVersion(hlaeLatest.version, installed) > 0;
  const r = { installed, latest: hlaeLatest.version, published: hlaeLatest.published, size: hlaeLatest.size, updateAvailable };
  if (!manual && updateAvailable) send('hlae:update-available', r);
  return r;
}

function scheduleAutoCheck() {
  const hlaeTick = () => checkHlaeUpdate(false).catch(e => log('HLAE update check failed:', e.message));
  setTimeout(hlaeTick, 8000);
  setInterval(hlaeTick, 6 * 3600 * 1000);
  // DemoLab itself: found releases are downloaded right away, installed on "Restart to update" or on quit.
  const updateTick = async () => {
    if (!s().updates.auto) return;
    const r = await updater.check();
    if (r.status === 'error') log('update check failed:', r.error);
    if (r.status === 'available' && r.installed) await updater.download().catch(() => {});
  };
  setTimeout(updateTick, 15000);
  setInterval(updateTick, 6 * 3600 * 1000);
  let last = 0;
  setInterval(() => {
    const d = s().downloads;
    if (!d.auto || downloader.checking || recorder) return;
    if (Date.now() - last < d.intervalMin * 60000) return;
    last = Date.now();
    checkMatches(false).catch(e => send('downloads:update', { autoError: e.message }));
  }, 20000);
}

// Matches you already have under another name (e.g. renamed to "Jonas1.dem") are recognised by
// map + number of rounds + players, using demos the app has already analysed.
const normMap = m => (m || '').toLowerCase().replace(/^(de|cs|ar)_/, '').replace(/[^a-z0-9]/g, '').replace(/ii$/, '2');
const existingCache = new Map();
function findExisting(m) {
  if (!m.players?.length || !m.rounds) return null;
  const hit = existingCache.get(m.id);
  if (hit && Date.now() - hit.t < 15000) return hit.file;
  const names = new Set(m.players.map(n => n.toLowerCase()));
  const map = normMap(m.mapLabel);
  let found = null;
  outer: for (const dir of demoFolders()) {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.dem$/i.test(name)) continue;
      const file = path.join(dir, name);
      let data = null;
      try { data = readCache(file); } catch {}
      if (!data || data.rounds.length !== m.rounds || (map && normMap(data.map) !== map)) continue;
      const overlap = data.players.filter(p => names.has((p.name || '').toLowerCase())).length;
      if (overlap >= Math.min(6, names.size)) { found = file; break outer; }
    }
  }
  existingCache.set(m.id, { t: Date.now(), file: found });
  return found;
}

app.whenReady().then(() => {
  // Installed builds: the Start menu shortcut carries this ID, which Windows needs to show notifications.
  if (app.isPackaged) app.setAppUserModelId('com.demolab.cs2');
  settings = new Settings(app.getPath('userData'));
  parserThreads(settings.get().lowEnd);
  store = new DemoStore(app.getPath('userData'), DATA_VERSION);
  utility = new UtilityStore(app.getPath('userData'));
  avatars = new AvatarStore(app.getPath('userData'), { fetch: net.fetch, steamPath: () => env?.steamPath, onUpdate: v => send('avatars:update', v), log });
  // The inventory request carries the Steam Community sign-in (Downloads tab), so a private inventory of your own still works.
  inventory = new InventoryStore(app.getPath('userData'), {
    fetch: net.fetch, steamFetch: (url, o) => session.fromPartition(PARTITION).fetch(url, o), onImages: v => send('inventory:images', v), onSales: v => send('inventory:sales', v), log,
  });
  themeArt = new ThemeArt(app.getPath('userData'), () => env?.csgoDir || null);
  // Dev aid: DEMOLAB_FAKE_UPLOAD=<folder> "uploads" the highlights page's files into that folder, not to catbox.
  const fakeDir = process.env.DEMOLAB_FAKE_UPLOAD;
  const fakeUpload = async file => { const name = require('crypto').randomBytes(3).toString('hex') + path.extname(file); fs.copyFileSync(file, path.join(fakeDir, name)); return name; };
  gallery = new Gallery(app.getPath('userData'), { log, ...(fakeDir ? { upload: fakeUpload, remove: async () => {}, shorten: async u => u } : {}) });
  updater = new Updater({ dir: path.join(app.getPath('userData'), 'updates'), version: app.getVersion(), fetch: net.fetch, installed: app.isPackaged, log, onChange: v => send('update:state', v) });
  refreshEnv();
  ffmpegFound = ffmpeg.resolve(settings.get().ffmpegPath);
  encoderReady = ffmpeg.pickEncoder(settings.get().encoder);
  downloader = new MatchDownloader({
    getEnv: () => env,
    demoFolders,
    stateFile: path.join(app.getPath('userData'), 'matches.json'),
    emit: e => {
      if (e.done) { log('downloaded', path.basename(e.file)); autoCandidate(e.file); }
      if (e.failed) log('download failed', e.failed, e.error);
      if (e.saveError) log('could not save matches.json:', e.saveError);
      send('downloads:update', e);
    },
    findExisting,
  });
  faceit = new faceitLib.Faceit({
    dir: () => downloader.replaysDir(),
    log,
    onProgress: (id, received, total) => downloader.externalStep(id, { received, total }),
    onDone: (id, file) => downloader.externalStep(id, { done: file }),
    onError: (id, message) => downloader.externalStep(id, { failed: message }),
    onClosed: id => downloader.externalStep(id, { closed: true }),
  });
  if (s().faceit.playerId) faceitLib.me().then(a => { faceitState = a ? 'ok' : 'signedOut'; log('startup - FACEIT:', faceitState); }).catch(() => {});
  watchCookies(log);
  loginCookieSummary().then(c => log('startup - Steam login cookies:', c)).catch(() => {});
  registerIpc();
  createWindow();
  scheduleAutoCheck();
  startAutoProcessing();
});

app.on('window-all-closed', () => { recorder?.cancel(); store?.flush(); app.quit(); });
// An update downloaded in the background installs when DemoLab closes (silently, without starting it again).
app.on('will-quit', () => {
  if (updating || updater?.state().status !== 'ready' || !s().updates.auto) return;
  try { updater.install({ relaunch: false }); } catch (e) { log('update on quit failed:', e.message); }
});
