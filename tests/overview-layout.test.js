const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const OverviewLayout = require('../src/renderer/overview-layout');
const { Settings } = require('../src/lib/settings');

test('layouts recover unknown, duplicate and missing entries without losing saved choices', () => {
  const layout = OverviewLayout.normalize({
    sections: [{ id: 'duels', hidden: true, span: 6, height: 412.4 }, { id: 'duels' }, { id: 'removed' }, { id: 'history', span: 2, height: -5 }, { id: 'maps', span: 'wide', height: 'tall' }],
    modules: { history: [{ id: 'recent' }, { id: 'trend', hidden: true }] },
    stats: [{ id: 'reaction', hidden: true }, null, { id: 'obsolete' }, { id: 'reaction' }],
    density: 'invalid', histograms: false,
  });
  const auto = { height: null };
  assert.deepEqual(layout.sections, [{ id: 'duels', hidden: true, span: 6, height: 412 }, { id: 'history', hidden: false, span: 4, ...auto },
    { id: 'maps', hidden: false, span: 12, ...auto }, { id: 'performance', hidden: false, span: 12, ...auto },
    { id: 'weapons', hidden: true, span: 12, ...auto }, { id: 'squad', hidden: true, span: 12, ...auto }, { id: 'habits', hidden: true, span: 12, ...auto }]);
  assert.deepEqual(layout.modules.duels.filter(m => !m.hidden).map(m => m.id), ['clutches', 'opening', 'sides', 'multi']);
  assert.deepEqual(layout.modules.history, [{ id: 'recent', hidden: false, ...auto, span: null }, { id: 'trend', hidden: true, ...auto, span: null }]);
  assert.equal(layout.stats.length, 12);
  assert.deepEqual(layout.stats[0], { id: 'reaction', hidden: true });
  assert.equal(layout.density, 'compact');
  assert.equal(layout.histograms, false);
  assert.deepEqual(OverviewLayout.normalize(layout), layout);
});

test('layout persists across settings reload and reset leaves other preferences intact', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demolab-layout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = new Settings(dir);
  const layout = OverviewLayout.normalize(null);
  layout.stats.reverse();
  layout.modules.performance[0].hidden = true;
  layout.ratingStats.find(stat => stat.id === 'adr').hidden = true;
  layout.ratingStats.find(stat => stat.id === 'reaction').hidden = false;
  layout.ratingStats.find(stat => stat.id === 'reaction').span = 9;
  layout.ratingStats.find(stat => stat.id === 'reaction').height = 120;
  layout.density = 'comfortable';
  settings.update({ overviewLayout: layout, theme: 'custom' });
  assert.deepEqual(new Settings(dir).get().overviewLayout, layout);
  settings.update({ overviewLayout: OverviewLayout.normalize(null) });
  const reloaded = new Settings(dir).get();
  assert.deepEqual(reloaded.overviewLayout, OverviewLayout.normalize(null));
  assert.equal(reloaded.theme, 'custom');
});

function renderer(saved, ovEdit = null) {
  const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  let page;
  const h = (tag, attrs = {}, ...children) => {
    const node = { tag, attrs, children: children.flat(Infinity).filter(x => x != null && x !== false) };
    node.classList = { add: name => { node.attrs.class = `${node.attrs.class || ''} ${name}`; } };
    return node;
  };
  const matches = [{ rounds: 10, kills: 5, deaths: 5, clutches: {}, multi: {}, weapons: {}, map: 'de_dust2' }];
  const context = {
    OverviewLayout, h, state: { settings: { overviewLayout: saved }, ovEdit, ov: { mode: 'all', map: 'all', period: 'all' }, demos: [] },
    $: () => ({ replaceChildren: node => { page = node; } }),
    shownProfile: () => ({ steamid: 'me', name: 'Player', matches }), filteredMatches: () => matches,
    playerMenu: () => 'Player', steamAvatar: () => null, mapName: m => m, fmtNum: n => n,
    customizeOverview() {}, cmpMenu: () => null, PERIODS: [],
    statTile: (tile, list, total, last10, charts) => h('tile', { id: tile.id, charts }),
    OverviewModules: {},
    OverviewEditor: { paused: () => false, bar: () => h('editbar'), chips: () => null, editable: node => node, sortable: node => node, section: (entry, node) => h('editsection', { id: entry.id }, node) },
  };
  for (const name of ['scorePanel', 'trendCard', 'recentCard', 'clutchCard', 'entryCard', 'sidesCard', 'multiCard']) context[name] = () => h(name);
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function aggregate(list)'), source.indexOf('// Small building blocks'))
    + source.slice(source.indexOf('const per ='), source.indexOf('// Distribution of a stat'))
    + source.slice(source.indexOf('function renderOverview()'), source.indexOf('\nfunction clutchCard')), context);
  context.renderOverview();
  return page;
}
const descendants = node => typeof node === 'object' ? [node, ...node.children.flatMap(descendants)] : [];

