// What this client is called in everyone's device list. The desktop app knows
// its machine's name; the phone app tells the page its model ("iPhone 16");
// a browser is named after itself and its system ("Safari on Mac"), so two
// of them can be told apart without numbers.

export function describeBrowser(ua) {
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua)) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'Chromebook'
    : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) || (/AppleWebKit\//.test(ua) && /iPhone|iPad|Macintosh/.test(ua)) ? 'Safari' : 'Browser';
  return os ? `${browser} on ${os}` : browser;
}

export function clientIdentity() {
  if (typeof window === 'undefined') return { name: 'Slopify', kind: 'web' };
  if (window.conduit) return { name: window.conduit.deviceName || 'Slopify Desktop', kind: 'desktop' };
  const shell = window.slopifyShell;
  if (shell?.deviceName) return { name: String(shell.deviceName), kind: 'phone' };
  return { name: describeBrowser(navigator.userAgent || ''), kind: 'web' };
}
