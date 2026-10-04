// Settings › About: the version, and where this server's source code is.
// Slopify is AGPL software; anyone using it over a network can get the code.
import { useEffect, useState } from 'react';

export default function About({ jf, phone = false }) {
  const [info, setInfo] = useState(null);
  useEffect(() => { jf.serverInfo?.().then(setInfo).catch(() => {}); }, [jf]);
  const source = info?.source || 'https://github.com/lukasbaxter/slopify';
  return (
    <section className={phone ? 'settings-about phone' : 'settings-section settings-about'}>
      {!phone && <h2>About</h2>}
      <p className="settings-hint">
        Slopify{info?.version ? ` ${info.version}` : ''} is free software under the{' '}
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">GNU AGPL v3</a>.{' '}
        <a href={source} target="_blank" rel="noreferrer">Source code</a> ·{' '}
        <a href={`${source.replace(/\/$/, '')}/blob/main/PRIVACY.md`} target="_blank" rel="noreferrer">What leaves your server</a>
      </p>
      <p className="settings-hint">Not affiliated with Spotify.</p>
    </section>
  );
}
