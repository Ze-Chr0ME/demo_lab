// Aim and game-sense anomalies per player, the raw material of the Integrity tab. Built in a worker
// the first time a match's Integrity tab is opened (one extra pass over every tick of the demo,
// about 6 seconds for a 5v5 match), then read from <id>.integrity.json.
//
// What a demo tells us, per player and tick: the view angles the client sent, the mouse movement of
// the last input frame of that tick (already multiplied by the player's sensitivity: one unit turns
// the view 0.022°), position, footsteps and shots, and which enemies the game shows on their radar
// (approximate_spotted_by). Who could actually see whom comes from the map's collision mesh
// (geometry.js); without a mesh the radar spotting stands in for it, which lags during quick peeks.
//
// From that, only facts are stored here (moments with what happened and counters); how suspicious
// they are is decided by scoreIntegrity() at read time, so thresholds can change without reading the
// demo again. Nothing here proves cheating: these are moments worth watching.
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const parser = require('./parser');
const { AimCollector } = require('./aim');
const { ALIVE, CT, T, FORCED, SCOPED, DUCK, NOCMD, AIR, VIS_STEP, BODY, wrap, tickArrays, tickView, castRays, spot, startSight } = require('./sight');

const INTEGRITY_VERSION = 2;
const SPOT_MEMORY = 128;      // an enemy the team saw (or had on the radar) in the last 2 s counts as known
const HIDDEN_STEP = 4;        // crosshair-on-hidden-enemy sampling, every 4 ticks
const MAX_DIST = 3000;        // ignore enemies further away than this
const SNAP_MIN = 8;           // degrees the view turns within 2 ticks to count as a snap
const STEP_RANGE = 1300;      // footsteps tell where an enemy is within this distance…
const SHOT_RANGE = 2500;      // …gunshots within this one
const LIST_MAX = 60;          // moments kept per kind and player
const NOT_GUNS = /grenade|flashbang|molotov|incgrenade|inferno|decoy|knife|bayonet|c4|taser|world/;
// Player flags, line of sight and the per player, per tick arrays are in sight.js.
const PROPS = ['X', 'Y', 'Z', 'usercmd_viewangle_x', 'usercmd_viewangle_y', 'usercmd_mouse_dx', 'usercmd_mouse_dy', 'is_alive', 'team_num', 'ducking',
  'usercmd_consumed_server_angle_changes', 'approximate_spotted_by', 'is_scoped', 'is_airborne'];
const SPLIT_MIN = 20000; // live ticks from which reading them with several parsers at once pays off
const SPLIT_MAX = 4;     // parsers at once; more don't read faster (1: 12.9 s, 2: 7.6 s, 4: 5.7 s, 6: 5.8 s on a 5v5 match)

const r1 = v => Math.round(v * 10) / 10;

// geometry: a MapGeometry for core.map, or null to fall back on radar spotting. lowEnd: one parser
// and no line-of-sight pool (the "Low-end PC" setting): slower, but about half the memory and threads.
function extractIntegrity(file, core, opts = {}) {
  const threads = [];
  try {
    return measure(file, core, opts, threads);
  } finally {
    for (const w of threads) w.close();
  }
}

