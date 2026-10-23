// Records the stream from OBS into a file on this computer. No re-encoding, so it uses almost no CPU.
// The file is .mkv: if the power or the app dies, the video recorded so far is still playable.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function two(n) { return String(n).padStart(2, '0'); }
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
}

function createRecorder({ ffmpeg, input, dir }) {
  let proc = null;
  let info = { on: false, file: '', startedAt: 0, error: '' };

  function start() {
    if (proc) return { ok: true };
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { info.error = 'Cannot make the folder: ' + e.message; return { error: info.error }; }
    const file = path.join(dir, `Multistream ${stamp()}.mkv`);
    const args = ['-loglevel', 'warning', '-nostats', ...input, '-c', 'copy', '-f', 'matroska', file];
    const p = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    proc = p;
    info = { on: true, file: path.basename(file), startedAt: Date.now(), error: '' };
    let last = '';
    p.stderr.on('data', (c) => { const t = c.toString().trim().split('\n').pop(); if (t) last = t; });
    p.stdin.on('error', () => {});
    p.on('error', (e) => { if (proc === p) { proc = null; info.on = false; info.error = e.message; } });
    p.on('close', (code) => {
      if (proc === p) {
        proc = null;
        info.on = false;
        // 255 is how ffmpeg ends when we ask it to stop; anything else while still recording is a problem
        if (code && code !== 255) info.error = last || `Recording stopped (code ${code})`;
      }
    });
    return { ok: true };
  }

  function stop() {
    const p = proc;
    if (!p) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      p.once('close', finish);
      try { p.stdin.write('q'); p.stdin.end(); } catch {}
      setTimeout(() => { try { p.kill('SIGTERM'); } catch {} }, 4000);
      setTimeout(finish, 6000);
    }).then(() => { if (proc === p) { proc = null; info.on = false; } });
  }

  function state() { return { ...info, folder: dir }; }

  function list() {
    try {
      return fs.readdirSync(dir)
        .filter((n) => /\.(mkv|mp4)$/i.test(n))
        .map((n) => { const s = fs.statSync(path.join(dir, n)); return { name: n, size: s.size, at: s.mtimeMs }; })
        .sort((a, b) => b.at - a.at)
        .slice(0, 20);
    } catch { return []; }
  }

  return { start, stop, state, list, dir };
}

module.exports = { createRecorder };
