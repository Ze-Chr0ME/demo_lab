// Records highlights: CS2 plays the demo through HLAE, which records each segment; ffmpeg then
// adds the audio and joins the segments into clips.
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg');
const { HlaeSession, FFMPEG_OPTS } = require('./hlae');
const { clipKills } = require('./share');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const secs = since => `${((Date.now() - since) / 1000).toFixed(1)} s`;

class Cancelled extends Error {}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
    .split(';').map(s => s.trim()).filter(Boolean);
}

function safeName(s) { return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80); }

// playdemo only accepts paths relative to game/csgo, so demos elsewhere get linked/copied in.
function demoRef(csgoDir, demoPath, tmpDir) {
  const rel = path.relative(csgoDir, demoPath);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/').replace(/\.dem$/i, '');
  fs.mkdirSync(tmpDir, { recursive: true });
  const target = path.join(tmpDir, 'current.dem');
  fs.rmSync(target, { force: true });
  try { fs.linkSync(demoPath, target); } catch { fs.copyFileSync(demoPath, target); }
  return `${path.basename(tmpDir)}/current`;
}

// True once ffmpeg has closed the mp4: its top-level boxes fill the file and include the 'moov' index.
function mp4Complete(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let pos = 0, moov = false;
    while (pos + 8 <= size) {
      fs.readSync(fd, head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      if (len < 8) return false; // 0 = box still growing to the end of the file
      if (head.toString('latin1', 4, 8) === 'moov') moov = true;
      pos += len;
    }
    return moov && pos === size;
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// True once the wav header has been fixed up with the final length (or there is no wav at all).
function wavComplete(file) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    return head.readUInt32LE(4) + 8 === size;
  } catch (e) { return e.code === 'ENOENT'; }
}

class Recorder {
  constructor({ settings, env, emit }) {
    this.s = settings;
    this.env = env;
    this.emit = emit;
    this.cancelled = false;
  }

