// Line of sight between players for the integrity tick pass (integrity.js), worked out ahead of it by
// a pool of worker threads. The pass asks "can p see q?" for every alive enemy pair every VIS_STEP
// ticks, about 4 million rays per 5v5 match: one thread takes ~2.5 s for them, the pool a fraction.
//
// Each worker takes a chunk of consecutive check ticks (so the per-ray "last blocking triangle" hints
// still work, see geometry.js) as soon as the tick reader that fills those ticks is done, asks exactly
// the questions the pass will ask at those ticks, in the same order, and stores the answers in a shared
// table: per check tick and viewer, a bit "answered" and a bit "visible" per target. The pass reads the
// table instead of casting the rays; anything not in it (damage ticks, a failed worker) is cast by the
// pass itself. Order matters because the pass caches each answer for both directions of a pair.
const os = require('os');
const { Worker, isMainThread, workerData } = require('worker_threads');
const { MapGeometry } = require('./geometry');

// flags: 1 alive, 2 CT, 4 T, 8 server set the view angles, 16 scoped, 32 crouching, 64 no usercmd, 128 in the air
const ALIVE = 1, CT = 2, T = 4, FORCED = 8, SCOPED = 16, DUCK = 32, NOCMD = 64, AIR = 128;
const VIS_STEP = 2;           // line of sight is checked every 2 ticks
const FOV = 55;               // degrees from the crosshair a player notices an enemy within (106° wide view)
// Points on the target checked for line of sight: [sideways offset × 14 units, height]
const BODY = [[0, 62], [0, 45], [0, 20], [1, 50], [-1, 50]];
// Per player, per tick arrays, in shared memory so helper threads can fill and read them.
const LAYOUT = [['x', Float32Array, NaN], ['y', Float32Array, NaN], ['z', Float32Array, NaN], ['pitch', Float32Array, NaN], ['yaw', Float32Array, NaN],
  ['mouse', Float32Array, 0], ['flags', Uint8Array, 0], ['spottedBy', Uint32Array, 0]];
const CHUNK = 1024;           // check ticks per piece of work (about 30 s of a round)

const wrap = d => ((d + 540) % 360) - 180;
const deg = r => r * 180 / Math.PI;

function tickArrays(N, maxTick, shared = null) {
  const buffers = shared || Array.from({ length: N }, () => LAYOUT.map(([, Type]) => new SharedArrayBuffer(Type.BYTES_PER_ELEMENT * maxTick)));
  const P = buffers.map(b => Object.fromEntries(LAYOUT.map(([k, Type, fill], i) => {
    const a = new Type(b[i]);
    if (!shared && fill !== 0) a.fill(fill);
    return [k, a];
  })));
  return { P, buffers };
}

// Questions about the per player, per tick arrays P (see integrity.js).
function tickView(P) {
  const alive = (p, t) => P[p].flags[t] & ALIVE;
  const side = (p, t) => P[p].flags[t] & (CT | T);
  const enemies = (p, q, t) => q !== p && side(q, t) && side(p, t) && side(q, t) !== side(p, t);
  const hasCmd = (p, t) => !(P[p].flags[t] & NOCMD) && !Number.isNaN(P[p].yaw[t]);
  const eye = (a, t) => a.z[t] + (a.flags[t] & DUCK ? 46 : 64);
  // Angular distance from p's crosshair to q's upper body, and where q is as seen from p.
  function aim(p, q, t) {
    const a = P[p], b = P[q];
    const dx = b.x[t] - a.x[t], dy = b.y[t] - a.y[t], dz = b.z[t] + (b.flags[t] & DUCK ? 38 : 50) - eye(a, t);
    const dist = Math.hypot(dx, dy, dz);
    const yawTo = deg(Math.atan2(dy, dx)), pitchTo = -deg(Math.asin(dz / dist));
    const err = Math.hypot(wrap(yawTo - a.yaw[t]) * Math.cos(pitchTo * Math.PI / 180), pitchTo - a.pitch[t]);
    // "On" the enemy: within their silhouette (about 40 units wide), and never stricter than 2.5°.
    return { err, dist, yawTo, pitchTo, thr: Math.max(2.5, 1.5 * deg(Math.atan2(20, dist))) };
  }
  return { alive, side, enemies, hasCmd, eye, aim };
}

