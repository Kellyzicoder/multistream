// Gives the studio page the few things a normal web page cannot do: web-page sources and picking a screen.
const { contextBridge, ipcRenderer } = require('electron');
const frameCbs = new Set();
ipcRenderer.on('ms-frame', (e, id, w, h, buf) => frameCbs.forEach((cb) => cb(id, w, h, buf)));
contextBridge.exposeInMainWorld('msNative', {
  openStudio: () => ipcRenderer.invoke('ms-open-studio'),
  browserOpen: (id, url, w, h) => ipcRenderer.invoke('ms-browser-open', id, url, w, h),
  browserClose: (id) => ipcRenderer.invoke('ms-browser-close', id),
  onFrame: (cb) => { frameCbs.add(cb); },
  screens: () => ipcRenderer.invoke('ms-screens'),
  pickScreen: (id) => ipcRenderer.invoke('ms-pick-screen', id),
});
