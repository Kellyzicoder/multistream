// Multistream relay.
// OBS  ->  rtmp://localhost/live/obs  ->  this app  ->  ffmpeg copies the video to each destination.
// Each destination gets its own ffmpeg process, so if one fails the others keep going.

const express = require('express');
const NodeMediaServer = require('node-media-server');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const os = require('os');
const { makeProgressParser, parseStreamLine, makeRateTracker, makeKeyframeTracker } = require('./stats');

const DASHBOARD_PORT = Number(process.env.PORT) || 3000;
const RTMP_PORT = 1935;
const HTTP_PORT = 8000; // the preview player watches the stream from here (http-flv)
const INGEST_PATH = '/live/obs'; // OBS server: rtmp://localhost/live   key: obs
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

// ---- relay state ----
let obsLive = false;
const procs = new Map(); // id -> ffmpeg process
const status = new Map(); // id -> { state, message }
const destStats = new Map(); // id -> { kbps, speed }  (what we are really sending to each platform)

function setStatus(id, state, message = '') {
  status.set(id, { state, message });
}

// ---- signal numbers for the stream coming in from OBS ----
// A second ffmpeg reads the incoming stream, copies it to nowhere, and we count the bytes.
// It does not decode video, so it costs very little.
const signal = { startedAt: 0, video: null, audio: null, kbps: 0, lastDataAt: 0, history: [], keyframe: null };
let monitor = null;

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
    '-i', `rtmp://127.0.0.1:${RTMP_PORT}${INGEST_PATH}`,
    '-map', '0', '-c', 'copy', '-f', 'flv', 'pipe:1',
  ];
  const p = spawn(FFMPEG, args, { windowsHide: true });
  monitor = p;
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
  const args = [
    '-loglevel', 'warning',
    '-nostats', '-progress', 'pipe:1', '-stats_period', '1', // numbers for the dashboard
    '-i', `rtmp://127.0.0.1:${RTMP_PORT}${INGEST_PATH}`,
    '-c', 'copy', // no re-encoding: low CPU. Set OBS to a bitrate/codec every platform accepts.
    '-f', 'flv',
    targetOf(d),
  ];
  const p = spawn(FFMPEG, args, { windowsHide: true });
  procs.set(d.id, p);
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
    if (procs.get(d.id) === p) setStatus(d.id, 'live');
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
    if (obsLive) setStatus(d.id, 'error', lastLine || `Stopped (code ${code})`);
    else setStatus(d.id, 'off');
  });
}

function stopDestination(id, nextState = 'off') {
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
  for (const d of destinations) stopDestination(d.id);
}

// ---- OBS ingest ----
// rtmp = video from OBS. http = lets the preview player in the window watch the same stream.
const nms = new NodeMediaServer({
  rtmp: { port: RTMP_PORT, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
  http: { port: HTTP_PORT, allow_origin: '*' },
  logType: 1,
});
nms.on('postPublish', (id, streamPath) => {
  if (streamPath !== INGEST_PATH) return;
  console.log('OBS connected. Starting destinations...');
  obsLive = true;
  // small delay so the first video packets are available before ffmpeg connects
  setTimeout(() => {
    startMonitor();
    destinations.forEach(startDestination);
  }, 1000);
});
nms.on('donePublish', (id, streamPath) => {
  if (streamPath !== INGEST_PATH) return;
  console.log('OBS disconnected. Stopping destinations.');
  obsLive = false;
  stopAll();
  resetSignal();
});
nms.run();


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
  return { enabled: settings.remote.enabled, hasPassword: Boolean(settings.remote.hash), addresses: lanAddresses() };
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
  res.json(remoteView());
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
    status: status.get(d.id) || { state: 'off', message: '' },
    stats: destStats.get(d.id) || null,
  };
}

app.get('/api/state', (req, res) => {
  res.json({
    obsLive,
    ingest: { server: `rtmp://localhost:${RTMP_PORT}/live`, key: 'obs', httpPort: HTTP_PORT, path: INGEST_PATH },
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
    obs: obsView(),
  });
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
  if (!obsLive) return res.status(400).json({ error: 'Start streaming in OBS first' });
  if (!fb.token || !fb.pageId) return res.status(400).json({ error: 'Add the Facebook Page first' });
  const d = fbDestination();
  if (!d) return res.status(400).json({ error: 'Add a channel named Facebook first' });
  const title = String((req.body || {}).title || '').trim() || `Live from FCCHQ ${new Date().toLocaleDateString('en-NZ')}`;
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
});

