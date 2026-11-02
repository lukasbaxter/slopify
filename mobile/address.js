// What someone types as their server address, made into one the app can
// load: "music.example.com" -> https://music.example.com. A bare IP, a .local
// name or a one-word host is a home server, so plain http. No trailing slash.
// null when it is not a web address at all, '' when empty. Parsed by hand:
// React Native's URL has not always had origin/hostname/pathname.
const RE = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?(\/[^?#]*)?(?:[?#].*)?$/i;

export const cleanAddress = (s) => {
  let u = String(s || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    const host = u.split(/[/:?#]/)[0];
    const lan = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /\.local$/i.test(host) || !host.includes('.');
    u = `${lan ? 'http' : 'https'}://${u}`;
  }
  const m = RE.exec(u);
  if (!m || !m[2] || /^[.-]|[.-]$/.test(m[2])) return null;
  const scheme = m[1].toLowerCase();
  const port = m[3] && !((scheme === 'http' && m[3] === '80') || (scheme === 'https' && m[3] === '443')) ? `:${m[3]}` : '';
  return `${scheme}://${m[2].toLowerCase()}${port}${(m[4] || '').replace(/\/+$/, '')}`;
};

// scheme://host[:port] of an address or page URL; '' when it is neither.
export const originOf = (u) => {
  const m = RE.exec(String(u || ''));
  if (!m) return '';
  const scheme = m[1].toLowerCase();
  const port = m[3] && !((scheme === 'http' && m[3] === '80') || (scheme === 'https' && m[3] === '443')) ? `:${m[3]}` : '';
  return `${scheme}://${m[2].toLowerCase()}${port}`;
};
