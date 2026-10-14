const { app, BrowserWindow, ipcMain, dialog, shell, Menu, crashReporter, screen, net } = require('electron');
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
const { heatPoints } = require('./lib/heat');
const { matchSummary, PROFILE_VERSION } = require('./lib/profile');
const { unpackTrack } = require('./lib/track');
const { INTEGRITY_VERSION, scoreIntegrity } = require('./lib/integrity');
const { ensureGeometry } = require('./lib/geometry');
const { MatchDownloader, fetchGcMatches } = require('./lib/matches');
const { decode } = require('./lib/proto');
const { Community, signIn, signOut, watchCookies, loginCookieSummary } = require('./lib/community');
const hlae = require('./lib/hlae');
const { UtilityStore, steamScreenshots } = require('./lib/utility');

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
let store; // DemoStore: parsed data, failures and custom names, keyed by demo content
let utility; // UtilityStore: the Utility page's lineups

// Diagnostics: crashes, unexpected quits and sign-in steps go to <userData>/clipmaker.log.
function log(...parts) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'clipmaker.log'), `[${new Date().toISOString()}] ${parts.join(' ')}\n`); } catch {}
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
    title: 'CS2 ClipMaker',
    // The screenshot dev aid (below) needs painting to continue while the window is in the background.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: !process.env.CLIPMAKER_SCREENSHOT },
  });
  // Dev aid: CLIPMAKER_SIZE=2560x1440 sets the window's content size (layout checks for other monitors).
  if (process.env.CLIPMAKER_SIZE) win.setContentSize(...process.env.CLIPMAKER_SIZE.split('x').map(Number));
  win.on('closed', () => log('main window closed'));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Dev aid: CLIPMAKER_SCREENSHOT=<file.png> saves a capture of the window after load.
  if (process.env.CLIPMAKER_SCREENSHOT) {
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log('[renderer]', message); });
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.CLIPMAKER_EVAL) { await win.webContents.executeJavaScript(process.env.CLIPMAKER_EVAL).catch(e => console.log('[eval]', e.message)); await new Promise(r => setTimeout(r, 2500)); }
      fs.writeFileSync(process.env.CLIPMAKER_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
      if (!process.env.CLIPMAKER_KEEP_OPEN) app.quit();
    }, +(process.env.CLIPMAKER_DELAY || 6000)));
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
      const w = new Worker(path.join(__dirname, 'lib', 'parseWorker.js'), { workerData: { file, mode: 'track', core } });
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

