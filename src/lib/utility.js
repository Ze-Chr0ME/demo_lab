// The Utility page's lineups (grenade throws to remember) in <userData>/utility/lineups.json, with
// their screenshots in <userData>/utility/images. Positions are CS2 world coordinates.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = new Set(['smoke', 'flash', 'molotov', 'he']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_IMAGE = 25 * 1048576;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const vec = (v, n) => (Array.isArray(v) && v.length >= n && v.slice(0, n).every(x => num(x) !== null || x === null) && num(v[0]) !== null && num(v[1]) !== null ? v.slice(0, n) : null);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

class UtilityStore {
  constructor(dir) {
    this.dir = path.join(dir, 'utility');
    this.imageDir = path.join(this.dir, 'images');
    this.file = path.join(this.dir, 'lineups.json');
    this.pending = new Map(); // image file -> when it was added
  }

  list() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; }
  }

  write(items) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
    fs.renameSync(tmp, this.file);
    this.prune(items);
  }

  // Creates (no id) or replaces a lineup; only known fields are kept.
  save(input) {
    const items = this.list();
    const old = items.find(x => x.id === input.id);
    const now = Date.now();
    const item = {
      id: old?.id || crypto.randomUUID(),
      name: str(input.name, 120).trim() || 'Untitled lineup',
      map: str(input.map, 64),
      type: TYPES.has(input.type) ? input.type : 'smoke',
      side: ['T', 'CT'].includes(input.side) ? input.side : 'both',
      from: vec(input.from, 3),
      to: vec(input.to, 3),
      angle: vec(input.angle, 2),
      lower: !!input.lower,
      move: str(input.move, 32),
      click: str(input.click, 16),
      aim: str(input.aim, 500),
      notes: str(input.notes, 4000),
      images: (Array.isArray(input.images) ? input.images : []).filter(f => typeof f === 'string' && fs.existsSync(path.join(this.imageDir, path.basename(f)))).map(f => path.basename(f)),
      path: Array.isArray(input.path) ? input.path.filter(p => vec(p, 3)).slice(0, 400).map(p => p.slice(0, 3).map(x => Math.round(x))) : null,
      source: input.source && typeof input.source === 'object' ? {
        demoPath: str(input.source.demoPath, 1024), demoId: str(input.source.demoId, 128), tick: num(input.source.tick), player: str(input.source.player, 64),
      } : null,
      fav: !!input.fav,
      practiced: old?.practiced || 0,
      lastPracticed: old?.lastPracticed || null,
      quiz: old?.quiz || null,
      createdAt: old?.createdAt || now,
      updatedAt: now,
    };
    const next = old ? items.map(x => (x.id === item.id ? item : x)) : [item, ...items];
    this.write(next);
    return item;
  }

  patch(id, fields) {
    const items = this.list();
    const it = items.find(x => x.id === id);
    if (!it) throw new Error('Lineup not found.');
    if (fields.fav !== undefined) it.fav = !!fields.fav;
    if (fields.practiced) { it.practiced = (it.practiced || 0) + 1; it.lastPracticed = Date.now(); }
    // Practice quiz: right and wrong answers, and when it was last asked.
    if (fields.quiz !== undefined) {
      const q = it.quiz || { right: 0, wrong: 0, last: null };
      if (fields.quiz) q.right++; else q.wrong++;
      q.last = Date.now();
      it.quiz = q;
    }
    this.write(items);
    return it;
  }

  remove(id) {
    this.write(this.list().filter(x => x.id !== id));
    return true;
  }

  // Stores an image (bytes from a paste or drop, or a file on disk) and returns its file name. It is
  // deleted again by prune() unless a saved lineup refers to it.
  addImage({ bytes, ext, file }) {
    let data;
    if (file) {
      ext = path.extname(file).toLowerCase();
      if (!IMAGE_EXT.has(ext)) throw new Error('Not an image file.');
      if (fs.statSync(file).size > MAX_IMAGE) throw new Error('That image is too big (25 MB max).');
      data = fs.readFileSync(file);
    } else {
      ext = `.${String(ext || 'png').replace(/^\./, '').toLowerCase()}`;
      if (!IMAGE_EXT.has(ext)) throw new Error('Not an image file.');
      data = Buffer.from(bytes);
      if (data.length > MAX_IMAGE) throw new Error('That image is too big (25 MB max).');
    }
    fs.mkdirSync(this.imageDir, { recursive: true });
    const name = `${crypto.randomUUID()}${ext === '.jpeg' ? '.jpg' : ext}`;
    fs.writeFileSync(path.join(this.imageDir, name), data);
    this.pending.set(name, Date.now());
    return name;
  }

  // Removes images no lineup uses. Images added in the last hour may belong to an editor that is still
  // open, so they stay until a later save.
  prune(items = this.list()) {
    const used = new Set(items.flatMap(x => x.images || []));
    let files = [];
    try { files = fs.readdirSync(this.imageDir); } catch { return; }
    for (const f of files) {
      if (used.has(f)) { this.pending.delete(f); continue; }
      if (Date.now() - (this.pending.get(f) || 0) < 3600e3) continue;
      try { fs.unlinkSync(path.join(this.imageDir, f)); } catch {}
      this.pending.delete(f);
    }
  }
}

// Newest CS2 screenshots taken with Steam's screenshot key (F12 by default), for attaching to a lineup.
function steamScreenshots(steamPath, steamid64, limit = 24) {
  if (!steamPath || !steamid64) return [];
  let account;
  try { account = (BigInt(steamid64) - 76561197960265728n).toString(); } catch { return []; }
  const dir = path.join(steamPath, 'userdata', account, '760', 'remote', '730', 'screenshots');
  let files;
  try { files = fs.readdirSync(dir).filter(f => IMAGE_EXT.has(path.extname(f).toLowerCase())); } catch { return []; }
  return files.map(f => {
    const file = path.join(dir, f);
    const thumb = path.join(dir, 'thumbnails', f);
    return { file, thumb: fs.existsSync(thumb) ? thumb : file, time: fs.statSync(file).mtimeMs };
  }).sort((a, b) => b.time - a.time).slice(0, limit);
}

module.exports = { UtilityStore, steamScreenshots };
