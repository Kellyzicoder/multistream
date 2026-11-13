// Desktop app (Windows + Mac). Version 3: the windows talk to the app directly, with no localhost.
// Pages load from app://multistream/... and every request is answered inside the app (server.js handle()).

const { app, BrowserWindow, dialog, shell, ipcMain, desktopCapturer, session, protocol, net: electronNet, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
// The app was called "Multistream 3". Its saved settings (keys, scenes, sign-ins) are in a folder with that name:
// keep using it, so nothing has to be typed in again after the name changed to "Multistream".
try { const old = path.join(app.getPath('appData'), 'Multistream 3'); if (fs.existsSync(old)) app.setPath('userData', old); } catch {}
const { spawn } = require('child_process');
const { Readable } = require('stream');

const HOME = 'app://multistream';

let win = null;
let relay = null; // the server module, once started

// ---- safety: only the app's own pages may use the app ----
const isAppUrl = (u) => typeof u === 'string' && (u === HOME || u.startsWith(HOME + '/'));
// a message from a window is only answered when it comes from one of the app's own pages
function fromApp(e) { try { return isAppUrl(e.senderFrame && e.senderFrame.url); } catch { return false; } }
const handleIpc = (name, fn) => ipcMain.handle(name, (e, ...a) => (fromApp(e) ? fn(e, ...a) : undefined));
const onIpc = (name, fn) => ipcMain.on(name, (e, ...a) => { if (fromApp(e)) fn(e, ...a); });
handleIpc('ms-version', () => app.getVersion());
// Web pages used as Studio sources (like a lyrics site) run in their own separate space: no camera,
// microphone or screen, no pop-ups, and they cannot reach the app's pages or settings.
const WEB_SOURCES = 'persist:web-sources';
let webSes = null;
function webSourcesSession() {
  if (webSes) return webSes;
  webSes = session.fromPartition(WEB_SOURCES);
  webSes.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  webSes.setPermissionCheckHandler(() => false);
  webSes.setDisplayMediaRequestHandler((req, cb) => cb({}));
  return webSes;
}
// the app's pages may use cameras, microphones and screen capture; nothing else may
function setupAppSession(ses) {
  ses.setPermissionRequestHandler((wc, perm, cb, details) => {
    const from = (details && details.requestingUrl) || (wc && !wc.isDestroyed() ? wc.getURL() : '');
    cb(isAppUrl(from) && ['media', 'mediaKeySystem', 'display-capture'].includes(perm));
  });
}
app.on('web-contents-created', (e, contents) => {
  const isWebSource = () => webSes && contents.session === webSes;
  // the app's own windows stay on the app's pages; a link to a website opens in the normal browser
  const guard = (ev, url) => {
    if (isWebSource() || isAppUrl(url)) return;
    ev.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  // pop-ups: web sources get none; app windows get the projector, and websites open in the normal browser
  // (the Stream and Studio windows set their own rules on top of this)
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebSource()) return { action: 'deny' };
    const p = projectorOptions(url); if (p) return p;
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

// must be set before the app is ready: app:// behaves like a normal secure web address (camera, fetch, video)
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);
function serveApp(ses) {
  ses.protocol.handle('app', async (request) => {
    const u = new URL(request.url);
    const method = request.method || 'GET';
    let body = null;
    if (!['GET', 'HEAD'].includes(method)) body = Buffer.from(await request.arrayBuffer());
    const headers = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    // only the app's own pages may ask the app for things
    if (['cross-site', 'same-site'].includes(headers['sec-fetch-site'])) return new Response('Not allowed', { status: 403 });
    const r = await relay.handle({ method, url: u.pathname + u.search, headers, body });
    const noBody = [101, 204, 205, 304].includes(r.status) || method === 'HEAD';
    if (noBody) r.body.resume();
    return new Response(noBody ? null : Readable.toWeb(r.body), { status: r.status, headers: r.headers });
  });
}

// ffmpeg is bundled with the app. When installed, it sits outside the packed app file.
function ffmpegPath() {
  let p = require('ffmpeg-static');
  if (app.isPackaged) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: 'Multistream',
    autoHideMenuBar: false,
    backgroundColor: '#eaf1fb',
    // the Studio runs inside this window (in the background while you look at other pages) and makes the video,
    // so the window never slows down. The app's own pages inside it (the Studio) get the app's helpers too.
    webPreferences: { contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(__dirname, 'preload.js') },
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => console.error('Page failed to load:', code, desc, url));
  win.loadURL(HOME + '/').catch((e) => console.error('Dashboard did not load:', e && e.message));
  // the Analytics page shows your own live dashboard website inside it: some sites say "do not show me inside
  // another page", so that rule is removed for pages shown inside the app's own pages (not for whole windows)
  if (!win.webContents.session.__msFrames) {
    win.webContents.session.__msFrames = true;
    win.webContents.session.webRequest.onHeadersReceived({ urls: ['https://*/*'] }, (d, cb) => {
      const top = d.webContents && !d.webContents.isDestroyed() ? d.webContents.getURL() : '';
      if (d.resourceType !== 'subFrame' || !isAppUrl(top)) return cb({});
      const h = { ...d.responseHeaders };
      for (const k of Object.keys(h)) {
        if (k.toLowerCase() === 'x-frame-options') delete h[k];
        else if (k.toLowerCase() === 'content-security-policy') h[k] = h[k].map((v) => v.replace(/frame-ancestors[^;]*;?/gi, ''));
      }
      cb({ responseHeaders: h });
    });
  }
  // links that leave the dashboard open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    const p = projectorOptions(url); if (p) return p;
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // closing the main window closes the whole app, with any Multiview or other window that is still open
  win.on('closed', () => { win = null; app.quit(); });
}


// ---- OBS engine (test) ----
// The engine draws the picture on the graphics card inside the app (see engine.js), the way OBS does, and it
// makes the video that goes live and into recordings.
// It is off unless switched on in the Help menu (Windows). Why: on Windows a camera or capture card
// (like a Blackmagic) can be open in one place only, and both the engine and the Studio page open it, so one of
// them can get a black picture. On the Mac it sometimes froze the app just after opening. Until both are fixed,
// the Studio makes the video itself, as before.
// (MULTISTREAM_ENGINE=off or =on changes this, for tests and for help with problems.)
let engineMod = null;
const engine = () => engineMod || (engineMod = require('./engine'));
const engineFile = () => path.join(app.getPath('userData'), 'engine-settings.json');
function engineOn() {
  if (process.env.MULTISTREAM_ENGINE === 'off') return false;
  if (process.env.MULTISTREAM_ENGINE === 'on') return true;
  if (process.platform !== 'win32') return false;
  try { return JSON.parse(fs.readFileSync(engineFile(), 'utf8')).test === true; } catch (e) { return false; }
}
// the Help menu switch: it is used the next time the app opens (the engine starts before the window shows)
function setEngine(on) {
  try { fs.writeFileSync(engineFile(), JSON.stringify({ test: Boolean(on) })); } catch (e) {}
  setMenu();
  dialog.showMessageBox({ type: 'info', message: on ? 'The OBS engine (test) is on.' : 'The OBS engine (test) is off.', detail: 'Close Multistream and open it again to use this.' });
}
// Starting the engine keeps the app busy for a second or two, so it is done before the window shows:
// then the window answers clicks straight away, instead of freezing just after it opens.
function startEngineFirst() {
  if (!engineOn() || !engine().available() || engine().isStarted()) return;
  if (!engine().start()) console.error('Engine: could not start, the Studio makes the video itself');
}
async function startEngine() {
  if (!engine().isStarted()) return;
  await engine().askMacCamera();
  if (win && !win.isDestroyed()) win.webContents.send('ms-engine', engineState());
  engineFollow(engine().isStarted());
}

// The engine builds the Studio's scenes: whenever the Studio saves (a new source, a move, another scene on air),
// the engine gets the same scenes. Only the facts it needs are sent: where each file is on this computer,
// and which screen (by its place in the list of screens).
let engineTimer = null, engineRev = -1, engineTrans = { type: 'fade', ms: 500 }, screenIds = [], screenAt = 0;
async function screenOrder() {
  if (Date.now() - screenAt < 10000) return screenIds;
  try { screenIds = (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })).map((s) => s.id); } catch (e) {}
  screenAt = Date.now();
  return screenIds;
}
function engineFile_(l, assets) {
  if (l.file && path.isAbsolute(l.file)) return l.file;
  const m = /^\/api\/studio\/asset\/(.+)$/.exec(l.url || '');
  if (m) { try { return path.join(assets, path.basename(decodeURIComponent(m[1]))); } catch (e) { return ''; } }
  return '';
}
async function engineSend(force) {
  if (!relay || !relay.studioNow || !engine().isStarted()) return;
  const now = relay.studioNow();
  if (!force && now.rev === engineRev) return;
  engineRev = now.rev;
  const st = now.studio || {};
  const order = await screenOrder();
  const [w, h] = st.shape === 'portrait' ? [1080, 1920] : st.shape === 'square' ? [1080, 1080] : [1920, 1080];
  const scenes = (st.scenes || []).map((sc) => ({
    name: String(sc.name || ''),
    layers: (sc.layers || []).map((l) => {
      const x = { ...l };
      if (l.type === 'image' || l.type === 'video') {
        x.path = engineFile_(l, now.assets);
        x.link = !x.path && /^https?:\/\//i.test(l.url || '') ? l.url : '';
      }
      if (l.type === 'screen' || (l.type === 'duo' && l.scrType !== 'window')) { const i = order.indexOf(l.display); x.screenIndex = i >= 0 ? i : 0; }
      if (l.type === 'duo' && l.bg && l.bg.kind === 'picture') x.bg = { ...l.bg, path: engineFile_(l.bg, now.assets) };
      return x;
    }),
  }));
  let ov = '';
  try { ov = relay.overlayBase ? await relay.overlayBase() : ''; } catch (e) {}
  engine().sync({ w, h, scenes, audio: st.audio || [], current: String(st.current || ''), trans: engineTrans, ov });
}
function engineFollow(on) {
  if (engineTimer) { clearInterval(engineTimer); engineTimer = null; }
  engineRev = -1;
  if (!on) return;
  engineSend(true);
  engineTimer = setInterval(() => { engineSend(false).catch(() => {}); }, 400);
}
// Going live with the engine: the Studio asks, the app opens its receiver, and the engine sends to it.
// o: { h, fps, kbps, shape } (the Studio's Output settings)
handleIpc('ms-engine-send', async (e, o) => {
  if (!relay || !relay.engineIngest || !engine().isStarted()) return { ok: false, error: 'The OBS engine is not on' };
  try {
    await engineSend(true);
    const ing = await relay.engineIngest(o || {});
    const r = engine().startStream(ing);
    if (!r.ok) relay.engineIngestStop();
    return r;
  } catch (err) {
    try { relay.engineIngestStop(); } catch (_) {}
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});
handleIpc('ms-engine-unsend', () => {
  try { engine().stopStream(); } catch (e) {}
  try { if (relay && relay.engineIngestStop) relay.engineIngestStop(); } catch (e) {}
  return true;
});
// Recording with the engine. o: { w, h, fps, kbps }
let engineRecFile = '';
handleIpc('ms-engine-record', (e, o) => {
  if (!relay || !relay.engineRecName || !engine().isStarted()) return { ok: false, error: 'The OBS engine is not on' };
  try {
    const n = relay.engineRecName();
    const r = engine().startRecord({ ...(o || {}), dir: n.dir, base: n.base });
    if (r.ok) engineRecFile = n.name;
    return r;
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
});
handleIpc('ms-engine-unrecord', async () => {
  const r = await engine().stopRecord();
  const name = engineRecFile; engineRecFile = '';
  if (r.ok && name) { relay.engineRecSaved(name); return { ok: true, saved: name }; }
  return r;
});
handleIpc('ms-engine-sendstate', () => (engineMod ? engine().streamState() : { sending: false, active: false }));
// the Studio's transition (Cut, Fade, Slide, Dip to black) and how long it takes
handleIpc('ms-engine-trans', (e, t) => {
  if (t && typeof t === 'object') engineTrans = { type: String(t.type || 'fade'), ms: Math.max(0, Math.min(5000, Number(t.ms) || 0)) };
  engineSend(true).catch(() => {});
  return true;
});
function engineState() {
  return { available: engine().available(), on: engineOn(), started: engine().isStarted() };
}
handleIpc('ms-engine-state', () => engineState());
// the page tells where its preview box is (or null when it is hidden); the engine draws its picture there
handleIpc('ms-engine-preview', (e, rect) => (win && e.sender === win.webContents ? engine().showPreview(win, rect) : false));
// any box on the app's own windows (the Studio's Program, the Multiview): key, where it is, and what it shows
// Copy buttons: the app's own clipboard (the page's clipboard needs a permission the app does not give)
handleIpc('ms-copy', (e, text) => { require('electron').clipboard.writeText(String(text || '').slice(0, 10000)); return true; });
handleIpc('ms-engine-display', (e, key, rect, src) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || (w !== win && w !== crWin) || !engineMod || !engine().isStarted()) return false;
  const k = 'w' + e.sender.id + '-' + String(key || '').replace(/[^\w-]/g, '').slice(0, 40);
  const what = src && typeof src === 'object' && src.scene ? { scene: String(src.scene) } : 'program';
  return engine().showDisplay(w, k, rect && typeof rect === 'object' ? { x: +rect.x || 0, y: +rect.y || 0, width: +rect.width || 0, height: +rect.height || 0 } : null, what);
});

