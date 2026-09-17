// electron-builder afterPack: ad-hoc sign the macOS app. No developer
// account here, so there is no real signature, but an unsigned app that
// came through a browser is refused as "damaged" on recent macOS; ad-hoc
// signed, Gatekeeper offers "open anyway" instead (or `xattr -cr` clears it).
const { execSync } = require('child_process');
const path = require('path');
exports.default = async (context) => {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execSync(`codesign --force --deep --sign - "${app}"`, { stdio: 'inherit' });
};
