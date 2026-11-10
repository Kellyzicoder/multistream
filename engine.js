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

// ---- pictures on the app's pages ----
// The engine paints straight into boxes on a page: the Go Live preview, the Studio's Program, and the Multiview.
// Each box has a key. src is 'program' (what viewers see) or { scene: 'Studio scene name' }.
// rect is in the page's own pixels; null takes the picture away (another page, a pop-up, the window minimised).
// On Windows the picture lets clicks through to the page under it.
const displays = new Map(); // key -> { key, id, win, src, name, rect, macSurface, hidden }
// A picture is never removed while the app runs, only parked out of sight: removing one makes the app wait for the
// engine, and on Windows the engine waits for the app's window at the same time, so both would stop. Parked
// pictures are tiny and cost almost nothing; they all go when the engine stops.
let dn = 0;

function sourceName(src) {
  if (src && src.scene) return scenes.sceneName(src.scene) || '';
  return scenes.programName();
}

function macOff(d) {
  if (d.macSurface && nwr) { try { nwr.destroyWindow(d.id); nwr.destroyIOSurface(d.id); } catch (e) {} }
  d.macSurface = false;
}
function park(d) {
  if (d.hidden) return;
  d.hidden = true;
  try {
    if (process.platform === 'darwin') macOff(d);
    else osn.NodeObs.OBS_content_moveDisplay(d.id, -30000, -30000);
    osn.NodeObs.OBS_content_resizeDisplay(d.id, 2, 2);
  } catch (e) {}
}

function placeDisplay(d) {
  const { win, rect, id } = d;
  const zoom = win.webContents.getZoomFactor ? win.webContents.getZoomFactor() : 1;
  const x = Math.round(rect.x * zoom);
  const y = Math.round(rect.y * zoom);
  const w = Math.max(2, Math.round(rect.width * zoom));
  const h = Math.max(2, Math.round(rect.height * zoom));
  d.hidden = false;
  if (process.platform === 'darwin') {
    // Mac: sizes are in points; the picture is a surface placed over the window, measured from the bottom
    osn.NodeObs.OBS_content_resizeDisplay(id, w, h);
    if (nwr) {
      macOff(d);
      const surface = osn.NodeObs.OBS_content_createIOSurface(id);
      nwr.createWindow(id, win.getNativeWindowHandle());
      nwr.connectIOSurface(id, surface);
      const contentH = win.getContentBounds().height;
      nwr.moveWindow(id, x, contentH - (y + h));
      d.macSurface = true;
    }
  } else {
    // Windows: sizes are in real screen pixels
    const scale = require('electron').screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
    osn.NodeObs.OBS_content_resizeDisplay(id, Math.round(w * scale), Math.round(h * scale));
    osn.NodeObs.OBS_content_moveDisplay(id, Math.round(x * scale), Math.round(y * scale));
  }
}

function showDisplay(win, key, rect, src) {
  if (!started || !win || win.isDestroyed()) return false;
  let d = displays.get(key);
  if (!rect || rect.width < 2 || rect.height < 2) { hideDisplay(key); return true; }
  const name = sourceName(src);
  if (!name) { hideDisplay(key); return true; } // that scene is not built (yet)
  try {
    // another scene or another window: a new picture (the old one stays parked)
    if (d && (d.name !== name || d.win !== win)) { park(d); displays.delete(key); d = null; }
    if (!d) {
      const id = key + '~' + (++dn);
      osn.NodeObs.OBS_content_createSourcePreviewDisplay(win.getNativeWindowHandle(), name, id, false, video);
      osn.NodeObs.OBS_content_setShouldDrawUI(id, false);
      osn.NodeObs.OBS_content_setPaddingSize(id, 0);
      osn.NodeObs.OBS_content_setPaddingColor(id, 0, 0, 0);
      d = { key, id, win, src, name, rect, macSurface: false, hidden: false };
      displays.set(key, d);
      // a window that closes: its pictures are forgotten (the window took them with it)
      if (!win.__msDisplays) { win.__msDisplays = true; win.once('closed', () => { displays.forEach((x) => { if (x.win === win) { macOff(x); displays.delete(x.key); } }); }); }
    }
    d.src = src; d.rect = rect;
    placeDisplay(d);
    return true;
  } catch (e) {
    console.error('[engine] picture ' + key + ':', e.message);
    return false;
  }
}

function hideDisplay(key) {
  const d = displays.get(key);
  if (!d || !osn) return;
  park(d);
}
function hideAll() { displays.forEach((d) => macOff(d)); displays.clear(); }

// the Go Live preview (kept for the Go Live page)
function showPreview(win, rect) { return showDisplay(win, 'golive', rect, 'program'); }
function hidePreview() { hideDisplay('golive'); }

// The Studio's scenes, sources and the scene on air (see engine-scenes.js)
function sync(data) {
  if (!started) return false;
  let remake = false;
  try { remake = scenes.sync(data, video); } catch (e) { console.error('[engine] scenes:', e.message); }
  // pictures whose scene was built again, or all of them when the size or transition changed, are made again
  [...displays.values()].forEach((d) => {
    if (d.win.isDestroyed()) { displays.delete(d.key); return; }
    if (remake || d.name !== sourceName(d.src)) {
      const { win, key, rect, src, hidden } = d;
      park(d); displays.delete(key);
      if (!hidden) showDisplay(win, key, rect, src);
    }
  });
  return true;
}

