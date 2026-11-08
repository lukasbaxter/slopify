'use strict';
// updater.js without Electron or GitHub: a stand-in `electron` module and
// https.get answering from a table. Run: npm test (in desktop/).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const Module = require('module');
const https = require('https');
const { PassThrough } = require('stream');

const fakeApp = { isPackaged: true, getVersion: () => '0.1.160', quit() {} };
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: fakeApp, powerMonitor: { on() {} } };
  return load.call(this, request, ...rest);
};
const updater = require('./updater');

// url -> body (string or Buffer); the latest release is the JSON one.
let routes = {};
https.get = (url, opts, cb) => {
  const res = new PassThrough();
  const body = routes[url];
  res.statusCode = body === undefined ? 404 : 200;
  res.headers = {};
  res.setEncoding = PassThrough.prototype.setEncoding;
  process.nextTick(() => { cb(res); res.end(body === undefined ? '' : body); });
  return { setTimeout() {}, on() {}, destroy() {} };
};
const LATEST = 'https://api.github.com/repos/lukasbaxter/slopify/releases/latest';
const asset = (name, body, extra = {}) => ({ name, size: Buffer.byteLength(body), browser_download_url: `https://dl/${name}`, ...extra });
function release(version, files) {
  routes = { [LATEST]: JSON.stringify({ tag_name: `v${version}`, assets: files.map(([name, body, extra]) => asset(name, body, extra)) }) };
  for (const [name, body] of files) routes[`https://dl/${name}`] = body;
}

const macAssets = (v) => [
  { name: `Slopify-${v}-arm64.dmg` },
  { name: `Slopify-${v}-arm64-mac.zip` },
  { name: `Slopify.Setup.${v}.exe` },
  { name: `Slopify.${v}.exe` },
];

test('an Apple silicon Mac gets the arm64 zip', () => {
  assert.strictEqual(updater._pickAsset(macAssets('0.1.162'), { platform: 'darwin', arch: 'arm64' })?.name, 'Slopify-0.1.162-arm64-mac.zip');
});

test('an Intel Mac is not offered the arm64 zip', () => {
  assert.strictEqual(updater._pickAsset(macAssets('0.1.162'), { platform: 'darwin', arch: 'x64' }), null);
});

test('an Intel Mac gets an Intel or universal zip when there is one', () => {
  const v = '0.1.162';
  assert.strictEqual(updater._pickAsset([...macAssets(v), { name: `Slopify-${v}-mac.zip` }], { platform: 'darwin', arch: 'x64' })?.name, `Slopify-${v}-mac.zip`);
  assert.strictEqual(updater._pickAsset([...macAssets(v), { name: `Slopify-${v}-x64-mac.zip` }], { platform: 'darwin', arch: 'x64' })?.name, `Slopify-${v}-x64-mac.zip`);
  assert.strictEqual(updater._pickAsset([{ name: `Slopify-${v}-universal-mac.zip` }], { platform: 'darwin', arch: 'x64' })?.name, `Slopify-${v}-universal-mac.zip`);
  assert.strictEqual(updater._pickAsset([{ name: `Slopify-${v}-universal-mac.zip` }], { platform: 'darwin', arch: 'arm64' })?.name, `Slopify-${v}-universal-mac.zip`);
});

test('Windows: installer or portable, as installed', () => {
  assert.strictEqual(updater._pickAsset(macAssets('0.1.162'), { platform: 'win32', arch: 'x64', env: {} })?.name, 'Slopify.Setup.0.1.162.exe');
  assert.strictEqual(updater._pickAsset(macAssets('0.1.162'), { platform: 'win32', arch: 'x64', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x.exe' } })?.name, 'Slopify.0.1.162.exe');
});

test('a newer release published after one is ready replaces it', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  release('0.1.161', [['Slopify.Setup.0.1.161.exe', 'one']]);
  await updater.check();
  assert.deepStrictEqual([updater.state().status, updater.state().version], ['ready', '0.1.161']);

  // The same release again: still ready, nothing downloaded.
  delete routes['https://dl/Slopify.Setup.0.1.161.exe'];
  await updater.check();
  assert.deepStrictEqual([updater.state().status, updater.state().version], ['ready', '0.1.161']);

  release('0.1.162', [['Slopify.Setup.0.1.162.exe', 'two']]);
  await updater.check();
  assert.deepStrictEqual([updater.state().status, updater.state().version], ['ready', '0.1.162']);

  // A check that fails leaves the ready update ready.
  routes = {};
  await updater.check();
  assert.deepStrictEqual([updater.state().status, updater.state().version], ['ready', '0.1.162']);

  // A download that does not match the release's checksum is not installed.
  const good = crypto.createHash('sha256').update('three').digest('hex');
  release('0.1.163', [['Slopify.Setup.0.1.163.exe', 'thre3', { digest: `sha256:${good}` }]]);
  await updater.check();
  assert.deepStrictEqual([updater.state().status, updater.state().version], ['ready', '0.1.162']);
  release('0.1.163', [['Slopify.Setup.0.1.163.exe', 'three', { digest: `sha256:${good}` }]]);
  await updater.check();
  assert.deepStrictEqual([updater.state().status, updater.state().version], ['ready', '0.1.163']);
});
