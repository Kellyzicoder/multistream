// Demo mode for the Vercel preview. There is no relay behind a preview link, so this fakes a few answers
// so the pages can be looked at. Nothing here runs in the real app.
window.DEMO = /\.vercel\.app$/i.test(location.hostname) || /[?&]demo\b/.test(location.search);
window.demoApi = function (url, method) {
  const t0 = Date.now() - 25 * 60 * 1000;
  const scenes = ['Countdown', 'Welcome', 'EasyWorship', 'Camera', 'Scripture Lowerthird', 'Standby', 'Offering', 'Zoom Iphone', 'Backup Screen'];
  const hist = Array.from({ length: 60 }, (_, i) => 4300 + Math.round(Math.sin(i / 4) * 150 + ((i * 37) % 90)));
  const dest = (id, name, state, msg) => ({ id, name, url: 'rtmp://demo.example/live', hasKey: true, keyEnd: '••••', enabled: state !== 'off', status: { state, message: msg }, stats: state === 'live' ? { kbps: 4400, speed: 1.0, fps: 30 } : null });
  const base = {
    obsLive: true,
    ingest: { server: 'rtmp://localhost:1935/live', key: 'obs', httpPort: 8000, path: '/live/obs' },
    signal: { startedAt: t0, video: { codec: 'h264', width: 1920, height: 1080, fps: 30 }, audio: { codec: 'aac', rate: 48000 }, kbps: 4500, ok: true, history: hist, keyframe: 2.0 },
    destinations: [dest('d1', 'YouTube', 'live', ''), dest('d2', 'Facebook', 'live', ''), dest('d3', 'Instagram', 'off', '')],
    facebook: { pageId: '1234', pageName: 'FCC Test Page', hasToken: true, tokenEnd: 'demo' },
    youtube: { hasClient: true, connected: true, channelTitle: 'Favourite Child Church - HQ' },
    obs: { enabled: true, host: 'localhost', port: 4455, hasPassword: true, connected: true, error: '', scenes, current: 'Camera' },
  };
  const p = url.split('?')[0];
  let out;
  if (method !== 'GET') out = { error: 'This is a demo. Nothing is changed here.' };
  else if (p === '/api/state') out = base;
  else if (p === '/api/obs') out = base.obs;
  else if (p === '/api/obs/thumbs' || p === '/api/obs/shots') out = {};
  else if (p === '/api/obs/levels') out = { levels: {}, muted: {} };
  else if (p === '/api/studio/shots') out = { alive: false };
  else if (p === '/api/studio') out = { scenes: [], current: '' };
  else if (p === '/api/facebook') out = base.facebook;
  else if (p === '/api/youtube') out = base.youtube;
  else if (p === '/api/remote') out = { enabled: false, hasPassword: false, urls: [] };
  else out = {};
  return Promise.resolve(out);
};
