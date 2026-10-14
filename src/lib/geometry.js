// Map collision geometry for line-of-sight checks: can a player at A see a point B, or is a wall in
// the way? The meshes come from the awpy-data project (github.com/pnxenopoulos/awpy-data), which
// exports each map's world_physics from CS2 and decimates it; one geometry.zip holds every map.
// DemoLab downloads that zip once into <userData>/geometry/ (see ensureGeometry) and checks it
// against the release manifest's sha256.
//
// .mesh (AWMH, little-endian): "AWMH", u32 version 1, u32 vertex count, u32 triangle count,
// vertices as 3 × f32 (Hammer units, Z up), triangles as 3 × u32 vertex indices.
// Static geometry only: no smokes, doors or bullet penetration.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const RELEASES = 'https://api.github.com/repos/pnxenopoulos/awpy-data/releases/latest';
const LEAF = 4;

// ---------- the mesh and its bounding volume hierarchy ----------
class MapGeometry {
  constructor(buf) {
    if (buf.toString('latin1', 0, 4) !== 'AWMH' || buf.readUInt32LE(4) !== 1) throw new Error('Unknown map mesh format');
    const nv = buf.readUInt32LE(8), nt = buf.readUInt32LE(12);
    const ab = buf.buffer.slice(buf.byteOffset + 16, buf.byteOffset + 16 + nv * 12 + nt * 12);
    const V = new Float32Array(ab, 0, nv * 3), I = new Uint32Array(ab, nv * 12, nt * 3);
    this.triangles = nt;

    // Per triangle: v0 and the two edges, ready for Möller–Trumbore.
    const T = new Float32Array(nt * 9);
    const cx = new Float32Array(nt), cy = new Float32Array(nt), cz = new Float32Array(nt);
    for (let t = 0; t < nt; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3, o = t * 9;
      T[o] = V[a]; T[o + 1] = V[a + 1]; T[o + 2] = V[a + 2];
      T[o + 3] = V[b] - V[a]; T[o + 4] = V[b + 1] - V[a + 1]; T[o + 5] = V[b + 2] - V[a + 2];
      T[o + 6] = V[c] - V[a]; T[o + 7] = V[c + 1] - V[a + 1]; T[o + 8] = V[c + 2] - V[a + 2];
      cx[t] = (V[a] + V[b] + V[c]) / 3; cy[t] = (V[a + 1] + V[b + 1] + V[c + 1]) / 3; cz[t] = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
    }

    // BVH over triangle centroids, median split on the longest axis. Nodes: bounds (6 floats) and
    // either two children or a range of the reordered triangle list.
    const order = new Uint32Array(nt);
    for (let i = 0; i < nt; i++) order[i] = i;
    const maxNodes = 2 * nt + 1; // median splits can leave as few as LEAF / 2 triangles per leaf
    const B = new Float32Array(maxNodes * 6);
    const N = new Int32Array(maxNodes * 3); // [left child | -1 for leaf, right child | first, count]
    let nodes = 0;
    const tri = this.tri = T;
    const bounds = (n, from, to) => {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = from; i < to; i++) {
        const o = order[i] * 9;
        for (let k = 0; k < 3; k++) {
          const x = tri[o] + (k === 1 ? tri[o + 3] : k === 2 ? tri[o + 6] : 0);
          const y = tri[o + 1] + (k === 1 ? tri[o + 4] : k === 2 ? tri[o + 7] : 0);
          const z = tri[o + 2] + (k === 1 ? tri[o + 5] : k === 2 ? tri[o + 8] : 0);
          if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
          if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
        }
      }
      B.set([x0, y0, z0, x1, y1, z1], n * 6);
      return [x1 - x0, y1 - y0, z1 - z0];
    };
    const stack = [[0, nt]];
    const ids = [nodes++];
    while (stack.length) {
      const [from, to] = stack.pop(), n = ids.pop();
      const ext = bounds(n, from, to);
      if (to - from <= LEAF) { N[n * 3] = -1; N[n * 3 + 1] = from; N[n * 3 + 2] = to - from; continue; }
      const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? cx : ext[1] >= ext[2] ? cy : cz;
      const mid = (from + to) >> 1;
      nthElement(order, from, to, mid, axis);
      const l = nodes++, r = nodes++;
      N[n * 3] = l; N[n * 3 + 1] = r;
      stack.push([from, mid], [mid, to]);
      ids.push(l, r);
    }
    // Reorder the triangles so leaves read a contiguous range.
    const S = new Float32Array(nt * 9);
    for (let i = 0; i < nt; i++) S.set(T.subarray(order[i] * 9, order[i] * 9 + 9), i * 9);
    this.tri = S;
    this.box = B;
    this.node = N;
    this.stack = new Int32Array(128);
  }

  // The triangles and the tree moved to shared memory, for fromShared() in worker threads.
  share() {
    const move = a => { if (a.buffer instanceof SharedArrayBuffer) return a; const s = new a.constructor(new SharedArrayBuffer(a.byteLength)); s.set(a); return s; };
    this.tri = move(this.tri); this.box = move(this.box); this.node = move(this.node);
    return { triangles: this.triangles, tri: this.tri.buffer, box: this.box.buffer, node: this.node.buffer };
  }

  static fromShared({ triangles, tri, box, node }) {
    const g = Object.create(MapGeometry.prototype);
    g.triangles = triangles;
    g.tri = new Float32Array(tri); g.box = new Float32Array(box); g.node = new Int32Array(node);
    g.stack = new Int32Array(128);
    return g;
  }

  // True when a wall (any triangle) crosses the segment from A to B. hints[slot], when given, is a
  // triangle to try first and is set to the one found: rays from one player to another hit the same
  // wall from tick to tick, so most blocked rays end after a single triangle test instead of a walk
  // down the tree. The answer is the same either way (any hit means blocked).
  blocked(ax, ay, az, bx, by, bz, hints = null, slot = 0) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    if (hints && hints[slot] >= 0 && this.hits(hints[slot] * 9, ax, ay, az, dx, dy, dz)) return true;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const B = this.box, N = this.node, st = this.stack;
    let sp = 0;
    st[sp++] = 0;
    while (sp) {
      const n = st[--sp], b = n * 6;
      // slab test against the node's box, for t in [0, 1]
      let t0 = 0, t1 = 1, u, v;
      u = (B[b] - ax) * ix; v = (B[b + 3] - ax) * ix; if (u > v) { const w = u; u = v; v = w; } if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) continue;
      u = (B[b + 1] - ay) * iy; v = (B[b + 4] - ay) * iy; if (u > v) { const w = u; u = v; v = w; } if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) continue;
      u = (B[b + 2] - az) * iz; v = (B[b + 5] - az) * iz; if (u > v) { const w = u; u = v; v = w; } if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) continue;
      const l = N[n * 3];
      if (l >= 0) { st[sp++] = l; st[sp++] = N[n * 3 + 1]; continue; }
      for (let i = N[n * 3 + 1], e = i + N[n * 3 + 2]; i < e; i++) {
        if (this.hits(i * 9, ax, ay, az, dx, dy, dz)) { if (hints) hints[slot] = i; return true; }
      }
    }
    return false;
  }

  // Möller–Trumbore: does the triangle at offset o in this.tri cross A + t·D for t in (0, 1)?
  hits(o, ax, ay, az, dx, dy, dz) {
    const T = this.tri;
    const e1x = T[o + 3], e1y = T[o + 4], e1z = T[o + 5], e2x = T[o + 6], e2y = T[o + 7], e2z = T[o + 8];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-9 && det < 1e-9) return false;
    const inv = 1 / det;
    const sx = ax - T[o], sy = ay - T[o + 1], sz = az - T[o + 2];
    const uu = (sx * px + sy * py + sz * pz) * inv;
    if (uu < 0 || uu > 1) return false;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const vv = (dx * qx + dy * qy + dz * qz) * inv;
    if (vv < 0 || uu + vv > 1) return false;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 1e-4 && t < 1 - 1e-4;
  }
}

