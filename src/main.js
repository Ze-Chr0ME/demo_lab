const { app, BrowserWindow, ipcMain, dialog, shell, Menu, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const steam = require('./lib/steam');
const ffmpeg = require('./lib/ffmpeg');
const { Settings } = require('./lib/settings');
const { Library } = require('./lib/library');
const { Recorder, Cancelled } = require('./lib/recorder');
const { buildHighlights, weaponName } = require('./lib/highlights');
const { DATA_VERSION } = require('./lib/demo');
const { DemoStore } = require('./lib/store');
const { buildMatchStats } = require('./lib/stats');
const { heatPoints } = require('./lib/heat');
const { unpackTrack } = require('./lib/track');
const { MatchDownloader, fetchGcMatches } = require('./lib/matches');
const { decode } = require('./lib/proto');
const { Community, signIn, signOut, watchCookies, loginCookieSummary } = require('./lib/community');
const hlae = require('./lib/hlae');

let win;
let settings;
let env;
let recorder = null;
let ffmpegFound = null;
let encoderReady = Promise.resolve();
let downloader;
const community = new Community();
let communityState = 'unknown'; // 'ok' | 'signedOut' | 'unknown' (not checked yet)
let store; // DemoStore: parsed data, failures and custom names, keyed by demo content

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
  win = new BrowserWindow({
    width: 1380, height: 880, minWidth: 1000, minHeight: 640,
    backgroundColor: '#0d0f12',
    title: 'CS2 ClipMaker',
    // The screenshot dev aid (below) needs painting to continue while the window is in the background.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: !process.env.CLIPMAKER_SCREENSHOT },
  });
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

// Heatmap points per demo and player, kept in memory: the "all matches on this map" view reuses them.
const heatCache = new Map();
function heatOf(id, steamid) {
  const key = id + '|' + steamid;
  if (heatCache.has(key)) return heatCache.get(key);
  const core = store.readCore(id), events = store.readEvents(id);
  if (!core || !events) return null;
  const pts = heatPoints(core, events, steamid);
  heatCache.set(key, pts);
  if (heatCache.size > 200) heatCache.delete(heatCache.keys().next().value);
  return pts;
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

  handle('demos:list', () => {
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
        let data = null;
        try { data = readCache(file); } catch { continue; }
        let summary = null;
        if (data) {
          const a = analysis(file, data, mySteamId());
          summary = { map: data.map, highlights: a.highlights?.length ?? null, best: a.highlights?.reduce((m, h) => Math.max(m, h.score), 0) ?? 0, score: a.score || null, stats: a.stats || null };
        }
        const id = store.idOf(file, st);
        const failure = store.failure(id);
        out.push({ id, path: file, name, customName: store.name(id), folder: dir, size: st.size, mtime: st.mtimeMs, date: matchDate(file, st), summary, failure: failure && { map: failure.map } });
      }
    }
    return out.sort((a, b) => b.date - a.date);
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
    if (scope === 'map') {
      for (const dir of demoFolders()) {
        for (const name of fs.readdirSync(dir)) {
          if (!/\.dem$/i.test(name)) continue;
          try {
            const id = store.idOf(path.join(dir, name));
            if (store.readCore(id)?.map === core.map) ids.add(id);
          } catch {}
        }
      }
    }
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
  // Everything the 2D replay needs: sampled positions plus kills, grenades and bomb events.
  handle('demo:replay', async file => {
    const { core, events } = await demoData(file);
    const track = await demoTrack(file);
    return {
      map: core.map, tickrate: core.tickrate, players: core.players,
      rounds: core.rounds.map(({ roster, ...r }) => r),
      kills: core.kills.map(k => ({ tick: k.tick, round: k.round, attacker: k.attacker, victim: k.victim, attackerTeam: k.attackerTeam, victimTeam: k.victimTeam, weapon: weaponName(k.weapon), headshot: k.headshot, victimPos: k.victimPos })),
      grenades: events.grenades, bomb: events.bomb,
      track: { header: track.header, data: new Uint8Array(track.data.buffer, track.data.byteOffset, track.data.byteLength) },
    };
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
      jobs.push({ demoPath: it.demoPath, demoDate: matchDate(it.demoPath, fs.statSync(it.demoPath)), map: data.map, player: a.player, highlight: h });
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
