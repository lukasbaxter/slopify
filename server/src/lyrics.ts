// LRC parsing into { start (ms) | null, text } lines. Tag lines ([ar:], [ti:],
// [offset:]) are dropped; a line with several timestamps becomes several lines.
export type LyricLine = { start: number | null; text: string };

export function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const off = /^\[offset:\s*([+-]?\d+)\]/i.exec(line);
    if (off) { offset = Number(off[1]); continue; }
    let rest = line;
    const starts: number[] = [];
    for (;;) {
      const m = /^\[(\d+):(\d+(?:\.\d+)?)\]/.exec(rest);
      if (!m) break;
      starts.push(Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000));
      rest = rest.slice(m[0].length);
    }
    if (!starts.length && /^\[[a-z]+:/i.test(rest)) continue;
    const t = rest.trim();
    if (!starts.length) out.push({ start: null, text: t });
    else for (const s of starts) out.push({ start: Math.max(0, s + offset), text: t });
  }
  // Only the timed lines sort by time; an untimestamped line in a mixed file
  // keeps its original place instead of the whole plain block piling up at
  // the front.
  const timed = out.filter((l) => l.start != null).sort((a, b) => a.start! - b.start!);
  let i = 0;
  return out.map((l) => (l.start == null ? l : timed[i++]));
}

export const isSynced = (lines: LyricLine[]) => lines.some((l) => l.start != null);
