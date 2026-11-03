const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const SteamUser = require('steam-user');
const { EAuthSessionGuardType } = require('steam-session');
const GlobalOffensive = require('globaloffensive');
const { SteamClient } = require('../src/lib/steamClient');

const STEAMID = '76561198000000000';
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const user = new EventEmitter();
  const gc = new EventEmitter();
  const session = new EventEmitter();
  session.accountName = 'my-account';
  session.steamID = { getSteamID64: () => STEAMID };
  session.refreshToken = 'secret-token';
  session.startWithCredentials = async () => {
    queueMicrotask(() => session.emit('authenticated'));
    return { actionRequired: false };
  };
  session.cancelLoginAttempt = () => calls.push(['cancelLoginAttempt']);
  session.submitSteamGuardCode = async () => {};

  const calls = [];
  user.steamID = { getSteamID64: () => STEAMID };
  user.logOn = details => {
    calls.push(['logOn', details]);
    queueMicrotask(() => { user.emit('refreshToken', 'secret-token'); user.emit('loggedOn', {}); });
  };
  user.logOff = () => { calls.push(['logOff']); user.emit('disconnected', 0); };
  user.gamesPlayed = games => {
    calls.push(['gamesPlayed', games]);
    if (games.length) { gc.haveGCSession = true; gc.emit('connectedToGC'); }
  };
  gc.inventory = [];
  gc._send = (type, proto, { casket_item_id: id }) => {
    gc.emit('itemCustomizationNotification', [id], GlobalOffensive.ItemCustomizationNotification.CasketContents);
  };
  const logs = [];
  const client = new SteamClient(dir, {
    encrypt: value => Buffer.from('encrypted:' + value),
    decrypt: value => value.toString().slice('encrypted:'.length),
    log: (...args) => logs.push(args), makeUser: () => user, makeGC: () => gc, makeSession: () => session, ...options,
  });
  return { dir, user, gc, session, client, calls, logs };
}
const signIn = client => client.login({ username: 'my-account', password: 'never-save-this-password' });

test('readStorage refuses while CS2 is running without making a Steam client', async t => {
  const { client, calls } = setup(t, { isGameRunning: () => true, makeUser: () => assert.fail('must not connect') });
  await assert.rejects(client.readStorage(), { message: 'Close CS2 first: reading storage units signs DemoLab in to CS2 and would kick your game.' });
  assert.equal(client.status().busy, false);
  assert.deepEqual(calls, []);
});

test('login persists only encrypted token and identity without Steam user logOn', async t => {
  const { client, dir, calls, logs } = setup(t);
  assert.deepEqual(await signIn(client), { account: 'my-account', steamid: STEAMID });
  const raw = fs.readFileSync(path.join(dir, 'steam-client.json'), 'utf8');
  const saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved).sort(), ['account', 'refreshToken', 'steamid']);
  assert.equal(Buffer.from(saved.refreshToken, 'base64').toString(), 'encrypted:secret-token');
  assert(!raw.includes('secret-token'));
  assert(!raw.includes('never-save-this-password'));
  assert(!JSON.stringify(logs).includes('never-save-this-password'));
  assert.equal(calls.filter(c => c[0] === 'logOn').length, 0);
  assert.equal(calls.filter(c => c[0] === 'cancelLoginAttempt').length, 1);
  const restored = new SteamClient(dir);
  assert.deepEqual(restored.status(), { signedIn: true, account: 'my-account', steamid: STEAMID, busy: false });
  client.logout();
  assert(!fs.existsSync(path.join(dir, 'steam-client.json')));
  assert.equal(client.status().signedIn, false);
});

