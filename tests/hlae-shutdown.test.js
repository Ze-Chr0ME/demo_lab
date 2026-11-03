const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/lib/hlae.js'), 'utf8');
const start = source.indexOf('  async quit(');
const method = source.slice(start, source.indexOf('\n}', start));

async function shutdown(hung) {
  let now = 0, queries = 0, destroyed = false;
  const commands = [], killed = [];
  const ctx = vm.createContext({
    Date: { now: () => now },
    sleep: async ms => { now += ms; },
    cs2Pids: () => ++queries === 1 ? [42] : (hung ? [42, 99] : []),
    execFileSync: (exe, args) => { assert.equal(exe, 'taskkill'); killed.push(args[1]); },
  });
  vm.runInContext(`globalThis.Session = class { ${method} };`, ctx);
  const session = new ctx.Session();
  session.sock = { destroy: () => { destroyed = true; } };
  session.send = async cmds => commands.push(...cmds);
  session.log = () => {};
  await session.quit({ timeoutMs: 1000 });
  assert.deepEqual(commands, ['quit']);
  assert(destroyed);
  assert.equal(session.sock, null);
  return { now, killed };
}

test('scenario shutdown force-closes a hung session after one second, leaving new processes alone', async () => {
  const { now, killed } = await shutdown(true);
  assert.equal(now, 1000);
  assert.deepEqual(killed, ['42']);
});

test('scenario shutdown returns immediately when CS2 exits normally', async () => {
  const { now, killed } = await shutdown(false);
  assert.equal(now, 0);
  assert.deepEqual(killed, []);
});