// ---- Studio helpers ----
let studioWin = null;
// same = true: the Studio replaces the dashboard in the same window (a button in the Studio goes back).
handleIpc('ms-open-studio', (e, same) => {
  if (studioWin) { studioWin.focus(); return; }
  if (same && win && !win.isDestroyed()) { win.webContents.setBackgroundThrottling(false); win.loadURL(HOME + '/studio.html?same=1'); return; }
  studioWin = new BrowserWindow({
    width: 1400, height: 860, title: 'Multistream Studio', autoHideMenuBar: false, backgroundColor: '#0f1512',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(__dirname, 'preload.js') },
  });
  studioWin.loadURL(HOME + '/studio.html');
  studioWin.webContents.setWindowOpenHandler(({ url }) => projectorOptions(url) || (url.startsWith(HOME) || url === 'about:blank' || url === '' ? { action: 'allow' } : (/^https?:\/\//i.test(url) && shell.openExternal(url), { action: 'deny' })));
  studioWin.on('closed', () => { studioWin = null; browsers.forEach((b) => b.destroy()); browsers.clear(); });
});
handleIpc('ms-open-dashboard', () => {
  if (!win || win.isDestroyed()) return;
  // the Studio has its own window: only bring the Go Live page to the front (reloading would close the Studio's web pages)
  if (studioWin && !studioWin.isDestroyed()) { win.show(); win.focus(); return; }
  browsers.forEach((b) => b.destroy()); browsers.clear();
  win.webContents.setBackgroundThrottling(true);
  win.loadURL(HOME + '/');
  win.show(); win.focus(); // bring the Go Live page to the front
});
// the screens that are connected (for showing the Multiview or a Preview/Program picture full screen on one of them)
const displayList = () => { const main = screen.getPrimaryDisplay().id; return screen.getAllDisplays().map((d, i) => ({ id: d.id, n: i + 1, label: d.label || '', w: d.size.width, h: d.size.height, main: d.id === main })); };
handleIpc('ms-displays', () => { try { return displayList(); } catch { return []; } });
const displayById = (id) => (id == null || id === '' ? null : screen.getAllDisplays().find((d) => String(d.id) === String(id)) || null);
// window.open of /projector.html (a picture of the Preview or Program): a normal window, or full screen on the chosen display
function projectorOptions(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'app:' || u.pathname !== '/projector.html') return null;
  const d = displayById(u.searchParams.get('d')), o = { backgroundColor: '#000000', autoHideMenuBar: true, title: 'Multistream Projector' };
  if (d) Object.assign(o, { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, fullscreen: true, frame: false });
  else Object.assign(o, { width: 960, height: 540 });
  return { action: 'allow', overrideBrowserWindowOptions: o };
}
let crWin = null;
handleIpc('ms-open-cr', (e, displayId) => openMultiview(displayId));
function openMultiview(displayId) {
  const d = displayById(displayId);
  if (crWin && !crWin.isDestroyed()) crWin.close();
  const o = { width: 1280, height: 800, title: 'Multistream Multiview', autoHideMenuBar: true, backgroundColor: '#07090b', show: !d,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') } };
  if (d) Object.assign(o, { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height });
  const w = crWin = new BrowserWindow(o);
  if (d) {
    w.once('ready-to-show', () => { w.setBounds(d.bounds); w.setFullScreen(true); w.show(); });
    // Esc leaves full screen (the window stays, on that display)
    w.webContents.on('before-input-event', (ev, input) => { if (input.type === 'keyDown' && input.key === 'Escape' && w.isFullScreen()) { w.setFullScreen(false); ev.preventDefault(); } });
  }
  w.loadURL(HOME + '/#control-room');
  w.on('closed', () => { if (crWin === w) crWin = null; });
}
// A web page (like the lyrics page) is drawn off-screen. We pass each new picture of it to the studio page.
const browsers = new Map();
handleIpc('ms-browser-open', (e, id, url, w, h) => {
  if (browsers.has(id)) return;
  const to = e.senderFrame;
  if (!/^https?:\/\//i.test(String(url))) return;
  const b = new BrowserWindow({ show: false, width: w || 1920, height: h || 1080, transparent: true, frame: false, webPreferences: { offscreen: true, backgroundThrottling: false, session: webSourcesSession(), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  b.webContents.setFrameRate(15);
  b.webContents.on('paint', (ev, dirty, image) => {
    const size = image.getSize();
    if (!e.sender.isDestroyed()) { try { to.send('ms-frame', id, size.width, size.height, image.toBitmap()); } catch {} }
  });
  b.webContents.setAudioMuted(false);
  b.loadURL(String(url)).catch(() => {});
  browsers.set(id, b);
});
handleIpc('ms-browser-close', (e, id) => { const b = browsers.get(id); if (b) { b.destroy(); browsers.delete(id); } });
// (sending on, or closing, a pipe only works for a pipe that window opened, so these need no page check)
// Two-way pipes between a window and the app (the Studio's video, recording and virtual camera).
// They used to be WebSockets on localhost. Now they are plain messages inside the app.
const pipes = new Map();
// One listener per window (not one per pipe) closes that window's pipes when the window goes away.
const pipeWatch = new Set();
function closePipesOf(senderId) {
  for (const [key, w] of pipes) if (key.startsWith(senderId + ':')) { pipes.delete(key); w.windowClosed(); }
}
// a page inside the window (the Studio) has its own pipes, so the key names the frame too
const frameKey = (e) => e.sender.id + ':' + (e.senderFrame ? e.senderFrame.processId + '.' + e.senderFrame.routingId : '0');
onIpc('ms-pipe-open', (e, id, p) => {
  const key = frameKey(e) + ':' + id, sid = e.sender.id, frame = e.senderFrame;
  const toWindow = (type, data) => { if (!e.sender.isDestroyed()) { try { frame.send('ms-pipe-ev', id, type, data); } catch {} } if (type === 'close') pipes.delete(key); };
  const w = relay && relay.openPipe(String(p), toWindow);
  if (!w) { toWindow('close'); return; }
  pipes.set(key, w);
  toWindow('open');
  if (!pipeWatch.has(sid)) {
    pipeWatch.add(sid);
    const wc = e.sender;
    // the window loads another page (Stream <-> Studio in the same window): the old page's pipes end too
    const moved = (ev) => { if (ev && ev.isMainFrame && !ev.isSameDocument) closePipesOf(sid); };
    wc.on('did-start-navigation', moved);
    wc.once('destroyed', () => { pipeWatch.delete(sid); closePipesOf(sid); });
  }
});
ipcMain.on('ms-pipe-data', (e, id, data, isText) => { const w = pipes.get(frameKey(e) + ':' + id); if (w) w.fromWindow(data, isText); });
ipcMain.on('ms-pipe-close', (e, id) => { const key = frameKey(e) + ':' + id; const w = pipes.get(key); if (w) { pipes.delete(key); w.windowClosed(); } });

// choosing which screen to capture (for the screen with the lyrics)
let picked = { id: '', name: '', kind: 'screen' };
// kind: 'screen' (a whole screen) or 'window' (one program). Each comes with a small picture so it is easy to pick.
handleIpc('ms-sources', async (e, kind) => {
  const list = await desktopCapturer.getSources({ types: [kind === 'window' ? 'window' : 'screen'], thumbnailSize: { width: 192, height: 108 }, fetchWindowIcons: false });
  return list.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '' }));
});
handleIpc('ms-screens', async () => (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })).map((s) => ({ id: s.id, name: s.name })));
// kind: 'screen', 'window' or 'audio' (the sound this PC plays)
// Finds what was asked for: the exact one, else one with the same name. A window that is gone is NOT swapped for a screen.
async function findSource(p) {
  const list = await desktopCapturer.getSources({ types: [p.kind === 'window' ? 'window' : 'screen'], thumbnailSize: { width: 0, height: 0 } });
  let pick = list.find((s) => s.id === p.id);
  if (!pick && p.name) pick = list.find((s) => s.name.toLowerCase().includes(p.name.toLowerCase()));
  if (!pick && p.kind !== 'window') pick = list[0];
  return pick || null;
}
// The page says what it is about to ask for, and hears at once if it is not there (so it can say so clearly).
handleIpc('ms-pick-screen', async (e, id, name, kind) => {
  picked = { id: String(id || ''), name: String(name || ''), kind: String(kind || 'screen') };
  try { return { found: Boolean(await findSource(picked)) }; } catch { return { found: false }; }
});
function setupScreenCapture(ses) {
  ses.setDisplayMediaRequestHandler(async (req, cb) => {
    try {
      const pick = await findSource(picked);
      if (!pick) return cb({});
      const out = { video: pick };
      if (picked.kind === 'audio' && process.platform === 'win32') out.audio = 'loopback'; // the sound this PC is playing (Windows)
      cb(out);
    } catch { cb({}); }
  });
}

// ---- Updates ----
// Windows: the app downloads the new version by itself and asks to restart.
// Mac and Linux: the app only tells you a new version is ready and opens the download page.
const RELEASE_PAGE = 'https://github.com/Kellyzicoder/multistream/releases/tag/v3-latest';
const VERSION_URL = 'https://github.com/Kellyzicoder/multistream/releases/download/v3-latest/version.json';
function isNewer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}
let askedVersion = '';
async function checkDownloadMessage() {
  try {
    const r = await electronNet.fetch(VERSION_URL);
    if (!r.ok) return;
    const v = String((await r.json()).version || '');
    if (!v || !isNewer(v, app.getVersion()) || askedVersion === v) return;
    askedVersion = v;
    const pick = await dialog.showMessageBox(win || undefined, {
      type: 'info', buttons: ['Open download page', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Multistream update',
      message: 'A new version of Multistream is ready.',
      detail: `You have ${app.getVersion()}. The new one is ${v}. Download it, then open it to replace this one.`,
    });
    if (pick.response === 0) shell.openExternal(RELEASE_PAGE);
  } catch {}
}
function startUpdates() {
  if (!app.isPackaged) return;
  if (process.platform === 'win32') {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('error', () => {});
      autoUpdater.on('update-downloaded', async (info) => {
        const pick = await dialog.showMessageBox(win || undefined, {
          type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
          title: 'Multistream update',
          message: 'A new version of Multistream is ready.',
          detail: `Version ${info.version} is downloaded. Restart to use it. If you press Later, it installs when you close the app. Do not restart while you are live.`,
        });
        if (pick.response === 0) { if (relay) relay.shutdown(); autoUpdater.quitAndInstall(); }
      });
      const check = () => autoUpdater.checkForUpdates().catch(() => {});
      setTimeout(check, 20000);
      setInterval(check, 6 * 60 * 60 * 1000);
    } catch {}
    return;
  }
  setTimeout(checkDownloadMessage, 20000);
  setInterval(checkDownloadMessage, 6 * 60 * 60 * 1000);
}