test('storage snapshot has the exact envelope and JSON-safe GC items', async t => {
  const progress = [];
  const { client, user, gc, dir, calls } = setup(t, { onProgress: value => progress.push(value) });
  await signIn(client);
  gc.inventory = [
    { id: '100', custom_name: 'My skins', casket_contained_item_count: 1 },
    { id: '101', def_index: 1201 },
    { id: '102', def_index: 7 },
  ];
  const long = { toUnsigned() { return this; }, toString() { return '9007199254740993'; } };
  const item = { id: 123n, def_index: 7, paint_index: 44, paint_wear: 0.02, paint_seed: 9, quality: 4,
    rarity: 5, custom_name: 'Skin', stickers: [{ slot: 0, sticker_id: 12, wear: 0.1 }],
    keychains: [{ slot: 0, sticker_id: 33, seed: 4 }], music_index: 3, graffiti_tint: 2, origin: 1,
    long, bytes: Buffer.from('item'), ignored() {} };
  gc._send = (type, proto, { casket_item_id: id }) => {
    gc.inventory.push({ ...item, casket_id: id });
    gc.emit('itemCustomizationNotification', [id], GlobalOffensive.ItemCustomizationNotification.CasketContents);
  };
  const result = await client.readStorage();
  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'inventory', `storage-${STEAMID}.json`), 'utf8'));
  assert.deepEqual(Object.keys(snapshot).sort(), ['t', 'units']);
  assert.equal(result.steamid, STEAMID);
  assert.equal(snapshot.t, result.t);
  assert.deepEqual(snapshot.units, result.units);
  assert.deepEqual(Object.keys(snapshot.units[0]).sort(), ['count', 'id', 'items', 'name']);
  assert.equal(snapshot.units[0].items[0].id, '123');
  assert.equal(snapshot.units[0].items[0].long, '9007199254740993');
  assert.equal(snapshot.units[0].items[0].bytes, Buffer.from('item').toString('base64'));
  assert.equal(snapshot.units[0].items[0].ignored, undefined);
  assert.deepEqual(snapshot.units[0].items[0].keychains, item.keychains);
  assert.deepEqual(snapshot.units[1], { id: '101', name: 'Storage Unit', count: 0, items: [] });
  assert.deepEqual(progress, [{ done: 0, total: 2 }, { done: 1, total: 2 }, { done: 2, total: 2 }]);
  assert.deepEqual(calls.at(-2), ['gamesPlayed', []]);
  assert.deepEqual(calls.at(-1), ['logOff']);
  assert.equal(calls.findLast(c => c[0] === 'logOn')[1].refreshToken, 'secret-token');
  assert.equal(user.listenerCount('steamGuard'), 0);
});

test('casket failure always quits CS2 and logs off without writing a snapshot', async t => {
  const { client, gc, calls, dir } = setup(t);
  await signIn(client);
  gc.inventory = [{ id: '1', casket_contained_item_count: 1 }];
  gc._send = () => { throw new Error('GC failed'); };
  await assert.rejects(client.readStorage(), /GC failed/);
  assert.deepEqual(calls.slice(-2), [['gamesPlayed', []], ['logOff']]);
  assert.equal(client.status().busy, false);
  assert(!fs.existsSync(path.join(dir, 'inventory', `storage-${STEAMID}.json`)));
});

test('phone approval completes login while the Guard prompt is open', async t => {
  const prompts = [];
  const { client, session, user } = setup(t, { onGuard: value => prompts.push(value) });
  session.startWithCredentials = async () => ({ actionRequired: true,
    validActions: [{ type: EAuthSessionGuardType.DeviceConfirmation }] });
  const pending = signIn(client);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prompts, [{ kind: 'app', domain: null, wrong: false }]);
  assert.equal(client.status().busy, true);
  await assert.rejects(signIn(client), /already running/);
  session.emit('authenticated');
  assert.deepEqual(await pending, { account: 'my-account', steamid: STEAMID });
  assert.equal(client.status().busy, false);
  assert.equal(session.eventNames().length, 0);
  assert.equal(user.eventNames().length, 0);
});

test('wrong Guard code re-prompts and a replacement completes login', async t => {
  const prompts = [];
  const { client, session } = setup(t, { onGuard: value => prompts.push(value) });
  session.startWithCredentials = async () => ({ actionRequired: true,
    validActions: [{ type: EAuthSessionGuardType.EmailCode, detail: 'mail.test' },
      { type: EAuthSessionGuardType.DeviceConfirmation }] });
  session.submitSteamGuardCode = async code => {
    if (code === 'wrong') throw Object.assign(new Error('InvalidLoginAuthCode'), { eresult: SteamUser.EResult.InvalidLoginAuthCode });
    assert.equal(code, '12345');
    session.emit('authenticated');
  };
  const pending = signIn(client);
  await new Promise(resolve => setImmediate(resolve));
  await client.guardCode('wrong');
  await client.guardCode(' 12345 ');
  await pending;
  assert.deepEqual(prompts, [{ kind: 'email', domain: 'mail.test', wrong: false },
    { kind: 'email', domain: 'mail.test', wrong: true }]);
  assert.throws(() => client.guardCode('x'), /not waiting/);
});

