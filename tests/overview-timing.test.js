const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { aimTotals } = require('../src/lib/aim');

test('reaction uses a fresh aimed shot; damage keeps its own timing and first-hit filter', () => {
  const facts = { tickrate: 64, weapons: ['ak47'], players: { me: {
    shots: [[104, 0, 0, 8, 4, 0], [108, 0, 0, 0, 64, 0], [116, 0, 0, 8, 64, 1]],
    eng: [[100, 'enemy', 2, 500, 32, 1, 1], [300, 'enemy', 3, 500, 16, 2, 2]],
  } } };
  const totals = aimTotals(facts, 'me');
  assert.deepEqual(totals.reaction, [250]);
  assert.deepEqual(totals.ttd, [500]);
  assert.equal(aimTotals(facts, 'missing'), null);
});

test('overview pools samples across matches and leaves unavailable timing empty', () => {
  const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function aggregate(list)'), source.indexOf('// Small building blocks'))
    + source.slice(source.indexOf('const per ='), source.indexOf('// Distribution of a stat'))
    + '\nthis.tiles = TILES;', ctx);
  const match = aim => ({ rounds: 10, kills: 5, deaths: 5, clutches: {}, multi: {}, weapons: {}, aim });
  const matches = [match({ reaction: [100, 200, 300], ttd: [200, 400, 600] }), match({ reaction: [900], ttd: [1000] }), match(null)];
  ctx.matches = matches;
  const totals = vm.runInContext('aggregate(matches)', ctx);
  const reaction = ctx.tiles.find(t => t.k === 'Reaction time');
  const damage = ctx.tiles.find(t => t.k === 'Time to Damage');
  assert.equal(reaction.t(totals), 250);
  assert.equal(damage.t(totals), 500);
  assert.equal(reaction.m(matches[2]), null);
  assert.equal(damage.m(matches[2]), null);
  assert.equal(reaction.low, true);
  assert.equal(damage.u, ' ms');
});
