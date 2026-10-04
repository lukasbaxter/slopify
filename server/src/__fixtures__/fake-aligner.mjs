// Speaks aligner/align.py's protocol for the lyricsync tests. Aligning: every
// line is "sung" FAKE_SHIFT ms after its known start (FAKE_STARTS by path), or
// at i * 3000. Writing: three lines of five words, or two stray words for a
// path containing "quiet" (an instrumental's lone hallucination).
import readline from 'node:readline';
const SHIFT = Number(process.env.FAKE_SHIFT || 0);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ ready: true, device: 'cpu', model: 'fake', separate: process.env.ALIGN_SEPARATE === '1', preload: process.env.ALIGN_PRELOAD !== '0' });
readline.createInterface({ input: process.stdin }).on('line', (raw) => {
  const req = JSON.parse(raw);
  if (req.path.includes('broken')) return out({ id: req.id, ok: false, error: 'RuntimeError: cannot decode' });
  if (req.cmd === 'transcribe') {
    if (req.path.includes('quiet')) return out({ id: req.id, ok: true, words: 2, lang: 'en', ms: 5, lines: [{ start: 144000, end: 145000, text: "don't know.", prob: 0.5 }] });
    return out({ id: req.id, ok: true, words: 15, lang: 'en', ms: 5, lines: [0, 1, 2].map((i) => ({ start: 10000 + i * 4000, end: 13000 + i * 4000, text: `written line number ${i} here`, prob: 0.9 })) });
  }
  const starts = JSON.parse(process.env.FAKE_STARTS || '{}')[req.path];
  out({ id: req.id, ok: true, score: 0.85, lang: 'en', ms: 5,
    lines: req.lines.map((_, i) => ({ start: (starts ? starts[i] + SHIFT : i * 3000), end: null, prob: 0.9 })) });
});