test('rejected refresh token is forgotten, and login errors are plain English', async t => {
  const { client, user, session, dir, calls } = setup(t);
  await signIn(client);
  user.logOn = () => queueMicrotask(() => user.emit('error', { eresult: SteamUser.EResult.InvalidPassword }));
  await assert.rejects(client.readStorage(), /Sign in to Steam again\./);
  assert.equal(client.status().signedIn, false);
  assert(!fs.existsSync(path.join(dir, 'steam-client.json')));
  session.startWithCredentials = async () => { throw Object.assign(new Error('bad password'), { eresult: SteamUser.EResult.InvalidPassword }); };
  await assert.rejects(signIn(client), /Incorrect Steam account name or password/);
  assert.deepEqual(calls.at(-1), ['cancelLoginAttempt']);
});

test('LoggedInElsewhere aborts a pending GC read and preserves the refresh token', async t => {
  const { client, gc, user, calls } = setup(t);
  await signIn(client);
  gc.inventory = [{ id: '1', casket_contained_item_count: 1 }];
  gc._send = () => queueMicrotask(() => user.emit('error', { eresult: SteamUser.EResult.LoggedInElsewhere }));
  await assert.rejects(client.readStorage(), /Steam signed DemoLab out because CS2 started on this account\./);
  assert.deepEqual(calls.slice(-2), [['gamesPlayed', []], ['logOff']]);
  assert.equal(client.status().signedIn, true);
});

test('game starting during a read aborts and logs off', async t => {
  let running = false;
  const { client, gc, calls } = setup(t, { isGameRunning: () => running });
  await signIn(client);
  gc.inventory = [{ id: '1', casket_contained_item_count: 1 }];
  gc._send = () => { running = true; };
  await assert.rejects(client.readStorage(), /CS2 started on this account/);
  assert.deepEqual(calls.slice(-2), [['gamesPlayed', []], ['logOff']]);
});

test('unavailable encryption refuses to save credentials and still logs off', async t => {
  const { client, dir, calls } = setup(t, { encrypt: () => { throw new Error('Secure storage is unavailable.'); } });
  await assert.rejects(signIn(client), /Secure storage is unavailable/);
  assert(!fs.existsSync(path.join(dir, 'steam-client.json')));
  assert.deepEqual(calls.at(-1), ['cancelLoginAttempt']);
  assert.equal(client.status().busy, false);
});


test('cancel during login clears busy, cancels polling and allows another login', async t => {
  const { client, session, calls } = setup(t);
  const normalStart = session.startWithCredentials;
  session.startWithCredentials = async () => ({ actionRequired: true,
    validActions: [{ type: EAuthSessionGuardType.DeviceCode }] });
  const pending = signIn(client);
  const rejected = assert.rejects(pending, /^Error: Cancelled$/);
  await new Promise(resolve => setImmediate(resolve));
  await client.cancel();
  await rejected;
  assert.equal(client.status().busy, false);
  assert.equal(session.eventNames().length, 0);
  assert(calls.some(c => c[0] === 'cancelLoginAttempt'));
  assert.throws(() => client.guardCode('x'), /not waiting/);
  session.startWithCredentials = normalStart;
  await signIn(client);
});

for (const reason of ['cancel', 'GC error']) {
  test(reason + ' during casket read clears busy, removes listeners and logs off', async t => {
    const { client, gc, user, calls, dir } = setup(t);
    await signIn(client);
    gc.inventory = [{ id: '1', casket_contained_item_count: 1 }];
    let sent;
    const requested = new Promise(resolve => { sent = resolve; });
    gc._send = () => sent();
    const pending = client.readStorage();
    const rejected = assert.rejects(pending, reason === 'cancel' ? /^Error: Cancelled$/ : /fatal GC/);
    await requested;
    assert.equal(gc.listenerCount('itemCustomizationNotification'), 1);
    if (reason === 'cancel') await client.cancel();
    else gc.emit('error', new Error('fatal GC'));
    await rejected;
    assert.equal(client.status().busy, false);
    assert.equal(gc.eventNames().length, 0);
    assert.equal(user.eventNames().length, 0);
    assert.deepEqual(calls.slice(-2), [['gamesPlayed', []], ['logOff']]);
    assert(!fs.existsSync(path.join(dir, 'inventory', `storage-${STEAMID}.json`)));
  });
}


for (const event of ['timeout', 'error']) {
  test('login ' + event + ' releases all session listeners', async t => {
    const { client, session } = setup(t);
    session.startWithCredentials = async () => ({ actionRequired: true,
      validActions: [{ type: EAuthSessionGuardType.DeviceCode }] });
    const pending = signIn(client);
    const rejected = assert.rejects(pending, event === 'timeout' ? /timed out/ : /Steam connection failed/);
    await new Promise(resolve => setImmediate(resolve));
    session.emit(event, new Error('connection lost'));
    await rejected;
    assert.equal(client.status().busy, false);
    assert.equal(session.eventNames().length, 0);
  });
}

