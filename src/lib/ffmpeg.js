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

// Montage with short fade between clips. Everything is normalised to the first clip's size/fps.
async function montage(inputs, output, { fade = 0.25, onProgress } = {}) {
  const infos = await Promise.all(inputs.map(probe));
  const W = infos[0].width || 1920, H = infos[0].height || 1080, F = Math.min(infos[0].fps || 60, 240);
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
  const total = infos.reduce((s, x) => s + x.duration, 0);
  await run(ffmpegPath, ['-y', '-hide_banner', ...inputs.flatMap(f => ['-i', f]), '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', '[a]', ...videoArgs(), ...audioArgs, '-movflags', '+faststart', output], { onProgress, totalSeconds: total });
  return { duration: total };
}

// Small JPEG thumbnail for the clip library.
function thumbnail(input, output, at = 1) {
  return run(ffmpegPath, ['-y', '-hide_banner', '-ss', String(at), '-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', output]);
}

module.exports = { resolve, probe, pickEncoder, mux, concat, montage, thumbnail, run, videoArgs, audioArgs, get encoder() { return chosenEncoder; }, get path() { return ffmpegPath; } };