test('default Overview keeps all modules and the current twelve stats', () => {
  const page = renderer(null), nodes = descendants(page);
  assert.deepEqual(nodes.filter(n => n.tag === 'tile').map(n => n.attrs.id), OverviewLayout.stats.map(s => s.id));
  assert.equal(nodes.filter(n => /ov-module-/.test(n.attrs.class || '')).length, 8);
});

test('Overview applies section/module order, visibility, stat order, spacing and histogram preference', () => {
  const layout = OverviewLayout.normalize(null);
  layout.sections.reverse();
  layout.modules.history.reverse();
  layout.modules.performance[0].hidden = true;
  layout.stats.reverse();
  layout.stats[0].hidden = true;
  layout.histograms = false;
  layout.density = 'comfortable';
  const page = renderer(layout), nodes = descendants(page);
  assert.match(page.attrs.class, /ov-density-comfortable/);
  const grid = page.children[1], shown = grid.children.map(slot => slot.children[0]);
  assert.match(grid.attrs.class, /ov-stack/);
  assert.match(shown[0].attrs.class, /ov-sec/);
  assert.equal(shown[1].children[0].tag, 'recentCard');
  assert.match(shown[2].attrs.class, /ov-single/);
  assert.equal(nodes.some(n => n.tag === 'scorePanel'), false);
  assert.deepEqual(nodes.filter(n => n.tag === 'tile').map(n => n.attrs.id), layout.stats.slice(1).map(s => s.id));
  assert(nodes.filter(n => n.tag === 'tile').every(n => n.attrs.charts === false));
});

test('section widths put sections side by side on the 12-column grid', () => {
  const layout = OverviewLayout.normalize(null);
  layout.sections[0].span = 6;
  layout.sections[1].span = 6;
  layout.sections[1].height = 640;
  const grid = renderer(layout).children[1];
  assert.equal(grid.children[1].attrs.style['--h'], '640px');
  assert.equal(grid.children[0].attrs.style['--h'], null);
  assert.doesNotMatch(grid.attrs.class, /ov-stack/);
  assert.deepEqual(grid.children.map(slot => [slot.attrs.style['--span'], /ov-full/.test(slot.attrs.class)]), [[6, false], [6, false], [12, true]]);
});

test('module sizes normalize and a resized module puts its section on the module grid', () => {
  const layout = OverviewLayout.normalize({ modules: { duels: [{ id: 'clutches', span: 1, height: 333.3 }, { id: 'opening', span: 'x', height: 0 }] } });
  assert.deepEqual(layout.modules.duels.slice(0, 2), [{ id: 'clutches', hidden: false, span: 3, height: 333 }, { id: 'opening', hidden: false, span: null, height: null }]);
  assert.equal(layout.modules.history[0].span, null);
  const grids = l => descendants(renderer(l)).filter(n => /ov-mgrid/.test(n.attrs.class || '')).map(n => n.attrs.class);
  assert.equal(grids(layout).length, 1);
  assert.match(grids(layout)[0], /ov-modules-duels/);
  const heightOnly = OverviewLayout.normalize(null);
  heightOnly.modules.history[0].height = 500;
  assert.deepEqual(grids(heightOnly), [], 'height alone keeps the built-in arrangement');
});

