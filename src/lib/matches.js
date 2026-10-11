// Fetches your recent official matches from Valve (via gcWorker.js) and downloads their demos
// into CS2's replays folder, named exactly like CS2's own downloads (with the .info file), so the
// Watch tab treats them as already downloaded.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const bz2 = require('unbzip2-stream');
const { decode, ints } = require('./proto');

function clientVersion(csgoDir) {
  try { return /ClientVersion=(\d+)/.exec(fs.readFileSync(path.join(csgoDir, 'steam.inf'), 'utf8'))[1]; } catch { return ''; }
}

// Runs the GC request in a child process (Steam shows "playing CS2" only while it runs).
function requestList(env) {
  const dll = path.join(env.cs2Dir, 'game', 'bin', 'win64', 'steam_api64.dll');
  if (!fs.existsSync(dll)) return Promise.reject(new Error('steam_api64.dll not found in the CS2 folder.'));
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'gcWorker.js'), dll, clientVersion(env.csgoDir)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SteamAppId: '730', SteamGameId: '730' },
      windowsHide: true,
    });
    let out = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('Timed out talking to Steam.')); }, 90000);
    p.stdout.on('data', d => { out += d; });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop();
      try {
        const r = JSON.parse(line);
        r.ok ? resolve(r) : reject(new Error(r.error));
      } catch { reject(new Error('Unexpected answer from the Steam helper.')); }
    });
  });
}

function modeName(maxRounds) {
  if (maxRounds === 24) return 'Premier / Competitive';
  if (maxRounds === 16) return 'Wingman';
  return 'Other mode';
}