// threads: every helper thread started here, stopped once done (or failed).
function measure(file, core, { geometry = null, lowEnd = false, onProgress = () => {} }, threads) {
  const tr = core.tickrate || 64;
  const rounds = core.rounds.filter(r => r.endTick > r.freezeEndTick);
  if (!rounds.length) throw new Error('No rounds in this demo');
  const maxTick = Math.max(...rounds.map(r => r.endTick)) + 1;
  const live = new Uint8Array(maxTick);
  const liveTicks = [];
  for (const r of rounds) for (let t = r.freezeEndTick; t <= r.endTick; t++) if (!live[t]) { live[t] = 1; liveTicks.push(t); }
  liveTicks.sort((a, b) => a - b);

  // ---- per player, per tick arrays
  const ids = core.players.map(p => p.steamid);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const N = ids.length;
  if (N > 32) throw new Error('Too many players for the integrity check');
  const { P, buffers } = tickArrays(N, maxTick);
  onProgress(0.02);
  // Long matches are read in up to SPLIT_MAX parts by helper threads at once (each parser only decodes
  // what the ticks it is asked for need, so 4 parts take less than half the time of one whole) while
  // this thread reads the events. Line of sight is worked out by a pool of threads as soon as each part
  // is in (sight.js).
  const parts = splitTicks(liveTicks.length, lowEnd ? 1 : SPLIT_MAX);
  const ready = new Int32Array(new SharedArrayBuffer(4 * parts.length)); // per part: 0 reading, 1 done, 2 failed
  let sight = geometry && !lowEnd ? startSight({ geometry, P, buffers, N, maxTick, ticks: liveTicks, parts, ready }) : null;
  if (sight) threads.push(sight);
  const helpers = parts.length > 1 ? parts.map(([a, b], k) => startTickHelper(file, ids, liveTicks.slice(a, b), maxTick, buffers, ready, k)) : [];
  for (const h of helpers) if (h) threads.push(h);

  // ---- events: shots and footsteps (what an enemy gives away by sound), hits and kills
  const events = parser.parseEvents(file, ['weapon_fire', 'player_footstep', 'player_hurt', 'player_death'], [], []).filter(e => e.tick < maxTick);
  parts.forEach(([a, b], k) => {
    if (helpers[k]?.join()) return;
    readTicks(file, ids, liveTicks.slice(a, b), P);
    Atomics.store(ready, k, 1);
    Atomics.notify(ready, k);
  });
  onProgress(0.7);
  const fired = ids.map(() => new Uint8Array(maxTick));
  const stepped = ids.map(() => new Uint8Array(maxTick));
  const shotTicks = ids.map(() => []);
  const damageAt = new Map(); // tick -> hurt/death events
  for (const e of events) {
    if (e.event_name === 'player_footstep') { const q = idx.get(e.user_steamid); if (q !== undefined) stepped[q][e.tick] = 1; continue; }
    if (e.event_name === 'weapon_fire') {
      const p = idx.get(e.user_steamid);
      if (p === undefined || NOT_GUNS.test(e.weapon || '')) continue;
      fired[p][e.tick] = 1;
      shotTicks[p].push(e.tick);
      continue;
    }
    if (!damageAt.has(e.tick)) damageAt.set(e.tick, []);
    damageAt.get(e.tick).push(e);
  }

  const view = tickView(P);
  const { alive, side, enemies, hasCmd, aim } = view;

  // Can p see any part of q (walls only: smokes, doors and view direction are not considered)?
  // Cached per tick; without map geometry the radar spotting decides. During the pass, the answers
  // at check ticks come from the sight pool.
  const losCache = new Int8Array(N * N);
  const wallHint = new Int32Array(N * N * BODY.length).fill(-1); // per ray (eye of p, a body point of q): the triangle that last blocked it
  let losTick = -1;
  function los(p, q, t) {
    if (!geometry) return ((P[q].spottedBy[t] >>> p) & 1) === 1;
    if (losTick !== t) { losCache.fill(-1); losTick = t; }
    const k = p * N + q;
    if (losCache[k] >= 0) return losCache[k] === 1;
    let v = sight && t % VIS_STEP === 0 ? sight.get(p, q, t) : -1;
    if (v < 0) v = castRays(geometry, P, N, p, q, t, wallHint);
    losCache[k] = v;
    losCache[q * N + p] = v; // eye-to-body is close enough to symmetric for "could they see each other"
    return v === 1;
  }

  // Aim mechanics (aim.js) are collected in the same pass.
  const aimc = new AimCollector({ ids, P, tr, los, F: { ALIVE, CT, T, SCOPED, DUCK, AIR, NOCMD } });

  // ---- how much angle the recorded mouse usually accounts for, per player. The demo only keeps the
  // mouse movement of a tick's last input frame, so players with many frames per tick turn more
  // than their recorded mouse; this ratio scales the recorded mouse back up.
  const ratio = ids.map((_, p) => {
    const a = P[p], rs = [];
    for (const t of liveTicks) {
      const f = a.flags[t], g = a.flags[t - 1];
      if (!(f & ALIVE) || !(g & ALIVE) || (f & (FORCED | SCOPED | NOCMD)) || (g & NOCMD) || a.mouse[t] < 20) continue;
      rs.push(Math.hypot(wrap(a.yaw[t] - a.yaw[t - 1]), a.pitch[t] - a.pitch[t - 1]) / (a.mouse[t] * 0.022));
    }
    rs.sort((x, y) => x - y);
    return Math.max(1, rs[Math.floor(rs.length * 0.9)] || 2);
  });

  const out = ids.map(() => ({
    aliveTicks: 0,
    snaps: { big: 0, list: [] },               // view turned >= SNAP_MIN° in 2 ticks with (almost) no mouse movement
    hidden: { samples: 0, on: 0, tracks: [] }, // crosshair on enemies behind walls whom the team knows nothing about and who are silent
    contact: { n: 0, on: 0, list: [] },        // such an enemy comes into view: was the crosshair already on them?
    wallHits: [],                              // hits through walls on such enemies
    kills: 0, hs: 0, hits: 0,
  }));

  // ---- one pass over the live ticks
  const lastSeen = ids.map(() => ({ [CT]: -1e9, [T]: -1e9 })); // enemy q -> last tick each team knew where they were
  const lastShot = new Array(N).fill(-1e9), lastStep = new Array(N).fill(-1e9);
  const tracks = ids.map(() => new Map());                // p -> q -> open tracking segment
  const wasVisible = ids.map(() => new Uint8Array(N));     // p -> q -> line of sight at the previous check
  const total = liveTicks.length;
  const audible = (q, t, dist) => (t - lastStep[q] < tr && dist < STEP_RANGE) || (t - lastShot[q] < tr && dist < SHOT_RANGE);

  for (let li = 0; li < total; li++) {
    const t = liveTicks[li];
    if (li % 10000 === 0) onProgress(0.7 + 0.3 * li / total);
    const contiguous = li > 0 && liveTicks[li - 1] === t - 1;
    for (let q = 0; q < N; q++) { if (fired[q][t]) lastShot[q] = t; if (stepped[q][t]) lastStep[q] = t; }
    const check = t % VIS_STEP === 0;

    // What each team knew about each enemy before this tick, then what they learn now: an enemy on
    // their radar, or in sight of (and in front of) someone on the team.
    const knownBefore = check || damageAt.has(t) ? ids.map((_, q) => ({ [CT]: lastSeen[q][CT], [T]: lastSeen[q][T] })) : null;
    if (check) spot(view, P, N, t, los, (q, team) => { lastSeen[q][team] = t; });

    for (let p = 0; p < N; p++) {
      const a = P[p], o = out[p];
      if (!alive(p, t) || !hasCmd(p, t)) { tracks[p].clear(); wasVisible[p].fill(0); continue; }
      o.aliveTicks++;
      const team = side(p, t);

      // 1. Snaps without mouse movement: the view turns a lot within two ticks, but the recorded mouse
      // in the surrounding ticks can't account for even a quarter of it.
      if (contiguous && t + 2 < maxTick) {
        let ok = true;
        for (let k = -3; k <= 2 && ok; k++) { const f = a.flags[t + k]; ok = live[t + k] && (f & ALIVE) && !(f & (FORCED | NOCMD)); }
        if (ok) {
          const mag = Math.hypot(wrap(a.yaw[t + 1] - a.yaw[t - 1]), a.pitch[t + 1] - a.pitch[t - 1]);
          if (mag >= SNAP_MIN) {
            o.snaps.big++;
            let m = 0;
            for (let k = -3; k <= 2; k++) m += a.mouse[t + k];
            const explained = m * 0.022 * ratio[p] * 1.5;
            const prev = o.snaps.list.at(-1);
            if (explained < 0.25 * mag && !(prev && t - prev.tick <= 4)) {
              let best = null;
              for (let q = 0; q < N; q++) if (alive(q, t + 1) && enemies(p, q, t + 1)) {
                const e = aim(p, q, t + 1);
                if (e.dist <= MAX_DIST && (!best || e.err < best.err)) best = { ...e, q };
              }
              const onEnemy = best && best.err < best.thr;
              const shot = shotTicks[p].find(s => s >= t - 1 && s <= t + 8);
              if (o.snaps.list.length < LIST_MAX * 2) o.snaps.list.push({
                tick: t, deg: r1(mag), mouse: r1(m * 0.022 * ratio[p]),
                target: onEnemy ? ids[best.q] : null, err: onEnemy ? r1(best.err) : null,
                shot: shot != null, scoped: !!(a.flags[t] & SCOPED),
              });
            }
          }
        }
      }

      if (!check) continue;
      for (let q = 0; q < N; q++) {
        if (!alive(q, t) || !enemies(p, q, t)) { tracks[p].delete(q); wasVisible[p][q] = 0; continue; }
        const visible = los(p, q, t);
        aimc.sight(p, q, t, visible);
        const appeared = visible && !wasVisible[p][q];
        wasVisible[p][q] = visible ? 1 : 0;
        const unknown = t - knownBefore[q][team] > SPOT_MEMORY;

        // 2. An enemy the team knew nothing about comes into view: was the crosshair already on them?
        if (appeared && unknown && contiguous) {
          const e = aim(p, q, t);
          if (e.dist <= MAX_DIST && !audible(q, t, e.dist)) {
            o.contact.n++;
            if (e.err < e.thr) {
              o.contact.on++;
              if (o.contact.list.length < LIST_MAX) o.contact.list.push({ tick: t, target: ids[q], err: r1(e.err), dist: Math.round(e.dist) });
            }
          }
        }

        // 3. Crosshair on enemies behind walls whom the team knows nothing about and who make no noise.
        if (t % HIDDEN_STEP) continue;
        const e = visible || !unknown ? null : aim(p, q, t);
        const hidden = e && e.dist <= MAX_DIST && !audible(q, t, e.dist);
        const tk = tracks[p].get(q);
        if (!hidden) {
          if (tk) closeTrack(o, tk, ids[q]);
          tracks[p].delete(q);
          continue;
        }
        o.hidden.samples++;
        if (e.err < e.thr) {
          o.hidden.on++;
          if (!tk) tracks[p].set(q, { start: t, end: t, sweep: 0, yaw: e.yawTo, pitch: e.pitchTo, n: 1, dist: e.dist });
          else { tk.sweep += Math.hypot(wrap(e.yawTo - tk.yaw), e.pitchTo - tk.pitch); tk.yaw = e.yawTo; tk.pitch = e.pitchTo; tk.end = t; tk.n++; }
        } else if (tk) { closeTrack(o, tk, ids[q]); tracks[p].delete(q); }
      }
    }

    // 4. Hits and kills; hits through a wall on an enemy the team knew nothing about and who was silent.
    for (const e of damageAt.get(t) || []) {
      const p = idx.get(e.attacker_steamid), q = idx.get(e.user_steamid);
      if (p === undefined || q === undefined || !live[t] || !enemies(p, q, t) || NOT_GUNS.test(e.weapon || '')) continue;
      const o = out[p];
      if (e.event_name === 'player_death') { o.kills++; if (e.headshot) o.hs++; continue; }
      o.hits++;
      if (!geometry || !alive(p, t)) continue;
      const dist = Math.hypot(P[q].x[t] - P[p].x[t], P[q].y[t] - P[p].y[t]);
      if (los(p, q, t) || t - knownBefore[q][side(p, t)] <= SPOT_MEMORY || audible(q, t, dist)) continue;
      if (o.wallHits.length < LIST_MAX) o.wallHits.push({ tick: t, target: ids[q], weapon: e.weapon, dmg: e.dmg_health, hit: e.hitgroup, dist: Math.round(dist) });
    }
  }

  // The pool's answers were for the pass; aim.js casts its own rays.
  if (sight) { sight.close(); sight = null; }

  const players = {};
  ids.forEach((id, p) => { players[id] = { ratio: r1(ratio[p]), ...out[p] }; });
  const aimFacts = { ...aimc.finish(events, maxTick), los: !!geometry };
  return { version: INTEGRITY_VERSION, tickrate: tr, liveTicks: total, los: !!geometry, players, aim: aimFacts };
}

