const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Scenarios, clean } = require('../src/lib/scenarios');
const bundled = require('../src/data/scenarios.json');

function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demolab-builtins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Scenarios(dir);
}

test('fresh installs have all 100 valid scenarios, ten per map', t => {
  const items = store(t).list();
  assert.equal(items.length, 100);
  assert.equal(new Set(items.map(s => s.id)).size, 100);
  const maps = {};
  for (const s of items) {
    assert.equal(s.builtin, true);
    assert.equal(clean(s).id, s.id);
    maps[s.map] = (maps[s.map] || 0) + 1;
  }
  assert.equal(Object.keys(maps).length, 10);
  assert(Object.values(maps).every(n => n === 10));
});

test('existing copies are not duplicated and custom saves keep the collection separate', t => {
  const s = store(t);
  s.write(bundled);
  assert.equal(s.list().length, 100);
  const custom = s.save({ ...bundled[0], id: 'custom1', name: 'My practice' });
  assert.equal(s.list().length, 101);
  assert.equal(s.get(custom.id).builtin, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')).map(x => x.id), ['custom1']);
  assert.deepEqual(s.get(bundled[0].id), { ...bundled[0], builtin: true });
  s.remove(custom.id);
  assert.equal(s.list().length, 100);
});

test('built-ins cannot be overwritten, deleted or changed by training mutations', t => {
  const s = store(t), original = s.list()[0];
  assert.throws(() => s.save({ ...original, name: 'Changed' }), /cannot be edited/);
  assert.throws(() => s.remove(original.id), /cannot be deleted/);
  original.bots[0].jiggleAt = [[0, 0, 0]];
  original.me.pos[0] = 999999;
  original.options.reps = 50;
  assert.deepEqual(s.get(original.id), { ...bundled[0], builtin: true });
});

test('built-in cards have no edit or delete actions, while custom cards keep them', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scenarios.js'), 'utf8');
  const ctx = vm.createContext({
    h: (tag, props, ...children) => ({ tag, props, children: children.flat().filter(Boolean) }),
    scPreview: () => null, scVersions: () => null, running: () => false,
    icon: () => null, ICONS: {}, SC_ICONS: {},
  });
  vm.runInContext(source.slice(source.indexOf('function scCard('), source.indexOf('// ---------- the buy menu')), ctx);
  const titles = node => [node.props?.title, ...(node.children || []).flatMap(c => typeof c === 'object' ? titles(c) : [])].filter(Boolean);
  const builtin = ctx.scCard({ ...bundled[0], builtin: true }, []);
  assert.equal(builtin.children[0].tag, 'div');
  assert.equal(builtin.children[0].props.onclick, undefined);
  assert(!titles(builtin).includes('Edit'));
  assert(!titles(builtin).includes('Delete'));
  const custom = ctx.scCard({ ...bundled[0], builtin: false }, []);
  assert.equal(custom.children[0].tag, 'button');
  assert(titles(custom).includes('Edit'));
  assert(titles(custom).includes('Delete'));
});
