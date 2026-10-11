// Extracts everything the app needs from a demo in one parser pass. Runs inside a worker thread
// (see parseWorker.js) because parsing blocks for a few seconds.
//  - core: rounds, rosters, kills. Small; used for highlights, the match list and duplicate detection.
//  - events: damage, shots, flashes, grenades, bomb, with positions. Used by the scoreboard and heatmap.
// Raw facts are stored rather than finished stats, so new stats can be computed from the cache
// without parsing the demo again. Bump DATA_VERSION only when the extracted facts themselves change.
const parser = require('./parser');

const DATA_VERSION = 2;
const TEAM_LETTER = { 2: 'T', 3: 'CT' };
const GRENADES = { smokegrenade_detonate: 'smoke', flashbang_detonate: 'flash', hegrenade_detonate: 'he', inferno_startburn: 'molotov', decoy_started: 'decoy' };
const EXPIRES = { smokegrenade_expired: 'smoke', inferno_expire: 'molotov' };
const NOT_SHOTS = /grenade|flashbang|molotov|decoy|knife|bayonet|c4/;

const r1 = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const pos = (e, who) => (e[`${who}_X`] == null ? null : [r1(e[`${who}_X`]), r1(e[`${who}_Y`]), r1(e[`${who}_Z`])]);
const sid = s => (s && s !== '0' ? s : null);

function extractDemo(file) {
  const header = parser.parseHeader(file);
  const events = parser.parseEvents(
    file,
    ['player_death', 'player_hurt', 'weapon_fire', 'player_blind', 'round_start', 'round_freeze_end', 'round_end', 'begin_new_match',
      'bomb_planted', 'bomb_defused', 'bomb_exploded', ...Object.keys(GRENADES), ...Object.keys(EXPIRES)],
    ['X', 'Y', 'Z', 'team_num'],
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
      if (!sid(row.steamid) || !TEAM_LETTER[row.team_num]) continue;
      if (!byTick.has(row.tick)) byTick.set(row.tick, {});
      byTick.get(row.tick)[row.steamid] = { team: TEAM_LETTER[row.team_num], alive: !!row.is_alive, name: row.name };
    }
    for (const r of rounds) r.roster = byTick.get(r.freezeEndTick) || {};
  }

  const players = {};
  for (const r of rounds) for (const [id, p] of Object.entries(r.roster)) players[id] = p.name;
  for (const p of parser.parsePlayerInfo(file)) if (sid(p.steamid) && !players[p.steamid] && TEAM_LETTER[p.team_number]) players[p.steamid] = p.name;

  const roundOf = tick => {
    for (let i = rounds.length - 1; i >= 0; i--) if (tick >= rounds[i].startTick) return (tick < (rounds[i].nextStartTick ?? Infinity)) ? rounds[i].num : null;
    return null;
  };

  const kills = of('player_death').map(e => ({
    tick: e.tick,
    round: roundOf(e.tick),
    attacker: sid(e.attacker_steamid),
    attackerName: e.attacker_name || null,
    attackerTeam: TEAM_LETTER[e.attacker_team_num] || null,
    victim: e.user_steamid,
    victimName: e.user_name,
    victimTeam: TEAM_LETTER[e.user_team_num] || null,
    assister: sid(e.assister_steamid),
    assisterTeam: TEAM_LETTER[e.assister_team_num] || null,
    flashAssist: !!e.assistedflash,
    weapon: e.weapon,
    headshot: !!e.headshot,
    noscope: !!e.noscope,
    wallbang: (e.penetrated || 0) > 0,
    smoke: !!e.thrusmoke,
    blind: !!e.attackerblind,
    inAir: !!e.attackerinair,
    distance: e.distance,
    attackerPos: pos(e, 'attacker'),
    victimPos: pos(e, 'user'),
  })).filter(k => k.round !== null);

  // Damage actually dealt: an AWP body shot reports 115 even on a 30 HP player, so cap each hit at
  // the health the victim had left (tracked from the previous hit in the same round).
  const damage = [];
  const hp = new Map();
  let curRound = null;
  for (const e of of('player_hurt')) {
    const round = roundOf(e.tick);
    if (round === null) continue;
    if (round !== curRound) { hp.clear(); curRound = round; }
    const before = hp.get(e.user_steamid) ?? 100;
    const dmg = Math.max(0, Math.min(e.dmg_health || 0, before));
    hp.set(e.user_steamid, e.health ?? Math.max(0, before - dmg));
    damage.push({
      tick: e.tick, round,
      attacker: sid(e.attacker_steamid), attackerTeam: TEAM_LETTER[e.attacker_team_num] || null,
      victim: e.user_steamid, victimTeam: TEAM_LETTER[e.user_team_num] || null,
      dmg, armor: e.dmg_armor || 0, weapon: e.weapon, hitgroup: e.hitgroup,
      attackerPos: pos(e, 'attacker'), victimPos: pos(e, 'user'),
    });
  }

  // Shots and grenade throws, as compact tuples: [tick, round, steamid, x, y, z, weapon]
  const shots = [], throws = [];
  for (const e of of('weapon_fire')) {
    const round = roundOf(e.tick);
    const p = pos(e, 'user');
    if (round === null || !p || !sid(e.user_steamid)) continue;
    const w = (e.weapon || '').replace(/^weapon_/, '');
    const row = [e.tick, round, e.user_steamid, p[0], p[1], p[2], w];
    if (/grenade|flashbang|molotov|decoy/.test(w)) throws.push(row);
    else if (!NOT_SHOTS.test(w)) shots.push(row);
  }

  const blinds = of('player_blind').map(e => ({
    tick: e.tick, round: roundOf(e.tick),
    attacker: sid(e.attacker_steamid), attackerTeam: TEAM_LETTER[e.attacker_team_num] || null,
    victim: e.user_steamid, victimTeam: TEAM_LETTER[e.user_team_num] || null,
    duration: Math.round((e.blind_duration || 0) * 100) / 100,
    victimPos: pos(e, 'user'),
  })).filter(b => b.round !== null);

  const grenades = live.filter(e => GRENADES[e.event_name] || EXPIRES[e.event_name]).map(e => ({
    tick: e.tick, round: roundOf(e.tick),
    type: GRENADES[e.event_name] || EXPIRES[e.event_name], expire: !!EXPIRES[e.event_name], entity: e.entityid ?? null,
    thrower: sid(e.user_steamid), team: TEAM_LETTER[e.user_team_num] || null,
    pos: [r1(e.x), r1(e.y), r1(e.z)],
  })).filter(g => g.round !== null);

  const bomb = live.filter(e => /^bomb_/.test(e.event_name)).map(e => ({
    tick: e.tick, round: roundOf(e.tick), type: e.event_name.slice(5), player: sid(e.user_steamid), pos: pos(e, 'user'),
  })).filter(b => b.round !== null);

  const core = {
    version: DATA_VERSION,
    map: header.map_name,
    server: header.server_name,
    tickrate: 64,
    players: Object.entries(players).map(([steamid, name]) => ({ steamid, name })),
    rounds,
    kills,
  };
  return { core, events: { version: DATA_VERSION, damage, shots, throws, blinds, grenades, bomb } };
}

module.exports = { extractDemo, DATA_VERSION };
