// Error messages in plain words, for everyone who uses the app (not computer words like
// "[flv @ 0x13…] Input/output error" or "ECONNREFUSED"). Used by the app (server.js, main.js) and its pages.
// A message that is already plain is kept as it is.
(function (root) {
  const RULES = [
    // sign-in and permission
    [/session has expired|error validating access token|access token.*(expired|invalid)|oauthexception.*190|invalid_grant|token (has been )?(expired|revoked)/i, 'Your sign-in has run out. Sign in again in Settings → Stream.'],
    [/permissions? error|\(#200\)|\(#10\)|insufficient permission|not authori[sz]ed|unauthori[sz]ed|forbidden|\b40[13]\b|access denied/i, 'The site did not allow this. Sign in again in Settings → Stream, and make sure your account can go live there.'],
    // YouTube
    [/not enabled for live streaming|livestreamingnotenabled/i, 'This YouTube channel is not set up for live streaming yet. Turn it on at youtube.com/features (it can take up to 24 hours).'],
    // internet
    [/getaddrinfo|enotfound|eai_again|resolve host|could not resolve|nodename nor servname|name or service not known|fetch failed|failed to fetch|network ?error|enetunreach|network is unreachable|no internet/i, 'No internet connection, or the site could not be reached. Check the internet and try again.'],
    [/etimedout|timed? ?out|timeout/i, 'The site took too long to answer. Check the internet and try again.'],
    // a live channel
    [/\b404\b|stream key.*(invalid|not found)|no such stream|not found/i, 'The stream key or address was not found. Check them, or make a new live on that site.'],
    [/invalid data|codec|unsupported|not supported/i, 'The site did not accept the video.'],
    [/input\/output error|i\/o error|broken pipe|connection reset|econnreset|econnrefused|connection refused|end of file|\beof\b|trailer|failed to update header|server returned|rtmps?:\/\/|\[flv|\[out#|\bflv\b|socket hang up|epipe/i, 'The connection to the site dropped.'],
    [/^stopped \(code -?\d+\)$/i, 'The connection to the site dropped.'],
    // files and the computer
    [/enospc|no space left|disk (is )?full/i, 'The disk is full. Free some space and try again.'],
    [/eacces|eperm|permission denied|operation not permitted/i, 'The app is not allowed to use that file or folder.'],
    [/enoent|no such file|cannot find|missing file/i, 'A file could not be found. It may have moved or be on a drive that is not plugged in.'],
    [/notallowederror|permission dismissed|notreadableerror|could not start video source/i, 'The camera or microphone could not be used. Check that no other app is using it, and that Multistream is allowed in the computer\'s privacy settings.'],
  ];
  // words that show a message is meant for programmers, not people
  const TECHY = /0x[0-9a-f]{4,}|\b[A-Z][a-zA-Z]+(Error|Exception)\b|\bE[A-Z]{3,}\b|\bat [\w.<>]+ \(|[{}[\]<>]|\w+\.(js|cpp|ts):\d+|\bcode \d{2,}|\(#\d+\)|\bnull\b|\bundefined\b|stack/;

  function plain(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return 'Something went wrong. Please try again.';
    for (const [re, words] of RULES) if (re.test(t)) {
      // keep the useful part around a rule's words: what to do next is in the rule
      const tail = /reconnecting… \(\d+ of \d+\)|could not reconnect after \d+ tries\. press restart\./i.exec(t);
      return tail ? words.replace(/\.$/, '') + '. ' + tail[0].charAt(0).toUpperCase() + tail[0].slice(1) : words;
    }
    if (TECHY.test(t) || t.length > 220) return 'Something went wrong. Please try again. If it keeps happening, close and open the app.';
    return t;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { plain };
  else root.msPlain = plain;
})(typeof window !== 'undefined' ? window : globalThis);
