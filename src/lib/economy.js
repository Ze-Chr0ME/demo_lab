// Round by round: how each team bought, how the round ended and who did what, from the stored demo
// facts (demo.js) and the per-round money and callouts (rounds.js). Used by the round strip under the
// match header, the Economy tab and the per-map positions.
const { assignTeams, enemyKill } = require('./stats');
const { weaponName } = require('./highlights');

// Buy types from the team's average loadout value when the round goes live (CS2 prices: an AK with
// vest and helmet is $3,700, a pistol-round loadout $200 to $1,000, a pistol with vest and helmet about $1,700).
const BUY_LABEL = { pistol: 'Pistol', eco: 'Eco', force: 'Force buy', full: 'Full buy' };
const ECO_MAX = 2000, FULL_MIN = 3500;
function buyType(avgEquip, avgMoney, firstOfHalf) {
  if (firstOfHalf && avgMoney <= 1000) return 'pistol';
  if (avgEquip < ECO_MAX) return 'eco';
  if (avgEquip < FULL_MIN) return 'force';
  return 'full';
}

const REASON = {
  t_killed: 'All Terrorists killed', ct_killed: 'All Counter-Terrorists killed',
  bomb_exploded: 'Bomb exploded', bomb_defused: 'Bomb defused', time_ran_out: 'Time ran out',
};

// Spelled-out callouts: "BombsiteA" -> "Bombsite A", "CTSpawn" -> "CT Spawn".
const placeLabel = p => (p || '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ') || 'Unknown';

const sum = a => a.reduce((s, x) => s + x, 0);

function buildRounds(core, events, facts, mySteamId) {
  const tr = core.tickrate || 64;
  const { team, sideOfA } = assignTeams(core.rounds);
  const names = Object.fromEntries(core.players.map(p => [p.steamid, p.name]));
  const myTeam = team[mySteamId] || 'A';
  const other = myTeam === 'A' ? 'B' : 'A';
  const byNum = new Map((facts?.rounds || []).map(r => [r.num, r]));
  const killsByRound = new Map();
  core.kills.forEach((k, i) => (killsByRound.get(k.round) || killsByRound.set(k.round, []).get(k.round)).push({ ...k, i }));
  const plants = new Map();
  for (const b of events?.bomb || []) if (b.type === 'planted' && !plants.has(b.round)) plants.set(b.round, b);

  const score = { A: 0, B: 0 };
  const flags = []; // personal buy mistakes, for every player
  const rounds = core.rounds.map((r, i) => {
    const sideA = sideOfA[r.num];
    const sideOf = t => (t === 'A' ? sideA : sideA === 'T' ? 'CT' : 'T');
    const firstOfHalf = i === 0 || sideOfA[core.rounds[i - 1].num] !== sideA;
    const winner = r.winner ? (r.winner === sideA ? 'A' : 'B') : null;
    if (winner) score[winner]++;
    const f = byNum.get(r.num);
    const kills = (killsByRound.get(r.num) || []).sort((a, b) => a.tick - b.tick);

    const teams = {};
    for (const t of ['A', 'B']) {
      const ids = Object.keys(r.roster).filter(id => team[id] === t);
      const eco = ids.map(id => f?.eco[id]).filter(Boolean);
      const equip = sum(eco.map(e => e[1])), money = sum(eco.map(e => e[0])), spent = sum(eco.map(e => e[2]));
      const n = eco.length || 1;
      const died = new Set(kills.filter(k => k.tick <= r.endTick).map(k => k.victim));
      teams[t] = {
        side: sideOf(t), players: ids.length,
        alive: ids.filter(id => r.roster[id].alive && !died.has(id)).length,
        equip, money, spent, type: f ? buyType(equip / n, money / n, firstOfHalf) : null,
      };
    }

    const mine = kills.filter(k => k.attacker === mySteamId && enemyKill(k));
    const opening = kills.find(enemyKill);
    const plant = plants.get(r.num);
    const kill = k => ({
      tick: k.tick, attacker: k.attacker, attackerName: names[k.attacker] || k.attackerName || 'World', victim: k.victim, victimName: names[k.victim] || k.victimName,
      weapon: weaponName(k.weapon), headshot: k.headshot, mine: team[k.attacker] === myTeam, enemy: enemyKill(k),
      place: facts?.killPlaces?.[k.i] ? placeLabel(facts.places[facts.killPlaces[k.i][1]]) : null,
    });

    // Personal buy mistakes, judged against what the rest of the team did.
    if (f && teams.A.type !== 'pistol' && teams.B.type !== 'pistol') {
      for (const id of Object.keys(r.roster)) {
        const e = f.eco[id];
        if (!e) continue;
        const [money, equip, spent, armor, kit, nades] = e;
        const t = team[id], tm = teams[t];
        const mates = Object.keys(r.roster).filter(o => o !== id && team[o] === t).map(o => f.eco[o]).filter(Boolean);
        if (!mates.length) continue;
        const matesEquip = sum(mates.map(m => m[1])) / mates.length;
        const add = (kind, text) => flags.push({ steamid: id, round: r.num, tick: r.freezeEndTick, side: tm.side, kind, text });
        if (equip >= FULL_MIN && spent >= 2000 && matesEquip < ECO_MAX) add('alone', `Bought ($${spent.toLocaleString('en-US')}) while the rest of the team saved`);
        else if (equip < ECO_MAX && money >= 4000 && matesEquip >= FULL_MIN) add('save', `Saved with $${money.toLocaleString('en-US')} while the rest of the team bought`);
        if (equip >= 2500 && !armor) add('armor', 'Bought a gun but no armor');
        if (tm.type === 'full' && equip >= FULL_MIN && !nades) add('nades', 'Full buy without a single grenade');
        if (tm.side === 'CT' && tm.type === 'full' && !kit && money - spent >= 400) add('kit', `No defuse kit with $${(money - spent).toLocaleString('en-US')} left`);
      }
    }

    return {
      num: r.num, startTick: r.startTick, freezeEndTick: r.freezeEndTick, endTick: r.endTick,
      half: firstOfHalf && i > 0, winner, winnerSide: r.winner || null, reason: r.reason, reasonText: REASON[r.reason] || r.reason || '',
      score: { ...score }, teams,
      time: Math.max(0, Math.round((r.endTick - r.freezeEndTick) / tr)),
      plant: plant ? { tick: plant.tick, player: names[plant.player] || null } : null,
      opening: opening ? kill(opening) : null,
      kills: kills.map(kill),
      me: r.roster[mySteamId] ? {
        kills: mine.length, hs: mine.filter(k => k.headshot).length,
        died: kills.some(k => k.victim === mySteamId && k.tick <= r.endTick),
        eco: f?.eco[mySteamId] ? { money: f.eco[mySteamId][0], equip: f.eco[mySteamId][1], spent: f.eco[mySteamId][2], items: f.eco[mySteamId][6] } : null,
      } : null,
    };
  });

  // Win rate per buy type, and how each of my buys fared against each of theirs: matrix[mine][theirs] = [won, played].
  const types = Object.keys(BUY_LABEL);
  const byType = t => Object.fromEntries(types.map(k => [k, [0, 0]]));
  const summary = { A: byType(), B: byType() };
  const matrix = Object.fromEntries(types.map(a => [a, Object.fromEntries(types.map(b => [b, [0, 0]]))]));
  for (const r of rounds) {
    if (!r.teams.A.type || !r.teams.B.type || !r.winner) continue;
    for (const t of ['A', 'B']) { const s = summary[t][r.teams[t].type]; s[1]++; if (r.winner === t) s[0]++; }
    const m = matrix[r.teams[myTeam].type][r.teams[other].type];
    m[1]++; if (r.winner === myTeam) m[0]++;
  }
  // A lost force buy that leaves the team on an eco next round.
  rounds.forEach((r, i) => {
    const next = rounds[i + 1];
    for (const t of ['A', 'B']) r.teams[t].brokeAfterForce = !!(r.teams[t].type === 'force' && r.winner && r.winner !== t && next && !next.half && next.teams[t].type === 'eco');
  });

  return {
    hasEconomy: !!facts, myTeam, otherTeam: other, labels: BUY_LABEL,
    teamNames: { [myTeam]: team[mySteamId] ? 'Your team' : 'Team A', [other]: team[mySteamId] ? 'Opponents' : 'Team B' },
    rounds, summary, matrix, flags,
    players: core.players.filter(p => team[p.steamid]).map(p => ({ steamid: p.steamid, name: p.name, team: team[p.steamid] })),
  };
}

