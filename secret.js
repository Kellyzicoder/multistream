// Keeps saved logins and stream keys encrypted on this computer (Windows: locked to this Windows user;
// Mac: the Keychain). Outside the desktop app (the tests) they are left as they are.
// A value that cannot be opened here (copied to another PC, or the Mac Keychain said no) comes back as null.
// server.js then keeps it exactly as it was in the file, so it is never lost by accident.
let ss = null;
try { const e = require('electron'); if (e && typeof e === 'object' && e.safeStorage) ss = e.safeStorage; } catch {}
// True when this computer can lock secrets (Windows or the Mac Keychain).
const ready = () => { try { return Boolean(ss && ss.isEncryptionAvailable()); } catch { return false; } };
// Locks a secret so it can only be opened on this computer.
function seal(v) {
  if (!v || typeof v !== 'string' || v.startsWith('enc:') || !ready()) return v;
  return 'enc:' + ss.encryptString(v).toString('base64');
}
// Opens a locked secret. Returns null when it cannot be opened here.
function open(v) {
  if (typeof v !== 'string' || !v.startsWith('enc:')) return v;
  if (!ss) return null;
  try { return ss.decryptString(Buffer.from(v.slice(4), 'base64')); } catch { return null; }
}
module.exports = { seal, open };
