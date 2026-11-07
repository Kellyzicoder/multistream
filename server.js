// Multistream relay.
// The Studio  ->  the video hub (flvhub.js)  ->  ffmpeg copies the video to each destination.
// Each destination gets its own ffmpeg process, so if one fails the others keep going.

const express = require('express');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const os = require('os');
const { createRecorder } = require('./recorder');
const { createHub } = require('./flvhub');
const { inject, FakeWs } = require('./inproc');
const http = require('http');
const { createVcam } = require('./vcam');
const { createAutoRetry } = require('./autoretry');
const { createChat } = require('./chat');
const { runPreflight } = require('./preflight');
const { detectEncoder } = require('./encoder');
const outargs = require('./outargs');
const { makeProgressParser, parseStreamLine, makeRateTracker, makeKeyframeTracker } = require('./stats');

// Version 3: nothing listens on the network unless you switch it on.
// The app windows talk to this file directly (see inproc.js), and video moves through the hub (flvhub.js).
// Ports are only opened for: phone control (3000), and for a few minutes while you sign in to YouTube (3000).
// Version 3 has no OBS connection at all.
const DASHBOARD_PORT = Number(process.env.PORT) || 3000;
const hub = createHub();
const HUB_IN = ['-f', 'flv', '-i', 'pipe:0'];
// The desktop app sets these two. Run on its own (npm start) they fall back to the old behaviour.
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const DATA_DIR = process.env.MULTISTREAM_DATA || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'destinations.json');
const STANDALONE = require.main === module;

// ---- check ffmpeg works ----
const check = spawnSync(FFMPEG, ['-version']);
if (check.error) {
  const msg = 'ffmpeg was not found. Install it first (on Mac: brew install ffmpeg) and try again.';
  if (STANDALONE) {
    console.error('\n' + msg + '\n');
    process.exit(1);
  }
  throw new Error(msg);
}

// ---- saved destinations (stored on this computer only) ----
fs.mkdirSync(DATA_DIR, { recursive: true });
let destinations = [];
try {
  destinations = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  destinations = [
    { id: crypto.randomUUID(), name: 'Instagram', url: '', key: '', enabled: true },
    { id: crypto.randomUUID(), name: 'Facebook', url: '', key: '', enabled: true },
  ];
}
function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(destinations, null, 2), { mode: 0o600 });
}
save();

// ---- recording ----
const REC_DIR = process.env.MULTISTREAM_RECORDINGS || path.join(DATA_DIR, 'recordings');
const REC_FILE = path.join(DATA_DIR, 'recording.json');
let recCfg = { auto: false };
try { recCfg = { auto: Boolean(JSON.parse(fs.readFileSync(REC_FILE, 'utf8')).auto) }; } catch {}
const recorder = createRecorder({ ffmpeg: FFMPEG, input: HUB_IN, dir: REC_DIR, feed: (stdin) => hub.subscribe(stdin) });
let openFolderHook = null;
const recView = () => ({ ...recorder.state(), auto: recCfg.auto });

