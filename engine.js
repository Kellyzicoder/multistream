// The OBS engine (obs-studio-node, the same engine Streamlabs Desktop uses).
// It draws the picture on the graphics card, inside the app, so the app's own pages stay exactly as designed.
// It is optional: if the engine is not installed with this copy of the app, nothing here runs and the app
// works as before. For now it is a test you switch on from the Help menu.
// The Studio's scenes are built in the engine by engine-scenes.js.
const path = require('path');
const { app } = require('electron');
const scenes = require('./engine-scenes');

let osn = null; // the engine, once loaded (false if it is not installed)
let nwr = null; // Mac only: puts the engine's picture on top of the window
let started = false;
let video = null;
let preview = null; // { key, win, macSurface }
let lastWin = null;  // where the preview box was last asked for, so it can be made again
let lastRect = null;
let refreshTimer = null;

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
      // the engine's own numbers for these (its names for them only exist while it is being built):
      // NV12 = 2, colour space 709 = 2, partial range = 1, bilinear = 3, fractional frame rate = 2
      outputFormat: 2, colorspace: 2, range: 1, scaleType: 3, fpsType: 2,
    };

    // sound: 48 kHz stereo (the engine's numbers: stereo = 2)
    try { osn.AudioFactory.audioContext = { sampleRate: 48000, speakers: 2 }; } catch (e) { console.log('[engine] sound settings:', e.message); }

    // the Studio's scenes come in through sync(); until then the picture is black
    scenes.init(osn);
    scenes.sync({ w: 1920, h: 1080, scenes: [], current: '', trans: { type: 'cut', ms: 0 } }, video);
    refreshTimer = setInterval(() => { try { scenes.refresh(); } catch (e) {} }, 2000);
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
  lastWin = win; lastRect = rect;
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
      osn.NodeObs.OBS_content_createSourcePreviewDisplay(win.getNativeWindowHandle(), scenes.programName(), key, false, video);
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

// The Studio's scenes, sources and the scene on air (see engine-scenes.js)
function sync(data) {
  if (!started) return false;
  let remake = false;
  try { remake = scenes.sync(data, video); } catch (e) { console.error('[engine] scenes:', e.message); }
  if (remake && preview) {
    // the picture changed size or the transition changed: the preview box is made again
    const win = lastWin, rect = lastRect;
    hidePreview();
    showPreview(win, rect);
  }
  return true;
}

// ---- going live ----
// The engine makes the video once (on the graphics card's video chip when there is one) and sends it to the app's
// own receiver on this computer. From there the app sends it to every channel, as before (so a channel that needs
// a smaller copy, like Facebook, still gets one).
let stream = null;
let encoder = null;
let sendState = { sending: false, error: '', encoder: '' };

// the best way to make video on this computer: its video chip first, the processor (x264) last
const ENCODERS = [
  'com.apple.videotoolbox.videoencoder.ave.avc', 'com.apple.videotoolbox.videoencoder.h264.gva', 'com.apple.videotoolbox.videoencoder.h264',
  'jim_nvenc', 'obs_nvenc_h264_tex', 'ffmpeg_nvenc', 'h264_texture_amf', 'amd_amf_h264', 'obs_qsv11_v2', 'obs_qsv11',
  'obs_x264',
];
// every way this computer has, best first (if one does not work here, the next one is tried)
function encoderChoices() {
  let types = [];
  try { types = osn.VideoEncoderFactory.types() || []; } catch (e) {}
  console.log('[engine] video makers on this computer:', types.join(', '));
  const list = ENCODERS.filter((t) => types.includes(t));
  types.filter((t) => /h264|avc/i.test(t) && !list.includes(t)).forEach((t) => list.splice(list.length - (list.includes('obs_x264') ? 1 : 0), 0, t));
  if (!list.includes('obs_x264')) list.push('obs_x264');
  return list;
}

