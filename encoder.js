// Picks how Studio video is turned into H.264. A graphics card does it with almost no work for the CPU,
// which keeps a 2 hour service steady on a weak PC. If no card encoder works, the CPU does it (x264).
// Every card encoder is TESTED with a 1 frame encode first, so a listed-but-broken one is skipped.
const { spawn } = require('child_process');

const ENCODERS = {
  nvenc: { id: 'h264_nvenc', name: 'NVIDIA graphics card', args: (k, g) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-b:v', k, '-maxrate', k, '-bufsize', k, '-g', g] },
  qsv: { id: 'h264_qsv', name: 'Intel graphics', args: (k, g) => ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', k, '-maxrate', k, '-g', g] },
  amf: { id: 'h264_amf', name: 'AMD graphics card', args: (k, g) => ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-rc', 'cbr', '-b:v', k, '-maxrate', k, '-g', g] },
  videotoolbox: { id: 'h264_videotoolbox', name: 'Mac graphics', args: (k, g) => ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-b:v', k, '-maxrate', k, '-g', g] },
  software: { id: 'libx264', name: 'processor (x264)', args: (k, g) => ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', k, '-maxrate', k, '-bufsize', String(parseInt(k, 10) * 2) + 'k', '-g', g, '-keyint_min', g, '-sc_threshold', '0'] },
};
const ORDER = { win32: ['nvenc', 'qsv', 'amf'], darwin: ['videotoolbox'], linux: ['nvenc', 'qsv'] };

function run(ffmpeg, args, ms) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(ffmpeg, args, { windowsHide: true }); } catch { return resolve({ ok: false, out: '' }); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve({ ok: false, out }); }, ms);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(t); resolve({ ok: false, out }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out }); });
  });
}

// returns { key, id, name } of the first encoder that really works, else the software one
async function detectEncoder(ffmpeg, platform = process.platform, forced = process.env.MULTISTREAM_ENCODER) {
  const soft = { key: 'software', id: ENCODERS.software.id, name: ENCODERS.software.name };
  if (forced === 'software') return soft;
  const listed = await run(ffmpeg, ['-hide_banner', '-encoders'], 8000);
  if (!listed.ok) return soft;
  for (const key of ORDER[platform] || []) {
    const e = ENCODERS[key];
    if (!listed.out.includes(e.id)) continue;
    const t = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30', '-frames:v', '5', '-pix_fmt', 'yuv420p', ...e.args('4500k', '60'), '-f', 'null', '-'], 10000);
    if (t.ok) return { key, id: e.id, name: e.name };
  }
  return soft;
}

function videoArgs(key, kbps = 4500, gop = 60) {
  const e = ENCODERS[key] || ENCODERS.software;
  return e.args(kbps + 'k', String(gop));
}

module.exports = { detectEncoder, videoArgs, ENCODERS };
