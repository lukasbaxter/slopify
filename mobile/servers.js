// Which of the server's two addresses the phone app should use, and the
// checks behind it (App.js wires these to the network, the app's state and
// the page). Plain functions: tools/ test them in Node.
import { hmacHex, nonce, sameHex } from './hmac';

const ipv4 = (h) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h || ''); return m ? m.slice(1).map(Number) : null; };
const hostOf = (addr) => (/^https?:\/\/([^/:]+|\[[^\]]+\])/i.exec(addr || '') || [])[1]?.toLowerCase() || '';

// An address only a home network can reach: a private IPv4 (not the VPN
// range: a Tailscale 100.x address works on cellular), a .local name, a
// one-word name. Not worth trying on cellular.
export function lanOnly(addr) {
  const h = hostOf(addr);
  const ip = ipv4(h);
  if (ip) return ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168) || (ip[0] === 169 && ip[1] === 254);
  return h.endsWith('.local') || (!!h && !h.includes('.') && !h.startsWith('['));
}

// The network the phone is on, as a key to remember it by: "wifi:192.168.1.0/24".
// No Wi-Fi name (that needs location permission); the subnet is enough to tell
// home from a café most of the time, and a wrong guess only costs a check.
export function netKey(state) {
  if (!state || state.isConnected === false) return null;
  const type = state.type || 'unknown';
  const d = state.details || {};
  const ip = ipv4(d.ipAddress); const mask = ipv4(d.subnet);
  if (ip && mask) {
    const bits = mask.reduce((n, o) => n + (o.toString(2).match(/1/g) || []).length, 0);
    return `${type}:${ip.map((o, i) => o & mask[i]).join('.')}/${bits}`;
  }
  return type;
}

// Worth trying the home address on this network at all?
export const homeTryable = (home, state) => !!home && !!state && state.isConnected !== false && !(state.type === 'cellular' && lanOnly(home));

const withTimeout = async (url, ms, init = {}) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal, cache: 'no-store' }); } finally { clearTimeout(timer); }
};

// Is this really your server? It answers HMAC(key, nonce) with the key only
// a signed-in app of your account holds (server/src/addresses.ts). The same
// private IP on someone else's Wi-Fi is someone else's machine: it never
// gets the sign-in or the page.
export async function provesItself(home, auth, ms) {
  if (!home || !auth?.key || !auth?.userId) return false;
  const n = nonce();
  try {
    const res = await withTimeout(`${home}/api/server/proof?u=${encodeURIComponent(auth.userId)}&n=${n}`, ms);
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return sameHex(body?.proof, hmacHex(auth.key, n));
  } catch { return false; }
}

// Does a Slopify server answer here at all? (the server screen's check)
export async function answers(base, ms) {
  try {
    const res = await withTimeout(`${base}/api/healthz`, ms);
    if (!res.ok) return false;
    return (await res.json().catch(() => null))?.ok === true;
  } catch { return false; }
}

// What the server tells a signed-in app: its key for the check above, its
// home-network address and the internet addresses people use for it.
export async function askAddresses(base, token, ms = 8000) {
  try {
    const res = await withTimeout(`${base}/api/server/addresses`, ms, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// A page on https cannot reach an http address (mixed content): moving it
// there needs a reload; every other move can happen under the running page.
export const canMoveLive = (page, target) => !(String(page).startsWith('https:') && String(target).startsWith('http:'));
