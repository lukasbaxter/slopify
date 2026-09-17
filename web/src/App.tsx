import { useEffect, useState } from 'react';
export function App() {
  const [health, setHealth] = useState<string>('…');
  useEffect(() => { fetch('/api/healthz').then((r) => r.json()).then((j) => setHealth(j.ok ? `server ${j.version}` : 'down')).catch(() => setHealth('down')); }, []);
  return <main style={{ fontFamily: 'system-ui', padding: 24 }}><h1>Slopify</h1><p data-testid="health">{health}</p></main>;
}
