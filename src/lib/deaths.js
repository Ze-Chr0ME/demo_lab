// Death review: every death of one player in a match, tagged with what went wrong (or what was just the
// enemy playing well), from the stored demo facts (demo.js), the per-kill positions and grenades of
// rounds.js and, once a match is measured, the aim facts (aim.js: who saw whom first).
//
// Tags (a death can have several; MISTAKES are the ones worth working on):
//  alone      not traded, and no living teammate within ALONE_DIST: nobody could have traded
//  untraded   not traded although a teammate was close enough
//  nades      died with grenades still in hand
//  dry        T side opening duel lost without any team grenade landing nearby just before
//  flashed    blind when killed (teamflash: by a teammate's flash)
//  lowhp      took the fight already hurt (under LOW_HP)
//  caught     the killer came into view with the crosshair far from them (CAUGHT_DEG), hit first and killed — measured matches
//  outaimed   same, but the crosshair was close: they were just faster — measured matches
//  late       died after the round was already over (a saved gun lost)
//  crossfire  hurt by two or more enemies in the last seconds
//  unseen     the killer never came into view (from behind, through smoke or a wall) — measured matches
//  hitfirst   hit the killer first and still lost the duel
//  opening    the first death of the round
const { enemyKill } = require('./stats');
const { weaponName } = require('./highlights');

const DEATHS_VERSION = 1;
const TRADE_SECONDS = 5;   // same as the scoreboard's trades
const ALONE_DIST = 1100;   // units: about the farthest a teammate can still trade from
const SUPPORT_DIST = 900;  // a team grenade this close to the duel counts as support
const LOW_HP = 40;
const CAUGHT_DEG = 15;    // crosshair this far from the killer's head when they appeared: about the worst 1 in 4 engagements
const MISTAKES = ['alone', 'untraded', 'nades', 'dry', 'flashed', 'teamflash', 'lowhp', 'caught', 'late'];
const INFO = ['outaimed', 'crossfire', 'unseen', 'hitfirst', 'opening'];

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0));
const near = (p, q, d) => !!p && !!q && Math.hypot(p[0] - q[0], p[1] - q[1]) <= d;
const nadeName = n => ({ 'Smoke Grenade': 'smoke', Flashbang: 'flash', 'High Explosive Grenade': 'HE', Molotov: 'molotov', 'Incendiary Grenade': 'incendiary', 'Decoy Grenade': 'decoy' })[n] || n;