  cancel() { this.cancelled = true; }
  check() { if (this.cancelled) throw new Cancelled('Cancelled'); }
  log(msg) { this.emit({ log: msg }); }
  async wait(seconds) {
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) { this.check(); await sleep(Math.min(250, until - Date.now())); }
  }

  /**
   * jobs: [{ demoPath, demoDate, map, player: {steamid, name}, highlight }]
   * Returns the list of created clip entries (not yet in the library).
   */
  async run(jobs) {
    const started = Date.now();
    const raws = await this.recordHlae(jobs);
    // --- Cut & join (after recording, so encoding never steals frames from the game)
    const clips = [];
    for (let i = 0; i < raws.length; i++) {
      this.check();
      const { job, segRaws } = raws[i];
      this.emit({ step: `Processing clip ${i + 1}/${raws.length}…`, progress: 0.99 });
      clips.push(await this.finish(job, segRaws));
    }
    if (!this.s.keepRaw) this.cleanupRaw();
    this.log(`All done in ${secs(started)}`);
    return clips;
  }

  groupByDemo(jobs) {
    const byDemo = new Map();
    jobs.forEach((j, i) => { if (!byDemo.has(j.demoPath)) byDemo.set(j.demoPath, []); byDemo.get(j.demoPath).push({ ...j, index: i }); });
    return byDemo;
  }

  // CS2 runs through HLAE, everything is scheduled on demo ticks, no focus needed.
  async recordHlae(jobs) {
    const t = this.s.timing;
    const hs = this.s.hlae;
    const session = new HlaeSession({
      dir: hs.path, cs2Dir: this.env.cs2Dir, port: hs.port, width: hs.width, height: hs.height,
      ffmpegPath: ffmpeg.path, log: m => this.log(m),
    });
    const cancelled = () => this.cancelled;
    const send = async cmds => { this.check(); await session.send(cmds); };
    const total = jobs.length;
    const tmpDir = path.join(this.env.csgoDir, 'demolab_tmp');
    const rawRoot = path.join(this.s.outputDir, '_raw');

    // Recording only goes as fast as CS2 renders, and CS2 sleeps between frames when its window has no
    // focus (and caps frames at fps_max). Both are lifted while recording and put back before quitting.
    const throttle = { engine_no_focus_sleep: '0', fps_max: '0' };
    const restore = {};

    try {
      let since = Date.now();
      this.emit({ step: 'Starting CS2 in the background (HLAE)…', progress: 0 });
      const { launched } = await session.start(cancelled);
      this.check();
      if (launched) {
        // The console answers before the main menu has finished loading.
        this.emit({ step: `Waiting ${t.startupWait}s for CS2 to load (you can keep using your PC)…` });
        await this.wait(t.startupWait);
      }
      this.log(`CS2 ready after ${secs(since)}`);

      const preset = `demolab_${ffmpeg.encoder}`;
      const opts = `${FFMPEG_OPTS[ffmpeg.encoder] || FFMPEG_OPTS.libx264} {QUOTE}{AFX_STREAM_PATH}\\\\video.mp4{QUOTE}`;
      await send([
        'demo_ui_mode 0', 'r_show_build_info 0', 'cl_trueview_show_status 0', 'cl_hud_telemetry_frametime_show 0',
        'cl_hud_telemetry_ping_show 0', 'cl_hud_telemetry_net_misdelivery_show 0', 'cl_demo_predict 1',
        ...fill(this.s.commands.setup, {}),
        `mirv_streams settings add ffmpeg ${preset} "${opts}"`,
        `mirv_streams settings edit ${preset} options "${opts}"`,
        'mirv_streams record screen enabled 1', `mirv_streams record screen settings ${preset}`,
        `mirv_streams record fps ${hs.fps}`, 'mirv_streams record startMovieWav 1',
      ]);
      for (const [cvar, value] of Object.entries(throttle)) {
        const was = await session.query(cvar);
        if (was === null) continue; // unknown in this CS2 build: leave it alone
        if (was !== value) { restore[cvar] = was; await send([`${cvar} ${value}`]); }
      }

      // Each job's segments are filled in as they get recorded (in demo order, see below).
      const raws = jobs.map(job => ({ job, segRaws: [] }));
      this.raws = raws;
      const totalSegs = jobs.reduce((n, j) => n + j.highlight.segments.length, 0);
      let doneSegs = 0;

      for (const [demoPath, list] of this.groupByDemo(jobs)) {
        since = Date.now();
        const rel = this.demoRef(demoPath, tmpDir);
        this.emit({ step: `Loading demo ${path.basename(demoPath)}…` });
        session.mark();
        await send([`playdemo "${rel}"`]);
        if (!(await session.waitFor(/Demo is version|Signon traffic "DEMO"/, 180000, cancelled))) {
          this.check();
          throw new Error(`CS2 did not load ${path.basename(demoPath)} within 3 minutes.`);
        }
        await this.wait(3);
        this.log(`Loaded ${path.basename(demoPath)} in ${secs(since)}`);

        // Recorded in the order they happen in the demo, so CS2 only ever skips forward.
        const segs = list.flatMap(job => job.highlight.segments.map((seg, si) => ({ job, seg, si })))
          .sort((a, b) => a.seg.start - b.seg.start);
        for (const { job, seg, si } of segs) {
          const h = job.highlight;
          const name = job.player.name.replace(/[";]/g, '');
          since = Date.now();
          this.emit({ step: `Recording ${job.index + 1}/${total}: Round ${h.round} – ${h.title}` + (h.segments.length > 1 ? ` (part ${si + 1}/${h.segments.length})` : ''), progress: doneSegs / totalSegs });
          const id = `${Date.now().toString(36)}${si}`;
          const dir = path.join(rawRoot, id);
          fs.mkdirSync(dir, { recursive: true });
          // The 3 s lead-in (camera on the player, smoothing settled) plays at 4x, the last half second
          // at normal speed so nothing sped-up ends up in the recording.
          await send([
            'demo_pause', 'mirv_cmd clear',
            `mirv_streams record name "${dir}"`,
            `mirv_cmd addAtTick ${seg.start - 64} spec_player "${name}"`,
            `mirv_cmd addAtTick ${seg.start - 60} spec_mode 2`,
            `mirv_cmd addAtTick ${seg.start - 32} demo_timescale 1`,
            `mirv_cmd addAtTick ${seg.start} mirv_streams record start`,
            `mirv_cmd addAtTick ${seg.end} mirv_streams record end`,
            `mirv_cmd addAtTick ${seg.end} demo_pause`,
            `mirv_cmd addAtTick ${seg.end} echo DEMOLAB_DONE_${id}`,
          ]);
          session.mark();
          await send([`demo_gototick ${Math.max(1, seg.start - 192)}`, 'demo_timescale 4', 'demo_resume']);
          const seconds = (seg.end - seg.start) / 64;
          if (!(await session.waitFor(new RegExp(`^DEMOLAB_DONE_${id}`, 'm'), Math.max(120, seconds * 8 + 60) * 1000, cancelled))) {
            this.check();
            throw new Error(`Recording round ${h.round} did not finish. CS2 may have stopped responding.`);
          }
          const files = await this.takeFiles(dir);
          if (!files) throw new Error('HLAE did not produce a video file. Check the ffmpeg path in Settings.');
          raws[job.index].segRaws[si] = { ...files, dir };
          doneSegs++;
          this.log(`Round ${h.round}${h.segments.length > 1 ? ` part ${si + 1}` : ''}: ${seconds.toFixed(1)} s of video in ${secs(since)}`);
        }
      }
      return raws;
    } finally {
      this.emit({ step: 'Closing CS2…' });
      const back = Object.entries(restore).map(([cvar, value]) => `${cvar} ${value}`);
      await session.send(['demo_timescale 1', ...back]).catch(() => {});
      await session.quit().catch(() => {});
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (this.cancelled) for (const r of this.raws || []) for (const s of r.segRaws) if (s) fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }

  // Waits until HLAE's ffmpeg has finished the newest take in dir; returns its files, or null if none appears.
  async takeFiles(dir) {
    const until = Date.now() + 20000;
    let videoDone = 0;
    while (Date.now() < until) {
      let take = null;
      try { take = fs.readdirSync(dir).filter(d => /^take\d+/.test(d)).sort().pop(); } catch {}
      if (take) {
        const video = path.join(dir, take, 'video.mp4'), audio = path.join(dir, take, 'audio.wav');
        if (!videoDone && mp4Complete(video)) videoDone = Date.now();
        // HLAE closes the wav itself at "record end"; don't hang on a header we can't read
        if (videoDone && (wavComplete(audio) || Date.now() - videoDone > 1500)) return { video, audio };
      }
      await sleep(100);
    }
    // Not seen as finished: fall back to whatever is there, as before.
    const take = fs.readdirSync(dir).filter(d => /^take\d+/.test(d)).sort().pop();
    const video = take && path.join(dir, take, 'video.mp4');
    return video && fs.existsSync(video) ? { video, audio: path.join(dir, take, 'audio.wav') } : null;
  }

  // Removes the _raw work folder once it is empty.
  cleanupRaw() {
    try { fs.rmdirSync(path.join(this.s.outputDir, '_raw')); } catch {}
  }

  demoRef(demoPath, tmpDir) { return demoRef(this.env.csgoDir, demoPath, tmpDir); }

  async finish(job, segRaws) {
    const out = this.s.outputDir;
    fs.mkdirSync(out, { recursive: true });
    const h = job.highlight;
    const date = new Date(job.demoDate).toISOString().slice(0, 10);
    const base = safeName(`${date} ${job.map.replace(/^de_/, '')} R${h.round} ${h.title}`);
    let file = path.join(out, base + '.mp4');
    for (let n = 2; fs.existsSync(file); n++) file = path.join(out, `${base} (${n}).mp4`);

    const parts = [];
    for (let i = 0; i < segRaws.length; i++) {
      const p = `${file}.part${i}.mp4`;
      // HLAE segments are already frame-exact: just add the audio.
      await ffmpeg.mux(segRaws[i].video, segRaws[i].audio, p);
      parts.push(p);
    }
    await ffmpeg.concat(parts, file);
    parts.forEach(p => fs.rmSync(p, { force: true }));
    // Target size chosen before recording: re-encode the joined clip to about that many MB.
    if (this.s.targetMB > 0) {
      const tmp = `${file}.fit.mp4`;
      this.emit({ step: `Fitting "${h.title}" into ${this.s.targetMB} MB…` });
      try {
        const r = await ffmpeg.fitToSize(file, tmp, this.s.targetMB);
        fs.renameSync(tmp, file);
        if (!r.kept) this.log(`${path.basename(file)}: ${(r.bytes / 1048576).toFixed(1)} MB at ${r.width}×${r.height} ${r.fps} fps, ${(r.videoKbps / 1000).toFixed(1)} Mbps`);
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        this.log(`Could not fit ${path.basename(file)} into ${this.s.targetMB} MB, kept full quality: ${e.message}`);
      }
    }

    if (!this.s.keepRaw) for (const r of segRaws) fs.rmSync(r.dir, { recursive: true, force: true });

    const thumbDir = path.join(out, '.thumbs');
    fs.mkdirSync(thumbDir, { recursive: true });
    const thumb = path.join(thumbDir, path.basename(file, '.mp4') + '.jpg');
    await ffmpeg.thumbnail(file, thumb, Math.min(this.s.timing.padBefore, 2)).catch(() => {});
    const info = await ffmpeg.probe(file).catch(() => ({ duration: h.duration }));

    return {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: 'clip',
      file, thumb: fs.existsSync(thumb) ? thumb : null,
      title: h.title, tags: h.tags.map(t => t.label), score: h.score, round: h.round, side: h.side,
      weapons: h.weapons, killWeapons: h.kills.map(k => k.weapon), map: job.map, player: job.player.name, demo: path.basename(job.demoPath),
      // which highlight this is, so the match view can mark it as already clipped
      demoId: job.demoId, steamid: job.player.steamid, highlightId: h.id,
      matchDate: job.demoDate, duration: info.duration, createdAt: Date.now(),
      // kills with their time in the clip, for slow motion and the kill feed when exporting for sharing
      kills: clipKills(h).map(k => ({ t: Math.round(k.t * 100) / 100, victim: k.victim, weapon: k.weapon, headshot: k.headshot })),
    };
  }
}

module.exports = { Recorder, Cancelled, demoRef, mp4Complete, wavComplete };
