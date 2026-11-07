// Helpers that read the numbers ffmpeg prints, so the dashboard can show signal info.

// ffmpeg "-progress pipe:1" prints blocks like  key=value ... progress=continue
function makeProgressParser(onBlock) {
  let buf = '';
  let cur = {};
  return (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      cur[k] = v;
      if (k === 'progress') {
        onBlock(cur);
        cur = {};
      }
    }
  };
}

// Reads the "Stream #0:0: Video: h264 ..., 1920x1080 ..., 30 fps" lines ffmpeg prints about the input.
// info = { video: null, audio: null } is filled in once.
function parseStreamLine(line, info) {
  if (!/Stream #\d+:\d+/.test(line) || /->/.test(line)) return;
  if (!info.video && /Video:/.test(line)) {
    const codec = (line.match(/Video:\s*([\w.]+)/) || [])[1] || null;
    const size = line.match(/,\s*(\d{2,5})x(\d{2,5})[\s,[]/);
    const fps = line.match(/(\d+(?:\.\d+)?)\s*fps/);
    info.video = {
      codec,
      width: size ? Number(size[1]) : null,
      height: size ? Number(size[2]) : null,
      fps: fps ? Number(fps[1]) : null,
    };
  }
  if (!info.audio && /Audio:/.test(line)) {
    const codec = (line.match(/Audio:\s*([\w.]+)/) || [])[1] || null;
    const hz = line.match(/(\d+)\s*Hz/);
    const ch = line.match(/Hz,\s*([\w.]+)/);
    info.audio = { codec, rate: hz ? Number(hz[1]) : null, channels: ch ? ch[1] : null };
  }
}

// Turns a growing byte total into kilobits per second, using the time between readings.
function makeRateTracker() {
  let last = null;
  return (bytes, now = Date.now()) => {
    const b = Number(bytes);
    if (!Number.isFinite(b)) return null;
    if (!last) {
      last = { b, t: now };
      return null;
    }
    const dt = (now - last.t) / 1000;
    if (dt <= 0) return null;
    const kbps = ((b - last.b) * 8) / 1000 / dt;
    last = { b, t: now };
    return kbps < 0 ? 0 : kbps;
  };
}


// Reads the FLV video that passes through the monitor and reports the time of every keyframe.
// A keyframe is a full picture. Facebook and YouTube want one about every 2 seconds.
// onKey(timestampMs) is called for each keyframe.
function makeKeyframeTracker(onKey) {
  let buf = Buffer.alloc(0);
  let skip = 0;
  let gotHeader = false;
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (skip > 0) {
        const n = Math.min(skip, buf.length);
        buf = buf.subarray(n);
        skip -= n;
        if (skip > 0) return;
      }
      if (!gotHeader) {
        if (buf.length < 13) return;
        if (buf.toString('latin1', 0, 3) !== 'FLV') { buf = Buffer.alloc(0); return; }
        const offset = buf.readUInt32BE(5);
        if (buf.length < offset + 4) return;
        buf = buf.subarray(offset + 4);
        gotHeader = true;
      }
      if (buf.length < 13) return; // a tag header (11 bytes) plus the first two data bytes
      const type = buf[0];
      const size = buf.readUIntBE(1, 3);
      if (type === 9 && size >= 2) {
        const first = buf[11];
        const ts = (((buf[7] << 24) | (buf[4] << 16) | (buf[5] << 8) | buf[6]) >>> 0);
        const frameType = (first >> 4) & 0x7; // 1 = keyframe
        const exHeader = (first & 0x80) !== 0; // newer FLV (for example H.265)
        let isPicture;
        if (exHeader) isPicture = [1, 3].includes(first & 0x0f); // 0 = setup data, not a picture
        else if ((first & 0x0f) === 7) isPicture = buf[12] === 1; // H.264: skip the setup tag
        else isPicture = true;
        if (frameType === 1 && isPicture) onKey(ts);
      }
      buf = buf.subarray(11);
      skip = size + 4; // the rest of this tag and the size field after it
    }
  };
}