// For the Maps page: where a player was each round, the round's result and their kills and deaths there.
// "Where": the callout they spent the most time in from 10 s into the round until they died, the bomb
// went down or the round ended. Spawn areas only count when they never left them.
function roundPositions(core, events, facts, steamid) {
  if (!facts) return null;
  const tr = core.tickrate || 64;
  const plants = new Map();
  for (const b of events?.bomb || []) if (b.type === 'planted' && !plants.has(b.round)) plants.set(b.round, b.tick);
  const out = [];
  core.rounds.forEach((r, i) => {
    const me = r.roster[steamid];
    const f = facts.rounds[i];
    if (!me || !f || f.num !== r.num) return;
    const samples = f.pos[steamid] || [];
    const from = Math.round(10 * tr / facts.sample);
    const until = plants.has(r.num) ? Math.floor((plants.get(r.num) - r.freezeEndTick) / facts.sample) : samples.length;
    let window = samples.slice(from, Math.max(from + 1, until)).filter(p => p >= 0);
    if (!window.length) window = samples.filter(p => p >= 0);
    const count = new Map();
    for (const p of window) count.set(p, (count.get(p) || 0) + 1);
    const ranked = [...count].sort((a, b) => b[1] - a[1]);
    const best = ranked.find(([p]) => !/spawn/i.test(facts.places[p])) || ranked[0];
    if (!best) return;
    const kills = core.kills.filter(k => k.round === r.num && k.attacker === steamid && enemyKill(k)).length;
    const died = core.kills.some(k => k.round === r.num && k.victim === steamid && k.tick <= r.endTick);
    out.push([r.num, me.team, facts.places[best[0]], r.winner === me.team ? 1 : 0, kills, died ? 1 : 0]);
  });
  return out; // [round, side, callout, won, kills, died]
}

module.exports = { buildRounds, roundPositions, placeLabel, BUY_LABEL };
