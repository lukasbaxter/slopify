// Saving a track to disk, in the format the user picked from the row menu.
//
// Jellyfin serves the original file and flac/mp3/aac/ogg transcodes; it has no
// wav muxer, so WAV is built here: fetch the original, decode it with the
// browser's audio decoder, write 16-bit PCM. The desktop app hands the URL to
// the main process (a cross-origin <a download> would navigate to the stream
// and replace the UI with Chromium's audio player); the web build is
// same-origin through the /jf proxy, so a plain download link works.

export const FORMATS = [
  { id: 'original', label: 'Original (highest quality)' },
  { id: 'flac', label: 'FLAC' },
  { id: 'wav', label: 'WAV (16-bit)' },
  { id: 'mp3', label: 'MP3 320 kbps' },
  { id: 'aac', label: 'AAC 256 kbps' },
  { id: 'ogg', label: 'OGG Vorbis 320 kbps' },
];

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function baseName(track) {
  const artist = (track.Artists || []).join(', ') || track.AlbumArtist || 'Unknown Artist';
  return safeName(`${artist} - ${track.Name}`);
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function encodeWav(audio) {
  const ch = audio.numberOfChannels, n = audio.length, rate = audio.sampleRate;
  const buf = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => audio.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true); o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Returns a promise; rejects with a readable message. */
export async function downloadTrack(jf, track, fmt = 'original') {
  const base = baseName(track);
  if (fmt === 'wav') {
    const res = await fetch(jf.downloadUrl(track.Id, 'original'));
    if (!res.ok) throw new Error(`Jellyfin ${res.status}`);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const audio = await ctx.decodeAudioData(await res.arrayBuffer());
      saveBlob(encodeWav(audio), `${base}.wav`);
    } finally { ctx.close(); }
    return;
  }
  let ext = fmt;
  if (fmt === 'original') {
    const src = track.Path || track.MediaSources?.[0]?.Path || '';
    ext = (src.match(/\.([a-z0-9]{2,5})$/i) || [, 'flac'])[1].toLowerCase();
  }
  const filename = `${base}.${ext}`;
  const url = `${jf.downloadUrl(track.Id, fmt)}&conduit_name=${encodeURIComponent(filename)}`;
  if (window.conduit?.download) { await window.conduit.download(url); return; }
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
}