// [from, to) index ranges of the live ticks, one per parser: up to max, at most one per two cores.
function splitTicks(n, max) {
  const k = n >= SPLIT_MIN ? Math.max(1, Math.min(max, os.availableParallelism() >> 1)) : 1;
  return Array.from({ length: k }, (_, i) => [Math.floor(n * i / k), Math.floor(n * (i + 1) / k)]);
}

// Reads the given ticks into P. One call, as columns: no JS object per row (3× faster than chunks of rows).
function readTicks(file, ids, ticks, P) {
  const idx = new Map(ids.map((id, i) => [id, i]));
  const c = parser.parseTicks(file, PROPS, ticks, null, true);
  for (let i = 0, rows = c.tick.length; i < rows; i++) {
    const p = idx.get(c.steamid[i]);
    if (p === undefined) continue;
    const a = P[p], t = c.tick[i], yaw = c.usercmd_viewangle_y[i];
    a.x[t] = c.X[i]; a.y[t] = c.Y[i]; a.z[t] = c.Z[i];
    if (yaw != null) { a.pitch[t] = c.usercmd_viewangle_x[i]; a.yaw[t] = yaw; }
    a.mouse[t] = Math.hypot(c.usercmd_mouse_dx[i] || 0, c.usercmd_mouse_dy[i] || 0);
    a.flags[t] = (c.is_alive[i] ? ALIVE : 0) | (c.team_num[i] === 3 ? CT : c.team_num[i] === 2 ? T : 0) | (c.usercmd_consumed_server_angle_changes[i] ? FORCED : 0)
      | (c.is_scoped[i] ? SCOPED : 0) | (c.ducking[i] ? DUCK : 0) | (yaw == null ? NOCMD : 0) | (c.is_airborne[i] ? AIR : 0);
    let m = 0;
    for (const s of c.approximate_spotted_by[i] || []) { const q = idx.get(s); if (q !== undefined) m |= 1 << q; }
    a.spottedBy[t] = m >>> 0;
  }
}

