// Keeps saved logins and stream keys encrypted on this computer (Windows: locked to this Windows user;
// Mac: the Keychain). Outside the desktop app (the tests) they are left as they are.
// A value that cannot be opened (for example the files were copied to another PC) comes back empty,
// so that login or key has to be entered again.
let ss = null;
try { const e = require('electron'); if (e && typeof e === 'object' && e.safeStorage) ss = e.safeStorage; } catch {}
const ready = () => { try { return Boolean(ss && ss.isEncryptionAvailable()); } catch { return false; } };
function seal(v) {
  if (!v || typeof v !== 'string' || v.startsWith('enc:') || !ready()) return v;
  return 'enc:' + ss.encryptString(v).toString('base64');
}
function open(v) {
  if (typeof v !== 'string' || !v.startsWith('enc:')) return v;
  try { return ss.decryptString(Buffer.from(v.slice(4), 'base64')); } catch { return ''; }
}
module.exports = { seal, open };
