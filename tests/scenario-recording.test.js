const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

async function record({ me = { pos: [0, 0, 0], yaw: 0 }, bots = [{}], discard = false, error = false, quitError = false } = {}) {
  const events = [];
  const updates = [];
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const session = { quit: async options => {
    events.push('quit');
    assert.equal(options.timeoutMs, 1000);
    assert(ctx.training, 'keep the session busy until shutdown completes');
    setImmediate(() => finish(updates.at(-1)));
    if (quitError) throw new Error('quit failed');
  } };
  const ctx = vm.createContext({
    training: null, recorder: null, watching: false, viewer: { session },
    env: { csgoDir: 'csgo' }, hlae: { missingFiles: () => [] }, hlaeDir: () => 'hlae',
    gsiServer: () => ({ start: async () => {}, install: () => false }),
    trainingDir: () => 'binds.json', viewerSession: async () => session,
    log: () => {}, send: (_name, status) => {
      updates.push(status);
    },
    scenarios: () => ({ save: draft => { events.push('save'); return draft; } }),
    runRecorder: async (_plan, io) => {
      ctx.training.rec = { me, bots };
      ctx.finishNow();
      assert.equal(io.cancelled(), true, 'F3 finishes the active recording');
      ctx.training.discard = discard;
      events.push('restore binds');
      if (error) throw new Error('recording failed');
      return { me, bots };
    },
  });
  vm.runInContext(main.slice(main.indexOf('async function startRecorder('), main.indexOf('// Moves the session\'s demo')), ctx);
  vm.runInContext(main.slice(main.indexOf('function finishNow('), main.indexOf('function syncFinishKey(')), ctx);
  await ctx.startRecorder('de_mirage');
  const status = await finished;
  assert.equal(updates.filter(st => ['recorded', 'cancelled', 'error'].includes(st.phase)).length, 1,
    'send the result once when finishing, without replaying it after CS2 closes');
  assert.equal(ctx.training, null);
  assert.equal(ctx.viewer, null, 'release the closed viewer session');
  return { events, status };
}

test('F3 saves the scenario after restoring binds, then closes CS2', async () => {
  const { events, status } = await record();
  assert.deepEqual(events, ['restore binds', 'save', 'quit']);
  assert.equal(status.phase, 'recorded');
  assert.equal(status.saved, true);
});

test('incomplete and discarded recordings also close CS2', async () => {
  for (const options of [{ me: null }, { bots: [] }, { discard: true }]) {
    const { events } = await record(options);
    assert.deepEqual(events, ['restore binds', 'quit']);
  }
});

test('recorder errors still close CS2', async () => {
  const { events, status } = await record({ error: true });
  assert.deepEqual(events, ['restore binds', 'quit']);
  assert.equal(status.phase, 'error');
});

test('a shutdown failure preserves the saved scenario and releases the session', async () => {
  const { status } = await record({ quitError: true });
  assert.equal(status.phase, 'recorded');
  assert.equal(status.saved, true);
});
