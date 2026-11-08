// How the Studio picture is turned into video for the channels and the recording.
// The Studio says what it wants (height, frames per second, bitrate); this file builds the ffmpeg arguments.
// Kept apart from server.js so it can be tested on its own (npm test).
const { videoArgs } = require('./encoder');

const SIZES = [720, 1080, 1440, 2160];
const widthFor = (h) => Math.round((h * 16) / 9 / 2) * 2; // 720 -> 1280, 1080 -> 1920, 1440 -> 2560, 2160 -> 3840

// a sensible bitrate when the Studio does not say (YouTube's own advice for H.264 is the guide)
function defaultKbps(h, fps) {
  const base = { 720: 4500, 1080: 6000, 1440: 12000, 2160: 20000 }[h] || 4500;
  return fps === 60 ? Math.round(base * 1.5) : base;
}

// q: URLSearchParams from /studio-ingest?h=1080&fps=30&kbps=6000
function parseOut(q) {
  const h = SIZES.includes(Number(q.get('h'))) ? Number(q.get('h')) : 720;
  const fps = Number(q.get('fps')) === 60 ? 60 : 30;
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
function channelVideoArgs(dest, out, encKey) {
  if (!needsCap(dest, out)) return { args: ['-c', 'copy'], capped: false };
  return {
    capped: true,
    args: ['-vf', out.shape ? `scale=${Math.min(resOf(out), LIMIT.h)}:-2` : `scale=-2:${Math.min(out.h, LIMIT.h)}`, ...videoArgs(encKey, Math.min(out.kbps, LIMIT.send_kbps), out.fps * 2), '-pix_fmt', 'yuv420p', '-r', String(out.fps), '-c:a', 'copy'],
  };
}

module.exports = { SIZES, widthFor, defaultKbps, parseOut, label, ingestArgs, recordArgs, needsCap, channelVideoArgs, LIMIT };
