// Aim mechanics per player: counter-strafing, first-bullet and spray accuracy, crosshair placement and
// time to damage. The facts are collected during the Integrity tab's pass over every tick (integrity.js
// calls sight() for every enemy pair it checks for line of sight, then finish()), stored as
// <id>.aim.json, and turned into numbers by summarizeAim() at read time.
//
// Per player:
//  shots: [tick, weapon index, speed (u/s), flags, ticks since the previous shot (max 255), hit]
//         flags: 1 in the air, 2 scoped, 4 crouching, 8 an enemy was visible within 8° of the crosshair
//         hit: 0 missed, 1 hit an enemy, 2 hit an enemy in the head
//  eng:   enemies coming into view: [tick, enemy steamid, crosshair distance to their head (°), distance
//         (units), ticks until this player first damaged them (-1 = not within 2 s), who hurt the other
//         first (0 nobody, 1 this player, 2 the enemy), who killed the other within 5 s (0, 1, 2)]
const AIM_VERSION = 1;
const SPOT_GAP = 32;     // an enemy "comes into view" after being out of sight for at least half a second
const MAX_DIST = 3000;
const ON_TARGET = 8;     // degrees: a shot "at" a visible enemy
const NOT_GUNS = /grenade|flashbang|molotov|incgrenade|inferno|decoy|knife|bayonet|c4|taser|world/;

const wrap = d => ((d + 540) % 360) - 180;
const deg = r => r * 180 / Math.PI;
const r1 = v => Math.round(v * 10) / 10;

class AimCollector {
  // ctx from integrity.js: { ids, P, tr, los(p, q, t), F: { ALIVE, CT, T, SCOPED, DUCK, AIR, NOCMD } }
  constructor(ctx) {
    Object.assign(this, ctx);
    const N = ctx.ids.length;
    this.N = N;
    this.lastSeen = new Float64Array(N * N).fill(-1e9);
    this.eng = ctx.ids.map(() => []);
  }

  side(p, t) { return this.P[p].flags[t] & (this.F.CT | this.F.T); }
  alive(p, t) { return this.P[p].flags[t] & this.F.ALIVE; }

  // Where q's head is relative to p's crosshair at tick t.
  aimAt(p, q, t) {
    const a = this.P[p], b = this.P[q], F = this.F;
    const ex = a.x[t], ey = a.y[t], ez = a.z[t] + (a.flags[t] & F.DUCK ? 46 : 64);
    const dx = b.x[t] - ex, dy = b.y[t] - ey, dz = b.z[t] + (b.flags[t] & F.DUCK ? 44 : 62) - ez;
    const dist = Math.hypot(dx, dy, dz);
    const yawTo = deg(Math.atan2(dy, dx)), pitchTo = -deg(Math.asin(dz / dist));
    const dyaw = wrap(yawTo - a.yaw[t]), dpitch = pitchTo - a.pitch[t];
    return { err: Math.hypot(dyaw * Math.cos(pitchTo * Math.PI / 180), dpitch), dyaw, dpitch, dist };
  }

  // Called by integrity.js every time it checks whether p can see the enemy q (every 2 ticks).
  sight(p, q, t, visible) {
    if (!visible) return;
    const k = p * this.N + q;
    const fresh = t - this.lastSeen[k] > SPOT_GAP;
    this.lastSeen[k] = t;
    if (!fresh || Number.isNaN(this.P[p].yaw[t]) || (this.P[p].flags[t] & this.F.NOCMD)) return;
    const e = this.aimAt(p, q, t);
    // Only enemies that appear inside the player's field of view (106° wide, about 70° high).
    if (e.dist > MAX_DIST || Math.abs(e.dyaw) > 53 || Math.abs(e.dpitch) > 35) return;
    this.eng[p].push([t, q, r1(e.err), Math.round(e.dist)]);
  }

