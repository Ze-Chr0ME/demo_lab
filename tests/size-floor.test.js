const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sizePlan, preferBest } = require('../src/lib/ffmpeg');
const vm = require('node:vm');
const { Settings } = require('../src/lib/settings');

const src = { width: 1920, height: 1080, fps: 60 };

test('size planner keeps the full ladder without a floor', () => {
  assert(sizePlan(10, 60, src).height < 720);
});

test('size planner respects resolution and fps floors even at low quality', () => {
  const plan = sizePlan(10, 60, src, { minHeight: 720, minFps: 60 });
  assert(plan.height >= 720);
  assert.equal(plan.fps, 60);
  assert.equal(plan.quality, 'low');
});

test('floors above the source preserve a valid source step', () => {
  const plan = sizePlan(10, 60, { ...src, fps: 30 }, { minHeight: 2160, minFps: 60 });
  assert.equal(plan.height, 1080);
  assert.equal(plan.fps, 30);
});

test('existing saved size settings inherit the new floor defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'size-floor-'));
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ videoSize: { clip: 10, montage: 50 } }));
    assert.deepEqual(new Settings(dir).get().videoSize, { clip: 10, montage: 50, minHeight: 360, minFps: 30 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MB = 1048576;

test('a best-quality clip below the target is kept with its original estimate', () => {
  const best = { ...src, videoKbps: 8800, audioKbps: 192, bytes: 40 * MB, quality: 'best', estimated: true };
  assert.deepEqual(preferBest({ ...sizePlan(50, 37, src), bytes: 48 * MB }, best, 50), { ...best, kept: true });
});

test('a best-quality clip above the target keeps the smaller size plan', () => {
  const best = { ...src, videoKbps: 18000, bytes: 80 * MB };
  const plan = { ...sizePlan(50, 37, src), bytes: 48 * MB };
  assert.equal(preferBest(plan, best, 50), plan);
  assert(plan.videoKbps <= best.videoKbps);
});

test('a target plan cannot claim a bitrate higher than best quality', () => {
  const best = { ...src, videoKbps: 8000, audioKbps: 192, bytes: 80 * MB, quality: 'best', estimated: true };
  const plan = { ...sizePlan(50, 37, src), seconds: 37, videoKbps: 10000 };
  const result = preferBest(plan, best, 50);
  assert.equal(result.kept, false);
  assert.equal(result.videoKbps, 8000);
  assert.equal(result.bytes, (8000 + plan.audioKbps) * 1000 / 8 * 37);
  assert.equal(result.quality, 'good');
});

test('a 120-second 720p30 clip above 10 MiB still needs fitting', () => {
  const source = { width: 1280, height: 720, fps: 30 };
  const videoKbps = Math.round(0.02 * source.width * source.height * source.fps / 1000);
  const best = { ...source, videoKbps, audioKbps: 192, bytes: (videoKbps + 192) * 1000 / 8 * 120 };
  const plan = { ...sizePlan(10, 120, source), seconds: 120 };
  const result = preferBest(plan, best, 10);
  assert(best.bytes > 10 * MB);
  assert.equal(result.kept, false);
  assert.equal(result.videoKbps, videoKbps);
  assert.equal(result.bytes, (videoKbps + plan.audioKbps) * 1000 / 8 * 120);
  assert.equal(result.quality, 'low');
});

function sizeHandler(items, probe, statSync) {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  let handler;
  const ctx = vm.createContext({
    s: () => ({ hlae: { width: 2560, height: 1440, fps: 60 } }),
    library: () => ({ list: () => items }), sizeProbeCache: new Map(),
    ffmpeg: { probe, sizePlan, preferBest }, fs: { statSync },
    handle: (_name, fn) => { handler = fn; },
  });
  vm.runInContext(main.slice(main.indexOf("  handle('video:sizePlan'"), main.indexOf("  handle('montage:make'")), ctx);
  return handler;
}

test('history uses probed dimensions and duration, caches concurrent probes, and refreshes changed files', async () => {
  let calls = 0, mtimeMs = 1;
  const item = { kind: 'clip', file: 'old.mp4' };
  const bpp = 0.06;
  const handler = sizeHandler([item], async () => {
    calls++;
    return { ...src, duration: 37 };
  }, () => ({ size: (bpp * src.width * src.height * src.fps + 192000) * 37 / 8, mtimeMs }));
  const [best, target] = await Promise.all([
    handler({ mb: 0, seconds: [37] }), handler({ mb: 100, seconds: [37] }),
  ]);
  assert.equal(calls, 1);
  assert.equal(best[0].videoKbps, Math.round(bpp * 2560 * 1440 * 60 / 1000));
  assert.equal(target[0].videoKbps, best[0].videoKbps);
  assert.equal(target[0].kept, true);
  mtimeMs++;
  await handler({ mb: 0, seconds: [37] });
  assert.equal(calls, 2);
});

test('history limits probing to eight recent clips and ignores failed probes', async () => {
  let calls = 0;
  const items = [{ kind: 'montage', duration: 10 }, { kind: 'clip', duration: 2 },
    ...Array.from({ length: 10 }, (_, i) => ({ kind: 'clip', duration: 10, file: `${i}.mp4` }))];
  const handler = sizeHandler(items, async () => { calls++; throw new Error('missing stream'); },
    () => ({ size: MB, mtimeMs: 1 }));
  const [best] = await handler({ mb: 0, seconds: [37] });
  assert.equal(calls, 8);
  assert.equal(best.videoKbps, Math.round(0.12 * 2560 * 1440 * 60 / 1000));
});

test('stored history metadata avoids probes and supports the lower bpp clamp', async () => {
  const handler = sizeHandler([{ kind: 'clip', file: 'clip.mp4', ...src, duration: 10 }],
    async () => { assert.fail('complete metadata needs no probe'); },
    () => ({ size: (0.01 * src.width * src.height * src.fps + 192000) * 10 / 8, mtimeMs: 1 }));
  const [best] = await handler({ mb: 0, seconds: [37] });
  assert.equal(best.videoKbps, Math.round(0.02 * 2560 * 1440 * 60 / 1000));
});

test('montage targets use the summed input sizes for best quality', async () => {
  const clips = [{ id: 'a', file: 'a.mp4', duration: 20 }, { id: 'b', file: 'b.mp4', duration: 17 }];
  const handler = sizeHandler(clips, async () => src, () => ({ size: 20 * MB }));
  const [best] = await handler({ mb: 0, ids: ['a', 'b'] });
  const [target] = await handler({ mb: 50, ids: ['a', 'b'] });
  assert.equal(best.bytes, 40 * MB);
  assert.equal(target.bytes, best.bytes);
  assert.equal(target.videoKbps, best.videoKbps);
  assert.equal(target.kept, true);
});

test('montage below the target runs the best-quality encoding path', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/ffmpeg.js'), 'utf8');
  let args;
  const ctx = vm.createContext({
    MB, probe: async () => ({ ...src, duration: 20 }),
    fs: { statSync: () => ({ size: 20 * MB }) },
    videoArgs: () => ['best-video'], audioArgs: ['best-audio'],
    montageOnce: async (...values) => { args = values; },
    encodeToSize: () => { assert.fail('fitting is unnecessary'); },
  });
  vm.runInContext(source.slice(source.indexOf('async function montage('), source.indexOf('async function montageOnce(')), ctx);
  await ctx.montage(['a.mp4', 'b.mp4'], 'out.mp4', { mb: 50 });
  assert.deepEqual(Array.from(args[5]), ['best-video', 'best-audio']);
});

for (const fail of [false, true]) test(`oversized best-quality montage fits and cleans up${fail ? ' on failure' : ''}`, async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/ffmpeg.js'), 'utf8');
  const calls = [];
  const floor = { minHeight: 720 }, seen = [], onProgress = p => seen.push(p);
  const plan = { bytes: 49 * MB };
  const ctx = vm.createContext({
    MB, probe: async () => ({ ...src, duration: 20 }),
    fs: {
      statSync: file => ({ size: (file === 'out.mp4' ? 60 : 20) * MB }),
      renameSync: (...args) => calls.push(['rename', ...args]),
      rmSync: file => calls.push(['remove', file]),
    },
    videoArgs: () => ['best-video'], audioArgs: ['best-audio'],
    montageOnce: async (_i, _n, _o, _s, _f, _a, progress) => { progress(0.5); progress(1); },
    fitToSize: async (input, output, mb, options) => {
      assert.equal(input, 'out.mp4');
      assert.equal(output, 'out.mp4.fit.mp4');
      assert.equal(mb, 50);
      assert.equal(options.floor, floor);
      options.onProgress(0.01); options.onProgress(1);
      // The fitting pass continues the bar instead of restarting it.
      assert.deepEqual(seen.map(p => +p.toFixed(3)), [0.3, 0.6, 0.604, 1]);
      if (fail) throw new Error('fit failed');
      return plan;
    },
  });
  vm.runInContext(source.slice(source.indexOf('async function montage('), source.indexOf('async function montageOnce(')), ctx);
  const result = ctx.montage(['a.mp4', 'b.mp4'], 'out.mp4', { mb: 50, floor, onProgress });
  if (fail) await assert.rejects(result, /fit failed/);
  else {
    const value = await result;
    assert.equal(value.duration, 40);
    assert.equal(value.plan, plan);
  }
  assert.deepEqual(calls, fail ? [['remove', 'out.mp4.fit.mp4']]
    : [['rename', 'out.mp4.fit.mp4', 'out.mp4'], ['remove', 'out.mp4.fit.mp4']]);
});
