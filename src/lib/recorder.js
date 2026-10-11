// Records highlights: CS2 plays the demo through HLAE, which records each segment; ffmpeg then
// adds the audio and joins the segments into clips.
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg');
const { HlaeSession, FFMPEG_OPTS } = require('./hlae');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cancelled extends Error {}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
    .split(';').map(s => s.trim()).filter(Boolean);
}

function safeName(s) { return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80); }

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
    const raws = [];
    const total = jobs.length;
    const tmpDir = path.join(this.env.csgoDir, 'clipmaker_tmp');
    const rawRoot = path.join(this.s.outputDir, '_raw');

    try {
      this.emit({ step: 'Starting CS2 in the background (HLAE)…', progress: 0 });
      const { launched } = await session.start(cancelled);
      this.check();
      if (launched) {
        // The console answers before the main menu has finished loading.
        this.emit({ step: `Waiting ${t.startupWait}s for CS2 to load (you can keep using your PC)…` });
        await this.wait(t.startupWait);
      }

      const preset = `clipmaker_${ffmpeg.encoder}`;
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

      for (const [demoPath, list] of this.groupByDemo(jobs)) {
        const rel = this.demoRef(demoPath, tmpDir);
        this.emit({ step: `Loading demo ${path.basename(demoPath)}…` });
        session.mark();
        await send([`playdemo "${rel}"`]);
        if (!(await session.waitFor(/Demo is version|Signon traffic "DEMO"/, 180000, cancelled))) {
          this.check();
          throw new Error(`CS2 did not load ${path.basename(demoPath)} within 3 minutes.`);
        }
        await this.wait(3);

        for (const job of list) {
          const h = job.highlight;
          const name = job.player.name.replace(/[";]/g, '');
          const segRaws = [];
          for (let si = 0; si < h.segments.length; si++) {
            const seg = h.segments[si];
            this.emit({ step: `Recording ${job.index + 1}/${total}: Round ${h.round} – ${h.title}` + (h.segments.length > 1 ? ` (part ${si + 1}/${h.segments.length})` : ''), progress: job.index / total });
            const id = `${Date.now().toString(36)}${si}`;
            const dir = path.join(rawRoot, id);
            fs.mkdirSync(dir, { recursive: true });
            await send([
              'demo_pause', 'mirv_cmd clear',
              `mirv_streams record name "${dir}"`,
              `mirv_cmd addAtTick ${seg.start - 64} spec_player "${name}"`,
              `mirv_cmd addAtTick ${seg.start - 60} spec_mode 2`,
              `mirv_cmd addAtTick ${seg.start} mirv_streams record start`,
              `mirv_cmd addAtTick ${seg.end} mirv_streams record end`,
              `mirv_cmd addAtTick ${seg.end} demo_pause`,
              `mirv_cmd addAtTick ${seg.end} echo CLIPMAKER_DONE_${id}`,
            ]);
            session.mark();
            await send([`demo_gototick ${Math.max(1, seg.start - 192)}`, 'demo_resume']);
            const seconds = (seg.end - seg.start) / 64;
            if (!(await session.waitFor(new RegExp(`^CLIPMAKER_DONE_${id}`, 'm'), Math.max(120, seconds * 8 + 60) * 1000, cancelled))) {
              this.check();
              throw new Error(`Recording round ${h.round} did not finish. CS2 may have stopped responding.`);
            }
            await sleep(1500); // let ffmpeg finish writing
            const take = fs.readdirSync(dir).filter(d => /^take\d+/.test(d)).sort().pop();
            const video = take && path.join(dir, take, 'video.mp4');
            if (!video || !fs.existsSync(video)) throw new Error('HLAE did not produce a video file. Check the ffmpeg path in Settings.');
            segRaws.push({ video, audio: path.join(dir, take, 'audio.wav'), dir });
          }
          raws.push({ job, segRaws });
        }
      }
      return raws;
    } finally {
      this.emit({ step: 'Closing CS2…' });
      await session.quit().catch(() => {});
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (this.cancelled) for (const r of raws) for (const s of r.segRaws) fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }

  // Removes the _raw work folder once it is empty.
  cleanupRaw() {
    try { fs.rmdirSync(path.join(this.s.outputDir, '_raw')); } catch {}
  }

  // playdemo only accepts paths relative to game/csgo, so demos elsewhere get linked/copied in.
  demoRef(demoPath, tmpDir) {
    const rel = path.relative(this.env.csgoDir, demoPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/').replace(/\.dem$/i, '');
    fs.mkdirSync(tmpDir, { recursive: true });
    const target = path.join(tmpDir, 'current.dem');
    fs.rmSync(target, { force: true });
    try { fs.linkSync(demoPath, target); } catch { fs.copyFileSync(demoPath, target); }
    return 'clipmaker_tmp/current';
  }

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
      matchDate: job.demoDate, duration: info.duration, createdAt: Date.now(),
    };
  }
}

module.exports = { Recorder, Cancelled };