  // events: the parser's weapon_fire, player_hurt and player_death events.
  finish(events, maxTick) {
    const { ids, P, F, tr } = this;
    const idx = new Map(ids.map((id, i) => [id, i]));
    const enemies = (p, q, t) => q !== p && this.side(q, t) && this.side(p, t) && this.side(q, t) !== this.side(p, t);

    const hurts = new Map();          // `${tick}|${attacker}` -> best hit on an enemy (2 head, 1 body)
    const firstHurt = new Map();      // `${a}|${v}` -> ticks a hurt v
    const killsBy = new Map();        // `${a}|${v}` -> ticks a killed v
    const push = (m, k, t) => (m.get(k) || m.set(k, []).get(k)).push(t);
    for (const e of events) {
      if (e.event_name !== 'player_hurt' && e.event_name !== 'player_death') continue;
      const a = idx.get(e.attacker_steamid), v = idx.get(e.user_steamid);
      if (a === undefined || v === undefined || e.tick >= maxTick || !enemies(a, v, e.tick)) continue;
      if (e.event_name === 'player_death') { push(killsBy, `${a}|${v}`, e.tick); continue; }
      push(firstHurt, `${a}|${v}`, e.tick);
      if (NOT_GUNS.test(e.weapon || '')) continue;
      const key = `${e.tick}|${a}`;
      hurts.set(key, Math.max(hurts.get(key) || 0, e.hitgroup === 'head' ? 2 : 1));
    }
    const firstAfter = (list, from, to) => { for (const t of list || []) if (t >= from && t <= to) return t; return null; };

    const weapons = [], weaponIndex = new Map();
    const players = {};
    ids.forEach((id, p) => {
      const a = P[p];
      const shots = [];
      let prev = -1e9;
      for (const e of events) {
        if (e.event_name !== 'weapon_fire' || e.user_steamid !== id || e.tick >= maxTick) continue;
        const w = (e.weapon || '').replace(/^weapon_/, '');
        if (NOT_GUNS.test(w) || !this.alive(p, e.tick)) continue;
        const t = e.tick;
        if (!weaponIndex.has(w)) { weaponIndex.set(w, weapons.length); weapons.push(w); }
        const back = Number.isNaN(a.x[t - 2]) ? (Number.isNaN(a.x[t - 1]) ? 0 : 1) : 2;
        const speed = back ? Math.round(Math.hypot(a.x[t] - a.x[t - back], a.y[t] - a.y[t - back]) * tr / back) : 0;
        let flags = (a.flags[t] & F.AIR ? 1 : 0) | (a.flags[t] & F.SCOPED ? 2 : 0) | (a.flags[t] & F.DUCK ? 4 : 0);
        if (!Number.isNaN(a.yaw[t])) {
          for (let q = 0; q < ids.length; q++) {
            if (!this.alive(q, t) || !enemies(p, q, t)) continue;
            const g = this.aimAt(p, q, t);
            if (g.err <= ON_TARGET && g.dist <= MAX_DIST && this.los(p, q, t)) { flags |= 8; break; }
          }
        }
        shots.push([t, weaponIndex.get(w), speed, flags, Math.min(255, t - prev), hurts.get(`${t}|${p}`) || 0]);
        prev = t;
      }
      const eng = this.eng[p].map(([t, q, err, dist]) => {
        const mine = firstAfter(firstHurt.get(`${p}|${q}`), t, t + 2 * tr);
        const theirs = firstAfter(firstHurt.get(`${q}|${p}`), t - 8, t + 2 * tr);
        const first = mine == null && theirs == null ? 0 : theirs == null || (mine != null && mine <= theirs) ? 1 : 2;
        const iKilled = firstAfter(killsBy.get(`${p}|${q}`), t, t + 5 * tr), theyKilled = firstAfter(killsBy.get(`${q}|${p}`), t, t + 5 * tr);
        const outcome = iKilled == null && theyKilled == null ? 0 : theyKilled == null || (iKilled != null && iKilled <= theyKilled) ? 1 : 2;
        return [t, ids[q], err, dist, mine == null ? -1 : mine - t, first, outcome];
      });
      players[id] = { shots, eng };
    });
    return { version: AIM_VERSION, tickrate: tr, weapons, players };
  }
}

