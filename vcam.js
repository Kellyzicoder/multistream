// Virtual camera for Zoom and other programs (Windows only).
// The Studio picture comes in as video, ffmpeg turns it into plain frames, and a small helper (vcam.exe)
// hands the frames to the "softcam" virtual camera driver.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function findDir() {
  const tries = [process.env.MULTISTREAM_VCAM, process.resourcesPath && path.join(process.resourcesPath, 'vcam'), path.join(__dirname, 'vcam', 'win')];
  return tries.filter(Boolean).find((d) => { try { return fs.existsSync(path.join(d, 'vcam.exe')); } catch { return false; } }) || '';
}

function createVcam({ ffmpeg, platform = process.platform, dir = findDir(), exe, exeArgs } = {}) {
  const helper = exe || (dir && path.join(dir, 'vcam.exe'));
  const available = Boolean(helper) && (platform === 'win32' || Boolean(exe));
  let procs = null, info = { on: false, error: '' };

  function stop() {
    if (!procs) return;
    const { ff, vc } = procs; procs = null; info.on = false;
    try { ff.stdin.end(); } catch {}
    setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} try { vc.kill('SIGKILL'); } catch {} }, 1500);
  }

  // returns { write(buf), stop() }
  function start(w = 1280, h = 720, fps = 30) {
    if (!available) throw new Error('The virtual camera is only in the Windows app');
    stop();
    info = { on: true, error: '' };
    const vc = spawn(helper, exeArgs || [String(w), String(h), String(fps)], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    const ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', 
      '-i', 'pipe:0', '-vf', `scale=${w}:${h}`, '-r', String(fps), '-pix_fmt', 'bgr24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    procs = { ff, vc };
    ff.stdout.pipe(vc.stdin);
    ff.stdin.on('error', () => {}); vc.stdin.on('error', () => {}); ff.stdout.on('error', () => {});
    const note = (d) => { const t = String(d).trim().split('\n').pop(); if (t) info.error = t.slice(0, 200); };
    ff.stderr.on('data', note); vc.stderr.on('data', note);
    const gone = () => { if (procs && procs.vc === vc) { procs = null; info.on = false; } try { ff.kill('SIGKILL'); } catch {} };
    vc.on('exit', gone); vc.on('error', (e) => { info.error = e.message; gone(); });
    ff.on('exit', () => { try { vc.stdin.end(); } catch {} });
    return { write: (b) => { if (ff.stdin.writable) ff.stdin.write(b); }, stop };
  }

  // Registers the virtual camera with Windows. Windows asks for the administrator's OK once.
  function install(unregister = false) {
    return new Promise((resolve) => {
      if (platform !== 'win32' || !dir) return resolve({ error: 'The virtual camera is only in the Windows app' });
      const inst = path.join(dir, 'softcam_installer.exe'), dll = path.join(dir, 'softcam.dll');
      if (!fs.existsSync(inst) || !fs.existsSync(dll)) return resolve({ error: 'The virtual camera files are missing from this install' });
      const q = (s) => "'" + s.replace(/'/g, "''") + "'";
      const ps = `Start-Process -FilePath ${q(inst)} -ArgumentList @(${q(unregister ? 'unregister' : 'register')}, ${q(dll)}) -Verb RunAs -Wait`;
      const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true });
      let err = ''; p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => resolve({ error: e.message }));
      p.on('close', (code) => resolve(code ? { error: err.trim().split('\n')[0] || 'Windows did not allow it' } : { ok: true }));
    });
  }

  return { available, start, stop, install, state: () => ({ available, ...info }) };
}

module.exports = { createVcam };
