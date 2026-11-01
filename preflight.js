// "Check everything" before the service. Each check says ok / warn / bad / skip and why, in plain words.
// It only looks. It changes nothing.

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('It took too long to answer')), ms))]);
}

async function runPreflight(d) {
  const out = [];
  const add = (id, label, state, detail) => out.push({ id, label, state, detail });

  // YouTube
  if (!d.youtube.connected) add('yt', 'YouTube', 'bad', 'Not connected. Open Settings, then YouTube, then Connect YouTube.');
  else {
    try {
      const name = await withTimeout(d.ytCheck(), 8000);
      add('yt', 'YouTube', 'ok', 'Connected' + (name ? ': ' + name : '') + '.');
    } catch (e) {
      const m = String((e && e.message) || e);
      add('yt', 'YouTube', 'bad', /invalid_grant|expired|revoked/i.test(m) ? 'The login ran out. Open Settings, then YouTube, then press Connect YouTube again.' : 'YouTube said: ' + m);
    }
  }

  // Facebook
  if (!d.facebook.ready) add('fb', 'Facebook', 'bad', 'No Page added. Open Settings, then Facebook.');
  else {
    try {
      const name = await withTimeout(d.fbCheck(), 8000);
      add('fb', 'Facebook', 'ok', 'Page token works' + (name ? ': ' + name : '') + '.');
    } catch (e) {
      add('fb', 'Facebook', 'bad', 'Facebook said: ' + String((e && e.message) || e) + ' You may need a new token (Settings, then Facebook).');
    }
  }

  // The picture and sound coming in from the Studio
  const s = d.signal || {};
  if (!d.obsLive) {
    add('sig', 'Video signal', 'warn', 'Nothing is being sent yet. In the Studio press Start Streaming, then check again to test the picture and sound.');
  } else {
    if (!d.signalOk) add('sig', 'Video signal', 'bad', 'The video source is connected but no video is arriving.');
    else add('sig', 'Video signal', 'ok', 'Video is arriving' + (s.kbps ? ' at ' + (s.kbps / 1000).toFixed(1) + ' Mbps' : '') + '.');
    const vOk = s.video && /h264|avc/i.test(s.video.codec || '');
    const aOk = s.audio && /aac/i.test(s.audio.codec || '');
    if (!s.video) add('fmt', 'Video and sound type', 'warn', 'Not measured yet. Wait a few seconds and check again.');
    else if (vOk && aOk) add('fmt', 'Video and sound type', 'ok', `${s.video.codec} ${s.video.width}x${s.video.height}, sound ${s.audio.codec}.`);
    else add('fmt', 'Video and sound type', 'bad', `YouTube and Facebook want H.264 video and AAC sound. the video is ${(s.video || {}).codec || '?'} and ${(s.audio || {}).codec || 'no sound'}.`);
    if (s.keyframe == null) add('key', 'Keyframe', 'warn', 'Not measured yet. Wait a few seconds and check again.');
    else if (s.keyframe <= 2.5) add('key', 'Keyframe', 'ok', `Every ${s.keyframe} seconds.`);
    else if (s.keyframe <= 4) add('key', 'Keyframe', 'warn', `Every ${s.keyframe} seconds. 2 is best.`);
    else add('key', 'Keyframe', 'bad', `Every ${s.keyframe} seconds. Too long.`);
  }

  // Room to record
  try {
    const free = await d.freeBytes();
    if (free == null) add('disk', 'Space for recording', 'skip', 'Could not read the free space.');
    else {
      const gb = free / 1073741824;
      add('disk', 'Space for recording', gb < 2 ? 'bad' : gb < 10 ? 'warn' : 'ok', `${gb.toFixed(1)} GB free. An hour of recording is about 2 GB.`);
    }
  } catch { add('disk', 'Space for recording', 'skip', 'Could not read the free space.'); }



  // Channels that need a key typed in by hand (Instagram changes it every time)
  const manual = (d.destinations || []).filter((x) => x.enabled && !/^(youtube|facebook)$/i.test(x.name) && !(x.url && x.key));
  if (manual.length) add('keys', 'Channel keys', 'warn', manual.map((x) => x.name).join(', ') + ': no stream key yet. Paste it before you start.');

  return out;
}

module.exports = { runPreflight };
