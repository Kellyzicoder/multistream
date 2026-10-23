// Desktop app (Windows + Mac). Opens a window around the dashboard and runs the relay inside it.

const { app, BrowserWindow, dialog, shell, ipcMain, desktopCapturer, session } = require('electron');
const net = require('net');
const path = require('path');

const DASHBOARD_PORT = 3000;
const RTMP_PORT = 1935;
const PREVIEW_PORT = 8000;

let win = null;
let relay = null; // the server module, once started

// Is a port free on this computer?
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '0.0.0.0');
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
    autoHideMenuBar: true,
    backgroundColor: '#eaf1fb',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', preload: path.join(__dirname, 'preload.js') },
  });
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'mediaKeySystem', 'display-capture'].includes(perm)));
  win.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}`);
  // links that leave the dashboard open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
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
  studioWin.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}/studio.html`);
  studioWin.on('closed', () => { studioWin = null; browsers.forEach((b) => b.destroy()); browsers.clear(); });
});
let crWin = null;
ipcMain.handle('ms-open-cr', () => {
  if (crWin) { crWin.focus(); return; }
  crWin = new BrowserWindow({ width: 1280, height: 800, title: 'Multistream Control Room', autoHideMenuBar: true, backgroundColor: '#eaf1fb',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') } });
  crWin.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}/#control-room`);
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
// choosing which screen to capture (for the screen with the lyrics)
let pickedScreen = '';
ipcMain.handle('ms-screens', async () => (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })).map((s) => ({ id: s.id, name: s.name })));
ipcMain.handle('ms-pick-screen', (e, id) => { pickedScreen = String(id || ''); });
function setupScreenCapture(ses) {
  ses.setDisplayMediaRequestHandler(async (req, cb) => {
    const list = await desktopCapturer.getSources({ types: ['screen'] });
    const pick = list.find((s) => s.id === pickedScreen) || list[0];
    cb(pick ? { video: pick } : {});
  });
}

async function start() {
  const busy = [];
  if (!(await portFree(DASHBOARD_PORT))) busy.push(`${DASHBOARD_PORT} (dashboard)`);
  if (!(await portFree(RTMP_PORT))) busy.push(`${RTMP_PORT} (video from OBS)`);
  if (!(await portFree(PREVIEW_PORT))) busy.push(`${PREVIEW_PORT} (video preview)`);
  if (busy.length) {
    dialog.showErrorBox(
      'Multistream cannot start',
      `Another program is already using port ${busy.join(' and ')}.\n\n` +
        'Close the other program (or another copy of Multistream) and open this app again.'
    );
    app.quit();
    return;
  }

  try {
    // where saved destinations and keys live: the user's own app-data folder
    process.env.MULTISTREAM_DATA = path.join(app.getPath('userData'), 'data');
    process.env.FFMPEG_PATH = ffmpegPath();
    process.env.MULTISTREAM_RECORDINGS = path.join(app.getPath('videos'), 'Multistream');
    relay = require('./server');
    relay.setOpenFolder((p) => shell.openPath(p));
  } catch (err) {
    dialog.showErrorBox('Multistream cannot start', String(err && err.message ? err.message : err));
    app.quit();
    return;
  }
  setupScreenCapture(session.defaultSession);
  createWindow();
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
  app.whenReady().then(start);
}

// stop every platform stream when the app closes
app.on('before-quit', () => {
  if (relay) relay.stopAll();
});
app.on('window-all-closed', () => app.quit());
