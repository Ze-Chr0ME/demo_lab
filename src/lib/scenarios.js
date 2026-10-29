// Training scenarios the player builds on the 2D map (renderer/scenarios.js): where they start, bots
// holding angles (spot + the point they look at, shooting or not, crouched or not) and smokes, played
// in CS2 by lib/training.js. Stored in <userData>/training/scenarios.json.
//
// The radar is flat: the height of a spot comes from the map's collision mesh (lib/geometry.js), the
// floors under a point being every surface a ray straight down hits with room to stand above it. When
// a point has several (stairs, a balcony over a corridor), the floor closest to where players stand
// in the user's demos around it wins, else the one the editor asks for.
const fs = require('fs');
const path = require('path');

const MAX_BOTS = 10, MAX_SMOKES = 8;
const STAND = 72;   // room a player needs above a floor
const NEAR = 220;   // demo positions this close (x/y) say which floor a spot is on

// Every surface under (x, y) with room to stand on it, top to bottom (z values).
function floorsAt(geo, x, y) {
  const top = geo.box[5] + 16, bottom = geo.box[2] - 16;
  const out = [];
  let z = top;
  for (let n = 0; n < 16 && z > bottom; n++) {
    if (!geo.blocked(x, y, z, x, y, bottom)) break;
    // the first surface below z: halve the segment until it's under half a unit
    let a = z, b = bottom;
    while (a - b > 0.5) { const m = (a + b) / 2; if (geo.blocked(x, y, z, x, y, m)) b = m; else a = m; }
    if (!geo.blocked(x, y, b + 2, x, y, b + STAND)) out.push(Math.round(b));
    z = b - 1;
  }
  return out;
}

// The floor to use at (x, y). near: a height to stay close to (the bot's own floor for the point it
// looks at); points: [x, y, z] of players in the user's demos on this map; lowerBelow/lower: the
// radar's two floors (Nuke, Vertigo) and which one the editor shows.
function pickFloor(geo, x, y, { near = null, points = [], lowerBelow, lower = false } = {}) {
  let floors = geo ? floorsAt(geo, x, y) : [];
  if (lowerBelow !== undefined) {
    const level = floors.filter(z => (z < lowerBelow) === lower);
    if (level.length) floors = level;
  }
  let want = near;
  if (want == null) {
    const zs = points.filter(p => Math.abs(p[0] - x) < NEAR && Math.abs(p[1] - y) < NEAR && (lowerBelow === undefined || (p[2] < lowerBelow) === lower)).map(p => p[2]).sort((a, b) => a - b);
    if (zs.length) want = zs[zs.length >> 1];
  }
  if (!floors.length) return { z: want, floors };
  const z = want == null ? Math.min(...floors) : floors.reduce((best, f) => (Math.abs(f - want) < Math.abs(best - want) ? f : best));
  return { z, floors };
}

const HEAR = 1200; // a bot's hearing range by default, in world units
const num = v => Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0;
const vec = v => Array.isArray(v) && v.length === 3 && v.every(x => x !== null && x !== '' && Number.isFinite(Number(x)));

// A scenario as saved: only known fields, sane numbers.
function clean(s) {
  if (!s || typeof s.map !== 'string' || s.map.length > 64 || !/^[a-z0-9_]+$/i.test(s.map)) throw new Error('A scenario needs a map.');
  if (!vec(s.me?.pos)) throw new Error('Place your start spot on the map.');
  const bots = (Array.isArray(s.bots) ? s.bots : []).filter(b => b && vec(b.pos) && vec(b.look)).slice(0, MAX_BOTS)
    .map(b => ({ pos: b.pos.map(num), look: b.look.map(num), shoot: b.shoot !== false, crouch: !!b.crouch,
      weapon: /^[a-z0-9_]{2,24}$/.test(b.weapon || '') ? b.weapon : null, jiggle: jiggleWidth(b.jiggle),
      jigglePause: Math.max(0, Math.min(2, Math.round((Number.isFinite(Number(b.jigglePause ?? 0.25)) ? Number(b.jigglePause ?? 0.25) : 0) * 20) / 20)), jiggleWalk: !!b.jiggleWalk,
      level: [0, 1, 2, 3].includes(b.level) ? b.level : null,
      hear: Number(b.hear) >= 300 ? Math.min(3000, Math.round(Number(b.hear))) : HEAR })); // hearing range (every bot hears)
  if (!bots.length) throw new Error('Place at least one bot.');
  const o = s.options || {};
  return {
    id: /^[a-z0-9]+$/.test(s.id || '') ? s.id : Date.now().toString(36),
    name: String(s.name || '').trim().slice(0, 60) || 'Untitled scenario',
    map: s.map,
    me: { pos: s.me.pos.map(num), yaw: num(s.me.yaw || 0) },
    bots,
    smokes: [], // smokes were dropped (throwing them for real meant teleporting around before every rep)
    options: { reps: Math.max(1, Math.min(50, Math.round(num(o.reps) || 10))), seconds: Math.max(8, Math.min(120, Math.round(num(o.seconds) || 25))),
      firstTo: Math.max(0, Math.min(16, Math.round(num(o.firstTo)))) }, // 0: every rep is played
    created: s.created || Date.now(),
    updated: Date.now(),
  };
}

