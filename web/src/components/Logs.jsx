// Settings › Logs: what this device logged (web/src/api/clientLog.js), and a
// problem report that sends what the person wrote with those lines to the
// server (server/src/reports.ts), kept there with who sent it and when.
import { useEffect, useRef, useState } from 'react';
import { clientLogLines } from '../api/clientLog.js';
import { clientIdentity } from '../api/deviceName.js';
import { t } from '../i18n.js';

const deviceInfo = () => {
  let standalone = false;
  try { standalone = window.navigator.standalone ?? window.matchMedia('(display-mode: standalone)').matches; } catch { /* old browser */ }
  return {
    device: clientIdentity().name,
    installed: !!standalone,
    online: navigator.onLine,
    link: navigator.connection?.effectiveType || null,
    screen: [window.screen.width, window.screen.height],
    window: [window.innerWidth, window.innerHeight],
    desktop: window.conduit?.platform || null,
    shell: window.slopifyShell?.version || null,
    language: navigator.language,
  };
};

export function LogsDialog({ jf, onClose }) {
  const [lines] = useState(clientLogLines);
  const [text, setText] = useState('');
  const [state, setState] = useState(null); // null | 'sending' | 'sent' | error text
  const [copied, setCopied] = useState(false);
  const view = useRef(null);
  useEffect(() => { if (view.current) view.current.scrollTop = view.current.scrollHeight; }, []);
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(lines.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* no clipboard */ }
  };
  const send = async (e) => {
    e.preventDefault();
    setState('sending');
    try {
      await jf._fetch('/api/reports', { method: 'POST', body: JSON.stringify({ message: text.trim(), logs: lines.slice(-300), info: deviceInfo() }) });
      setState('sent'); setText('');
    } catch (err) { setState(err.message || t('Could not send')); }
  };
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal logs-modal" onSubmit={send}>
        <div className="logs-head">
          <h3>{t('Logs')}</h3>
          <button type="button" className="btn-secondary" onClick={copy} disabled={!lines.length}>{copied ? t('Copied') : t('Copy')}</button>
        </div>
        <pre className="logs-view" ref={view}>{lines.length ? lines.join('\n') : t('Nothing logged on this device yet.')}</pre>
        <h3>{t('Report a problem')}</h3>
        <textarea value={text} onChange={(e) => { setText(e.target.value); if (state !== 'sending') setState(null); }} placeholder={t('What happened, and what were you doing?')} rows={4} maxLength={4000} />
        <div className="settings-hint">{t("Sends what you write, the log above and this device's type to your Slopify server.")}</div>
        {state && state !== 'sending' && <div className={`settings-hint ${state === 'sent' ? 'logs-sent' : 'logs-error'}`}>{state === 'sent' ? t('Sent. Thanks.') : state}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('Close')}</button>
          <button type="submit" className="primary" disabled={!text.trim() || state === 'sending'}>{state === 'sending' ? t('Sending…') : t('Send report')}</button>
        </div>
      </form>
    </div>
  );
}