// ---- chat (read only) ----
const chat = createChat({
  ytList: ({ liveChatId, pageToken }) => ytApi('GET', 'liveChat/messages', { liveChatId, part: 'snippet,authorDetails', ...(pageToken ? { pageToken } : {}) }),
  fbList: async ({ videoId }) => {
    const q = new URLSearchParams({ access_token: fb.token, fields: 'id,message,created_time,from{name}', order: 'reverse_chronological', live_filter: 'no_filter', limit: '50' });
    const r = await fetch(`${GRAPH}/${videoId}/comments?${q}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || 'Facebook did not answer');
    return j;
  },
});

// what is open right now on each site, so the Go live button can turn into End live
const session = { youtube: '', facebook: '' }; // YouTube broadcast id, Facebook live video id

// ---- relay state ----
let obsLive = false;
const procs = new Map(); // id -> ffmpeg process
let studioOut = { h: 720, w: 1280, fps: 30, kbps: 4500 }; // the size the Studio is sending right now
const status = new Map(); // id -> { state, message }
const destStats = new Map(); // id -> { kbps, speed }  (what we are really sending to each platform)

// ---- alerts: pushed to every open page (Stream, Control Room, Studio) over one connection, no polling ----
// Each page joins one group: 'stream' (Stream and Control Room) or 'studio' (the Studio window).
// A channel problem goes to 'stream'; a problem with the video from the Studio goes to 'studio'.
const alertClients = new Map(); // response -> group
const ALERT_GROUPS = ['stream', 'studio'];
function sendAlert(group, source, text) {
  const data = `data: ${JSON.stringify({ source, text, at: Date.now() })}\n\n`;
  for (const [res, g] of alertClients) if (g === group) res.write(data);
}
function clearAlerts(group) {
  const data = `data: ${JSON.stringify({ clear: true })}\n\n`;
  for (const [res, g] of alertClients) if (g === group) res.write(data);
}

function setStatus(id, state, message = '') {
  const before = (status.get(id) || {}).state;
  status.set(id, { state, message });
  if (state === 'error' && before !== 'error') {
    const d = destinations.find((x) => x.id === id);
    sendAlert('stream', d ? d.name : 'A channel', `stopped receiving: ${message || 'no reason given'}`);
  }
}

// ---- signal numbers for the stream coming in from the Studio ----
// A second ffmpeg reads the incoming stream, copies it to nowhere, and we count the bytes.
// It does not decode video, so it costs very little.
const signal = { startedAt: 0, video: null, audio: null, kbps: 0, lastDataAt: 0, history: [], keyframe: null };
let monitor = null;
let noSignalSent = false; // so the "no video" alert is sent once, not every second

function resetSignal() {
  signal.startedAt = 0;
  signal.video = null;
  signal.audio = null;
  signal.kbps = 0;
  signal.lastDataAt = 0;
  signal.history = [];
  signal.keyframe = null;
}

function startMonitor() {
  if (monitor || !obsLive) return;
  resetSignal();
  signal.startedAt = Date.now();
  const args = [
    '-loglevel', 'info', '-nostats',
    ...HUB_IN,
    '-map', '0', '-c', 'copy', '-f', 'flv', 'pipe:1',
  ];
  const p = spawn(FFMPEG, args, { windowsHide: true });
  monitor = p;
  p.stdin.on('error', () => {});
  hub.subscribe(p.stdin, () => { try { p.kill('SIGKILL'); } catch {} });
  let bytes = 0;
  const rate = makeRateTracker();
  // seconds between keyframes: average of the last few gaps
  const gaps = [];
  let lastKey = null;
  const keys = makeKeyframeTracker((ts) => {
    if (lastKey !== null && ts > lastKey) {
      gaps.push(ts - lastKey);
      if (gaps.length > 4) gaps.shift();
      signal.keyframe = Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000) * 10) / 10;
    }
    lastKey = ts;
  });
  p.stdout.on('data', (c) => { bytes += c.length; keys(c); });
  p.stderr.on('data', (c) => c.toString().split(/\r?\n/).forEach((l) => parseStreamLine(l, signal)));
  const timer = setInterval(() => {
    if (obsLive && signal.lastDataAt && Date.now() - signal.lastDataAt > 8000 && !noSignalSent) {
      noSignalSent = true;
      sendAlert('studio', 'Studio', 'connected, but no video is arriving.');
    }
    if (Date.now() - signal.lastDataAt < 4000) noSignalSent = false;
    const k = rate(bytes);
    if (k == null) return;
    signal.kbps = Math.round(k);
    if (bytes > 0) signal.lastDataAt = Date.now();
    signal.history.push(signal.kbps);
    if (signal.history.length > 90) signal.history.shift();
  }, 1000);
  p.on('error', () => {});
  p.on('close', () => {
    clearInterval(timer);
    const wanted = !p.stoppedByUs;
    if (monitor === p) monitor = null;
    if (wanted && obsLive) setTimeout(startMonitor, 2000); // came up too early or dropped: try again
  });
}

function stopMonitor() {
  if (!monitor) return;
  const p = monitor;
  monitor = null;
  p.stoppedByUs = true;
  p.kill('SIGTERM');
}

// a destination that drops while the Studio is still sending starts again by itself
const autoRetry = createAutoRetry({
  restart: (id) => { const d = destinations.find((x) => x.id === id); if (d && obsLive) startDestination(d); },
  onWait: (id, reason, ms, n, max) => setStatus(id, 'error', `${reason || 'Dropped'} - trying again in ${Math.round(ms / 1000)} s (try ${n} of ${max})`),
  onGiveUp: (id, reason, max) => setStatus(id, 'error', `${reason || 'Stopped'} - gave up after ${max} tries. Press Restart.`),
});

function targetOf(d) {
  return `${d.url.replace(/\/+$/, '')}/${d.key}`;
}

function startDestination(d) {
  if (!obsLive || !d.enabled || procs.has(d.id)) return;
  if (!d.url || !d.key) {
    setStatus(d.id, 'error', 'Add the stream URL and key first');
    return;
  }
  setStatus(d.id, 'starting');
  // No re-encoding (low CPU): the Studio sends H.264 + AAC, which every platform accepts.
  // The one exception: Facebook and Instagram take 1080p at most, so a bigger picture gets a smaller copy.
  const cv = outargs.channelVideoArgs(d, studioOut, studioEncoder.key);
  const args = [
    '-loglevel', 'warning',
    '-nostats', '-progress', 'pipe:1', '-stats_period', '1', // numbers for the dashboard
    ...HUB_IN,
    ...cv.args,
    '-f', 'flv',
    targetOf(d),
  ];
  const p = spawn(FFMPEG, args, { windowsHide: true });
  const startedAt = Date.now();
  procs.set(d.id, p);
  p.stdin.on('error', () => {});
  // if this channel falls far behind (slow internet), it is stopped and starts again by itself
  hub.subscribe(p.stdin, () => { try { p.kill('SIGKILL'); } catch {} });
  // what we are really sending: average of the last few readings, because the sending comes in bursts
  const rate = makeRateTracker();
  const recent = [];
  p.stdout.on(
    'data',
    makeProgressParser((b) => {
      const k = rate(b.total_size);
      if (k != null) {
        recent.push(k);
        if (recent.length > 5) recent.shift();
      }
      const avg = recent.length ? recent.reduce((a, c) => a + c, 0) / recent.length : 0;
      const speed = parseFloat(b.speed);
      if (procs.get(d.id) === p) destStats.set(d.id, { kbps: Math.round(avg), speed: Number.isFinite(speed) ? speed : null });
    })
  );
  let lastLine = '';
  // ffmpeg prints nothing at "warning" level while healthy, so mark live after a short wait
  const liveTimer = setTimeout(() => {
    if (procs.get(d.id) === p) setStatus(d.id, 'live', cv.capped ? 'Sent as 1080p, the most this site takes' : '');
  }, 3000);
  p.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim().split('\n').pop();
    if (text) lastLine = text.replace(d.key, '***'); // never show the key
  });
  p.on('error', (err) => {
    clearTimeout(liveTimer);
    procs.delete(d.id);
    destStats.delete(d.id);
    setStatus(d.id, 'error', err.message);
  });
  p.on('close', (code, signal) => {
    clearTimeout(liveTimer);
    if (procs.get(d.id) === p) {
      procs.delete(d.id);
      destStats.delete(d.id);
    }
    if (signal === 'SIGTERM') return; // we stopped it on purpose
    if (obsLive) {
      if (d.enabled) autoRetry.dropped(d.id, lastLine || `Stopped (code ${code})`, Date.now() - startedAt);
      else setStatus(d.id, 'error', lastLine || `Stopped (code ${code})`);
    } else setStatus(d.id, 'off');
  });
}

function stopDestination(id, nextState = 'off') {
  autoRetry.cancel(id);
  const p = procs.get(id);
  if (p) {
    procs.delete(id);
    p.kill('SIGTERM');
  }
  destStats.delete(id);
  setStatus(id, nextState);
}

function stopAll() {
  stopMonitor();
  chat.stop();
  recorder.stop();
  for (const d of destinations) stopDestination(d.id);
}

// ---- Video coming in from the Studio ----
hub.on('start', () => {
  console.log('Video is coming in. Starting destinations...');
  obsLive = true;
  chat.clear();
  // small delay so the first keyframe is in the hub before the channels join
  setTimeout(() => {
    if (!obsLive) return;
    startMonitor();
    destinations.forEach(startDestination);
    if (recCfg.auto) recorder.start();
  }, 1000);
});
hub.on('end', () => {
  console.log('Video stopped coming in. Stopping destinations.');
  if (session.youtube || session.facebook) sendAlert('studio', 'Studio', 'the video stopped coming in, but the live is still open on ' + [session.youtube && 'YouTube', session.facebook && 'Facebook'].filter(Boolean).join(' and ') + '. Press End live when the service is finished.');
  obsLive = false;
  stopAll();
  resetSignal();
});
// Feed an ffmpeg's FLV output into the hub, but only once it really starts giving video,
// so a source that fails to start does not cut off the one that is working.
function feedHub(stdout) {
  let stop = null;
  stdout.once('data', (first) => { stop = hub.publish(stdout); hub.write(first); });
  return () => { if (stop) stop(); };
}




// ---- remote access (control the dashboard from a phone on the same Wi-Fi) ----
// The app window on this computer never needs a password. Any other device must switch this on and log in.
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let settings = { remote: { enabled: false, salt: '', hash: '' } };
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  settings.remote = { ...settings.remote, ...(saved.remote || {}) };
} catch {}
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
const sessions = new Map(); // login cookie -> expiry time
const SESSION_MS = 30 * 24 * 3600 * 1000;
const fails = new Map(); // ip -> { n, until }

function cookieOf(req, name) {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : '';
}
function validSession(req) {
  const t = cookieOf(req, 'ms_session');
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function samePassword(pw) {
  const r = settings.remote;
  if (!r.hash) return false;
  const a = Buffer.from(hashPw(pw, r.salt), 'hex');
  const b = Buffer.from(r.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${DASHBOARD_PORT}`);
  }
  return out;
}
function simplePage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Multistream</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c110e;color:#eef4f0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
.box{width:100%;max-width:340px;background:#141b17;border:1px solid #25322a;border-radius:8px;padding:22px}h1{margin:0 0 6px;font-size:18px}p{margin:0 0 14px;color:#92a39a}
input{width:100%;padding:11px 12px;border-radius:4px;border:1px solid #2c3b32;background:#0e1410;color:#eef4f0;font-size:16px;margin-bottom:12px}
button{width:100%;padding:11px;border:0;border-radius:4px;background:#22c55e;color:#052e14;font-size:15px;font-weight:600}.er{color:#ff8a90;margin:0 0 10px}</style></head><body><div class="box"><h1>${title}</h1>${body}</div></body></html>`;
}
function loginPage(error) {
  return simplePage('Multistream', `<p>Enter the password to control the stream.</p>${error ? `<p class="er">${error}</p>` : ''}
<form method="post" action="/login"><input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password"><button>Log in</button></form>`);
}

// ---- dashboard + API ----
const app = express();
// Phone control: a web server for other devices on the Wi-Fi. Only runs while "Allow other devices" is on.
let phoneServer = null, phoneError = '';
function syncPhoneServer() {
  const want = Boolean(settings.remote.enabled && settings.remote.hash);
  if (want && !phoneServer) {
    phoneError = '';
    const s = http.createServer(app);
    s.on('upgrade', (req, sock) => sock.destroy());
    s.on('error', (e) => { phoneError = e.code === 'EADDRINUSE' ? `Port ${DASHBOARD_PORT} is in use by another program (is Version 1 or 2 open?)` : e.message; if (phoneServer === s) phoneServer = null; });
    s.listen(DASHBOARD_PORT, '0.0.0.0');
    phoneServer = s;
  } else if (!want && phoneServer) {
    const s = phoneServer; phoneServer = null;
    try { s.close(); s.closeAllConnections && s.closeAllConnections(); } catch {}
  }
}
// YouTube sign-in: Google sends your browser back to this computer once. A small listener opens
// for that only, on this computer only, and closes again after sign-in (or after 5 minutes).
let loginServer = null, loginTimer = null;
function openLoginListener() {
  if (phoneServer || loginServer) return;
  const s = http.createServer(app);
  s.on('error', () => { if (loginServer === s) loginServer = null; });
  s.listen(DASHBOARD_PORT, '127.0.0.1');
  loginServer = s;
  clearTimeout(loginTimer); loginTimer = setTimeout(closeLoginListener, 5 * 60 * 1000);
}
function closeLoginListener() {
  clearTimeout(loginTimer);
  const s = loginServer; loginServer = null;
  if (s) setTimeout(() => { try { s.close(); s.closeAllConnections && s.closeAllConnections(); } catch {} }, 1500);
}
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));

// every request from another device must be allowed and logged in. This computer is always allowed.
app.use((req, res, next) => {
  if (isLocal(req)) return next();
  const r = settings.remote;
  if (!r.enabled || !r.hash) {
    return res.status(403).type('html').send(simplePage('Remote access is off', '<p>Turn it on in the Multistream app on the church computer: Settings, then Control from phone.</p>'));
  }
  if (req.method === 'POST' && req.path === '/login') return next();
  if (validSession(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in' });
  return res.type('html').send(loginPage());
});

app.post('/login', (req, res) => {
  if (isLocal(req)) return res.redirect('/');
  const ip = req.socket.remoteAddress || '';
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) return res.status(429).type('html').send(loginPage('Too many tries. Wait a minute and try again.'));
  if (samePassword((req.body || {}).password || '')) {
    fails.delete(ip);
    const t = crypto.randomBytes(24).toString('hex');
    sessions.set(t, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', `ms_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
    return res.redirect('/');
  }
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
  fails.set(ip, f);
  res.status(401).type('html').send(loginPage('Wrong password.'));
});

// settings for remote access: only the app window on this computer may change them
function remoteView() {
  return { enabled: settings.remote.enabled, hasPassword: Boolean(settings.remote.hash), addresses: lanAddresses(), running: Boolean(phoneServer), error: phoneError };
}
app.get('/api/remote', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Change this on the church computer' });
  res.json(remoteView());
});
app.put('/api/remote', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Change this on the church computer' });
  const { enabled, password } = req.body || {};
  const r = settings.remote;
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: 'Use at least 6 characters for the password' });
    r.salt = crypto.randomBytes(16).toString('hex');
    r.hash = hashPw(password, r.salt);
    sessions.clear(); // a new password logs everyone out
  }
  if (enabled !== undefined) {
    if (enabled && !r.hash) return res.status(400).json({ error: 'Set a password first' });
    r.enabled = Boolean(enabled);
    if (!r.enabled) sessions.clear();
  }
  saveSettings();
  syncPhoneServer();
  setTimeout(() => res.json(remoteView()), 300);
});

