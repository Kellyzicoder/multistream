// The OBS engine (obs-studio-node, the same engine Streamlabs Desktop uses).
// It draws the picture on the graphics card, inside the app, so the app's own pages stay exactly as designed.
// It is optional: if the engine is not installed with this copy of the app, nothing here runs and the app
// works as before. For now it is a test you switch on from the Help menu.
const path = require('path');
const { app } = require('electron');

let osn = null; // the engine, once loaded (false if it is not installed)
let nwr = null; // Mac only: puts the engine's picture on top of the window
let started = false;
let video = null;
let scene = null;
let camera = null;
let preview = null; // { key, win, macSurface }

// Where the engine lives: next to the app when installed, in node_modules while developing
function enginePath(name) {
  if (app.isPackaged) return path.join(process.resourcesPath, name);
  return path.join(__dirname, 'node_modules', name);
}

function load() {
  if (osn !== null) return osn;
  try {
    osn = require(enginePath('obs-studio-node'));
  } catch (e) {
    console.log('[engine] not installed with this copy:', e.message);
    osn = false;
  }
  if (osn && process.platform === 'darwin') {
    try { nwr = require(enginePath('node-window-rendering')); } catch (e) { console.log('[engine] Mac preview helper missing:', e.message); }
  }
  return osn;
}

function available() {
  return Boolean(load());
}

// The first camera, or nothing if there is none
function firstCamera() {
  const mac = process.platform === 'darwin';
  const type = mac ? 'av_capture_input' : 'dshow_input';
  const prop = mac ? 'device' : 'video_device_id';
  let probe = null;
  try {
    probe = osn.InputFactory.create(type, 'multistream-camera-list', {});
    const p = probe.properties.get(prop);
    const items = p && p.details ? p.details.items : [];
    probe.release();
    probe = null;
    const dev = items.find((i) => i.value);
    if (!dev) return null;
    console.log('[engine] camera:', dev.name);
    return osn.InputFactory.create(type, 'Camera', { [prop]: dev.value });
  } catch (e) {
    if (probe) try { probe.release(); } catch (_) {}
    console.log('[engine] no camera:', e.message);
    return null;
  }
}

function start() {
  if (started) return true;
  if (!load()) return false;
  try {
    const hosted = osn.NodeObs.IPC.host('multistream-' + process.pid);
    if (hosted !== 0) throw new Error('engine process did not start (' + hosted + ')');
    osn.NodeObs.SetWorkingDirectory(enginePath('obs-studio-node'));
    const result = osn.NodeObs.OBS_API_initAPI({
      language: 'en-US',
      appDataPath: path.join(app.getPath('userData'), 'engine'),
      version: app.getVersion(),
      crashServerUrl: '',
    });
    if (result !== 0) throw new Error('engine did not start (' + result + ')');

    // the picture: 1920 x 1080, 30 frames a second
    video = osn.VideoFactory.create();
    video.video = {
      fpsNum: 30, fpsDen: 1,
      baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080,
      outputFormat: osn.EVideoFormat.NV12, colorspace: osn.EColorSpace.CS709, range: osn.ERangeType.Partial,
      scaleType: osn.EScaleType.Bilinear, fpsType: osn.EFPSType.Fractional,
    };

    // one scene with the camera in it (a first test; the Studio's scenes come next)
    scene = osn.SceneFactory.create('Multistream');
    camera = firstCamera();
    if (camera) scene.add(camera);
    osn.Global.setOutputSource(0, scene);
    started = true;
    console.log('[engine] started');
    return true;
  } catch (e) {
    console.error('[engine] could not start:', e.message);
    stop();
    return false;
  }
}

// Mac: the camera needs the Mac's permission first
function askMacCamera() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin' || !osn || !osn.NodeObs.RequestPermissions) return resolve();
    try {
      const now = osn.NodeObs.GetPermissionsStatus();
      if (now && now.webcamPermission) return resolve();
      osn.NodeObs.RequestPermissions(() => resolve());
      setTimeout(resolve, 15000);
    } catch (e) { resolve(); }
  });
}

// Shows the engine's picture over a box of the window (rect in the page's own pixels), or hides it (rect null)
function showPreview(win, rect) {
  if (!started || !win || win.isDestroyed()) return false;
  const key = 'golive';
  if (!rect || rect.width < 2 || rect.height < 2) {
    hidePreview();
    return true;
  }
  const zoom = win.webContents.getZoomFactor ? win.webContents.getZoomFactor() : 1;
  const x = Math.round(rect.x * zoom);
  const y = Math.round(rect.y * zoom);
  const w = Math.max(2, Math.round(rect.width * zoom));
  const h = Math.max(2, Math.round(rect.height * zoom));
  try {
    if (!preview) {
      osn.NodeObs.OBS_content_createSourcePreviewDisplay(win.getNativeWindowHandle(), scene.name, key, false, video);
      osn.NodeObs.OBS_content_setShouldDrawUI(key, false);
      osn.NodeObs.OBS_content_setPaddingSize(key, 0);
      osn.NodeObs.OBS_content_setPaddingColor(key, 0, 0, 0);
      preview = { key, win, macSurface: false };
    }
    if (process.platform === 'darwin') {
      // Mac: sizes are in points; the picture is a surface placed over the window, measured from the bottom
      osn.NodeObs.OBS_content_resizeDisplay(key, w, h);
      if (nwr) {
        if (preview.macSurface) { nwr.destroyWindow(key); nwr.destroyIOSurface(key); }
        const surface = osn.NodeObs.OBS_content_createIOSurface(key);
        nwr.createWindow(key, win.getNativeWindowHandle());
        nwr.connectIOSurface(key, surface);
        const contentH = win.getContentBounds().height;
        nwr.moveWindow(key, x, contentH - (y + h));
        preview.macSurface = true;
      }
    } else {
      // Windows: sizes are in real screen pixels
      const scale = require('electron').screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
      osn.NodeObs.OBS_content_resizeDisplay(key, Math.round(w * scale), Math.round(h * scale));
      osn.NodeObs.OBS_content_moveDisplay(key, Math.round(x * scale), Math.round(y * scale));
    }
    return true;
  } catch (e) {
    console.error('[engine] preview:', e.message);
    return false;
  }
}

function hidePreview() {
  if (!preview || !osn) return;
  try {
    if (preview.macSurface && nwr) { nwr.destroyWindow(preview.key); nwr.destroyIOSurface(preview.key); }
    osn.NodeObs.OBS_content_destroyDisplay(preview.key);
  } catch (e) {}
  preview = null;
}

function stop() {
  hidePreview();
  if (!osn) return;
  try {
    if (camera) { camera.release(); camera = null; }
    if (scene) { scene.release(); scene = null; }
    if (video) { video.destroy(); video = null; }
  } catch (e) {}
  try { osn.NodeObs.InitShutdownSequence(); } catch (e) {}
  try { osn.NodeObs.OBS_service_removeCallback(); } catch (e) {}
  try { osn.NodeObs.IPC.disconnect(); } catch (e) {}
  started = false;
}

module.exports = { available, start, stop, askMacCamera, showPreview, hidePreview, isStarted: () => started };
