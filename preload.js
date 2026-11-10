// Gives the studio page the few things a normal web page cannot do: web-page sources and picking a screen.
const { contextBridge, ipcRenderer } = require('electron');
const frameCbs = new Set();
ipcRenderer.on('ms-frame', (e, id, w, h, buf) => frameCbs.forEach((cb) => cb(id, w, h, buf)));
// pipes to the app (instead of WebSockets on localhost)
const pipeCbs = new Map();
let pipeN = 0;
ipcRenderer.on('ms-pipe-ev', (e, id, type, data) => { const cb = pipeCbs.get(id); if (cb) { if (type === 'close') pipeCbs.delete(id); cb(type, data); } });
// only the app's own pages get these helpers (not a website shown inside a page, like the live dashboard)
if (location.protocol === 'app:') contextBridge.exposeInMainWorld('msNative', {
  pipe: (p, cb) => {
    const id = ++pipeN;
    pipeCbs.set(id, cb);
    ipcRenderer.send('ms-pipe-open', id, String(p));
    return {
      send: (data) => (typeof data === 'string' ? ipcRenderer.send('ms-pipe-data', id, data, true) : ipcRenderer.send('ms-pipe-data', id, data, false)),
      close: () => { ipcRenderer.send('ms-pipe-close', id); },
    };
  },
  openControlRoom: (displayId) => ipcRenderer.invoke('ms-open-cr', displayId == null ? null : displayId),
  displays: () => ipcRenderer.invoke('ms-displays'),
  appVersion: () => ipcRenderer.invoke('ms-version'),
  openStudio: (same) => ipcRenderer.invoke('ms-open-studio', Boolean(same)),
  openDashboard: () => ipcRenderer.invoke('ms-open-dashboard'),
  browserOpen: (id, url, w, h) => ipcRenderer.invoke('ms-browser-open', id, url, w, h),
  browserClose: (id) => ipcRenderer.invoke('ms-browser-close', id),
  onFrame: (cb) => { frameCbs.add(cb); },
  platform: process.platform,
  screens: () => ipcRenderer.invoke('ms-screens'),
  sources: (kind) => ipcRenderer.invoke('ms-sources', kind),
  pickScreen: (id, name, kind) => ipcRenderer.invoke('ms-pick-screen', id, name, kind),
  // the OBS engine (test, switched on in the Help menu)
  engineState: () => ipcRenderer.invoke('ms-engine-state'),
  enginePreview: (rect) => ipcRenderer.invoke('ms-engine-preview', rect),
  engineDisplay: (key, rect, src) => ipcRenderer.invoke('ms-engine-display', key, rect, src),
  onEngine: (cb) => { ipcRenderer.on('ms-engine', (e, st) => cb(st)); },
  engineTrans: (t) => ipcRenderer.invoke('ms-engine-trans', t),
  engineSend: (o) => ipcRenderer.invoke('ms-engine-send', o),
  engineUnsend: () => ipcRenderer.invoke('ms-engine-unsend'),
  engineSendState: () => ipcRenderer.invoke('ms-engine-sendstate'),
  engineRecord: (o) => ipcRenderer.invoke('ms-engine-record', o),
  engineUnrecord: () => ipcRenderer.invoke('ms-engine-unrecord'),
});