app.use(express.static(path.join(__dirname, 'public')));
// the small video-player library used by the preview
try {
  app.use('/vendor', express.static(path.join(path.dirname(require.resolve('flv.js/package.json')), 'dist')));
} catch {
  console.warn('flv.js was not found. The video preview will be off until you run: npm install');
}

function publicView(d) {
  return {
    id: d.id,
    name: d.name,
    url: d.url,
    hasKey: Boolean(d.key),
    keyEnd: d.key ? d.key.slice(-4) : '',
    enabled: d.enabled,
    cap1080: d.cap1080 === undefined ? null : d.cap1080,
    status: status.get(d.id) || { state: 'off', message: '' },
    stats: destStats.get(d.id) || null,
  };
}

// Dismiss on any page clears the alert on every page
app.post('/api/alerts/clear', (req, res) => { const g = ALERT_GROUPS.includes(req.query.group) ? req.query.group : 'stream'; clearAlerts(g); res.json({ ok: true }); });

app.get('/api/alerts', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': connected\n\n');
  const group = ALERT_GROUPS.includes(req.query.group) ? req.query.group : 'stream';
  alertClients.set(res, group);
  req.on('close', () => alertClients.delete(res));
});

app.get('/api/state', (req, res) => {
  res.json({
    obsLive,
    ingest: { preview: '/live.flv' },
    studio: { sending: studioInfo.sending },
    signal: {
      startedAt: signal.startedAt,
      video: signal.video,
      audio: signal.audio,
      kbps: signal.kbps,
      ok: Date.now() - signal.lastDataAt < 4000,
      history: signal.history.slice(-60),
      keyframe: signal.keyframe,
    },
    destinations: destinations.map(publicView),
    facebook: fbView(),
    youtube: ytView(),
    recording: recView(),
    session: { youtube: Boolean(session.youtube), facebook: Boolean(session.facebook) },
  });
});

