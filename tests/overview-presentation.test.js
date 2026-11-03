const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
const h = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(x => x != null) });
const descendants = node => typeof node === 'object' ? [node, ...node.children.flatMap(descendants)] : [];

test('stat values compare with fixed player references independently of recent form and match count', () => {
  const context = vm.createContext({ h });
  vm.runInContext(source.slice(source.indexOf('const STAT_BENCHMARKS ='), source.indexOf('const RATING_LEVELS ='))
    + '\nthis.statTile = statTile;', context);
  const render = (value, recent, id = 'kd', low = false, count = 11) => {
    const def = { id, k: 'Test', d: 2, low, m: m => m.value, t: t => t.value };
    const list = Array.from({ length: count }, () => ({ value }));
    return descendants(context.statTile(def, list, { value }, { value: recent }, false));
  };
  const valueClass = nodes => nodes.find(node => node.attrs?.class?.startsWith('tile-v ')).attrs.class;
  assert.equal(valueClass(render(1.4, 0.8)), 'tile-v up');
  assert.equal(valueClass(render(1.4, 2)), 'tile-v up');
  assert.equal(valueClass(render(0.8, 1.4)), 'tile-v down');
  assert.equal(valueClass(render(0.8, 0.5)), 'tile-v down');
  assert.equal(valueClass(render(1, 1)), 'tile-v neutral');
  assert.equal(valueClass(render(1, 1.001)), 'tile-v neutral');
  assert.equal(valueClass(render(0.94, null)), 'tile-v neutral');
  assert.equal(valueClass(render(1.14, null)), 'tile-v neutral');
  assert.equal(valueClass(render(200, 100, 'reaction', true)), 'tile-v up');
  assert.equal(valueClass(render(400, 500, 'reaction', true)), 'tile-v down');
  assert.equal(valueClass(render(300, 200, 'reaction', true)), 'tile-v neutral');
  assert.equal(valueClass(render(0.6, 0.5, 'deaths', true)), 'tile-v up');
  assert.equal(valueClass(render(0.8, 0.9, 'deaths', true)), 'tile-v down');
  assert.equal(valueClass(render(90, 95, 'adr')), 'tile-v up');
  assert.equal(valueClass(render(60, 55, 'adr')), 'tile-v down');
  assert.equal(valueClass(render(77.3, 90, 'adr')), 'tile-v neutral');
  assert.equal(valueClass(render(1, null)), 'tile-v neutral');
  assert.equal(valueClass(render(null, 1)), 'tile-v neutral');
  assert.equal(valueClass(render(1.4, null, 'kd', false, 1)), 'tile-v up');
  assert.equal(valueClass(render(NaN, 1)), 'tile-v neutral');
  assert.equal(valueClass(render(1, 2, 'unknown')), 'tile-v neutral');
  assert(render(1, null).some(node => node.attrs?.title?.includes('Typical FACEIT player (median)')));
  assert(render(300, null, 'reaction', true).some(node => node.attrs?.title?.includes('Estimated average-player reference')));
});

function trendContext() {
  let onresize, chart, opened;
  const context = vm.createContext({
    h: (tag, attrs, ...children) => {
      const node = h(tag, attrs, ...children);
      if (attrs?.class === 'trend-wrap') {
        chart = node;
        Object.assign(node, { clientWidth: 600, clientHeight: 200, isConnected: true,
          addEventListener: (name, callback) => { node[name] = callback; } });
      }
      return node;
    },
    card: (title, content) => ({ title, content }), mapName: name => name, openMatch: match => { opened = match; },
    ResizeObserver: class {
      constructor(callback) { onresize = callback; }
      observe() { onresize(); }
      disconnect() {}
    },
  });
  vm.runInContext(source.slice(source.indexOf('function smoothRatingPath('), source.indexOf('\nfunction multiCard('))
    + '\nthis.curve = smoothRatingPath; this.trend = trendCard;', context);
  return { context, get chart() { return chart; }, get opened() { return opened; }, resize: () => onresize() };
}

test('rating curves pass through every sample without overshooting between matches', () => {
  const { context } = trendContext();
  assert.equal(context.curve([]), '');
  assert.equal(context.curve([[0, 10]]), 'M0.00,10.00');
  for (const values of [[10, 20], [20, 20, 20], [10, 50, 15, 70], [0, 1, 100, 101], [100, 99, 1, 0]]) {
    const path = context.curve(values.map((y, i) => [i * 30, y]));
    const segments = [...path.matchAll(/C([\d., -]+)/g)];
    assert.equal(segments.length, values.length - 1);
    segments.forEach(([_, coords], i) => {
      const [x1, y1, x2, y2, x3, y3] = coords.split(/[ ,]+/).map(Number);
      assert.equal(x3, (i + 1) * 30);
      assert.equal(y3, values[i + 1]);
      assert(x1 < x2 && x2 < x3);
      for (let j = 0; j <= 100; j++) {
        const t = j / 100, u = 1 - t;
        const y = u ** 3 * values[i] + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3;
        assert(y >= Math.min(values[i], y3) - 0.01 && y <= Math.max(values[i], y3) + 0.01);
      }
    });
  }
});

test('rating chart curves both series and area, keeps clickable matches and redraws on resize', () => {
  const ui = trendContext();
  const matches = [1.5, 0.7, 1.1].map((rating, i) => ({ rating, date: 1700000000000 - i * 86400000,
    map: 'de_dust2', score: [13, 10], result: 'W' }));
  ui.context.trend(matches);
  const svg = ui.chart.innerHTML;
  const path = cls => svg.match(new RegExp(`<path d="([^"]+)" class="${cls}"`))[1];
  assert.match(path('t-line'), /C/);
  assert.match(path('t-avg'), /C/);
  assert(path('t-area').startsWith(path('t-line')));
  assert.equal((svg.match(/<circle /g) || []).length, 3);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  ui.chart.click({ target: { dataset: { i: '0' } } });
  assert.equal(ui.opened, matches[2]);
  ui.chart.clientWidth = 300;
  ui.resize();
  assert.notEqual(ui.chart.innerHTML, svg);
  assert.equal(ui.context.trend(matches.slice(0, 1)).title, 'Rating per match');
});
