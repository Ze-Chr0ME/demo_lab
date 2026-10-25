// Thin wrappers around ffmpeg/ffprobe: muxing HLAE recordings, joining segments, montages.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';

function resolve(custom) {
  const candidates = [];
  if (custom) candidates.push(custom);
  // The installer ships ffmpeg and ffprobe in resources\ffmpeg (package.json → build.extraResources).
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
  try {
    const out = execFileSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
    candidates.push(...out.split(/\r?\n/).filter(Boolean));
  } catch {}
  candidates.push('C:\\ffmpeg\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe');
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      ffmpegPath = c;
      const probe = path.join(path.dirname(c), 'ffprobe.exe');
      ffprobePath = fs.existsSync(probe) ? probe : 'ffprobe';
      return c;
    }
  }
  return null;
}

function run(bin, args, { onProgress, totalSeconds } = {}) {
  return new Promise((resolveP, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let err = '';
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => {
      const s = d.toString();
      err = (err + s).slice(-8000);
      if (onProgress && totalSeconds) {
        const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
        if (m) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / totalSeconds));
      }
    });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolveP(out) : reject(new Error(`${path.basename(bin)} exited with ${code}: ${err.split('\n').slice(-6).join('\n')}`)));
  });
}

async function probe(file) {
  const out = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = j.streams.find(s => s.codec_type === 'video');
  const [num, den] = (v?.avg_frame_rate || '60/1').split('/').map(Number);
  return {
    duration: parseFloat(j.format.duration) || 0,
    width: v?.width, height: v?.height,
    fps: den ? Math.round(num / den) : 60,
    hasAudio: j.streams.some(s => s.codec_type === 'audio'),
  };
}

const ENCODERS = {
  libx264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'],
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0'],
  h264_amf: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '20'],
  h264_qsv: ['-c:v', 'h264_qsv', '-global_quality', '20'],
};
let chosenEncoder = 'libx264';

// Picks the first hardware encoder that actually works on this PC, else x264.
async function pickEncoder(pref) {
  if (pref && pref !== 'auto') { chosenEncoder = pref; return pref; }
  for (const enc of ['h264_nvenc', 'h264_amf', 'h264_qsv']) {
    try {
      await run(ffmpegPath, ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30', '-frames:v', '5', ...ENCODERS[enc], '-f', 'null', '-']);
      chosenEncoder = enc;
      return enc;
    } catch {}
  }
  chosenEncoder = 'libx264';
  return chosenEncoder;
}

const videoArgs = () => [...ENCODERS[chosenEncoder], '-pix_fmt', 'yuv420p'];
const audioArgs = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];

// Puts HLAE's separate video.mp4 + audio.wav together (video copied as-is, audio to AAC).
function mux(video, audio, output) {
  const hasAudio = audio && fs.existsSync(audio);
  return run(ffmpegPath, ['-y', '-hide_banner', '-i', video, ...(hasAudio ? ['-i', audio] : []),
    '-map', '0:v', ...(hasAudio ? ['-map', '1:a', ...audioArgs, '-shortest'] : []),
    '-c:v', 'copy', '-movflags', '+faststart', output]);
}

// Joins segments that share the same encoding parameters (no re-encode).
async function concat(inputs, output) {
  if (inputs.length === 1) { fs.copyFileSync(inputs[0], output); return; }
  const list = output + '.txt';
  fs.writeFileSync(list, inputs.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await run(ffmpegPath, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output]);
  } finally { fs.rmSync(list, { force: true }); }
}

