// Measures how quickly the app answers clicks right after it opens (Studio <-> Go Live), and finds what keeps it busy.
// It opens the real app twice: once to set up a Studio with three videos, then again to measure from the start.
// Run: node tools/click-lag-test.js  (MULTISTREAM_ENGINE=off to compare without the OBS engine)
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FF = require('ffmpeg-static');
const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-lag-'));
const DATA = path.join(tmp, 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[lag]', ...a);
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ROOT];
const ENV = { ...process.env, MULTISTREAM_DATA: DATA, MULTISTREAM_RECORDINGS: path.join(tmp, 'rec') };

async function launch() {
  const app = await electron.launch({ args: ARGS, env: ENV, timeout: 90000 });
  app.process().stderr.on('data', (d) => { const t = String(d); if (/engine|error/i.test(t)) process.stdout.write('[app err] ' + t.slice(0, 300)); });
  return app;
}

// stop after 150 s, so a frozen app is reported instead of waiting forever
setTimeout(() => { console.log('[lag] STUCK: the app stopped answering'); process.exit(2); }, 150000).unref();
(async () => {
  // three 1080p videos, like the countdown videos
  const vids = [1, 2, 3].map((n) => {
    const f = path.join(tmp, `countdown${n}.mp4`);
    spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=40`, '-f', 'lavfi', '-i', 'sine=d=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', f]);
    return f;
  });
  log('videos made:', vids.map((f) => fs.statSync(f).size).join(', '));

  // 1. set up the Studio
  let app = await launch();
  let dash = await app.firstWindow({ timeout: 60000 });
  await dash.waitForLoadState('domcontentloaded');
  await sleep(3000);
  const layer = (id, f, vis) => ({ id, type: 'video', name: path.basename(f), file: f, url: '/api/studio/file?p=' + encodeURIComponent(f), x: 0, y: 0, w: 1920, h: 1080, fit: 'stretch', visible: vis, loop: true });
  const put = await dash.evaluate((body) => fetch('/api/studio', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status), {
    current: 'Countdown', shape: 'landscape', audio: [],
    scenes: [
      { name: 'Countdown', audio: [], layers: [layer('v1', vids[0], true), layer('v2', vids[1], false), layer('v3', vids[2], false)] },
      { name: 'Camera', audio: [], layers: [{ id: 'c', type: 'camera', device: '', x: 0, y: 0, w: 1920, h: 1080, fit: 'cover', visible: true }] },
      { name: 'Words', audio: [], layers: [{ id: 't', type: 'text', text: 'Welcome', size: 160, color: '#fff', x: 100, y: 400, w: 1700, h: 240, visible: true }] },
    ],
  });
  log('studio saved:', put);
  await dash.evaluate(() => { try { localStorage.removeItem('ms_studio_window'); } catch {} });
  await sleep(1500);
  await app.close();

  // 2. open again and measure from the start
  app = await launch();
  const t0 = Date.now();
  // the app's own process: note every time it is stuck for more than 80 ms
  await app.evaluate(({ contentTracing }) => {
    global.__gaps = []; let last = Date.now(); const s0 = last;
    setInterval(() => { const n = Date.now(); if (n - last > 80) global.__gaps.push({ at: n - s0, ms: n - last }); last = n; }, 20);
    return contentTracing.startRecording({ included_categories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'blink', 'electron'] });
  }).catch((e) => log('tracing could not start:', e.message));
  dash = await app.firstWindow({ timeout: 60000 });
  await dash.waitForLoadState('domcontentloaded');
  log('window ready after', Date.now() - t0, 'ms');
  await dash.evaluate(() => {
    window.__lt = []; window.__clicks = []; window.__gaps = [];
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push({ at: Math.round(e.startTime), ms: Math.round(e.duration), from: (e.attribution && e.attribution[0] && (e.attribution[0].containerSrc || e.attribution[0].name)) || '' }))).observe({ type: 'longtask', buffered: true }); } catch {}
    document.addEventListener('pointerdown', (e) => window.__clicks.push({ at: Math.round(performance.now()), wait: Math.round(performance.now() - e.timeStamp) }), true);
    let last = performance.now();
    setInterval(() => { const n = performance.now(); if (n - last > 100) window.__gaps.push({ at: Math.round(n), ms: Math.round(n - last) }); last = n; }, 25);
  });
  // the welcome screen shows each time the app opens: choose Go Live, like a person
  await dash.evaluate(() => { const b = document.getElementById('wlLive'); if (b && document.getElementById('welcome').classList.contains('open')) b.click(); }).catch(() => {});
  await sleep(300);
  const results = [];
  for (let i = 0; i < 10; i++) {
    const to = i % 2 === 0 ? 'studio' : 'dash';
    const c0 = Date.now();
    // a real mouse click where the button is (no waiting for the page to be ready, like a person)
    const r = await dash.evaluate((p) => { const b = document.querySelector(`#sideNav [data-page=${p}]`); if (!b) return null; const x = b.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2, top: (document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2) || {}).outerHTML }; }, to).catch((e) => ({ err: e.message }));
    if (i === 0) { log('button:', JSON.stringify(r).slice(0, 300)); await dash.screenshot({ path: path.join(ROOT, 'lag-start.png') }).catch(() => {}); }
    if (r && r.x != null) await dash.mouse.click(r.x, r.y).catch((e) => log('click failed:', e.message));
    await dash.waitForFunction((p) => document.querySelector(`#sideNav [data-page=${p}]`).getAttribute('aria-current') === 'page', to, { timeout: 15000, polling: 16 }).catch(() => {});
    results.push({ at: c0 - t0, to, ms: Date.now() - c0 });
    await sleep(1800);
  }
  const page = await dash.evaluate(() => ({ lt: window.__lt, clicks: window.__clicks, gaps: window.__gaps, eng: window.msNative && window.msNative.engineState ? null : 'none' }));
  const eng = await dash.evaluate(() => (window.msNative && window.msNative.engineState ? window.msNative.engineState() : null)).catch(() => null);
  const main = await app.evaluate(() => global.__gaps).catch(() => []);
  const traceFile = await app.evaluate(({ contentTracing }) => contentTracing.stopRecording()).catch(() => '');
  await app.close().catch(() => {});

  log('engine:', JSON.stringify(eng));
  log('--- clicks (time after opening, page, how long until it switched) ---');
  results.forEach((r) => log(`  ${(r.at / 1000).toFixed(1)} s  -> ${r.to.padEnd(6)} ${r.ms} ms`));
  log('--- time each click waited before the page saw it ---');
  page.clicks.forEach((c) => log(`  ${(c.at / 1000).toFixed(1)} s  waited ${c.wait} ms`));
  log('--- page busy (long tasks over 100 ms) ---');
  page.lt.filter((x) => x.ms >= 100).forEach((x) => log(`  ${(x.at / 1000).toFixed(1)} s  ${x.ms} ms  ${x.from}`));
  log('page long tasks total:', page.lt.length, 'sum', page.lt.reduce((a, b) => a + b.ms, 0), 'ms');
  log('--- app process stuck (over 80 ms) ---');
  main.forEach((g) => log(`  ${(g.at / 1000).toFixed(1)} s  ${g.ms} ms`));

  // what was running in the long moments (from the trace)
  if (traceFile && fs.existsSync(traceFile)) {
    let tr = JSON.parse(fs.readFileSync(traceFile, 'utf8')); tr = tr.traceEvents || tr;
    const names = {}; const procs = {};
    tr.forEach((e) => { if (e.ph === 'M' && e.name === 'thread_name') names[e.pid + ':' + e.tid] = e.args.name; if (e.ph === 'M' && e.name === 'process_name') procs[e.pid] = e.args.name; if (e.ph === 'M' && e.name === 'process_labels') procs[e.pid] = (procs[e.pid] || '') + ' ' + e.args.labels; });
    const th = (e) => (procs[e.pid] || e.pid) + ' / ' + (names[e.pid + ':' + e.tid] || e.tid);
    const main = tr.filter((e) => e.ph === 'X' && e.dur > 60000 && /RunTask|ThreadControllerImpl|TaskQueueManager/.test(e.name) && /CrBrowserMain|CrRendererMain/.test(names[e.pid + ':' + e.tid] || ''));
    main.sort((a, b) => b.dur - a.dur);
    log('--- the 15 longest busy moments, and what ran inside ---');
    const ts0 = tr.reduce((m, e) => (e.ts && e.ts < m ? e.ts : m), Infinity);
    for (const t of main.slice(0, 15)) {
      const inner = tr.filter((e) => e.ph === 'X' && e.pid === t.pid && e.tid === t.tid && e.ts >= t.ts && e.ts + (e.dur || 0) <= t.ts + t.dur && e !== t && e.dur > 15000);
      const what = new Map();
      inner.forEach((e) => {
        const d = (e.args && e.args.data) || {};
        const k = e.name + (d.functionName ? ' ' + d.functionName : '') + (d.url ? ' ' + String(d.url).split('/').pop() + ':' + (d.lineNumber || '') : '') + (e.args && e.args.src_func ? ' ' + e.args.src_file + ':' + e.args.src_func : '');
        what.set(k, Math.max(what.get(k) || 0, e.dur));
      });
      const top = [...what.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, d]) => `      ${Math.round(d / 1000)} ms  ${k}`).join('\n');
      const src = t.args && (t.args.src_func || (t.args.task && t.args.task.posted_from)) ? ' ' + JSON.stringify(t.args).slice(0, 160) : '';
      log(`  ${((t.ts - ts0) / 1e6).toFixed(1)} s  ${Math.round(t.dur / 1000)} ms  ${th(t)}${src}\n${top}`);
    }
    fs.copyFileSync(traceFile, path.join(ROOT, 'lag-trace.json'));
  }
  process.exit(0);
})().catch((e) => { console.error('[lag] ERROR', e); process.exit(1); });
