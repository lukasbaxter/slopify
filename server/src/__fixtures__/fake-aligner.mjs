// Speaks aligner/align.py's protocol for the lyricsync tests. Every line is
// "sung" FAKE_SHIFT ms after its known start (FAKE_STARTS by path), or at
// i * 3000. A path containing "wrong" aligns badly (a different song).
import readline from 'node:readline';
const SHIFT = Number(process.env.FAKE_SHIFT || 0);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ ready: true, device: 'cpu', model: 'fake', separate: process.env.ALIGN_SEPARATE === '1' });
readline.createInterface({ input: process.stdin }).on('line', (raw) => {
  const req = JSON.parse(raw);
  if (req.path.includes('broken')) return out({ id: req.id, ok: false, error: 'RuntimeError: cannot decode' });
  const starts = JSON.parse(process.env.FAKE_STARTS || '{}')[req.path];
  out({ id: req.id, ok: true, score: req.path.includes('wrong') ? 0.12 : 0.85, lang: 'en', ms: 5,
    lines: req.lines.map((_, i) => ({ start: (starts ? starts[i] + SHIFT : i * 3000), end: null, prob: req.path.includes('wrong') ? 0.1 : 0.9 })) });
});
