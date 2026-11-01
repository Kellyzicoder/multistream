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

  // 4. add the fake YouTube as a channel, turn the others off, and make a scene
  await dash.evaluate(async () => {
    const s = await fetch('/api/state').then((r) => r.json());
    for (const d of s.destinations) await fetch('/api/destinations/' + d.id, { method: 'DELETE' });
    await fetch('/api/destinations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Test YouTube', url: 'rtmp://127.0.0.1:19350/live', key: 'test' }) });
    const L = (o) => ({ x: 0, y: 0, w: 1920, h: 1080, fit: 'stretch', visible: true, ...o });
    await fetch('/api/studio', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: 'Welcome', audio: [], scenes: [{ name: 'Welcome', audio: [], layers: [L({ id: 'bg', type: 'color', color: '#0b3d1e' }), L({ id: 'ck', type: 'clock', size: 160, color: '#ffffff', y: 420, h: 300, secs: true })] }] }) });
  });

  // 5. open the Studio from the dashboard
  const [studio] = await Promise.all([app.waitForEvent('window', { timeout: 30000 }), dash.click('#pageTabs [data-page=studio]')]);
  watch(studio, 'studio');
  await studio.waitForLoadState('domcontentloaded');
  await sleep(3000);
  assert.ok(studio.url().startsWith('app://multistream/studio.html'), 'studio address is ' + studio.url());
  ok('Studio opens in its own window: ' + studio.url());

  // 6. Start sending: the video goes Studio -> app -> fake YouTube, with no local server
  await studio.click('#sendBtn');
  await until(() => dash.evaluate(() => fetch('/api/state').then((r) => r.json()).then((s) => s.obsLive)), 30000, 'video coming in');
  ok('Studio video reaches the app');
  await until(() => dash.evaluate(() => fetch('/api/state').then((r) => r.json()).then((s) => s.destinations.some((d) => d.status.state === 'live'))), 30000, 'channel live');
  ok('channel is live');
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
  // the quality list is inside the More menu
  await studio.click('#moreBtn');
  await studio.selectOption('#recQ', '720-3');
  await studio.screenshot({ path: path.join(OUT, '3b-studio-more-menu.png') });
  await studio.click('#moreBtn');
  await studio.click('#recBtn');
  await sleep(5000);
  await studio.click('#recBtn');
  await until(() => studio.evaluate(() => /Saved/.test(document.getElementById('st').textContent)), 20000, 'recording saved');
  const recs = fs.readdirSync(REC).filter((f) => f.startsWith('Studio '));
  assert.strictEqual(recs.length, 1);
  const ri = mediaInfo(path.join(REC, recs[0]));
  assert.ok(ri.video && ri.w === 1280 && ri.secs > 3, 'recording ' + JSON.stringify(ri));
  ok(`Studio recording saved (${ri.w}x${ri.h}, ${ri.secs.toFixed(1)} s, sound: ${ri.audio ? 'yes' : 'no'})`);

  // 9. stop sending: the fake YouTube gets a proper video
  await sleep(3000);
  await studio.click('#sendBtn');
  await until(() => dash.evaluate(() => fetch('/api/state').then((r) => r.json()).then((s) => !s.obsLive)), 20000, 'stopped');
  await until(() => fakeYt.exitCode !== null, 20000, 'fake YouTube to finish');
  const yi = mediaInfo(yt);
  assert.ok(yi.video && yi.w === 1280 && yi.h === 720 && yi.secs > 8, 'fake YouTube got ' + JSON.stringify(yi));
  ok(`fake YouTube received ${yi.secs.toFixed(1)} s of ${yi.w}x${yi.h} video (sound: ${yi.audio ? 'yes' : 'no'})`);

  // 10. OBS backup: off = no port; on = OBS can send in; off again = port closed
  await dash.evaluate(() => fetch('/api/obsin', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' }));
  await until(() => portOpen(1935), 10000, 'OBS backup port');
  const obs = spawn(FF, ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-c:a', 'aac', '-f', 'flv', 'rtmp://127.0.0.1:1935/live/obs'], { stdio: 'inherit' });
  await until(() => dash.evaluate(() => fetch('/api/state').then((r) => r.json()).then((s) => s.obsLive)), 15000, 'OBS video coming in');
  ok('OBS backup: when switched on, OBS can send video in');
  await new Promise((r) => obs.on('close', r));
  await dash.evaluate(() => fetch('/api/obsin', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' }));
  await until(async () => !(await portOpen(1935)), 10000, 'OBS backup port to close');
  ok('OBS backup: when switched off, the port closes');

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
