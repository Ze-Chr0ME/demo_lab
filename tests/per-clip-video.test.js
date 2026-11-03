const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ffmpeg = require('../src/lib/ffmpeg');

const src = { width: 1920, height: 1080, fps: 60 };
const plan = (video, mb = 10) => ffmpeg.clipPlan(mb, 60, src, {}, video);

test('fixed height and fps clamp to the source', () => {
  const p = plan({ height: 2160, fps: 120 });
  assert.equal(p.width, 1920);
  assert.equal(p.height, 1080);
  assert.equal(p.fps, 60);
  assert.equal(p.custom, true);
  assert.deepEqual(p.src, src);
});

test('fixed dimensions bypass the ladder and its floors', () => {
  const p = ffmpeg.sizePlan(1, 120, src, { minHeight: 1080, minFps: 60 }, { height: 720, fps: 30 });
  assert.equal(p.width, 1280);
  assert.equal(p.height, 720);
  assert.equal(p.fps, 30);
  assert.equal(p.quality, 'low');
});

test('setting only one dimension leaves the other at source', () => {
  assert.equal(plan({ height: 720 }).fps, 60);
  assert.equal(plan({ fps: 30 }).height, 1080);
});

test('video bitrate wins over size and derives bytes without a quality cap', () => {
  const p = plan({ height: 360, fps: 30, videoKbps: 50000 }, 1);
  assert.equal(p.videoKbps, 50000);
  assert.equal(p.bytes, (50000 + p.audioKbps) * 1000 / 8 * 60);
  assert.equal(p.quality, 'excellent');
  assert.equal(p.estimated, false);
  assert.equal(p.kept, false);
});

test('bitrate alone preserves source dimensions and fps', () => {
  const p = plan({ videoKbps: 150 });
  assert.equal(p.height, 1080);
  assert.equal(p.fps, 60);
  assert.equal(p.quality, 'low');
});

test('zero mb overrides the global target while undefined inherits it', () => {
  const best = plan({ mb: 0 });
  const inherited = plan({ mb: undefined });
  assert.equal(best.quality, 'best');
  assert.equal(best.custom, true);
  assert.equal(inherited.custom, undefined);
  assert(inherited.bytes < best.bytes);
  assert.deepEqual(inherited, plan({}));
});

test('a per-clip size replaces the global target', () => {
  assert.deepEqual(plan({ mb: 5 }, 100), plan({ mb: 5 }, 1));
});

test('null and zero manual settings are auto', () => {
  assert.deepEqual(plan({ height: null, fps: 0, videoKbps: null }), plan({}));
  assert.equal(plan({ mb: null }).quality, 'best');
});

test('manual dimensions without size scale the best-estimate pixel rate', () => {
  const best = plan({}, 0);
  const p = plan({ height: 720, fps: 30 }, 0);
  assert.equal(p.videoKbps, Math.round(best.videoKbps * 1280 * 720 * 30 / (1920 * 1080 * 60)));
  assert.equal(p.audioKbps, best.audioKbps);
  assert.equal(p.bytes, (p.videoKbps + p.audioKbps) * 1000 / 8 * 60);
  assert.equal(p.estimated, true);
  assert.equal(p.kept, false);
});

test('output width is even and follows the source aspect ratio', () => {
  const p = ffmpeg.clipPlan(0, 20, { width: 2560, height: 1080, fps: 60 }, {}, { height: 720 });
  assert.equal(p.width % 2, 0);
  assert(Math.abs(p.width - 2560 * 720 / 1080) <= 1);
});

test('preferBest is used only for plain size targets', () => {
  assert.equal(plan({}, 1000).kept, true);
  const p = plan({ height: 720, fps: 30 }, 1000);
  assert.equal(p.height, 720);
  assert.equal(p.fps, 30);
  assert.equal(p.kept, false);
});

test('IPC aligns overrides with seconds and preserves plain rows', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  let handler;
  const ctx = vm.createContext({
    s: () => ({ hlae: src }), library: () => ({ list: () => [] }), ffmpeg,
    handle: (_name, fn) => { handler = fn; },
  });
  vm.runInContext(main.slice(main.indexOf("  handle('video:sizePlan'"), main.indexOf("  handle('montage:make'")), ctx);
  const rows = await handler({ mb: 10, seconds: [60, 60, 30, 60],
    overrides: [null, { mb: 0 }, { height: 720, fps: 30, videoKbps: 4000 }] });
  assert.equal(rows[0].custom, undefined);
  assert.equal(rows[1].quality, 'best');
  assert.equal(rows[1].custom, true);
  assert.equal(rows[2].width, 1280);
  assert.equal(rows[2].videoKbps, 4000);
  assert.equal(rows[2].bytes, 4192 * 1000 / 8 * 30);
  assert.equal(rows[3].bytes, rows[0].bytes);
  for (const row of rows) assert.equal(row.src.width, 1920);
});