app.post('/api/youtube/live', async (req, res) => {
  if (!obsLive) return res.status(400).json({ error: 'Start streaming in OBS first' });
  if (!yt.refreshToken) return res.status(400).json({ error: 'Connect YouTube first' });
  const d = ytDestination();
  if (!d) return res.status(400).json({ error: 'Add a channel named YouTube first' });
  const test = Boolean((req.body || {}).test);
  const title = String((req.body || {}).title || '').trim() || `Live from FCCHQ ${new Date().toLocaleDateString('en-NZ')}`;
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
    // 4. send the video to that stream
    const info = stream.cdn.ingestionInfo;
    stopDestination(d.id);
    d.url = info.ingestionAddress;
    d.key = info.streamName;
    d.enabled = true;
    save();
    startDestination(d);
    res.json({ ok: true, broadcastId: b.id });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---- OBS remote control (OBS WebSocket, built into OBS 28 and newer) ----
// Shows the OBS scenes in the dashboard and switches scene. Only scene names, the current scene and small pictures are used.
const OBS_FILE = path.join(DATA_DIR, 'obs.json');
let obsCfg = { enabled: false, host: '127.0.0.1', port: 4455, password: '' };
try { obsCfg = { ...obsCfg, ...JSON.parse(fs.readFileSync(OBS_FILE, 'utf8')) }; } catch {}
function saveObsCfg() { fs.writeFileSync(OBS_FILE, JSON.stringify(obsCfg, null, 2), { mode: 0o600 }); }
const obsState = { connected: false, scenes: [], current: '', error: '', levels: {}, muted: {} };
const OBS_BASE_EVENTS = 4 | 8; // scene events + input events (mute changes)
const OBS_METER_EVENTS = 65536; // audio meters. These are busy, so they are only on while someone is watching
let obsMetersOn = false;
let obsLastLevelPoll = 0;
let obsWs = null;
let obsTimer = null;
let obsReqId = 0;
const obsPending = new Map();

function obsView() {
  return {
    enabled: obsCfg.enabled, host: obsCfg.host, port: obsCfg.port, hasPassword: Boolean(obsCfg.password),
    connected: obsState.connected, error: obsState.error, scenes: obsState.scenes, current: obsState.current,
  };
}
function obsRequest(type, data) {
  return new Promise((resolve, reject) => {
    if (!obsWs || obsWs.readyState !== 1 || !obsState.connected) return reject(new Error('OBS is not connected'));
    const id = String(++obsReqId);
    const t = setTimeout(() => { obsPending.delete(id); reject(new Error('OBS did not answer')); }, 5000);
    obsPending.set(id, { resolve, reject, t });
    obsWs.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data || {} } }));
  });
}
async function obsRefreshScenes() {
  try {
    const r = await obsRequest('GetSceneList');
    // OBS lists scenes from the bottom up, so flip them to match what you see in OBS
    obsState.scenes = (r.scenes || []).slice().reverse().map((x) => x.sceneName);
    obsState.current = r.currentProgramSceneName || '';
  } catch {}
}
async function obsRefreshInputs() {
  try {
    const r = await obsRequest('GetInputList');
    const muted = {};
    await Promise.all((r.inputs || []).map(async (i) => {
      try { muted[i.inputName] = Boolean((await obsRequest('GetInputMute', { inputName: i.inputName })).inputMuted); } catch {}
    }));
    obsState.muted = muted;
  } catch {}
}
function obsSetMeters(on) {
  if (!obsState.connected || obsMetersOn === on || !obsWs) return;
  obsMetersOn = on;
  if (!on) obsState.levels = {};
  obsWs.send(JSON.stringify({ op: 3, d: { eventSubscriptions: OBS_BASE_EVENTS | (on ? OBS_METER_EVENTS : 0) } }));
}
setInterval(() => obsSetMeters(Date.now() - obsLastLevelPoll < 4000), 2000);
function obsConnect() {
  clearTimeout(obsTimer);
  if (obsWs) { try { obsWs.removeAllListeners(); obsWs.on('error', () => {}); obsWs.close(); } catch {} obsWs = null; }
  for (const p of obsPending.values()) { clearTimeout(p.t); p.reject(new Error('OBS disconnected')); }
  obsPending.clear();
  obsState.connected = false;
  obsMetersOn = false;
  obsState.levels = {};
  thumbCache = { at: 0, w: 0, data: {} };
  if (!obsCfg.enabled) { obsState.error = ''; obsState.scenes = []; obsState.current = ''; return; }
  const retry = () => { if (obsWs === ws) { obsTimer = setTimeout(obsConnect, 3000); } };
  let ws;
  try { ws = new WebSocket(`ws://${obsCfg.host}:${obsCfg.port}`, { handshakeTimeout: 4000 }); } catch { obsState.error = 'Could not open the OBS address'; return; }
  obsWs = ws;
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.op === 0) {
      const d = { rpcVersion: 1, eventSubscriptions: OBS_BASE_EVENTS };
      const a = m.d && m.d.authentication;
      if (a) {
        const secret = crypto.createHash('sha256').update(obsCfg.password + a.salt).digest('base64');
        d.authentication = crypto.createHash('sha256').update(secret + a.challenge).digest('base64');
      }
      ws.send(JSON.stringify({ op: 1, d }));
    } else if (m.op === 2) {
      obsState.connected = true;
      obsState.error = '';
      obsMetersOn = false;
      await obsRefreshScenes();
      obsRefreshInputs();
    } else if (m.op === 5) {
      const e = m.d || {};
      if (e.eventType === 'CurrentProgramSceneChanged') obsState.current = e.eventData.sceneName;
      else if (e.eventType === 'SceneListChanged') obsRefreshScenes();
      else if (e.eventType === 'InputMuteStateChanged') obsState.muted[e.eventData.inputName] = Boolean(e.eventData.inputMuted);
      else if (e.eventType === 'InputCreated' || e.eventType === 'InputRemoved' || e.eventType === 'InputNameChanged') obsRefreshInputs();
      else if (e.eventType === 'InputVolumeMeters') {
        const seen = {};
        for (const i of (e.eventData && e.eventData.inputs) || []) {
          let mag = 0;
          let peak = 0;
          for (const ch of i.inputLevelsMul || []) { mag = Math.max(mag, ch[0] || 0); peak = Math.max(peak, ch[1] || ch[0] || 0); }
          const old = obsState.levels[i.inputName];
          seen[i.inputName] = { mag, peak: Math.max(peak, old ? old.peak : 0) };
        }
        obsState.levels = seen;
      }
    } else if (m.op === 7) {
      const p = obsPending.get(m.d.requestId);
      if (!p) return;
      obsPending.delete(m.d.requestId);
      clearTimeout(p.t);
      if (m.d.requestStatus && m.d.requestStatus.result) p.resolve(m.d.responseData || {});
      else p.reject(new Error((m.d.requestStatus && m.d.requestStatus.comment) || 'OBS said no'));
    }
  });
  ws.on('close', (code) => {
    if (obsWs !== ws) return;
    obsState.connected = false;
    obsState.error = code === 4009 ? 'Wrong OBS password' : 'Cannot reach OBS. Is OBS open, with the WebSocket server turned on?';
    retry();
  });
  ws.on('error', () => {});
}
let thumbCache = { at: 0, w: 0, data: {} };
let thumbBusy = null;
async function obsThumbs(w) {
  if (Date.now() - thumbCache.at < 1200 && thumbCache.w === w) return thumbCache.data;
  if (thumbBusy) return thumbBusy;
  thumbBusy = (async () => {
    const data = {};
    for (const name of obsState.scenes) {
      try {
        const r = await obsRequest('GetSourceScreenshot', { sourceName: name, imageFormat: 'jpg', imageWidth: w, imageHeight: Math.round((w * 9) / 16), imageCompressionQuality: 40 });
        data[name] = r.imageData;
      } catch {}
    }
    thumbCache = { at: Date.now(), w, data };
    return data;
  })();
  try { return await thumbBusy; } finally { thumbBusy = null; }
}
app.get('/api/obs', (req, res) => res.json(obsView()));
app.put('/api/obs', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Change this on the church computer' });
  const b = req.body || {};
  if (typeof b.enabled === 'boolean') obsCfg.enabled = b.enabled;
  if (b.host !== undefined) obsCfg.host = String(b.host).trim() || '127.0.0.1';
  if (b.port !== undefined) {
    const port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'The port must be a number, usually 4455' });
    obsCfg.port = port;
  }
  if (typeof b.password === 'string' && b.password !== '') obsCfg.password = b.password;
  if (b.clearPassword === true) obsCfg.password = '';
  saveObsCfg();
  obsConnect();
  res.json(obsView());
});
app.post('/api/obs/scene', async (req, res) => {
  const name = String((req.body || {}).name || '');
  if (!obsState.scenes.includes(name)) return res.status(400).json({ error: 'That scene is not in OBS' });
  try {
    await obsRequest('SetCurrentProgramScene', { sceneName: name });
    obsState.current = name;
    res.json({ current: name });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.get('/api/obs/thumbs', async (req, res) => {
  if (!obsState.connected) return res.json({});
  const w = Math.min(400, Math.max(80, Number((req.query || {}).w) || 160));
  res.json(await obsThumbs(w));
});
let shotCache = {};
async function obsShot(name, w) {
  const key = name + '|' + w;
  const c = shotCache[key];
  if (c && Date.now() - c.at < 200) return c.img;
  const r = await obsRequest('GetSourceScreenshot', { sourceName: name, imageFormat: 'jpg', imageWidth: w, imageHeight: Math.round((w * 9) / 16), imageCompressionQuality: 45 });
  shotCache[key] = { at: Date.now(), img: r.imageData };
  return r.imageData;
}
app.get('/api/obs/shots', async (req, res) => {
  if (!obsState.connected) return res.json({});
  const q = req.query || {};
  const w = Math.min(960, Math.max(160, Number(q.w) || 640));
  const out = {};
  for (const k of ['a', 'b']) {
    const name = String(q[k] || '');
    if (!name || !obsState.scenes.includes(name)) continue;
    try { out[k] = await obsShot(name, w); } catch {}
  }
  res.json(out);
});
const toDb = (m) => (m > 0 ? Math.max(-100, 20 * Math.log10(m)) : -100);
app.get('/api/obs/levels', (req, res) => {
  obsLastLevelPoll = Date.now();
  obsSetMeters(true);
  const out = {};
  for (const [name, v] of Object.entries(obsState.levels)) {
    out[name] = { mag: Math.round(toDb(v.mag) * 10) / 10, peak: Math.round(toDb(v.peak) * 10) / 10 };
    v.peak = v.mag; // the peak is held until it has been read once
  }
  res.json({ connected: obsState.connected, levels: out, muted: obsState.muted });
});
if (obsCfg.enabled) obsConnect();

app.post('/api/destinations', (req, res) => {
  const { name, url, key } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is needed' });
  const d = { id: crypto.randomUUID(), name: String(name), url: String(url || ''), key: String(key || ''), enabled: true };
  destinations.push(d);
  save();
  startDestination(d);
  res.json(publicView(d));
});

app.put('/api/destinations/:id', (req, res) => {
  const d = destinations.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const { name, url, key, enabled } = req.body || {};
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
let studioShots = { at: 0, prog: '', pv: '', thumbs: {} };
app.put('/api/studio/shots', (req, res) => {
  if (!isLocal(req)) return res.status(403).end();
  const b = req.body || {};
  studioShots = { at: Date.now(), prog: String(b.prog || ''), pv: String(b.pv || ''), thumbs: b.thumbs && typeof b.thumbs === 'object' ? b.thumbs : studioShots.thumbs };
  res.json({ ok: true });
});
app.get('/api/studio/shots', (req, res) => res.json({ alive: Date.now() - studioShots.at < 5000, prog: studioShots.prog, pv: studioShots.pv, thumbs: studioShots.thumbs }));
app.post('/api/studio/preview', (req, res) => { studio.preview = String((req.body || {}).name || ''); studioRev++; res.json({ ok: true }); });
let studioFf = null;
const studioInfo = { sending: false, error: '' };
app.get('/api/studio/status', (req, res) => res.json(studioInfo));

const httpServer = app.listen(DASHBOARD_PORT, '0.0.0.0', () => {
  console.log(`\nDashboard:  http://localhost:${DASHBOARD_PORT}`);
  console.log(`In OBS use: Server  rtmp://localhost:${RTMP_PORT}/live   Stream key  obs\n`);
});

const studioWss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 * 1024 });
httpServer.on('upgrade', (req, sock, head) => {
  if (!req.url.startsWith('/studio-ingest')) return sock.destroy();
  if (!isLocal(req)) return sock.destroy();
  studioWss.handleUpgrade(req, sock, head, (w) => studioWss.emit('connection', w));
});
studioWss.on('connection', (w) => {
  if (studioFf) { try { studioFf.kill('SIGKILL'); } catch {} }
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-vf', 'scale=1280:720', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-b:v', '4500k', '-maxrate', '4500k', '-bufsize', '9000k',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-f', 'flv', `rtmp://127.0.0.1:${RTMP_PORT}${INGEST_PATH}`];
  const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  studioFf = ff; studioInfo.sending = true; studioInfo.error = '';
  ff.stderr.on('data', (d) => { studioInfo.error = String(d).trim().split('\n').pop().slice(0, 200); });
  ff.stdin.on('error', () => {});
  ff.on('exit', () => { if (studioFf === ff) { studioFf = null; studioInfo.sending = false; } try { w.close(); } catch {} });
  w.on('message', (m) => { if (ff.stdin.writable) ff.stdin.write(m); });
  w.on('close', () => { try { ff.stdin.end(); setTimeout(() => ff.kill('SIGKILL'), 1500); } catch {} });
});

if (STANDALONE) {
  process.on('SIGINT', () => {
    stopAll();
    process.exit(0);
  });
}

// used by the desktop app (main.js)
module.exports = { stopAll, DASHBOARD_PORT, RTMP_PORT };
