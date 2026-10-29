// What happened in a training session, from the demo CS2 recorded while it ran (lib/training.js).
//
// Bots can't be read from these demos (the parser leaves bots of a local server without name or
// position), so the targets are where DemoLab put them: the drills' bots run a brain that never walks
// (lib/botBrains.js), so each rep's bots stay on the rep's spots. The reps are found in the demo by my
// own teleports: I land on a rep's start spot (rep.me). Only my position, view, shots, hits, kills and
// deaths come from the demo.
//
// Per target (a bot of a rep), once it comes into view (line of sight from the map mesh, inside my
// field of view):
//   xhair   crosshair distance to its head (°); pitch: how much of it is height (+ = aiming too low)
//   react   ms until my first shot, ttk: ms until I killed it
//   first   my first bullet after it came into view hit (2 = in the head)
// Per shot: speed (too fast to be accurate = moving), hit. Per death of mine: why (tags, as in
// lib/deaths.js). Without targets (procedural map, tracking's dodging bot, no mesh) only the
// shots, hits, kills and deaths are scored.
const parser = require('./parser');
const { accurateSpeed } = require('./aim');
const { wrap, deg } = require('./sight');

const PROPS = ['X', 'Y', 'Z', 'usercmd_viewangle_x', 'usercmd_viewangle_y', 'pitch', 'yaw', 'is_alive', 'ducking'];
const NOT_GUNS = /grenade|flashbang|molotov|incgrenade|inferno|decoy|knife|bayonet|c4|taser|world/;
const CAUGHT_DEG = 15;   // same as the death review
const LAND = 72;         // a landing this close to a rep's start spot is that rep
const BOT_EYE = 64, BOT_HEAD = 62;
const SMOKE_R = 130, SMOKE_MID = 60; // a smoke: a ball this wide, this high over its spot (scenarios)

const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null);

