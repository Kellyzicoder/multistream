// Turns the Studio's scenes into the OBS engine's scenes.
// The Studio stays exactly as designed: it saves its scenes as before, and this file builds the same scenes in
// the engine (cameras, screens, windows, pictures, videos and colours). Text, name bars, countdowns, the clock,
// web pages and phone cameras are still drawn only by the Studio for now; they move to the engine next.
//
// What viewers see (Program) is a transition in the engine, so changing scene can fade like in the Studio.
// Sound inputs (microphones, the computer's sound) are put in the scenes that use them, so a scene's sound is
// only heard while that scene is on air, the same as in the Studio.

const NATIVE = new Set(['camera', 'screen', 'window', 'image', 'video', 'color', 'browser', 'ipcam', 'text', 'lower', 'timer', 'clock']);
// drawn by the app's graphics page (public/engine-overlay.html) inside the engine's web page source
const GFX = new Set(['text', 'lower', 'timer', 'clock']);
let ov = ''; // where the graphics page is (a listener only this computer can reach)

// Speaker + screen: the same layout as the Studio's drawDuo(), made of a background, the screen and the camera
function expand(layers, W) {
  const out = [];
  (layers || []).forEach((l) => {
    if (l.type !== 'duo') { out.push(l); return; }
    const x = l.x || 0, y = l.y || 0, w = l.w || W[0], h = l.h || W[1];
    const pad = Math.round(w * 0.03), gap = Math.round(w * 0.018);
    const inner = w - pad * 2 - gap, share = l.layout === 'side' ? 0.5 : 0.68;
    const sw = inner * share, cw = inner - sw, bh = Math.min(h - pad * 2, sw * 9 / 16);
    const by = y + (h - bh) / 2, sx = l.camLeft ? x + pad + cw + gap : x + pad, cx = l.camLeft ? x + pad : x + pad + sw + gap;
    const vis = l.visible;
    const bg = l.bg && l.bg.kind === 'colour' ? l.bg.color : '#0a0e1f';
    out.push({ id: l.id + ':bg', type: 'color', color: bg, x, y, w, h, visible: vis });
    if (l.bg && l.bg.kind === 'picture') out.push({ id: l.id + ':bgpic', type: 'image', path: l.bg.path, x, y, w, h, fit: 'cover', visible: vis });
    out.push({ id: l.id + ':scr', type: l.scrType === 'window' ? 'window' : 'screen', winName: l.winName || '', screenIndex: l.screenIndex || 0, x: sx, y: by, w: sw, h: bh, fit: 'fit', visible: vis });
    out.push({ id: l.id + ':cam', type: 'camera', label: l.camLabel || '', x: cx, y: by, w: cw, h: bh, fit: 'cover', visible: vis });
  });
  return out;
}

const TRANS = { cut: 'cut_transition', fade: 'fade_transition', slide: 'slide_transition', dip: 'fade_to_color_transition' };
const PROGRAM = 'Multistream Program'; // the name the preview box shows
// the engine's own numbers (its names for them only exist while it is being built)
const BOUNDS = { none: 0, stretch: 1, inside: 2, outside: 3 };
const ALIGN = { center: 0, topLeft: 5 };

let osn = null;
let types = [];
let cameras = null;       // [{ name, value }] found once
const inputs = new Map(); // key -> { input, used }
const scenes = new Map(); // studio scene name -> { scene, items: [{ id, key, item }] }
let transition = null;
let transType = '';
let onAir = '';
let size = [1920, 1080];
let last = null;          // the last data, so changed settings can be put back after a picture loads

const mac = () => process.platform === 'darwin';
const has = (t) => types.includes(t);

function init(engine) {
  osn = engine;
  try { types = osn.InputFactory.types() || []; } catch (e) { types = []; }
  console.log('[engine] source types:', types.join(', '));
}

