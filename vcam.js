// Virtual camera for Zoom and other programs (Windows only).
// The Studio picture comes in as video, ffmpeg turns it into plain frames, and a small helper (vcam.exe)
// hands the frames to the "softcam" virtual camera driver. The camera is called "Multistream Camera".
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findDir() {
  const tries = [process.env.MULTISTREAM_VCAM, process.resourcesPath && path.join(process.resourcesPath, 'vcam'), path.join(__dirname, 'vcam', 'win')];
  return tries.filter(Boolean).find((d) => { try { return fs.existsSync(path.join(d, 'vcam.exe')); } catch { return false; } }) || '';
}

function createVcam({ ffmpeg, platform = process.platform, dir = findDir(), exe, exeArgs, logoPath } = {}) {
  const helper = exe || (dir && path.join(dir, 'vcam.exe'));
  const available = Boolean(helper) && (platform === 'win32' || Boolean(exe));
  // The helper (vc) stays running once the camera has been started, so Windows keeps the camera in place.
  // When the Studio stops sending, we hand it a plain dark picture instead. If the helper quit, the camera would
  // disappear and Zoom would show an error.
  let vc = null, ff = null, idle = null, info = { on: false, error: '' }, fed = 0, size = 0, vw = 0, vh = 0;

  // the picture shown while the camera is not sending: the Multistream "M" logo on dark (plain dark if that fails)
  let idleBuf = null, idleSize = 0;
  function idleFrame() {
    if (idleBuf && idleSize === size) return idleBuf;
    idleSize = size; idleBuf = Buffer.alloc(size, 0x18);
    try {
      const w = vw, h = vh;
      const logo = fs.readFileSync(logoPath || path.join(__dirname, 'public', 'vcam-logo.png'));
      const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'lavfi', '-i', `color=c=0x181818:s=${w}x${h}`,
        '-filter_complex', `[0:v]scale=-1:${Math.round(h * 0.4)}[l];[1:v][l]overlay=(W-w)/2:(H-h)/2`, '-frames:v', '1', '-pix_fmt', 'bgr24', '-f', 'rawvideo', 'pipe:1'],
        { input: logo, maxBuffer: size * 2, windowsHide: true });
      if (r.status === 0 && r.stdout.length === size) idleBuf = r.stdout;
    } catch {}
    return idleBuf;
  }
  function idleStart() {
    if (idle || !vc) return;
    const frame = idleFrame();
    // Once a second is enough: softcam shows the last picture again by itself when no new one comes (every 0.5 s).
    // A picture is skipped while the helper has not taken the last ones yet.
    idle = setInterval(() => { if (vc && vc.stdin.writable && vc.stdin.writableLength < frame.length * 2) vc.stdin.write(frame); }, 1000);
    if (idle.unref) idle.unref();
  }
  function idleStop() { if (idle) { clearInterval(idle); idle = null; } }
  function finishFrame() { // never leave half a picture behind
    const rest = (size - (fed % size)) % size;
    if (rest && vc && vc.stdin.writable) vc.stdin.write(Buffer.alloc(rest));
    fed = 0;
  }
  function stop() { // stops sending; the camera stays, showing the dark picture
    const f = ff; ff = null; info.on = false;
    if (f) {
      try { f.stdout.removeAllListeners('data'); f.stdin.end(); } catch {}
      setTimeout(() => { try { f.kill('SIGKILL'); } catch {} }, 1500);
      finishFrame(); idleStart();
    }
  }
  function quit() { // really closes the camera (app is closing)
    stop(); idleStop();
    const v = vc; vc = null;
    if (v) { try { v.stdin.end(); } catch {} setTimeout(() => { try { v.kill('SIGKILL'); } catch {} }, 1000); }
  }

  // returns { write(buf), stop() }
  function start(w = 1280, h = 720, fps = 30) {
    if (!available) throw new Error('The virtual camera is only in the Windows app');
    stop();
    info = { on: true, error: '' };
    if (vc && size !== w * h * 3) quit();
    if (!vc) {
      size = w * h * 3; vw = w; vh = h; fed = 0;
      const v = spawn(helper, exeArgs || [String(w), String(h), String(fps)], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      vc = v;
      v.stdin.on('error', () => {});
      v.stderr.on('data', (d) => { const t = String(d).trim().split('\n').pop(); if (t) info.error = t.slice(0, 200); });
      const gone = () => { if (vc === v) { vc = null; idleStop(); info.on = false; try { ff && ff.kill('SIGKILL'); } catch {} ff = null; } };
      v.on('exit', gone); v.on('error', (e) => { info.error = e.message; gone(); });
    }
    idleStop(); fed = 0;
    const f = ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-vf', `scale=${w}:${h}`, '-r', String(fps), '-pix_fmt', 'bgr24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    f.stdin.on('error', () => {}); f.stdout.on('error', () => {});
    f.stderr.on('data', (d) => { const t = String(d).trim().split('\n').pop(); if (t) info.error = t.slice(0, 200); });
    const target = vc;
    f.stdout.on('data', (b) => {
      if (!target || !target.stdin.writable) return;
      fed += b.length;
      if (!target.stdin.write(b)) { f.stdout.pause(); target.stdin.once('drain', () => f.stdout.resume()); }
    });
    f.on('exit', () => { if (ff === f) { ff = null; info.on = false; finishFrame(); idleStart(); } });
    return { write: (b) => { if (f.stdin.writable) f.stdin.write(b); }, stop };
  }

  // Registers the virtual camera with Windows. Windows asks for the administrator's OK once.
  // The camera files are first copied to Program Files (only an administrator can change files there) and
  // registered from that copy, so programs that load the camera (Zoom, Teams) never load a file that a
  // normal user, or a harmful program running as that user, could have swapped.
  function install(unregister = false) {
    return new Promise((resolve) => {
      if (platform !== 'win32' || !dir) return resolve({ error: 'The virtual camera is only in the Windows app' });
      const inst = path.join(dir, 'softcam_installer.exe'), dll = path.join(dir, 'softcam.dll');
      if (!fs.existsSync(inst) || !fs.existsSync(dll)) return resolve({ error: 'The virtual camera files are missing from this install' });
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const safe = "$d = Join-Path $env:ProgramFiles 'Multistream\\Camera'; $i = Join-Path $d 'softcam_installer.exe'; $l = Join-Path $d 'softcam.dll'";
      // the part that runs as administrator (a copy that Zoom has open is kept, and registered again)
      const admin = unregister
        ? `${safe}; if (Test-Path $i) { & $i unregister $l } else { & ${q(inst)} unregister ${q(dll)} }; exit $LASTEXITCODE`
        : `${safe}; New-Item -ItemType Directory -Force -Path $d | Out-Null; Copy-Item -Force -ErrorAction SilentlyContinue ${q(inst)}, ${q(dll)} -Destination $d; if (!(Test-Path $i) -or !(Test-Path $l)) { exit 2 }; if ((Get-FileHash $l).Hash -ne (Get-FileHash ${q(dll)}).Hash) { exit 3 }; & $i register $l; exit $LASTEXITCODE`;
      const enc = Buffer.from(admin, 'utf16le').toString('base64');
      // if the Windows permission box is cancelled, Start-Process fails: report it, not success
      const ps = `$ErrorActionPreference = 'Stop'; try { $p = Start-Process -FilePath ${q(powershell)} -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',${q(enc)}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; if ($null -eq $p) { exit 1 }; exit $p.ExitCode } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
      const p = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
      let err = ''; p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => resolve({ error: e.message }));
      p.on('close', (code) => resolve(code ? { error: err.trim().split('\n')[0] || (code === 2 ? 'The camera files could not be copied' : code === 3 ? 'Zoom (or Teams, OBS) is using the camera. Quit it fully, also from the icons next to the clock, then press Start Virtual Camera again' : 'Windows did not allow it') } : { ok: true }));
    });
  }
  return { available, start, stop, quit, install, state: () => ({ available, ...info }) };
}

module.exports = { createVcam };
