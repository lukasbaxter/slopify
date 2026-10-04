// Speaks aligner/align.py's protocol for the lyricsync tests. Every line is
// "sung" SHIFT ms after its original start (synced) or at i * 3000 (plain).
import readline from 'node:readline';
const SHIFT = Number(process.env.FAKE_SHIFT || 0);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ ready: true, device: 'cpu', model: 'fake', separate: process.env.ALIGN_SEPARATE === '1' });
readline.createInterface({ input: process.stdin }).on('line', (raw) => {
  const req = JSON.parse(raw);
  if (req.path.includes('broken')) return out({ id: req.id, ok: false, error: 'RuntimeError: cannot decode' });
  const starts = JSON.parse(process.env.FAKE_STARTS || '{}')[req.path];
  out({ id: req.id, ok: true, score: 0.85, lang: 'en', ms: 5,
    lines: req.lines.map((_, i) => ({ start: (starts ? starts[i] + SHIFT : i * 3000), end: null, prob: 0.9 })) });
});