// Can p see any part of q at tick t (walls only: smokes, doors and view direction are not considered)?
// hints: per ray (eye of p, a body point of q) the triangle that last blocked it, N × N × BODY slots.
function castRays(geometry, P, N, p, q, t, hints) {
  const a = P[p], b = P[q], k = p * N + q;
  const ex = a.x[t], ey = a.y[t], ez = a.z[t] + (a.flags[t] & DUCK ? 46 : 64);
  const dx = b.x[t] - ex, dy = b.y[t] - ey, L = Math.hypot(dx, dy) || 1, sx = -dy / L * 14, sy = dx / L * 14;
  const h = b.flags[t] & DUCK ? 0.75 : 1;
  for (let j = 0; j < BODY.length; j++) {
    const [s, z] = BODY[j];
    if (!geometry.blocked(ex, ey, ez, b.x[t] + s * sx, b.y[t] + s * sy, b.z[t] + z * h, hints, k * BODY.length + j)) return 1;
  }
  return 0;
}

// Who on each team sees (or has on the radar) each enemy at check tick t, in the order the tick pass
// asks: mark(q, team) for each enemy q a team learns about. Line of sight is only asked for enemies in
// front of a player with a usercmd, once per team and enemy.
function spot(view, P, N, t, los, mark) {
  const { alive, side, enemies, hasCmd, aim } = view;
  for (let q = 0; q < N; q++) {
    if (!alive(q, t)) continue;
    const m = P[q].spottedBy[t];
    let known = 0; // teams that already learnt about q at this tick
    for (let p = 0; p < N; p++) {
      if (!alive(p, t) || !enemies(p, q, t)) continue;
      const team = side(p, t);
      if (known & team) continue;
      if ((m >>> p) & 1 || (hasCmd(p, t) && aim(p, q, t).err < FOV && los(p, q, t))) { known |= team; mark(q, team); }
    }
  }
}

// Starts the pool. ticks: the live ticks in order; parts: [from, to) index ranges of ticks, each
// filled by one reader that sets ready[part] to 1 when done. Returns { get(p, q, t), close() }, or
// null when no worker could be started.
function startSight({ geometry, P, buffers, N, maxTick, ticks, parts, ready }) {
  const checks = [], chunks = []; // chunks: [first check, end check, part]
  parts.forEach(([from, to], part) => {
    const start = checks.length;
    for (let i = from; i < to; i++) if (ticks[i] % VIS_STEP === 0) checks.push(ticks[i]);
    for (let c = start; c < checks.length; c += CHUNK) chunks.push([c, Math.min(c + CHUNK, checks.length), part]);
  });
  if (!chunks.length) return null;
  const slots = Math.ceil(maxTick / VIS_STEP);
  const chunkOf = new Int32Array(slots).fill(-1);
  chunks.forEach(([a, b], c) => { for (let i = a; i < b; i++) chunkOf[checks[i] / VIS_STEP] = c; });
  const shared = n => new Int32Array(new SharedArrayBuffer(4 * Math.max(1, n)));
  const table = shared(slots * N * 2);
  const state = shared(chunks.length); // per chunk: 0 waiting, 1 done, 2 failed, 3 given up by the pass
  const next = shared(1);
  const checkTicks = shared(checks.length); checkTicks.set(checks);
  const chunkList = shared(chunks.length * 3); chunkList.set(chunks.flat());

  const threads = Math.max(1, Math.min(4, os.availableParallelism() - 2, chunks.length)); // more add little: the pass itself takes about as long
  const mesh = geometry.share();
  const workers = [];
  for (let i = 0; i < threads; i++) {
    try {
      const w = new Worker(__filename, { workerData: {
        mode: 'sight', mesh, buffers, N, maxTick, ready: ready.buffer, table: table.buffer, state: state.buffer, next: next.buffer,
        checks: checkTicks.buffer, chunks: chunkList.buffer, count: chunks.length,
      } });
      w.unref();
      w.on('error', () => {});
      workers.push(w);
    } catch {}
  }
  if (!workers.length) return null;

  return {
    // 1 visible, 0 not, -1 not worked out (the caller casts the rays itself).
    get(p, q, t) {
      const c = chunkOf[t / VIS_STEP];
      if (c === undefined || c < 0) return -1;
      let s = Atomics.load(state, c);
      if (s === 0) {
        // The event loop is blocked meanwhile, so workers report through the state, never by message.
        const deadline = Date.now() + 2 * 60000;
        while ((s = Atomics.load(state, c)) === 0 && Date.now() < deadline) Atomics.wait(state, c, 0, 1000);
        if (s === 0 && Atomics.compareExchange(state, c, 0, 3) === 0) s = 3;
        else s = Atomics.load(state, c);
      }
      if (s !== 1) return -1;
      const o = (t / VIS_STEP * N + p) * 2;
      return (table[o] >>> q) & 1 ? (table[o + 1] >>> q) & 1 : -1;
    },
    close() { for (const w of workers) w.terminate(); },
  };
}