test('cancel before credentials resolve also cancels polling started by a late response', async t => {
  const { client, session, calls } = setup(t);
  let resolveStart;
  session.startWithCredentials = () => new Promise(resolve => { resolveStart = resolve; });
  const pending = signIn(client);
  const rejected = assert.rejects(pending, /Cancelled/);
  await client.cancel();
  await rejected;
  resolveStart({ actionRequired: true, validActions: [{ type: EAuthSessionGuardType.DeviceConfirmation }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.status().busy, false);
  assert.equal(session.eventNames().length, 0);
  assert.equal(calls.filter(c => c[0] === 'cancelLoginAttempt').length, 2);
});

test('cancel immediately after authenticated rejects login without saving a token', async t => {
  const { client, session, dir } = setup(t);
  session.startWithCredentials = async () => ({ actionRequired: false });
  const pending = signIn(client);
  const rejected = assert.rejects(pending, /^Error: Cancelled$/);
  await new Promise(resolve => setImmediate(resolve));
  session.emit('authenticated');
  await client.cancel();
  await rejected;
  assert.equal(client.status().busy, false);
  assert.equal(client.status().signedIn, false);
  assert(!fs.existsSync(path.join(dir, 'steam-client.json')));
  assert(!fs.existsSync(path.join(dir, 'steam-client.json.tmp')));
});

// Match the five SteamUser subscriptions in GlobalOffensive 3.3.0's constructor.
function attachFakeGC(user, gc) {
  user.on('receivedFromGC', () => gc.emit('error', new Error('late fatal GC packet')));
  user.on('appLaunched', () => {});
  user.on('appQuit', () => { clearInterval(gc._helloInterval); });
  user.on('disconnected', () => {});
  user.on('error', () => {});
  return gc;
}

test('GC errors remain handled during asynchronous logOff and its user listeners are disposed', async t => {
  const { client, user, gc } = setup(t);
  client.makeGC = steam => attachFakeGC(steam, gc);
  const unrelated = () => {};
  user.on('receivedFromGC', unrelated);
  await signIn(client);
  let finishLogOff;
  const loggingOff = new Promise(resolve => {
    user.logOff = () => { finishLogOff = () => user.emit('disconnected', 0); resolve(); };
  });
  const pending = client.readStorage();
  await loggingOff;
  assert.equal(client.status().busy, true);
  assert.doesNotThrow(() => user.emit('receivedFromGC'));
  assert.doesNotThrow(() => gc.emit('error', new Error('late GC error')));
  assert.doesNotThrow(() => user.emit('error', new Error('late Steam error')));
  finishLogOff();
  await pending;
  assert.equal(client.status().busy, false);
  assert.deepEqual(user.listeners('receivedFromGC'), [unrelated]);
  assert.doesNotThrow(() => user.emit('receivedFromGC'));
  user.removeListener('receivedFromGC', unrelated);
  assert.deepEqual(user.eventNames(), []);
  assert.deepEqual(gc.eventNames(), []);
});

test('cancel while connecting clears both GC hello timers and detaches the GC bridge', async t => {
  const { client, user, gc, dir } = setup(t);
  client.makeGC = steam => attachFakeGC(steam, gc);
  await signIn(client);
  let connecting;
  const started = new Promise(resolve => { connecting = resolve; });
  let helloTimer, helloInterval;
  user.gamesPlayed = games => {
    if (!games.length) { user.emit('appQuit', 730); return; }
    helloTimer = gc._helloTimer = setTimeout(() => assert.fail('hello timer survived cancellation'), 60000);
    helloInterval = gc._helloInterval = setInterval(() => assert.fail('hello interval survived cancellation'), 60000);
    connecting();
  };
  t.after(() => { clearTimeout(helloTimer); clearInterval(helloInterval); });
  const pending = client.readStorage();
  const rejected = assert.rejects(pending, /^Error: Cancelled$/);
  await started;
  await client.cancel();
  await rejected;
  assert.equal(helloTimer._destroyed, true);
  assert.equal(helloInterval._destroyed, true);
  assert.equal(gc._helloTimer, null);
  assert.equal(gc._helloInterval, null);
  assert.deepEqual(user.eventNames(), []);
  assert.deepEqual(gc.eventNames(), []);
  assert.equal(client.status().busy, false);
  assert(!fs.existsSync(path.join(dir, 'inventory', `storage-${STEAMID}.json`)));
});
