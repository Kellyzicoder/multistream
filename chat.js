// Reads the live chat of the YouTube video and the comments of the Facebook live video.
// This only READS. Nothing here posts, deletes or replies. Chat text is shown as plain text, never run.
// YouTube is asked no faster than every 6 seconds (each ask costs 5 of the 10,000 daily quota units).

const MAX = 200;
const YT_MIN_MS = 6000;
const FB_EVERY_MS = 4000;

function createChat({ ytList, fbList }) {
  let seq = 0;
  let messages = [];
  const seen = new Set();
  const status = { youtube: '', facebook: '' };
  let yt = null; // { timer, token }
  let fb = null; // { timer }

  function add(source, id, author, text, at) {
    const key = source + ':' + id;
    if (seen.has(key)) return;
    seen.add(key);
    messages.push({ seq: ++seq, source, author: String(author || 'Viewer').slice(0, 80), text: String(text || '').slice(0, 1000), at });
    if (messages.length > MAX) { const old = messages.shift(); seen.delete(old.source + ':' + old.id); }
    messages[messages.length - 1].id = id;
  }

  async function ytTick(liveChatId, me) {
    if (yt !== me) return;
    let wait = YT_MIN_MS;
    try {
      const j = await ytList({ liveChatId, pageToken: me.token });
      if (yt !== me) return;
      for (const m of j.items || []) {
        const sn = m.snippet || {};
        // only normal text messages (not "joined" or money notices)
        if (sn.type && sn.type !== 'textMessageEvent' && !sn.displayMessage) continue;
        if (!sn.displayMessage) continue;
        add('youtube', m.id, (m.authorDetails || {}).displayName, sn.displayMessage, sn.publishedAt || new Date().toISOString());
      }
      me.token = j.nextPageToken || me.token;
      status.youtube = 'Reading YouTube chat';
      wait = Math.max(YT_MIN_MS, Number(j.pollingIntervalMillis) || 0);
      if (j.offlineAt) { status.youtube = 'YouTube chat has ended'; yt = null; return; }
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/ended|no longer live|not found|disabled/i.test(msg)) { status.youtube = 'YouTube chat: ' + msg; yt = null; return; }
      status.youtube = 'YouTube chat: ' + msg + ' (trying again)';
      wait = 15000;
    }
    me.timer = setTimeout(() => ytTick(liveChatId, me), wait);
  }

  async function fbTick(videoId, me) {
    if (fb !== me) return;
    let wait = FB_EVERY_MS;
    try {
      const j = await fbList({ videoId });
      if (fb !== me) return;
      const list = (j.data || []).slice().sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
      for (const c of list) add('facebook', c.id, (c.from || {}).name || 'Facebook viewer', c.message, c.created_time || new Date().toISOString());
      status.facebook = 'Reading Facebook comments';
    } catch (e) {
      status.facebook = 'Facebook comments: ' + String((e && e.message) || e);
      wait = 15000;
    }
    me.timer = setTimeout(() => fbTick(videoId, me), wait);
  }

  return {
    startYoutube(liveChatId) {
      this.stopYoutube();
      if (!liveChatId) { status.youtube = 'YouTube did not give a chat for this video'; return; }
      const me = { timer: null, token: '' };
      yt = me; status.youtube = 'Connecting to YouTube chat';
      ytTick(liveChatId, me);
    },
    startFacebook(videoId) {
      this.stopFacebook();
      if (!videoId) { status.facebook = 'Facebook did not give a video id'; return; }
      const me = { timer: null };
      fb = me; status.facebook = 'Connecting to Facebook comments';
      fbTick(videoId, me);
    },
    stopYoutube() { if (yt) { clearTimeout(yt.timer); yt = null; } },
    stopFacebook() { if (fb) { clearTimeout(fb.timer); fb = null; } },
    stop() { this.stopYoutube(); this.stopFacebook(); },
    clear() { messages = []; seen.clear(); status.youtube = ''; status.facebook = ''; },
    view(after = 0) {
      const a = Number(after) || 0;
      return { seq, items: messages.filter((m) => m.seq > a), status: { ...status }, active: { youtube: Boolean(yt), facebook: Boolean(fb) } };
    },
  };
}

module.exports = { createChat };
