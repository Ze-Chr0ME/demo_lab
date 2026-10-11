// Sends console commands to a running CS2 client.
//
// Two methods:
//  - "keypress" (default, normal game): commands are written to cfg/clipmaker_cmd.cfg and a spare
//    key bound to `exec clipmaker_cmd` is pressed in the CS2 window. The bind is installed by
//    launching CS2 with `+exec clipmaker_init` (or by typing that once in the console).
//  - "netcon": CS2's telnet console (-netconport). On Windows this only works with `-tools`.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Windows virtual-key / scan codes for the keys we allow as trigger.
const KEYS = {
  scrolllock: { scan: 0x46, ext: false },
  f13: { scan: 0x64, ext: false },
  insert: { scan: 0x52, ext: true },
};

let win32 = null;
function user32() {
  if (win32) return win32;
  const koffi = require('koffi');
  const u = koffi.load('user32.dll');
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: koffi.union('INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT }) });
  win32 = {
    INPUT,
    FindWindowW: u.func('void* __stdcall FindWindowW(str16 cls, str16 title)'),
    GetForegroundWindow: u.func('void* __stdcall GetForegroundWindow()'),
    SetForegroundWindow: u.func('bool __stdcall SetForegroundWindow(void* hwnd)'),
    ShowWindow: u.func('bool __stdcall ShowWindow(void* hwnd, int cmd)'),
    IsIconic: u.func('bool __stdcall IsIconic(void* hwnd)'),
    SendInput: u.func('uint32 __stdcall SendInput(uint32 n, INPUT *inputs, int size)'),
    keybd_event: u.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)'),
  };
  return win32;
}

function findWindow() {
  const w = user32();
  return w.FindWindowW('SDL_app', 'Counter-Strike 2') || w.FindWindowW(null, 'Counter-Strike 2');
}

function isRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq cs2.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
    return /cs2\.exe/i.test(out);
  } catch { return false; }
}

const addr = p => (typeof p === 'bigint' || typeof p === 'number') ? BigInt(p) : require('koffi').address(p);
const sameHwnd = (a, b) => !!a && !!b && addr(a) === addr(b);

async function focus() {
  const w = user32();
  const hwnd = findWindow();
  if (!hwnd) throw new Error('CS2 window not found');
  if (sameHwnd(w.GetForegroundWindow(), hwnd)) return true;
  if (w.IsIconic(hwnd)) w.ShowWindow(hwnd, 9 /* SW_RESTORE */);
  // Windows only lets the process that received the last input steal focus; a synthetic
  // ALT press makes us that process.
  w.keybd_event(0x12, 0, 0, 0);
  w.keybd_event(0x12, 0, 2, 0);
  w.SetForegroundWindow(hwnd);
  for (let i = 0; i < 20; i++) {
    await sleep(50);
    if (sameHwnd(w.GetForegroundWindow(), hwnd)) return true;
  }
  return false;
}

function pressKey(name) {
  const w = user32();
  const k = KEYS[name] || KEYS.scrolllock;
  const flags = 0x0008 /* SCANCODE */ | (k.ext ? 0x0001 : 0);
  const mk = up => ({ type: 1, u: { ki: { wVk: 0, wScan: k.scan, dwFlags: flags | (up ? 0x0002 : 0), time: 0, dwExtraInfo: 0 } } });
  const size = require('koffi').sizeof(w.INPUT);
  w.SendInput(1, mk(false), size);
  return sleep(40).then(() => w.SendInput(1, mk(true), size));
}

class KeypressChannel {
  constructor({ csgoDir, key }) {
    this.cfgDir = path.join(csgoDir, 'cfg');
    this.key = key;
    this.queue = Promise.resolve();
  }

  writeInit() {
    fs.mkdirSync(this.cfgDir, { recursive: true });
    fs.writeFileSync(path.join(this.cfgDir, 'clipmaker_init.cfg'),
      `// Written by CS2 ClipMaker: binds the trigger key used to send commands.\nbind "${this.key}" "exec clipmaker_cmd"\necho "[ClipMaker] control key bound to ${this.key}"\n`);
  }

  launchArgs() { return ['+exec', 'clipmaker_init']; }

  async connect() { this.writeInit(); return !!findWindow(); }

  // Commands are serialised: each one rewrites the cfg file, then presses the key.
  send(commands) {
    const job = this.queue.then(async () => {
      const text = (Array.isArray(commands) ? commands : [commands]).join('\n') + '\n';
      fs.writeFileSync(path.join(this.cfgDir, 'clipmaker_cmd.cfg'), text);
      if (!(await focus())) throw new Error('Could not bring CS2 to the foreground. Click on the CS2 window and try again.');
      await sleep(60);
      await pressKey(this.key);
      await sleep(120);
    });
    this.queue = job.catch(() => {});
    return job;
  }

  close() {}
}

class NetconChannel {
  constructor({ port }) { this.port = port; this.sock = null; this.listeners = new Set(); }
  launchArgs() { return ['-tools', '-netconport', String(this.port)]; }
  connect() {
    return new Promise(resolve => {
      const s = net.connect({ host: '127.0.0.1', port: this.port });
      s.setEncoding('utf8');
      s.once('connect', () => { this.sock = s; resolve(true); });
      s.once('error', () => resolve(false));
      s.on('data', d => this.listeners.forEach(f => f(d)));
      s.on('close', () => { if (this.sock === s) this.sock = null; });
    });
  }
  async send(commands) {
    if (!this.sock && !(await this.connect())) throw new Error(`Cannot reach CS2 console on port ${this.port}. Launch CS2 with "-tools -netconport ${this.port}".`);
    for (const c of Array.isArray(commands) ? commands : [commands]) this.sock.write(c + '\r\n');
    await sleep(100);
  }
  onOutput(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  close() { this.sock?.destroy(); this.sock = null; }
}

function createChannel(settings, csgoDir) {
  return settings.control.method === 'netcon'
    ? new NetconChannel({ port: settings.control.netconPort })
    : new KeypressChannel({ csgoDir, key: settings.control.key });
}

function launch(steamPath, args) {
  const exe = path.join(steamPath, 'steam.exe');
  spawn(exe, ['-applaunch', '730', ...args], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

async function waitForWindow(timeoutMs, isCancelled = () => false) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (isCancelled()) return false;
    if (findWindow()) return true;
    await sleep(1000);
  }
  return false;
}

module.exports = { createChannel, launch, waitForWindow, isRunning, findWindow, focus, KEYS };