// A thread that reads some ticks into the shared arrays (parseWorker.js, mode 'ticks') and sets
// ready[k] when done: 1 worked, 2 failed. join() blocks until then and says whether it worked; if not,
// the caller reads those ticks itself. The ticks of the threads never overlap, so they write to
// different places of the arrays.
function startTickHelper(file, ids, ticks, maxTick, buffers, ready, k) {
  let w;
  try {
    w = new Worker(path.join(__dirname, 'parseWorker.js'), { workerData: { mode: 'ticks', file, ids, ticks, maxTick, buffers, ready: ready.buffer, k } });
    w.unref();
    w.on('error', () => {});
  } catch { return null; }
  return {
    join() {
      // The event loop is blocked meanwhile, so the helper reports through the flag, never by message.
      while (Atomics.load(ready, k) === 0) if (Atomics.wait(ready, k, 0, 10 * 60000) === 'timed-out') break;
      const ok = Atomics.load(ready, k) === 1;
      if (!ok) w.terminate();
      return ok;
    },
    close() { w.terminate(); },
  };
}

// parseWorker.js, mode 'ticks': the helper's side.
function tickHelper({ file, ids, ticks, maxTick, buffers, ready, k }) {
  const f = new Int32Array(ready);
  try {
    readTicks(file, ids, ticks, tickArrays(ids.length, maxTick, buffers).P);
    Atomics.store(f, k, 1);
  } catch {
    Atomics.store(f, k, 2);
  }
  Atomics.notify(f, k);
}