// ---------- Numbers (at read time) ----------
// Max running speed per weapon (scoped where it differs); a shot is accurate below 34% of it.
const MAX_SPEED = {
  ak47: 215, m4a1: 225, m4a1_silencer: 225, famas: 220, galilar: 215, aug: [220, 150], sg556: [210, 150],
  awp: [200, 100], ssg08: 230, g3sg1: [215, 120], scar20: [215, 120],
  deagle: 230, revolver: 220, glock: 240, usp_silencer: 240, hkp2000: 240, p250: 240, fiveseven: 240, tec9: 240, cz75a: 240, elite: 240,
  mac10: 240, mp9: 240, mp7: 220, mp5sd: 235, ump45: 230, p90: 230, bizon: 240,
  nova: 220, xm1014: 215, mag7: 225, sawedoff: 210, m249: 195, negev: 150,
};
const CLASS = w => /^(ak47|m4a1|m4a1_silencer|famas|galilar|aug|sg556)$/.test(w) ? 'rifle'
  : /^(awp|ssg08|g3sg1|scar20)$/.test(w) ? 'sniper'
    : /^(mac10|mp9|mp7|mp5sd|ump45|p90|bizon)$/.test(w) ? 'smg'
      : /^(nova|xm1014|mag7|sawedoff)$/.test(w) ? 'shotgun'
        : /^(m249|negev)$/.test(w) ? 'heavy' : 'pistol';
const AUTOMATIC = new Set(['rifle', 'smg', 'heavy']);
const STOP_CLASSES = new Set(['rifle', 'sniper', 'pistol']); // run-and-gun weapons don't need a stop
const FRESH = 32;   // a first bullet comes after at least half a second without shooting
const SPRAY = 12;   // shots this close together belong to one spray
const accurateSpeed = (w, scoped) => { const s = MAX_SPEED[w] ?? 230; return 0.34 * (Array.isArray(s) ? (scoped ? s[1] : s[0]) : s); };

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ratio = (a, b) => (b ? a / b : null);

// One player's numbers in one match (plus the raw counts, so matches can be added up). With roundOf
// (tick -> round number), the same counts per round too: the Aim tab's progression over the match.
function aimNumbers(f, weapons, tr, roundOf = null) {
  const blank = () => ({ stop: [0, 0], first: [0, 0], spray: [0, 0], hits: 0, head: 0, shots: 0, ttd: [], xhair: [] });
  const c = { ...blank(), byClass: {} };
  const cls = k => (c.byClass[k] ||= { stop: [0, 0], first: [0, 0], shots: 0, hits: 0 });
  const perRound = new Map();
  const inRound = tick => { if (!roundOf) return blank(); const r = roundOf(tick); return perRound.get(r) || perRound.set(r, blank()).get(r); };
  const tally = (pair, ok, ...more) => { for (const o of [c, ...more]) { o[pair][1]++; if (ok) o[pair][0]++; } };
  let sprayIdx = 0, prevW = -1;
  const moving = [];
  for (const [tick, wi, speed, flags, gap, hit] of f.shots) {
    const w = weapons[wi], k = CLASS(w), x = cls(k), r = inRound(tick);
    sprayIdx = gap <= SPRAY && wi === prevW ? sprayIdx + 1 : 0;
    prevW = wi;
    c.shots++; x.shots++; r.shots++;
    if (hit) { c.hits++; x.hits++; r.hits++; if (hit === 2) { c.head++; r.head++; } }
    const fresh = gap >= FRESH, air = flags & 1, onTarget = flags & 8;
    if (fresh && !air && STOP_CLASSES.has(k)) {
      const ok = speed <= accurateSpeed(w, flags & 2);
      tally('stop', ok, x, r);
      if (!ok && onTarget && !hit) moving.push({ tick, weapon: w, speed });
    }
    if (fresh && onTarget && k !== 'shotgun') tally('first', hit, x, r);
    if (sprayIdx >= 3 && onTarget && AUTOMATIC.has(k)) tally('spray', hit, r);
  }
  for (const [tick, , err, , ttd, first] of f.eng) {
    const r = inRound(tick);
    c.xhair.push(err); r.xhair.push(err);
    if (ttd >= 0 && ttd <= 1.5 * tr && first !== 2) { const ms = Math.round(ttd * 1000 / tr); c.ttd.push(ms); r.ttd.push(ms); }
  }
  return { counts: c, moving, perRound };
}

