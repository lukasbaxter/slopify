// Settings › About: the version, and where this server's source code is.
// Slopify is AGPL software; anyone using it over a network can get the code.
import { useEffect, useState } from 'react';
import { t } from '../i18n.js';

export default function About({ jf, phone = false }) {
  const [info, setInfo] = useState(null);
  useEffect(() => { jf.serverInfo?.().then(setInfo).catch(() => {}); }, [jf]);
  const source = info?.source || 'https://github.com/lukasbaxter/slopify';
  return (
    <section className={phone ? 'settings-about phone' : 'settings-section settings-about'}>
      {!phone && <h2>{t('About')}</h2>}
      <p className="settings-hint">
        {t('{app} is free software under the <a>GNU AGPL v3</a>.', { app: `Slopify${info?.version ? ` ${info.version}` : ''}` }).split(/<a>(.*?)<\/a>/).map((part, i) => (i % 2 ? <a key={i} href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">{part}</a> : part))}{' '}
        <a href={source} target="_blank" rel="noreferrer">{t('Source code')}</a> ·{' '}
        <a href={`${source.replace(/\/$/, '')}/blob/main/docs/PRIVACY.md`} target="_blank" rel="noreferrer">{t('What leaves your server')}</a>
      </p>
      <p className="settings-hint">{t('Not affiliated with Spotify.')}</p>
    </section>
  );
}
