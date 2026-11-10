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
    engine.sync({
      w: 1920, h: 1080, current: 'One', trans: { type: 'cut', ms: 0 },
      audio: [{ id: 's1', name: 'Computer sound', kind: 'desktop', vol: 1 }],
      scenes: [{ name: 'One', audio: ['s1'], layers: [{ id: 'a', type: 'color', color: '#fb923c', x: 0, y: 0, w: 1920, h: 1080 }] }],
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
