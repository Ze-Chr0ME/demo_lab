// One player's numbers for one match, for the overview dashboard and the per-map stats. Small enough to
// keep for every demo; the renderer adds them up with whatever filters are picked (mode, map, period).
const { buildMatchStats, enemyKill } = require('./stats');
const { weaponName } = require('./highlights');

const PROFILE_VERSION = 1; // bump when the summary below changes

function gameMode(core) {
  if (/^rush/i.test(core.map || '')) return 'Rush';
  const size = Math.max(0, ...core.rounds.map(r => Object.keys(r.roster).length));
  return size && size <= 4 ? 'Wingman' : '5v5';
}

function matchSummary(core, events, steamid) {
  if (!steamid || !core.players.some(p => p.steamid === steamid)) return null;
  const st = buildMatchStats(core, events, steamid);
  const mine = st.teams.find(t => t.mine);
  const other = st.teams.find(t => t !== mine);
  const p = mine?.players.find(x => x.steamid === steamid);
  if (!p) return null;

  const weapons = {}; // weapon -> [kills, headshot kills]
  for (const k of core.kills) {
    if (k.attacker !== steamid || !enemyKill(k)) continue;
    const w = weaponName(k.weapon);
    const row = weapons[w] ||= [0, 0];
    row[0]++;
    if (k.headshot) row[1]++;
  }
  return {
    map: core.map, mode: gameMode(core), totalRounds: st.rounds,
    score: [mine.score, other?.score ?? 0],
    result: mine.score > (other?.score ?? 0) ? 'W' : mine.score < (other?.score ?? 0) ? 'L' : 'T',
    name: p.name,
    rounds: p.rounds, kills: p.kills, deaths: p.deaths, assists: p.assists, hsKills: p.hsKills,
    damage: p.damage, kastRounds: p.kastRounds, rating: p.rating,
    firstKills: p.firstKills, firstDeaths: p.firstDeaths, side: p.side,
    clutches: p.clutches, multi: p.multi, tradeKills: p.tradeKills,
    utilityDamage: p.utilityDamage, enemiesFlashed: p.enemiesFlashed, flashAssists: p.flashAssists,
    weapons,
    mates: mine.players.filter(x => x.steamid !== steamid).map(x => [x.steamid, x.name]),
  };
}

module.exports = { matchSummary, PROFILE_VERSION };
