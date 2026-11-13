// How the Studio picture is turned into video for the channels and the recording.
// The Studio says what it wants (height, frames per second, bitrate); this file builds the ffmpeg arguments.
// Kept apart from server.js so it can be tested on its own (npm test).
const { videoArgs } = require('./encoder');

const SIZES = [720, 1080, 1440, 2160];
const widthFor = (h) => Math.round((h * 16) / 9 / 2) * 2; // 720 -> 1280, 1080 -> 1920, 1440 -> 2560, 2160 -> 3840

// a sensible bitrate when the Studio does not say (YouTube's own advice for H.264 is the guide)
function defaultKbps(h, fps) {
  const base = { 720: 4500, 1080: 6000, 1440: 12000, 2160: 20000 }[h] || (h > 1440 ? 20000 : h > 1080 ? 12000 : h > 720 ? 6000 : 4500);
  return fps >= 50 ? Math.round(base * 1.5) : base;
}
// The Studio's own numbers (Settings → Video → Custom) are taken when they make sense:
// a height from 360 to 2160 (made even), and 10 to 60 frames a second.
const heightOf = (v) => { const n = Math.round(Number(v)); return n >= 360 && n <= 2160 ? n - (n % 2) : 720; };
const fpsOf = (v) => { const n = Math.round(Number(v)); return n >= 10 && n <= 60 ? n : 30; };

// q: URLSearchParams from /studio-ingest?h=1080&fps=30&kbps=6000
function parseOut(q) {
  const h = heightOf(q.get('h'));
  const fps = fpsOf(q.get('fps'));
  const kbps = Math.min(60000, Math.max(1000, Math.round(Number(q.get('kbps'))) || defaultKbps(h, fps)));
  // a tall (9:16) or square scene collection: "1080p" means 1080 wide
  const shape = q.get('shape');
  if (shape === 'portrait') return { h: widthFor(h), w: h, fps, kbps, res: h, shape };
  if (shape === 'square') return { h, w: h, fps, kbps, res: h, shape };
  return { h, w: widthFor(h), fps, kbps };
}
const resOf = (out) => out.res || out.h;

function label(out) {
  const r = resOf(out);
  return `${r === 2160 ? '4K' : r + 'p'}${out.shape === 'portrait' ? ' tall' : out.shape === 'square' ? ' square' : ''} ${out.fps} fps, ${(out.kbps / 1000).toFixed(out.kbps % 1000 ? 1 : 0)} Mbit`;
}

// the Studio's video (from the page) -> H.264 + AAC as FLV on pipe:1
// copy = true (encode once, the normal case): the page already encoded H.264 at the right size, so ffmpeg only
// wraps it. Audio is still made AAC, because FLV does not take the Opus audio the browser makes.
function ingestArgs(encKey, out, copy = false) {
  if (copy) return ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-flvflags', 'no_duration_filesize', '-f', 'flv', 'pipe:1'];
  return ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-vf', `scale=${out.w}:${out.h}`, ...videoArgs(encKey, out.kbps, out.fps * 2), '-pix_fmt', 'yuv420p', '-r', String(out.fps),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-flvflags', 'no_duration_filesize', '-f', 'flv', 'pipe:1'];
}

// the Studio's video -> a file
// copy = true: the recording canvas is already the right size and H.264, so the file is only wrapped (no second encode)
function recordArgs(encKey, { h, mbit, fps, shape }, file, copy = false) {
  const hh = SIZES.includes(Number(h)) ? Number(h) : 720;
  const size = shape === 'portrait' ? `${hh}:${widthFor(hh)}` : shape === 'square' ? `${hh}:${hh}` : `${widthFor(hh)}:${hh}`;
  const mb = Math.min(80, Math.max(2, Number(mbit) || 8));
  const f = Number(fps) === 60 ? 60 : 30;
  if (copy) return ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '160k', '-f', 'matroska', file];
  return ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', `scale=${size}`,
    ...videoArgs(encKey, mb * 1000, f * 2), '-pix_fmt', 'yuv420p', '-r', String(f), '-c:a', 'aac', '-b:a', '160k', '-f', 'matroska', file];
}

// Facebook allows at most 1920x1080, 60 frames and 9000 kbps (Facebook Live API reference).
// Instagram is treated the same way to be safe. A channel that would get more than that is sent a smaller copy.
const LIMITED = /(facebook|fbcdn|instagram)\./i;
const LIMIT = { h: 1080, kbps: 9000, send_kbps: 6000 };
function needsCap(dest, out) {
  const limited = dest.cap1080 === true || (dest.cap1080 !== false && LIMITED.test(String(dest.url || '')));
  return limited && (resOf(out) > LIMIT.h || out.kbps > LIMIT.kbps);
}
// the ffmpeg arguments for the video part of a channel: copy as is, or a smaller copy for a limited site
// Instagram is watched on a phone held upright. A wide picture can be sent as it is, or made tall (9:16):
//   fill = cut the sides off; blur = the whole picture with a blurred copy behind it; bars = the whole picture with black bars
const TALL = { w: 720, h: 1280, kbps: 4000 };
function tallFilter(mode) {
  const { w, h } = TALL;
  if (mode === 'fill') return `scale=-2:${h},crop=${w}:${h}`;
  if (mode === 'bars') return `scale=${w}:-2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
  if (mode === 'blur') return `split[a][b];[a]scale=-2:${h},crop=${w}:${h},boxblur=24:4[bg];[b]scale=${w}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  return '';
}
function channelVideoArgs(dest, out, encKey) {
  // a tall copy only makes sense when the Studio's picture is wide
  const tall = !out.shape && tallFilter(dest.tall);
  if (tall) return { capped: true, tall: dest.tall,
    args: ['-vf', tall, ...videoArgs(encKey, Math.min(out.kbps, TALL.kbps), out.fps * 2), '-pix_fmt', 'yuv420p', '-r', String(out.fps), '-c:a', 'copy'] };
  if (!needsCap(dest, out)) return { args: ['-c', 'copy'], capped: false };
  return {
    capped: true,
    args: ['-vf', out.shape ? `scale=${Math.min(resOf(out), LIMIT.h)}:-2` : `scale=-2:${Math.min(out.h, LIMIT.h)}`, ...videoArgs(encKey, Math.min(out.kbps, LIMIT.send_kbps), out.fps * 2), '-pix_fmt', 'yuv420p', '-r', String(out.fps), '-c:a', 'copy'],
  };
}

module.exports = { tallFilter, TALL, SIZES, widthFor, defaultKbps, parseOut, label, ingestArgs, recordArgs, needsCap, channelVideoArgs, LIMIT };
