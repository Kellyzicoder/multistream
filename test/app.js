// Starts the real Multistream 3 desktop app and checks it end to end. Run: npm run test:app
// (On Linux with no screen: xvfb-run -a npm run test:app)
// A fake "YouTube" runs on this computer, so nothing goes to the real internet.
const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const FF = require('ffmpeg-static');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-out');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms3-app-'));
const DATA = path.join(tmp, 'data'), REC = path.join(tmp, 'recordings');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (m) => { results.push('ok - ' + m); console.log('ok -', m); };

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}
function mediaInfo(file) {
  const e = spawnSync(FF, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
  const v = /Video: h264[^\n]*?(\d{3,4})x(\d{3,4})/.exec(e);
  const t = [...e.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  return { video: Boolean(v), w: v ? +v[1] : 0, h: v ? +v[2] : 0, audio: /Audio: aac/.test(e), secs: t ? (+t[1]) * 3600 + (+t[2]) * 60 + parseFloat(t[3]) : 0 };
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('Timed out waiting for: ' + what); await sleep(500); }
}

(async () => {
  // a fake YouTube: takes an RTMP stream and saves it to a file
  const yt = path.join(tmp, 'fake-youtube.flv');
  const fakeYt = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', 'rtmp://127.0.0.1:19350/live/test', '-c', 'copy', '-y', yt], { stdio: 'inherit' });
  // a fake Facebook: it is marked as a site that takes 1080p at most, so it must get a smaller copy
  const fb = path.join(tmp, 'fake-facebook.flv');
  const fakeFb = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', 'rtmp://127.0.0.1:19351/live/test', '-c', 'copy', '-y', fb], { stdio: 'inherit' });

  const app = await electron.launch({
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ROOT],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', MULTISTREAM_DATA: DATA, MULTISTREAM_RECORDINGS: REC, MULTISTREAM_ENCODER: 'software' },
    timeout: 90000,
  });
  // show what the app prints, so a failure can be understood
  const proc = app.process();
  proc.stdout.on('data', (d) => process.stdout.write('[app] ' + d));
  proc.stderr.on('data', (d) => process.stdout.write('[app err] ' + d));
  const errors = [];
  const watch = (p, name) => { p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(name + ' console: ' + m.text()); }); };
  let dash;
  try { dash = await app.firstWindow({ timeout: 60000 }); } catch (e) {
    const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL() + ' loading=' + w.webContents.isLoading())).catch((x) => 'could not ask: ' + x.message);
    console.log('windows the app has:', wins);
    throw e;
  }
  watch(dash, 'dashboard');
  await dash.waitForLoadState('domcontentloaded');
  await sleep(2500);

  // 1. the window comes from the app itself, not from localhost
  assert.ok(dash.url().startsWith('app://multistream/'), 'dashboard address is ' + dash.url());
  ok('dashboard opens from inside the app: ' + dash.url());

  // 2. nothing is listening on the network
  for (const p of [3000, 1935, 8000]) assert.strictEqual(await portOpen(p), false, `port ${p} should be closed`);
  ok('no ports open (3000, 1935 and 8000 are all closed)');

  // 3. the dashboard can talk to the app (no network)
  const state = await dash.evaluate(() => fetch('/api/state').then((r) => r.json()));
  assert.strictEqual(state.obsLive, false);
  ok('dashboard reads the app state with no network');
  await dash.screenshot({ path: path.join(OUT, '1-dashboard.png') });

  // 4. add the fake YouTube and fake Facebook as channels, and make a scene with a few items and a sound input
  await dash.evaluate(async () => {
    const s = await fetch('/api/state').then((r) => r.json());
    for (const d of s.destinations) await fetch('/api/destinations/' + d.id, { method: 'DELETE' });
    const post = (b) => fetch('/api/destinations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    await post({ name: 'Test YouTube', url: 'rtmp://127.0.0.1:19350/live', key: 'test' });
    await post({ name: 'Test Facebook', url: 'rtmp://127.0.0.1:19351/live', key: 'test', cap1080: true });
    const L = (o) => ({ x: 0, y: 0, w: 1920, h: 1080, fit: 'stretch', visible: true, ...o });
    await fetch('/api/studio', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: 'Welcome', audio: [{ id: 'mic', name: 'Mic', device: '', label: '', vol: 1, muted: false, monitor: 'both' }],
      scenes: [{ name: 'Welcome', audio: ['mic'], layers: [
        L({ id: 'bg', type: 'color', color: '#0b3d1e' }),
        L({ id: 'cam', type: 'camera', name: 'Test camera', x: 1100, y: 60, w: 720, h: 405, res: '720', fps: '30' }),
        L({ id: 'ck', type: 'clock', size: 160, color: '#ffffff', y: 420, h: 300, secs: true }),
        L({ id: 'box', type: 'color', name: 'Box', color: '#ff8800', x: 200, y: 600, w: 500, h: 300 }),
      ] }] }) });
  });

  // 4b. "Open the Studio in: the same window" replaces the dashboard, and a button comes back
  await dash.evaluate(() => localStorage.setItem('ms_studio_open', 'same'));
  await dash.click('#pageTabs [data-page=studio]');
  await until(() => dash.url().includes('studio.html?same=1'), 20000, 'the Studio in the same window');
  await dash.waitForLoadState('domcontentloaded'); await sleep(1500);
  assert.strictEqual(app.windows().length, 1, 'no second window was opened');
  assert.ok(await dash.isVisible('#backBtn'), 'the Dashboard button shows');
  await dash.click('#backBtn');
  await until(() => dash.url() === 'app://multistream/', 20000, 'back to the dashboard');
  await dash.waitForLoadState('domcontentloaded'); await sleep(2000);
  ok('Studio can open in the same window (one window only) and the Dashboard button comes back');
  await dash.evaluate(() => localStorage.setItem('ms_studio_open', 'window'));

  // 5. open the Studio from the dashboard
  const [studio] = await Promise.all([app.waitForEvent('window', { timeout: 30000 }), dash.click('#pageTabs [data-page=studio]')]);
  watch(studio, 'studio');
  await studio.waitForLoadState('domcontentloaded');
  await sleep(3000);
  assert.ok(studio.url().startsWith('app://multistream/studio.html'), 'studio address is ' + studio.url());
  ok('Studio opens in its own window: ' + studio.url());

  // 5b. the Studio's editing tools
  const geo = () => studio.evaluate(() => { const g = evGeom(); return { left: g.left, top: g.top, dw: g.dw, dh: g.dh, sw: SW, sh: SH }; });
  const at = async (sx, sy) => { const g = await geo(); return [g.left + (sx / g.sw) * g.dw, g.top + (sy / g.sh) * g.dh, g.dw / g.sw]; }; // scene point -> screen point
  const layer = (id) => studio.evaluate((i) => { const l = byName(editing).layers.find((x) => x.id === i); return l && JSON.parse(JSON.stringify(l)); }, id);
  const dragScene = async (from, to, keys = []) => {
    const [x1, y1] = await at(...from), [x2, y2] = await at(...to);
    for (const k of keys) await studio.keyboard.down(k);
    await studio.mouse.move(x1, y1); await studio.mouse.down(); await studio.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 }); await studio.mouse.move(x2, y2, { steps: 4 }); await studio.mouse.up();
    for (const k of keys.slice().reverse()) await studio.keyboard.up(k);
    await sleep(150);
  };
  // video capture device: asks for 720p at 30 and reports what it really got
  const camInfo = await until(() => studio.evaluate(() => { const c = [...cams.values()][0]; return c && c.ready ? c.info : ''; }), 20000, 'the camera to start');
  assert.ok(/^\d+x\d+/.test(camInfo), 'camera info: ' + camInfo);
  ok('video capture device starts and says what it receives: ' + camInfo);
  // the Properties window shows the camera settings and that line
  await studio.evaluate(() => { sel = 'cam'; propsOpen = true; renderLayers(); });
  await until(() => studio.evaluate(() => /Receiving/.test((document.getElementById('camInfo') || {}).textContent || '')), 5000, 'the camera line in Properties');
  const opts = await studio.evaluate(() => [...document.querySelectorAll('#props select')].map((s) => [...s.options].map((o) => o.text).join('|')));
  assert.ok(opts.some((o) => /4K/.test(o)) && opts.some((o) => /60/.test(o)), 'resolution and frame rate choices: ' + JSON.stringify(opts));
  await studio.evaluate(() => { closeProps(); sel = ''; renderLayers(); });
  ok('camera Properties: resolution (up to 4K) and frame rate choices');

  // pick and move an item by dragging it in the Preview
  await dragScene([450, 750], [450, 750]); // a click selects it
  assert.strictEqual(await studio.evaluate(() => sel), 'box', 'clicking an item selects it');
  await dragScene([450, 750], [550, 750]);
  let bx = await layer('box');
  assert.ok(Math.abs(bx.x - 300) <= 30 && bx.y === 600, 'moved by dragging: ' + JSON.stringify(bx));
  ok(`drag to move in the Preview (x 200 -> ${bx.x})`);
  // resize from the corner (keeps the shape)
  const b1 = await studio.evaluate(() => boundsOf(byName(editing).layers.find((x) => x.id === 'box')));
  await dragScene([b1[0] + b1[2], b1[1] + b1[3]], [b1[0] + b1[2] + 100, b1[1] + b1[3] + 60], ['Control']);
  bx = await layer('box');
  assert.ok(bx.w > 560 && Math.abs(bx.w / bx.h - 500 / 300) < 0.05, 'corner resize keeps the shape: ' + JSON.stringify(bx));
  ok(`drag a corner to resize, shape kept (500x300 -> ${bx.w}x${bx.h})`);
  // resize from an edge (changes one side only)
  const b2 = await studio.evaluate(() => boundsOf(byName(editing).layers.find((x) => x.id === 'box')));
  await dragScene([b2[0] + b2[2], b2[1] + b2[3] / 2], [b2[0] + b2[2] + 80, b2[1] + b2[3] / 2], ['Control']);
  const bx2 = await layer('box');
  assert.ok(Math.abs(bx2.w - (bx.w + 80)) <= 3 && bx2.h === bx.h, 'edge resize changes the width only: ' + JSON.stringify(bx2));
  ok('drag an edge to stretch one side');
  // arrow keys nudge, Shift = 10
  await studio.keyboard.press('ArrowRight'); await studio.keyboard.press('Shift+ArrowDown'); await sleep(100);
  const bx3 = await layer('box');
  assert.ok(bx3.x === bx2.x + 1 && bx3.y === bx2.y + 10, 'arrow keys: ' + JSON.stringify([bx2.x, bx2.y, bx3.x, bx3.y]));
  ok('arrow keys nudge the selected item (1 px, Shift = 10 px)');
  // Alt + drag an edge crops the picture, and the rest stays where it is
  await dragScene([1460, 262], [1460, 262]);
  assert.strictEqual(await studio.evaluate(() => sel), 'cam');
  const c0 = await layer('cam');
  await dragScene([c0.x, c0.y + c0.h / 2], [c0.x + 100, c0.y + c0.h / 2], ['Alt']);
  const c1 = await layer('cam');
  assert.ok(c1.pfx && c1.pfx.crop.l > 8 && c1.pfx.crop.l < 20 && Math.abs(c1.x - (c0.x + 100)) <= 3 && Math.abs(c1.w - (c0.w - 100)) <= 3, 'Alt+drag crops: ' + JSON.stringify(c1));
  ok(`Alt + drag an edge crops (left ${c1.pfx.crop.l}%), the rest stays in place`);
  // a locked item cannot be moved by accident
  await studio.evaluate(() => { byName(editing).layers.find((x) => x.id === 'box').locked = true; });
  await dragScene([bx3.x + 100, bx3.y + 100], [bx3.x + 200, bx3.y + 100]);
  const bx4 = await layer('box');
  assert.ok(bx4.x === bx3.x, 'locked items stay put');
  await studio.evaluate(() => { byName(editing).layers.find((x) => x.id === 'box').locked = false; sel = ''; });
  ok('a locked item stays where it is');
  await studio.screenshot({ path: path.join(OUT, '3a-studio-edit.png') });

  // sound: monitoring, and the extra tools
  const mic = await until(() => studio.evaluate(() => { const n = asrc.get('mic'); return n && n.node ? { mon: n.mon.gain.value, gate: n.gate.gain.value } : null; }), 15000, 'the sound input');
  await sleep(600);
  let m = await studio.evaluate(() => { const n = asrc.get('mic'); return { mon: n.mon.gain.value, gate: n.gate.gain.value }; });
  assert.ok(m.mon > 0.9 && m.gate > 0.9, 'monitor and stream: ' + JSON.stringify(m));
  const setMon = async (v) => { await studio.evaluate((x) => { studio.audio[0].monitor = x; syncAudio(); gateAudio(); }, v); await sleep(700); return studio.evaluate(() => { const n = asrc.get('mic'); return { mon: n.mon.gain.value, gate: n.gate.gain.value }; }); };
  m = await setMon('only'); assert.ok(m.mon > 0.9 && m.gate < 0.1, 'monitor only: ' + JSON.stringify(m));
  m = await setMon('off'); assert.ok(m.mon < 0.1 && m.gate > 0.9, 'monitor off: ' + JSON.stringify(m));
  m = await setMon('both');
  await studio.evaluate(() => { const a = studio.audio[0]; a.fx = { lowcut: { on: true, hz: 120 }, eq: { on: true, low: 6, mid: -3, high: 4 }, lim: { on: true, thr: -6 } }; syncAudio(); });
  await sleep(300);
  const fx = await studio.evaluate(() => { const n = asrc.get('mic'); return { hp: n.hp.type, hz: n.hp.frequency.value, low: n.eqL.gain.value, mid: n.eqM.gain.value, high: n.eqH.gain.value, thr: n.lim.threshold.value, ratio: n.lim.ratio.value }; });
  assert.ok(fx.hp === 'highpass' && fx.hz === 120 && fx.low === 6 && fx.mid === -3 && fx.high === 4 && fx.thr === -6 && fx.ratio === 20, 'sound tools: ' + JSON.stringify(fx));
  await studio.evaluate(() => { studio.audio[0].fx = {}; syncAudio(); });
  ok('sound: monitor only / off / and stream wired correctly; low cut, bass-mid-treble and limiter set the audio nodes');
  results.push('note - sound monitoring was checked by reading the audio graph, not by listening to a speaker');

  // screens and windows
  const srcs = await studio.evaluate(async () => ({ screens: (await msNative.sources('screen')).length, windows: (await msNative.sources('window')).length, plat: msNative.platform }));
  ok(`screen and window lists answer (screens: ${srcs.screens}, windows: ${srcs.windows}, on ${srcs.plat})`);
  // a window that does not exist is NOT replaced by a screen
  const gone = await studio.evaluate(async () => { const l = { id: 'w1', type: 'window', display: '', winName: 'No Such Window 12345' }; const c = getCapture(l); for (let i = 0; i < 60 && !c.err && !c.ready; i++) await new Promise((r) => setTimeout(r, 250)); const r = { ready: c.ready, err: c.err || '' }; caps.delete(capKey(l)); return r; });
  assert.ok(!gone.ready && /Could not find the window/.test(gone.err), 'missing window: ' + JSON.stringify(gone));
  ok('a window that is not there gives a clear message (it is not swapped for a screen)');
  // a whole screen
  const scr = await studio.evaluate(async () => { const l = { id: 's1', type: 'screen', display: '' }; const c = getCapture(l); for (let i = 0; i < 80 && !c.err && !c.ready; i++) await new Promise((r) => setTimeout(r, 250)); const r = { ready: c.ready, w: c.v.videoWidth, h: c.v.videoHeight, err: c.err || '' }; try { c.st && c.st.getTracks().forEach((t) => t.stop()); } catch {} caps.delete(capKey(l)); return r; });
  if (scr.ready && scr.w > 0) ok(`screen capture works (${scr.w}x${scr.h})`);
  else results.push('NOT PROVEN - screen capture did not start in the test computer (' + (scr.err || 'no picture') + '). Needs a check on a real PC.');
  console.log('screen capture:', JSON.stringify(scr));

  // video size: 1080p, with a bitrate above what Facebook allows
  await studio.click('#setBtn');
  const panes = await studio.evaluate(() => [...document.querySelectorAll('#setNav button')].map((b) => b.textContent));
  assert.deepStrictEqual(panes, ['General', 'Channels', 'Video', 'Recording', 'Audio', 'Hotkeys', 'Advanced']);
  // Channels (like Restream): both test channels are listed, the limit is shown, add and remove work
  await studio.click('#setNav [data-sp=channels]');
  await until(() => studio.evaluate(() => document.querySelectorAll('.ch').length === 2), 10000, 'two channels in the list');
  const names = await studio.evaluate(() => [...document.querySelectorAll('.ch .chh b')].map((b) => b.textContent));
  assert.deepStrictEqual(names, ['Test YouTube', 'Test Facebook']);
  await studio.locator('.ch').nth(1).locator('button', { hasText: 'Edit' }).click();
  assert.strictEqual(await studio.locator('.ch').nth(1).locator('select').inputValue(), 'yes', 'Facebook shows it is limited to 1080p');
  const keyHint = await studio.locator('.ch').nth(1).locator('input[type=password]').getAttribute('placeholder');
  assert.ok(/Saved \(ends in/.test(keyHint), 'the key is never shown, only its last letters: ' + keyHint);
  await studio.selectOption('#chType', 'other'); await studio.fill('#chName', 'Extra'); await studio.fill('#chUrl', 'rtmp://127.0.0.1:19999/live'); await studio.fill('#chKey', 'k');
  await studio.click('#chAdd');
  await until(() => studio.evaluate(() => document.querySelectorAll('.ch').length === 3), 10000, 'the added channel');
  studio.once('dialog', (d) => d.accept());
  await studio.locator('.ch').nth(2).locator('button', { hasText: 'Remove' }).click();
  await until(() => studio.evaluate(() => document.querySelectorAll('.ch').length === 2), 10000, 'the channel to be removed');
  ok('Settings > Channels: lists the channels, shows the 1080p limit, adds and removes a channel');
  // Recording pane
  await studio.click('#setNav [data-sp=output]');
  await until(() => studio.evaluate(() => document.getElementById('recDir2').textContent.length > 3), 10000, 'the recording folder');
  ok('Settings > Recording: shows where files are saved');
  await studio.click('#setNav [data-sp=video]');
  await until(() => studio.evaluate(() => document.getElementById('encName').textContent.length > 2 && document.getElementById('encName').textContent !== '...'), 10000, 'the encoder name');
  ok('Settings > Video: says which encoder is used (' + await studio.textContent('#encName') + ')');
  await studio.selectOption('#outQ', '1080-30-6000');
  await studio.fill('#outKbps', '12000'); await studio.press('#outKbps', 'Tab');
  assert.strictEqual(await studio.evaluate(() => OUT.kbps), 12000);
  const presets = await studio.evaluate(() => [...document.querySelectorAll('#outQ option')].map((o) => o.text));
  assert.ok(presets.some((x) => /4K/.test(x)) && presets.some((x) => /1440p/.test(x)) && presets.some((x) => /60 frames/.test(x)), 'video presets: ' + presets.join(' | '));
  assert.ok(await studio.evaluate(() => [...document.querySelectorAll('#recQ option')].some((o) => /4K/.test(o.text))), 'recording has a 4K choice');
  await studio.screenshot({ path: path.join(OUT, '3b-studio-settings.png') });
  await studio.click('#setOk');
  ok('Settings: video presets up to 4K and 60 frames, bitrate, recording up to 4K');

  // 6. Start sending: the video goes Studio -> app -> fake YouTube, with no local server
  assert.strictEqual((await studio.textContent('#sendBtn')).trim(), 'Start Streaming');
  await studio.click('#sendBtn');
  await until(() => dash.evaluate(() => fetch('/api/state').then((r) => r.json()).then((s) => s.obsLive)), 30000, 'video coming in');
  assert.strictEqual((await studio.textContent('#sendBtn')).trim(), 'Stop Streaming');
  ok('Studio video reaches the app');
  await until(() => dash.evaluate(() => fetch('/api/state').then((r) => r.json()).then((s) => s.destinations.length === 2 && s.destinations.every((d) => d.status.state === 'live'))), 45000, 'both channels live');
  ok('both channels are live');
  const st2 = await dash.evaluate(() => fetch('/api/state').then((r) => r.json()));
  const fbd = st2.destinations.find((d) => d.name === 'Test Facebook');
  assert.ok(/1080p/.test(fbd.status.message), 'the limited channel says it gets a smaller copy: ' + JSON.stringify(fbd.status));
  assert.strictEqual(st2.destinations.find((d) => d.name === 'Test YouTube').status.message, '');
  const so = await studio.evaluate(() => fetch('/api/studio/status').then((r) => r.json()));
  assert.ok(/1080p 30 fps/.test(so.out), 'status says what is sent: ' + JSON.stringify(so));
  ok('the limited channel (Facebook) gets a smaller copy; YouTube gets the video as is (' + so.out + ')');
  for (const p of [3000, 1935, 8000]) assert.strictEqual(await portOpen(p), false, `port ${p} should still be closed while live`);
  ok('still no ports open while live');

  // 7. the dashboard preview plays (it also comes from inside the app)
  await sleep(4000);
  const pv = await dash.evaluate(() => { const v = document.getElementById('pv'); return { w: v.videoWidth, h: v.videoHeight, ready: v.readyState }; });
  assert.ok(pv.w > 0 && pv.ready >= 2, 'preview ' + JSON.stringify(pv));
  ok(`dashboard preview plays (${pv.w}x${pv.h})`);
  await dash.screenshot({ path: path.join(OUT, '2-dashboard-live.png') });
  await studio.screenshot({ path: path.join(OUT, '3-studio-sending.png') });

  // 8. record from the Studio while sending
  await studio.evaluate(() => { const q = document.getElementById('recQ'); q.value = '720-3'; q.dispatchEvent(new Event('change')); }); // (the box lives in Settings)
  await studio.click('#recBtn');
  await sleep(5000);
  await studio.click('#recBtn');
  const saved = await until(() => studio.evaluate(() => /Saved/.test(document.getElementById('st').textContent) && document.getElementById('st').textContent), 20000, 'the Saved message').catch(() => '');
  await until(() => fs.existsSync(REC) && fs.readdirSync(REC).some((f) => f.startsWith('Studio ')), 20000, 'recording file');
  await sleep(1500);
  const recs = fs.readdirSync(REC).filter((f) => f.startsWith('Studio '));
  console.log('Studio said:', saved || '(no Saved message)');
  assert.strictEqual(recs.length, 1);
  const ri = mediaInfo(path.join(REC, recs[0]));
  assert.ok(ri.video && ri.w === 1280 && ri.secs > 3, 'recording ' + JSON.stringify(ri));
  ok(`Studio recording saved (${ri.w}x${ri.h}, ${ri.secs.toFixed(1)} s, sound: ${ri.audio ? 'yes' : 'no'})`);

  // 9. stop sending: the fake YouTube gets a proper video
  await sleep(3000);
  await studio.click('#sendBtn');
  await until(() => dash.evaluate(() => fetch('/api/state').then((r) => r.json()).then((s) => !s.obsLive)), 20000, 'stopped');
  await until(() => fakeYt.exitCode !== null && fakeFb.exitCode !== null, 25000, 'fake YouTube and Facebook to finish');
  const yi = mediaInfo(yt);
  assert.ok(yi.video && yi.w === 1920 && yi.h === 1080 && yi.secs > 8, 'fake YouTube got ' + JSON.stringify(yi));
  ok(`fake YouTube received ${yi.secs.toFixed(1)} s of ${yi.w}x${yi.h} video (sound: ${yi.audio ? 'yes' : 'no'})`);
  const fi = mediaInfo(fb);
  assert.ok(fi.video && fi.w === 1920 && fi.h === 1080 && fi.secs > 6, 'fake Facebook got ' + JSON.stringify(fi));
  ok(`fake Facebook received ${fi.secs.toFixed(1)} s of ${fi.w}x${fi.h} video (sound: ${fi.audio ? 'yes' : 'no'})`);

  // 10. Version 3 has no OBS connection: port 1935 never opens
  assert.strictEqual(await portOpen(1935), false);
  const obsApi = await dash.evaluate(() => fetch('/api/obsin').then((r) => r.status));
  assert.notStrictEqual(obsApi, 200, 'the OBS backup setting is gone');
  ok('no OBS connection (port 1935 stays closed, no OBS settings)');

  // 11. phone control: on = port 3000 open; off = closed
  await dash.evaluate(() => fetch('/api/remote', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"password":"test-pass-123","enabled":true}' }));
  await until(() => portOpen(3000), 10000, 'phone port');
  await dash.evaluate(() => fetch('/api/remote', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' }));
  await until(async () => !(await portOpen(3000)), 10000, 'phone port to close');
  ok('phone control: port opens only while switched on');

  await dash.screenshot({ path: path.join(OUT, '4-dashboard-after.png') });
  await app.close();
  const bad = errors.filter((e) => !/favicon|Failed to load resource.*404/.test(e));
  if (bad.length) console.log('page errors:\n  ' + bad.join('\n  '));
  assert.strictEqual(bad.length, 0, 'there were page errors');
  ok('no page errors');
  fs.writeFileSync(path.join(OUT, 'results.txt'), results.join('\n') + '\n');
  console.log('ALL APP TESTS PASSED');
  process.exit(0);
})().catch(async (e) => {
  console.error('FAILED:', e && e.stack || e);
  fs.writeFileSync(path.join(OUT, 'results.txt'), results.join('\n') + '\nFAILED: ' + (e && e.message) + '\n');
  process.exit(1);
});
