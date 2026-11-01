// Lets the app windows talk to the app's own code with no web server and no port.
// A request from a window (like fetch('/api/state')) is handed straight to the same code that a
// web server would use, and the answer is handed back. Nothing is opened on the network.
const http = require('http');
const { Readable, PassThrough } = require('stream');
const { EventEmitter } = require('events');

function fakeSocket() {
  const s = new PassThrough();
  s.remoteAddress = '127.0.0.1';
  s.encrypted = false;
  s.setTimeout = () => s; s.setNoDelay = () => s; s.setKeepAlive = () => s; s.destroySoon = () => {};
  s.cork = () => {}; s.uncork = () => {};
  return s;
}

// A response that hands what is written to the window instead of a network socket.
// The methods are put on the object itself (not a class), because Express changes the object's
// prototype when it handles a request, and that would throw class methods away.
function makeRes(req, onHead) {
  const res = new http.ServerResponse(req);
  let sink = null;
  const head = () => {
    if (!res._header) res._implicitHeader();
    if (!sink) { sink = new PassThrough(); onHead(res, sink); }
  };
  Object.defineProperty(res, 'writableLength', { configurable: true, get: () => (sink ? sink.readableLength : 0) });
  res.write = function (chunk, enc, cb) {
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    head();
    if (chunk != null && chunk.length !== 0 && req.method !== 'HEAD') {
      sink.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
    }
    if (cb) process.nextTick(cb);
    return true;
  };
  res.end = function (chunk, enc, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = null; }
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (res.finished) { if (cb) process.nextTick(cb); return res; }
    if (chunk != null) res.write(chunk, enc); else head();
    res.finished = true;
    sink.end();
    process.nextTick(() => { res.emit('prefinish'); res.emit('finish'); if (cb) cb(); res.emit('close'); });
    return res;
  };
  return res;
}

// headers that were written (both setHeader() ones and writeHead(status, {...}) ones)
function headersOf(res) {
  const out = [];
  const raw = typeof res._header === 'string' ? res._header : '';
  raw.split('\r\n').slice(1).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  });
  return out.filter(([k]) => !/^(connection|keep-alive|transfer-encoding|date)$/i.test(k));
}

// handler: function (req, res) like express(). input: { method, url, headers, body (Buffer) }
// returns a promise of { status, headers: [[k, v]], body: Readable, abort() }
function inject(handler, { method = 'GET', url = '/', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const socket = fakeSocket();
    const req = new http.IncomingMessage(socket);
    req.method = method.toUpperCase();
    req.url = url;
    req.httpVersionMajor = 1; req.httpVersionMinor = 1; req.httpVersion = '1.1';
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = String(v);
    if (body && body.length) h['content-length'] = String(body.length);
    else delete h['content-length'];
    h.host = h.host || 'multistream';
    req.headers = h;
    req.rawHeaders = Object.entries(h).flat();
    if (body && body.length) req.push(body);
    req.push(null);
    let done = false;
    const res = makeRes(req, (r, sink) => {
      if (done) return; done = true;
      const abort = () => { if (req.destroyed) return; req.destroyed = true; req.emit('aborted'); req.emit('close'); socket.destroy(); };
      // the window stopped reading (closed the page, or stopped the video): tell the handler
      sink.once('close', () => { if (!r.finished) abort(); });
      resolve({ status: r.statusCode, headers: headersOf(r), body: sink, abort });
    });
    try { handler(req, res); } catch (e) {
      if (!done) { done = true; resolve({ status: 500, headers: [['content-type', 'text/plain']], body: Readable.from([String(e && e.message)]), abort() {} }); }
    }
  });
}

// A two-way pipe that looks like a WebSocket to the app's own code (on('message'), send(), close()).
// The window side talks to it through Electron's messages instead of the network.
class FakeWs extends EventEmitter {
  constructor(toWindow) {
    super();
    this.toWindow = toWindow;
    this.readyState = 1;
  }
  send(data) { if (this.readyState === 1) this.toWindow('message', typeof data === 'string' ? data : Buffer.from(data)); }
  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.toWindow('close');
    this.emit('close');
  }
  // from the window
  fromWindow(data, isText) { if (this.readyState === 1) this.emit('message', isText ? Buffer.from(String(data)) : Buffer.from(data), !isText); }
  windowClosed() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
}

module.exports = { inject, FakeWs };
