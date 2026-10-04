'use strict';
// In-app updates without a code-signing certificate (Electron's built-in
// updater needs one on the Mac). Checks GitHub's latest release a minute
// after launch and every 6 hours, downloads the build for this machine in
// the background, and once it is ready the page shows "Restart to update"
// in the profile menu. Restarting swaps the new app in and opens it:
//   Mac:     the .zip of the .app, unpacked with ditto, swapped in place of
//            the running bundle by a small script once this process exits
//            (files written by the app carry no quarantine flag, and the
//            build is ad-hoc signed, so it opens like the old one did).
//   Windows: the NSIS installer run silently (/S), which reopens the app;
//            the portable .exe is replaced next to itself.
//   Linux:   the AppImage file is replaced.
// Nothing happens in development (unpackaged) builds.

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');

const REPO = 'lukasbaxter/slopify';
const EVERY = 6 * 60 * 60 * 1000;

let state = { status: 'idle', version: null, error: null }; // idle | checking | downloading | ready | current | error
let ready = null; // { version, kind, file }
let listeners = [];

const set = (patch) => { state = { ...state, ...patch }; for (const fn of listeners) { try { fn(state); } catch { /* window gone */ } } };

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

function get(url, { json = false, to = null, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': `Slopify/${app.getVersion()}`, Accept: json ? 'application/vnd.github+json' : '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); resolve(get(new URL(res.headers.location, url).href, { json, to, redirects: redirects - 1 })); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      if (to) {
        const out = fs.createWriteStream(to);
        res.pipe(out); out.on('finish', () => out.close(() => resolve(to))); out.on('error', reject);
      } else {
        let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(json ? JSON.parse(body) : body); } catch (e) { reject(e); } });
      }
    });
    req.setTimeout(30000, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

// The release asset for this machine, or null.
function pickAsset(assets) {
  const find = (re) => assets.find((a) => re.test(a.name)) || null;
  if (process.platform === 'darwin') return find(new RegExp(`-${process.arch === 'arm64' ? 'arm64' : 'x64'}-mac\\.zip$`)) || (process.arch === 'x64' ? find(/-mac\.zip$/) : null);
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? find(/^Slopify\.\d+\.\d+\.\d+\.exe$/) : find(/Setup\.\d+\.\d+\.\d+\.exe$/);
  if (process.platform === 'linux' && process.env.APPIMAGE) return find(/\.AppImage$/);
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 1 << 20 }, (e, out) => (e ? reject(e) : resolve(out))));
}

async function check() {
  if (!app.isPackaged || ['checking', 'downloading', 'ready'].includes(state.status)) return state;
  set({ status: 'checking', error: null });
  try {
    const rel = await get(`https://api.github.com/repos/${REPO}/releases/latest`, { json: true });
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (!version || !newer(version, app.getVersion())) { set({ status: 'current', version: app.getVersion() }); return state; }
    const asset = pickAsset(rel.assets || []);
    if (!asset) { set({ status: 'current', version: app.getVersion(), error: `no ${process.platform} build in ${version}` }); return state; }
    set({ status: 'downloading', version });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-update-'));
    const file = await get(asset.browser_download_url, { to: path.join(dir, asset.name) });
    if (asset.size && fs.statSync(file).size !== asset.size) throw new Error('download incomplete');
    if (process.platform === 'darwin') {
      await run('ditto', ['-x', '-k', file, path.join(dir, 'new')]);
      const bundle = fs.readdirSync(path.join(dir, 'new')).find((n) => n.endsWith('.app'));
      if (!bundle) throw new Error('no app in the download');
      ready = { version, kind: 'mac', file: path.join(dir, 'new', bundle) };
    } else {
      ready = { version, kind: process.platform, file };
    }
    set({ status: 'ready', version });
  } catch (e) {
    set({ status: 'error', error: e.message });
  }
  return state;
}

// The running Mac bundle: /Applications/Slopify.app (from .../Contents/MacOS/Slopify).
const macBundle = () => path.resolve(path.dirname(process.execPath), '..', '..');

function install() {
  if (!ready) return false;
  if (ready.kind === 'mac') {
    const target = macBundle();
    // Waits for this process to exit, swaps the bundles, opens the new one.
    const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
old="${target}.old-$$"
mv "${target}" "$old" && mv "${ready.file}" "${target}" && rm -rf "$old" || { [ -d "$old" ] && [ ! -d "${target}" ] && mv "$old" "${target}"; }
open "${target}"`;
    spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
  } else if (ready.kind === 'win32') {
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portable) {
      const script = `Start-Sleep -Milliseconds 800; while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }; Copy-Item -Force '${ready.file}' '${portable}'; Start-Process '${portable}'`;
      spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawn(ready.file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    }
  } else if (ready.kind === 'linux') {
    const target = process.env.APPIMAGE;
    const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done; cp "${ready.file}" "${target}" && chmod +x "${target}" && "${target}" &`;
    spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
  }
  app.quit();
  return true;
}

function start(onState) {
  listeners.push(onState);
  if (!app.isPackaged) return;
  setTimeout(check, 60 * 1000);
  setInterval(check, EVERY).unref?.();
}

module.exports = { start, check, install, state: () => state, _newer: newer, _pickAsset: pickAsset };