// ---- finding devices, screens and windows by their names ----
function listOf(input, names) {
  for (const n of names) {
    try {
      const p = input.properties.get(n);
      if (p && p.details && Array.isArray(p.details.items)) return { prop: n, items: p.details.items };
    } catch (e) {}
  }
  return null;
}
const clean = (s) => String(s || '').toLowerCase().replace(/\([0-9a-f]{4}:[0-9a-f]{4}\)/g, '').replace(/\s+/g, ' ').trim();
function pickItem(items, want, index) {
  const ok = items.filter((i) => i.value !== '' && i.value !== null && i.value !== undefined);
  if (!ok.length) return null;
  const w = clean(want);
  if (w) {
    const hit = ok.find((i) => clean(i.name) === w) || ok.find((i) => clean(i.name).includes(w) || w.includes(clean(i.name)));
    if (hit) return hit;
  }
  if (Number.isInteger(index) && ok[index]) return ok[index];
  return ok[0];
}

const step = process.env.MULTISTREAM_ENGINE_LOG === '1' ? (m) => console.log('[engine] step: ' + m + ' ' + Date.now() % 100000) : () => {};
function cameraType() { return mac() ? (has('av_capture_input') ? 'av_capture_input' : 'macos_avcapture') : 'dshow_input'; }
function cameraList() {
  if (cameras) return cameras;
  cameras = [];
  let probe = null;
  try {
    step('camera list: make');
    probe = osn.InputFactory.create(cameraType(), 'ms-camera-list', {});
    step('camera list: read');
    const l = listOf(probe, ['device', 'video_device_id']);
    step('camera list: done');
    if (l) cameras = l.items.filter((i) => i.value);
  } catch (e) { console.log('[engine] camera list:', e.message); }
  if (probe) try { probe.release(); } catch (e) {}
  return cameras;
}

// ---- one engine source for one Studio source ----
// key: sources that are the same thing (the same camera, the same picture file) share one engine source;
// videos get their own, because each plays from the start when its scene goes on air
function keyOf(l) {
  if (l.type === 'camera') return 'camera|' + clean(l.label);
  if (l.type === 'screen') return 'screen|' + (l.screenIndex || 0);
  if (l.type === 'window') return 'window|' + clean(l.winName);
  if (l.type === 'image') return 'image|' + (l.path || l.link || '');
  if (l.type === 'video') return 'video|' + l.id;
  if (l.type === 'color') return 'color|' + l.id;
  if (GFX.has(l.type)) return 'gfx|' + l.id;
  if (l.type === 'browser') return 'web|' + (l.url || '') + '|' + (l.bw || size[0]) + 'x' + (l.bh || size[1]);
  if (l.type === 'ipcam') return 'ipcam|' + (l.url || '');
  return '';
}
function colorInt(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const v = m ? m[1] : '000000';
  const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
  return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0; // the engine wants alpha, blue, green, red
}

// ---- sound inputs ----
function micType() { return mac() ? 'coreaudio_input_capture' : 'wasapi_input_capture'; }
function deskType() {
  if (!mac()) return 'wasapi_output_capture';
  return has('sck_audio_capture') ? 'sck_audio_capture' : 'coreaudio_output_capture';
}
let mics = null;
function micList() {
  if (mics) return mics;
  mics = [];
  let probe = null;
  try {
    probe = osn.InputFactory.create(micType(), 'ms-mic-list', {});
    const l = listOf(probe, ['device_id']);
    if (l) mics = l.items.filter((i) => i.value);
  } catch (e) { console.log('[engine] microphone list:', e.message); }
  if (probe) try { probe.release(); } catch (e) {}
  return mics;
}
function audioKey(a) { return a.kind === 'desktop' ? 'desktop' : 'mic|' + clean(a.label); }
function audioFor(a) {
  const key = audioKey(a);
  let s = inputs.get(key);
  if (!s) {
    let input = null;
    try {
      if (a.kind === 'desktop') input = osn.InputFactory.create(deskType(), 'ms-sound-' + (++n), mac() ? {} : { device_id: 'default' });
      else {
        // the microphone with the same name, or the computer's normal microphone
        const w = clean(a.label);
        const dev = w ? micList().find((i) => clean(i.name) === w) || micList().find((i) => clean(i.name).includes(w) || w.includes(clean(i.name))) : null;
        input = osn.InputFactory.create(micType(), 'ms-mic-' + (++n), { device_id: dev ? dev.value : 'default' });
      }
    } catch (e) { console.log('[engine] could not add sound', a.name + ':', e.message); }
    s = { input, used: true };
    inputs.set(key, s);
  }
  s.used = true;
  if (s.input) {
    try { s.input.volume = a.vol == null ? 1 : Math.max(0, Math.min(4, Number(a.vol) || 0)); } catch (e) {}
    try { s.input.muted = Boolean(a.muted); } catch (e) {}
  }
  return s.input ? { key, input: s.input } : null;
}

