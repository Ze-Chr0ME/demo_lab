// The Weapons tab: every bullet hit, kill and shot of the match as compact rows, so the renderer can
// filter (rounds, players, teams, sides, weapon type) and add up per weapon instantly. Built from the
// cached core + events (demo.js): nothing is parsed again.
//
//  hits:  [round, attacker, side, weapon, hitgroup, damage, distance (m), first]   enemy damage only;
//         first = 1 on the first hit of a bullet (shotgun pellets and collaterals hit more than once)
//  kills: [round, attacker, side, weapon, flags, distance (m)]   enemy kills only
//         flags: 1 headshot, 2 wallbang, 4 through smoke, 8 no-scope, 16 while blind, 32 in the air
//  shots: [round, steamid, side, weapon, count]   bullets fired
const { assignTeams } = require('./stats');

const METERS = 0.0254; // one Hammer unit is an inch
const dist = (a, b) => (a && b ? Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * METERS * 10) / 10 : null);
const enemy = (a, at, vt) => a && at && vt && at !== vt;

function buildWeapons(core, events) {
  const { team, sideOfA } = assignTeams(core.rounds);
  const sideOf = {};   // `${round}|${steamid}` -> side, for shots (weapon_fire rows carry no team)
  for (const r of core.rounds) for (const [id, p] of Object.entries(r.roster)) sideOf[`${r.num}|${id}`] = p.team;

  const hits = [], shotHit = new Set();
  for (const d of events.damage) {
    if (!enemy(d.attacker, d.attackerTeam, d.victimTeam) || d.attacker === d.victim || !d.weapon) continue;
    const shot = `${d.tick}|${d.attacker}`, first = shotHit.has(shot) ? 0 : 1;
    shotHit.add(shot);
    hits.push([d.round, d.attacker, d.attackerTeam, d.weapon, d.hitgroup || 'generic', d.dmg, dist(d.attackerPos, d.victimPos), first]);
  }
  const kills = [];
  for (const k of core.kills) {
    if (!enemy(k.attacker, k.attackerTeam, k.victimTeam) || k.attacker === k.victim || !k.weapon) continue;
    const flags = (k.headshot ? 1 : 0) | (k.wallbang ? 2 : 0) | (k.smoke ? 4 : 0) | (k.noscope ? 8 : 0) | (k.blind ? 16 : 0) | (k.inAir ? 32 : 0);
    kills.push([k.round, k.attacker, k.attackerTeam, k.weapon, flags, dist(k.attackerPos, k.victimPos)]);
  }
  const count = new Map();
  for (const [, round, id, , , , w] of events.shots) {
    const key = `${round}|${id}|${w}`;
    count.set(key, (count.get(key) || 0) + 1);
  }
  const shots = [...count].map(([key, n]) => { const [round, id, w] = key.split('|'); return [+round, id, sideOf[`${round}|${id}`] || null, w, n]; });

  // Halves: a new one starts whenever the sides switch (2nd half, then each overtime half).
  let half = 0;
  const rounds = core.rounds.map((r, i) => {
    if (i && sideOfA[r.num] !== sideOfA[core.rounds[i - 1].num]) half++;
    return { num: r.num, half };
  });
  const names = Object.fromEntries(core.players.map(p => [p.steamid, p.name]));
  const players = Object.keys(team).map(id => ({ steamid: id, name: names[id] || id, team: team[id] }));
  return { rounds, players, hits, kills, shots };
}

module.exports = { buildWeapons };