// Partial sort of order[from, to) so that order[k] holds the k-th smallest key (quickselect).
function nthElement(order, from, to, k, key) {
  let lo = from, hi = to - 1;
  while (hi > lo) {
    const pivot = key[order[(lo + hi) >> 1]];
    let i = lo, j = hi;
    while (i <= j) {
      while (key[order[i]] < pivot) i++;
      while (key[order[j]] > pivot) j--;
      if (i <= j) { const t = order[i]; order[i] = order[j]; order[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else break;
  }
}

// ---------- geometry.zip ----------
// Just enough of the zip format for awpy-data's archive: the central directory, stored or deflated entries.
function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    const data = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(data, data + csize);
    out.set(name, method === 0 ? raw : method === 8 ? () => zlib.inflateRawSync(raw) : null);
  }
  return out;
}

// Makes sure <dir> holds the map meshes: downloads the latest awpy-data release's geometry.zip
// (about 57 MB) the first time, verifies it and extracts the .mesh files. Returns the directory with
// the meshes. `fetch` is passed in (Electron's net.fetch in the app).
async function ensureGeometry(dir, fetch, log = () => {}) {
  const done = path.join(dir, 'manifest.json');
  if (fs.existsSync(done)) return dir;
  const rel = await (await fetch(RELEASES, { headers: { 'User-Agent': 'cs2-demolab', Accept: 'application/vnd.github+json' } })).json();
  const asset = n => rel.assets?.find(a => a.name === n)?.browser_download_url;
  if (!asset('geometry.zip') || !asset('manifest.json')) throw new Error('The map geometry release has no geometry.zip');
  const manifest = await (await fetch(asset('manifest.json'))).json();
  log(`downloading map geometry ${rel.tag_name}`);
  const res = await fetch(asset('geometry.zip'));
  if (!res.ok) throw new Error(`Map geometry download failed (HTTP ${res.status})`);
  const zip = Buffer.from(await res.arrayBuffer());
  const want = manifest.artifacts?.['geometry.zip']?.sha256;
  const got = crypto.createHash('sha256').update(zip).digest('hex');
  if (want && want !== got) throw new Error('The downloaded map geometry is corrupt (checksum mismatch)');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, entry] of unzip(zip)) {
    if (!/^[a-z0-9_]+\.mesh$/.test(name) || !entry) continue;
    fs.writeFileSync(path.join(dir, name), Buffer.isBuffer(entry) ? entry : entry());
  }
  fs.writeFileSync(done, JSON.stringify({ release: rel.tag_name, ...manifest }));
  log(`map geometry ${rel.tag_name} ready`);
  return dir;
}

function loadGeometry(dir, map) {
  const file = path.join(dir, `${map}.mesh`);
  return fs.existsSync(file) ? new MapGeometry(fs.readFileSync(file)) : null;
}

module.exports = { MapGeometry, ensureGeometry, loadGeometry, unzip };
