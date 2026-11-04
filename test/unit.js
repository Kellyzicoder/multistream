// Quick checks of the two new Version 3 parts: the video hub and the in-app requests. Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createHub } = require('../flvhub');
const { inject, FakeWs } = require('../inproc');
const oa = require('../outargs');
let FF = process.env.FFMPEG_PATH || 'ffmpeg';
try { if (!process.env.FFMPEG_PATH) FF = require('ffmpeg-static'); } catch {}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms3-unit-'));
const read = (s) => new Promise((r) => { const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => r(Buffer.concat(c))); });
const ok = (m) => console.log('ok -', m);
function info(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const e = r.stderr || '';
  const dur = [...e.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  return { video: /Video: h264/.test(e), audio: /Audio: aac/.test(e), secs: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0, errors: /error|corrupt|non-existing PPS/i.test(e.split('\n').filter((l) => !/Input #|Stream #|Metadata|encoder|Duration|time=/.test(l)).join('\n')) };
}
function source(secs) {
  return spawn(FF, ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', String(secs), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'flv', 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] });
}
function taker(hub, file) {
  const p = spawn(FF, ['-loglevel', 'error', '-y', '-f', 'flv', '-i', 'pipe:0', '-c', 'copy', file], { stdio: ['pipe', 'ignore', 'inherit'] });
  p.stdin.on('error', () => {});
  hub.subscribe(p.stdin);
  return new Promise((r) => p.on('close', r));
}

async function hubTests() {
  const hub = createHub(); const ev = [];
  hub.on('start', () => ev.push('start')); hub.on('end', () => ev.push('end'));
  const src = source(7);
  hub.publish(src.stdout);
  const a = path.join(tmp, 'a.mkv'), b = path.join(tmp, 'b.mkv');
  const first = taker(hub, a);
  await new Promise((r) => setTimeout(r, 3000));
  const second = taker(hub, b);
  await Promise.all([first, second]);
  const ia = info(a), ib = info(b);
  assert.deepStrictEqual(ev, ['start', 'end']);
  assert.ok(ia.video && ia.audio && ia.secs > 6 && !ia.errors, 'first copy ' + JSON.stringify(ia));
  assert.ok(ib.video && ib.audio && ib.secs > 3 && !ib.errors, 'late copy ' + JSON.stringify(ib));
  ok(`hub: two copies, the late one starts clean (${ia.secs.toFixed(1)} s and ${ib.secs.toFixed(1)} s, no errors)`);

  // a new source replaces the old one; the old one cannot end the new one
  const hub2 = createHub(); const ev2 = [];
  hub2.on('start', () => ev2.push('start')); hub2.on('end', () => ev2.push('end'));
  const s1 = source(6); hub2.publish(s1.stdout);
  await new Promise((r) => setTimeout(r, 1500));
  const s2 = source(3); s2.stdout.once('data', (c) => { hub2.publish(s2.stdout); hub2.write(c); });
  await new Promise((r) => setTimeout(r, 700)); s1.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 1000));
  assert.strictEqual(hub2.live, true, 'new source still live after old one was killed');
  await new Promise((r) => s2.on('close', r)); await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(hub2.live, false);
  ok('hub: a new source takes over cleanly');

  // a stuck taker is dropped, the others carry on
  const hub3 = createHub(); const { Writable } = require('stream');
  let dropped = '';
  const stuck = new Writable({ highWaterMark: 1, write() { /* never calls back */ } });
  const s3 = source(5); hub3.publish(s3.stdout);
  hub3.subscribe(stuck, (why) => { dropped = why; });
  const c = path.join(tmp, 'c.mkv'); const t3 = taker(hub3, c);
  await t3;
  // 5 s of 640x360 is small, so to prove dropping we check the stuck one never blocked the other
  assert.ok(info(c).secs > 4, 'other taker kept going');
  ok('hub: a stuck taker does not hold up the others' + (dropped ? ' (and was dropped)' : ''));
}

async function injectTests() {
  let closed = false;
  const handler = (req, res) => {
    // like Express: it swaps the prototype of req and res before handling
    Object.setPrototypeOf(res, Object.create(require('http').ServerResponse.prototype));
    Object.setPrototypeOf(req, Object.create(require('http').IncomingMessage.prototype));
    if (req.url === '/json') { res.setHeader('Content-Type', 'application/json'); res.statusCode = 201; return res.end(JSON.stringify({ local: req.socket.remoteAddress })); }
    if (req.url === '/echo') { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { res.writeHead(200, { 'X-Len': String(Buffer.concat(c).length) }); res.end(Buffer.concat(c)); }); return; }
    if (req.url === '/forever') { res.writeHead(200); const t = setInterval(() => res.write('y'), 20); req.on('close', () => { clearInterval(t); closed = true; }); return; }
    if (req.url === '/throw') throw new Error('boom');
    res.statusCode = 404; res.end();
  };
  let r = await inject(handler, { url: '/json' });
  assert.strictEqual(r.status, 201); assert.deepStrictEqual(JSON.parse(await read(r.body)), { local: '127.0.0.1' });
  r = await inject(handler, { method: 'POST', url: '/echo', body: Buffer.from('hello') });
  assert.strictEqual((await read(r.body)).toString(), 'hello');
  r = await inject(handler, { url: '/forever' }); await new Promise((x) => setTimeout(x, 100)); r.body.destroy(); await new Promise((x) => setTimeout(x, 50));
  assert.ok(closed, 'when the window stops reading, the handler is told');
  r = await inject(handler, { url: '/throw' }); assert.strictEqual(r.status, 500);
  ok('in-app requests: answers, uploads, streams and errors');
  const got = []; const w = new FakeWs((t, d) => got.push(t + (d ? ':' + d : ''))); const msgs = [];
  w.on('message', (m, bin) => msgs.push([String(m), bin]));
  w.fromWindow(new Uint8Array([65, 66]).buffer, false); w.fromWindow('stop', true); w.send('{"a":1}'); w.close();
  assert.deepStrictEqual(msgs, [['AB', true], ['stop', false]]); assert.deepStrictEqual(got, ['message:{"a":1}', 'close']);
  ok('in-app pipes: both ways, text and video');
}


function outTests() {
  const q = (o) => new URLSearchParams(o);
  // sizes
  assert.deepStrictEqual(oa.parseOut(q({ h: '2160', fps: '30', kbps: '20000' })), { h: 2160, w: 3840, fps: 30, kbps: 20000 });
  assert.deepStrictEqual(oa.parseOut(q({ h: '1440' })), { h: 1440, w: 2560, fps: 30, kbps: 12000 });
  assert.deepStrictEqual(oa.parseOut(q({ h: '1080', fps: '60' })), { h: 1080, w: 1920, fps: 60, kbps: 9000 });
  assert.deepStrictEqual(oa.parseOut(q({ h: '999', fps: '24', kbps: '9' })), { h: 720, w: 1280, fps: 30, kbps: 1000 }, 'nonsense falls back to safe values');
  assert.strictEqual(oa.parseOut(q({ h: '1080', kbps: '999999' })).kbps, 60000);
  ok('output sizes: 720p, 1080p, 1440p, 4K and safe fallbacks');
  // ingest + record arguments carry the size
  const ia = oa.ingestArgs('software', oa.parseOut(q({ h: '2160', fps: '30', kbps: '20000' })));
  assert.ok(ia.includes('scale=3840:2160') && ia.includes('20000k') && ia[ia.indexOf('-r') + 1] === '30', ia.join(' '));
  const ra = oa.recordArgs('software', { h: '1440', mbit: '16', fps: '60' }, 'x.mkv');
  assert.ok(ra.includes('scale=2560:1440') && ra.includes('16000k') && ra[ra.indexOf('-r') + 1] === '60' && ra[ra.length - 1] === 'x.mkv', ra.join(' '));
  assert.ok(oa.recordArgs('nvenc', { h: '2160', mbit: '500' }, 'y.mkv').includes('80000k'), 'recording bitrate is capped');
  ok('ffmpeg arguments for sending and recording at the chosen size');
  // Facebook / Instagram get at most 1080p and 9000 kbps; YouTube gets everything
  const fb = { url: 'rtmps://live-api-s.facebook.com:443/rtmp/' }, ig = { url: 'rtmps://edgetee-upload.instagram.com:443/rtmp/' }, yt = { url: 'rtmp://a.rtmp.youtube.com/live2' };
  const big = oa.parseOut(q({ h: '2160', fps: '30', kbps: '20000' })), ok1080 = oa.parseOut(q({ h: '1080', fps: '60', kbps: '9000' })), heavy = oa.parseOut(q({ h: '1080', fps: '30', kbps: '12000' }));
  assert.strictEqual(oa.channelVideoArgs(yt, big, 'software').capped, false);
  assert.deepStrictEqual(oa.channelVideoArgs(yt, big, 'software').args, ['-c', 'copy']);
  for (const d of [fb, ig]) {
    const c = oa.channelVideoArgs(d, big, 'software');
    assert.ok(c.capped && c.args.includes('scale=-2:1080') && c.args.includes('6000k') && c.args.includes('copy'), c.args.join(' '));
    assert.strictEqual(oa.channelVideoArgs(d, ok1080, 'software').capped, false, '1080p60 at 9000 is allowed as it is');
    assert.strictEqual(oa.channelVideoArgs(d, heavy, 'software').capped, true, 'over 9000 kbps is lowered');
  }
  assert.strictEqual(oa.channelVideoArgs({ url: 'rtmp://x/y', cap1080: true }, ok1080 && heavy, 'software').capped, true, 'a channel can be marked limited by hand');
  assert.strictEqual(oa.channelVideoArgs({ url: fb.url, cap1080: false }, big, 'software').capped, false, 'or marked not limited');
  ok('Facebook and Instagram are held to 1080p / 9000 kbps; YouTube gets the full size');
  // the arguments really run: a 1080p source -> capped copy, and the picture comes out 1080p
  const src = path.join(tmp, 'big.flv');
  let r = spawnSync(FF, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=2560x1440:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', src]);
  assert.strictEqual(r.status, 0, 'make a 1440p test file');
  const dst = path.join(tmp, 'capped.flv'), cv = oa.channelVideoArgs(fb, oa.parseOut(q({ h: '1440', fps: '30', kbps: '12000' })), 'software');
  r = spawnSync(FF, ['-loglevel', 'error', '-i', src, ...cv.args, '-f', 'flv', '-y', dst]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const e = spawnSync(FF, ['-hide_banner', '-i', dst, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  assert.ok(/Video: h264[^\n]*1920x1080/.test(e), 'capped copy is 1080p: ' + e.split('\n').filter((l) => /Video:/.test(l)).join(' '));
  ok('a 1440p picture really is turned into a 1080p copy for Facebook');
}

// The virtual camera helper must stay running when the Studio stops, and only get whole pictures
async function vcamTests() {
  const { createVcam } = require('../vcam');
  const fake = path.join(tmp, 'fakevcam.js'), log = path.join(tmp, 'vcam.log');
  fs.writeFileSync(fake, `const fs=require('fs');let n=0;process.stdin.on('data',d=>{n+=d.length;fs.writeFileSync(${JSON.stringify(log+'.last')},d);fs.writeFileSync(${JSON.stringify(log)},String(n));});process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(log)+'+".end"'},'1');});setInterval(()=>{},1000);`);
  const webm = path.join(tmp, 'vc.webm');
  assert.strictEqual(spawnSync(FF, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-t', '1', '-c:v', 'libvpx', '-y', webm]).status, 0, 'make a test video');
  const W = 64, H = 36, FR = W * H * 3;
  const vc = createVcam({ ffmpeg: FF, exe: process.execPath, exeArgs: [fake], logoPath: path.join(__dirname, '..', 'public', 'vcam-logo.png') });
  const s = vc.start(W, H, 10);
  s.write(fs.readFileSync(webm)); await new Promise((r) => setTimeout(r, 1800));
  const during = +fs.readFileSync(log, 'utf8');
  assert.ok(during >= FR, 'pictures reached the camera helper: ' + during);
  vc.stop();
  await new Promise((r) => setTimeout(r, 1200));
  const after = +fs.readFileSync(log, 'utf8');
  assert.strictEqual(after % FR, 0, 'only whole pictures were sent: ' + after);
  assert.ok(after > during, 'a dark picture keeps going to the camera while stopped');
  const last = fs.readFileSync(log + '.last'); assert.strictEqual(last.length, FR, 'last idle picture is one whole picture');
  assert.ok(new Set(last).size > 3, 'the idle picture shows the logo, not just one colour');
  assert.ok(!fs.existsSync(log + '.end'), 'the helper is still running after stop');
  vc.quit(); await new Promise((r) => setTimeout(r, 400));
  ok('virtual camera stays in place when stopped, shows a dark picture, and only sends whole pictures');
}

(async () => {
  outTests();
  await injectTests();
  await hubTests();
  await vcamTests();
  console.log('ALL UNIT TESTS PASSED');
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
