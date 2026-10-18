// Mac: Apple silicon refuses apps with no signature at all ("is damaged"). We have no Apple developer
// account, so sign with a free "ad hoc" signature. The app then opens after the normal right-click > Open.
const { execFileSync } = require('child_process');
const path = require('path');
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
