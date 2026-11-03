const fs = require('fs');
const path = require('path');
const SteamUser = require('steam-user');
const GlobalOffensive = require('globaloffensive');
const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } = require('steam-session');
const GCLanguage = require('globaloffensive/language');
const GCProtos = require('globaloffensive/protobufs/generated/_load');

const CLOSE_GAME = 'Close CS2 first: reading storage units signs DemoLab in to CS2 and would kick your game.';
const KICKED = 'Steam signed DemoLab out because CS2 started on this account.';
const INVALID_TOKEN = new Set(['InvalidPassword', 'InvalidSignature', 'InvalidParam', 'AccessDenied', 'Expired', 'Revoked', 'AccountLogonDenied', 'InvalidLoginAuthCode']);
const MESSAGES = {
  InvalidPassword: 'Incorrect Steam account name or password.',
  RateLimitExceeded: 'Steam is limiting sign-in attempts. Wait a while and try again.',
  AccountLoginDeniedThrottle: 'Too many Steam sign-in attempts. Wait a while and try again.',
  AccountDisabled: 'This Steam account is disabled.',
  AccountNotFound: 'Steam could not find that account.',
  ServiceUnavailable: 'Steam is unavailable. Try again later.',
  NoConnection: 'Could not connect to Steam. Check your connection.',
  InvalidLoginAuthCode: 'The Steam Guard code was incorrect. Try again.',
  TwoFactorCodeMismatch: 'The Steam Guard code was incorrect. Try again.',
  LoggedInElsewhere: KICKED,
  LogonSessionReplaced: KICKED,
};

function plain(value, seen = new Set()) {
  if (typeof value === 'bigint') return value.toString();
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value.toUnsigned === 'function' && typeof value.toString === 'function') return value.toString();
  seen.add(value);
  const out = Array.isArray(value) ? value.map(v => plain(v, seen)) : Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, plain(v, seen)]).filter(([, v]) => v !== undefined));
  seen.delete(value);
  return out;
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

