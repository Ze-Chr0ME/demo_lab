// Everything the 2D replay draws that the stats don't need, built in a worker the first time a
// match's replay is opened, then read from disk:
//  - player positions over the whole match, sampled every STEP ticks (8 per second at 64 tick) and
//    packed into a compact binary block (about 10 bytes per player per sample, ~1.5 MB per match)
//  - in header.extra: grenade flight paths with how each one was thrown, shots with their aim, bomb
//    plant/defuse/carrier events and the round and bomb timers
//
// File: [uint32 header length][header JSON][samples]. Each sample holds, for every player in
// header.players order, one REC-byte record:
//   int16 x, int16 y, int16 z, uint8 yaw (0-255 = 0-360°), uint8 health, uint8 weapon (index into
//   header.weapons, 255 = none), uint8 flags (1 = present, 2 = alive, 4 = CT)
const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const parser = require('./parser');

const TRACK_VERSION = 2;
const STEP = 8;
const REC = 10;

const PROJECTILES = { CSmokeGrenadeProjectile: 'smoke', CFlashbangProjectile: 'flash', CHEGrenadeProjectile: 'he', CMolotovProjectile: 'molotov', CIncendiaryGrenadeProjectile: 'molotov', CDecoyProjectile: 'decoy' };
const THROWN = { smokegrenade: 'smoke', flashbang: 'flash', hegrenade: 'he', molotov: 'molotov', incgrenade: 'molotov', decoy: 'decoy' };
const NOT_SHOTS = /grenade|flashbang|molotov|decoy|knife|bayonet|c4|taser/;
const PATH_STEP = 2; // grenade path points every 2 ticks (plus every bounce's last point)

const r1 = v => Math.round(v * 10) / 10;
const ri = v => Math.round(v);

// lowEnd: one parser at a time (the "Low-end PC" setting), slower but with a lower memory peak.
function extractTrack(file, core, { lowEnd = false } = {}) {
  const first = core.rounds[0]?.startTick ?? 0;
  const lastRound = core.rounds.at(-1);
  const last = lastRound ? (lastRound.nextStartTick ?? lastRound.endTick + 5 * core.tickrate) : first;
  // Reading the grenades takes most of the time: a helper thread does it while this one reads the rest.
  const flights = lowEnd ? null : startFlights(file, first, last);
  try {
    return readTrack(file, core, first, last, flights);
  } finally {
    flights?.close();
  }
}

function readTrack(file, core, first, last, flights) {
  const ticks = [];
  for (let t = first; t <= last; t += STEP) ticks.push(t);

  const players = core.players.map(p => p.steamid);
  const index = new Map(players.map((id, i) => [id, i]));
  const weapons = [];
  const weaponIndex = new Map();
  const buf = Buffer.alloc(ticks.length * players.length * REC);

  const rows = parser.parseTicks(file, ['X', 'Y', 'Z', 'yaw', 'health', 'is_alive', 'team_num', 'active_weapon_name'], ticks);
  for (const r of rows) {
    const p = index.get(r.steamid);
    if (p === undefined || r.X == null) continue;
    const s = Math.round((r.tick - first) / STEP);
    if (s < 0 || s >= ticks.length) continue;
    let w = 255;
    if (r.active_weapon_name) {
      if (!weaponIndex.has(r.active_weapon_name) && weapons.length < 255) { weaponIndex.set(r.active_weapon_name, weapons.length); weapons.push(r.active_weapon_name); }
      w = weaponIndex.get(r.active_weapon_name) ?? 255;
    }
    const o = (s * players.length + p) * REC;
    const clamp = v => Math.max(-32768, Math.min(32767, Math.round(v)));
    buf.writeInt16LE(clamp(r.X), o);
    buf.writeInt16LE(clamp(r.Y), o + 2);
    buf.writeInt16LE(clamp(r.Z), o + 4);
    buf[o + 6] = Math.round((((r.yaw || 0) % 360) + 360) % 360 / 360 * 256) & 255;
    buf[o + 7] = Math.max(0, Math.min(255, r.health || 0));
    buf[o + 8] = w;
    buf[o + 9] = 1 | (r.is_alive ? 2 : 0) | (r.team_num === 3 ? 4 : 0);
  }
  const extra = extractExtra(file, core, first, last, index, flights);
  return { header: { version: TRACK_VERSION, step: STEP, rec: REC, firstTick: first, samples: ticks.length, players, weapons, extra }, data: buf };
}

