// The video hub. One source (the Studio, or OBS when the backup is on) puts its video in.
// Many takers (YouTube, Facebook, the recording, the stream check, the preview) each get a copy.
// It all happens inside the app, so no local server or port is needed.
//
// The video is FLV. A taker that joins late first gets the start of the file (header, codec info)
// and the frames since the last keyframe, so its picture starts clean straight away.
const { EventEmitter } = require('events');

const MAX_BACKLOG = 24 * 1024 * 1024; // a taker this far behind (about 20 s at 9 Mbit) is dropped (it starts again by itself)
const MAX_GOP_TAGS = 3000;

function createHub() {
  const ev = new EventEmitter();
  let live = false;
  let buf = Buffer.alloc(0);
  let header = null; // 9-byte FLV header + 4-byte zero
  let meta = null, vseq = null, aseq = null;
  let gop = [];
  let gotHeader = false;
  const takers = new Set();

  function reset() {
    buf = Buffer.alloc(0); header = meta = vseq = aseq = null; gop = []; gotHeader = false;
  }

  function sendTo(t, b) {
    if (t.dead) return;
    try {
      if (t.stream.writableLength > MAX_BACKLOG) { drop(t, 'too far behind'); return; }
      t.stream.write(b);
    } catch { drop(t, 'write failed'); }
  }
  function drop(t, why) {
    if (t.dead) return;
    t.dead = true; takers.delete(t);
    try { t.onDrop && t.onDrop(why); } catch {}
  }
  function startBytes() {
    const parts = [header];
    if (meta) parts.push(meta);
    if (vseq) parts.push(vseq);
    if (aseq) parts.push(aseq);
    return Buffer.concat(parts.concat(gop));
  }

  function onTag(tag) {
    const type = tag[0];
    const body = tag[11];
    if (type === 18) { meta = tag; }
    else if (type === 9) {
      const key = (body >> 4) === 1, avc = (body & 0x0f) === 7;
      if (avc && tag[12] === 0) vseq = tag;
      else if (key) gop = [tag];
      else if (gop.length && gop.length < MAX_GOP_TAGS) gop.push(tag);
    } else if (type === 8) {
      if ((body >> 4) === 10 && tag[12] === 0) aseq = tag;
      else if (gop.length && gop.length < MAX_GOP_TAGS) gop.push(tag);
    }
    for (const t of takers) {
      if (!t.started) { if (header && vseq && type === 9 && (body >> 4) === 1 && !(tag[12] === 0 && (body & 0x0f) === 7)) { t.started = true; sendTo(t, startBytes()); } continue; }
      sendTo(t, tag);
    }
  }

  // put a chunk of FLV in (from the source)
  function write(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!gotHeader) {
      if (buf.length < 13) return;
      if (buf.toString('latin1', 0, 3) !== 'FLV') { ev.emit('error', new Error('not FLV')); buf = Buffer.alloc(0); return; }
      const off = buf.readUInt32BE(5);
      if (buf.length < off + 4) return;
      header = Buffer.concat([buf.subarray(0, 9), Buffer.alloc(4)]);
      buf = buf.subarray(off + 4);
      gotHeader = true;
      if (!live) { live = true; ev.emit('start'); }
    }
    let pos = 0;
    while (buf.length - pos >= 11) {
      const size = buf.readUIntBE(pos + 1, 3);
      const total = 11 + size + 4;
      if (buf.length - pos < total) break;
      onTag(Buffer.from(buf.subarray(pos, pos + total)));
      pos += total;
    }
    buf = pos ? buf.subarray(pos) : buf;
  }

  // the source stopped
  function end() {
    const was = live;
    live = false;
    for (const t of [...takers]) { t.dead = true; takers.delete(t); try { t.stream.end(); } catch {} }
    reset();
    if (was) ev.emit('end');
  }

  // feed a source stream (like ffmpeg's output) into the hub. Returns a function to stop feeding.
  // Only one source at a time: a new one replaces the old one, and the old one can no longer touch the hub.
  let active = null;
  function publish(readable) {
    end();
    active = readable;
    const onData = (c) => { if (active === readable) write(c); };
    const onEnd = () => { if (active === readable) { active = null; end(); } };
    readable.on('data', onData);
    readable.on('end', onEnd);
    readable.on('close', onEnd);
    readable.on('error', onEnd);
    return () => { readable.off('data', onData); onEnd(); };
  }

  // a taker gets a copy, starting at the next keyframe. stream: anything with write() and end().
  function subscribe(stream, onDrop) {
    const t = { stream, onDrop, started: false, dead: false };
    if (stream.on) {
      stream.on('error', () => drop(t, 'closed'));
      stream.on('close', () => drop(t, 'closed'));
    }
    takers.add(t);
    // start straight away from the saved keyframe, if there is one
    if (header && vseq && gop.length) { t.started = true; sendTo(t, startBytes()); }
    return () => { if (!t.dead) { t.dead = true; takers.delete(t); } };
  }

  return {
    write, end, publish, subscribe,
    on: (...a) => ev.on(...a),
    get live() { return live; },
    get takers() { return takers.size; },
  };
}

module.exports = { createHub };
