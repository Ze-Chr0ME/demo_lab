// Training drills played in CS2 (lib/training.js runs them): what each drill is, and the spots its
// repetitions use, taken from the kills in the user's own demos.
//
// A kill is an angle: where the killer stood (the bot goes there) and where the victim was (the player
// starts next to it, out of the killer's sight when the map mesh can tell). Kills are grouped by both
// places (BOT_CELL / ME_CELL grids), so "the angles people die to most" and "the angles I died to"
// come from the same list:
//  common      most kills from that angle, any player in the user's demos
//  mine        the user's own deaths
// Duels at range (counter-strafe, tracking) use the killer's spot for the player and the victim's
// for the bot instead: a kill without wallbang or smoke proves the two could see each other.
const BOT_CELL = 140, ME_CELL = 420, Z_CELL = 110;
const NOT_GUNS = /grenade|flashbang|molotov|inferno|decoy|knife|bayonet|taser|world|c4|planted/i;
const EYE = 64, HEAD = 62;

// bots: one (one angle per rep), area (every angle onto one area at once), duel (one bot at range).
// shoot: the bots fire back. hold: they don't walk (bot_stop, or bot_freeze when they shoot).
const DRILLS = {
  // mode: [game_type, game_mode] the map is loaded in (its own cfg/maps/pg_training.cfg: Custom)
  procedural: { name: 'Procedural map', map: 'pg_training', workshop: '3808451248', free: true, mode: [3, 0],
    about: 'SCOPE.GG\'s training map: rooms built from pieces of competitive maps, a new layout every run, bots that strafe, flash and peek you. Clear every room.',
    mapTitle: 'SCOPE.GG Procedurally Generated Training Map', how: 'Pick the map\'s settings (bots, difficulty, headshots only…) with its buttons in CS2 and start a run.' },
  // the warm-up: Aim Botz, set up in game with its own buttons
  warmup: { name: 'Warm-up', map: 'aim_botz', workshop: '3070244462', free: true,
    about: 'Aim Botz, the classic aim map: standing, moving or armoured bots to flick, tap, spray and peek for as long as you like before you play.',
    mapTitle: 'Aim Botz - Aim Training (CS2)', how: 'Pick your gun and the bots (moving, armour, parts of the map) with the map\'s buttons in CS2.' },
  preaim: { name: 'Pre-aim', bots: 'one', shoot: false,
    about: 'One angle at a time: you start next to the spot, the bot waits where enemies kill from. Have the crosshair on it before it comes into view.' },
  crosshair: { name: 'Crosshair placement', bots: 'area', shoot: false,
    about: 'Several bots hold the angles of one area at once. Walk in and clear them: crosshair at head height, already on the next angle.' },
  peek: { name: 'Peeking', bots: 'one', shoot: true,
    about: 'A bot holds the angle and shoots back. Peek it from cover and win the duel: stop before you shoot, first bullet at the head.' },
  strafe: { name: 'Counter-strafe', bots: 'duel', shoot: false,
    about: 'A bot at a real duel distance. Strafe, stop with the opposite key, shoot, strafe again. Shots fired while still moving are counted.' },
  tracking: { name: 'Tracking', bots: 'duel', shoot: false, strafe: true,
    about: 'The bot strafes left and right at a real duel distance. Keep the crosshair on its head while you spray and tap.' },
  // made by the player, recorded in CS2 or placed on the 2D map (lib/scenarios.js), not from the demos
  scenario: { name: 'My scenarios', bots: 'scenario', shoot: true,
    about: 'Record your own in CS2: where you start and bots holding the angles you choose. Then clear it, rep after rep, map by map.' },
};
// The warm-up playlist: drills in a row on one map, [drill, seconds].
const WARMUP = [['strafe', 120], ['tracking', 120], ['preaim', 180], ['peek', 180]];

const cell = (p, s) => `${Math.round(p[0] / s)},${Math.round(p[1] / s)},${Math.round(p[2] / Z_CELL)}`;
const median = arr => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
const mid = pts => [0, 1, 2].map(i => Math.round(median(pts.map(p => p[i]))));
const okPos = p => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite);

// The kills of one demo that make usable angles, compact (kept in derived.json per demo):
// [killer x, y, z, victim x, y, z, 1 = the victim was me, 1 = the killer was me]
function anglePairs(core, me) {
  const out = [];
  for (const k of core.kills || []) {
    if (!k.attacker || k.attacker === k.victim || k.wallbang || k.smoke || NOT_GUNS.test(k.weapon || '')) continue;
    if (!okPos(k.attackerPos) || !okPos(k.victimPos) || !k.attackerTeam || k.attackerTeam === k.victimTeam) continue;
    const d = Math.hypot(k.attackerPos[0] - k.victimPos[0], k.attackerPos[1] - k.victimPos[1]);
    if (d < 120 || d > 3500) continue;
    out.push([...k.attackerPos.map(Math.round), ...k.victimPos.map(Math.round), k.victim === me ? 1 : 0, k.attacker === me ? 1 : 0]);
  }
  return out;
}

// Groups the pairs of every demo on a map into angles: { bot, me, count, mine, dist }.
function angles(pairs) {
  const by = new Map();
  for (const p of pairs) {
    const bot = p.slice(0, 3), me = p.slice(3, 6);
    const key = cell(bot, BOT_CELL) + '|' + cell(me, ME_CELL);
    const g = by.get(key) || by.set(key, { bots: [], mes: [], count: 0, mine: 0 }).get(key);
    g.bots.push(bot); g.mes.push(me); g.count++; g.mine += p[6];
  }
  return [...by.values()].map(g => {
    const bot = mid(g.bots), me = mid(g.mes);
    return { bot, me, count: g.count, mine: g.mine, dist: Math.round(Math.hypot(bot[0] - me[0], bot[1] - me[1])) };
  });
}