function extractExtra(file, core, first, last, index, flights) {
  const events = parser.parseEvents(file,
    ['weapon_fire', 'player_jump', 'bomb_beginplant', 'bomb_begindefuse', 'bomb_pickup', 'bomb_dropped', 'server_cvar'],
    ['X', 'Y', 'Z', 'pitch', 'yaw'], []);
  const inMatch = e => e.tick >= first && e.tick <= last;

  // Server settings for the round clock and the bomb timer (CS2 doesn't announce mp_c4timer when it is the default 40).
  const cvar = {};
  for (const e of events) if (e.event_name === 'server_cvar') cvar[e.name] = parseFloat(e.value);
  const timers = {
    roundTime: Math.round(60 * (cvar.mp_roundtime_defuse || cvar.mp_roundtime || 1.92)),
    c4: cvar.mp_c4timer || 40,
  };

  // Shots: [tick, player index, x, y, z, yaw]
  const shots = [];
  const throws = [];
  for (const e of events) {
    if (e.event_name !== 'weapon_fire' || !inMatch(e) || e.user_X == null) continue;
    const p = index.get(e.user_steamid);
    if (p === undefined) continue;
    const w = (e.weapon || '').replace(/^weapon_/, '');
    if (THROWN[w]) throws.push({ tick: e.tick, steamid: e.user_steamid, type: THROWN[w], weapon: w, x: e.user_X, y: e.user_Y, z: e.user_Z, pitch: e.user_pitch, yaw: e.user_yaw, used: false });
    else if (!NOT_SHOTS.test(w)) shots.push([e.tick, p, ri(e.user_X), ri(e.user_Y), ri(e.user_Z), r1(e.user_yaw || 0)]);
  }

  const jumps = new Map();
  for (const e of events) if (e.event_name === 'player_jump' && inMatch(e)) {
    if (!jumps.has(e.user_steamid)) jumps.set(e.user_steamid, []);
    jumps.get(e.user_steamid).push({ tick: e.tick, pos: [r1(e.user_X), r1(e.user_Y), r1(e.user_Z)] });
  }

  const bomb = events.filter(e => /^bomb_/.test(e.event_name) && inMatch(e)).map(e => ({
    tick: e.tick, type: e.event_name.slice(5), player: e.user_steamid || null,
    pos: e.user_X == null ? null : [ri(e.user_X), ri(e.user_Y), ri(e.user_Z ?? 0)],
    ...(e.event_name === 'bomb_begindefuse' ? { kit: !!e.haskit } : {}),
  }));

  const moves = movementAround(file, throws);
  return { timers, shots, nades: grenadePaths(file, first, last, throws, jumps, flights, moves), bomb };
}

// Every thrown grenade's flight from the parser's per-tick projectile positions, matched to the
// throw (weapon_fire) it came from, with how the player threw it (moves: from movementAround).
function grenadePaths(file, first, last, throws, jumps, flights, moves) {
  const nades = [];
  for (const f of flights?.join() || flightsOf(parser.parseGrenades(file), first, last)) {
    let from = null;
    for (let i = throws.length - 1; i >= 0; i--) {
      const t = throws[i];
      if (t.used || t.steamid !== f.steamid || t.type !== f.type || t.tick > f.t0) continue;
      if (f.t0 - t.tick <= 96) { t.used = true; from = t; }
      break;
    }
    nades.push({ type: f.type, thrower: f.steamid || null, entity: f.entity, t0: f.t0, t1: f.t1, path: f.path, throw: from && throwInfo(from, jumps) });
  }
  addMovement(nades, moves);
  return nades;
}

// The flights in the parser's grenade rows, in the order they were thrown: { type, steamid, entity, t0, t1, path }.
function flightsOf(grenades, first, last) {
  const rows = grenades.filter(r => PROJECTILES[r.grenade_type] && r.x != null && r.tick >= first && r.tick <= last);
  rows.sort((a, b) => a.grenade_entity_id - b.grenade_entity_id || a.tick - b.tick);

  // Entity ids get reused: a gap in the ticks starts a new projectile.
  const flights = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || cur.entity !== r.grenade_entity_id || r.tick - cur.rows.at(-1).tick > 4) {
      cur = { entity: r.grenade_entity_id, type: PROJECTILES[r.grenade_type], steamid: r.steamid, rows: [] };
      flights.push(cur);
    }
    cur.rows.push(r);
  }

  const out = [];
  for (const f of flights.sort((a, b) => a.rows[0].tick - b.rows[0].tick)) {
    // Smokes and decoys keep their entity after landing: cut the path where it stopped moving.
    let end = f.rows.length - 1;
    while (end > 0) {
      const a = f.rows[end], b = f.rows[end - 1];
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) > 0.5) break;
      end--;
    }
    const pts = f.rows.slice(0, end + 1);
    if (pts.length < 2) continue;
    const t0 = pts[0].tick;
    const path = [];
    pts.forEach((r, i) => {
      // Keep every PATH_STEP-th point, the last one and any point where the direction changes sharply (bounces).
      const prev = pts[i - 1], next = pts[i + 1];
      const bounce = prev && next && ((r.x - prev.x) * (next.x - r.x) + (r.y - prev.y) * (next.y - r.y) + (r.z - prev.z) * (next.z - r.z)) < 0;
      if (i % PATH_STEP === 0 || i === pts.length - 1 || bounce) path.push(r.tick - t0, ri(r.x), ri(r.y), ri(r.z));
    });
    out.push({ type: f.type, steamid: f.steamid, entity: f.entity, t0, t1: pts.at(-1).tick, path });
  }
  return out;
}