test('hiding every module keeps customization available; empty stat selection has a recovery hint', () => {
  const layout = OverviewLayout.normalize(null);
  for (const modules of Object.values(layout.modules)) for (const module of modules) module.hidden = true;
  let nodes = descendants(renderer(layout));
  assert.equal(nodes.some(n => n.tag === 'button' && n.children.includes('Choose modules')), true);
  assert.equal(nodes.filter(n => /ov-module-/.test(n.attrs.class || '')).length, 0);
  assert(nodes.some(n => n.children.includes('All modules are hidden. Customize overview brings them back.')));
  layout.modules.performance[1].hidden = false;
  for (const stat of layout.stats) stat.hidden = true;
  nodes = descendants(renderer(layout));
  assert.equal(nodes.filter(n => n.tag === 'tile').length, 0);
  assert(nodes.some(n => n.children.includes('No stats selected. Choose your tiles in Customize overview.')));
});

function editorElement(tag, attrs = {}, ...children) {
  const node = { tag, attrs, children: children.flat(Infinity).filter(x => x != null && x !== false), dataset: {}, listeners: {} };
  node.style = { ...attrs.style,
    getPropertyValue: key => node.style[key] || '',
    setProperty: (key, value) => { node.style[key] = value; },
    removeProperty: key => { delete node.style[key]; },
  };
  node.classList = {
    add: (...names) => { node.attrs.class = `${node.attrs.class || ''} ${names.join(' ')}`; },
    remove: (...names) => { node.attrs.class = (node.attrs.class || '').split(' ').filter(name => !names.includes(name)).join(' '); },
  };
  node.setAttribute = (key, value) => { node.attrs[key] = value; };
  node.addEventListener = (name, callback) => { node.listeners[name] = callback; };
  node.removeEventListener = name => { delete node.listeners[name]; };
  node.append = (...items) => { node.children.push(...items); for (const item of items) if (typeof item === 'object') item.parentElement = node; };
  node.getBoundingClientRect = () => node.rect || { left: 0, top: 0, right: 120, bottom: 40, width: 120, height: 40 };
  for (const child of node.children) if (typeof child === 'object') child.parentElement = node;
  return node;
}