const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
const yawTo = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
// Turns tried around a spot, "straight away from the bot" first, then more and more to the sides.
const TURNS = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8].map(k => k * Math.PI / 8);

// Somewhere near `me` the bot at `bot` can't see (behind the corner the victim came from), reachable
// from `me` in a straight line, with floor under it and room to stand. Without a mesh: `me` itself.
function hiddenStart(geo, me, bot) {
  if (!geo) return me;
  const sees = p => !geo.blocked(p[0], p[1], p[2] + EYE, bot[0], bot[1], bot[2] + HEAD) || !geo.blocked(p[0], p[1], p[2] + 40, bot[0], bot[1], bot[2] + 40);
  if (!sees(me)) return me;
  const [ax, ay] = unit(me[0] - bot[0], me[1] - bot[1]);
  for (let r = 64; r <= 384; r += 32) {
    for (const turn of TURNS) {
      const dx = ax * Math.cos(turn) - ay * Math.sin(turn), dy = ax * Math.sin(turn) + ay * Math.cos(turn);
      const p = [me[0] + dx * r, me[1] + dy * r, me[2]];
      if (geo.blocked(me[0], me[1], me[2] + 40, p[0], p[1], p[2] + 40)) continue;   // wall in the way
      if (!geo.blocked(p[0], p[1], p[2] + 40, p[0], p[1], p[2] - 70)) continue;      // no floor
      if (geo.blocked(p[0], p[1], p[2] + 20, p[0], p[1], p[2] + 72)) continue;       // no room to stand
      if (!sees(p)) return p.map(Math.round);
    }
  }
  return me;
}

// The repetitions of a drill: [{ me: [x, y, z], ang: [pitch, yaw], bots: [[x, y, z], ...], tag, count }].
// list: angles() of the map. source: 'common' | 'mine' | 'both'. geo: the map's MapGeometry or null.
function buildReps(drill, list, { source = 'both', geo = null, max = 12 } = {}) {
  const d = DRILLS[drill];
  if (!d || d.free || d.bots === 'scenario') return [];
  const face = (me, bot) => [0, Math.round(yawTo(me, bot) * 10) / 10];
  // Angle drills: facing the way into the angle (from the hidden start to where the duel happened),
  // not the bot, so placing the crosshair is the player's job. Started on the spot itself: 45° off.
  const walkIn = (start, spot, bot) => (Math.hypot(start[0] - spot[0], start[1] - spot[1]) > 32 ? face(start, spot) : [0, Math.round(((yawTo(start, bot) + 45 + 540) % 360 - 180) * 10) / 10]);
  if (d.bots === 'duel') {
    // the killer's spot for me, the victim's for the bot, at a real duel distance
    const [lo, hi] = drill === 'tracking' ? [350, 1300] : [550, 1900];
    const pool = list.filter(a => a.dist >= lo && a.dist <= hi);
    const mineFirst = source === 'mine' ? pool.filter(a => a.mine) : pool;
    return (mineFirst.length ? mineFirst : pool).sort((a, b) => b.count - a.count).slice(0, max)
      .map(a => ({ me: a.bot, ang: face(a.bot, a.me), bots: [a.me], tag: a.mine ? 'mine' : 'common', count: a.count }));
  }
  const mine = list.filter(a => a.mine).sort((a, b) => b.mine - a.mine || b.count - a.count);
  const common = list.filter(a => a.count >= 2).sort((a, b) => b.count - a.count);

  if (d.bots === 'area') {
    // the angles onto one area at once (up to 5 bots), one rep per area
    const areas = new Map();
    for (const a of source === 'mine' ? mine : source === 'common' ? common : [...mine, ...common]) {
      const k = cell(a.me, ME_CELL * 1.5);
      const g = areas.get(k) || areas.set(k, { list: [], count: 0, mine: 0 }).get(k);
      if (!g.list.includes(a)) { g.list.push(a); g.count += a.count; g.mine += a.mine; }
    }
    return [...areas.values()].filter(g => g.list.length >= 2)
      .sort((x, y) => (source === 'common' ? 0 : y.mine - x.mine) || y.count - x.count).slice(0, max)
      .map(g => {
        const top = g.list.sort((x, y) => y.count - x.count).slice(0, 5);
        const spot = mid(top.map(a => a.me));
        const start = hiddenStart(geo, spot, top[0].bot);
        return { me: start, ang: walkIn(start, spot, top[0].bot), bots: top.map(a => a.bot), tag: g.mine ? 'mine' : 'common', count: g.count };
      });
  }

  const pick = [];
  const take = (arr, n) => { for (const a of arr) { if (n <= 0) break; if (!pick.includes(a)) { pick.push(a); n--; } } };
  if (source === 'mine') take(mine, max);
  else if (source === 'common') take(common, max);
  else { take(mine, Math.ceil(max / 2)); take(common, max - pick.length); take(mine, max - pick.length); }
  return pick.map(a => {
    const start = hiddenStart(geo, a.me, a.bot);
    return { me: start, ang: walkIn(start, a.me, a.bot), bots: [a.bot], tag: a.mine ? 'mine' : 'common', count: a.count };
  });
}

module.exports = { DRILLS, WARMUP, anglePairs, angles, buildReps, hiddenStart };