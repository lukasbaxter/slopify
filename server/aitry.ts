import { openDb } from './src/db.js';
import { Llm, generatePlaylist } from './src/ai.js';
import { similarInLibrary } from './src/discover.js';
const db = openDb(process.env.DATA!);
const uid = (db.prepare("SELECT id FROM users WHERE name = 'lukas@lukasbaxter.ca'").get() as any).id;
const llm = new Llm({ llmUrl: 'http://127.0.0.1:18092', llamaBin: '', modelPath: '', modelUrl: '', port: 0, idleMs: 60000, gpuLayers: '', ctx: 36864 });
for (const prompt of process.argv.slice(2)) {
  const t0 = Date.now(); const job: any = { state: 'running' }; let last = '';
  const iv = setInterval(() => { const st = job.info?.stages?.find((x: any) => x.state === 'active')?.key; if (st && st !== last) { console.log(`  +${((Date.now() - t0) / 1000).toFixed(1)}s ${st}`); last = st; } }, 100);
  const r = await generatePlaylist(db, llm, uid, prompt, job, (a) => similarInLibrary(db, a), async (_pl, songs) => { console.log('  would request:', songs.map((x) => `${x.artist} - ${x.title}`).join(' | ')); return songs.length; });
  clearInterval(iv); job.state = 'done';
  const plays = db.prepare('SELECT COUNT(*) n FROM plays WHERE user_id = ? AND track_id = ?');
  console.log(`=== "${prompt}" -> ${r.name} (${r.count} songs, ${r.known} known, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  r.tracks.forEach((t: any, i: number) => { const x = db.prepare('SELECT artist, title FROM tracks WHERE id = ?').get(t.id) as any; console.log(`${String(i + 1).padStart(2)}. [${t.fit}${t.known ? ' KNOWN' : ''}] ${x.artist} - ${x.title}`); });
}