// ---- going live ----
// The engine makes the video once (on the graphics card's video chip when there is one) and sends it to the app's
// own receiver on this computer. From there the app sends it to every channel, as before (so a channel that needs
// a smaller copy, like Facebook, still gets one).
let stream = null;
let encoder = null;
let sendState = { sending: false, error: '', encoder: '' };

// the best way to make video on this computer: its video chip first, the processor (x264) last.
// Only the ones the engine allows for going live and recording (others are refused when starting).
const ENCODERS = [
  'com.apple.videotoolbox.videoencoder.ave.avc', 'com.apple.videotoolbox.videoencoder.h264.gva', // Apple
  'obs_nvenc_h264_tex', 'ffmpeg_nvenc', 'h264_texture_amf', 'obs_qsv11_v2',                     // NVIDIA, AMD, Intel
  'obs_x264',
];
// every way this computer has, best first (if one does not work here, the next one is tried)
function encoderChoices() {
  let types = [];
  try { types = osn.VideoEncoderFactory.types() || []; } catch (e) {}
  console.log('[engine] video makers on this computer:', types.join(', '));
  const list = ENCODERS.filter((t) => types.includes(t));
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

// ---- recording ----
// The engine records the same picture and sound to a file, with its own video maker (so the file can be a
// higher quality than the stream). o: { dir, base (file name without .mkv), w, h, fps, kbps }
let rec = null;
let recEncoder = null;
let recDone = null; // waits for the file to be finished
function startRecord(o) {
  if (!started) return { ok: false, error: 'The engine is not on' };
  if (rec) return { ok: false, error: 'Already recording' };
  const fps = Number(o.fps) === 60 ? 60 : 30;
  try { if (!stream && video.video.fpsNum !== fps) video.video = { ...video.video, fpsNum: fps, fpsDen: 1 }; } catch (e) {}
  let lastError = '';
  for (const id of encoderChoices()) {
    try {
      const kbps = Math.max(1000, Math.min(80000, Number(o.kbps) || 8000));
      const settings = { rate_control: 'CBR', bitrate: kbps, keyint_sec: 2, profile: 'high' };
      if (id === 'obs_x264') settings.preset = 'veryfast';
      recEncoder = osn.VideoEncoderFactory.create(id, 'ms-record-encoder', settings);
      if (!recEncoder) throw new Error('could not make the video maker');
      rec = osn.AdvancedRecordingFactory.create();
      rec.path = o.dir;
      rec.format = 'mkv';           // a file that is still good if the computer stops suddenly
      rec.fileFormat = o.base;      // the exact name (the engine adds .mkv)
      rec.overwrite = false;
      rec.noSpace = false;
      rec.video = video;
      rec.videoEncoder = recEncoder;
      rec.useStreamEncoders = false;
      rec.mixer = 1;                // sound track 1
      const [bw, bh] = [video.video.baseWidth, video.video.baseHeight];
      if (o.w && o.h && (o.w !== bw || o.h !== bh)) { rec.rescaling = true; rec.outputWidth = o.w; rec.outputHeight = o.h; }
      if (!osn.AudioTrackFactory.getAtIndex(1)) osn.AudioTrackFactory.setAtIndex(osn.AudioTrackFactory.create(160, 'ms-sound'), 1);
      let finish;
      recDone = new Promise((r) => { finish = r; });
      rec.signalHandler = (sig) => {
        if (!sig || sig.type !== 'recording') return;
        if (sig.signal === 'wrote') finish({ ok: true });
        if (sig.signal === 'writing_error') finish({ ok: false, error: sig.error || 'The file could not be finished' });
        if (sig.signal === 'stop' && sig.code) finish({ ok: false, error: sig.error || 'Recording stopped (' + sig.code + ')' });
      };
      rec.start();
      console.log('[engine] recording with', id, kbps + ' kbps', o.w + 'x' + o.h, 'to', o.base);
      return { ok: true, encoder: id };
    } catch (e) {
      lastError = e.message;
      console.log('[engine] recording: ' + id + ' did not work here:', e.message);
      dropRecord();
    }
  }
  return { ok: false, error: lastError };
}
function dropRecord() {
  if (rec) { try { osn.AdvancedRecordingFactory.destroy(rec); } catch (e) {} rec = null; }
  if (recEncoder) { try { recEncoder.release(); } catch (e) {} recEncoder = null; }
}
// stops and waits (up to 20 seconds) until the file is finished
async function stopRecord() {
  if (!rec) return { ok: false, error: 'Not recording' };
  const done = recDone;
  try { rec.stop(); } catch (e) {}
  const r = await Promise.race([done, new Promise((res) => setTimeout(() => res({ ok: true, late: true }), 20000))]);
  dropRecord();
  return r;
}

function streamState() {
  let stats = {};
  if (stream) { try { stats = { kbps: Math.round(stream.kbitsPerSec || 0), dropped: stream.droppedFrames || 0, frames: stream.totalFrames || 0 }; } catch (e) {} }
  return { ...sendState, active: Boolean(stream), ...stats };
}

function stop() {
  if (rec) { try { rec.stop(true); } catch (e) {} dropRecord(); }
  stopStream();
  hideAll();
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

module.exports = { available, start, stop, askMacCamera, showPreview, hidePreview, showDisplay, hideDisplay, sync, startStream, stopStream, streamState, startRecord, stopRecord, isRecording: () => Boolean(rec), isStarted: () => started };
