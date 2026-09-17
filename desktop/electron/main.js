'use strict';

const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Discovery } = require('./discovery');
const { CastTransport } = require('./transports/cast');
const { BluOSTransport } = require('./transports/bluos');

// SLOPIFY_DEV=1: load the Vite dev server instead of the shipped web build.
const isDev = !app.isPackaged && process.env.SLOPIFY_DEV === '1';

// "Lukass-MBP-2.localdomain" -> "Lukass MBP 2"
function friendlyHostname() {
  const raw = require('os').hostname() || 'Desktop';
  return raw.split('.')[0].replace(/-/g, ' ').trim() || 'Desktop';
}

let win = null;
let discovery = null;
/** @type {Map<string, CastTransport|BluOSTransport>} */
const transports = new Map();

function transportFor(device) {
  if (!device || !device.id) throw new Error('No device supplied');
  let t = transports.get(device.id);
  if (!t) {
    t = device.kind === 'cast' ? new CastTransport(device) : new BluOSTransport(device);
    transports.set(device.id, t);
  }
  return t;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0d0d10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload cannot require('os') under the default sandbox, so the
      // machine name is handed across as a launch argument instead.
      additionalArguments: [
        `--conduit-device-name=${encodeURIComponent(friendlyHostname())}`,
      ],
    },
  });

  // Open external links in the real browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL('http://localhost:5180');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.on('closed', () => { win = null; });
  // Mouse back / forward buttons: macOS delivers them as app commands (the
  // renderer never sees a mouse event), so forward them to the page's history.
  win.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward' || cmd === 'browser-forward') { e.preventDefault(); win.webContents.send('navigate', cmd === 'browser-backward' ? 'back' : 'forward'); }
  });
  // Never let those buttons navigate the BrowserWindow itself.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('http://localhost:5180') && !url.includes('/index.html')) e.preventDefault(); });
}

/**
 * Annotate BluOS players with their sync-group membership so the UI can present
 * a group as one speaker instead of listing every member separately.
 */
async function withSyncInfo(devices) {
  const out = await Promise.all(
    devices.map(async (d) => {
      if (d.kind !== 'bluos') return d;
      try {
        const info = await new BluOSTransport(d).syncInfo();
        return { ...d, ...info };
      } catch {
        return d;
      }
    })
  );
  return out;
}

function startDiscovery() {
  discovery = new Discovery(async (devices) => {
    trace(`discovery -> ${devices.length} device(s): ${devices.map((d) => d.name).join(', ')}`);
    const annotated = await withSyncInfo(devices);
    const grouped = annotated.filter((d) => d.isSlave || d.groupName);
    if (grouped.length) {
      trace(`sync groups: ${grouped.map((d) => `${d.name}${d.isSlave ? ' (slave of ' + d.masterHost + ')' : ' (master)'}`).join('; ')}`);
    }
    if (win && !win.isDestroyed()) win.webContents.send('devices:changed', annotated);
  });
  discovery.start();
  trace('discovery started');
}

app.whenReady().then(() => {
  createWindow();
  startDiscovery();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (discovery) discovery.stop();
  for (const t of transports.values()) {
    if (typeof t.close === 'function') t.close();
  }
});

// --- IPC -------------------------------------------------------------------
// Every handler returns {ok, ...} rather than throwing across the bridge, so the
// renderer can surface a device error without an unhandled rejection.

// Set SLOPIFY_TRACE=1 to log every device call with timings. Invaluable for
// telling "the speaker is misbehaving" apart from "the UI is calling us wrong",
// which look identical from the renderer.
// Written to a file rather than stdout: Electron's stdout does not survive the
// concurrently wrapper in dev, so console logging here silently goes nowhere.
const TRACE = process.env.SLOPIFY_TRACE !== '0';
const TRACE_FILE = path.join(require('os').tmpdir(), 'slopify-trace.log');
const t0 = Date.now();
try { if (TRACE) fs.writeFileSync(TRACE_FILE, `--- slopify trace ${new Date().toISOString()} ---\n`); } catch (e) { /* non-fatal */ }
const trace = (...a) => {
  if (!TRACE) return;
  const line = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(' ')}\n`;
  try { fs.appendFileSync(TRACE_FILE, line); } catch (e) { /* non-fatal */ }
};

const handle = (channel, fn) => {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try {
      const value = await fn(...args);
      if (TRACE) {
        const dev = args[0]?.name || '';
        if (channel === 'devices:list') {
          trace(`list    -> ${(value || []).length} device(s)`);
        } else if (channel === 'device:status') {
          trace(`status  ${dev} -> playing=${value?.playing} pos=${value?.position}`);
        } else {
          trace(`${channel.replace('device:', '').padEnd(7)} ${dev}`, channel === 'device:play' ? String(args[1]).slice(-40) : (args[1] ?? ''));
        }
      }
      return { ok: true, value };
    } catch (err) {
      trace(`${channel} FAILED: ${err?.message}`);
      return { ok: false, error: err?.message || String(err) };
    }
  });
};

// Renderer exceptions never reach stdout in Electron, so a crash there looks
// identical to "the app just stopped doing things". Funnel them into the trace.
ipcMain.on('renderer:error', (_e, msg) => trace(`RENDERER ERROR: ${msg}`));
ipcMain.on('renderer:debug', (_e, msg) => trace(`ui: ${msg}`));

handle('devices:list', () => (discovery ? withSyncInfo(discovery.list()) : []));

// Track downloads. The renderer cannot use <a download> for a Jellyfin URL
// (cross-origin, so Chromium would navigate to the stream and play it in
// place of the app); main starts the download and names the file. The
// renderer passes the wanted filename as a `conduit_name` query param, which
// Jellyfin ignores.
handle('download', (url) => { if (win) win.webContents.downloadURL(url); return true; });
app.whenReady().then(() => {
  session.defaultSession.on('will-download', (_e, item) => {
    let name = item.getFilename();
    try { name = new URL(item.getURL()).searchParams.get('conduit_name') || name; } catch { /* blob: etc. */ }
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), name) });
    trace(`download ${name}`);
  });
});

handle('device:play', (device, url, meta, startAt) => transportFor(device).play(url, meta, startAt || 0));
handle('device:resume', (device) => transportFor(device).resume());
handle('device:pause', (device) => transportFor(device).pause());
handle('device:stop', (device) => transportFor(device).stop());
handle('device:seek', (device, seconds) => transportFor(device).seek(seconds));
handle('device:volume', (device, level) => transportFor(device).setVolume(level));
handle('device:status', (device) => transportFor(device).status());
// BluOS only: block until the speaker's status changes (see BluOSTransport.statusWait).
handle('device:statusWait', (device, etag) => { const t = transportFor(device); if (!t.statusWait) throw new Error('no long-poll'); return t.statusWait(etag); });
handle('device:identify', (device) => {
  const t = transportFor(device);
  return typeof t.identify === 'function' ? t.identify() : { name: device.name };
});
