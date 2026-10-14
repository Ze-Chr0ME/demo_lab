// Scoreboard and duel statistics for a whole match, computed from the cached demo data
// (see demo.js), so changing a formula here never requires parsing demos again.

const TRADE_SECONDS = 5;   // a death is "traded" when a teammate kills the killer within this time
const UTILITY = new Set(['hegrenade', 'inferno', 'molotov', 'incgrenade']);

const enemyKill = k => k.attacker && k.attacker !== k.victim && k.attackerTeam && k.attackerTeam !== k.victimTeam;

// HLTV Rating 2.0 is not published. This is the widely used community reconstruction; it usually
// lands within about ±0.02 of HLTV's number. KAST is in percent, the rest per round.
function rating2(s) {
  if (!s.rounds) return null;
  const kpr = s.kills / s.rounds, dpr = s.deaths / s.rounds, apr = s.assists / s.rounds;
  const impact = 2.13 * kpr + 0.42 * apr - 0.41;
  return 0.0073 * s.kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * s.adr + 0.1587;
}

// Teams are the groups of players that start on the same side; they swap sides at halftime.
// Returns steamid -> 'A' | 'B', and for each round the side team A played.
function assignTeams(rounds) {
  const team = {};
  const sideOfA = {};
  for (const r of rounds) {
    let t = 0, ct = 0;
    for (const [id, p] of Object.entries(r.roster)) if (team[id] === 'A') p.team === 'T' ? t++ : ct++;
    const a = t || ct ? (t >= ct ? 'T' : 'CT') : 'T';
    sideOfA[r.num] = a;
    for (const [id, p] of Object.entries(r.roster)) if (!team[id]) team[id] = p.team === a ? 'A' : 'B';
  }
  return { team, sideOfA };
}