// Montage with short fade between clips. Everything is normalised to the first clip's size/fps,
// or to what fits in `mb` MB when a target size is given.
async function montage(inputs, output, { fade = 0.25, mb = 0, onProgress } = {}) {
  const infos = await Promise.all(inputs.map(probe));
  const total = infos.reduce((s, x) => s + x.duration, 0);
  const src = { width: infos[0].width || 1920, height: infos[0].height || 1080, fps: Math.min(infos[0].fps || 60, 240) };
  if (!mb) {
    await montageOnce(inputs, infos, output, src, fade, [...videoArgs(), ...audioArgs], onProgress, total);
    return { duration: total };
  }
  const r = await encodeToSize(mb, sizePlan(mb, total, src), async p => {
    await montageOnce(inputs, infos, output, p, fade,
      [...bitrateArgs(p.videoKbps), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', `${p.audioKbps}k`, '-ar', '48000', '-ac', '2'], onProgress, total);
    return output;
  });
  return { duration: total, plan: r };
}

async function montageOnce(inputs, infos, output, { width: W, height: H, fps: F }, fade, encodeArgs, onProgress, total) {
  const parts = [];
  const labels = [];
  infos.forEach((info, i) => {
    const D = info.duration;
    const f = Math.min(fade, D / 4);
    parts.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${F},format=yuv420p` +
      (f > 0 ? `,fade=t=in:st=0:d=${f},fade=t=out:st=${(D - f).toFixed(3)}:d=${f}` : '') + `[v${i}]`);
    const a = info.hasAudio ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo` : `anullsrc=r=48000:cl=stereo,atrim=0:${D.toFixed(3)}`;
    parts.push(a + (f > 0 ? `,afade=t=in:st=0:d=${f},afade=t=out:st=${(D - f).toFixed(3)}:d=${f}` : '') + `[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join('')}concat=n=${inputs.length}:v=1:a=1[v][a]`);
  await run(ffmpegPath, ['-y', '-hide_banner', ...inputs.flatMap(f => ['-i', f]), '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', '[a]', ...encodeArgs, '-movflags', '+faststart', output], { onProgress, totalSeconds: total });
}

// ---------- Target file size ----------
// The user picks a rough size in MB (MiB, as Windows shows it); bitrate, resolution and fps follow from the length.
const MB = 1024 * 1024;
const LADDER = [[0, 0], [1080, 0], [720, 0], [720, 30], [540, 30], [480, 30], [360, 30]]; // [height, fps], 0 = source
const MIN_BPP = 0.045;  // bits per pixel per frame below which H.264 gets visibly blocky in CS2's fast motion
const MAX_BPP = 0.3;    // above this more bits don't show: the file just ends up smaller than the target

function sizePlan(mb, seconds, src = {}) {
  const W = src.width || 1920, H = src.height || 1080, F = src.fps || 60;
  const totalKbps = mb * MB * 8 * 0.97 / Math.max(seconds, 0.5) / 1000; // ~3% container overhead
  const audioKbps = totalKbps > 3000 ? 192 : totalKbps > 1000 ? 128 : 96;
  let videoKbps = Math.max(150, Math.floor(totalKbps - audioKbps));
  const steps = LADDER.map(([h, f]) => [Math.min(H, h || H), Math.min(F, f || F)])
    .filter(([h, f], i, a) => a.findIndex(x => x[0] === h && x[1] === f) === i);
  let height = H, fps = F;
  for (const [h, f] of steps) {
    height = h; fps = f;
    if (videoKbps * 1000 / (Math.round(W * h / H) * h * f) >= MIN_BPP) break;
  }
  const width = Math.round(W * height / H / 2) * 2;
  const bpp = videoKbps * 1000 / (width * height * fps);
  if (bpp > MAX_BPP) videoKbps = Math.round(MAX_BPP * width * height * fps / 1000);
  const quality = bpp >= 0.1 ? 'excellent' : bpp >= 0.06 ? 'good' : bpp >= MIN_BPP ? 'fair' : 'low';
  return { videoKbps, audioKbps, width, height, fps, quality, scaled: height !== H || fps !== F };
}

function bitrateArgs(kbps) {
  const k = Math.round(kbps);
  const rate = ['-b:v', `${k}k`, '-maxrate', `${Math.round(k * 1.5)}k`, '-bufsize', `${k * 2}k`];
  return {
    libx264: ['-c:v', 'libx264', '-preset', 'medium', ...rate],
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-multipass', 'fullres', ...rate],
    h264_amf: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', ...rate],
    h264_qsv: ['-c:v', 'h264_qsv', ...rate],
  }[chosenEncoder] || ['-c:v', 'libx264', '-preset', 'medium', ...rate];
}

// Runs encode(plan) and, if the file came out more than 4% over the target, once more with a lower bitrate.
async function encodeToSize(mb, plan, encode) {
  for (let tries = 0; ; tries++) {
    const out = await encode(plan);
    const size = fs.statSync(out).size;
    if (size <= mb * MB * 1.04 || tries >= 2) return { ...plan, bytes: size };
    plan = { ...plan, videoKbps: Math.max(100, Math.floor(plan.videoKbps * (mb * MB / size) * 0.97)) };
  }
}

// Re-encodes a finished clip to about `mb` MB. A clip already under the target is kept as it is.
async function fitToSize(input, output, mb, { onProgress } = {}) {
  const info = await probe(input);
  if (fs.statSync(input).size <= mb * MB) { fs.copyFileSync(input, output); return { kept: true }; }
  return encodeToSize(mb, sizePlan(mb, info.duration, info), async p => {
    const vf = p.scaled ? ['-vf', `scale=${p.width}:${p.height}:flags=lanczos,fps=${p.fps}`] : [];
    await run(ffmpegPath, ['-y', '-hide_banner', '-i', input, '-map', '0:v', '-map', '0:a?', ...vf, ...bitrateArgs(p.videoKbps), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', `${p.audioKbps}k`, '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output], { onProgress, totalSeconds: info.duration });
    return output;
  });
}

// Small JPEG thumbnail for the clip library.
function thumbnail(input, output, at = 1) {
  return run(ffmpegPath, ['-y', '-hide_banner', '-ss', String(at), '-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', output]);
}

module.exports = { resolve, probe, pickEncoder, mux, concat, montage, thumbnail, sizePlan, fitToSize, run, videoArgs, audioArgs, get encoder() { return chosenEncoder; }, get path() { return ffmpegPath; } };