// facts: <id>.rounds.json (needs killState, ROUNDS_VERSION 2); aim: <id>.aim.json or null.
function reviewDeaths(core, events, facts, aim, steamid) {
  if (!steamid || !core.players.some(p => p.steamid === steamid)) return null;
  const tr = core.tickrate || 64;
  const names = Object.fromEntries(core.players.map(p => [p.steamid, p.name]));
  const roundOf = new Map(core.rounds.map(r => [r.num, r]));
  const byRound = new Map();
  for (const k of core.kills) (byRound.get(k.round) || byRound.set(k.round, []).get(k.round)).push(k);
  for (const list of byRound.values()) list.sort((a, b) => a.tick - b.tick);
  const dmgByRound = new Map();
  for (const d of events.damage) (dmgByRound.get(d.round) || dmgByRound.set(d.round, []).get(d.round)).push(d);
  const eng = aim?.players?.[steamid]?.eng || null;

  const out = [];
  core.kills.forEach((k, i) => {
    if (k.victim !== steamid || !k.round) return;
    const r = roundOf.get(k.round);
    if (!r) return;
    const kills = byRound.get(k.round);
    const state = facts?.killState?.[i] || null;
    const side = k.victimTeam;
    const tags = [];
    const killer = enemyKill(k) ? k.attacker : null;
    const pos = state?.pos[steamid] || k.victimPos;
    const killerPos = (killer && state?.pos[killer]) || k.attackerPos;

    // ---- trades and who was around
    const mates = Object.entries(state?.pos || {}).filter(([id]) => id !== steamid && r.roster[id]?.team === side);
    const nearest = pos && mates.length ? Math.min(...mates.map(([, p]) => dist(p, pos))) : null;
    const trade = killer ? kills.find(t => t.tick > k.tick && t.tick - k.tick <= TRADE_SECONDS * tr && enemyKill(t) && t.victim === killer && t.attackerTeam === side) : null;
    const late = k.tick > r.endTick;
    if (late) tags.push('late');
    else if (killer && !trade && mates.length) tags.push(nearest != null && nearest > ALONE_DIST ? 'alone' : 'untraded');

    // ---- grenades left
    const nades = (state?.nades || []).filter(n => !/Decoy/.test(n));
    if (nades.length && !late) tags.push('nades');

    // ---- opening duel without support (T side: the side that has to walk into the fight)
    const firstDeath = kills.find(x => enemyKill(x) && x.tick <= r.endTick);
    const opening = !!firstDeath && firstDeath.tick === k.tick && firstDeath.victim === steamid;
    if (opening) {
      tags.push('opening');
      if (side === 'T') {
        const supported = events.grenades.some(g => !g.expire && g.round === k.round && g.team === side && g.type !== 'decoy'
          && g.tick <= k.tick && k.tick - g.tick <= (g.type === 'smoke' ? 18 : 3) * tr
          && (near(g.pos, pos, SUPPORT_DIST) || near(g.pos, killerPos, SUPPORT_DIST)));
        if (!supported) tags.push('dry');
      }
    }

    // ---- blind
    const blind = events.blinds.filter(b => b.victim === steamid && b.duration >= 0.7 && b.tick <= k.tick && k.tick <= b.tick + b.duration * tr)
      .sort((a, b) => b.duration - a.duration)[0];
    let flashedBy = null;
    if (blind) {
      const team = blind.attacker && blind.attackerTeam === side && blind.attacker !== steamid;
      tags.push(team ? 'teamflash' : 'flashed');
      flashedBy = blind.attacker ? names[blind.attacker] || null : null;
    }

    // ---- health and who hurt whom in the last seconds
    const dmg = (dmgByRound.get(k.round) || []).filter(d => d.tick <= k.tick);
    let hp = 100;
    for (const d of dmg) if (d.victim === steamid && d.tick < k.tick - 3 * tr) hp -= d.dmg;
    hp = Math.max(1, hp);
    if (hp < LOW_HP && !late) tags.push('lowhp');
    const recent = dmg.filter(d => k.tick - d.tick <= 4 * tr);
    const hurtBy = new Set(recent.filter(d => d.victim === steamid && d.attacker && d.attackerTeam && d.attackerTeam !== side).map(d => d.attacker));
    if (hurtBy.size >= 2) tags.push('crossfire');
    const mineOnKiller = killer ? recent.filter(d => d.attacker === steamid && d.victim === killer) : [];
    const theirsOnMe = killer ? recent.filter(d => d.attacker === killer && d.victim === steamid) : [];
    const dmgFirst = mineOnKiller.reduce((s, d) => s + d.dmg, 0);
    if (mineOnKiller.length && (!theirsOnMe.length || mineOnKiller[0].tick < theirsOnMe[0].tick)) tags.push('hitfirst');

    // ---- measured matches: did the victim see the killer, and where was the crosshair?
    let xhair = null;
    if (eng && killer && !late) {
      const seen = eng.filter(e => e[1] === killer && e[0] <= k.tick && k.tick - e[0] <= 15 * tr);
      const lost = seen.filter(e => k.tick - e[0] <= 5 * tr && e[5] === 2 && e[6] === 2).at(-1);
      if (lost) { xhair = Math.round(lost[2] * 10) / 10; tags.push(xhair >= CAUGHT_DEG ? 'caught' : 'outaimed'); }
      else if (!seen.length && !blind && !k.wallbang && !k.smoke) tags.push('unseen');
    }

    const place = facts?.killPlaces?.[i] && facts.killPlaces[i][1] >= 0 ? facts.places[facts.killPlaces[i][1]] : null;
    out.push({
      round: k.round, tick: k.tick, clock: Math.max(0, Math.round((k.tick - r.freezeEndTick) / tr)), side,
      killer, killerName: killer ? names[killer] || k.attackerName : k.attacker === steamid ? 'yourself' : k.attackerName || 'the world',
      weapon: weaponName(k.weapon), headshot: k.headshot, wallbang: k.wallbang, smoke: k.smoke, place,
      tags, hp, nearest: nearest == null ? null : Math.round(nearest), matesAlive: mates.length,
      nades: nades.map(nadeName), flashedBy, xhair, dmgFirst,
      traded: trade ? { by: names[trade.attacker] || trade.attackerName, after: Math.round((trade.tick - k.tick) / tr * 10) / 10 } : null,
      won: r.winner === side,
    });
  });
  return { rounds: core.rounds.length, deaths: out, measured: !!eng };
}

module.exports = { reviewDeaths, DEATHS_VERSION, MISTAKES, INFO };