// Decodes a CDataGCCStrike15_v2_MatchInfo into what the UI needs.
function parseMatch(b64) {
  const raw = Buffer.from(b64, 'base64');
  const m = decode(raw);
  const rounds = (m[5] || []).map(decode);
  const last = rounds[rounds.length - 1] || {};
  const url = [...rounds].reverse().map(r => r[3]?.[0]?.toString()).find(u => u && /^https?:\/\//.test(u)) || null;
  let fileBase = null;
  if (url) {
    const u = /replay(\d+)\.valve\.net\/730\/([0-9_]+)\.dem/.exec(url);
    if (u) fileBase = `match730_${u[2]}_${u[1]}`;
  }
  const maxRounds = last[31] ? Number(last[31][0]) : null;
  return {
    source: 'gc',
    id: fileBase || m[1]?.[0]?.toString(),
    matchid: m[1]?.[0]?.toString(),
    time: m[2] ? Number(m[2][0]) * 1000 : null,
    url, fileBase,
    score: ints(last[12]),
    rounds: rounds.length,
    durationMin: last[15] ? Math.round(Number(last[15][0]) / 60) : null,
    maxRounds,
    mode: modeName(maxRounds),
    raw: b64,
  };
}

class MatchDownloader {
  /**
   * sources: { gc: () => Promise<entries>|null, community: () => Promise<entries>|null } — each returns
   *   entries or throws; main decides whether a source can run right now.
   * findExisting(entry): path of a demo already on disk for this match under another name, or null.
   */
  constructor({ getEnv, demoFolders, stateFile, emit, findExisting = () => null }) {
    this.getEnv = getEnv;
    this.demoFolders = demoFolders;
    this.stateFile = stateFile;
    this.emit = emit;
    this.findExisting = findExisting;
    this.state = { matches: [], lastCheck: null, downloaded: {} };
    try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch {}
    // Entries saved by older versions were keyed by GC match id only.
    for (const m of this.state.matches) { m.id ||= m.fileBase || m.matchid; m.source ||= 'gc'; }
    this.queue = [];
    this.active = null;
    this.checking = false;
  }

  // Never throws: a failed save must not abort a check or mark a finished download as failed.
  save() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) {
      this.emit({ saveError: e.message });
    }
  }

  replaysDir() { return path.join(this.getEnv().csgoDir, 'replays'); }

  // 'downloaded' | 'removed' (you deleted/moved it after a download; never re-fetched automatically)
  // | 'queued' | 'downloading' | 'available' | 'expired'
  status(m) {
    if (this.active?.id === m.id) return 'downloading';
    if (this.queue.some(q => q.id === m.id)) return 'queued';
    if (this.localFile(m)) return 'downloaded';
    if (!m.url) return 'expired';
    const name = m.fileBase + '.dem';
    if (this.state.downloaded[m.id] || this.state.downloaded[m.matchid] || fs.existsSync(path.join(this.replaysDir(), name + '.info'))) return 'removed';
    return 'available';
  }

  // Match start time for a downloaded demo, by file name (without .dem).
  matchTime(fileBase) {
    return this.state.matches.find(m => m.fileBase === fileBase)?.time || null;
  }

  localFile(m) {
    if (m.fileBase) {
      for (const d of this.demoFolders()) {
        const f = path.join(d, m.fileBase + '.dem');
        if (fs.existsSync(f)) return f;
      }
    }
    return this.findExisting(m);
  }

  list() {
    return {
      lastCheck: this.state.lastCheck,
      checking: this.checking,
      progress: this.active ? { id: this.active.id, ...this.active.progress } : null,
      matches: this.state.matches.map(m => ({ ...m, raw: undefined, status: this.status(m), file: this.localFile(m) })),
    };
  }

  // Adds/updates entries. The same match can come from both sources: keep the GC protobuf (.info)
  // and take the more precise mode name from Steam Community.
  merge(entries) {
    const byId = new Map(this.state.matches.map(m => [m.id, m]));
    for (const e of entries) {
      const old = byId.get(e.id);
      byId.set(e.id, old ? {
        ...old, ...e,
        raw: e.raw || old.raw, matchid: e.matchid || old.matchid,
        mode: e.source === 'community' ? e.mode : (old.source === 'community' ? old.mode : e.mode),
        mapLabel: e.mapLabel || old.mapLabel, players: e.players || old.players,
      } : e);
    }
    this.state.matches = [...byId.values()].sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 150);
  }

  // Runs every source that is available, merges the results and queues new demos.
  async check({ autoDownload, sources }) {
    if (this.checking) return { ...this.list(), newCount: 0, notes: [] };
    this.checking = true;
    this.emit({ checking: true });
    const notes = [];
    try {
      const fresh = [];
      for (const [name, run] of Object.entries(sources)) {
        if (!run) continue;
        try { fresh.push(...await run()); } catch (e) { notes.push(`${name === 'gc' ? 'Valve match list' : 'Steam Community'}: ${e.message}`); }
      }
      if (!fresh.length && notes.length) throw new Error(notes.join('\n'));
      const before = new Set(this.state.matches.filter(m => this.status(m) !== 'available').map(m => m.id));
      this.merge(fresh);
      this.state.lastCheck = Date.now();
      this.save();
      const newOnes = this.state.matches.filter(m => this.status(m) === 'available' && fresh.some(f => f.id === m.id) && !before.has(m.id));
      if (autoDownload) newOnes.forEach(m => this.enqueue(m.id));
      return { ...this.list(), newCount: newOnes.length, notes };
    } finally {
      this.checking = false;
      this.emit({ checking: false });
    }
  }

  enqueue(id) {
    const m = this.state.matches.find(x => x.id === id);
    if (!m || !m.url || !m.fileBase || this.active?.id === id || this.queue.some(q => q.id === id)) return;
    this.queue.push(m);
    this.emit({ queued: id });
    this.pump();
  }

  async pump() {
    if (this.active || !this.queue.length) return;
    const m = this.queue.shift();
    this.active = { id: m.id, progress: { received: 0, total: 0 } };
    try {
      const file = await this.download(m);
      this.state.downloaded[m.id] = file;
      this.save();
      this.emit({ done: m.id, file });
    } catch (e) {
      this.emit({ failed: m.id, error: e.message });
    } finally {
      this.active = null;
      this.pump();
    }
  }

  async download(m) {
    const dir = this.replaysDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, m.fileBase + '.dem');
    const part = target + '.part';
    const res = await get(m.url);
    if (res.statusCode === 404) { res.resume(); throw new Error('Valve has deleted this demo (they expire after a few weeks).'); }
    if (res.statusCode !== 200) { res.resume(); throw new Error(`Download failed (HTTP ${res.statusCode}).`); }
    const total = Number(res.headers['content-length']) || 0;
    let received = 0, lastEmit = 0;
    const counter = new Transform({
      transform: (chunk, _enc, cb) => {
        received += chunk.length;
        this.active.progress = { received, total };
        if (Date.now() - lastEmit > 400) { lastEmit = Date.now(); this.emit({ progress: { id: m.id, received, total } }); }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(res, counter, /\.bz2$/i.test(m.url) ? bz2() : new Transform({ transform: (c, _e, cb) => cb(null, c) }), fs.createWriteStream(part));
      fs.renameSync(part, target);
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw e;
    }
    if (m.raw) fs.writeFileSync(target + '.info', Buffer.from(m.raw, 'base64'));
    // Without a .info file (Steam Community downloads) the file date is all that survives if the
    // match drops out of matches.json, so make it the match date rather than the download date.
    else if (m.time) try { fs.utimesSync(target, new Date(), new Date(m.time)); } catch {}
    return target;
  }
}

function get(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    (url.startsWith('https') ? https : http).get(url, { timeout: 30000 }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      } else resolve(res);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Connection timed out')); });
  });
}

async function fetchGcMatches(env) {
  const r = await requestList(env);
  return r.matches.map(parseMatch).filter(m => m.id);
}

module.exports = { MatchDownloader, parseMatch, fetchGcMatches };
