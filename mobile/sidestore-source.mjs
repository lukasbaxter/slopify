// The SideStore / AltStore source for the iPhone app: one app, the newest
// version. Published as a release asset, so its address never changes:
//   https://github.com/lukasbaxter/slopify/releases/latest/download/sidestore-source.json
// SideStore matches it to the installed app by bundle id and offers the
// update when the version here is newer.
//   node sidestore-source.mjs <version> <ipa path> [min iOS]
import fs from 'node:fs';
import path from 'node:path';

const [version, ipa, minOS = '16.4'] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY || 'lukasbaxter/slopify';
const raw = `https://raw.githubusercontent.com/${repo}/main`;
const app = JSON.parse(fs.readFileSync(new URL('./app.json', import.meta.url))).expo;

console.log(JSON.stringify({
  name: 'Slopify',
  subtitle: 'Self-hosted music',
  description: 'The Slopify phone app, for sideloading until it is in the App Store.',
  iconURL: `${raw}/web/public/icon-512.png`,
  website: `https://github.com/${repo}`,
  tintColor: '#1ED760',
  nsfw: false,
  featuredApps: [app.ios.bundleIdentifier],
  apps: [{
    name: 'Slopify',
    bundleIdentifier: app.ios.bundleIdentifier,
    developerName: 'Slopify contributors',
    subtitle: 'Your music, on any speaker in the house.',
    localizedDescription: 'Your own Slopify server on your phone: your library, playlists and lyrics, one session shared with your other devices, and your speakers. Plays with the screen off; the volume buttons step a speaker\'s volume while the music is on it.',
    iconURL: `${raw}/web/public/icon-512.png`,
    tintColor: '#1ED760',
    category: 'entertainment',
    versions: [{
      version, buildVersion: version, date: new Date().toISOString(),
      localizedDescription: `Release notes: https://github.com/${repo}/releases/tag/v${version}`,
      downloadURL: `https://github.com/${repo}/releases/download/v${version}/${path.basename(ipa)}`,
      size: fs.statSync(ipa).size,
      minOSVersion: minOS,
    }],
    appPermissions: { entitlements: [], privacy: {} },
  }],
  news: [],
}, null, 2));