function closeTrack(o, tk, target) {
  // Followed for at least half a second while the enemy moved across at least 10° of the view.
  if (tk.n >= 8 && tk.sweep >= 10 && o.hidden.tracks.length < LIST_MAX) {
    o.hidden.tracks.push({ tick: tk.start, end: tk.end, target, sweep: Math.round(tk.sweep) });
  }
}

// ---------- Scoring (at read time, from the stored facts) ----------
// Thresholds from 532 player-matches in 61 Premier, matchmaking and Rush demos: "unusual" is past
// what about 1 in 100 players reached, "very" past (nearly) all of them. Rates that depend a lot on
// the map (small Rush rooms put everyone close to enemies) are compared with the rest of the lobby.
// "Unknown" enemy below: behind a wall, not seen by anyone on the team and not on the radar for 2 s,
// and silent (no footsteps or shots within earshot).
const SIGNALS = [
  {
    key: 'snaps', label: 'No-mouse aim',
    tip: 'The view snapped onto an enemy (8°+ within two ticks) while the mouse barely moved, and the player fired right after. A hand on a mouse cannot do this; aim assistance writing the view angles directly can.',
    value: p => p.snaps.list.filter(s => s.target && s.shot).length,
    show: v => String(v), normal: '0', unusual: 1, very: 2,
  },
  {
    key: 'tracking', label: 'Tracked through walls',
    tip: 'Times the crosshair stayed on an unknown enemy behind a wall for at least half a second while following them across 10°+ (at 3°/s or faster).',
    value: (p, tr) => p.hidden.tracks.filter(t => isTracking(t, tr)).length,
    show: v => String(v), normal: '0 – 3', unusual: 4, very: 6,
  },
  {
    key: 'hiddenAim', label: 'Aim behind walls',
    tip: 'How often the crosshair was on an unknown enemy behind a wall within 3000 units, compared with the rest of the lobby. Holding common angles gives everyone some; seeing through walls gives more.',
    value: (p, tr, lobby) => { const v = rate(p.hidden); return v == null || lobby.hidden == null ? null : v / Math.max(0.3, lobby.hidden); },
    show: (v, p) => `${rate(p.hidden).toFixed(1)}% · ${v.toFixed(1)}×`, normal: 'up to 2.5× the lobby', unusual: 2.6, very: 3.2,
  },
  {
    key: 'contact', label: 'Pre-aimed appearances',
    tip: 'Share of the times an unknown enemy came into view that the crosshair was already on them, compared with the rest of the lobby. Good crosshair placement gives some; knowing where they are gives more.',
    value: (p, tr, lobby) => { const v = rate(p.contact, 20); return v == null || lobby.contact == null ? null : v / Math.max(5, lobby.contact); },
    show: (v, p) => `${Math.round(rate(p.contact, 20))}% · ${v.toFixed(1)}×`, normal: 'up to 2.7× the lobby', unusual: 3, very: 4,
  },
  {
    key: 'wallHits', label: 'Wall hits',
    tip: 'Hits on unknown enemies through a wall: nobody on the team could see them, they were not on the radar and made no noise.',
    value: p => p.wallHits.length,
    show: v => String(v), normal: '0 – 4', unusual: 6, very: 9,
  },
];

