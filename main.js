// Desktop app (Windows + Mac). Version 3: the windows talk to the app directly, with no localhost.
// Pages load from app://multistream/... and every request is answered inside the app (server.js handle()).

const { app, BrowserWindow, dialog, shell, ipcMain, desktopCapturer, session, protocol, net: electronNet } = require('electron');
const path = require('path');
const { Readable } = require('stream');

const HOME = 'app://multistream';

let win = null;
let relay = null; // the server module, once started

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
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(__dirname, 'preload.js') },
  });
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'mediaKeySystem', 'display-capture'].includes(perm)));
  win.webContents.on('did-fail-load', (e, code, desc, url) => console.error('Page failed to load:', code, desc, url));
  win.loadURL(HOME + '/').catch((e) => console.error('Dashboard did not load:', e && e.message));
  // links that leave the dashboard open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}


// ---- Studio helpers ----
let studioWin = null;
ipcMain.handle('ms-open-studio', () => {
  if (studioWin) { studioWin.focus(); return; }
  studioWin = new BrowserWindow({
    width: 1400, height: 860, title: 'Multistream Studio', autoHideMenuBar: true, backgroundColor: '#0f1512',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(__dirname, 'preload.js') },
  });
  studioWin.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'display-capture'].includes(perm)));
  studioWin.loadURL(HOME + '/studio.html');
  studioWin.webContents.setWindowOpenHandler(({ url }) => (url.startsWith(HOME) || url === 'about:blank' || url === '' ? { action: 'allow' } : (/^https?:\/\//i.test(url) && shell.openExternal(url), { action: 'deny' })));
  studioWin.on('closed', () => { studioWin = null; browsers.forEach((b) => b.destroy()); browsers.clear(); });
});
let crWin = null;
ipcMain.handle('ms-open-cr', () => {
  if (crWin) { crWin.focus(); return; }
  crWin = new BrowserWindow({ width: 1280, height: 800, title: 'Multistream Control Room', autoHideMenuBar: true, backgroundColor: '#eaf1fb',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') } });
  crWin.loadURL(HOME + '/#control-room');
  crWin.on('closed', () => { crWin = null; });
});
// A web page (like the lyrics page) is drawn off-screen. We pass each new picture of it to the studio page.
const browsers = new Map();
ipcMain.handle('ms-browser-open', (e, id, url, w, h) => {
  if (browsers.has(id)) return;
  if (!/^https?:\/\//i.test(String(url))) return;
  const b = new BrowserWindow({ show: false, width: w || 1920, height: h || 1080, transparent: true, frame: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  b.webContents.setFrameRate(15);
  b.webContents.on('paint', (ev, dirty, image) => {
    const size = image.getSize();
    if (!e.sender.isDestroyed()) e.sender.send('ms-frame', id, size.width, size.height, image.toBitmap());
  });
  b.webContents.setAudioMuted(false);
  b.loadURL(String(url)).catch(() => {});
  browsers.set(id, b);
});
ipcMain.handle('ms-browser-close', (e, id) => { const b = browsers.get(id); if (b) { b.destroy(); browsers.delete(id); } });
// Two-way pipes between a window and the app (the Studio's video, recording and virtual camera).
// They used to be WebSockets on localhost. Now they are plain messages inside the app.
const pipes = new Map();
ipcMain.on('ms-pipe-open', (e, id, p) => {
  const key = e.sender.id + ':' + id;
  const toWindow = (type, data) => { if (!e.sender.isDestroyed()) e.sender.send('ms-pipe-ev', id, type, data); if (type === 'close') pipes.delete(key); };
  const w = relay && relay.openPipe(String(p), toWindow);
  if (!w) { toWindow('close'); return; }
  pipes.set(key, w);
  toWindow('open');
  e.sender.once('destroyed', () => { const x = pipes.get(key); if (x) { pipes.delete(key); x.windowClosed(); } });
});
ipcMain.on('ms-pipe-data', (e, id, data, isText) => { const w = pipes.get(e.sender.id + ':' + id); if (w) w.fromWindow(data, isText); });
ipcMain.on('ms-pipe-close', (e, id) => { const key = e.sender.id + ':' + id; const w = pipes.get(key); if (w) { pipes.delete(key); w.windowClosed(); } });

// choosing which screen to capture (for the screen with the lyrics)
let picked = { id: '', name: '', kind: 'screen' };
// kind: 'screen' (a whole screen) or 'window' (one program). Each comes with a small picture so it is easy to pick.
ipcMain.handle('ms-sources', async (e, kind) => {
  const list = await desktopCapturer.getSources({ types: [kind === 'window' ? 'window' : 'screen'], thumbnailSize: { width: 192, height: 108 }, fetchWindowIcons: false });
  return list.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '' }));
});
ipcMain.handle('ms-screens', async () => (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })).map((s) => ({ id: s.id, name: s.name })));
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
ipcMain.handle('ms-pick-screen', async (e, id, name, kind) => {
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