// file: the session's demo. me: my SteamID. geometry: the map's MapGeometry or null.
// parts: [{ drill, from, to, reps: [{ me, bots, smokes }] }] (from/to: seconds since the recording started,
// only used when no rep is found), or null (procedural map).
function analyzeSession(file, { me, geometry = null, parts = null } = {}) {
  const map = parser.parseHeader(file).map_name;
  const events = parser.parseEvents(file, ['player_death', 'player_hurt', 'weapon_fire', 'player_blind', 'weapon_reload'], [], []);
  const rows = parser.parseTicks(file, PROPS, null, null, true);
  const n = rows.tick.length;
  let t0 = Infinity, tEnd = 0;
  const pick = [];
  for (let i = 0; i < n; i++) {
    if (rows.steamid[i] !== me) continue;
    pick.push(i);
    if (rows.tick[i] < t0) t0 = rows.tick[i];
    if (rows.tick[i] > tEnd) tEnd = rows.tick[i];
  }
  if (!pick.length) throw new Error('You are not in the training demo.');
  const N = tEnd - t0 + 1, tr = 64;
  const X = new Float32Array(N).fill(NaN), Y = new Float32Array(N).fill(NaN), Z = new Float32Array(N).fill(NaN);
  const P = new Float32Array(N).fill(NaN), W = new Float32Array(N).fill(NaN), A = new Uint8Array(N), D = new Uint8Array(N);
  for (const i of pick) {
    const t = rows.tick[i] - t0;
    X[t] = rows.X[i]; Y[t] = rows.Y[i]; Z[t] = rows.Z[i];
    P[t] = rows.usercmd_viewangle_x[i] ?? rows.pitch[i]; W[t] = rows.usercmd_viewangle_y[i] ?? rows.yaw[i];
    A[t] = rows.is_alive[i] ? 1 : 0; D[t] = rows.ducking[i] ? 1 : 0;
  }
  const ok = t => t >= 0 && t < N && A[t] && !Number.isNaN(X[t]) && !Number.isNaN(W[t]);
  const speedAt = t => { const b = Math.min(4, t); return b && !Number.isNaN(X[t - b]) ? Math.hypot(X[t] - X[t - b], Y[t] - Y[t - b]) * tr / b : 0; };
  // Where a point (a bot's feet) is from my crosshair at tick t.
  const aimAt = (q, t) => {
    const ex = X[t], ey = Y[t], ez = Z[t] + (D[t] ? 46 : 64);
    const dx = q[0] - ex, dy = q[1] - ey, dz = q[2] + BOT_HEAD - ez;
    const dist = Math.hypot(dx, dy, dz);
    const yawTo = deg(Math.atan2(dy, dx)), pitchTo = -deg(Math.asin(dz / dist));
    const dyaw = wrap(yawTo - W[t]), dpitch = pitchTo - P[t];
    return { err: Math.hypot(dyaw * Math.cos(pitchTo * Math.PI / 180), dpitch), dyaw, dpitch, dist };
  };
  // the segment from A to B passes through the ball (c, r)
  const through = (ax, ay, az, bx, by, bz, c, r) => {
    const dx = bx - ax, dy = by - ay, dz = bz - az, l2 = dx * dx + dy * dy + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((c[0] - ax) * dx + (c[1] - ay) * dy + (c[2] + SMOKE_MID - az) * dz) / l2));
    return Math.hypot(ax + u * dx - c[0], ay + u * dy - c[1], az + u * dz - c[2] - SMOKE_MID) < r;
  };
  const seesAt = (q, t, h, smokes) => {
    const ez = Z[t] + (D[t] ? 46 : 64);
    return !geometry.blocked(X[t], Y[t], ez, q[0], q[1], q[2] + h) && !(smokes || []).some(c => through(X[t], Y[t], ez, q[0], q[1], q[2] + h, c, SMOKE_R));
  };
  const sees = (q, t, smokes) => seesAt(q, t, BOT_HEAD, smokes) || seesAt(q, t, 40, smokes);

  // ---- my events (bots' names come out empty: anything not me is a bot)
  const shots = [], hits = [], kills = [], deaths = [], blinds = [], reloads = [];
  for (const e of events) {
    const t = e.tick - t0;
    if (t < 0 || t >= N) continue;
    const mine = e.user_steamid === me, byMe = e.attacker_steamid === me;
    if (e.event_name === 'weapon_fire' && mine) { const w = (e.weapon || '').replace(/^weapon_/, ''); if (!NOT_GUNS.test(w)) shots.push({ t, w }); }
    else if (e.event_name === 'player_hurt' && byMe && !mine) hits.push({ t, head: e.hitgroup === 'head' });
    else if (e.event_name === 'player_death' && byMe && !mine) kills.push({ t, head: !!e.headshot });
    else if (e.event_name === 'player_death' && mine) deaths.push({ t, weapon: (e.weapon || '').replace(/^weapon_/, ''), head: !!e.headshot });
    else if (e.event_name === 'player_blind' && mine) blinds.push({ t, until: t + (e.blind_duration || 0) * tr });
    else if (e.event_name === 'weapon_reload' && mine) reloads.push(t);
  }
  const hitAt = new Map();
  for (const h of hits) hitAt.set(h.t, Math.max(hitAt.get(h.t) || 0, h.head ? 2 : 1));

  // ---- reps: every time I land on a rep's start spot, until the next landing
  const reps = [];
  (parts || []).forEach((p, k) => p.reps.forEach(r => reps.push({ ...r, part: k, drill: p.drill })));
  const segs = [];
  if (reps.length) {
    for (let t = 1; t < N; t++) {
      if (!ok(t) || Number.isNaN(X[t - 1]) || Math.hypot(X[t] - X[t - 1], Y[t] - Y[t - 1]) < 150) continue;
      const land = Math.min(N - 1, t + 2);
      let best = null, bd = LAND;
      for (const r of reps) {
        const d = Math.hypot(X[land] - r.me[0], Y[land] - r.me[1]);
        if (d < bd && Math.abs(Z[land] - r.me[2]) < 120) { bd = d; best = r; }
      }
      // any other jump (respawn, the smoke setup of a scenario) ends the rep too
      if (segs.length && segs.at(-1).to === N) segs.at(-1).to = t;
      if (!best) continue;
      segs.push({ from: t, to: N, rep: best, part: best.part, drill: best.drill });
    }
  }
  // the part a tick belongs to when no rep covers it (by the runner's clock)
  const partAt = t => {
    const s = segs.find(x => t >= x.from && t < x.to);
    if (s) return s.part;
    if (!parts) return null;
    const sec = t / tr;
    const k = parts.findIndex(p => sec >= p.from && sec < p.to);
    return k >= 0 ? k : null;
  };

  // ---- targets of each rep
  const engs = [];
  const deathInfo = new Map(); // death -> { eng }
  const withTargets = !!geometry;
  for (const s of segs) {
    if (!withTargets || s.drill === 'tracking') continue;
    const targets = s.rep.bots.map((pos, i) => ({ pos, i, dead: null, seen: null }));
    // my kills in this rep, each to the bot closest to my crosshair
    for (const k of kills) {
      if (k.t < s.from || k.t >= s.to || !ok(k.t)) continue;
      const alive = targets.filter(x => !x.dead);
      if (!alive.length) break;
      alive.sort((a, b) => aimAt(a.pos, k.t).err - aimAt(b.pos, k.t).err)[0].dead = k;
    }
    for (let t = s.from + 4; t < s.to; t += 2) {
      if (!ok(t)) continue;
      for (const x of targets) {
        if (x.seen || (x.dead && x.dead.t <= t)) continue;
        const e = aimAt(x.pos, t);
        if (Math.abs(e.dyaw) > 53 || Math.abs(e.dpitch) > 35 || !sees(x.pos, t, s.rep.smokes)) continue;
        x.seen = { t, ...e };
      }
    }
    for (const x of targets) {
      if (!x.seen) continue;
      const v = x.seen;
      const shot = shots.find(q => q.t >= v.t && q.t <= Math.min(s.to, v.t + 3 * tr));
      engs.push({
        t: v.t, part: s.part, target: `bot ${x.i + 1}`, xhair: r1(v.err), pitch: r1(v.dpitch), dist: Math.round(v.dist),
        react: shot ? Math.round((shot.t - v.t) / tr * 1000) : null,
        ttk: x.dead ? Math.round((x.dead.t - v.t) / tr * 1000) : null,
        first: shot ? hitAt.get(shot.t) || 0 : null,
        firstSpeed: shot ? Math.round(speedAt(shot.t)) : null, firstOk: shot ? speedAt(shot.t) <= accurateSpeed(shot.w, false) : null,
        pos: x.pos,
      });
    }
    // which bot killed me: the one in sight, closest to my crosshair
    for (const d of deaths) {
      if (d.t < s.from || d.t >= s.to) continue;
      const t = Math.max(s.from, d.t - 1);
      if (!ok(t)) continue;
      const cands = targets.filter(x => !(x.dead && x.dead.t < d.t) && sees(x.pos, t, s.rep.smokes));
      const killer = cands.sort((a, b) => aimAt(a.pos, t).err - aimAt(b.pos, t).err)[0];
      deathInfo.set(d, { eng: killer ? engs.find(e => e.pos === killer.pos && e.t <= d.t && e.part === s.part && e.t >= s.from) || null : null, unseen: !killer });
    }
  }

  function review(d) {
    const info = deathInfo.get(d);
    const tags = [];
    if (blinds.some(b => b.t <= d.t && d.t <= b.until)) tags.push('flashed');
    if (info?.unseen) tags.push('unseen');
    else if (info?.eng) {
      tags.push(info.eng.xhair >= CAUGHT_DEG ? 'caught' : 'outaimed');
      if (info.eng.react == null || info.eng.react > 600) tags.push('slow');
    }
    const last = [...shots].reverse().find(s => s.t <= d.t && d.t - s.t <= 2 * tr);
    if (last && speedAt(last.t) > accurateSpeed(last.w, false)) tags.push('moving');
    const myHits = hits.filter(h => h.t <= d.t && d.t - h.t <= 3 * tr);
    if (last && !myHits.length) tags.push('missed');
    if (reloads.some(t => t <= d.t && d.t - t <= 2.5 * tr)) tags.push('reloading');
    return { t: d.t, at: Math.round(d.t / tr), killer: info?.eng?.target || 'a bot', weapon: d.weapon, headshot: d.head, xhair: info?.eng?.xhair ?? null, react: info?.eng?.react ?? null, tags };
  }

  function summary(k) {
    const inP = t => k == null || partAt(t) === k;
    const sh = shots.filter(s => inP(s.t)), hi = hits.filter(h => inP(h.t)), ki = kills.filter(x => inP(x.t));
    const de = deaths.filter(x => inP(x.t)).map(review);
    const en = engs.filter(e => k == null || e.part === k);
    const hitTicks = new Set(hi.map(h => h.t)).size;
    let moving = 0;
    for (const s of sh) if (speedAt(s.t) > accurateSpeed(s.w, false)) moving++;
    const mySegs = segs.filter(s => k == null || s.part === k);
    let seconds = 0;
    if (k == null) seconds = Math.round(N / tr);
    else if (parts?.[k]) seconds = Math.round(parts[k].to - parts[k].from);
    return {
      drill: k == null ? null : parts[k].drill,
      kills: ki.length, deaths: de.length, hs: ki.filter(x => x.head).length,
      shots: sh.length, hits: hitTicks, headHits: hi.filter(h => h.head).length,
      accuracy: pct(Math.min(hitTicks, sh.length), sh.length), hsRate: pct(ki.filter(x => x.head).length, ki.length),
      targets: en.length,
      xhair: r1(median(en.map(e => e.xhair))), pitch: r1(median(en.map(e => Math.abs(e.pitch)))),
      react: median(en.filter(e => e.react != null).map(e => e.react)), ttk: median(en.filter(e => e.ttk != null).map(e => e.ttk)),
      firstHit: pct(en.filter(e => e.first).length, en.filter(e => e.first != null).length),
      firstOk: pct(en.filter(e => e.firstOk).length, en.filter(e => e.firstOk != null).length),
      moving: pct(moving, sh.length),
      // tracking: the dodging bot's spot isn't known, so how much of the spray hit it
      tracking: pct(Math.min(hitTicks, sh.length), sh.length), trackErr: null,
      duels: pct(ki.length, ki.length + de.length),
      reps: mySegs.length,
      engagements: en.slice(0, 400).map(({ pos, ...e }) => ({ ...e, at: Math.round(e.t / tr) })), deathList: de,
      seconds,
    };
  }

  return {
    map, seconds: Math.round(N / tr), measured: geometry ? 'mesh' : 'none', repsFound: segs.length,
    total: summary(null),
    segments: parts ? parts.map((_, k) => summary(k)) : null,
  };
}