function finalNumbers(c) {
  return {
    counterStrafe: ratio(c.stop[0], c.stop[1]), counterStrafeN: c.stop[1],
    firstBullet: ratio(c.first[0], c.first[1]), firstBulletN: c.first[1],
    spray: ratio(c.spray[0], c.spray[1]), sprayN: c.spray[1],
    headHits: ratio(c.head, c.hits), hits: c.hits, shots: c.shots,
    timeToDamage: median(c.ttd), timeToDamageN: c.ttd.length,
    crosshair: median(c.xhair), crosshairN: c.xhair.length,
  };
}

// The Aim tab: every player of the match, with the moments worth a look for each.
function summarizeAim(facts, core, mySteamId) {
  const { assignTeams } = require('./stats');
  const tr = facts.tickrate || 64;
  const names = Object.fromEntries(core.players.map(p => [p.steamid, p.name]));
  const { team, sideOfA } = assignTeams(core.rounds);
  const roundOf = tick => { for (let i = core.rounds.length - 1; i >= 0; i--) if (tick >= core.rounds[i].startTick) return core.rounds[i]; return core.rounds[0]; };
  const when = tick => { const r = roundOf(tick); return { round: r.num, clock: Math.max(0, Math.round((tick - r.freezeEndTick) / tr)) }; };
  const players = Object.entries(facts.players).filter(([id, f]) => names[id] && f.shots.length + f.eng.length > 0).map(([id, f]) => {
    const { counts, moving, perRound } = aimNumbers(f, facts.weapons, tr, tick => roundOf(tick).num);
    // Raw counts per round ([round, stop, first, spray, hits, head, shots, ttd, xhair]), pooled by the renderer.
    const rounds = [...perRound].sort((a, b) => a[0] - b[0]).map(([num, x]) => [num, x.stop, x.first, x.spray, x.hits, x.head, x.shots, x.ttd, x.xhair]);
    const byClass = Object.fromEntries(Object.entries(counts.byClass).map(([k, x]) => [k, {
      shots: x.shots, accuracy: ratio(x.hits, x.shots), counterStrafe: ratio(x.stop[0], x.stop[1]), counterStrafeN: x.stop[1], firstBullet: ratio(x.first[0], x.first[1]), firstBulletN: x.first[1],
    }]));
    // Engagements lost while moving: first bullets at a visible enemy, too fast to be accurate, that missed.
    const moments = moving.map(m => ({ ...m, ...when(m.tick) }));
    const slow = f.eng.filter(e => e[5] === 2 && e[6] === 2).map(e => ({ tick: e[0], enemy: names[e[1]] || 'an enemy', err: e[2], dist: e[3], ...when(e[0]) }));
    return { steamid: id, name: names[id], team: team[id] || null, mine: id === mySteamId, ...finalNumbers(counts), byClass, rounds, moving: moments.slice(0, 40), caught: slow.slice(0, 40) };
  });
  players.sort((a, b) => (b.mine - a.mine) || (team[a.steamid] || '').localeCompare(team[b.steamid] || '') || a.name.localeCompare(b.name));
  // First round of each half after the first (sides switch): markers on the progression chart.
  const halves = core.rounds.filter((r, i) => i && sideOfA[r.num] !== sideOfA[core.rounds[i - 1].num]).map(r => r.num);
  return { players, tickrate: tr, myTeam: team[mySteamId] || null, lineOfSight: !!facts.los, roundNums: core.rounds.map(r => r.num), halves };
}

// Raw counts for the overview, so matches can be added up exactly.
function aimTotals(facts, steamid) {
  const f = facts.players[steamid];
  if (!f) return null;
  const { counts } = aimNumbers(f, facts.weapons, facts.tickrate || 64);
  return { stop: counts.stop, first: counts.first, spray: counts.spray, hits: counts.hits, head: counts.head, shots: counts.shots, ttd: counts.ttd, xhair: counts.xhair.map(v => Math.round(v * 10) / 10) };
}

module.exports = { AimCollector, AIM_VERSION, summarizeAim, aimTotals, accurateSpeed };
