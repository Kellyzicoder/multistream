// Starts a destination again by itself when it drops while OBS is still live.
// Waits a little longer each time (3 s, 6 s, 9 s ... up to 30 s) and gives up after 10 tries in a row,
// so a wrong stream key does not hammer YouTube or Facebook. A run that stays up for a minute resets the count.
function createAutoRetry({ restart, onWait, onGiveUp, maxTries = 10, stepMs = 3000, maxWaitMs = 30000, healthyMs = 60000, timers = { set: setTimeout, clear: clearTimeout }, now = Date.now }) {
  const state = new Map(); // id -> { n, timer }

  function cancel(id) {
    const s = state.get(id);
    if (s && s.timer) timers.clear(s.timer);
    state.delete(id);
  }

  // call when a destination stops that we did not stop on purpose
  function dropped(id, reason, ranForMs) {
    const prev = state.get(id);
    let n = prev ? prev.n : 0;
    if (ranForMs >= healthyMs) n = 0;
    if (prev && prev.timer) timers.clear(prev.timer);
    n += 1;
    if (n > maxTries) { state.set(id, { n, timer: 0 }); onGiveUp(id, reason, maxTries); return; }
    const wait = Math.min(maxWaitMs, stepMs * n);
    const timer = timers.set(() => { const s = state.get(id); if (s) s.timer = 0; restart(id); }, wait);
    state.set(id, { n, timer });
    onWait(id, reason, wait, n, maxTries);
  }

  return { dropped, cancel, count: (id) => (state.get(id) || {}).n || 0 };
}

module.exports = { createAutoRetry };
