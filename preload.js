// Gives the studio page the few things a normal web page cannot do: web-page sources and picking a screen.
const { contextBridge, ipcRenderer } = require('electron');
const frameCbs = new Set();
ipcRenderer.on('ms-frame', (e, id, w, h, buf) => frameCbs.forEach((cb) => cb(id, w, h, buf)));
// pipes to the app (instead of WebSockets on localhost)
const pipeCbs = new Map();
let pipeN = 0;
ipcRenderer.on('ms-pipe-ev', (e, id, type, data) => { const cb = pipeCbs.get(id); if (cb) { if (type === 'close') pipeCbs.delete(id); cb(type, data); } });
contextBridge.exposeInMainWorld('msNative', {
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
  openStudio: (same) => ipcRenderer.invoke('ms-open-studio', Boolean(same)),
  openDashboard: () => ipcRenderer.invoke('ms-open-dashboard'),
  browserOpen: (id, url, w, h) => ipcRenderer.invoke('ms-browser-open', id, url, w, h),
  browserClose: (id) => ipcRenderer.invoke('ms-browser-close', id),
  onFrame: (cb) => { frameCbs.add(cb); },
  platform: process.platform,
  screens: () => ipcRenderer.invoke('ms-screens'),
  sources: (kind) => ipcRenderer.invoke('ms-sources', kind),
  pickScreen: (id, name, kind) => ipcRenderer.invoke('ms-pick-screen', id, name, kind),
});
