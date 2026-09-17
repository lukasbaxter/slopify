// Silent shadow stream for the visualizer on a device that is not the one
// playing: the mp3 transcode is fetched as bytes, split at frame boundaries,
// decoded with decodeAudioData and scheduled on the AudioContext clock into
// an output node that is never connected to the speakers. No media element
// is involved: an <audio> captured by createMediaElementSource can still come
// out of the speaker on iOS (the iPad played along with the phone when the
// visualizer came on); a buffer source with no path to the destination
// cannot make a sound.
//
// Time-keeping: every mp3 frame is a fixed number of samples, so the track
// time of a chunk is `base + framesBefore * samplesPerFrame / sampleRate`,
// exact whatever the decoder trims at chunk edges. Chunks are scheduled at
// that time on the context clock (t0 = the moment the first chunk starts),
// so a lost frame at a boundary is a 26 ms hole, never accumulated drift.

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// Layer III frame header at `i`, or null.
function frameAt(b, i) {
  if (i + 4 > b.length || b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) return null;
  const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
  if (ver === 1 || layer !== 1) return null;
  const bi = b[i + 2] >> 4, si = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
  if (bi === 0 || bi === 15 || si === 3) return null;
  const kbps = (ver === 3 ? BR1 : BR2)[bi], sr = SR[ver][si];
  const spf = ver === 3 ? 1152 : 576;
  const len = Math.floor((spf / 8) * kbps * 1000 / sr) + pad;
  return { len, sr, spf };
}

const CHUNK_SECONDS = 2;
const AHEAD_SECONDS = 8; // stop pulling the transcode when this much is scheduled

export function createShadow(ctx) {
  const source = ctx.createGain(); // analysers hang off this; nothing downstream
  const sh = {
    ctx, source,
    id: null,        // track id of the current stream (owned by the caller)
    base: 0,         // track time the current stream starts at
    lead: 1.0,       // how far ahead of the playhead to ask for (learned)
    offset: undefined,
    loading: false,  // between load() and the first chunk playing
    paused: true,
    _run: 0, _abort: null, _t0: 0, _nodes: new Set(), _onPlaying: null,
  };

  const stopNodes = () => { for (const n of sh._nodes) { try { n.stop(); } catch { /* not started */ } } sh._nodes.clear(); };

  // Track time coming out of the analyser right now.
  Object.defineProperty(sh, 'position', { get() { return sh.paused || sh.loading ? sh.base : sh.base + Math.max(0, ctx.currentTime - sh._t0); } });

  sh.onPlaying = (cb) => { sh._onPlaying = cb; };

  sh.stop = () => {
    sh._run++;
    sh._abort?.abort(); sh._abort = null;
    stopNodes();
    sh.paused = true; sh.loading = false;
  };

  // Start a fresh stream that begins at track time `base`.
  sh.load = (url, base) => {
    sh.stop();
    const run = sh._run;
    const ac = new AbortController(); sh._abort = ac;
    sh.base = base; sh.loading = true; sh.paused = false;
    (async () => {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`shadow ${res.status}`);
      const reader = res.body.getReader();
      let buf = new Uint8Array(0), frames = 0, first = true, chunkEnd = 0;
      const emit = async (bytes, nFrames, sr, spf) => {
        const at = frames * spf / sr; // stream time of this chunk
        frames += nFrames;
        const audio = await ctx.decodeAudioData(bytes.slice().buffer);
        if (run !== sh._run) return;
        if (first) { first = false; sh._t0 = ctx.currentTime + 0.05; sh.loading = false; sh._onPlaying?.(); }
        const when = sh._t0 + at;
        if (when + audio.duration < ctx.currentTime) return; // decoded too late, skip
        const node = ctx.createBufferSource(); node.buffer = audio; node.connect(source);
        node.onended = () => { sh._nodes.delete(node); try { node.disconnect(); } catch { /* gone */ } };
        sh._nodes.add(node);
        const late = Math.max(0, ctx.currentTime - when);
        node.start(Math.max(when, ctx.currentTime), late);
        chunkEnd = when + audio.duration;
      };
      for (;;) {
        // Backpressure: never decode more than AHEAD_SECONDS ahead of the clock.
        while (run === sh._run && chunkEnd - ctx.currentTime > AHEAD_SECONDS) await new Promise((r) => setTimeout(r, 250));
        if (run !== sh._run) return;
        const { done, value } = await reader.read();
        if (run !== sh._run) return;
        if (value) { const nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb; }
        // Cut whole frames off the front of the buffer, CHUNK_SECONDS at a time.
        let i = 0, start = -1, n = 0, sr = 0, spf = 0;
        const flush = async (end) => { if (n) await emit(buf.subarray(start, end), n, sr, spf); start = -1; n = 0; };
        while (i + 4 <= buf.length) {
          const f = frameAt(buf, i);
          if (!f) { if (start >= 0) { await flush(i); } i++; continue; } // junk / ID3 / mid-frame: resync
          if (i + f.len > buf.length && !done) break; // partial frame: wait for more
          if (start < 0) { start = i; sr = f.sr; spf = f.spf; }
          n++; i += Math.min(f.len, buf.length - i);
          if (n * spf / sr >= CHUNK_SECONDS) { await flush(i); }
          if (run !== sh._run) return;
        }
        if (done) { await flush(Math.min(i, buf.length)); return; }
        const keep = start >= 0 ? start : i;
        buf = buf.subarray(keep);
      }
    })().catch((e) => { if (e?.name !== 'AbortError' && run === sh._run) { console.warn('shadow stream', e); sh.loading = false; } });
  };

  sh.close = () => { sh.stop(); try { source.disconnect(); } catch { /* not connected */ } };
  return sh;
}