// side 'T' | 'CT' limits every number to what players did while on that side (HLTV's side
// filter); the team score is then the rounds each team won on it. Without it: the whole match,
// plus `sides` with both one-side versions when opts.sides is set.
function buildMatchStats(core, events, mySteamId, opts = {}) {
  const side = opts.side || null;
  const on = team => !side || team === side;
  const tr = core.tickrate || 64;
  const rounds = core.rounds;
  const { team, sideOfA } = assignTeams(rounds);
  const names = Object.fromEntries(core.players.map(p => [p.steamid, p.name]));

  const S = {};
  const st = id => (S[id] ||= {
    steamid: id, name: names[id] || id, team: team[id],
    rounds: 0, kills: 0, deaths: 0, assists: 0, flashAssists: 0, teamKills: 0, hsKills: 0,
    damage: 0, utilityDamage: 0, kastRounds: 0, firstKills: 0, firstDeaths: 0,
    tradeKills: 0, tradedDeaths: 0, enemiesFlashed: 0, multi: { 2: 0, 3: 0, 4: 0, 5: 0 },
    clutches: { won: 0, played: 0, best: 0, vs: { 1: [0, 0], 2: [0, 0], 3: [0, 0], 4: [0, 0], 5: [0, 0] } }, // vs: [won, played]
    side: { T: { rounds: 0, won: 0, fk: 0, fd: 0 }, CT: { rounds: 0, won: 0, fk: 0, fd: 0 } },
  });
  for (const id of Object.keys(team)) st(id);

  const duels = {};     // duels[a][b] = times a killed b
  const openings = {};  // same, first kill of the round only
  const add = (m, a, b) => { (m[a] ||= {})[b] = (m[a][b] || 0) + 1; };
  const score = { A: 0, B: 0 };

  const killsByRound = new Map();
  for (const k of core.kills) (killsByRound.get(k.round) || killsByRound.set(k.round, []).get(k.round)).push(k);

  for (const r of rounds) {
    const roster = r.roster;
    const winnerTeam = r.winner === sideOfA[r.num] ? 'A' : 'B';
    if (r.winner && on(r.winner)) score[winnerTeam]++;
    const kills = (killsByRound.get(r.num) || []).slice().sort((a, b) => a.tick - b.tick);
    const kast = new Set();
    const died = new Set();
    const roundKills = {};

    for (const [id, p] of Object.entries(roster)) {
      if (!on(p.team)) continue;
      const s = st(id);
      s.rounds++;
      const side = s.side[p.team];
      if (side) { side.rounds++; if (r.winner === p.team) side.won++; }
    }

    let first = true;
    kills.forEach((k, i) => {
      died.add(k.victim);
      const victimOn = on(k.victimTeam), killerOn = on(k.attackerTeam);
      if (S[k.victim] && victimOn) S[k.victim].deaths++;
      if (!enemyKill(k)) {
        if (k.attacker && k.attacker !== k.victim && k.attackerTeam === k.victimTeam && S[k.attacker] && killerOn) S[k.attacker].teamKills++;
        return;
      }
      const opening = first;
      first = false;
      if (killerOn) {
        const a = st(k.attacker);
        a.kills++;
        if (k.headshot) a.hsKills++;
        roundKills[k.attacker] = (roundKills[k.attacker] || 0) + 1;
        kast.add(k.attacker);
        if (opening) { a.firstKills++; if (a.side[k.attackerTeam]) a.side[k.attackerTeam].fk++; }
      }
      if (opening && victimOn && S[k.victim]) { S[k.victim].firstDeaths++; if (S[k.victim].side[k.victimTeam]) S[k.victim].side[k.victimTeam].fd++; }
      add(duels, k.attacker, k.victim);
      if (opening) add(openings, k.attacker, k.victim);
      if (k.assister && k.assisterTeam && k.assisterTeam !== k.victimTeam && on(k.assisterTeam) && S[k.assister]) {
        k.flashAssist ? S[k.assister].flashAssists++ : S[k.assister].assists++;
        kast.add(k.assister);
      }
      // Trade: a teammate of the victim kills this killer shortly after.
      const trade = kills.slice(i + 1).find(t => t.tick - k.tick <= TRADE_SECONDS * tr && enemyKill(t) && t.victim === k.attacker && t.attackerTeam === k.victimTeam);
      if (trade && victimOn) {
        st(trade.attacker).tradeKills++;
        if (S[k.victim]) S[k.victim].tradedDeaths++;
        kast.add(k.victim);
      }
    });

    for (const id of Object.keys(roster)) if (!died.has(id)) kast.add(id);
    for (const id of kast) if (roster[id] && on(roster[id].team) && S[id]) S[id].kastRounds++;
    for (const [id, n] of Object.entries(roundKills)) if (n >= 2) S[id].multi[Math.min(n, 5)]++;

    // Clutches: the moment a player is the last one alive on their side with enemies left.
    const alive = new Map(Object.entries(roster).filter(([, p]) => p.alive).map(([id, p]) => [id, p.team]));
    const clutch = {};
    const check = () => {
      const bySide = { T: [], CT: [] };
      for (const [id, side] of alive) bySide[side]?.push(id);
      for (const [side, ids] of Object.entries(bySide)) {
        const enemies = bySide[side === 'T' ? 'CT' : 'T'].length;
        if (ids.length === 1 && enemies >= 1 && !clutch[side]) clutch[side] = { id: ids[0], vs: enemies };
      }
    };
    check();
    for (const k of kills) {
      if (k.tick > r.endTick) break;
      alive.delete(k.victim);
      check();
    }
    for (const [cs, c] of Object.entries(clutch)) {
      const s = S[c.id];
      if (!s || !on(cs)) continue;
      const vs = s.clutches.vs[Math.min(c.vs, 5)];
      s.clutches.played++;
      vs[1]++;
      if (r.winner === cs) { s.clutches.won++; vs[0]++; s.clutches.best = Math.max(s.clutches.best, c.vs); }
    }
  }

  for (const d of events.damage) {
    if (!d.attacker || d.attacker === d.victim || !d.attackerTeam || d.attackerTeam === d.victimTeam || !on(d.attackerTeam) || !S[d.attacker]) continue;
    S[d.attacker].damage += d.dmg;
    if (UTILITY.has(d.weapon)) S[d.attacker].utilityDamage += d.dmg;
  }
  for (const b of events.blinds) {
    if (b.attacker && b.attackerTeam && b.attackerTeam !== b.victimTeam && on(b.attackerTeam) && b.duration >= 0.5 && S[b.attacker]) S[b.attacker].enemiesFlashed++;
  }

  const players = Object.values(S).filter(s => s.rounds > 0).map(s => {
    const out = {
      ...s,
      kd: s.deaths ? s.kills / s.deaths : s.kills,
      diff: s.kills - s.deaths,
      hsPct: s.kills ? Math.round(100 * s.hsKills / s.kills) : 0,
      adr: s.damage / s.rounds,
      kast: 100 * s.kastRounds / s.rounds,
      kpr: s.kills / s.rounds,
    };
    out.rating = rating2(out);
    return out;
  });

  const myTeam = team[mySteamId] || null;
  const teams = ['A', 'B'].map(id => ({
    id,
    startSide: id === 'A' ? sideOfA[rounds[0]?.num] : (sideOfA[rounds[0]?.num] === 'T' ? 'CT' : 'T'),
    score: score[id],
    played: rounds.filter(r => on(id === 'A' ? sideOfA[r.num] : sideOfA[r.num] === 'T' ? 'CT' : 'T')).length, // rounds on `side`
    mine: myTeam === id,
    players: players.filter(p => p.team === id).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)),
  }));
  if (myTeam === 'B') teams.reverse();

  const out = { rounds: rounds.length, teams, duels, openings, me: myTeam ? mySteamId : null };
  if (!side && opts.sides) {
    out.sides = {};
    for (const sd of ['CT', 'T']) {
      const one = buildMatchStats(core, events, mySteamId, { side: sd });
      out.sides[sd] = { teams: one.teams };
    }
  }
  return out;
}

module.exports = { buildMatchStats, rating2, enemyKill, assignTeams };
