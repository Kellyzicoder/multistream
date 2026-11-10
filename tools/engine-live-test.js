// Checks going live with the OBS engine, the way the app does it (engine.js + the app's own receiver idea):
// a scene with a colour, the engine sends it to an ffmpeg receiver on this computer, and the file it saves
// must have video and sound in it.
// Run: npx electron tools/engine-live-test.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const out = (...a) => console.log('[live]', ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const ffmpeg = require('ffmpeg-static');
  const engine = require('../engine');
  const file = path.join(app.getPath('temp'), 'ms-engine-live.flv');
  try { fs.unlinkSync(file); } catch (e) {}
  let rx = null;
  try {
    out('start:', engine.start());
    // the graphics page, served the way the app serves it (a listener on this computer only)
    const http = require('http');
    const timer = { id: 'g', type: 'timer', minutes: 5, x: 0, y: 300, w: 1920, size: 200, color: '#ffffff', bg: { kind: 'colour', color: '#00ff00', op: 100 } };
    const ovSrv = http.createServer((req, res) => {
      if (req.url.startsWith('/ov/t/page')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(__dirname, '..', 'public', 'engine-overlay.html'))); }
      if (req.url.startsWith('/ov/t/layer')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ layer: timer, w: 1920, h: 1080 })); }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => ovSrv.listen(0, '127.0.0.1', r));
    const ov = 'http://127.0.0.1:' + ovSrv.address().port + '/ov/t';
    engine.sync({
      w: 1920, h: 1080, current: 'One', trans: { type: 'cut', ms: 0 }, ov,
      audio: [{ id: 's1', name: 'Computer sound', kind: 'desktop', vol: 1 }],
      scenes: [{ name: 'One', audio: ['s1'], layers: [{ id: 'a', type: 'color', color: '#fb923c', x: 0, y: 0, w: 1920, h: 1080 }, timer] }],
    });
    const port = 19350 + Math.floor(Math.random() * 500);
    rx = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-f', 'flv', '-i', `rtmp://127.0.0.1:${port}/live/test`, '-c', 'copy', '-y', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    rx.stderr.on('data', (d) => out('receiver:', String(d).trim().slice(0, 200)));
    await wait(800);
    const r = engine.startStream({ server: `rtmp://127.0.0.1:${port}/live`, key: 'test', w: 1280, h: 720, fps: 30, kbps: 3000 });
    out('go live:', JSON.stringify(r));
    for (let i = 0; i < 8; i++) { await wait(1000); out('state:', JSON.stringify(engine.streamState())); }
    // record at the same time, at 1080p
    const recDir = app.getPath('temp');
    const base = 'ms-engine-rec-' + Date.now();
    out('record:', JSON.stringify(engine.startRecord({ dir: recDir, base, w: 1920, h: 1080, fps: 30, kbps: 8000 })));
    await wait(4000);
    out('record stop:', JSON.stringify(await engine.stopRecord()));
    const recFile = path.join(recDir, base + '.mkv');
    const recSize = fs.existsSync(recFile) ? fs.statSync(recFile).size : 0;
    out('recording bytes:', recSize);
    const rp = spawnSync(ffmpeg, ['-hide_banner', '-i', recFile], { encoding: 'utf8' });
    String(rp.stderr || '').split('\n').filter((l) => /Stream #|Duration/.test(l)).forEach((l) => out('recording:', l.trim()));
    out(recSize > 50000 ? 'record test: OK' : 'record test: FAILED');
    // the countdown's green background (drawn by the graphics page in the engine) must be in the picture
    const px = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '3', '-i', recFile, '-frames:v', '1', '-vf', 'crop=4:4:20:20,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    if (px.stderr && px.stderr.length) out('pixel read:', String(px.stderr).slice(0, 300));
    const rgb = px.stdout && px.stdout.length >= 3 ? [px.stdout[0], px.stdout[1], px.stdout[2]] : [];
    out('pixel at 20,20:', rgb.join(','), rgb.length && rgb[1] > 180 && rgb[0] < 90 ? 'graphics test: OK (green from the graphics page)' : 'graphics test: FAILED (expected green)');
    engine.stopStream();
    await wait(1500);
    try { rx.kill('SIGINT'); } catch (e) {}
    await wait(1000);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    out('saved bytes:', size);
    const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
    String(probe.stderr || '').split('\n').filter((l) => /Stream #|Duration/.test(l)).forEach((l) => out('file:', l.trim()));
    out(size > 50000 ? 'live test: OK' : 'live test: FAILED (no video arrived)');
  } catch (e) {
    out('ERROR:', e.message, e.stack);
  }
  try { if (rx) rx.kill('SIGKILL'); } catch (e) {}
  try { engine.stop(); } catch (e) {}
  setTimeout(() => app.exit(0), 500);
});
