const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { guardOutputStream } = require('../src/lib/outputPipes');

test('output guards absorb broken pipes and report other stream errors once', () => {
  const stream = new EventEmitter(), errors = [];
  guardOutputStream(stream, error => errors.push(error));
  guardOutputStream(stream, error => errors.push(error));
  stream.emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' }));
  assert.equal(errors.length, 0);
  const unexpected = Object.assign(new Error('write failed'), { code: 'EIO' });
  stream.emit('error', unexpected);
  assert.deepEqual(errors, [unexpected]);
  assert.equal(stream.listenerCount('error'), 1);
});

test('logging after the launcher closes stdout and stderr does not crash', { timeout: 5000 }, async t => {
  const modulePath = require.resolve('../src/lib/outputPipes');
  const child = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(modulePath)}).guardOutputPipes();
    process.on('message', () => {
      console.log('stdout after pipe closed');
      console.error('stderr after pipe closed');
      setTimeout(() => { process.send('survived'); process.disconnect(); }, 50);
    });
    process.send('ready');
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = once(child, 'exit');
  assert.deepEqual(await once(child, 'message'), ['ready', undefined]);
  child.stdout.destroy();
  child.stderr.destroy();
  const survived = once(child, 'message');
  child.send('write');
  assert.equal((await survived)[0], 'survived');
  assert.deepEqual(await exited, [0, null]);
});
