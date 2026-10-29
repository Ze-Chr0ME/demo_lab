const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const app = read('src/renderer/app.js');
const main = read('src/main.js');
const h = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat().filter(x => x != null) });
const nodes = el => [el, ...(el.children || []).filter(x => typeof x === 'object').flatMap(nodes)];

function setup() {
  const full = { id: 'r1', round: 1, title: '3K', duration: 12, segments: [{ start: 10, end: 20 }, { start: 30, end: 40 }] };
  let list;
  const ctx = vm.createContext({
    state: { settings: { timing: { startupWait: 35 } }, env: { outputDir: 'clips' } },
    handle: (name, fn) => { if (name === 'highlights:all') list = fn; },
    scanDemos: () => [{ id: 'demo1', path: 'match.dem', name: 'match.dem', date: 1 }],
    store: { readCore: () => ({ map: 'de_mirage' }) }, mySteamId: () => 'player1',
    analysis: () => ({ playerFound: true, player: { steamid: 'player1' }, highlights: [full] }),
    h, modal: content => { ctx.dialog = h('div', {}, content); },
    sizeDialog: options => { ctx.size = options; }, clipsOf: () => [], ICONS: {},
  });
  const start = main.indexOf("  handle('highlights:all'");
  vm.runInContext(main.slice(start, main.indexOf('\n\n  // The overview dashboard', start)), ctx);
  vm.runInContext(app.slice(app.indexOf('function estimateSeconds('), app.indexOf('function actionBar(')), ctx);
  vm.runInContext(app.slice(app.indexOf('function confirmRecord('), app.indexOf('async function startRecord(')), ctx);
  return { ctx, full, list };
}

test('recording confirmation accepts the actual cross-match list payload', () => {
  const { ctx, list } = setup();
  const highlight = list().items[0].highlight;
  assert.equal(highlight.segments, undefined);
  assert.equal(highlight.segmentCount, 2);
  assert(Number.isFinite(ctx.estimateSeconds([highlight])));
  ctx.confirmRecord([highlight]);
  const next = nodes(ctx.dialog).find(n => n.tag === 'button' && n.children.includes('Next'));
  assert(next, 'Record queue must open the confirmation dialog');
  next.attrs.onclick();
  assert.equal(ctx.size.clips.length, 1);
  assert.equal(ctx.size.goLabel, 'Start recording');
});

test('recording estimates agree for full highlights and list summaries', () => {
  const { ctx, full, list } = setup();
  assert.equal(ctx.estimateSeconds([list().items[0].highlight]), ctx.estimateSeconds([full]));
});

test('a previously loaded list without segment counts still opens confirmation', () => {
  const { ctx, list } = setup();
  const highlight = list().items[0].highlight;
  delete highlight.segmentCount;
  ctx.confirmRecord([highlight]);
  assert(Number.isFinite(ctx.estimateSeconds([highlight])));
  assert(nodes(ctx.dialog).some(n => n.tag === 'button' && n.children.includes('Next')));
});
