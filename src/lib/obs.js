// Controls OBS Studio through its built-in WebSocket server (OBS 28+, Tools > WebSocket Server Settings).
const { OBSWebSocket } = require('obs-websocket-js');

const SCENE = 'CS2 ClipMaker';
const CAPTURE = 'CS2 ClipMaker - Game';
const AUDIO = 'CS2 ClipMaker - Game Audio';
const CS2_WINDOW = 'Counter-Strike 2:SDL_app:cs2.exe';

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Obs {
  constructor() {
    this.ws = new OBSWebSocket();
    this.connected = false;
    this.version = null;
    this.ws.on('ConnectionClosed', () => { this.connected = false; });
  }

  async connect({ host, port, password }) {
    if (this.connected) return this.version;
    try {
      await this.ws.connect(`ws://${host}:${port}`, password || undefined);
    } catch (e) {
      const msg = String(e.message || e);
      if (/auth/i.test(msg) || e.code === 4009) throw new Error('OBS refused the password. Copy it from OBS > Tools > WebSocket Server Settings > Show Connect Info.');
      throw new Error(`Cannot reach OBS at ${host}:${port}. Is OBS open, with Tools > WebSocket Server Settings > "Enable WebSocket server" ticked?`);
    }
    this.connected = true;
    this.version = await this.ws.call('GetVersion');
    return this.version;
  }

  async disconnect() { try { await this.ws.disconnect(); } catch {} this.connected = false; }

  // Creates (once) a dedicated scene with a CS2 game capture + CS2-only audio, so Discord,
  // music etc. never end up in the clips.
  async ensureScene() {
    const { scenes } = await this.ws.call('GetSceneList');
    if (!scenes.some(s => s.sceneName === SCENE)) await this.ws.call('CreateScene', { sceneName: SCENE });
    const { inputs } = await this.ws.call('GetInputList');
    const names = new Set(inputs.map(i => i.inputName));
    const major = parseInt(this.version?.obsVersion || '0', 10);

    if (!names.has(CAPTURE)) {
      await this.ws.call('CreateInput', {
        sceneName: SCENE, inputName: CAPTURE, inputKind: 'game_capture',
        inputSettings: { capture_mode: 'window', window: CS2_WINDOW, priority: 2, capture_cursor: false, capture_audio: major >= 30 },
        sceneItemEnabled: true,
      });
    }
    if (major < 30 && !names.has(AUDIO)) {
      await this.ws.call('CreateInput', {
        sceneName: SCENE, inputName: AUDIO, inputKind: 'wasapi_process_output_capture',
        inputSettings: { window: CS2_WINDOW, priority: 2 }, sceneItemEnabled: true,
      }).catch(() => {});
    }
    // Make the capture fill the canvas.
    try {
      const { sceneItemId } = await this.ws.call('GetSceneItemId', { sceneName: SCENE, sourceName: CAPTURE });
      const video = await this.ws.call('GetVideoSettings');
      await this.ws.call('SetSceneItemTransform', {
        sceneName: SCENE, sceneItemId,
        sceneItemTransform: { boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: video.baseWidth, boundsHeight: video.baseHeight, positionX: 0, positionY: 0, alignment: 5, boundsAlignment: 0 },
      });
    } catch {}
  }

  // Switches to our scene and mutes global desktop/mic audio. Returns a restore function.
  async prepare() {
    await this.ensureScene();
    const { currentProgramSceneName } = await this.ws.call('GetCurrentProgramScene');
    await this.ws.call('SetCurrentProgramScene', { sceneName: SCENE });
    const special = await this.ws.call('GetSpecialInputs');
    const muted = [];
    for (const name of Object.values(special)) {
      if (!name) continue;
      try {
        const { inputMuted } = await this.ws.call('GetInputMute', { inputName: name });
        if (!inputMuted) { await this.ws.call('SetInputMute', { inputName: name, inputMuted: true }); muted.push(name); }
      } catch {}
    }
    return async () => {
      for (const name of muted) await this.ws.call('SetInputMute', { inputName: name, inputMuted: false }).catch(() => {});
      if (currentProgramSceneName && currentProgramSceneName !== SCENE) await this.ws.call('SetCurrentProgramScene', { sceneName: currentProgramSceneName }).catch(() => {});
    };
  }

  // Resolves with the timestamp at which OBS reports the recording as actually running.
  async startRecord() {
    const st = await this.ws.call('GetRecordStatus');
    if (st.outputActive) throw new Error('OBS is already recording. Stop that recording first.');
    const started = new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.ws.off('RecordStateChanged', h); reject(new Error('OBS did not start recording')); }, 10000);
      const h = ev => {
        if (ev.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') { clearTimeout(t); this.ws.off('RecordStateChanged', h); resolve(Date.now()); }
      };
      this.ws.on('RecordStateChanged', h);
    });
    await this.ws.call('StartRecord');
    return started;
  }

  async stopRecord() {
    const stopped = new Promise(resolve => {
      const t = setTimeout(() => { this.ws.off('RecordStateChanged', h); resolve(null); }, 15000);
      const h = ev => {
        if (ev.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') { clearTimeout(t); this.ws.off('RecordStateChanged', h); resolve(ev.outputPath); }
      };
      this.ws.on('RecordStateChanged', h);
    });
    const res = await this.ws.call('StopRecord');
    const evPath = await stopped;
    await sleep(300); // let OBS finish writing the file
    return res.outputPath || evPath;
  }
}

module.exports = { Obs, SCENE };
