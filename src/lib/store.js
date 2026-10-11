// Everything the app remembers about demos, keyed by the demo's content rather than its path:
// renaming, moving or copying a demo, or a changed file date, never makes the app parse it again.
//
// <userData>/demo-data/
//   index.json        path|size|mtime -> demo id, so ids don't need re-hashing on every scan
//   names.json        demo id -> custom name shown in the UI
//   failures.json     demo id -> { version, map, error } for demos the parser rejected
//   derived.json      demo id|steamid -> per-player match summary (overview), rebuilt when its version changes
//   <id>.json         core data: rounds, rosters, kills (highlights, lists, duplicate detection)
//   <id>.events.json  damage, shots, flashes, grenades, bomb (scoreboard, heatmap)
//   <id>.track.bin    sampled player positions for the 2D replay, built on first use
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHUNK = 256 * 1024;

// size + first and last 256 KB: the start holds the server/map signon, the end the final ticks of
// that specific match. Reading 512 KB takes milliseconds, hashing a whole 300 MB demo would not.
function fingerprint(file, size) {
  const hash = crypto.createHash('sha1').update(String(size));
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(CHUNK, size));
    hash.update(buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)));
    if (size > CHUNK) hash.update(buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, Math.max(CHUNK, size - CHUNK))));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex').slice(0, 24);
}

class JsonFile {
  constructor(file) {
    this.file = file;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
    this.timer = null;
  }
  get(k) { return this.data[k]; }
  set(k, v) {
    if (v === undefined) delete this.data[k]; else this.data[k] = v;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }
  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch {}
  }
}

class DemoStore {
  constructor(userData, version) {
    this.dir = path.join(userData, 'demo-data');
    this.version = version;
    fs.mkdirSync(this.dir, { recursive: true });
    this.index = new JsonFile(path.join(this.dir, 'index.json'));
    this.names = new JsonFile(path.join(this.dir, 'names.json'));
    this.failures = new JsonFile(path.join(this.dir, 'failures.json'));
    this.derivedFile = new JsonFile(path.join(this.dir, 'derived.json'));
    this.core = new Map();   // id -> core data (small, all demos stay in memory)
    this.events = new Map(); // id -> events data (bigger, only the last few)
    // The previous cache was keyed by file path; its contents are superseded by demo-data.
    fs.rm(path.join(userData, 'demo-cache'), { recursive: true, force: true }, () => {});
  }

  flush() { this.index.flush(); this.names.flush(); this.failures.flush(); this.derivedFile.flush(); }

  idOf(file, st = fs.statSync(file)) {
    const key = `${file.toLowerCase()}|${st.size}|${st.mtimeMs}`;
    let id = this.index.get(key);
    if (!id) { id = fingerprint(file, st.size); this.index.set(key, id); }
    return id;
  }

  readCore(id) {
    if (this.core.has(id)) return this.core.get(id);
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8'));
      if (data.version === this.version) { this.core.set(id, data); return data; }
    } catch {}
    return null;
  }

  readEvents(id) {
    if (this.events.has(id)) return this.events.get(id);
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.events.json`), 'utf8'));
      if (data.version !== this.version) data = null;
    } catch {}
    if (data) {
      this.events.set(id, data);
      if (this.events.size > 8) this.events.delete(this.events.keys().next().value);
    }
    return data;
  }

  write(id, { core, events }) {
    fs.writeFileSync(path.join(this.dir, `${id}.events.json`), JSON.stringify(events));
    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(core));
    this.core.set(id, core);
    this.events.delete(id);
    this.failures.set(id, undefined);
  }

  forget(id) {
    this.core.delete(id);
    this.events.delete(id);
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }

  // A demo the parser rejected stays rejected until the extraction code changes.
  failure(id) {
    const f = this.failures.get(id);
    return f && f.version === this.version ? f : null;
  }
  setFailure(id, info) { this.failures.set(id, { version: this.version, ...info }); }

  // Values computed from the stored facts, so they are never stale: the key includes both versions.
  derived(key, version) {
    const v = this.derivedFile.get(key);
    return v && v.v === `${this.version}.${version}` ? v.value : undefined;
  }
  setDerived(key, version, value) { this.derivedFile.set(key, { v: `${this.version}.${version}`, value }); }

  name(id) { return this.names.get(id) || null; }
  setName(id, name) { this.names.set(id, (name || '').trim().slice(0, 80) || undefined); }

  trackFile(id) { return path.join(this.dir, `${id}.track.bin`); }
}

module.exports = { DemoStore, fingerprint };