class Scenarios {
  constructor(dir) { this.file = path.join(dir, 'scenarios.json'); }
  list() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; } }
  get(id) { return this.list().find(s => s.id === id) || null; }
  write(list) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(list)); }
  save(s) {
    const sc = clean(s);
    const list = this.list();
    const i = list.findIndex(x => x.id === sc.id);
    if (i >= 0) list[i] = { ...sc, created: list[i].created }; else list.push(sc);
    this.write(list);
    return sc;
  }
  remove(id) { this.write(this.list().filter(s => s.id !== id)); }
}

// How far a bot jiggles, in world units (0: it stands still). Older scenarios saved 1 / 2 (48 / 96).
const jiggleWidth = j => (j === 1 ? 48 : j === 2 ? 96 : Number.isFinite(+j) && +j >= 16 ? Math.min(200, Math.round(+j)) : 0);
// The two points a jiggling bot steps between: across the angle it holds (perpendicular to where it
// looks), half the width each side, pulled in when a wall is closer (mesh) so it never walks into one.
function jigglePoints(geo, b) {
  const w = jiggleWidth(b.jiggle);
  if (!w) return null;
  const dx = b.look[0] - b.pos[0], dy = b.look[1] - b.pos[1], l = Math.hypot(dx, dy) || 1;
  const px = -dy / l, py = dx / l;
  const side = sign => {
    let r = w / 2;
    const z = b.pos[2] + 40;
    if (geo) while (r > 8 && geo.blocked(b.pos[0], b.pos[1], z, b.pos[0] + sign * px * (r + 16), b.pos[1] + sign * py * (r + 16), z)) r -= 8;
    return [Math.round(b.pos[0] + sign * px * r), Math.round(b.pos[1] + sign * py * r), b.pos[2]];
  };
  return [side(1), side(-1)];
}

// The point a player standing with eyes at `eye` aims at (pitch/yaw in degrees, as setang): the first
// wall on the map mesh along that line (binary search on blocked()), else 1500 units out.
function aimPoint(geo, eye, pitch, yaw) {
  const p = pitch * Math.PI / 180, y = yaw * Math.PI / 180;
  const d = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
  const at = l => eye.map((v, k) => v + d[k] * l);
  const far = 4000;
  if (!geo || !geo.blocked(...eye, ...at(far))) return at(geo ? Math.min(far, 1500) : 1500);
  let lo = 0, hi = far;
  for (let k = 0; k < 16; k++) { const mid = (lo + hi) / 2; if (geo.blocked(...eye, ...at(mid))) hi = mid; else lo = mid; }
  return at(Math.max(32, lo - 4));
}

module.exports = { jigglePoints, aimPoint, Scenarios, floorsAt, pickFloor, clean, MAX_BOTS, MAX_SMOKES };

// Codes omit local ids, timestamps and session history.
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
function pack(items) {
  return items.slice(0, 100).map(input => {
    const { map, name, me, bots, options } = clean(input);
    return { map, name, me, bots, options };
  });
}
function shareCode(items) {
  return 'DLS1-' + zlib.deflateRawSync(Buffer.from(JSON.stringify(pack(items))), { level: 9 }).toString('base64url');
}
async function shortCode(items, { upload, cacheFile }) {
  const json = JSON.stringify(pack(items));
  const hash = crypto.createHash('sha1').update(json).digest('hex');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  if (/^[a-z0-9]{6}$/.test(cache[hash] || '')) return 'DLS2-' + cache[hash];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demolab-scenarios-'));
  try {
    const file = path.join(tmp, 'scenarios.json');
    fs.writeFileSync(file, json);
    const name = await upload(file);
    const id = /^([a-z0-9]{6})\.json$/.exec(name)?.[1];
    if (!id) throw new Error('Unexpected scenario upload name.');
    cache[hash] = id;
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(Object.entries(cache).slice(-300))));
    return 'DLS2-' + id;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
async function readCodes(text, { fetchShort } = {}) {
  const parts = String(text || '').replace(/\s+/g, '').split(/(DLS[12]-)/), out = [];
  for (let i = 1; i < parts.length && out.length < 100; i += 2) {
    const short = parts[i] === 'DLS2-';
    const body = (short ? /^[a-z0-9]{6}/ : /^[A-Za-z0-9_-]+/).exec(parts[i + 1])?.[0];
    if (!body) continue;
    let list;
    try {
      list = short ? await fetchShort(body) : JSON.parse(zlib.inflateRawSync(Buffer.from(body, 'base64url'), { maxOutputLength: 4 * 1048576 }).toString('utf8'));
    } catch (e) { throw new Error(`Could not read scenario code: ${e.message}`); }
    if (!Array.isArray(list)) throw new Error('This is not a scenario code.');
    for (const s of list.slice(0, 100 - out.length)) out.push(clean({ ...s, id: crypto.randomBytes(16).toString('hex'), created: Date.now() }));
  }
  if (!out.length) throw new Error('No scenarios found. Codes start with DLS2- or DLS1-.');
  return out;
}
module.exports.pack = pack;
module.exports.shareCode = shareCode;
module.exports.shortCode = shortCode;
module.exports.readCodes = readCodes;