// Aim and visibility facts for the Integrity tab: built once per demo (same queue), then read from
// <id>.integrity.json. Progress goes to the renderer as integrity:progress. Facts made without map
// geometry are rebuilt once the geometry is there.
const checking = new Map();
async function demoIntegrity(file) {
  const core = await parseDemo(file);
  const id = store.idOf(file);
  const out = store.integrityFile(id);
  let cached = null;
  try { const d = JSON.parse(fs.readFileSync(out, 'utf8')); if (d.version === INTEGRITY_VERSION) cached = d; } catch {}
  if (cached?.los) return { core, facts: cached };
  if (!checking.has(id)) {
    const job = (async () => {
      if (!fs.existsSync(path.join(app.getPath('userData'), 'geometry', 'manifest.json'))) send('integrity:progress', { id, progress: 0, phase: 'geometry' });
      const dir = await geometryDir();
      if (cached && !meshFor(dir, core.map)) return cached;
      const run = parseQueue.then(() => new Promise((resolve, reject) => {
        const w = new Worker(path.join(__dirname, 'lib', 'parseWorker.js'), { workerData: { file, mode: 'integrity', core, geometryDir: dir } });
        w.on('message', msg => {
          if (msg.progress != null) return send('integrity:progress', { id, progress: msg.progress, phase: 'demo' });
          w.terminate();
          if (!msg.ok) return reject(new Error(`Could not check this demo: ${msg.error}`));
          fs.writeFileSync(out, JSON.stringify(msg.data));
          resolve(msg.data);
        });
        w.once('error', reject);
      }));
      parseQueue = run.catch(() => {});
      return run;
    })().finally(() => checking.delete(id));
    checking.set(id, job);
  }
  return { core, facts: await checking.get(id) };
}

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

  // The overview dashboard: my summary for every parsed demo I played in (each demo once, even if copied).
  // Demos that aren't parsed yet are skipped; the renderer asks again as the background parsing goes on.
  handle('profile:get', () => {
    const me = mySteamId();
    const matches = [];
    const seen = new Set();
    for (const d of scanDemos()) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const sum = me ? summaryOf(d.id, me) : null;
      if (sum) matches.push({ id: d.id, path: d.path, date: d.date, customName: d.customName, ...sum });
    }
    return { steamid: me, name: matches[0]?.name || env.steamUser?.name || '', matches };
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
    return buildMatchStats(core, events, mySteamId());
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

  handle('downloads:list', () => ({ ...downloader.list(), community: communityState }));
  handle('downloads:check', () => checkMatches(true));
  handle('downloads:get', id => { downloader.enqueue(id); return downloader.list(); });
  handle('community:signIn', async () => {
    const ok = await signIn(log);
    if (ok) communityState = 'ok';
    return ok;
  });
  handle('community:signOut', async () => { await signOut(); communityState = 'signedOut'; log('signed out of Steam Community (button)'); return true; });

  handle('record:start', async (items, steamid) => {
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
      settings: { ...s(), outputDir: outputDir(), hlae: { ...s().hlae, path: hlaeDir() } }, env,
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
      const cfg = s();
      let session = viewer?.session;
      if (!session?.sock) {
        session = new hlae.HlaeSession({
          dir: hlaeDir(), cs2Dir: env.cs2Dir, port: cfg.hlae.port, width: cfg.hlae.width, height: cfg.hlae.height,
          ffmpegPath: ffmpegFound || 'ffmpeg', log: m => log('watch:', m),
        });
        const { launched } = await session.start(() => false);
        viewer = { session, demo: null };
        if (launched) await new Promise(r => setTimeout(r, cfg.timing.startupWait * 1000));
      }
      if (viewer.demo !== file) {
        session.mark();
        await session.send([`playdemo "${demoRef(env.csgoDir, file, path.join(env.csgoDir, 'clipmaker_watch'))}"`]);
        if (!(await session.waitFor(/Demo is version|Signon traffic "DEMO"/, 180000, () => false))) throw new Error('CS2 did not load the demo within 3 minutes.');
        await new Promise(r => setTimeout(r, 3000));
        viewer.demo = file;
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

  handle('utility:list', () => ({ items: utility.list(), imageDir: utility.imageDir }));
  handle('utility:save', item => utility.save(item));
  handle('utility:patch', (id, fields) => utility.patch(id, fields));
  handle('utility:delete', id => utility.remove(id));
  handle('utility:addImage', img => utility.addImage(img));
  handle('utility:screenshots', () => steamScreenshots(env.steamPath, mySteamId()));

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

  handle('montage:make', async (ids, name) => {
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
        fade: s().montage.fade, onProgress: p => send('montage:update', { state: 'running', progress: p }),
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
    },
  });
  if (cs2Open) r.notes.push('Valve match list skipped while CS2 is open.');
  log(`check: ${r.matches.length} matches, ${r.newCount} new, community=${communityState}${r.notes.length ? ', notes: ' + r.notes.join(' | ') : ''}`);
  existingCache.clear();
  if (!manual && r.newCount) send('downloads:update', { found: r.newCount });
  return { ...r, community: communityState };
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
  settings = new Settings(app.getPath('userData'));
  store = new DemoStore(app.getPath('userData'), DATA_VERSION);
  utility = new UtilityStore(app.getPath('userData'));
  refreshEnv();
  ffmpegFound = ffmpeg.resolve(settings.get().ffmpegPath);
  encoderReady = ffmpeg.pickEncoder(settings.get().encoder);
  downloader = new MatchDownloader({
    getEnv: () => env,
    demoFolders,
    stateFile: path.join(app.getPath('userData'), 'matches.json'),
    emit: e => {
      if (e.done) log('downloaded', path.basename(e.file));
      if (e.failed) log('download failed', e.failed, e.error);
      if (e.saveError) log('could not save matches.json:', e.saveError);
      send('downloads:update', e);
    },
    findExisting,
  });
  watchCookies(log);
  loginCookieSummary().then(c => log('startup - Steam login cookies:', c)).catch(() => {});
  registerIpc();
  createWindow();
  scheduleAutoCheck();
});

app.on('window-all-closed', () => { recorder?.cancel(); store?.flush(); app.quit(); });