// out: { server, key, w, h, fps, kbps }
function startStream(out) {
  if (!started) return { ok: false, error: 'The engine is not on' };
  stopStream();
  // frames a second
  const fps = Number(out.fps) === 60 ? 60 : 30;
  try { if (video.video.fpsNum !== fps) video.video = { ...video.video, fpsNum: fps, fpsDen: 1 }; } catch (e) {}
  let lastError = '';
  for (const id of encoderChoices()) {
    try {
      startWith(id, out, fps);
      return { ok: true, encoder: id };
    } catch (e) {
      lastError = e.message;
      console.log('[engine] ' + id + ' did not work here:', e.message);
      stopStream();
    }
  }
  console.error('[engine] could not go live:', lastError);
  sendState = { sending: false, error: lastError, encoder: '' };
  return { ok: false, error: lastError };
}

function startWith(id, out, fps) {
  const kbps = Math.max(500, Math.min(50000, Number(out.kbps) || 6000));
  const settings = { rate_control: 'CBR', bitrate: kbps, keyint_sec: 2, profile: 'high' };
  if (id === 'obs_x264') settings.preset = 'veryfast';
  encoder = osn.VideoEncoderFactory.create(id, 'ms-video-encoder', settings);
  if (!encoder) throw new Error('could not make the video maker');
  sendState = { sending: false, error: '', encoder: id };
  console.log('[engine] making video with', id, kbps + ' kbps', out.w + 'x' + out.h, fps + ' fps');

  stream = osn.AdvancedStreamingFactory.create();
  stream.videoEncoder = encoder;
  stream.service = osn.ServiceFactory.create('rtmp_custom', 'ms-service', { server: out.server, key: out.key, use_auth: false });
  stream.enforceServiceBitrate = false;
  stream.video = video;
  // a smaller picture than the scenes (720p from a 1080p scene): the engine makes it smaller
  const [bw, bh] = [video.video.baseWidth, video.video.baseHeight];
  if (out.w && out.h && (out.w !== bw || out.h !== bh)) {
    stream.rescaling = true;
    stream.rescaleFilter = 3; // bilinear
    stream.outputWidth = out.w;
    stream.outputHeight = out.h;
  }
  stream.delay = osn.DelayFactory.create();
  const re = osn.ReconnectFactory.create();
  re.enabled = true; re.retryDelay = 2; re.maxRetries = 1000;
  stream.reconnect = re;
  stream.network = osn.NetworkFactory.create();
  const track = osn.AudioTrackFactory.create(160, 'ms-sound');
  osn.AudioTrackFactory.setAtIndex(track, 1);
  stream.audioTrack = 1;
  stream.signalHandler = (sig) => {
    if (!sig || sig.type !== 'streaming') return;
    if (sig.signal === 'start' || sig.signal === 'activate') sendState = { ...sendState, sending: true, error: '' };
    if (sig.signal === 'reconnect') sendState = { ...sendState, sending: false, error: 'Reconnecting...' };
    if (sig.signal === 'reconnect_success') sendState = { ...sendState, sending: true, error: '' };
    if (sig.signal === 'stop') sendState = { ...sendState, sending: false, error: sig.code ? (sig.error || 'The engine stopped sending (' + sig.code + ')') : '' };
  };
  stream.start();
}

function stopStream() {
  if (stream) {
    try { stream.stop(true); } catch (e) {}
    try { osn.AdvancedStreamingFactory.destroy(stream); } catch (e) {}
    stream = null;
  }
  if (encoder) { try { encoder.release(); } catch (e) {} encoder = null; }
  sendState = { ...sendState, sending: false };
}

function streamState() {
  let stats = {};
  if (stream) { try { stats = { kbps: Math.round(stream.kbitsPerSec || 0), dropped: stream.droppedFrames || 0, frames: stream.totalFrames || 0 }; } catch (e) {} }
  return { ...sendState, active: Boolean(stream), ...stats };
}

function stop() {
  stopStream();
  hidePreview();
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (!osn) return;
  try { scenes.clear(); } catch (e) {}
  try {
    if (video) { video.destroy(); video = null; }
  } catch (e) {}
  try { osn.NodeObs.InitShutdownSequence(); } catch (e) {}
  try { osn.NodeObs.OBS_service_removeCallback(); } catch (e) {}
  try { osn.NodeObs.IPC.disconnect(); } catch (e) {}
  started = false;
}

module.exports = { available, start, stop, askMacCamera, showPreview, hidePreview, sync, startStream, stopStream, streamState, isStarted: () => started };
