// Desktop app (Windows + Mac). Opens a window around the dashboard and runs the relay inside it.

const { app, BrowserWindow, dialog, shell } = require('electron');
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
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}`);
  // links that leave the dashboard open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
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
    relay = require('./server');
  } catch (err) {
    dialog.showErrorBox('Multistream cannot start', String(err && err.message ? err.message : err));
    app.quit();
    return;
  }
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