// Reads the video and sound details (type, size, frames a second) straight from the FLV video, inside the
// app, so no extra ffmpeg is needed for the stream check. Fills info.video and info.audio in the same shape
// as parseStreamLine. The size and frame rate come from the video's own description (onMetaData).
function readAmfValue(b, o) {
  const t = b[o];
  if (t === 0) return [b.readDoubleBE(o + 1), o + 9];
  if (t === 1) return [b[o + 1] !== 0, o + 2];
  if (t === 2) { const n = b.readUInt16BE(o + 1); return [b.toString('utf8', o + 3, o + 3 + n), o + 3 + n]; }
  throw new Error('stop'); // a kind of value we do not need
}
function readMetaData(body) {
  const out = {};
  try {
    if (body[0] !== 2) return out;
    let o = 3 + body.readUInt16BE(1); // the name "onMetaData"
    const kind = body[o];
    if (kind === 8) o += 5; else if (kind === 3) o += 1; else return out;
    while (o + 3 <= body.length) {
      const n = body.readUInt16BE(o);
      if (n === 0 && body[o + 2] === 9) break;
      const key = body.toString('utf8', o + 2, o + 2 + n);
      const [v, next] = readAmfValue(body, o + 2 + n);
      out[key] = v; o = next;
    }
  } catch {}
  return out;
}
const VIDEO_CODECS = { 7: 'h264', 12: 'hevc' }, FOURCC = { avc1: 'h264', hvc1: 'hevc', av01: 'av1', vp09: 'vp9' };
const AUDIO_CODECS = { 2: 'mp3', 10: 'aac', 11: 'speex' };
function makeFlvInfo(info) {
  let buf = Buffer.alloc(0), gotHeader = false, meta = {};
  const fill = () => {
    if (info.video) {
      if (meta.width) info.video.width = meta.width;
      if (meta.height) info.video.height = meta.height;
      if (meta.framerate) info.video.fps = Math.round(meta.framerate * 100) / 100;
    }
    if (info.audio && meta.audiosamplerate) info.audio.rate = meta.audiosamplerate;
    if (info.audio && typeof meta.stereo === 'boolean') info.audio.channels = meta.stereo ? 'stereo' : 'mono'; // (AAC always says stereo in its flags)
  };
  return (chunk) => {
    if (info.video && info.audio && meta.width) return; // all known: nothing more to read
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!gotHeader) {
      if (buf.length < 13) return;
      if (buf.toString('latin1', 0, 3) !== 'FLV') { buf = Buffer.alloc(0); return; }
      const off = buf.readUInt32BE(5);
      if (buf.length < off + 4) return;
      buf = buf.subarray(off + 4); gotHeader = true;
    }
    while (buf.length >= 11) {
      const type = buf[0], size = buf.readUIntBE(1, 3);
      if (buf.length < 11 + size + 4) return;
      const body = buf.subarray(11, 11 + size);
      if (type === 18) { meta = { ...meta, ...readMetaData(body) }; fill(); }
      else if (type === 9 && size && !info.video) {
        const f = body[0];
        const codec = (f & 0x80) ? FOURCC[body.toString('latin1', 1, 5)] || body.toString('latin1', 1, 5) : VIDEO_CODECS[f & 0x0f] || 'other';
        info.video = { codec, width: null, height: null, fps: null }; fill();
      } else if (type === 8 && size && !info.audio) {
        const f = body[0];
        info.audio = { codec: AUDIO_CODECS[f >> 4] || 'other', rate: [5512, 11025, 22050, 44100][(f >> 2) & 3], channels: (f & 1) ? 'stereo' : 'mono' }; fill();
      }
      buf = buf.subarray(11 + size + 4);
    }
  };
}

module.exports = { makeProgressParser, parseStreamLine, makeRateTracker, makeKeyframeTracker, makeFlvInfo };