// A worker of the pool: takes chunks in order until none are left.
function sightWorker({ mesh, buffers, N, ready, table, state, next, checks, chunks, count }) {
  const geometry = MapGeometry.fromShared(mesh);
  const { P } = tickArrays(N, 0, buffers);
  const view = tickView(P);
  const { alive, enemies, hasCmd } = view;
  const R = new Int32Array(ready), TB = new Int32Array(table), S = new Int32Array(state), X = new Int32Array(next);
  const C = new Int32Array(checks), L = new Int32Array(chunks);
  const hints = new Int32Array(N * N * BODY.length);
  const cache = new Int8Array(N * N);
  let t = 0, slot = 0;
  // Same answers, same caching for both directions as the pass's own los().
  const los = (p, q) => {
    const k = p * N + q;
    if (cache[k] >= 0) return cache[k] === 1;
    const v = castRays(geometry, P, N, p, q, t, hints);
    cache[k] = v; cache[q * N + p] = v;
    const o = (slot * N + p) * 2;
    TB[o] |= 1 << q;
    if (v) TB[o + 1] |= 1 << q;
    return v === 1;
  };
  for (let c; (c = Atomics.add(X, 0, 1)) < count;) {
    const part = L[c * 3 + 2];
    try {
      for (let r; (r = Atomics.load(R, part)) !== 1;) Atomics.wait(R, part, r, 1000);
      hints.fill(-1);
      for (let i = L[c * 3]; i < L[c * 3 + 1]; i++) {
        t = C[i]; slot = t / VIS_STEP;
        cache.fill(-1);
        spot(view, P, N, t, los, () => {});
        // Then every alive player with a usercmd against every alive enemy (integrity.js, step 2 and 3).
        for (let p = 0; p < N; p++) {
          if (!alive(p, t) || !hasCmd(p, t)) continue;
          for (let q = 0; q < N; q++) if (alive(q, t) && enemies(p, q, t)) los(p, q);
        }
      }
      Atomics.compareExchange(S, c, 0, 1);
    } catch {
      Atomics.compareExchange(S, c, 0, 2);
    }
    Atomics.notify(S, c);
  }
}

if (!isMainThread && workerData && workerData.mode === 'sight') sightWorker(workerData);

module.exports = { ALIVE, CT, T, FORCED, SCOPED, DUCK, NOCMD, AIR, VIS_STEP, FOV, BODY, wrap, deg, tickArrays, tickView, castRays, spot, startSight };