app.get('/api/chat', (req, res) => res.json(chat.view(req.query.after)));

// ---- End live (the button that turns Go live back off) ----
app.post('/api/youtube/end', async (req, res) => {
  if (!session.youtube) return res.status(400).json({ error: 'There is no YouTube live to end' });
  // Stop sending first. Even if YouTube does not confirm, it ends the video by itself soon after the video stops.
  const d = ytDestination();
  if (d) stopDestination(d.id);
  chat.stopYoutube();
  let warning = '';
  try {
    await ytApi('POST', 'liveBroadcasts/transition', { broadcastStatus: 'complete', id: session.youtube, part: 'status' });
  } catch (e) {
    if (!/already|complete|invalid transition|redundant/i.test(e.message)) warning = e.message;
  }
  session.youtube = '';
  res.json({ ok: true, warning });
});
app.post('/api/facebook/end', async (req, res) => {
  if (!session.facebook) return res.status(400).json({ error: 'There is no Facebook live to end' });
  const d = fbDestination();
  if (d) stopDestination(d.id);
  chat.stopFacebook();
  let warning = '';
  try {
    const r = await fetch(`${GRAPH}/${session.facebook}`, { method: 'POST', body: new URLSearchParams({ access_token: fb.token, end_live_video: 'true' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !/already|ended|finished/i.test((j.error && j.error.message) || '')) warning = (j.error && j.error.message) || 'Facebook did not confirm';
  } catch { warning = 'Could not reach Facebook'; }
  session.facebook = '';
  res.json({ ok: true, warning });
});

// ---- Check everything before the service ----
app.get('/api/preflight', async (req, res) => {
  const dir = fs.existsSync(REC_DIR) ? REC_DIR : DATA_DIR;
  const results = await runPreflight({
    obsLive,
    signal,
    signalOk: Date.now() - signal.lastDataAt < 4000,
    youtube: ytView(),
    facebook: { ready: Boolean(fb.token && fb.pageId) },
    ytCheck: async () => (((await ytApi('GET', 'channels', { part: 'snippet', mine: 'true' })).items || [])[0] || {}).snippet?.title || '',
    fbCheck: async () => {
      const r = await fetch(`${GRAPH}/me?${new URLSearchParams({ fields: 'name', access_token: fb.token })}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || 'Facebook did not answer');
      return j.name || '';
    },
    freeBytes: async () => { try { const f = await fs.promises.statfs(dir); return Number(f.bavail) * Number(f.bsize); } catch { return null; } },
    destinations,
  });
  res.json({ at: Date.now(), results });
});

// ---- Recording routes ----
app.get('/api/recording', (req, res) => res.json({ ...recView(), files: recorder.list() }));
app.post('/api/recording/start', (req, res) => {
  if (!obsLive) return res.status(400).json({ error: 'Start Streaming in the Studio first' });
  const r = recorder.start();
  if (r.error) return res.status(500).json({ error: r.error });
  res.json(recView());
});
app.post('/api/recording/stop', async (req, res) => { await recorder.stop(); res.json(recView()); });
app.put('/api/recording', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Change this on the church computer' });
  recCfg = { auto: Boolean((req.body || {}).auto) };
  try { fs.writeFileSync(REC_FILE, JSON.stringify(recCfg)); } catch {}
  res.json(recView());
});
app.post('/api/recording/open', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Do this on the church computer' });
  try { fs.mkdirSync(REC_DIR, { recursive: true }); } catch {}
  if (!openFolderHook) return res.json({ error: 'Open this folder yourself: ' + REC_DIR });
  openFolderHook(REC_DIR);
  res.json({ ok: true });
});

// ---- Title and thumbnail for Go live ----
// The title the person typed is remembered. The thumbnail picture is kept in this computer's data folder.
const GL_FILE = path.join(DATA_DIR, 'golive.json');
let gl = { title: '' };
try { gl = { ...gl, ...JSON.parse(fs.readFileSync(GL_FILE, 'utf8')) }; } catch {}
const THUMBS = { 'image/png': path.join(DATA_DIR, 'thumbnail.png'), 'image/jpeg': path.join(DATA_DIR, 'thumbnail.jpg') };
function thumbFile() {
  for (const [type, file] of Object.entries(THUMBS)) if (fs.existsSync(file)) return { type, file };
  return null;
}
function goLiveTitle(req) {
  const body = req.body || {};
  const t = String(body.title || '').trim().slice(0, 100); // YouTube allows 100 characters
  if (typeof body.title === 'string' && t !== gl.title) {
    gl.title = t;
    try { fs.writeFileSync(GL_FILE, JSON.stringify(gl, null, 2)); } catch {}
  }
  return t || `Live from FCCHQ ${new Date().toLocaleDateString('en-NZ')}`;
}
app.get('/api/golive', (req, res) => res.json({ title: gl.title, hasThumbnail: Boolean(thumbFile()) }));
app.put('/api/golive/thumbnail', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Change this on the church computer' });
  const b = req.body;
  const type = Buffer.isBuffer(b) && b.length > 8
    ? (b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'image/png' : b.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg' : '')
    : '';
  if (!type) return res.status(400).json({ error: 'Choose a PNG or JPG picture' });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const f of Object.values(THUMBS)) fs.rmSync(f, { force: true });
    fs.writeFileSync(THUMBS[type], b);
  } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});
app.delete('/api/golive/thumbnail', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Change this on the church computer' });
  for (const f of Object.values(THUMBS)) { try { fs.rmSync(f, { force: true }); } catch {} }
  res.json({ ok: true });
});
app.get('/api/golive/thumbnail', (req, res) => {
  const t = thumbFile();
  t ? res.sendFile(t.file) : res.status(404).end();
});

// ---- Facebook Page: "Go live on Facebook" button ----
// The Page token is stored only in facebook.json on this computer. It is never sent back to the browser.
const FB_FILE = path.join(DATA_DIR, 'facebook.json');
let fb = { pageId: '', pageName: '', token: '' };
try {
  fb = { ...fb, ...JSON.parse(fs.readFileSync(FB_FILE, 'utf8')) };
} catch {}
function saveFb() {
  fs.writeFileSync(FB_FILE, JSON.stringify(fb, null, 2), { mode: 0o600 });
}
const GRAPH = 'https://graph.facebook.com/v26.0';
function fbView() {
  return { pageId: fb.pageId, pageName: fb.pageName, hasToken: Boolean(fb.token), tokenEnd: fb.token ? fb.token.slice(-4) : '' };
}
function fbDestination() {
  return destinations.find((d) => /facebook/i.test(d.name));
}
// Go live needs a channel to put the new key in. If the person has not added one yet, make it here.
function addDestination(name) {
  const d = { id: crypto.randomUUID(), name, url: '', key: '', enabled: true };
  destinations.push(d);
  save();
  return d;
}

app.get('/api/facebook', (req, res) => {
  res.json(fbView());
});

app.put('/api/facebook', async (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Change this on the church computer' });
  const pageId = String((req.body || {}).pageId || '').trim();
  const token = String((req.body || {}).token || '').trim();
  if (!/^\d+$/.test(pageId)) return res.status(400).json({ error: 'The Page ID is only numbers' });
  const newToken = token || fb.token;
  if (!newToken) return res.status(400).json({ error: 'Paste the Page access token' });
  try {
    const r = await fetch(`${GRAPH}/${pageId}?fields=name&access_token=${encodeURIComponent(newToken)}`);
    const j = await r.json();
    if (!r.ok || !j.id) return res.status(400).json({ error: (j.error && j.error.message) || 'Facebook did not accept this Page ID and token' });
    fb = { pageId, pageName: j.name || '', token: newToken };
    saveFb();
    res.json(fbView());
  } catch {
    res.status(502).json({ error: 'Could not reach Facebook. Check the internet connection.' });
  }
});

app.post('/api/facebook/live', async (req, res) => {
  if (!obsLive) return res.status(400).json({ error: 'Start Streaming in the Studio first' });
  if (!fb.token || !fb.pageId) return res.status(400).json({ error: 'Add the Facebook Page first' });
  const d = fbDestination() || addDestination('Facebook');
  const title = goLiveTitle(req);
  try {
    const r = await fetch(`${GRAPH}/${fb.pageId}/live_videos`, {
      method: 'POST',
      // Test mode: Facebook takes the stream but the video is not published on the Page.
      body: new URLSearchParams({ access_token: fb.token, status: (req.body || {}).test ? 'UNPUBLISHED' : 'LIVE_NOW', title }),
    });
    const j = await r.json();
    const streamUrl = j.secure_stream_url || j.stream_url;
    if (!r.ok || !streamUrl) return res.status(502).json({ error: (j.error && j.error.message) || 'Facebook did not create the live video' });
    // Facebook gives one full address. Split it into the URL and the key the relay already uses.
    const [addr, query] = streamUrl.split('?');
    const idx = addr.lastIndexOf('/');
    stopDestination(d.id);
    d.url = addr.slice(0, idx);
    d.key = addr.slice(idx + 1) + (query ? '?' + query : '');
    d.enabled = true;
    save();
    startDestination(d);
    session.facebook = j.id || '';
    chat.startFacebook(j.id);
    res.json({ ok: true, liveVideoId: j.id || '' });
  } catch {
    res.status(502).json({ error: 'Could not reach Facebook. Check the internet connection.' });
  }
});

// ---- YouTube: sign in once, then "Go live on YouTube" ----
// The file from Google and the login are stored only in youtube.json on this computer. They are never sent to the browser.
const YT_FILE = path.join(DATA_DIR, 'youtube.json');
let yt = { clientId: '', clientSecret: '', refreshToken: '', channelTitle: '' };
try {
  yt = { ...yt, ...JSON.parse(fs.readFileSync(YT_FILE, 'utf8')) };
} catch {}
function saveYt() {
  fs.writeFileSync(YT_FILE, JSON.stringify(yt, null, 2), { mode: 0o600 });
}
const YT_REDIRECT = `http://127.0.0.1:${DASHBOARD_PORT}/api/youtube/callback`;
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube';
let ytLoginState = '';
let ytAccess = { token: '', expires: 0 };
function ytView() {
  return { hasClient: Boolean(yt.clientId && yt.clientSecret), connected: Boolean(yt.refreshToken), channelTitle: yt.channelTitle };
}
function ytDestination() {
  return destinations.find((d) => /youtube/i.test(d.name));
}
const plain = (s) => String(s).replace(/[<>&"']/g, '');
async function googleToken(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: yt.clientId, client_secret: yt.clientSecret, ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'Google did not accept the login');
  return j;
}
async function ytAccessToken() {
  if (ytAccess.token && Date.now() < ytAccess.expires - 60000) return ytAccess.token;
  const j = await googleToken({ grant_type: 'refresh_token', refresh_token: yt.refreshToken });
  ytAccess = { token: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return ytAccess.token;
}
async function ytApi(method, endpoint, query, body) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams(query)}`, {
    method,
    headers: { Authorization: `Bearer ${await ytAccessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'YouTube returned an error');
  return j;
}

app.get('/api/youtube', (req, res) => {
  res.json(ytView());
});

// the file you download from Google (the OAuth client .json). Only the computer itself can set this.
app.put('/api/youtube/client', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Change this on the church computer' });
  const f = (req.body || {}).file || {};
  const c = f.installed || f.web || {};
  if (!c.client_id || !c.client_secret) return res.status(400).json({ error: 'This does not look like the file Google gave you' });
  yt = { clientId: String(c.client_id), clientSecret: String(c.client_secret), refreshToken: '', channelTitle: '' };
  ytAccess = { token: '', expires: 0 };
  saveYt();
  res.json(ytView());
});

app.get('/api/youtube/login', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Do this on the church computer' });
  if (!yt.clientId) return res.status(400).json({ error: 'Choose the file from Google first' });
  ytLoginState = crypto.randomBytes(16).toString('hex');
  openLoginListener();
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: yt.clientId,
    redirect_uri: YT_REDIRECT,
    response_type: 'code',
    scope: YT_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: ytLoginState,
  });
  res.json({ url });
});

// Google sends the browser back here after you approve
app.get('/api/youtube/callback', async (req, res) => {
  const page = (title, text) => res.type('html').send(simplePage(title, `<p>${text}</p>`));
  if (!isLocal(req)) return page('Not allowed', 'Open this on the church computer.');
  const { code, state, error } = req.query;
  if (error) return page('YouTube not connected', `Google said: ${plain(error)}. You can close this tab and try again.`);
  if (!ytLoginState || state !== ytLoginState) return page('YouTube not connected', 'This sign-in link is old. Go back to the app and click Connect YouTube again.');
  ytLoginState = '';
  try {
    const j = await googleToken({ grant_type: 'authorization_code', code: String(code), redirect_uri: YT_REDIRECT });
    if (!j.refresh_token) throw new Error('Google did not give a long-lasting login. Try again.');
    yt.refreshToken = j.refresh_token;
    ytAccess = { token: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
    const ch = await ytApi('GET', 'channels', { part: 'snippet', mine: 'true' });
    yt.channelTitle = (ch.items && ch.items[0] && ch.items[0].snippet && ch.items[0].snippet.title) || '';
    saveYt();
    page('YouTube connected', `Connected${yt.channelTitle ? ' to ' + plain(yt.channelTitle) : ''}. You can close this tab and go back to the app.`);
  } catch (e) {
    page('YouTube not connected', plain(e.message));
  }
  closeLoginListener();
});

async function ytSetThumbnail(videoId) {
  const t = thumbFile();
  if (!t) return;
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?${new URLSearchParams({ videoId })}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await ytAccessToken()}`, 'Content-Type': t.type },
    body: fs.readFileSync(t.file),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error((j.error && j.error.message) || 'YouTube did not accept the thumbnail');
  }
}
app.post('/api/youtube/live', async (req, res) => {
  if (!obsLive) return res.status(400).json({ error: 'Start Streaming in the Studio first' });
  if (!yt.refreshToken) return res.status(400).json({ error: 'Connect YouTube first' });
  const d = ytDestination() || addDestination('YouTube');
  const test = Boolean((req.body || {}).test);
  const title = goLiveTitle(req);
  try {
    // 1. the stream (the key) that the video is sent to
    const list = await ytApi('GET', 'liveStreams', { part: 'id,cdn', mine: 'true', maxResults: '50' });
    const streams = list.items || [];
    let stream = streams.find((s) => s.cdn && s.cdn.ingestionInfo && s.cdn.ingestionInfo.streamName === d.key) || streams[0];
    if (!stream) {
      stream = await ytApi('POST', 'liveStreams', { part: 'snippet,cdn' }, {
        snippet: { title: 'Multistream' },
        cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
      });
    }
    // 2. the broadcast (test mode makes it private). Auto start/stop: it goes live when video arrives and ends when it stops.
    const b = await ytApi('POST', 'liveBroadcasts', { part: 'snippet,status,contentDetails' }, {
      snippet: { title, scheduledStartTime: new Date().toISOString() },
      status: { privacyStatus: test ? 'private' : 'public', selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true },
    });
    // 3. join the broadcast to the stream
    await ytApi('POST', 'liveBroadcasts/bind', { id: b.id, part: 'id,contentDetails', streamId: stream.id });
    // the picture is optional: if YouTube refuses it, the live video still goes ahead
    let thumbnailError = '';
    try { await ytSetThumbnail(b.id); } catch (e) { thumbnailError = e.message; }
    // 4. send the video to that stream
    const info = stream.cdn.ingestionInfo;
    stopDestination(d.id);
    d.url = info.ingestionAddress;
    d.key = info.streamName;
    d.enabled = true;
    save();
    startDestination(d);
    // the chat id is on the broadcast. If it was not in the first answer, ask for it.
    let liveChatId = (b.snippet || {}).liveChatId;
    if (!liveChatId) {
      try { liveChatId = (((await ytApi('GET', 'liveBroadcasts', { part: 'snippet', id: b.id })).items || [])[0] || {}).snippet?.liveChatId; } catch {}
    }
    session.youtube = b.id;
    chat.startYoutube(liveChatId);
    res.json({ ok: true, broadcastId: b.id, thumbnailError });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});



app.post('/api/destinations', (req, res) => {
  const { name, url, key, cap1080 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is needed' });
  const d = { id: crypto.randomUUID(), name: String(name), url: String(url || ''), key: String(key || ''), enabled: true };
  if (typeof cap1080 === 'boolean') d.cap1080 = cap1080;
  destinations.push(d);
  save();
  startDestination(d);
  res.json(publicView(d));
});

app.put('/api/destinations/:id', (req, res) => {
  const d = destinations.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const { name, url, key, enabled, cap1080 } = req.body || {};
  if (cap1080 !== undefined) d.cap1080 = cap1080 === null ? undefined : Boolean(cap1080);
  const changedTarget = (url !== undefined && url !== d.url) || (key !== undefined && key !== '' && key !== d.key);
  if (name !== undefined) d.name = String(name);
  if (url !== undefined) d.url = String(url);
  if (key !== undefined && key !== '') d.key = String(key); // empty = keep the old key
  if (enabled !== undefined) d.enabled = Boolean(enabled);
  save();
  if (!d.enabled) stopDestination(d.id);
  else if (changedTarget) {
    stopDestination(d.id);
    startDestination(d);
  } else startDestination(d);
  res.json(publicView(d));
});

app.post('/api/destinations/:id/restart', (req, res) => {
  const d = destinations.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  stopDestination(d.id);
  startDestination(d);
  res.json(publicView(d));
});

app.delete('/api/destinations/:id', (req, res) => {
  stopDestination(req.params.id);
  status.delete(req.params.id);
  destinations = destinations.filter((x) => x.id !== req.params.id);
  save();
  res.json({ ok: true });
});


// ---- Built-in studio (replaces OBS) ----
// The studio page (studio.html) draws the scenes on a canvas, records it, and sends the video here over a
// local websocket. We hand it to ffmpeg, which pushes it into our own RTMP ingest, so the relay works as before.
const STUDIO_FILE = path.join(DATA_DIR, 'studio.json');
const ASSET_DIR = path.join(DATA_DIR, 'studio-assets');
let studio = { scenes: [], current: '', preview: '', audio: [] };
try { studio = { ...studio, ...JSON.parse(fs.readFileSync(STUDIO_FILE, 'utf8')) }; } catch {}
let studioRev = 1;
function saveStudio() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STUDIO_FILE, JSON.stringify(studio)); } catch {} studioRev++; }
app.get('/api/studio', (req, res) => res.json({ ...studio, rev: studioRev }));
app.put('/api/studio', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Edit scenes on the church PC' });
  const b = req.body || {};
  if (Array.isArray(b.scenes)) studio.scenes = b.scenes.slice(0, 60);
  if (Array.isArray(b.audio)) studio.audio = b.audio.slice(0, 40);
  if (typeof b.current === 'string') studio.current = b.current;
  saveStudio();
  res.json({ ok: true, rev: studioRev });
});
app.post('/api/studio/scene', (req, res) => {
  const name = String((req.body || {}).name || '');
  if (!studio.scenes.some((s) => s.name === name)) return res.status(404).json({ error: 'No such scene' });
  studio.current = name; saveStudio();
  res.json({ ok: true });
});
app.post('/api/studio/layer', (req, res) => {
  const b = req.body || {};
  const sc = studio.scenes.find((x) => x.name === b.scene);
  const l = sc && sc.layers.find((x) => x.id === b.id);
  if (!l) return res.status(404).json({ error: 'No such item' });
  l.visible = !!b.visible; saveStudio();
  res.json({ ok: true });
});
app.put('/api/studio/asset/:name', express.raw({ type: '*/*', limit: '30mb' }), (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Local only' });
  const n = path.basename(req.params.name).replace(/[^\w.\- ]/g, '_');
  try { fs.mkdirSync(ASSET_DIR, { recursive: true }); fs.writeFileSync(path.join(ASSET_DIR, n), req.body); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, url: '/api/studio/asset/' + encodeURIComponent(n) });
});
app.get('/api/studio/asset/:name', (req, res) => {
  const f = path.join(ASSET_DIR, path.basename(req.params.name));
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).end();
});

// local files named in an imported OBS scene file (pictures and videos). Only this PC can ask for them.
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|mp4|m4v|mov|webm|mkv)$/i;
app.get('/api/studio/file', (req, res) => {
  if (!isLocal(req)) return res.status(403).end();
  const p = String((req.query || {}).p || '');
  if (!path.isAbsolute(p) || !MEDIA_EXT.test(p) || !fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p, { dotfiles: 'allow' });
});
// phone-camera apps (DroidCam) serve a picture over Wi-Fi. We pass it through so the page may draw it.
app.get('/api/studio/ipcam', (req, res) => {
  if (!isLocal(req)) return res.status(403).end();
  let u; try { u = new URL(String((req.query || {}).url || '')); } catch { return res.status(400).end(); }
  const h = u.hostname;
  const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  if (u.protocol !== 'http:' || !lan) return res.status(400).json({ error: 'Only http addresses on your own network' });
  const r = require('http').get(u, (up) => { res.writeHead(up.statusCode || 200, { 'Content-Type': up.headers['content-type'] || 'image/jpeg' }); up.pipe(res); });
  r.on('error', () => { try { res.status(502).end(); } catch {} });
  req.on('close', () => r.destroy());
});
// pictures of the scenes, drawn by the studio page and shown in the Control Room
// The Studio only draws these while a Control Room is looking (it asks `watching` in the answer), so a Studio that is
// sending, recording and running the virtual camera does not also draw pictures nobody sees.
let studioShots = { at: 0, prog: '', pv: '', thumbs: {}, tv: 0, watched: 0 };
app.put('/api/studio/shots', (req, res) => {
  if (!isLocal(req)) return res.status(403).end();
  const b = req.body || {};
  if (b.ping) studioShots.at = Date.now();   // only "I am still here"
  else {
    const gotThumbs = b.thumbs && typeof b.thumbs === 'object';
    studioShots = { ...studioShots, at: Date.now(), prog: String(b.prog || ''), pv: String(b.pv || ''), thumbs: gotThumbs ? b.thumbs : studioShots.thumbs, tv: studioShots.tv + (gotThumbs ? 1 : 0) };
  }
  res.json({ ok: true, watching: Date.now() - studioShots.watched < 3000, wantThumbs: studioShots.tv === 0 });
});
// ?tv=N: the Control Room already has the small scene pictures number N, so they are not sent again
app.get('/api/studio/shots', (req, res) => {
  studioShots.watched = Date.now();
  const tv = Number((req.query || {}).tv);
  res.json({ alive: Date.now() - studioShots.at < 5000, prog: studioShots.prog, pv: studioShots.pv, tv: studioShots.tv, rev: studioRev, thumbs: tv === studioShots.tv ? undefined : studioShots.thumbs });
});
app.post('/api/studio/preview', (req, res) => { studio.preview = String((req.body || {}).name || ''); studioRev++; res.json({ ok: true }); });
let studioFf = null;
const studioInfo = { sending: false, error: '' };
app.get('/api/studio/status', (req, res) => res.json(studioInfo));

// the dashboard's video preview: a copy from the hub, inside the app
app.get('/live.flv', (req, res) => {
  if (!hub.live) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-cache' });
  const off = hub.subscribe(res, () => { try { res.end(); } catch {} });
  req.on('close', off);
});


// Which encoder the Studio uses: the graphics card if one works, else the processor. Tested once at start.
let studioEncoder = { key: 'software', id: 'libx264', name: 'processor (x264)' };
detectEncoder(FFMPEG).then((e) => { studioEncoder = e; studioInfo.encoder = e.name; console.log('Studio encoder: ' + e.name); }).catch(() => {});

const studioWss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 * 1024 });
// (the Studio's video, recording and virtual camera pipes are opened by openPipe() below)
// ---- Recording from the Studio: its own file, own quality, works with or without sending ----
const studioRecWss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 * 1024 });
studioRecWss.on('connection', (w, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  try { fs.mkdirSync(REC_DIR, { recursive: true }); } catch (e) { w.send(JSON.stringify({ error: 'Cannot make the folder: ' + e.message })); return w.close(); }
  const d = new Date(), two = (n) => String(n).padStart(2, '0');
  const name = `Studio ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}.mkv`;
  const args = outargs.recordArgs(studioEncoder.key, { h: q.get('h'), mbit: q.get('mbit'), fps: q.get('fps') }, path.join(REC_DIR, name));
  const ff = spawn(FFMPEG, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let last = '';
  ff.stderr.on('data', (c) => { last = String(c).trim().split('\n').pop().slice(0, 200); });
  ff.stdin.on('error', () => {});
  ff.on('exit', (code) => { try { w.send(JSON.stringify(code ? { error: last || 'Recording stopped (code ' + code + ')' } : { saved: name })); } catch {} try { w.close(); } catch {} });
  w.on('message', (m, isBin) => {
    if (isBin === false) { if (String(m) === 'stop') { try { ff.stdin.end(); } catch {} } return; }
    if (ff.stdin.writable) ff.stdin.write(m);
  });
  w.on('close', () => { try { ff.stdin.end(); } catch {} setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 8000); });
});
// ---- Virtual camera (Zoom etc.) ----
const vcam = createVcam({ ffmpeg: FFMPEG });
app.get('/api/vcam', (req, res) => res.json(vcam.state()));
app.post('/api/vcam/install', async (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Do this on the church computer' });
  res.json(await vcam.install(Boolean((req.body || {}).remove)));
});
const vcamWss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 * 1024 });
vcamWss.on('connection', (w) => {
  let s;
  try { s = vcam.start(1280, 720, 30); } catch (e) { try { w.send(JSON.stringify({ error: e.message })); w.close(); } catch {} return; }
  w.on('message', (m) => s.write(m));
  w.on('close', () => s.stop());
});
studioWss.on('connection', (w, req) => {
  if (studioFf) { try { studioFf.kill('SIGKILL'); } catch {} }
  const out = outargs.parseOut(new URL((req && req.url) || '/', 'http://x').searchParams);
  studioOut = out; studioInfo.out = outargs.label(out);
  const args = outargs.ingestArgs(studioEncoder.key, out);
  const ff = spawn(FFMPEG, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  studioFf = ff; studioInfo.sending = true; studioInfo.error = '';
  const unfeed = feedHub(ff.stdout);
  ff.on('close', unfeed);
  ff.stderr.on('data', (d) => { studioInfo.error = String(d).trim().split('\n').pop().slice(0, 200); });
  ff.stdin.on('error', () => {});
  ff.on('exit', () => { if (studioFf === ff) { studioFf = null; studioInfo.sending = false; } try { w.close(); } catch {} });
  w.on('message', (m) => { if (ff.stdin.writable) ff.stdin.write(m); });
  w.on('close', () => { try { ff.stdin.end(); setTimeout(() => ff.kill('SIGKILL'), 1500); } catch {} });
});

// ---- for the desktop app (main.js) ----
// A request from an app window, answered with no network: { method, url, headers, body } -> { status, headers, body }
function handle(r) { return inject(app, r); }
// A two-way pipe from an app window (instead of a WebSocket). toWindow(type, data) sends back to the window.
function openPipe(p, toWindow) {
  const url = String(p || '');
  const target = url.startsWith('/studio-record') ? studioRecWss : url.startsWith('/studio-vcam') ? vcamWss : url.startsWith('/studio-ingest') ? studioWss : null;
  if (!target) return null;
  const w = new FakeWs(toWindow);
  setImmediate(() => target.emit('connection', w, { url, socket: { remoteAddress: '127.0.0.1' }, headers: {} }));
  return w;
}
function shutdown() {
  stopAll();
  try { if (studioFf) studioFf.kill('SIGKILL'); } catch {}
  try { vcam.quit(); } catch {}
  for (const s of [phoneServer, loginServer]) { try { s && s.close(); } catch {} }
}
syncPhoneServer();

if (STANDALONE) {
  // for testing without the desktop app: open the dashboard in a browser at http://localhost:3000
  if (!phoneServer) { const s = http.createServer(app); s.listen(DASHBOARD_PORT, '127.0.0.1', () => console.log(`Dashboard (test mode): http://localhost:${DASHBOARD_PORT}`)); }
  process.on('SIGINT', () => {
    stopAll();
    process.exit(0);
  });
}

// used by the desktop app (main.js)
module.exports = { stopAll, shutdown, handle, openPipe, setOpenFolder: (fn) => { openFolderHook = fn; } };
