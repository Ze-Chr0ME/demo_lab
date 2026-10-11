// Player positions over a whole match for the 2D replay, sampled every STEP ticks (8 per second at
// 64 tick) and packed into a compact binary file (about 10 bytes per player per sample, ~1.5 MB
// per match). Built in a worker the first time a match's radar is opened, then read from disk.
//
// File: [uint32 header length][header JSON][samples]. Each sample holds, for every player in
// header.players order, one REC-byte record:
//   int16 x, int16 y, int16 z, uint8 yaw (0-255 = 0-360°), uint8 health, uint8 weapon (index into
//   header.weapons, 255 = none), uint8 flags (1 = present, 2 = alive, 4 = CT)
const parser = require('./parser');

const TRACK_VERSION = 1;
const STEP = 8;
const REC = 10;

function extractTrack(file, core) {
  const first = core.rounds[0]?.startTick ?? 0;
  const lastRound = core.rounds.at(-1);
  const last = lastRound ? (lastRound.nextStartTick ?? lastRound.endTick + 5 * core.tickrate) : first;
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
  return { header: { version: TRACK_VERSION, step: STEP, rec: REC, firstTick: first, samples: ticks.length, players, weapons }, data: buf };
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

module.exports = { extractTrack, packTrack, unpackTrack };