function editor(saved, fail = false, globals = {}) {
  let writes = 0, renders = 0;
  const h = editorElement;
  const context = {
    OverviewLayout, h, icon: () => 'icon', toggle: (label, on, onchange) => h('toggle', { label, on, onchange }),
    state: { settings: { overviewLayout: saved } }, renderOverview: () => { renders++; }, $: () => null, toast() {},
    api: { setSettings: async patch => { writes++; if (fail) throw new Error('disk unavailable'); return patch; } },
    ...globals,
  };
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(require.resolve('../src/renderer/overview-customize.js'), 'utf8')}\nthis.OverviewEditor = OverviewEditor;`, context);
  const ed = context.OverviewEditor;
  ed.open();
  return {
    ed, state: context.state, get writes() { return writes; }, get renders() { return renders; },
    bar: () => descendants(ed.bar()),
    click: label => descendants(ed.bar()).find(n => n.tag === 'button' && n.children.includes(label)).attrs.onclick(),
  };
}

test('rating breakdown defaults and saved choices normalize independently of stat tiles', () => {
  const layout = OverviewLayout.normalize(null);
  assert.deepEqual(layout.ratingStats.filter(stat => !stat.hidden).map(stat => stat.id), ['winRate', 'kd', 'adr', 'kast', 'headshot']);
  const saved = OverviewLayout.normalize({ ratingStats: [
    { id: 'reaction', hidden: false, span: 8, height: 120 }, { id: 'adr', hidden: true, span: 1, height: -4 }, { id: 'reaction', hidden: true }, { id: 'obsolete' },
  ] });
  assert.deepEqual(saved.ratingStats.slice(0, 2), [{ id: 'reaction', hidden: false, span: 8, height: 120 }, { id: 'adr', hidden: true, span: 3, height: null }]);
  assert.equal(saved.ratingStats.length, OverviewLayout.ratingStats.length);
  assert.deepEqual(saved.stats, layout.stats);
  assert.deepEqual(OverviewLayout.normalize(saved), saved);
});

test('rating breakdown add/remove controls stage changes, cancel, save and reset', async () => {
  const saved = OverviewLayout.normalize(null), ui = editor(saved);
  let entries = ui.state.ovEdit.draft.ratingStats;
  ui.ed.hideRatingStat(entries.find(stat => stat.id === 'adr')).attrs.onclick();
  assert.equal(entries.find(stat => stat.id === 'adr').hidden, true);
  let chips = descendants(ui.ed.chips('ratingStat', entries));
  chips.find(node => node.attrs?.title === 'Add Reaction time').attrs.onclick();
  assert.equal(entries.find(stat => stat.id === 'reaction').hidden, false);
  assert.deepEqual(saved, OverviewLayout.normalize(null));
  assert.equal(ui.writes, 0);
  ui.ed.cancel();
  ui.ed.open();
  entries = ui.state.ovEdit.draft.ratingStats;
  assert.equal(entries.find(stat => stat.id === 'adr').hidden, false);
  assert.equal(entries.find(stat => stat.id === 'reaction').hidden, true);
  ui.ed.hideRatingStat(entries.find(stat => stat.id === 'adr')).attrs.onclick();
  chips = descendants(ui.ed.chips('ratingStat', entries));
  chips.find(node => node.attrs?.title === 'Add Reaction time').attrs.onclick();
  await ui.ed.save();
  assert.equal(ui.state.settings.overviewLayout.ratingStats.find(stat => stat.id === 'adr').hidden, true);
  assert.equal(ui.state.settings.overviewLayout.ratingStats.find(stat => stat.id === 'reaction').hidden, false);
  assert.deepEqual(ui.state.settings.overviewLayout.stats, saved.stats);
  ui.ed.open();
  ui.ed.reset();
  assert.deepEqual(ui.state.ovEdit.draft.ratingStats, saved.ratingStats);
});

test('rating panel renders selected stats and handles missing timing data and an empty breakdown', () => {
  const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  const ui = editor(null);
  const context = {
    OverviewLayout, OverviewEditor: ui.ed, state: ui.state,
    h: editorElement,
    pct: (a, b) => b ? Math.round(a / b * 100) : 0, clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    qualityClass: () => 'good', fmtNum: String,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const per ='), source.indexOf('// Distribution of a stat'))
    + source.slice(source.indexOf('const RATING_LEVELS ='), source.indexOf('\nfunction renderOverview()'))
    + '\nthis.scorePanel = scorePanel;', context);
  const totals = { rating: 1.1, won: 1, played: 2, lost: 1, tied: 0, kills: 30, deaths: 20, kd: 1.5, adr: 80,
    damage: 3200, rounds: 40, kastRounds: 28, hs: 15, multi: {}, fk: 2, fd: 2, utility: 100, flashed: 4, aim: { reaction: [], ttd: [] } };
  const layout = ui.state.ovEdit.draft;
  layout.ratingStats.find(stat => stat.id === 'adr').hidden = true;
  layout.ratingStats.find(stat => stat.id === 'reaction').hidden = false;
  let nodes = descendants(context.scorePanel(totals, totals, [], layout));
  const rows = nodes.filter(node => node.attrs?.['data-rating-stat']);
  assert.deepEqual(rows.map(row => row.attrs['data-rating-stat']), ['winRate', 'kd', 'kast', 'headshot', 'reaction']);
  assert(descendants(rows.at(-1)).some(node => node.children.includes('—')));
  assert.equal(nodes.filter(node => node.attrs?.class === 'ov-breakdown-hide').length, 5);
  totals.aim.reaction = [100, 300];
  nodes = descendants(context.scorePanel(totals, totals, [], layout));
  assert(nodes.some(node => node.children.includes('200 ms')));
  ui.state.ovEdit = null;
  layout.ratingStats.find(stat => stat.id === 'reaction').span = 9;
  layout.ratingStats.find(stat => stat.id === 'reaction').height = 120;
  layout.ratingStats.reverse();
  nodes = descendants(context.scorePanel(totals, totals, [], layout));
  assert.equal(nodes.some(node => node.tag === 'button'), false);
  const savedRows = nodes.filter(node => node.attrs?.['data-rating-stat']);
  assert.equal(savedRows[0].attrs['data-rating-stat'], 'reaction');
  assert.equal(savedRows[0].attrs.style['--mspan'], 9);
  assert.equal(savedRows[0].attrs.style['--rh'], '120px');
  for (const entry of layout.ratingStats) entry.hidden = true;
  nodes = descendants(context.scorePanel(totals, totals, [], layout));
  assert.equal(nodes.some(node => node.children.includes('Breakdown')), false);
  ui.state.ovEdit = { draft: layout };
  nodes = descendants(context.scorePanel(totals, totals, [], layout));
  assert(nodes.some(node => node.children.includes('No breakdown stats. Add them with the + buttons above.')));
  assert.equal(nodes.filter(node => node.attrs?.class === 'ov-tray-chip').length, layout.ratingStats.length);
});

test('editor reorders shown entries and keeps hidden ones in their slots', () => {
  const ui = editor(null), list = [{ id: 'a' }, { id: 'b', hidden: true }, { id: 'c' }, { id: 'd' }];
  ui.ed.reorder(list, ['d', 'a', 'c']);
  assert.deepEqual(list.map(e => e.id), ['d', 'b', 'a', 'c']);
  assert.equal(ui.ed.step(list, 'd', 1), true);
  assert.deepEqual(list.map(e => e.id), ['a', 'b', 'd', 'c']);
  assert.equal(ui.ed.step(list, 'a', -1), false);
});

test('breakdown stats drag independently and resize with saved order and dimensions', async () => {
  const globals = {
    document: { addEventListener() {}, querySelector: () => ({ focus() {} }) },
    getComputedStyle: () => ({ columnGap: '0' }), performance: { now: () => 1000 }, setTimeout: fn => fn(),
  };
  const ui = editor(null, false, globals), entries = ui.state.ovEdit.draft.ratingStats;
  const makeRow = entry => ui.ed.editable(editorElement('div', { style: { '--mspan': entry.span || 6 } }), 'ratingStat', entry, entries);
  const first = makeRow(entries[0]), second = makeRow(entries[1]);
  const grid = editorElement('div', {}, first, second);
  grid.rect = { left: 0, top: 0, right: 264, bottom: 40, width: 264, height: 40 };
  first.rect = { left: 0, top: 0, right: 132, bottom: 40, width: 132, height: 40 };
  second.rect = { left: 132, top: 0, right: 264, bottom: 40, width: 132, height: 40 };
  second.animate = () => {};
  grid.insertBefore = (node, before) => {
    grid.children.splice(grid.children.indexOf(node), 1);
    grid.children.splice(before ? grid.children.indexOf(before) : grid.children.length, 0, node);
  };
  ui.ed.sortable(grid, entries);
  let stopped = 0;
  const event = { target: first, preventDefault() {}, stopPropagation() { stopped++; },
    dataTransfer: { setData() {}, dropEffect: 'move' } };
  grid.listeners.dragstart(event);
  assert.equal(ui.ed.paused(), true);
  grid.listeners.dragover({ ...event, target: second, clientX: 250, clientY: 20 });
  grid.listeners.dragend(event);
  assert.equal(ui.ed.paused(), false);
  assert.equal(stopped, 3, 'nested drag events do not reach the rating card or section');
  assert.deepEqual(entries.slice(0, 2).map(entry => entry.id), ['kd', 'winRate']);
  const resize = first.children.find(node => node.attrs.class === 'ov-resize ov-resize-xy');
  resize.attrs.onpointerdown({ ...event, button: 0, pointerId: 1, clientY: 40 });
  assert.equal(ui.ed.paused(), true);
  resize.listeners.pointermove({ clientX: 198, clientY: 100 });
  assert.equal(first.style['--mspan'], 9);
  assert.equal(first.style['--rh'], '100px');
  resize.listeners.pointerup();
  assert.equal(ui.ed.paused(), false);
  assert.equal(entries.find(entry => entry.id === 'winRate').span, 9);
  assert.equal(entries.find(entry => entry.id === 'winRate').height, 100);
  await ui.ed.save();
  const saved = ui.state.settings.overviewLayout;
  assert.deepEqual(saved.ratingStats.slice(0, 2).map(entry => entry.id), ['kd', 'winRate']);
  assert.equal(saved.ratingStats[1].span, 9);
  assert.equal(saved.ratingStats[1].height, 100);
  ui.ed.open();
  const reopened = ui.state.ovEdit.draft.ratingStats;
  const node = ui.ed.editable(editorElement('div', { style: { '--mspan': 9 } }), 'ratingStat', reopened[1], reopened);
  const sibling = editorElement('div', { style: { '--mspan': 6 } });
  sibling.dataset.ovId = 'kd';
  editorElement('div', {}, sibling, node);
  node.listeners.keydown({ ...event, target: node, key: 'ArrowLeft' });
  assert.deepEqual(reopened.slice(0, 2).map(entry => entry.id), ['winRate', 'kd']);
  const width = node.children.find(child => child.attrs.class === 'ov-resize ov-resize-x');
  width.attrs.onkeydown({ ...event, key: 'ArrowLeft' });
  assert.equal(reopened[0].span, 8);
  const corner = node.children.find(child => child.attrs.class === 'ov-resize ov-resize-xy');
  corner.attrs.ondblclick();
  assert.equal(reopened[0].span, null);
  assert.equal(reopened[0].height, null);
  assert.equal(reopened[1].span, 6, 'resetting a stat keeps its neighbour size');
  ui.ed.cancel();
  assert.equal(ui.state.settings.overviewLayout.ratingStats[1].span, 9, 'cancel discards size and order changes');
});

test('editor stages edits on the page, cancels without writing and saves the dragged order', async () => {
  const original = OverviewLayout.normalize(null);
  let ui = editor(original);
  const draft = ui.state.ovEdit.draft;
  ui.ed.step(draft.sections, 'performance', 1);
  draft.sections.find(s => s.id === 'performance').hidden = true;
  assert.equal(ui.writes, 0);
  assert.equal(original.sections[0].id, 'performance');
  ui.click('Cancel');
  assert.equal(ui.state.ovEdit, null);
  assert.equal(ui.writes, 0);
  ui = editor(original);
  ui.ed.step(ui.state.ovEdit.draft.sections, 'performance', 1);
  ui.state.ovEdit.draft.sections[1].hidden = true;
  await ui.ed.save();
  assert.equal(ui.writes, 1);
  assert.equal(ui.state.ovEdit, null);
  assert.equal(ui.state.settings.overviewLayout.sections[1].id, 'performance');
  assert.equal(ui.state.settings.overviewLayout.sections[1].hidden, true);
});

test('Hidden tray lists sections only; hidden modules and stats get + chips at their place', () => {
  const saved = OverviewLayout.normalize(null);
  saved.stats[0].hidden = true;
  saved.modules.duels[2].hidden = true;
  const ui = editor(saved);
  const tray = ui.bar().filter(n => n.attrs.class === 'ov-tray-chip').map(n => n.children[1]);
  assert.deepEqual(tray, ['Maps', 'Weapons', 'Squad', 'Habits & records']);
  const draft = ui.state.ovEdit.draft;
  const duelChips = descendants(ui.ed.chips('module', draft.modules.duels, 'duels')).filter(n => n.tag === 'button');
  assert.deepEqual(duelChips.map(n => n.children[1]), ['T / CT sides', 'Aim timing', 'Headshots', 'Utility', 'Impact per round']);
  const statChips = descendants(ui.ed.chips('stat', draft.stats)).filter(n => n.tag === 'button');
  assert.deepEqual(statChips.map(n => n.children[1]), ['K/D ratio']);
  statChips[0].attrs.onclick();
  assert.equal(draft.stats[0].hidden, false);
  assert.equal(ui.ed.chips('module', draft.modules.performance, 'performance'), null);
  ui.click('Comfortable');
  ui.bar().find(n => n.tag === 'toggle').attrs.onchange(false);
  assert.equal(draft.density, 'comfortable');
  assert.equal(draft.histograms, false);
  assert.equal(ui.state.settings.overviewLayout, saved);
});

test('editor saves a reset and keeps failed edits available to retry', async () => {
  const saved = OverviewLayout.normalize(null);
  saved.stats.reverse();
  saved.density = 'comfortable';
  let ui = editor(saved);
  ui.click('Reset to default');
  await ui.click('Save layout');
  assert.deepEqual(ui.state.settings.overviewLayout, OverviewLayout.normalize(null));
  ui = editor(saved, true);
  ui.state.ovEdit.draft.histograms = false;
  await ui.click('Save layout');
  assert.equal(ui.state.settings.overviewLayout, saved);
  assert.equal(ui.state.ovEdit.saving, false);
  assert.equal(ui.state.ovEdit.draft.histograms, false);
  assert(ui.bar().some(n => n.children.includes('Could not save layout: disk unavailable')));
});

test('edit mode renders the draft, keeps empty sections editable and replaces the Customize button', () => {
  const draft = OverviewLayout.normalize(null);
  for (const module of draft.modules.history) module.hidden = true;
  draft.sections[2].hidden = true;
  const nodes = descendants(renderer(null, { draft }));
  assert.equal(nodes.some(n => /ov-customize-button/.test(n.attrs.class || '')), false);
  assert.equal(nodes.filter(n => n.tag === 'editbar').length, 1);
  assert.deepEqual(nodes.filter(n => n.tag === 'editsection').map(n => n.attrs.id), ['performance', 'history']);
  assert.equal(nodes.filter(n => /ov-module-/.test(n.attrs.class || '')).length, 2);
});

test('every optional module renders from real-shaped totals, with and without data', () => {
  const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  const h = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(x => x != null && x !== false) });
  const context = {
    h, card: (title, body) => h('card', { title }, body), barList: rows => h('bars', {}, ...rows.map(r => h('row', r, r.label, r.value))),
    big: (v, u, note) => h('big', {}, v, u, note), kv: rows => h('kv', {}, ...rows.flat()), pct: (a, b) => (b ? Math.round(100 * a / b) : 0),
    fmtNum: n => String(Math.round(n)), fmtDate: d => String(d), UI_LOCALE: 'en-GB', mapName: m => m, mapThumb: m => h('thumb', {}, m), openMatch() {}, selectPlayer() {},
    avatar: () => h('avatar'), weaponIcon: c => h('img', { c }), overviewMedian: v => (v?.length ? [...v].sort((a, b) => a - b)[v.length >> 1] : null),
    qualityClass: (v, g, b) => (v >= g ? 'good' : v < b ? 'bad' : 'mid'), ratingClass: () => '', state: { ov: {} }, renderOverview() {},
    RATING_LEVELS: [[1.2, 'Excellent'], [1.08, 'Good'], [0.95, 'Average'], [0.85, 'Below average'], [-Infinity, 'Poor']],
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(source.indexOf('function aggregate(list)'), source.indexOf('// Small building blocks'))}
${fs.readFileSync(require.resolve('../src/renderer/overview-modules.js'), 'utf8')}
this.aggregate = aggregate; this.OverviewModules = OverviewModules;`, context);
  const side = (rounds, won) => ({ rounds, won, fk: 1, fd: 1 });
  const match = (i, result, map, rating) => ({
    id: i, map, mode: i % 2 ? 'Premier' : 'Competitive', date: Date.UTC(2026, 9, 1 + i, 8 + i * 3), result, score: result === 'W' ? [13, 9 - i] : [5 + i, 13],
    rating, rounds: 22, kills: 15 + i, deaths: 14, assists: 4, hsKills: 7, damage: 1700 + 40 * i, kastRounds: 16, firstKills: 2, firstDeaths: 2,
    tradeKills: 2, utilityDamage: 90, enemiesFlashed: 5, flashAssists: 1, aim: { reaction: [300 + i, 420], ttd: [480] },
    side: { T: side(11, 6), CT: side(11, 5) }, clutches: { vs: { 1: [1, 2] } }, multi: { 2: 2, 3: i % 2, 4: 0, 5: 0 },
    weapons: { 'AK-47': [8, 4], AWP: [4, 1], HE: [1, 0], 'USP-S': [3, 2] }, mates: [['7656', 'Mate'], ['7657', 'Duo']],
  });
  const list = ['W', 'W', 'L', 'W', 'T', 'L'].map((r, i) => match(i, r, i % 3 ? 'de_mirage' : 'de_inferno', 0.8 + i / 10));
  const titles = [];
  for (const sample of [list, []]) {
    const t = context.aggregate(sample);
    for (const ids of OverviewLayout.sections.map(s => s.modules.map(m => m.id))) {
      for (const id of ids.filter(id => context.OverviewModules[id])) {
        const node = context.OverviewModules[id]({ t, list: sample, last10: t });
        assert.equal(node.tag, 'card', id);
        if (sample.length) titles.push(id);
      }
    }
  }
  assert.equal(titles.length, 20);
  const t = context.aggregate(list);
  const streak = descendants(context.OverviewModules.streaks({ t, list }));
  assert(streak.some(n => n.children?.[0] === 2 && n.children?.[1]?.children?.[0] === 'W'));
  const types = descendants(context.OverviewModules.weaponTypes({ t, list })).filter(n => n.tag === 'row').map(n => n.attrs.label);
  assert.deepEqual(types, ['Rifles', 'Snipers', 'Pistols', 'Grenades & Zeus']);
});
