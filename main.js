// Desktop app (Windows + Mac). Version 3: the windows talk to the app directly, with no localhost.
// Pages load from app://multistream/... and every request is answered inside the app (server.js handle()).

const { app, BrowserWindow, dialog, shell, ipcMain, desktopCapturer, session, protocol, net: electronNet, screen } = require('electron');
const path = require('path');
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
    title: 'Multistream 3',
    autoHideMenuBar: true,
    backgroundColor: '#eaf1fb',
    // the Stream page may slow down while minimised or hidden (it only shows things); the Studio makes the video,
    // so it never slows down (see ms-open-studio)
    webPreferences: { contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(__dirname, 'preload.js') },
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => console.error('Page failed to load:', code, desc, url));
  win.loadURL(HOME + '/').catch((e) => console.error('Dashboard did not load:', e && e.message));
  // links that leave the dashboard open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    const p = projectorOptions(url); if (p) return p;
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}


// ---- Studio helpers ----
let studioWin = null;
// same = true: the Studio replaces the dashboard in the same window (a button in the Studio goes back).
handleIpc('ms-open-studio', (e, same) => {
  if (studioWin) { studioWin.focus(); return; }
  if (same && win && !win.isDestroyed()) { win.webContents.setBackgroundThrottling(false); win.loadURL(HOME + '/studio.html?same=1'); return; }
  studioWin = new BrowserWindow({
    width: 1400, height: 860, title: 'Multistream Studio', autoHideMenuBar: true, backgroundColor: '#0f1512',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(__dirname, 'preload.js') },
  });
  studioWin.loadURL(HOME + '/studio.html');
  studioWin.webContents.setWindowOpenHandler(({ url }) => projectorOptions(url) || (url.startsWith(HOME) || url === 'about:blank' || url === '' ? { action: 'allow' } : (/^https?:\/\//i.test(url) && shell.openExternal(url), { action: 'deny' })));
  studioWin.on('closed', () => { studioWin = null; browsers.forEach((b) => b.destroy()); browsers.clear(); });
});
handleIpc('ms-open-dashboard', () => {
  if (!win || win.isDestroyed()) return;
  browsers.forEach((b) => b.destroy()); browsers.clear();
  win.webContents.setBackgroundThrottling(true);
  win.loadURL(HOME + '/');
});
// the screens that are connected (for showing the Control Room or a Preview/Program picture full screen on one of them)
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
handleIpc('ms-open-cr', (e, displayId) => {
  const d = displayById(displayId);
  if (crWin && !crWin.isDestroyed()) crWin.close();
  const o = { width: 1280, height: 800, title: 'Multistream Control Room', autoHideMenuBar: true, backgroundColor: '#07090b', show: !d,
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
});
// A web page (like the lyrics page) is drawn off-screen. We pass each new picture of it to the studio page.
const browsers = new Map();
handleIpc('ms-browser-open', (e, id, url, w, h) => {
  if (browsers.has(id)) return;
  if (!/^https?:\/\//i.test(String(url))) return;
  const b = new BrowserWindow({ show: false, width: w || 1920, height: h || 1080, transparent: true, frame: false, webPreferences: { offscreen: true, backgroundThrottling: false, session: webSourcesSession(), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  b.webContents.setFrameRate(15);
  b.webContents.on('paint', (ev, dirty, image) => {
    const size = image.getSize();
    if (!e.sender.isDestroyed()) e.sender.send('ms-frame', id, size.width, size.height, image.toBitmap());
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
onIpc('ms-pipe-open', (e, id, p) => {
  const key = e.sender.id + ':' + id, sid = e.sender.id;
  const toWindow = (type, data) => { if (!e.sender.isDestroyed()) e.sender.send('ms-pipe-ev', id, type, data); if (type === 'close') pipes.delete(key); };
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
ipcMain.on('ms-pipe-data', (e, id, data, isText) => { const w = pipes.get(e.sender.id + ':' + id); if (w) w.fromWindow(data, isText); });
ipcMain.on('ms-pipe-close', (e, id) => { const key = e.sender.id + ':' + id; const w = pipes.get(key); if (w) { pipes.delete(key); w.windowClosed(); } });

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

async function start() {
  try {
    // where saved destinations and keys live: the user's own app-data folder
    process.env.MULTISTREAM_DATA = process.env.MULTISTREAM_DATA || path.join(app.getPath('userData'), 'data');
    process.env.FFMPEG_PATH = ffmpegPath();
    process.env.MULTISTREAM_RECORDINGS = process.env.MULTISTREAM_RECORDINGS || path.join(app.getPath('videos'), 'Multistream');
    relay = require('./server');
    relay.setOpenFolder((p) => shell.openPath(p));
  } catch (err) {
    dialog.showErrorBox('Multistream cannot start', String(err && err.message ? err.message : err));
    app.quit();
    return;
  }
  serveApp(session.defaultSession);
  setupAppSession(session.defaultSession);
  setupScreenCapture(session.defaultSession);
  createWindow();
  startUpdates();
}

// only one copy at a time
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start).catch((e) => { console.error('Multistream failed to start:', e && e.stack || e); dialog.showErrorBox('Multistream cannot start', String(e && e.message || e)); app.quit(); });
}

// stop every platform stream when the app closes
app.on('before-quit', () => {
  if (relay) relay.shutdown();
});
app.on('window-all-closed', () => app.quit());