const LEVELS = ['normal', 'unusual', 'very'];
// Percent of samples, once there are enough of them.
const rate = (x, min = 200) => (x.n ?? x.samples) >= min ? 100 * x.on / (x.n ?? x.samples) : null;
const median = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

// Slow drifts (an enemy walking roughly along the line of a held angle) are not following anyone.
const isTracking = (t, tr) => t.sweep / Math.max(0.5, (t.end - t.tick) / tr) >= 3;

function roundAt(rounds, tick) {
  for (let i = rounds.length - 1; i >= 0; i--) if (tick >= rounds[i].startTick) return rounds[i];
  return rounds[0];
}

function scoreIntegrity(facts, core, mySteamId) {
  const { assignTeams } = require('./stats');
  const { weaponName } = require('./highlights');
  const tr = facts.tickrate || 64;
  const names = Object.fromEntries(core.players.map(p => [p.steamid, p.name]));
  const { team } = assignTeams(core.rounds);
  const when = tick => {
    const r = roundAt(core.rounds, tick);
    return { round: r.num, clock: Math.max(0, Math.round((tick - r.freezeEndTick) / tr)) };
  };
  const name = id => names[id] || 'an enemy';

  const entries = Object.entries(facts.players).filter(([id, p]) => names[id] && p.aliveTicks > 0);
  // Lobby reference: the other players who were alive for at least 4 minutes.
  const regulars = entries.filter(([, p]) => p.aliveTicks >= 4 * 60 * tr);
  const players = entries.map(([id, p]) => {
    const others = regulars.filter(([o]) => o !== id).map(([, o]) => o);
    const lobby = { hidden: median(others.map(o => rate(o.hidden))), contact: median(others.map(o => rate(o.contact, 20))) };
    const signals = SIGNALS.map(s => {
      const v = s.value(p, tr, lobby);
      const level = v == null ? 0 : v >= s.very ? 2 : v >= s.unusual ? 1 : 0;
      return { key: s.key, label: s.label, tip: s.tip, normal: s.normal, value: v, display: v == null ? '—' : s.show(v, p), level: LEVELS[level], rank: level };
    });
    // Overall: one "very" signal, or two "unusual" ones, makes the player very unusual.
    const points = signals.reduce((n, s) => n + (s.rank === 2 ? 3 : s.rank), 0);
    const level = points >= 3 ? 'very' : points >= 1 ? 'unusual' : 'normal';

    const moments = [];
    for (const s of p.snaps.list) {
      if (!s.target) continue;
      moments.push({
        kind: 'snap', tick: s.tick, ...when(s.tick), target: s.target, targetName: name(s.target), strong: s.shot, minor: !s.shot,
        text: `Snapped ${s.deg}° onto ${name(s.target)} with about ${s.mouse}° of mouse movement${s.shot ? ', then fired' : ''}${s.scoped ? ' · scoped' : ''}`,
      });
    }
    for (const t of p.hidden.tracks.filter(x => isTracking(x, tr))) moments.push({
      kind: 'track', tick: t.tick, end: t.end, ...when(t.tick), target: t.target, targetName: name(t.target), strong: false,
      text: `Followed ${name(t.target)} across ${t.sweep}° for ${((t.end - t.tick) / tr).toFixed(1)} s through a wall, while nobody on the team knew where they were`,
    });
    for (const h of p.wallHits) moments.push({
      kind: 'wallhit', tick: h.tick, ...when(h.tick), target: h.target, targetName: name(h.target), strong: false,
      text: `Hit ${name(h.target)} through a wall with the ${weaponName((h.weapon || '').replace(/^weapon_/, ''))} (${h.dmg} damage${h.hit ? `, ${h.hit.replace(/_/g, ' ')}` : ''}) while nobody on the team knew where they were`,
    });
    for (const c of p.contact.list) moments.push({
      kind: 'contact', tick: c.tick, ...when(c.tick), target: c.target, targetName: name(c.target), strong: false, minor: true,
      text: `Crosshair was already on ${name(c.target)} (${c.err}° off, ${c.dist} units away) the moment they came into view`,
    });
    moments.sort((a, b) => a.tick - b.tick);

    return {
      steamid: id, name: names[id], team: team[id] || null, mine: id === mySteamId,
      level, points, signals, moments,
      context: {
        kills: p.kills, hsPct: p.kills ? Math.round(100 * p.hs / p.kills) : 0, aliveMinutes: Math.round(p.aliveTicks / tr / 60),
        mouselessOther: p.snaps.list.filter(s => !s.target || !s.shot).length,
      },
    };
  });
  players.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  return { players, tickrate: tr, myTeam: team[mySteamId] || null, lineOfSight: !!facts.los };
}

module.exports = { extractIntegrity, scoreIntegrity, tickHelper, INTEGRITY_VERSION };
