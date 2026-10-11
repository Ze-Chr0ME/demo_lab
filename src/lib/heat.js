// Heatmap points for one player, from the cached demo data. Each point is a compact tuple
// [kind, side, weapon, x, y, z] in world coordinates; the renderer maps them onto the radar image.
//  kill   where the player stood when they got a kill     death  where they died
//  shot   where they fired from                            dealt  where they stood when they hit an enemy
//  taken  where they stood when an enemy hit them          smoke / flash / he / molotov  where their grenade landed
const { weaponName } = require('./highlights');

const KINDS = ['kill', 'death', 'shot', 'dealt', 'taken', 'smoke', 'flash', 'he', 'molotov'];
const K = Object.fromEntries(KINDS.map((k, i) => [k, i]));
const SIDE = { T: 0, CT: 1 };

function heatPoints(core, events, steamid) {
  const out = [];
  const push = (kind, side, weapon, p) => { if (p && SIDE[side] !== undefined) out.push([K[kind], SIDE[side], weapon ? weaponName(weapon) : '', p[0], p[1], p[2]]); };
  const enemy = (a, b) => a && b && a !== b;

  for (const k of core.kills) {
    if (k.attacker === steamid && k.victim !== steamid && enemy(k.attackerTeam, k.victimTeam)) push('kill', k.attackerTeam, k.weapon, k.attackerPos);
    if (k.victim === steamid) push('death', k.victimTeam, k.weapon, k.victimPos);
  }
  for (const d of events.damage) {
    if (!enemy(d.attackerTeam, d.victimTeam) || d.attacker === d.victim) continue;
    if (d.attacker === steamid) push('dealt', d.attackerTeam, d.weapon, d.attackerPos);
    if (d.victim === steamid) push('taken', d.victimTeam, d.weapon, d.victimPos);
  }
  const sideIn = new Map(core.rounds.map(r => [r.num, r.roster[steamid]?.team]));
  for (const [, round, id, x, y, z, w] of events.shots) if (id === steamid) push('shot', sideIn.get(round), w, [x, y, z]);
  for (const g of events.grenades) if (g.thrower === steamid && !g.expire && K[g.type] !== undefined) push(g.type, g.team, null, g.pos);
  return out;
}

module.exports = { heatPoints, KINDS };
