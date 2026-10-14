// "Export for sharing": re-encodes a clip or montage for social media with ffmpeg.
//  - format: the original 16:9, vertical 9:16 (cropped to the middle, or the whole frame on a blurred
//    background) or square
//  - slow motion around one moment (the last kill), game audio slowed down with it
//  - a title at the start and our own kill feed (a vertical crop cuts the game's kill feed off)
//  - music under the game audio, faded out at the end
// The filter graph goes to ffmpeg in a script file and every text in its own file, so names with
// quotes, colons or any alphabet need no escaping.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('./ffmpeg');

const FORMATS = {
  original: null,
  vertical: { w: 1080, h: 1920, mode: 'crop' },
  verticalFit: { w: 1080, h: 1920, mode: 'fit' },
  square: { w: 1080, h: 1080, mode: 'crop' },
};
const FEED_SECONDS = 5;
const FONT = ['segoeuib.ttf', 'arialbd.ttf'].map(f => path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', f)).find(f => fs.existsSync(f));

// A path inside a filter graph option: forward slashes, the drive colon escaped, in single quotes.
const fpath = p => `'${p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")}'`;
const n3 = v => (Math.round(v * 1000) / 1000).toString();

/**
 * opts: { format, slowmo: { at, before, after, speed } | null, title, subtitle, feed: [{ t, text }],
 *         music: { file, volume, gameVolume } | null, onProgress }
 * Times are seconds in the input video.
 */
async function exportShare(input, output, opts) {
  const info = await ffmpeg.probe(input);
  const D = info.duration || 0;
  if (!D) throw new Error('Could not read the video length.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demolab-share-'));
  try {
    const parts = [];
    const fmt = FORMATS[opts.format] || null;
    const W = fmt ? fmt.w : info.width || 1920, H = fmt ? fmt.h : info.height || 1080;

    // ---- slow motion: three pieces, the middle one stretched
    const sm = opts.slowmo && opts.slowmo.at > 0 && opts.slowmo.at < D ? opts.slowmo : null;
    const speed = sm ? Math.max(0.25, Math.min(0.75, sm.speed || 0.5)) : 1;
    const a = sm ? Math.max(0, sm.at - (sm.before ?? 0.6)) : 0, b = sm ? Math.min(D, sm.at + (sm.after ?? 0.9)) : 0;
    const remap = t => (!sm || t <= a ? t : t <= b ? a + (t - a) / speed : a + (b - a) / speed + (t - b));
    const total = remap(D);
    const audioIn = info.hasAudio ? '[0:a]' : null;
    if (sm) {
      parts.push(`[0:v]split=3[v0][v1][v2]`);
      parts.push(`[v0]trim=0:${n3(a)},setpts=PTS-STARTPTS[s0]`);
      parts.push(`[v1]trim=${n3(a)}:${n3(b)},setpts=(PTS-STARTPTS)/${speed}[s1]`);
      parts.push(`[v2]trim=${n3(b)},setpts=PTS-STARTPTS[s2]`);
      parts.push(`[s0][s1][s2]concat=n=3:v=1:a=0,fps=${Math.min(info.fps || 60, 60)}[vs]`);
      if (audioIn) {
        // atempo goes down to 0.5 per filter; chain two for slower.
        const tempo = speed >= 0.5 ? `atempo=${speed}` : `atempo=0.5,atempo=${n3(speed / 0.5)}`;
        parts.push(`${audioIn}asplit=3[a0][a1][a2]`);
        parts.push(`[a0]atrim=0:${n3(a)},asetpts=PTS-STARTPTS[t0]`);
        parts.push(`[a1]atrim=${n3(a)}:${n3(b)},asetpts=PTS-STARTPTS,${tempo}[t1]`);
        parts.push(`[a2]atrim=${n3(b)},asetpts=PTS-STARTPTS[t2]`);
        parts.push(`[t0][t1][t2]concat=n=3:v=0:a=1[as]`);
      }
    } else {
      parts.push(`[0:v]null[vs]`);
      if (audioIn) parts.push(`${audioIn}anull[as]`);
    }

    // ---- frame format
    if (!fmt) parts.push(`[vs]null[vf]`);
    else if (fmt.mode === 'crop') parts.push(`[vs]crop='min(iw,ih*${W}/${H})':ih,scale=${W}:${H},setsar=1[vf]`);
    else {
      parts.push(`[vs]split=2[bg0][fg0]`);
      parts.push(`[bg0]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:3,eq=brightness=-0.12[bg]`);
      parts.push(`[fg0]scale=${W}:-2[fg]`);
      parts.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[vf]`);
    }

    // ---- title and kill feed
    let last = '[vf]';
    let k = 0;
    const text = (content, opt) => {
      const file = path.join(tmp, `t${k}.txt`);
      fs.writeFileSync(file, content, 'utf8');
      const out = `[x${k++}]`;
      parts.push(`${last}drawtext=fontfile=${fpath(FONT)}:textfile=${fpath(file)}:${opt}${out}`);
      last = out;
    };
    const scale = Math.min(W, H) / 1080;
    if (FONT && opts.title) {
      const fade = `alpha='if(lt(t,0.35),t/0.35,if(lt(t,2.8),1,max(0,(3.2-t)/0.4)))':enable='lt(t,3.2)'`;
      const titleY = fmt?.mode === 'fit' ? Math.round(H * 0.17) : Math.round(H * 0.12);
      text(opts.title, `fontsize=${Math.round(84 * scale)}:fontcolor=white:borderw=${Math.round(5 * scale)}:bordercolor=black@0.7:x=(w-text_w)/2:y=${titleY}:${fade}`);
      if (opts.subtitle) text(opts.subtitle, `fontsize=${Math.round(40 * scale)}:fontcolor=white@0.9:borderw=${Math.round(3 * scale)}:bordercolor=black@0.7:x=(w-text_w)/2:y=${titleY + Math.round(104 * scale)}:${fade}`);
    }
    if (FONT && opts.feed?.length) {
      // Each entry shows for FEED_SECONDS; newer ones go below older ones, which move up as they expire.
      const items = opts.feed.map(f => ({ ...f, from: remap(f.t), to: Math.min(total, remap(f.t) + FEED_SECONDS) })).sort((x, y) => x.from - y.from);
      const cuts = [...new Set(items.flatMap(i => [i.from, i.to]))].sort((x, y) => x - y);
      const size = Math.round(fmt ? 38 * scale : 30 * H / 1080);
      const lineH = Math.round(size * 1.75);
      const top = fmt?.mode === 'crop' ? Math.round(H * (fmt.h > fmt.w ? 0.24 : 0.06)) : fmt?.mode === 'fit' ? Math.round(H * 0.68) : Math.round(H * 0.16);
      // The game draws its own kill feed top right: ours goes top left on the original frame.
      const right = fmt ? `(w-text_w)/2` : `${Math.round(W * 0.02)}`;
      for (let c = 0; c < cuts.length - 1; c++) {
        const s = cuts[c], e = cuts[c + 1];
        const active = items.filter(i => i.from <= s && i.to >= e);
        active.forEach((i, slot) => text(i.text, `fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=${Math.round(size * 0.35)}:x=${right}:y=${top + slot * lineH}:enable='between(t,${n3(s)},${n3(e - 0.001)})'`));
      }
    }
    parts.push(`${last}format=yuv420p[vout]`);

    // ---- audio: game sound (and music)
    const inputs = ['-i', input];
    let audioOut = null;
    const gameVol = opts.music ? opts.music.gameVolume ?? 1 : 1;
    if (opts.music?.file) {
      inputs.push('-stream_loop', '-1', '-i', opts.music.file);
      const fadeAt = Math.max(0, total - 2);
      parts.push(`[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=${n3(opts.music.volume ?? 0.6)},atrim=0:${n3(total)},afade=t=in:d=0.5,afade=t=out:st=${n3(fadeAt)}:d=2[mus]`);
      if (audioIn) {
        parts.push(`[as]aresample=48000,aformat=channel_layouts=stereo,volume=${n3(gameVol)}[game]`);
        parts.push(`[game][mus]amix=inputs=2:duration=first:normalize=0[aout]`);
      } else parts.push(`[mus]anull[aout]`);
      audioOut = '[aout]';
    } else if (audioIn) {
      parts.push(`[as]aresample=48000,aformat=channel_layouts=stereo[aout]`);
      audioOut = '[aout]';
    }

    const script = path.join(tmp, 'graph.txt');
    fs.writeFileSync(script, parts.join(';\n'), 'utf8');
    await ffmpeg.run(ffmpeg.path, ['-y', '-hide_banner', ...inputs, '-filter_complex_script', script,
      '-map', '[vout]', ...(audioOut ? ['-map', audioOut, ...ffmpeg.audioArgs] : []),
      ...ffmpeg.videoArgs(), '-t', n3(total), '-movflags', '+faststart', output],
    { onProgress: opts.onProgress, totalSeconds: total });
    return { duration: total, width: W, height: H };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Where each kill of a highlight lands in its recorded clip (seconds): the clip is the highlight's
// segments back to back, recorded in real time (64 ticks a second).
function clipKills(h, tickrate = 64) {
  const out = [];
  let offset = 0;
  for (const seg of h.segments) {
    for (const k of h.kills) if (k.tick >= seg.start && k.tick <= seg.end) out.push({ ...k, t: offset + (k.tick - seg.start) / tickrate });
    offset += (seg.end - seg.start) / tickrate;
  }
  return out;
}

module.exports = { exportShare, clipKills, FORMATS };