// ---------- the menu bar (like OBS: File, Edit, View, Help) ----------
const focusedWin = () => BrowserWindow.getFocusedWindow() || win;
const clickIn = (w, sel) => { if (w && !w.isDestroyed()) w.webContents.executeJavaScript(`(function(){const b=document.querySelector(${JSON.stringify(sel)});if(b)b.click();})()`).catch(() => {}); };
const openFolder = (dir) => { try { fs.mkdirSync(dir, { recursive: true }); } catch {} shell.openPath(dir); };
// Remux: copy recordings into MP4 files without encoding again (fast, same quality), like OBS
async function remuxRecordings() {
  const rec = process.env.MULTISTREAM_RECORDINGS; try { fs.mkdirSync(rec, { recursive: true }); } catch {}
  const parent = focusedWin();
  const r = await dialog.showOpenDialog(parent, { title: 'Remux recordings to MP4', defaultPath: rec, properties: ['openFile', 'multiSelections'], filters: [{ name: 'Recordings', extensions: ['mkv', 'webm', 'flv', 'mov'] }] });
  if (r.canceled || !r.filePaths.length) return;
  const done = [], bad = [];
  for (const f of r.filePaths) {
    const base = f.replace(/\.[^.\\/]+$/, '');
    const out = fs.existsSync(base + '.mp4') ? base + ' (remux).mp4' : base + '.mp4';
    const code = await new Promise((ok) => {
      const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', f, '-map', '0', '-c', 'copy', '-movflags', '+faststart', out], { windowsHide: true, stdio: 'ignore' });
      p.on('error', () => ok(1)); p.on('exit', (c) => ok(c));
    });
    if (code === 0) done.push(out); else { bad.push(path.basename(f)); try { fs.unlinkSync(out); } catch {} }
  }
  await dialog.showMessageBox(parent, { type: bad.length ? 'warning' : 'info', message: bad.length ? 'Some recordings could not be remuxed' : 'Remux finished',
    detail: [done.length ? 'Made: ' + done.map((x) => path.basename(x)).join(', ') : '', bad.length ? 'Not done: ' + bad.join(', ') : ''].filter(Boolean).join('\n') });
  if (done.length) shell.showItemInFolder(done[0]);
}
// Scene Collection menu: the Studio page does the work (it asks for names and shows the result)
async function collDo(act, name) {
  const w = studioWin && !studioWin.isDestroyed() ? studioWin : win; if (!w || w.isDestroyed()) return;
  const ok = await w.webContents.executeJavaScript('typeof window.msColl === "function"').catch(() => false);
  if (!ok) { dialog.showMessageBox(w, { type: 'info', message: 'Open the Studio first', detail: 'Scene collections are changed in the Studio.' }); return; }
  w.focus(); w.webContents.executeJavaScript(`window.msColl(${JSON.stringify(act)}, ${JSON.stringify(name || '')})`).catch(() => {});
}
function buildMenu() {
  let ds = []; try { ds = displayList(); } catch {}
  let cl = { current: '', names: [] }; try { if (relay && relay.collections) cl = relay.collections(); } catch {}
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Show Recordings', click: () => openFolder(process.env.MULTISTREAM_RECORDINGS) },
      { label: 'Remux Recordings', click: () => remuxRecordings() },
      { type: 'separator' },
      { label: 'Settings', click: () => clickIn(focusedWin(), '#setBtn') },
      { label: 'Show Settings Folder', click: () => openFolder(process.env.MULTISTREAM_DATA) },
      { type: 'separator' },
      { label: 'Exit', role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'Scene Collection', submenu: [
      { label: 'New...', click: () => collDo('new') },
      { label: 'Duplicate...', click: () => collDo('duplicate') },
      { label: 'Rename...', click: () => collDo('rename') },
      { label: 'Remove', click: () => collDo('remove'), enabled: cl.names.length > 1 },
      { type: 'separator' },
      { label: 'Import...', click: () => collDo('import') },
      { label: 'Export...', click: () => collDo('export') },
      { type: 'separator' },
      ...cl.names.map((n) => ({ label: n, type: 'radio', checked: n === cl.current, click: () => collDo('switch', n) })),
    ] },
    { label: 'View', submenu: [
      { label: 'Fullscreen Interface', accelerator: 'F11', click: () => { const w = focusedWin(); if (w) w.setFullScreen(!w.isFullScreen()); } },
      { label: 'Reset Panels', click: () => clickIn(studioWin || win, '#resetLayout') },
      { type: 'separator' },
      { label: 'Open Multiview', submenu: [
        ...ds.map((d) => ({ label: `Display ${d.n}${d.main ? ' (main)' : ''}: ${d.w}x${d.h}`, click: () => openMultiview(d.id) })),
        { label: 'New window', click: () => openMultiview(null) },
      ] },
    ] },
    { label: 'Help', submenu: [
      { label: 'Download page (latest version)', click: () => shell.openExternal(RELEASE_PAGE) },
      { label: 'Developer tools (for problems)', accelerator: 'F12', click: () => { const w = focusedWin(); if (w) w.webContents.toggleDevTools(); } },
      ...(process.platform === 'win32' && engine().available() ? [
        { type: 'separator' },
        { label: 'Use the OBS engine (test)', type: 'checkbox', checked: engineOn(), click: (item) => setEngine(item.checked) },
      ] : []),
    ] },
  ];
  return Menu.buildFromTemplate(template);
}
const setMenu = () => { try { Menu.setApplicationMenu(buildMenu()); } catch (e) { console.error('Menu:', e && e.message); } };

