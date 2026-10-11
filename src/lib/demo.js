// Extracts the compact match data (rounds, rosters, kills) needed to find highlights.
// Runs inside a worker thread (see parseWorker.js) because parsing blocks for ~1-3s.
const parser = require('./parser');

const DATA_VERSION = 1;
const TEAM_LETTER = { 2: 'T', 3: 'CT' };

function extractDemo(file) {
  const header = parser.parseHeader(file);
  const events = parser.parseEvents(
    file,
    ['player_death', 'round_start', 'round_freeze_end', 'round_end', 'begin_new_match'],
    ['team_num'],
    ['is_warmup_period'],
  );

  const matchStart = Math.max(0, ...events.filter(e => e.event_name === 'begin_new_match').map(e => e.tick));
  const live = events.filter(e => !e.is_warmup_period && e.tick >= matchStart).sort((a, b) => a.tick - b.tick);
  const of = name => live.filter(e => e.event_name === name);

  // Rounds are the intervals between consecutive round_start events; post-round
  // kills (after round_end) still belong to the round they happened in.
  const starts = of('round_start').map(e => e.tick);
  if (!starts.length || starts[0] > (of('round_freeze_end')[0]?.tick ?? Infinity)) starts.unshift(matchStart);
  const freezeEnds = of('round_freeze_end');
  const roundEnds = of('round_end');

  const rounds = [];
  for (let i = 0; i < starts.length; i++) {
    const startTick = starts[i];
    const nextStartTick = starts[i + 1] ?? Infinity;
    const end = roundEnds.find(e => e.tick >= startTick && e.tick < nextStartTick);
    const freeze = freezeEnds.find(e => e.tick >= startTick && e.tick < nextStartTick);
    if (!end || !freeze) continue;
    rounds.push({
      num: rounds.length + 1,
      startTick,
      freezeEndTick: freeze.tick,
      endTick: end.tick,
      nextStartTick: Number.isFinite(nextStartTick) ? nextStartTick : null,
      winner: end.winner, // 'T' | 'CT'
      reason: end.reason,
    });
  }

  // Who is on which team and alive when each round goes live.
  if (rounds.length) {
    const ticks = parser.parseTicks(file, ['team_num', 'is_alive'], rounds.map(r => r.freezeEndTick));
    const byTick = new Map();
    for (const row of ticks) {
      if (!row.steamid || row.steamid === '0' || !TEAM_LETTER[row.team_num]) continue;
      if (!byTick.has(row.tick)) byTick.set(row.tick, {});
      byTick.get(row.tick)[row.steamid] = { team: TEAM_LETTER[row.team_num], alive: !!row.is_alive, name: row.name };
    }
    for (const r of rounds) r.roster = byTick.get(r.freezeEndTick) || {};
  }

  const players = {};
  for (const r of rounds) for (const [id, p] of Object.entries(r.roster)) players[id] = p.name;
  for (const p of parser.parsePlayerInfo(file)) if (p.steamid && p.steamid !== '0' && !players[p.steamid] && TEAM_LETTER[p.team_number]) players[p.steamid] = p.name;

  const roundOf = tick => {
    for (let i = rounds.length - 1; i >= 0; i--) if (tick >= rounds[i].startTick) return (tick < (rounds[i].nextStartTick ?? Infinity)) ? rounds[i].num : null;
    return null;
  };

  const kills = of('player_death').map(e => ({
    tick: e.tick,
    round: roundOf(e.tick),
    attacker: e.attacker_steamid || null,
    attackerName: e.attacker_name || null,
    attackerTeam: TEAM_LETTER[e.attacker_team_num] || null,
    victim: e.user_steamid,
    victimName: e.user_name,
    victimTeam: TEAM_LETTER[e.user_team_num] || null,
    weapon: e.weapon,
    headshot: !!e.headshot,
    noscope: !!e.noscope,
    wallbang: (e.penetrated || 0) > 0,
    smoke: !!e.thrusmoke,
    blind: !!e.attackerblind,
    inAir: !!e.attackerinair,
    distance: e.distance,
  })).filter(k => k.round !== null);

  return {
    version: DATA_VERSION,
    map: header.map_name,
    server: header.server_name,
    tickrate: 64,
    players: Object.entries(players).map(([steamid, name]) => ({ steamid, name })),
    rounds,
    kills,
  };
}

module.exports = { extractDemo, DATA_VERSION };