class SteamClient {
  constructor(dir, { log = () => {}, encrypt, decrypt, isGameRunning = () => false, onGuard = () => {}, onProgress = () => {},
    makeUser = () => new SteamUser({ dataDirectory: null, autoRelogin: false, renewRefreshTokens: true }),
    makeGC = user => new GlobalOffensive(user),
    makeSession = () => new LoginSession(EAuthTokenPlatformType.SteamClient) } = {}) {
    Object.assign(this, { dir, log, encrypt, decrypt, isGameRunning, onGuard, onProgress, makeUser, makeGC, makeSession });
    this.file = path.join(dir, 'steam-client.json');
    this.saved = null;
    this.busy = false;
    this.guard = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.refreshToken && saved.account && /^\d+$/.test(saved.steamid)) this.saved = saved;
    } catch (e) { if (e.code !== 'ENOENT') log('Could not read Steam sign-in. Sign in again.'); }
  }

  status() {
    return { signedIn: !!this.saved, account: this.saved?.account || null, steamid: this.saved?.steamid || null, busy: this.busy };
  }

  guardCode(code) {
    if (!this.guard) throw new Error('Steam is not waiting for a Guard code.');
    if (typeof code !== 'string' || !code.trim()) throw new Error('Enter a Steam Guard code.');
    return this.guard(code.trim());
  }

  async cancel() {
    if (this.cancelOperation) await this.cancelOperation();
  }

  logout() {
    if (this.busy) throw new Error('A Steam operation is already running.');
    this._forget();
  }

  _forget() {
    fs.rmSync(this.file, { force: true });
    this.saved = null;
  }

  _save(token, account, steamid) {
    const saved = { refreshToken: this.encrypt(token).toString('base64'), account, steamid };
    writeJSON(this.file, saved);
    this.saved = saved;
  }

  async login({ username, password } = {}) {
    return this._run(false, async op => {
      if (!username || !password) throw new Error('Enter your Steam account name and password.');
      const session = this.makeSession();
      op.cleanup(() => session.cancelLoginAttempt());
      const authenticated = op.event(session, 'authenticated', 120000, 'Steam sign-in timed out. Complete Steam Guard or mobile approval and try again.');
      authenticated.catch(() => {});
      let prompts = [];
      const prompt = wrong => {
        for (const value of prompts) this.onGuard({ ...value, wrong });
      };
      op.listen(session, 'timeout', () => op.abort(new Error('Steam sign-in timed out. Try again.')));
      op.listen(session, 'error', op.error);
      this.guard = async code => {
        try {
          await session.submitSteamGuardCode(code);
        } catch (err) {
          if (!op.active()) return;
          // Code submission rejections are recoverable; keep mobile polling alive.
          try { prompt(true); } catch (e) { op.abort(e); }
        }
      };
      const starting = session.startWithCredentials({ accountName: username, password });
      // Cancellation can precede the credential request completing and starting polling.
      starting.then(() => { if (!op.active()) session.cancelLoginAttempt(); }, () => {});
      let result;
      try { result = await op.wait(starting, 120000, 'Steam sign-in timed out. Try again.'); }
      catch (err) { throw op.error(err) || err; }
      if (!op.active()) throw new Error('Cancelled');
      if (result.actionRequired) {
        const actions = result.validActions || [];
        prompts = actions.flatMap(action => {
          if (action.type === EAuthSessionGuardType.EmailCode) return [{ kind: 'email', domain: action.detail || null }];
          if (action.type === EAuthSessionGuardType.DeviceCode) return [{ kind: 'app', domain: null }];
          return [];
        });
        if (!prompts.length && actions.some(action => action.type === EAuthSessionGuardType.DeviceConfirmation)) {
          prompts = [{ kind: 'app', domain: null }];
        }
        prompt(false);
      }
      await authenticated;
      if (!op.active()) throw new Error('Cancelled');
      const steamid = session.steamID?.getSteamID64();
      if (!steamid || !/^\d+$/.test(steamid)) throw new Error('Steam did not return an account ID.');
      if (!session.refreshToken) throw new Error('Steam did not return a refresh token. Try signing in again.');
      this._save(session.refreshToken, session.accountName, steamid);
      return { account: session.accountName, steamid };
    });
  }

  async readStorage() {
    if (this.isGameRunning()) throw new Error(CLOSE_GAME);
    return this._run(true, async op => {
      if (!this.saved) throw new Error('Sign in to Steam again.');
      const { account, steamid, refreshToken } = this.saved;
      let token;
      try { token = this.decrypt(Buffer.from(refreshToken, 'base64')); }
      catch (e) { this._forget(); throw new Error('Sign in to Steam again.'); }
      const gc = op.createGC();
      op.listen(gc, 'error', err => op.abort(err instanceof Error ? err : new Error('CS2 Game Coordinator failed.')));
      await op.logOn({ refreshToken: token });
      if (op.user.steamID?.getSteamID64() !== steamid) { this._forget(); throw new Error('Sign in to Steam again.'); }
      if (op.token()) this._save(op.token(), account, steamid);
      op.checkGame();
      const connected = gc.haveGCSession ? Promise.resolve() : op.event(gc, 'connectedToGC', 60000, 'Timed out connecting to the CS2 Game Coordinator.');
      connected.catch(() => {});
      op.user.gamesPlayed([730]);
      await connected;
      const caskets = (gc.inventory || []).filter(i => i.casket_contained_item_count != null || i.def_index === 1201);
      const units = [];
      this.onProgress({ done: 0, total: caskets.length });
      for (const casket of caskets) {
        op.checkGame();
        const id = String(casket.id);
        let items = gc.inventory.filter(item => String(item.casket_id) === id);
        if (!casket.casket_contained_item_count) items = [];
        else if (items.length !== Number(casket.casket_contained_item_count)) {
          let remove;
          const contents = new Promise(resolve => {
            remove = op.listen(gc, 'itemCustomizationNotification', (ids, type) => {
              if (String(ids[0]) === id && type === GlobalOffensive.ItemCustomizationNotification.CasketContents) {
                resolve(gc.inventory.filter(item => String(item.casket_id) === id));
              }
            });
          });
          try {
            gc._send(GCLanguage.CasketItemLoadContents, GCProtos.CMsgCasketItem, {
              casket_item_id: id, item_item_id: id,
            });
            items = await op.wait(contents, 30000, 'Timed out reading a storage unit.');
          } finally { remove(); }
        }
        units.push({ id: String(casket.id), name: casket.custom_name || 'Storage Unit',
          count: Number(casket.casket_contained_item_count ?? items.length), items: items.map(item => ({ ...plain(item), id: String(item.id) })) });
        this.onProgress({ done: units.length, total: caskets.length });
      }
      op.checkGame();
      const t = Date.now();
      writeJSON(path.join(this.dir, 'inventory', `storage-${steamid}.json`), { t, units });
      return { steamid, t, units };
    });
  }

  async _run(reading, work) {
    if (this.busy) throw new Error('A Steam operation is already running.');
    this.busy = true;
    let user, gc, interval, closing = false, cancelled = false, token = null;
    const cleanups = [];
    const timers = new Set();
    let abort;
    const aborted = new Promise((_, reject) => { abort = reject; });
    aborted.catch(() => {});
    let finished;
    const done = new Promise(resolve => { finished = resolve; });
    this.cancelOperation = () => {
      cancelled = true;
      abort(new Error('Cancelled'));
      return done;
    };
    const wait = async (promise, ms, message) => {
      let timer;
      try {
        return await Promise.race([promise, aborted, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
          timers.add(timer);
        })]);
      } finally { clearTimeout(timer); timers.delete(timer); }
    };
    const listen = (emitter, name, fn) => {
      emitter.on(name, fn);
      const remove = () => emitter.removeListener(name, fn);
      cleanups.push(remove);
      return remove;
    };
    const clearGCTimers = () => {
      if (!gc) return;
      clearTimeout(gc._helloTimer);
      clearInterval(gc._helloInterval);
      gc._helloTimer = null;
      gc._helloInterval = null;
    };
    const createGC = () => {
      // GlobalOffensive has no dispose API and registers anonymous SteamUser listeners.
      // Each read owns a fresh pair; capture only the constructor's additions.
      const before = new Map(user.eventNames().map(name => [name, new Set(user.rawListeners(name))]));
      gc = this.makeGC(user);
      const added = user.eventNames().flatMap(name => user.rawListeners(name)
        .filter(fn => !before.get(name)?.has(fn)).map(fn => [name, fn]));
      cleanups.push(() => {
        for (const [name, fn] of added) user.removeListener(name, fn);
        clearGCTimers();
      });
      return gc;
    };
    const event = (emitter, name, ms, message) => wait(new Promise(resolve => listen(emitter, name, resolve)), ms, message);
    const checkGame = () => {
      if (cancelled) throw new Error('Cancelled');
      if (reading && this.isGameRunning()) throw new Error(KICKED);
    };
    const error = err => {
      if (closing || cancelled) return;
      const name = SteamUser.EResult[err.eresult];
      if (reading && INVALID_TOKEN.has(name)) {
        try { this._forget(); } catch (e) { /* Still end the Steam session if disk cleanup fails. */ }
        const failure = new Error('Sign in to Steam again.');
        abort(failure);
        return failure;
      }
      const failure = new Error(MESSAGES[name] || 'Steam connection failed. Please try again.');
      abort(failure);
      return failure;
    };
    try {
      if (reading) {
        user = this.makeUser();
        listen(user, 'error', error);
        listen(user, 'disconnected', eresult => error({ eresult }));
        listen(user, 'steamGuard', () => {
          this._forget();
          abort(new Error('Sign in to Steam again.'));
        });
        listen(user, 'refreshToken', value => {
          token = value;
          // Steam may renew the token after loggedOn, while caskets are being read.
          if (reading && this.saved && user.steamID?.getSteamID64() === this.saved.steamid) {
            try { this._save(value, this.saved.account, this.saved.steamid); } catch (e) { abort(e); }
          }
        });
      }
      if (reading) interval = setInterval(() => { try { checkGame(); } catch (e) { abort(e); } }, 1000);
      return await work({ user, createGC, wait, event, checkGame, listen, error, abort,
        active: () => !closing && !cancelled, cleanup: fn => cleanups.push(fn), token: () => token,
        logOn: async details => {
          const ready = event(user, 'loggedOn', 120000, 'Steam sign-in timed out. Complete Steam Guard or mobile approval and try again.');
          try { user.logOn(details); } catch (e) { error(e); }
          await ready;
        } });
    } finally {
      closing = true;
      clearInterval(interval);
      for (const timer of timers) clearTimeout(timer);
      this.guard = null;
      clearGCTimers();
      try {
        // logOff is asynchronous. Keep both error handlers and the GC bridge alive
        // until disconnected. steam-user emits 'disconnected' itself within 4 s of
        // logOff; past 5 s, drop the connection without a logoff so nothing is left alive.
        if (user) await new Promise(resolve => {
          const finish = () => {
            clearTimeout(timeout);
            user.removeListener('disconnected', finish);
            resolve();
          };
          const timeout = setTimeout(() => {
            try { user._disconnect?.(true); } catch (e) { /* Already gone. */ }
            finish();
          }, 5000);
          user.once('disconnected', finish);
          try { user.gamesPlayed([]); } catch (e) { /* Already disconnected. */ }
          try { user.logOff(); } catch (e) { finish(); }
        });
        for (const cleanup of cleanups) {
          try { cleanup(); } catch (e) { /* Continue releasing the remaining resources. */ }
        }
      } finally {
        this.cancelOperation = null;
        this.busy = false;
        finished();
      }
    }
  }
}

module.exports = { SteamClient };