// A score out of 100 per drill, from the summary's numbers (null when there's not enough to judge).
// Shown with the formula on the results, so it can be explained in one line.
const clamp = v => Math.max(0, Math.min(1, v));
const SCORES = {
  preaim: m => m.targets && 100 * (0.6 * clamp(1 - m.xhair / 25) + 0.25 * clamp(1 - ((m.ttk ?? 1500) - 200) / 1300) + 0.15 * (m.hsRate ?? 0) / 100),
  crosshair: m => m.targets && 100 * (0.45 * clamp(1 - m.xhair / 25) + 0.35 * clamp(1 - m.pitch / 8) + 0.2 * clamp(1 - ((m.ttk ?? 1500) - 200) / 1300)),
  peek: m => (m.kills + m.deaths) && 100 * (0.5 * (m.duels ?? 0) / 100 + 0.25 * (m.firstHit ?? 0) / 100 + 0.25 * (m.firstOk ?? 0) / 100),
  strafe: m => m.shots && 100 * (0.7 * (1 - (m.moving ?? 100) / 100) + 0.3 * (m.accuracy ?? 0) / 100),
  tracking: m => m.shots && 100 * (0.6 * (m.accuracy ?? 0) / 100 + 0.4 * clamp((m.headHits || 0) / Math.max(1, m.hits))),
  scenario: m => (m.kills + m.deaths) && 100 * (m.targets
    ? 0.4 * (m.duels ?? 0) / 100 + 0.35 * clamp(1 - m.xhair / 25) + 0.25 * clamp(1 - ((m.ttk ?? 1500) - 200) / 1300)
    : (m.duels ?? 0) / 100),
  procedural: m => m.shots && 100 * (0.4 * (m.duels ?? 0) / 100 + 0.3 * (m.accuracy ?? 0) / 100 + 0.3 * (m.hsRate ?? 0) / 100),
  warmup: m => m.shots && 100 * (0.5 * (m.accuracy ?? 0) / 100 + 0.5 * (m.hsRate ?? 0) / 100),
};
const SCORE_HOW = {
  preaim: '60% crosshair distance when the bot came into view (0° = full, 25°+ = none), 25% time to kill, 15% headshots',
  crosshair: '45% crosshair distance when a bot came into view, 35% height error, 20% time to kill',
  peek: '50% duels won, 25% first bullet hit, 25% first bullet fired standing still',
  strafe: '70% shots fired standing still, 30% accuracy',
  tracking: '60% of your bullets on the bot, 40% of those in the head',
  scenario: '40% duels won, 35% crosshair distance when a bot came into view (0° = full, 25°+ = none), 25% time to kill',
  procedural: '40% duels won, 30% accuracy, 30% headshot kills',
  warmup: '50% accuracy, 50% headshot kills',
};
function scoreOf(drill, m) {
  const f = SCORES[drill];
  const v = f && m ? f(m) : null;
  return v || v === 0 ? Math.round(v) : null;
}

module.exports = { analyzeSession, scoreOf, SCORE_HOW };