async function start() {
  try {
    // where saved destinations and keys live: the user's own app-data folder
    process.env.MULTISTREAM_DATA = process.env.MULTISTREAM_DATA || path.join(app.getPath('userData'), 'data');
    process.env.FFMPEG_PATH = ffmpegPath();
    process.env.MULTISTREAM_RECORDINGS = process.env.MULTISTREAM_RECORDINGS || path.join(app.getPath('videos'), 'Multistream');
    relay = require('./server');
    relay.setOpenFolder((p) => shell.openPath(p));
    if (relay.setShowFile) relay.setShowFile((p) => shell.showItemInFolder(p));
    if (relay.onCollections) relay.onCollections(() => setMenu()); // the menu shows the scene collections
  } catch (err) {
    dialog.showErrorBox('Multistream cannot start', require('./public/plain').plain(String(err && err.message ? err.message : err)));
    app.quit();
    return;
  }
  serveApp(session.defaultSession);
  setupAppSession(session.defaultSession);
  setupScreenCapture(session.defaultSession);
  setMenu(); screen.on('display-added', setMenu); screen.on('display-removed', setMenu); // the Multiview list follows the screens
  try { startEngineFirst(); } catch (e) { console.error('Engine:', e && e.message); }
  createWindow();
  startUpdates();
  const goEngine = () => { startEngine().catch((e) => console.error('Engine:', e && e.message)); };
  if (win && win.webContents.isLoading()) win.webContents.once('did-finish-load', goEngine); else goEngine();
}

// only one copy at a time
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else if (app.isReady()) createWindow(); // the main window was closed but the app was still there
  });
  app.whenReady().then(start).catch((e) => { console.error('Multistream failed to start:', e && e.stack || e); dialog.showErrorBox('Multistream cannot start', require('./public/plain').plain(String(e && e.message || e))); app.quit(); });
}

// stop every platform stream when the app closes
app.on('before-quit', () => {
  if (engineMod) engineMod.stop();
  if (relay) relay.shutdown();
});
app.on('window-all-closed', () => app.quit());
