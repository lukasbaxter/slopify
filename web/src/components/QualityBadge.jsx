// Spotify's green "Lossless" tag, but saying what it is: FLAC 44.1kHz,
// FLAC 24-bit 96kHz, MP3 320kbps, AAC 320kbps. It names what is actually
// reaching the listener, not what sits on disk: a speaker gets the original
// file, this device gets whatever its stream mode delivers (an iPhone plays an
// AAC transcode of a FLAC, so it says AAC). Green when that is lossless.
import React, { useEffect, useState } from 'react';

const khz = (hz) => { const k = hz / 1000; return `${Number.isInteger(k) ? k : k.toFixed(1)}kHz`; };

export function formatLabel(f) {
  if (!f?.codec) return null;
  if (f.lossless) return [f.codec, f.bitDepth && f.bitDepth > 16 ? `${f.bitDepth}-bit` : null, f.sampleRate ? khz(f.sampleRate) : null].filter(Boolean).join(' ');
  return f.bitrate ? `${f.codec} ${Math.round(f.bitrate / 1000)}kbps` : f.codec;
}

// What the session's device receives for a file of format `f`.
export function deliveredFormat(f, deviceKind, jf) {
  if (!f) return null;
  if (deviceKind !== 'local' || !jf) return f;            // speakers and other clients: the original file
  const mode = jf.streamMode();
  if (mode === 'file') return f;
  const bitrate = { high: 320000, normal: 160000, low: 96000 }[jf.quality] || 320000;
  return { codec: mode === 'hls' ? 'AAC' : 'MP3', lossless: false, bitrate };
}

/** The now-playing track's delivered format, as { text, lossless } (or null). */
export function useQuality(player, jf) {
  const id = player?.nowPlaying?.itemId || null;
  const [fmt, setFmt] = useState(null);
  useEffect(() => {
    if (!id || !jf?.trackFormat) { setFmt(null); return undefined; }
    let alive = true;
    jf.trackFormat(id).then((f) => { if (alive) setFmt(f); }).catch(() => { if (alive) setFmt(null); });
    return () => { alive = false; };
  }, [id, jf]);
  const d = deliveredFormat(fmt, player?.nowPlaying?.device?.kind || 'local', jf);
  const text = formatLabel(d);
  return text ? { text, lossless: !!d.lossless } : null;
}

export default function QualityBadge({ quality, className = '' }) {
  if (!quality) return null;
  return (
    <span className={`quality-badge ${quality.lossless ? 'lossless' : ''} ${className}`} title={quality.lossless ? 'Lossless' : 'Compressed'}>
      {quality.text}
    </span>
  );
}