function makeInput(l, name) {
  const mk = (type, settings) => { step('make ' + type + ' ' + name); const r = osn.InputFactory.create(type, name, settings || {}); step('made ' + name); return r; };
  if (GFX.has(l.type)) {
    if (!ov) return null;
    return mk('browser_source', { url: ov + '/page?id=' + encodeURIComponent(l.id), is_local_file: false, width: size[0], height: size[1], fps: 30, fps_custom: true, shutdown: false, restart_when_active: false, reroute_audio: false, css: '' });
  }
  if (l.type === 'browser') {
    if (!/^https?:\/\//i.test(l.url || '')) return null;
    return mk('browser_source', { url: l.url, is_local_file: false, width: Math.round(l.bw || size[0]), height: Math.round(l.bh || size[1]), fps: 30, shutdown: false, restart_when_active: false });
  }
  if (l.type === 'ipcam') {
    if (!/^https?:\/\//i.test(l.url || '')) return null;
    return mk('ffmpeg_source', { is_local_file: false, input: l.url, looping: false, restart_on_activate: false, close_when_inactive: false, reconnect_delay_sec: 3, hw_decode: true });
  }
  if (l.type === 'camera') {
    if (l.off) return null; // deactivated in the Studio (like OBS's Deactivate)
    const dev = pickItem(cameraList(), l.label);
    if (!dev) return null;
    return mk(cameraType(), { [mac() ? 'device' : 'video_device_id']: dev.value, ...(mac() ? {} : { deactivate_when_not_showing: Boolean(l.idleOff) }) });
  }
  if (l.type === 'screen' || l.type === 'window') {
    const win = l.type === 'window';
    let input;
    if (mac()) {
      // the Mac's newer screen capture (ScreenCaptureKit) when the engine has it
      const sck = has('mac_screen_capture') ? 'mac_screen_capture' : has('screen_capture') ? 'screen_capture' : '';
      const type = sck || (win ? 'window_capture' : 'display_capture');
      input = mk(type, sck ? { type: win ? 1 : 0, show_cursor: true } : {});
    } else {
      input = mk(win ? 'window_capture' : 'monitor_capture', { capture_cursor: true, cursor: true });
    }
    const l2 = win ? listOf(input, ['window']) : listOf(input, ['display_uuid', 'display', 'monitor_id', 'monitor']);
    if (l2) {
      const it = pickItem(l2.items, win ? l.winName : '', win ? undefined : (l.screenIndex || 0));
      if (it) input.update({ [l2.prop]: it.value });
    }
    return input;
  }
  if (l.type === 'image') {
    if (!l.path) return null; // a picture from a web address: not yet
    return mk('image_source', { file: l.path, unload: false });
  }
  if (l.type === 'video') {
    const local = Boolean(l.path);
    if (!local && !l.link) return null;
    return mk('ffmpeg_source', {
      is_local_file: local, local_file: l.path || '', input: local ? '' : l.link,
      looping: l.loop !== false, restart_on_activate: true, close_when_inactive: false, hw_decode: true,
    });
  }
  if (l.type === 'color') {
    const type = has('color_source_v3') ? 'color_source_v3' : 'color_source';
    return mk(type, { color: colorInt(l.color), width: Math.round(l.w || size[0]), height: Math.round(l.h || size[1]) });
  }
  return null;
}

let n = 0;
function inputFor(l) {
  const key = keyOf(l);
  if (!key) return null;
  let s = inputs.get(key);
  if (!s) {
    let input = null;
    try { input = makeInput(l, 'ms-' + l.type + '-' + (++n)); } catch (e) { console.log('[engine] could not add', l.type + ':', e.message); }
    s = { input, used: true };
    inputs.set(key, s);
  }
  s.used = true;
  if (s.input && GFX.has(l.type)) {
    try { const st = s.input.settings || {}; if (st.width !== size[0] || st.height !== size[1]) s.input.update({ width: size[0], height: size[1] }); } catch (e) {}
  }
  if (s.input && l.type === 'color') {
    try { s.input.update({ color: colorInt(l.color), width: Math.round(l.w || size[0]), height: Math.round(l.h || size[1]) }); } catch (e) {}
  }
  return s.input ? { key, input: s.input } : null;
}

// ---- where a source sits in the picture (same rules as the Studio's place() and pic()) ----
function place(item, l, input) {
  const x = l.x || 0, y = l.y || 0, w = l.w || size[0], h = l.h || size[1];
  const flipX = l.flipH ? -1 : 1, flipY = l.flipV ? -1 : 1;
  try {
    item.deferUpdateBegin();
    if (l.fit === 'natural') {
      item.boundsType = BOUNDS.none;
      item.alignment = ALIGN.topLeft;
      item.position = { x, y };
      item.scale = { x: (l.sx || 1) * flipX, y: (l.sy || 1) * flipY };
    } else {
      // a box: the source is stretched into it, fitted inside it, or fills it (sides cut off)
      item.alignment = ALIGN.center; // turns around its middle, like the Studio
      item.boundsAlignment = 0;
      item.position = { x: x + w / 2, y: y + h / 2 };
      item.bounds = { x: w, y: h };
      item.boundsType = l.fit === 'fit' || l.fit === 'blur' ? BOUNDS.inside
        : l.fit === 'cover' ? BOUNDS.outside : BOUNDS.stretch;
      item.cropToBounds = l.fit === 'cover';
      item.scale = { x: flipX, y: flipY };
    }
    item.rotation = Number(l.rot) || 0;
    // crop (in the Studio it is a share of the picture; the engine wants pixels)
    const c = (l.pfx && l.pfx.crop) || {};
    const sw = input.width || 0, sh = input.height || 0;
    const pc = (v) => Math.min(90, Number(v) || 0) / 100;
    item.crop = sw && sh
      ? { left: Math.round(sw * pc(c.l)), top: Math.round(sh * pc(c.t)), right: Math.round(sw * pc(c.r)), bottom: Math.round(sh * pc(c.b)) }
      : { left: 0, top: 0, right: 0, bottom: 0 };
    item.visible = l.visible !== false;
    item.deferUpdateEnd();
  } catch (e) { console.log('[engine] place:', e.message); }
}

// ---- the scenes ----
function sceneFor(name) {
  let s = scenes.get(name);
  if (!s) {
    s = { scene: osn.SceneFactory.create('ms-scene-' + name + '-' + (++n)), items: [] };
    scenes.set(name, s);
  }
  return s;
}

function buildScene(sc, audio) {
  const s = sceneFor(sc.name);
  const want = [];
  expand(sc.layers, size).forEach((l) => {
    if (!NATIVE.has(l.type)) return;
    const got = inputFor(l);
    if (!got) return;
    // graphics fill the whole picture (the page draws them in their place); a name bar is always there, so
    // it can slide out by itself when it is hidden
    const at = GFX.has(l.type) ? { x: 0, y: 0, w: size[0], h: size[1], fit: 'stretch', visible: l.type === 'lower' ? true : l.visible } : l;
    want.push({ id: l.id, key: got.key, input: got.input, l: at });
  });
  // the sound inputs this scene uses (they have no picture, so where they sit does not matter)
  (sc.audio || []).forEach((id) => {
    const a = (audio || []).find((x) => x.id === id);
    if (!a) return;
    const got = audioFor(a);
    if (got && !want.some((w) => w.key === got.key)) want.push({ id: 'sound-' + id, key: got.key, input: got.input, sound: true });
  });
  // the same sources in the same order: only move them; otherwise build the scene again
  const same = want.length === s.items.length && want.every((w, i) => s.items[i].id === w.id && s.items[i].key === w.key);
  if (!same) {
    s.items.forEach((it) => { try { it.item.remove(); } catch (e) {} });
    s.items = [];
    want.forEach((w) => {
      try { s.items.push({ id: w.id, key: w.key, item: s.scene.add(w.input) }); } catch (e) { console.log('[engine] add to scene:', e.message); }
    });
  }
  s.items.forEach((it, i) => { if (!want[i].sound) place(it.item, want[i].l, want[i].input); });
  s.want = want;
  s.used = true;
}

function setTransition(kind) {
  const type = TRANS[kind] || TRANS.fade;
  if (transition && transType === type) return false;
  const old = transition;
  try {
    transition = osn.TransitionFactory.create(type, PROGRAM + (old ? ' ' + (++n) : ''), type === 'fade_to_color_transition' ? { color: 0xff000000 } : {});
  } catch (e) {
    console.log('[engine] transition', type + ':', e.message);
    if (old) return false;
    transition = osn.TransitionFactory.create('cut_transition', PROGRAM, {});
  }
  transType = type;
  const s = scenes.get(onAir);
  if (s) try { transition.set(s.scene); } catch (e) {}
  osn.Global.setOutputSource(0, transition);
  if (old) try { old.release(); } catch (e) {}
  return true; // the preview box has to be made again (it shows the transition by name)
}

function resize(w, h, video) {
  if (w === size[0] && h === size[1]) return false;
  size = [w, h];
  try {
    video.video = { ...video.video, baseWidth: w, baseHeight: h, outputWidth: w, outputHeight: h };
  } catch (e) { console.log('[engine] size:', e.message); }
  return true;
}

// data: { w, h, scenes: [{ name, layers }], current, trans: { type, ms } }
// returns true when the preview box has to be made again
function sync(data, video) {
  if (!osn || !data) return false;
  last = data;
  ov = data.ov || ov;
  let remake = resize(data.w || 1920, data.h || 1080, video);
  inputs.forEach((s) => { s.used = false; });
  scenes.forEach((s) => { s.used = false; });
  (data.scenes || []).forEach((sc) => buildScene(sc, data.audio));
  if (!data.scenes || !data.scenes.length) sceneFor('');
  if (setTransition((data.trans && data.trans.type) || 'fade')) remake = true;

  // put the scene on air
  const want = scenes.has(data.current) ? data.current : (data.scenes && data.scenes[0] ? data.scenes[0].name : '');
  const s = sceneFor(want);
  s.used = true;
  if (want !== onAir || remake) {
    const ms = Math.max(0, Number(data.trans && data.trans.ms) || 0);
    try {
      if (!onAir || remake || transType === TRANS.cut || !ms) transition.set(s.scene);
      else transition.start(ms, s.scene);
    } catch (e) { console.log('[engine] change scene:', e.message); }
    onAir = want;
  }

  // scenes and sources nobody uses any more are let go (a camera is free for other apps again)
  scenes.forEach((sc, name) => {
    if (sc.used) return;
    sc.items.forEach((it) => { try { it.item.remove(); } catch (e) {} });
    try { sc.scene.release(); } catch (e) {}
    scenes.delete(name);
  });
  inputs.forEach((s, key) => {
    if (s.used) return;
    if (s.input) try { s.input.release(); } catch (e) {}
    inputs.delete(key);
  });
  return remake;
}

// a picture's or video's size is only known once it has loaded: crop and natural size are set again then
function refresh() {
  scenes.forEach((s) => {
    if (!s.want) return;
    s.items.forEach((it, i) => { const w = s.want[i]; if (w && !w.sound && w.id === it.id) place(it.item, w.l, w.input); });
  });
}

function clear() {
  scenes.forEach((sc) => {
    sc.items.forEach((it) => { try { it.item.remove(); } catch (e) {} });
    try { sc.scene.release(); } catch (e) {}
  });
  scenes.clear();
  inputs.forEach((s) => { if (s.input) try { s.input.release(); } catch (e) {} });
  inputs.clear();
  if (transition) try { transition.release(); } catch (e) {}
  transition = null; transType = ''; onAir = ''; cameras = null; mics = null; last = null; size = [1920, 1080];
}

// the engine's name for a Studio scene (for a picture of that scene on a page), or '' if it is not built
function sceneName(n) { const sc = scenes.get(n); try { return sc ? sc.scene.name : ''; } catch (e) { return ''; } }

module.exports = { init, sync, refresh, clear, sceneName, programName: () => (transition ? transition.name : PROGRAM), NATIVE };