// A thread that reads the grenades and works out their flights (parseWorker.js, mode 'flights').
// join() blocks until it is done and returns the flights, or null if it failed (the caller then reads
// them itself).
function startFlights(file, first, last) {
  const flag = new Int32Array(new SharedArrayBuffer(4)); // 0 working, 1 done, 2 failed
  const { port1, port2 } = new MessageChannel();
  let w;
  try {
    w = new Worker(path.join(__dirname, 'parseWorker.js'), { workerData: { mode: 'flights', file, first, last, port: port2, flag: flag.buffer }, transferList: [port2] });
    w.unref();
    w.on('error', () => {});
  } catch { return null; }
  return {
    join() {
      // The event loop is blocked meanwhile: the result comes through the port, read without it.
      while (Atomics.load(flag, 0) === 0) if (Atomics.wait(flag, 0, 0, 10 * 60000) === 'timed-out') break;
      return Atomics.load(flag, 0) === 1 ? receiveMessageOnPort(port1)?.message || null : null;
    },
    close() { w.terminate(); port1.close(); },
  };
}

// parseWorker.js, mode 'flights': the helper's side.
function flightsHelper({ file, first, last, port, flag }) {
  const f = new Int32Array(flag);
  try {
    port.postMessage(flightsOf(parser.parseGrenades(file), first, last));
    Atomics.store(f, 0, 1);
  } catch {
    Atomics.store(f, 0, 2);
  }
  Atomics.notify(f, 0);
}

function throwInfo(t, jumps) {
  const jump = (jumps.get(t.steamid) || []).filter(j => j.tick <= t.tick && t.tick - j.tick <= 64).at(-1);
  return {
    tick: t.tick, weapon: t.weapon,
    pos: [r1(t.x), r1(t.y), r1(t.z)], pitch: r1(t.pitch || 0), yaw: r1(t.yaw || 0),
    jumpAgo: jump ? t.tick - jump.tick : null, jumpPos: jump ? jump.pos : null,
  };
}

// Buttons and movement around each throw: which mouse buttons were held (throw strength), which
// movement keys, crouching, in the air, and the speed.
// The ticks around every throw are read before the grenades are matched to their throws (while the
// helper still reads the grenades), so a few unmatched throws get read for nothing.
function movementAround(file, throws) {
  const byKey = new Map();
  if (!throws.length) return byKey;
  const want = new Set();
  for (const t of throws) for (let d = -4; d <= 0; d++) want.add(t.tick + d);
  const props = ['X', 'Y', 'FIRE', 'RIGHTCLICK', 'FORWARD', 'BACK', 'LEFT', 'RIGHT', 'JUMP', 'is_walking', 'ducking', 'is_airborne'];
  for (const r of parser.parseTicks(file, props, [...want].sort((a, b) => a - b))) byKey.set(`${r.tick}|${r.steamid}`, r);
  return byKey;
}

function addMovement(nades, byKey) {
  const thrown = nades.filter(n => n.throw);
  for (const n of thrown) {
    const t = n.throw.tick;
    const at = d => byKey.get(`${t + d}|${n.thrower}`);
    const now = at(0), before = at(-4);
    if (!now) continue;
    const held = k => [-2, -1, 0].some(d => at(d)?.[k]);
    const keys = ['FORWARD', 'BACK', 'LEFT', 'RIGHT'].filter(held);
    const speed = before && before.X != null ? Math.round(Math.hypot(now.X - before.X, now.Y - before.Y) / (4 / 64)) : null;
    Object.assign(n.throw, {
      left: held('FIRE'), right: held('RIGHTCLICK'), keys, jumpKey: held('JUMP'),
      walk: !!now.is_walking, duck: !!now.ducking, air: !!now.is_airborne, speed,
    });
  }
}

function packTrack({ header, data }) {
  const h = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(h.length);
  return Buffer.concat([len, h, data]);
}

function unpackTrack(buf) {
  const n = buf.readUInt32LE(0);
  const header = JSON.parse(buf.subarray(4, 4 + n).toString());
  if (header.version !== TRACK_VERSION) return null;
  return { header, data: buf.subarray(4 + n) };
}

module.exports = { extractTrack, packTrack, unpackTrack, flightsHelper };
