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
    session: { youtube: false, facebook: false },
    recording: { on: false, file: '', startedAt: 0, error: '', folder: 'C:\\Users\\church\\Videos\\Multistream', auto: false },
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
  else if (p === '/api/preflight') out = { at: Date.now(), results: [{ id: 'yt', label: 'YouTube', state: 'ok', detail: 'Connected: Favourite Child Church - HQ.' }, { id: 'fb', label: 'Facebook', state: 'bad', detail: 'Facebook said: (#190) Error validating access token. You may need a new token (Settings, then Facebook).' }, { id: 'sig', label: 'OBS signal', state: 'ok', detail: 'Video is arriving at 4.5 Mbps.' }, { id: 'key', label: 'Keyframe', state: 'warn', detail: 'Every 3.5 seconds. 2 is best. In OBS: Settings, Output, Keyframe Interval, 2.' }, { id: 'disk', label: 'Space for recording', state: 'ok', detail: '46.6 GB free. An hour of recording is about 2 GB.' }] };
  else if (p === '/api/chat') out = { seq: 4, items: [{ seq: 1, source: 'youtube', author: 'Grace A.', text: 'Good morning church! Watching from Manukau', at: '' }, { seq: 2, source: 'facebook', author: 'Daniel K.', text: 'Amen. God bless you pastor', at: '' }, { seq: 3, source: 'youtube', author: 'Tina M.', text: 'Can you hear the music? Sound is fine here', at: '' }, { seq: 4, source: 'facebook', author: 'Ruth O.', text: 'Joining from London', at: '' }], status: { youtube: 'Reading YouTube chat', facebook: 'Reading Facebook comments' }, active: { youtube: true, facebook: true } };
  else if (p === '/api/recording') out = { ...base.recording, files: [{ name: 'Multistream 2026-10-18 09-58-02.mkv', size: 2147483648, at: Date.now() - 5 * 86400000 }, { name: 'Multistream 2026-10-11 10-01-40.mkv', size: 1932735283, at: Date.now() - 12 * 86400000 }] };
  else if (p === '/api/remote') out = { enabled: false, hasPassword: false, urls: [] };
  else out = {};
  return Promise.resolve(out);
};
