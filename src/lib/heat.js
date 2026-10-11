// Heatmap points for one player (or everyone), from the cached demo data. Each point is a compact tuple
// [kind, side, weapon, x, y, z, fromX, fromY] in world coordinates; the renderer maps them onto the radar image.
//  kill   where the player stood when they got a kill     death  where they died
//  shot   where they fired from                            dealt  where they stood when they hit an enemy
//  taken  where they stood when an enemy hit them          smoke / flash / he / molotov  where their grenade landed
// Grenades also carry where they were thrown from (fromX, fromY) when the throw could be matched.
const { weaponName } = require('./highlights');

const KINDS = ['kill', 'death', 'shot', 'dealt', 'taken', 'smoke', 'flash', 'he', 'molotov'];
const K = Object.fromEntries(KINDS.map((k, i) => [k, i]));
const SIDE = { T: 0, CT: 1 };
const THROWN = { smokegrenade: 'smoke', flashbang: 'flash', hegrenade: 'he', molotov: 'molotov', incgrenade: 'molotov', decoy: 'decoy' };
const MAX_FLIGHT = 20 * 64; // ticks between a throw and its detonation

// steamid null = every player. Shots are left out then: there are far too many to be useful.
function heatPoints(core, events, steamid) {
  const out = [];
  const is = id => !steamid || id === steamid;
  const push = (kind, side, weapon, p, from) => {
    if (!p || SIDE[side] === undefined) return;
    const row = [K[kind], SIDE[side], weapon ? weaponName(weapon) : '', p[0], p[1], p[2]];
    if (from) row.push(from[0], from[1]);
    out.push(row);
  };
  const enemy = (a, b) => a && b && a !== b;

  for (const k of core.kills) {
    if (k.attacker && is(k.attacker) && k.victim !== k.attacker && enemy(k.attackerTeam, k.victimTeam)) push('kill', k.attackerTeam, k.weapon, k.attackerPos);
    if (is(k.victim)) push('death', k.victimTeam, k.weapon, k.victimPos);
  }
  for (const d of events.damage) {
    if (!enemy(d.attackerTeam, d.victimTeam) || d.attacker === d.victim) continue;
    if (d.attacker && is(d.attacker)) push('dealt', d.attackerTeam, d.weapon, d.attackerPos);
    if (is(d.victim)) push('taken', d.victimTeam, d.weapon, d.victimPos);
  }
  if (steamid) {
    const sideIn = new Map(core.rounds.map(r => [r.num, r.roster[steamid]?.team]));
    for (const [, round, id, x, y, z, w] of events.shots) if (id === steamid) push('shot', sideIn.get(round), w, [x, y, z]);
  }

  // Each detonation is matched to the same player's latest unused throw of that grenade type.
  const throws = new Map();
  for (const [tick, , id, x, y, , w] of events.throws || []) {
    if (!is(id) || !THROWN[w]) continue;
    if (!throws.has(id)) throws.set(id, []);
    throws.get(id).push({ tick, type: THROWN[w], from: [x, y], used: false });
  }
  for (const g of events.grenades) {
    if (g.expire || K[g.type] === undefined || !g.thrower || !is(g.thrower)) continue;
    let from = null;
    const list = throws.get(g.thrower) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      if (t.used || t.type !== g.type || t.tick > g.tick) continue;
      if (g.tick - t.tick <= MAX_FLIGHT) { t.used = true; from = t.from; }
      break;
    }
    push(g.type, g.team, null, g.pos, from);
  }
  return out;
}

module.exports = { heatPoints, KINDS };
