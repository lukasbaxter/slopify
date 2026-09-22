import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepAlive } from './keepalive.js';

// The local device is always present and is not discovered over mDNS. Named
// for the runtime: the desktop app IS the computer, the PWA is one web player
// among possibly several (the relay numbers those for the OTHER clients).
const IS_DESKTOP = typeof window !== 'undefined' && !!window.conduit;
export const LOCAL_DEVICE = {
  id: 'local',
  kind: 'local',
  name: IS_DESKTOP ? 'This Computer' : 'This Web Player',
  model: IS_DESKTOP ? 'Local playback' : 'Browser playback',
};

const MIME_BY_CONTAINER = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
};

function containerOf(track) {
  const c = (track?._container || track?.MediaSources?.[0]?.Container || track?.Container || '').toLowerCase();
  return c.split(',')[0] || '';
}

function mimeOf(track) {
  return MIME_BY_CONTAINER[containerOf(track) || 'mp3'] || 'audio/mpeg';
}

function ticksToSeconds(ticks) {
  return ticks ? ticks / 10_000_000 : 0;
}

// What another client needs to render and re-materialise a queue entry.
// Whole Jellyfin items are several KB each; a 2000-track playlist would be
// megabytes per publish.
function slimTrack(t) {
  return {
    Id: t.Id, Name: t.Name, Artists: t.Artists, AlbumArtist: t.AlbumArtist, Album: t.Album,
    AlbumId: t.AlbumId, RunTimeTicks: t.RunTimeTicks,
    ArtistItems: (t.ArtistItems || []).map((a) => ({ Id: a.Id, Name: a.Name })),
    AlbumArtists: (t.AlbumArtists || []).map((a) => ({ Id: a.Id, Name: a.Name })),
    UserData: { IsFavorite: Boolean(t.UserData?.IsFavorite) },
    _queued: Boolean(t._queued),
  };
}

// Fetch full items for a list of ids, in order, in URL-safe batches.
async function fetchByIds(jf, ids) {
  return jf.itemsByIds(ids);
}

// Fisher-Yates, non-mutating.
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * One playback controller covering local audio, Google Cast and BluOS.
 *
 * Switching `device` mid-track is a handoff: position is captured from the
 * outgoing device, playback is stopped there, and the incoming device resumes
 * from the same offset. That is the "playing on this device" behaviour.
 */
export function usePlayer(jf) {
  const [device, setDeviceState] = useState(LOCAL_DEVICE);
  const [queue, setQueue] = useState([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  // Every start bumps this; a start that finishes after a newer one began is
  // ignored (its element load was already torn down by the newer src).
  const startGenRef = useRef(0);
  const lastSkipAtRef = useRef(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(80);
  // Spotify-style modes. repeat: 'off' | 'all' | 'one'. shuffle: 'off' | 'on' |
  // 'smart' (smart = keep going past the queue with similar songs).
  const [repeat, setRepeat] = useState('off');
  const [shuffle, setShuffle] = useState('off');
  const [error, setErrorRaw] = useState(null);
  // Browser noise is not a user-facing error: a play() that was cut short by
  // the next track (AbortError) or a load that superseded it just means the
  // user skipped quickly. Everything else shows in the toast.
  const setError = useCallback((msg) => {
    const text = msg == null ? null : String(msg);
    if (text && (/interrupted by a new load|AbortError|The operation was aborted|goo\.gl\/LdLk22/i.test(text))) return;
    setErrorRaw(text);
  }, []);
  // What a speaker reports playing when we did not start it ourselves (another
  // client, or this app on another machine). Lets a freshly opened window show
  // the house's current playback instead of claiming nothing is on.
  const [external, setExternal] = useState(null);
  const [contextId, setContextId] = useState(null);
  const contextRef = useRef(null);
  const [roster, setRoster] = useState({ players: [], lanDevices: [] });
  // Queues published by my other clients, keyed by clientId. The active
  // player's is what the queue panel shows while mirroring.
  const [remoteQueues, setRemoteQueues] = useState({});
  const remoteQueuesRef = useRef({});
  const relayRef = useRef(null);
  const pinnedRef = useRef(false); // user explicitly chose a device
  const adoptedRef = useRef(false);

  const audioRef = useRef(null);
  const localBaseRef = useRef(0); // track time at which the local element's stream starts (transcodes only)
  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    // The visualizer taps this element through a MediaElementSource, which is
    // silent for cross-origin media unless the element is CORS-enabled. The
    // stream origin (music.baxtergroup.io) answers with ACAO: *.
    audioRef.current.crossOrigin = 'anonymous';
  }
  // The element is routed through a Web Audio graph from the moment it is
  // created (element -> source -> destination), so the visualizer can tap the
  // source at any time without re-plumbing a playing element (that re-plumb
  // was the pop). A MediaElementSource follows the element across src
  // changes, unlike a captureStream(), whose stream went silent on the second
  // track. 'playback' latency = a comfortable buffer, no glitching. The
  // context is resumed on every local play (a suspended context is silent).
  const webAudioRef = useRef(null);
  const webAudio = useCallback(() => {
    if (webAudioRef.current) { webAudioRef.current.ctx.resume?.().catch(() => {}); return webAudioRef.current; }
    const el = audioRef.current; if (!el) return null;
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return null;
    const ctx = new Ctx({ latencyHint: 'playback' });
    const source = ctx.createMediaElementSource(el);
    source.connect(ctx.destination);
    webAudioRef.current = { ctx, source, onSource: () => () => {} };
    return webAudioRef.current;
  }, []);
  // Build it before anything plays.
  useEffect(() => { webAudio(); }, [webAudio]);

  // Mirrors of state that async callbacks and intervals need to read without
  // being re-created on every tick.
  const deviceRef = useRef(device);
  const positionRef = useRef(0);
  const durationRef = useRef(0);
  const queueRef = useRef([]);
  const indexRef = useRef(-1);
  // Last known remote position plus when we learned it, so the ticker can
  // interpolate instead of stepping once per poll.
  const anchorRef = useRef({ pos: 0, at: Date.now(), playing: false });
  // True while a handoff is in flight. The status poll re-subscribes to the new
  // device the instant `device` changes, which is BEFORE that device has been
  // told to play -- it then reports "not playing, position 0" and clobbers the
  // position we are trying to carry across. Ignore poll results while this is
  // set, and the handoff keeps its timestamp.
  const transitionRef = useRef(false);
  const notPlayingSinceRef = useRef(0); // first moment the speaker said not-playing while we believed it was
  // Counts consecutive polls that disagree with our interpolated clock. One
  // bad reading is a hiccup (a receiver reopening a stream reports secs=0 for a
  // beat); a few seconds of it means the device really did move and we should
  // believe it. Holds the time the disagreement started (0 = none).
  const disagreeRef = useRef(0);
  // The device claims to play but the playhead sits at 0. BluOS lands in
  // exactly this state if a stream is disturbed mid-setup: playing=true,
  // position frozen, silence. { since, restarted } while it lasts, else 0.
  const stalledRef = useRef(0);
  // Set while the user is dragging the volume slider, so the device poll does
  // not yank the handle back to the last value it reported.
  const volumeHeldRef = useRef(0);
  const playQueueRef = useRef(() => {});
  const toggleRef = useRef(() => {});
  const seekRef = useRef(() => {});
  const skipToRef = useRef(() => {});
  const yieldRef = useRef(() => {});
  const setVolumeRef = useRef(() => {});
  const previousRef = useRef(() => {});
  const setRepeatModeRef = useRef(() => {});
  const setShuffleModeRef = useRef(() => {});
  const activePlayerRef = useRef(null); // clientId of the active player, if not us
  const switchGenRef = useRef(0); // setDevice generation, see setDevice
  const wasMirroringRef = useRef(false); // this client has been mirroring another player since it last played itself
  const rosterRef = useRef({ players: [], lanDevices: [] });
  const repeatRef = useRef('off');
  const shuffleRef = useRef('off');
  // The queue in its original (unshuffled) order, so turning shuffle off can
  // restore it instead of leaving the tracks scrambled.
  const originalQueueRef = useRef([]);
  const advanceRef = useRef(() => {});
  // Which track (id) the current device actually has loaded. A queue restored
  // from the last run is shown paused with NOTHING loaded yet; the first play
  // must (re)start the stream at the saved position instead of resuming a
  // stream that does not exist.
  const loadedRef = useRef(null);
  const restoredRef = useRef(false);

  useEffect(() => { deviceRef.current = device; }, [device]);
  useEffect(() => { repeatRef.current = repeat; }, [repeat]);
  useEffect(() => { contextRef.current = contextId; }, [contextId]);
  useEffect(() => { shuffleRef.current = shuffle; }, [shuffle]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { indexRef.current = index; }, [index]);

  // Re-anchor whenever we knowingly move the playhead, so the interpolated
  // clock does not drift back to a stale value before the next poll.
  const anchorAt = useCallback((seconds, isPlaying = true) => {
    anchorRef.current = { pos: seconds, at: Date.now(), playing: isPlaying };
    setPosition(seconds);
  }, []);

  const current = index >= 0 ? queue[index] || null : null;
  const remote = typeof window !== 'undefined' ? window.conduit?.remote : null;

  const [relayInstance, setRelayInstance] = useState(null);
  const attachRelay = useCallback((relay) => { relayRef.current = relay; setRelayInstance(relay); }, []);
  // Display and control-routing follow the shared session (derived at render),
  // so this just stores the roster.
  const applyRoster = useCallback((r) => { rosterRef.current = r; setRoster(r); }, []);
  const applyRemoteQueue = useCallback((from, q) => {
    const next = { ...remoteQueuesRef.current, [from]: q || [] };
    remoteQueuesRef.current = next; setRemoteQueues(next);
  }, []);

  // The relay's memory of the account's last playback, sent when nobody is
  // actively playing (on connect, or when the active player just went away).
  // Adopt it, paused where it was, unless this client is mid-playback itself or
  // its own remembered playhead is newer. Whatever you left on any device is
  // what every device opens on; "Nothing playing" never happens.
  const applySession = useCallback((s) => {
    const np = s?.nowPlaying;
    if (!np?.itemId) return;
    if (queueRef.current.length && anchorRef.current.playing) return;
    // A client that was MIRRORING the session takes it over as-is when its
    // player vanishes (a reload of the playing browser): what it has locally
    // is whatever it played hours ago, not something to fall back to. Only a
    // client that was on its own queue weighs its saved playhead against it.
    if (!wasMirroringRef.current) {
      if (queueRef.current.length && loadedRef.current) return;
      const mine = (jf && jf.persisted('playhead')) || {};
      if (queueRef.current.length && (mine.at || 0) >= (s.at || 0)) return;
    }
    let q = Array.isArray(s.queue) && s.queue.length ? s.queue : [];
    let i = q.findIndex((t) => t?.Id === np.itemId);
    if (i < 0) {
      // No queue survived (or it does not contain the track): show the track alone.
      q = [{ Id: np.itemId, Name: np.title, Artists: np.artist ? [np.artist] : [], AlbumId: np.albumId || null,
             ArtistItems: np.artistId ? [{ Id: np.artistId, Name: np.artist }] : [], UserData: { IsFavorite: Boolean(np.liked) },
             RunTimeTicks: Math.round((np.duration || 0) * 10_000_000), _partial: true }];
      i = 0;
    }
    setQueue(q); queueRef.current = q;
    setIndex(i); indexRef.current = i;
    originalQueueRef.current = q;
    if (['off', 'all', 'one'].includes(np.repeat)) { repeatRef.current = np.repeat; setRepeat(np.repeat); }
    if (['off', 'on', 'smart'].includes(np.shuffle)) { shuffleRef.current = np.shuffle; setShuffle(np.shuffle); }
    const dur = np.duration || ticksToSeconds(q[i].RunTimeTicks);
    setDuration(dur);
    // The session was live when the relay last heard it; it is not playing
    // any more (its player is gone), so freeze the playhead where it got to.
    let pos = np.position || 0;
    if (np.playing && np.at) pos += (Math.min(Date.now(), (s.at || Date.now())) - np.at) / 1000;
    anchorAt(Math.max(0, Math.min(pos, dur || pos)), false);
    loadedRef.current = null;
    setPlaying(false);
    restoredRef.current = true;
  }, [jf, anchorAt]);

  // The speakers THIS client can drive itself (desktop mDNS list), so a
  // transfer command naming a device id can be resolved to a real device.
  const localDevicesRef = useRef([]);
  const registerDevices = useCallback((list) => { localDevicesRef.current = list || []; }, []);

  // Speakers another of my clients on this network can see, offered to a
  // browser (which cannot discover or drive them itself). Picking one asks
  // that client (viaClient) to play the session on it. The desktop already
  // lists its own speakers, so this is browser-only.
  // The server's own speakers (viaClient 'server:…') are offered everywhere,
  // the desktop included: the server drives them, so it needs no LAN reach.
  const lanDevices = (roster.lanDevices || [])
    .filter((d) => !remote || String(d.viaClient || '').startsWith('server:'))
    // A speaker this desktop can see itself is driven from here, not listed twice.
    .filter((d) => !remote || !localDevicesRef.current.some((x) => x.id === d.id))
    .filter((d, i, arr) => arr.findIndex((x) => x.id === d.id) === i)
    .map((d) => ({ id: d.id, kind: d.kind, name: d.name, model: d.kind === 'bluos' ? 'Bluesound' : 'Chromecast', viaClient: d.viaClient }));

  // Remote players from the relay, presented as selectable devices.
  const relayDevices = roster.players
    .filter((p) => p.canPlay)
    .map((p) => ({ id: `relay:${p.id}`, kind: 'relay', name: p.name, model: p.kind === 'desktop' ? 'Desktop' : 'Conduit', relayClientId: p.id }));

  const metaFor = useCallback(
    (track) => {
      // Album art first; the artist portrait is a fallback for tracks whose
      // album has none, which is most of this library until the retag lands.
      const artistId = track.ArtistItems?.[0]?.Id || track.AlbumArtists?.[0]?.Id || null;
      const art = jf?.imageUrl(track.AlbumId || track.Id, { maxHeight: 1000 });
      const artistArt = artistId ? jf?.imageUrl(artistId, { maxHeight: 1000 }) : null;
      return {
        title: track.Name || 'Unknown title',
        artist: track.Artists?.join(', ') || track.AlbumArtist || '',
        album: track.Album || '',
        artwork: art || artistArt || undefined,
        artworkFallback: artistArt || undefined,
        contentType: mimeOf(track),
      };
    },
    [jf]
  );

  // --- low-level per-transport operations ---------------------------------

  const startOn = useCallback(
    async (dev, track, seekSeconds = 0, gen = null) => {
      if (!jf || !track) return;
      if (dev.kind === 'local') {
        const el = audioRef.current;
        webAudioRef.current?.ctx.resume?.().catch(() => {});
        // A transcode starts at the wanted moment on the server; the element's
        // clock then runs from 0 and localBaseRef holds the offset.
        const transcoded = jf.transcoded?.();
        localBaseRef.current = transcoded ? Math.max(0, seekSeconds) : 0;
        el.src = jf.playbackUrl(track.Id, { startAt: transcoded ? seekSeconds : 0 });
        el.volume = volume / 100;
        if (seekSeconds > 0 && !transcoded) {
          // The seek has to land BEFORE play(), otherwise playback audibly
          // starts at zero and only then jumps, which reads as a reset. Jellyfin
          // serves the static stream with Accept-Ranges, so the element really
          // can seek; it just needs metadata first.
          await new Promise((resolve) => {
            let done = false;
            const settle = () => {
              if (done) return;
              done = true;
              try { el.currentTime = seekSeconds; } catch { /* not seekable yet */ }
              resolve();
            };
            if (el.readyState >= 1) settle();
            else el.addEventListener('loadedmetadata', settle, { once: true });
            // Never hang the handoff on a stream that will not report metadata.
            setTimeout(settle, 3000);
          });
        }
        await el.play();
      } else {
        // The list fetch skipped MediaSources; get the container now so Cast
        // gets the right MIME. One tiny request, cached.
        if (!containerOf(track) && jf.container) {
          try { track._container = await jf.container(track.Id); } catch { /* default */ }
        }
        // Play the static file with the offset handed to the transport. The
        // offset cannot go in the URL (Jellyfin's offset stream is chunked with
        // no Content-Length and BluOS refuses it), so each transport does what
        // its device can: Cast loads at currentTime; BluOS mutes, plays, seeks
        // and unmutes once the playhead is there -- either way nothing from
        // the head of the track is heard.
        const url = jf.streamUrl(track.Id);
        await remote.play(dev, url, metaFor(track), seekSeconds > 0 ? seekSeconds : 0);
      }
      if (gen != null && startGenRef.current !== gen) return; // superseded while loading
      loadedRef.current = track.Id;
      // A play counts after 8 s on the same track (the socket path applies
      // the same rule); a song skipped past never enters history.
      const id = track.Id;
      setTimeout(() => { if (loadedRef.current === id && playingRef.current) jf.reportStart(id); }, 8000);
    },
    [jf, metaFor, remote, volume]
  );

  const stopOn = useCallback(
    async (dev) => {
      if (!dev) return;
      loadedRef.current = null;
      if (dev.kind === 'local') {
        const el = audioRef.current;
        el.pause();
        el.removeAttribute('src');
        el.load();
        return;
      }
      // Acknowledging a stop is not the same as having stopped, so we verify.
      // But that verification must NEVER be awaited by the handoff: a device
      // that is slow or asleep can take seconds per status call, and blocking
      // on it froze the whole window. Issue the stop, then confirm in the
      // background under a hard deadline.
      await remote.stop(dev).catch(() => {});
      (async () => {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 400));
          const s = await remote.status(dev).catch(() => null);
          if (!s || !s.playing) return;
          await remote.stop(dev).catch(() => {});
        }
      })();
    },
    [remote]
  );

  // --- public controls ----------------------------------------------------

  const playQueue = useCallback(
    async (tracks, startIndex = 0, ctx = null, startAt = 0) => {
      // If another of my clients is the active player, change the song THERE.
      const act = activePlayerRef.current;
      if (act && relayRef.current) {
        relayRef.current.command(act, {
          action: 'play', trackIds: tracks.map((t) => t.Id), index: startIndex, ctx, startAt,
        });
        return; // display mirrors the active player; nothing to set locally
      }
      // No active remote session: play here and become the active player.
      if (relayRef.current) relayRef.current.claim();
      setError(null);
      setExternal(null);
      setContextId(ctx);
      // With shuffle on, keep the chosen track first and scramble the rest.
      originalQueueRef.current = tracks;
      let order = tracks;
      let start = startIndex;
      if (shuffleRef.current !== 'off' && tracks.length > 1) {
        const chosen = tracks[startIndex];
        order = [chosen, ...shuffled(tracks.filter((_, i) => i !== startIndex))];
        start = 0;
      }
      setQueue(order);
      setIndex(start);
      queueRef.current = order;
      indexRef.current = start;
      const track = order[start];
      setDuration(ticksToSeconds(track?.RunTimeTicks));
      // startAt: play from a moment inside the track (a lyric line you searched for).
      anchorAt(startAt > 0 ? startAt : 0, true);
      try {
        await startOn(deviceRef.current, track, startAt > 0 ? startAt : 0);
        setPlaying(true);
      } catch (e) {
        setError(e.message);
        setPlaying(false);
      }
    },
    [anchorAt, startOn]
  );

  // "Add to queue": append to the session's queue. Routed to the active player
  // while mirroring, like every other queue change. With nothing playing here
  // the tracks become the queue, shown paused.
  const addToQueue = useCallback((tracks) => {
    if (!tracks?.length) return;
    const act = activePlayerRef.current;
    if (act && relayRef.current) {
      relayRef.current.command(act, { action: 'enqueue', trackIds: tracks.map((t) => t.Id) });
      return;
    }
    const q = queueRef.current;
    if (!q.length) {
      setQueue(tracks); queueRef.current = tracks;
      setIndex(0); indexRef.current = 0;
      originalQueueRef.current = tracks;
      setDuration(ticksToSeconds(tracks[0]?.RunTimeTicks));
      anchorAt(0, false); setPlaying(false);
      return;
    }
    // Spotify puts "Add to queue" tracks right after what is playing (behind
    // anything already queued that way), ahead of the rest of the context.
    const i = indexRef.current;
    let at = i + 1;
    while (at < q.length && q[at]?._queued) at += 1;
    const flagged = tracks.map((t) => ({ ...t, _queued: true }));
    const next = [...q.slice(0, at), ...flagged, ...q.slice(at)];
    setQueue(next); queueRef.current = next;
    originalQueueRef.current = [...originalQueueRef.current, ...flagged];
  }, [anchorAt]);
  const addToQueueRef = useRef(addToQueue);
  useEffect(() => { addToQueueRef.current = addToQueue; }, [addToQueue]);

  // Queue editing from the panel. Both route to the active player while
  // mirroring, since the queue lives there.
  const removeFromQueue = useCallback((pos) => {
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'queueRemove', index: pos }); return; }
    const q = queueRef.current;
    if (pos < 0 || pos >= q.length || pos === indexRef.current) return;
    const next = q.filter((_, k) => k !== pos);
    setQueue(next); queueRef.current = next;
    if (pos < indexRef.current) { const ni = indexRef.current - 1; setIndex(ni); indexRef.current = ni; }
  }, []);
  const moveInQueue = useCallback((from, to) => {
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'queueMove', from, to }); return; }
    const q = [...queueRef.current];
    const cur = indexRef.current;
    if (from === to || from <= cur || to <= cur || from >= q.length || to >= q.length) return; // only the upcoming part moves
    const [it] = q.splice(from, 1); q.splice(to, 0, it);
    setQueue(q); queueRef.current = q;
  }, []);
  const clearQueued = useCallback(() => {
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'queueClear' }); return; }
    const q = queueRef.current, cur = indexRef.current;
    const next = q.filter((t, k) => k <= cur || !t._queued);
    setQueue(next); queueRef.current = next;
  }, []);
  const removeFromQueueRef = useRef(removeFromQueue), moveInQueueRef = useRef(moveInQueue), clearQueuedRef = useRef(clearQueued);
  useEffect(() => { removeFromQueueRef.current = removeFromQueue; moveInQueueRef.current = moveInQueue; clearQueuedRef.current = clearQueued; }, [removeFromQueue, moveInQueue, clearQueued]);

  const skipTo = useCallback(
    async (nextIndex) => {
      const act = activePlayerRef.current;
      if (act && relayRef.current) { relayRef.current.command(act, { action: 'skipTo', index: nextIndex }); return; }
      const q = queueRef.current;
      if (nextIndex < 0) nextIndex = 0; // "previous" on the first track restarts it
      if (nextIndex >= q.length) {
        // Ran out: park on the last track at 0:00, paused. The footer keeps
        // showing it (play restarts it) instead of going blank.
        await stopOn(deviceRef.current);
        setPlaying(false);
        const last = q.length - 1;
        setIndex(last); indexRef.current = last;
        anchorAt(0, false);
        return;
      }
      setIndex(nextIndex);
      indexRef.current = nextIndex;
      const track = q[nextIndex];
      setDuration(ticksToSeconds(track?.RunTimeTicks));
      anchorAt(0, true);
      const gen = ++startGenRef.current;
      // Hunting through the queue: the UI moves at once, but the load waits
      // until the taps stop (300 ms), so ten quick skips cost one start, not
      // ten transcodes and ten aborted streams.
      const now = Date.now();
      const rapid = now - lastSkipAtRef.current < 300;
      lastSkipAtRef.current = now;
      if (rapid) {
        await new Promise((r) => setTimeout(r, 300));
        if (startGenRef.current !== gen) return;
      }
      try {
        await startOn(deviceRef.current, track, 0, gen);
        if (startGenRef.current !== gen) return;
        setPlaying(true);
      } catch (e) {
        if (startGenRef.current === gen) setError(e.message);
      }
    },
    [anchorAt, startOn, stopOn]
  );

  // Smart shuffle: the queue ran out, so extend it with songs similar to the
  // current track (a Jellyfin instant mix) and keep playing. `orRestart` is
  // the fallback when nothing similar exists (a manual skip must still land
  // on a track); the default parks at the end.
  const smartNext = useCallback(async (orRestart = false) => {
    const cur = queueRef.current[indexRef.current];
    const giveUp = () => skipTo(orRestart ? 0 : queueRef.current.length);
    if (!cur || !jf) return giveUp();
    try {
      const have = new Set(queueRef.current.map((t) => t.Id));
      // Never a track the user excluded from their taste profile.
      const fresh = await jf.instantMix(cur.Id, 25);
      let pick = fresh.filter((t) => !have.has(t.Id));
      if (!pick.length) pick = fresh.filter((t) => t.Id !== cur.Id);
      if (!pick.length) return giveUp();
      const merged = [...queueRef.current, ...pick];
      setQueue(merged); queueRef.current = merged;
      await skipTo(indexRef.current + 1);
    } catch {
      await giveUp();
    }
  }, [jf, skipTo]);

  // Start the context over. With shuffle on, a fresh order (not the same
  // scramble again), never opening on the track that just played.
  const restart = useCallback(async () => {
    const q = queueRef.current;
    if (shuffleRef.current !== 'off' && q.length > 1) {
      const last = q[indexRef.current];
      const base = (originalQueueRef.current.length ? originalQueueRef.current : q).filter((t) => !t._queued);
      let order = shuffled(base);
      if (order.length > 1 && last && order[0].Id === last.Id) order = [...order.slice(1), order[0]];
      setQueue(order); queueRef.current = order;
    }
    return skipTo(0);
  }, [skipTo]);

  // Played from an artist page: more of that artist. Everything by them that
  // is not in the queue yet, shuffled; when that runs dry, an instant mix off
  // the artist; failing both, the queue starts over.
  const moreOfArtist = useCallback(async (artistId) => {
    if (!jf) return restart();
    try {
      const have = new Set(queueRef.current.map((t) => t.Id));
      let pick = shuffled((await jf.tracks({ artistId, limit: 500 })).items.filter((t) => !have.has(t.Id) && t.UserData?.Likes !== false));
      if (!pick.length) pick = (await jf.instantMix(artistId, 25)).filter((t) => !have.has(t.Id));
      if (!pick.length) return restart();
      const merged = [...queueRef.current, ...pick];
      setQueue(merged); queueRef.current = merged;
      originalQueueRef.current = [...originalQueueRef.current, ...pick];
      return skipTo(indexRef.current + 1);
    } catch {
      return restart();
    }
  }, [jf, skipTo, restart]);

  // Advance the queue. `auto` is true for a track that ended on its own (vs. a
  // manual skip). At the end of the queue, honour repeat / smart shuffle; a
  // MANUAL skip must always land on another track: a playlist or album starts
  // over (reshuffled if shuffle is on), an artist context plays more of the
  // artist, and a bare queue (a song clicked in search, a radio) continues
  // with similar songs.
  const advance = useCallback(async (auto = false) => {
    const q = queueRef.current;
    const i = indexRef.current;
    if (auto && repeatRef.current === 'one') return skipTo(i); // replay the track
    if (i + 1 < q.length) return skipTo(i + 1);
    // Nothing left.
    if (repeatRef.current === 'all') return restart();
    if (repeatRef.current === 'one') return skipTo(i);
    if (shuffleRef.current === 'smart') return smartNext(!auto);
    if (auto) return skipTo(q.length); // falls into the stop branch (parks on the last track)
    const ctx = contextRef.current;
    if (ctx && String(ctx).startsWith('artist:')) return moreOfArtist(String(ctx).slice(7));
    if (ctx) return restart();
    return smartNext(true);
  }, [skipTo, smartNext, restart, moreOfArtist]);
  useEffect(() => { advanceRef.current = advance; }, [advance]);

  // Both route to the active player while mirroring: the queue lives there.
  const next = useCallback(() => {
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'next' }); return; }
    advanceRef.current(false);
  }, []);
  const previous = useCallback(() => {
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'previous' }); return; }
    // Match the usual convention: restart the track unless we are near its start.
    if (positionRef.current > 3) {
      // Same track: rewind in place rather than reloading the stream.
      const el = audioRef.current;
      if (deviceRef.current.kind === 'local' && el && loadedRef.current === queueRef.current[indexRef.current]?.Id) { el.currentTime = 0; anchorAt(0, playingRef.current); return; }
      return skipTo(indexRef.current);
    }
    return skipTo(indexRef.current - 1);
  }, [skipTo, anchorAt]);

  const toggle = useCallback(async () => {
    const dev = deviceRef.current;
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'toggle' }); return; }
    if (!current && !external) return;
    try {
      // Nothing loaded on this device for the shown track (a queue restored
      // from the last run, or a device that was stopped): start it here at the
      // remembered playhead rather than resuming a stream that is not there.
      // (A speaker we switched to but never loaded -- a transfer whose fetch
      // failed -- counts too, whatever `playing` claims: resuming it would
      // poke a Cast media session that does not exist.)
      if (current && loadedRef.current !== current.Id && (!playing || dev.kind !== 'local')) {
        relayRef.current?.claim();
        await startOn(dev, current, positionRef.current);
        anchorAt(positionRef.current, true);
        setPlaying(true);
        return;
      }
      if (!playing) relayRef.current?.claim();
      if (dev.kind === 'local') {
        const el = audioRef.current;
        if (playing) el.pause();
        else { webAudioRef.current?.ctx.resume?.().catch(() => {}); await el.play(); }
      } else if (playing) {
        await remote.pause(dev);
      } else {
        await remote.resume(dev);
      }
      anchorAt(positionRef.current, !playing);
      setPlaying(!playing);
    } catch (e) {
      setError(e.message);
    }
  }, [anchorAt, current, external, playing, remote, startOn]);

  const seek = useCallback(
    async (seconds) => {
      const dev = deviceRef.current;
      const act = activePlayerRef.current;
      if (act && relayRef.current) { relayRef.current.command(act, { action: 'seek', pos: seconds }); return; }
      const track = queueRef.current[indexRef.current];
      // Scrubbing with nothing loaded used to fire /Play?seek= at a speaker that
      // had no stream, which is how a device ended up in a stalled state before
      // anything was even playing.
      if (!track) return;

      disagreeRef.current = 0;
      stalledRef.current = 0;
      anchorAt(seconds, true);

      if (dev.kind === 'local') {
        if (jf?.transcoded?.()) {
          // Cannot seek a transcode: restart it at the new spot (startOn sets
          // the base), keeping play/pause as it was.
          const el = audioRef.current; const wasPlaying = !el.paused;
          try { await startOn(dev, track, seconds); if (!wasPlaying) el.pause(); } catch (e) { setError(e.message); }
          return;
        }
        audioRef.current.currentTime = seconds;
        return;
      }

      try {
        await remote.seek(dev, seconds);
      } catch (e) {
        // Only rebuild the stream when the device genuinely cannot seek the one
        // it has. Re-playing on every hiccup restarted the track under the user
        // and could kill the stream outright.
        if (e.message?.includes('not seekable') || e.message?.includes('ENOSEEK')) {
          try {
            await startOn(dev, track, seconds);
            anchorAt(seconds, true);
            setPlaying(true);
          } catch (e2) {
            setError(e2.message);
          }
          return;
        }
        setError(e.message);
      }
    },
    [anchorAt, remote, startOn]
  );

  const setVolume = useCallback(
    async (level) => {
      const act = activePlayerRef.current;
      if (act && relayRef.current) { relayRef.current.command(act, { action: 'setVolume', level }); setVolumeState(level); return; }
      // Hold off the poll briefly so it cannot fight the drag.
      volumeHeldRef.current = Date.now() + 2000;
      setVolumeState(level);
      const dev = deviceRef.current;
      try {
        if (dev.kind === 'local') audioRef.current.volume = level / 100;
        else await remote.setVolume(dev, level);
      } catch {
        // Some receivers reject volume while idle; not worth surfacing.
      }
    },
    [remote]
  );

  // Re-order the queue for a shuffle change, keeping the current track playing.
  const applyShuffleOrder = useCallback((mode) => {
    const q = queueRef.current;
    const cur = q[indexRef.current] || null;
    if (mode !== 'off') {
      if (shuffleRef.current === 'off') originalQueueRef.current = q; // remember the real order
      if (cur && q.length > 1) {
        const order = [cur, ...shuffled(q.filter((t) => t.Id !== cur.Id))];
        setQueue(order); queueRef.current = order;
        setIndex(0); indexRef.current = 0;
      }
    } else {
      const orig = originalQueueRef.current.length ? originalQueueRef.current : q;
      const pos = cur ? Math.max(0, orig.findIndex((t) => t.Id === cur.Id)) : indexRef.current;
      setQueue(orig); queueRef.current = orig;
      setIndex(pos); indexRef.current = pos;
    }
  }, []);

  const setShuffleMode = useCallback((mode) => {
    applyShuffleOrder(mode); shuffleRef.current = mode; setShuffle(mode);
  }, [applyShuffleOrder]);
  const setRepeatMode = useCallback((mode) => { repeatRef.current = mode; setRepeat(mode); }, []);

  // Spotify-style cycling toggles. When another client owns the session, route
  // the change to it so the mode lives with the actual playback -- and base the
  // next mode on the mode currently SHOWN (mirrored from the active player), not
  // our stale local ref, or a controller would send the same value forever and
  // could never toggle back off.
  const activeMode = (field) => {
    const act = activePlayerRef.current;
    if (act) return (rosterRef.current.players || []).find((p) => p.id === act)?.nowPlaying?.[field] || 'off';
    return field === 'shuffle' ? shuffleRef.current : repeatRef.current;
  };
  const cycleShuffle = useCallback(() => {
    const nextMode = { off: 'on', on: 'smart', smart: 'off' }[activeMode('shuffle')] || 'on';
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'setShuffle', mode: nextMode }); return; }
    setShuffleMode(nextMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setShuffleMode]);
  // Direct set (the hero's shuffle toggle), routed like the cycles are.
  const setShuffleRouted = useCallback((mode) => {
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'setShuffle', mode }); return; }
    setShuffleMode(mode);
  }, [setShuffleMode]);
  const cycleRepeat = useCallback(() => {
    const nextMode = { off: 'all', all: 'one', one: 'off' }[activeMode('repeat')] || 'all';
    const act = activePlayerRef.current;
    if (act && relayRef.current) { relayRef.current.command(act, { action: 'setRepeat', mode: nextMode }); return; }
    setRepeatMode(nextMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setRepeatMode]);

  /**
   * On first load, find any speaker that is already playing and adopt it as the
   * active device, so opening the app anywhere shows where music is running.
   * Runs once, and never overrides a device the user has already chosen.
   */
  const adoptActive = useCallback(
    async (deviceList) => {
      // Do not latch before we can actually resolve a track. Devices are
      // discovered ~0.4s after launch, while restoring the Jellyfin session is
      // an async round trip, so `jf` is usually still null at that point.
      // Latching here meant adoption ran once, found a playing speaker, and
      // gave up on the lookup -- position and device were right, title and art
      // were empty.
      if (adoptedRef.current || !remote || !deviceList.length || !jf) return null;
      // Do NOT latch here. mDNS discovers speakers progressively, so the first
      // list is usually one device; latching on it meant we gave up before the
      // playing speaker had even been found. Only latch once we actually adopt,
      // or once this window starts its own playback.
      // A queue restored from the last run and still paused is not "our own
      // playback" -- a speaker that kept playing after the app closed wins.
      const ownPlayback = queueRef.current.length && (anchorRef.current.playing || loadedRef.current);
      if (ownPlayback) {
        adoptedRef.current = true;
        return null;
      }
      const checks = deviceList.map(async (d) => {
        const s = await remote.status(d).catch(() => null);
        return s && s.playing ? { d, s } : null;
      });
      const hit = (await Promise.all(checks)).find(Boolean);
      // No one is playing yet; stay unlatched so a later scan can still adopt.
      if (!hit) return null;
      // Re-check: the user may have hit play while we were polling the network.
      if (queueRef.current.length && (anchorRef.current.playing || loadedRef.current)) return null;
      adoptedRef.current = true;
      // Drop the restored paused queue: the house is playing something else.
      setQueue([]); setIndex(-1); queueRef.current = []; indexRef.current = -1;
      setDeviceState(hit.d);
      deviceRef.current = hit.d;
      setExternal({ title: hit.s.title, artist: hit.s.artist, album: hit.s.album });
      setDuration(hit.s.duration || 0);
      anchorAt(hit.s.position || 0, true);
      setPlaying(true);
      return hit.d;
    },
    [anchorAt, jf, remote]
  );

  /** Move playback to another device, preserving track and position. */
  const setDevice = useCallback( // eslint-disable-next-line react-hooks/exhaustive-deps
    async (nextDevice) => {
      const prev = deviceRef.current;

      // Picking another of my clients: hand the active session to it. The
      // target must BECOME the active player (claim), resume the CURRENT track
      // at the CURRENT position, and this client must stop + mirror. A plain
      // 'play' command would loop: the target still sees THIS client as active
      // and would route the command straight back, restarting the song here at
      // 0:00 (the exact bug this replaces).
      const viaRelay = nextDevice.kind === 'relay' || (nextDevice.viaClient && !remote);
      if (viaRelay && relayRef.current) {
        const act = activePlayerRef.current;
        // The WHOLE session queue moves with the track, so "next" on the
        // target keeps going where this client would have.
        let trackIds = [];
        let index = 0;
        let pos = 0;
        let wasPlaying = true;
        if (act) {
          // We are mirroring another session: hand off THAT session's queue.
          const np = (rosterRef.current.players || []).find((p) => p.id === act)?.nowPlaying;
          const rq = remoteQueuesRef.current[act] || [];
          if (np) {
            const qi = typeof np.queueIndex === 'number' && rq[np.queueIndex]?.Id === np.itemId ? np.queueIndex : -1;
            if (qi >= 0) { trackIds = rq.map((t) => t.Id); index = qi; }
            else if (np.itemId) { trackIds = [np.itemId]; index = 0; }
            pos = np.playing ? (np.position || 0) + (Date.now() - (np.at || Date.now())) / 1000 : (np.position || 0);
            wasPlaying = np.playing !== false;
          }
        } else {
          // We are the active player: hand off our own queue + playhead.
          const q = queueRef.current;
          const a = anchorRef.current;
          if (q[indexRef.current]) {
            trackIds = q.map((t) => t.Id);
            index = indexRef.current;
            pos = a.playing ? a.pos + (Date.now() - a.at) / 1000 : positionRef.current;
            wasPlaying = playing;
          }
        }
        // A speaker seen through another client: that client takes the
        // session and plays it on the named device.
        const target = nextDevice.kind === 'relay' ? nextDevice.relayClientId : nextDevice.viaClient;
        relayRef.current.command(target, {
          action: 'transfer', trackIds, index, position: pos, playing: wasPlaying,
          // Picking a client means ITS OWN output (Spotify: "This Computer"),
          // even if that client last drove a speaker; the speakers are listed
          // separately.
          deviceId: nextDevice.kind === 'relay' ? 'local' : nextDevice.id,
        });
        // Stop our own local playback right away so the two clients never overlap
        // while the target spins up. The target's claim also yields us as a
        // backstop, and the roster update then flips us into the mirror + green
        // bar.
        if (!act) {
          const dev = deviceRef.current;
          if (dev.kind === 'local') { const el = audioRef.current; if (el) el.pause(); }
          else if (dev.kind !== 'relay' && remote) remote.stop(dev).catch(() => {});
          setPlaying(false);
          anchorRef.current = { pos: positionRef.current, at: Date.now(), playing: false };
        }
        return;
      }

      // Transferring away from a remote active session onto THIS device (local
      // or a speaker): take over playback of that session's current track here.
      const act = activePlayerRef.current;
      if (act) {
        const np = (rosterRef.current.players || []).find((p) => p.id === act)?.nowPlaying;
        setDeviceState(nextDevice); deviceRef.current = nextDevice;
        // Become the active player immediately -- unconditionally, so taking
        // over never silently fails just because the track can't be resumed.
        relayRef.current?.claim();
        activePlayerRef.current = null;
        if (np?.itemId && jf) {
          try {
            const rq = remoteQueuesRef.current[act] || [];
            const qi = typeof np.queueIndex === 'number' && rq[np.queueIndex]?.Id === np.itemId ? np.queueIndex : -1;
            const ids = qi >= 0 ? rq.map((t) => t.Id) : [np.itemId];
            const tracks = await fetchByIds(jf, ids, 'MediaSources,ArtistItems,AlbumArtists,UserData');
            const at = qi >= 0 ? Math.max(0, tracks.findIndex((t) => t.Id === np.itemId)) : 0;
            const t = tracks[at];
            if (t) {
              setQueue(tracks); setIndex(at); queueRef.current = tracks; indexRef.current = at;
              setDuration(ticksToSeconds(t.RunTimeTicks));
              anchorAt(np.position || 0, true);
              await startOn(nextDevice, t, np.position || 0);
              setPlaying(true);
            }
          } catch (e) { setError(e.message); }
        }
        return;
      }

      if (prev.id === nextDevice.id) return;
      const track = queueRef.current[indexRef.current] || null;
      const wasPlaying = playing;

      // Read the position off the interpolated clock rather than React state,
      // which can be a render behind at the instant of the click.
      const a = anchorRef.current;
      const at = a.playing ? a.pos + (Date.now() - a.at) / 1000 : positionRef.current;
      const startedAt = Date.now();

      // Each switch gets a generation; a slow one (a Cast that never answers
      // takes 10 s to fail) must not undo a newer switch made meanwhile.
      const gen = (switchGenRef.current += 1);
      const stillMine = () => switchGenRef.current === gen;
      transitionRef.current = true;
      setDeviceState(nextDevice);
      deviceRef.current = nextDevice;
      setError(null);
      // Hold the carried timestamp on screen rather than snapping to zero while
      // the incoming device spins up.
      anchorAt(at, wasPlaying);

      try {
        // Start the new device FIRST and only then stop the old one, so the
        // music never drops out while the target spins up (a Node takes a few
        // seconds to fetch, seek and unmute). The brief overlap is the price.
        if (track && wasPlaying) {
          // The target is already playing this very track (a TV we lost track
          // of): adopt its playhead instead of restarting it from ours.
          let adopted = false;
          if (nextDevice.kind !== 'local' && remote) {
            try {
              const st = await remote.status(nextDevice);
              const sameTrack = st?.playing && st.streamUrl && st.streamUrl.includes(track.Id);
              if (sameTrack) { anchorAt(st.position || 0, true); adopted = true; }
            } catch { /* status is advisory */ }
          }
          if (!stillMine()) return;
          if (!adopted) await startOn(nextDevice, track, at);
          if (!stillMine()) return;
          if (!adopted) anchorAt(at, true);
          setPlaying(true);
          if (prev.id !== nextDevice.id) stopOn(prev).catch(() => {});
        } else {
          await stopOn(prev);
        }
      } catch (e) {
        if (!stillMine()) return;
        // The target failed: the old device is still playing, go back to it
        // with the playhead it has reached meanwhile.
        setDeviceState(prev); deviceRef.current = prev;
        setError(`Could not move playback to ${nextDevice.name}: ${e.message}`);
        if (wasPlaying) { anchorAt(at + (Date.now() - startedAt) / 1000, true); setPlaying(true); }
      } finally {
        // Show the incoming device's real volume rather than carrying the old
        // one across; they are independent hardware levels.
        if (nextDevice.kind !== 'local') {
          remote.status(nextDevice)
            .then((s) => { if (typeof s?.volume === 'number' && !s.muted && s.volume > 0) setVolumeState(s.volume); })
            .catch(() => {});
        } else {
          setVolumeState(Math.round((audioRef.current?.volume ?? 0.8) * 100));
        }
        // Let the receiver actually begin before trusting its status again.
        setTimeout(() => { transitionRef.current = false; }, 2500);
      }
    },
    [anchorAt, playing, startOn, stopOn]
  );

  // --- progress tracking --------------------------------------------------

  // Local playback drives position from the audio element itself.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return undefined;
    const onTime = () => {
      if (deviceRef.current.kind !== 'local') return;
      // During a handoff the element briefly reports 0 before the seek lands.
      // Writing that through would wipe the position we are carrying over.
      if (transitionRef.current) return;
      const pos = localBaseRef.current + el.currentTime;
      setPosition(pos);
      anchorRef.current = { pos, at: Date.now(), playing: !el.paused };
    };
    const onEnded = () => {
      if (deviceRef.current.kind === 'local') advanceRef.current(true);
    };
    const onDuration = () => {
      // A transcode's element duration is the REMAINDER from its start (or
      // unknown); the track's own length from Jellyfin stays authoritative.
      if (deviceRef.current.kind === 'local' && Number.isFinite(el.duration) && !localBaseRef.current && !jf?.transcoded?.()) {
        setDuration(el.duration);
      }
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnded);
    el.addEventListener('loadedmetadata', onDuration);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('loadedmetadata', onDuration);
    };
  }, [next]);

  // Remote devices have to be polled; they do not push state to us. Polling
  // alone makes the clock jump in 2s steps, so the poll only moves an anchor
  // and a local ticker interpolates between anchors for a smooth readout.
  useEffect(() => {
    if (device.kind === 'local' || !remote) return undefined;
    let cancelled = false;
    // One status reading from the device. `exact` = `arrivedAt` is the
    // moment the speaker's whole-second counter ticked over to `position`
    // (caught by the BluOS loop below), so the position is the true one at
    // that instant; otherwise it is a reading of unknown phase, and it only
    // moves the anchor when the anchor no longer agrees with it.
    const apply = (s, arrivedAt, exact) => {
      if (cancelled || !s || transitionRef.current) return;
      const a = anchorRef.current;
      // A rebuffer (Cast BUFFERING, BluOS "connecting") while we believe we
      // are playing is not a pause: the session used to flip to paused and
      // back on every one, and every mirror's playhead jumped with it (the
      // iPad "skipping around"). Hold playing through those, and through a
      // single not-playing reading of any kind; only a device that has said
      // not-playing for 1.5 s straight is really paused/stopped. The
      // end-of-track check below keeps the raw reading.
      const rawPlaying = !!s.playing;
      if (a.playing && !rawPlaying) {
        const transient = /BUFFERING|connecting/i.test(s.state || '');
        if (transient) { s = { ...s, playing: true }; notPlayingSinceRef.current = 0; }
        else {
          if (!notPlayingSinceRef.current) notPlayingSinceRef.current = arrivedAt;
          if (arrivedAt - notPlayingSinceRef.current < 1500) s = { ...s, playing: true, rawPosition: s.position || 0, position: a.pos + (arrivedAt - a.at) / 1000 };
        }
      } else notPlayingSinceRef.current = 0;
      const expected = a.playing ? a.pos + (Date.now() - a.at) / 1000 : a.pos;
      const reported = s.position || 0;

      // Track finished: advance the queue. Two signatures, because devices
      // disagree about what "finished" looks like:
      //   Cast:  playing=false with position sitting at the end.
      //   BluOS: playing=false with position reset to 0 -- indistinguishable
      //          from a stop unless we remember we were near the end.
      // Only look for end-of-track while we actually believe we're playing.
      // Crucially, clear the anchor's playing flag BEFORE advancing: skipping
      // that let a.playing stay true after the queue ended, so every later
      // poll re-fired "past the end" and stopped the device in a 2s loop.
      const dur = s.duration || durationRef.current;
      const rawReported = rawPlaying ? reported : (s.rawPosition ?? reported);
      const atEnd = a.playing && dur > 0
        && (rawReported >= dur - 1.5 || (rawReported === 0 && expected >= dur - 3));
      if (!rawPlaying && atEnd) {
        disagreeRef.current = 0;
        anchorRef.current = { pos: reported, at: Date.now(), playing: false };
        advanceRef.current(true);
        return;
      }

      // A receiver reopening a stream briefly reports 0 (or a big rewind)
      // while still claiming to play. Accepting that is what made the clock
      // flicker 0,1,0. Hold our own estimate until the device says the same
      // thing several polls running.
      // Both holds below are measured in TIME, not readings: the BluOS loop
      // polls five times a second while it hunts for the tick, and counting
      // readings there restarted a stream that merely took a second to start.
      const now = Date.now();
      const rewound = a.playing && reported < expected - 5;
      if (rewound) {
        if (!disagreeRef.current) disagreeRef.current = now;
        if (now - disagreeRef.current < 4000) { if (s.duration) setDuration(s.duration); return; }
      } else disagreeRef.current = 0;

      // A playing device whose position never advances is a dead stream, not
      // playback. Re-establish it once rather than showing a frozen 0.
      if (s.playing && reported === 0 && a.pos <= 0.5) {
        if (!stalledRef.current) stalledRef.current = { since: now, restarted: false };
        const st = stalledRef.current;
        if (now - st.since > 6000 && !st.restarted) {
          st.restarted = true;
          const track = queueRef.current[indexRef.current];
          if (track) {
            setError('Stream stalled on the speaker, restarting it');
            startOn(device, track, 0).catch(() => {});
          }
        }
        if (now - st.since < 12000) return;
      } else {
        stalledRef.current = 0;
      }

      // A whole-second clock reports the floor of the true position. While
      // our anchor is consistent with the reading (the true value lies in
      // [reported, reported+1), or within 0.3 s for a sub-second clock) leave
      // it alone: re-anchoring on every poll was what made the head jitter by
      // up to a second. Re-anchor only on an exact tick or a real disagreement.
      const agrees = a.playing && !!s.playing && (s.coarsePosition
        ? expected >= reported && expected < reported + 1
        : Math.abs(expected - reported) < 0.3);
      if (exact || !agrees) {
        const debiased = exact ? reported : (s.coarsePosition && s.playing ? reported + 0.5 : reported);
        anchorRef.current = { pos: debiased, at: arrivedAt, playing: !!s.playing };
      }
      if (s.duration) setDuration(s.duration);
      setPlaying(Boolean(s.playing));
      // The ticker only runs while playing; once it stops nothing else would
      // move the displayed position, so pin it to what the device reports.
      if (!s.playing) setPosition(anchorRef.current.pos);
      // Mirror the speaker's own volume, including changes made from the
      // BluOS app or a physical dial -- but never while the user is dragging.
      // A muted speaker (the resume dance mutes for a moment) must not drag
      // the slider to 0 and back.
      if (typeof s.volume === 'number' && !s.muted && Date.now() > volumeHeldRef.current) {
        setVolumeState((v) => (Math.abs(v - s.volume) > 1 ? s.volume : v));
      }

    };
    // BluOS only counts whole seconds, and its long-poll returns on state
    // changes, never on the tick (verified against the Node: 30 s timeouts
    // while playing). So catch the tick ourselves: poll fast until two
    // readings straddle a change of the counter -- the tick happened between
    // the first response and the second request, which pins the true
    // position to ~100 ms -- then drop to a 1 s check that only re-anchors
    // (and re-catches the tick) if the anchor has drifted out of agreement.
    let timer = null;
    if (device.kind === 'bluos') {
      (async () => {
        let prev = null;    // { secs, t1 } of the last reading while playing
        let locked = false; // the anchor sits on a caught tick
        let hunting = 0;    // when the fast polling started (0 = not hunting)
        while (!cancelled) {
          try {
            if (transitionRef.current) { prev = null; locked = false; hunting = 0; await new Promise((r) => setTimeout(r, 300)); continue; }
            const t0 = Date.now();
            const s = await remote.status(device);
            const t1 = Date.now();
            if (cancelled) return;
            if (!s.playing) { apply(s, (t0 + t1) / 2, false); prev = null; locked = false; hunting = 0; await new Promise((r) => setTimeout(r, 1000)); continue; }
            const a = anchorRef.current;
            const expected = a.playing ? a.pos + (t1 - a.at) / 1000 : a.pos;
            const agrees = a.playing && expected >= s.position && expected < s.position + 1;
            if (locked && !agrees) { locked = false; hunting = 0; }
            if (!locked && prev && s.position === prev.secs + 1 && t0 - prev.t1 < 600) {
              // The counter ticked between prev's response and this request.
              apply(s, (prev.t1 + t0) / 2, true);
              locked = true; hunting = 0;
            } else {
              apply(s, (t0 + t1) / 2, false);
            }
            prev = { secs: s.position, t1 };
            // Hunt for the tick at 250 ms, but not forever: a counter that is
            // not moving (start-up, a stall) gets the ordinary 1 s cadence.
            if (s.position === 0) hunting = 0; else if (!locked && !hunting) hunting = t1;
            const fast = !locked && s.position > 0 && t1 - hunting < 8000;
            await new Promise((r) => setTimeout(r, fast ? 250 : 1000));
          } catch {
            prev = null;
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      })();
    } else {
      timer = setInterval(async () => {
        try {
          if (transitionRef.current) return;
          const t0 = Date.now();
          const s = await remote.status(device);
          // Cast reports a sub-second position; it was true roughly mid-request.
          apply(s, (t0 + Date.now()) / 2, false);
        } catch {
          // Transient network blips are expected; keep polling.
        }
      }, 2000);
    }
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [device, next, remote, startOn]);

  // As soon as a track is playing, the next two are transcoded on the server
  // (one request) and the next one's playlist and first segments are pulled
  // into the browser cache, so a skip lands on a finished, half-loaded track.
  // Delayed a little so it never competes with this track's own first segments.
  useEffect(() => {
    if (device.kind !== 'local' || !playing || !jf || !current) return undefined;
    const t = setTimeout(() => {
      const q = queueRef.current, i = indexRef.current;
      const ahead = [q[i + 1], q[i + 2]].filter(Boolean).map((x) => x.Id);
      if (!ahead.length && repeatRef.current === 'all' && q[0]) ahead.push(q[0].Id);
      if (!ahead.length) return;
      jf.warm?.(ahead);
      jf.prewarm?.(ahead[0]);
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.kind, playing, current?.Id, jf]);

  // Interpolate the remote clock between polls so the seek bar moves smoothly.
  useEffect(() => {
    if (device.kind === 'local' || !playing) return undefined;
    const tick = setInterval(() => {
      const a = anchorRef.current;
      if (!a.playing) return;
      const next = a.pos + (Date.now() - a.at) / 1000;
      setPosition(durationRef.current ? Math.min(next, durationRef.current) : next);
    }, 200);
    return () => clearInterval(tick);
  }, [device, playing]);

  // --- remember what was playing across app restarts ---------------------

  // Restore the last run's queue, track, playhead and modes, shown PAUSED. The
  // player never opens on "Nothing playing": whatever you closed on is right
  // there to resume, like Spotify. Nothing is loaded on a device until play.
  useEffect(() => {
    if (!jf || restoredRef.current) return;
    restoredRef.current = true;
    if (queueRef.current.length) return; // something already started (e.g. a transfer)
    const saved = jf.persisted('playback');
    if (!saved || !Array.isArray(saved.queue) || !saved.queue.length) {
      // Fresh install: nothing remembered here. Jellyfin still knows the last
      // track this account played; show that, paused at the start. A relay
      // session (newer, with a real playhead) replaces it when it arrives.
      jf.lastPlayedTrack().then((t) => {
        if (!t || queueRef.current.length) return;
        setQueue([t]); queueRef.current = [t];
        setIndex(0); indexRef.current = 0;
        originalQueueRef.current = [t];
        setDuration(ticksToSeconds(t.RunTimeTicks));
        anchorAt(0, false);
        setPlaying(false);
      }).catch(() => {});
      return;
    }
    const head = jf.persisted('playhead') || {};
    // Prefer the track id over the index: a fallback save may have kept only
    // the current track, in which case the index no longer applies.
    let i = saved.queue.findIndex((t) => t?.Id === head.trackId);
    if (i < 0) i = Math.min(Math.max(0, head.index | 0), saved.queue.length - 1);
    const track = saved.queue[i];
    if (!track?.Id) return;
    setQueue(saved.queue); queueRef.current = saved.queue;
    setIndex(i); indexRef.current = i;
    originalQueueRef.current = Array.isArray(saved.original) && saved.original.length ? saved.original : saved.queue;
    setContextId(saved.contextId || null);
    const rep = ['off', 'all', 'one'].includes(head.repeat) ? head.repeat : 'off';
    const shf = ['off', 'on', 'smart'].includes(head.shuffle) ? head.shuffle : 'off';
    repeatRef.current = rep; setRepeat(rep);
    shuffleRef.current = shf; setShuffle(shf);
    const dur = ticksToSeconds(track.RunTimeTicks);
    setDuration(dur);
    const pos = Number.isFinite(head.position) ? Math.max(0, Math.min(head.position, dur || head.position)) : 0;
    anchorAt(pos, false);
    setPlaying(false);
  }, [jf, anchorAt]);

  // Two keys: the queue (big, written only when it changes) and the playhead
  // (tiny, written on a slow tick, on pause and on close). Stringifying a
  // 2000-track playlist every few seconds is not free, so it is not done.
  const saveQueue = useCallback(() => {
    if (!jf) return;
    const q = queueRef.current;
    const i = indexRef.current;
    if (!q.length || i < 0 || !q[i]) return;
    const key = `${jf._lsPrefix}playback`;
    const write = (queue, original) => {
      localStorage.setItem(key, JSON.stringify({ queue, original, contextId }));
    };
    try {
      write(q, shuffleRef.current !== 'off' ? originalQueueRef.current : []);
    } catch {
      // Too big for localStorage: keep at least the current track.
      try { write([q[i]], []); } catch { /* private mode / no storage */ }
    }
  }, [jf, contextId]);
  const savePlayhead = useCallback(() => {
    if (!jf) return;
    const q = queueRef.current;
    const i = indexRef.current;
    if (!q.length || i < 0 || !q[i]) return;
    const a = anchorRef.current;
    const pos = a.playing ? a.pos + (Date.now() - a.at) / 1000 : positionRef.current;
    try {
      localStorage.setItem(`${jf._lsPrefix}playhead`, JSON.stringify({
        trackId: q[i].Id, index: i, position: Math.max(0, pos),
        repeat: repeatRef.current, shuffle: shuffleRef.current, at: Date.now(),
      }));
    } catch { /* ignore */ }
  }, [jf]);
  const saveQueueRef = useRef(saveQueue);
  const savePlayheadRef = useRef(savePlayhead);
  useEffect(() => { saveQueueRef.current = saveQueue; }, [saveQueue]);
  useEffect(() => { savePlayheadRef.current = savePlayhead; }, [savePlayhead]);

  // The queue itself, not the position in it (that is the playhead's job):
  // serialising the whole queue on every track change was work at the tap.
  useEffect(() => {
    if (!jf || !queue.length) return;
    saveQueueRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jf, queue, contextId, shuffle]);

  useEffect(() => {
    if (!jf || !current) return;
    savePlayheadRef.current();
  }, [jf, current, index, repeat, shuffle, playing]);

  useEffect(() => {
    if (!jf || !current || !playing) return undefined;
    const t = setInterval(() => savePlayheadRef.current(), 5000);
    return () => clearInterval(t);
  }, [jf, current, playing]);

  useEffect(() => {
    const flush = () => savePlayheadRef.current();
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, []);

  // Report progress back to Jellyfin so play counts and resume work.
  useEffect(() => {
    if (!jf || !current) return undefined;
    const timer = setInterval(() => {
      jf.reportProgress(current.Id, positionRef.current, !playing);
    }, 10000);
    return () => clearInterval(timer);
  }, [jf, current, playing]);

  // The active session lives on another of my clients: mirror it. This is
  // independent of my local `device` -- whichever client is playing account-
  // wide, every other client shows and controls THAT. Song and playhead always
  // describe the same real playback.
  const myClientId = relayInstance?.id;
  const activePlayer = roster.activeClientId && roster.activeClientId !== myClientId
    ? (roster.players || []).find((p) => p.id === roster.activeClientId)
    : null;
  const relayTarget = activePlayer?.nowPlaying || null;
  const relayTargetId = activePlayer?.id || null;

  // Either the mirrored active session, our own queue item, or an adopted speaker.
  // A mirrored track's art is resolved by ID through THIS client's own server
  // base URL + token. The active player's ready-made artUrl is only a fallback:
  // it is built for ITS origin (the browser's own origin, or the
  // desktop's LAN address) and does not load from the other runtime -- that
  // was the missing cover on the desktop while a web player was the master.
  const nowPlaying = activePlayer
    ? (relayTarget ? {
        title: relayTarget.title,
        artist: relayTarget.artist,
        artId: relayTarget.albumId || relayTarget.itemId || null,
        artUrl: relayTarget.artUrl || null,
        albumId: relayTarget.albumId || null,
        artistId: relayTarget.artistId || null,
        artists: relayTarget.artists || null,
        itemId: relayTarget.itemId || null,
        liked: Boolean(relayTarget.liked),
        device: relayTarget.device || null,
      } : null)
    : current
    ? {
        title: current.Name,
        artist: current.Artists?.join(', ') || current.AlbumArtist || '',
        artId: current.AlbumId || current.Id,
        itemId: current.Id,
        liked: Boolean(current.UserData?.IsFavorite),
        device: { id: device.id, kind: device.kind, name: device.name },
        albumId: current.AlbumId || null,
        // ArtistItems carries the real artist entity; AlbumArtists is the
        // fallback for tracks credited only at album level.
        artistId: current.ArtistItems?.[0]?.Id || current.AlbumArtists?.[0]?.Id || null,
        artists: (current.ArtistItems?.length ? current.ArtistItems : current.AlbumArtists || []).map((a) => ({ Id: a.Id, Name: a.Name })),
      }
    : external
    ? { title: external.title, artist: external.artist || '', artId: null }
    : null;

  // The Jellyfin item id of whatever is playing session-wide, so views like
  // lyrics work on a mirroring client (where `current` is null) too.
  const nowPlayingId = relayTarget?.itemId || current?.Id || null;

  // Take over as the active player and resume a handed-off track locally at the
  // given position. Bypasses playQueue's active-player routing on purpose: when
  // a transfer arrives, THIS client is not yet the active player (the sender
  // still is), so playQueue would route the command straight back. We claim
  // first, then play here directly.
  const startHere = useCallback(async (tracks, startIndex, position, shouldPlay) => {
    relayRef.current?.claim();
    activePlayerRef.current = null;
    setError(null);
    setExternal(null);
    setContextId(null);
    setQueue(tracks);
    setIndex(startIndex);
    queueRef.current = tracks;
    indexRef.current = startIndex;
    const track = tracks[startIndex];
    setDuration(ticksToSeconds(track?.RunTimeTicks));
    anchorAt(position, shouldPlay);
    try {
      if (shouldPlay) {
        await startOn(deviceRef.current, track, position);
        setPlaying(true);
      }
    } catch (e) {
      setError(e.message);
      setPlaying(false);
    }
  }, [anchorAt, startOn]);
  const startHereRef = useRef(startHere);
  useEffect(() => { startHereRef.current = startHere; }, [startHere]);

  // Run a command another client routed to us.
  const executeCommand = useCallback(async (cmd) => {
    if (!cmd) return;
    // Breadcrumb in the device trace: what another client asked of us.
    window.conduit?.debug?.(`command ${cmd.action} tracks=${cmd.trackIds?.length ?? '-'} index=${cmd.index ?? '-'} pos=${cmd.position != null ? Math.round(cmd.position) : '-'} playing=${cmd.playing ?? '-'} device=${cmd.deviceId || '-'} current=${deviceRef.current?.name || '-'}`);
    if (cmd.action === 'transfer' && jf) {
      // Another client handed the active session to us. Claim immediately so we
      // stop routing controls away, then resume the track at its playhead.
      relayRef.current?.claim();
      activePlayerRef.current = null;
      // A browser picked one of OUR speakers: play there instead of locally.
      // Stop whatever this client was driving so two outputs never overlap.
      if (cmd.deviceId) {
        const dev = cmd.deviceId === 'local' ? LOCAL_DEVICE : localDevicesRef.current.find((d) => d.id === cmd.deviceId);
        if (dev && dev.id !== deviceRef.current.id) {
          await stopOn(deviceRef.current).catch(() => {});
          setDeviceState(dev); deviceRef.current = dev; pinnedRef.current = true;
        }
      }
      if (Array.isArray(cmd.trackIds) && cmd.trackIds.length) {
        // Start the handed-over song from ITS record alone and fill the queue
        // in behind it: fetching the whole queue first (50 tracks with
        // MediaSources from a slow Jellyfin) failed or stalled, and the old
        // silent catch left the speaker switched to but never loaded -- every
        // control after that hit a Cast session that did not exist.
        const fields = 'MediaSources,ArtistItems,AlbumArtists,UserData';
        const idx = Math.min(cmd.index || 0, cmd.trackIds.length - 1);
        const chosenId = cmd.trackIds[idx];
        try {
          const rest = cmd.trackIds.length > 1 ? fetchByIds(jf, cmd.trackIds, fields).catch(() => null) : null;
          const [first] = await fetchByIds(jf, [chosenId], fields);
          if (!first) throw new Error('track not found');
          await startHereRef.current([first], 0, cmd.position || 0, cmd.playing !== false);
          const tracks = rest ? await rest : null;
          if (!tracks || !tracks.length || queueRef.current[indexRef.current]?.Id !== chosenId) return;
          const at = Math.max(0, tracks.findIndex((t) => t.Id === chosenId));
          setQueue(tracks); queueRef.current = tracks;
          setIndex(at); indexRef.current = at;
        } catch (e) { window.conduit?.debug?.(`transfer FAILED: ${e.message}`); setError(`Could not take over playback: ${e.message}`); setPlaying(false); }
      } else {
        window.conduit?.debug?.('transfer carried no tracks: nothing to start');
      }
    } else if (cmd.action === 'play' && jf && Array.isArray(cmd.trackIds) && cmd.trackIds.length) {
      // Start the chosen song the moment ITS record is here; the rest of the
      // queue (often 20-50 tracks with full fields) arrives behind it and is
      // swapped in around the playing track. Waiting for the whole list first
      // cost about a second between the click on the phone and the sound.
      const fields = 'ArtistItems,AlbumArtists,UserData';
      const idx = Math.min(cmd.index || 0, cmd.trackIds.length - 1);
      const chosenId = cmd.trackIds[idx];
      try {
        const rest = cmd.trackIds.length > 1 ? fetchByIds(jf, cmd.trackIds, fields) : null;
        const [first] = await fetchByIds(jf, [chosenId], fields);
        if (!first) return;
        await playQueueRef.current([first], 0, cmd.ctx || null, cmd.startAt || 0);
        if (!rest) return;
        const tracks = await rest;
        // Still on that song? Then fill the queue in around it, respecting shuffle.
        if (queueRef.current[indexRef.current]?.Id !== chosenId || !tracks.length) return;
        const at = Math.max(0, tracks.findIndex((t) => t.Id === chosenId));
        let order = tracks, start = at;
        if (shuffleRef.current !== 'off' && tracks.length > 1) { order = [tracks[at], ...shuffled(tracks.filter((_, i) => i !== at))]; start = 0; }
        originalQueueRef.current = tracks;
        setQueue(order); queueRef.current = order;
        setIndex(start); indexRef.current = start;
      } catch { /* ignore */ }
    } else if (cmd.action === 'enqueue' && jf && Array.isArray(cmd.trackIds) && cmd.trackIds.length) {
      (async () => {
        const tracks = await fetchByIds(jf, cmd.trackIds, 'ArtistItems,AlbumArtists,UserData');
        if (tracks.length) addToQueueRef.current(tracks);
      })().catch(() => {});
    } else if (cmd.action === 'queueRemove') { removeFromQueueRef.current(cmd.index | 0); }
    else if (cmd.action === 'queueMove') { moveInQueueRef.current(cmd.from | 0, cmd.to | 0); }
    else if (cmd.action === 'queueClear') { clearQueuedRef.current(); }
    else if (cmd.action === 'skipTo') { skipToRef.current(cmd.index | 0); }
    else if (cmd.action === 'toggle') { toggleRef.current(); }
    else if (cmd.action === 'seek') { seekRef.current(cmd.pos || 0); }
    else if (cmd.action === 'setVolume') { setVolumeRef.current(cmd.level ?? 100); }
    else if (cmd.action === 'next') { advanceRef.current(false); }
    else if (cmd.action === 'previous') { previousRef.current(); }
    else if (cmd.action === 'setRepeat') { setRepeatModeRef.current(cmd.mode || 'off'); }
    else if (cmd.action === 'setShuffle') { setShuffleModeRef.current(cmd.mode || 'off'); }
    else if (cmd.action === 'yield') { yieldRef.current(); }
    else if (cmd.action === 'patchLiked' && cmd.itemId) {
      // A controller liked/unliked the session track: update our queue so the
      // next now-playing broadcast carries the new heart to every mirror.
      const liked = Boolean(cmd.liked);
      setQueue((q) => {
        const n = q.map((t) => (t.Id === cmd.itemId ? { ...t, UserData: { ...(t.UserData || {}), IsFavorite: liked } } : t));
        queueRef.current = n; return n;
      });
    }
  }, [jf, stopOn]);

  const patchQueue = useCallback((fn) => {
    setQueue((q) => { const n = q.map(fn); queueRef.current = n; return n; });
  }, []);

  // Liked state changed here: if another client owns the session, tell it, so
  // its queue (the source of the mirrored heart) agrees with what we just did.
  const syncLiked = useCallback((itemId, liked) => {
    const act = activePlayerRef.current;
    if (act && relayRef.current) relayRef.current.command(act, { action: 'patchLiked', itemId, liked });
  }, []);

  // Stop local audio and remote-device playback because another client took over.
  yieldRef.current = () => {
    const dev = deviceRef.current;
    if (dev.kind === 'local') { const el = audioRef.current; if (el) el.pause(); }
    else if (dev.kind !== 'relay' && remote) remote.pause(dev).catch(() => {});
    setPlaying(false);
    anchorRef.current = { pos: positionRef.current, at: Date.now(), playing: false };
  };
  useEffect(() => { playQueueRef.current = playQueue; }, [playQueue]);
  useEffect(() => { toggleRef.current = toggle; }, [toggle]);
  useEffect(() => { seekRef.current = seek; }, [seek]);
  useEffect(() => { skipToRef.current = skipTo; }, [skipTo]);
  useEffect(() => { setVolumeRef.current = setVolume; }, [setVolume]);
  useEffect(() => { previousRef.current = previous; }, [previous]);
  useEffect(() => { setRepeatModeRef.current = setRepeatMode; }, [setRepeatMode]);
  useEffect(() => { setShuffleModeRef.current = setShuffleMode; }, [setShuffleMode]);
  useEffect(() => { activePlayerRef.current = relayTargetId; if (relayTargetId) wasMirroringRef.current = true; }, [relayTargetId]);
  // Cleared once this client plays something itself (playQueue / take-over).
  useEffect(() => { if (playing && !activePlayerRef.current) wasMirroringRef.current = false; }, [playing]);

  // Broadcast what we're playing so the roster shows it on other clients. The
  // song AND the playhead go together, so a controller never shows a different
  // track from the position it displays.
  useEffect(() => {
    const r = relayRef.current;
    if (!r) return;
    // Do not report while mirroring someone else's session -- only the active
    // player reports its state (title, playhead, volume) for everyone to sync to.
    if (relayTarget) return;
    r.reportNowPlaying(current ? {
      itemId: current.Id,
      title: current.Name,
      artist: current.Artists?.join(', ') || current.AlbumArtist || '',
      album: current.Album || null,
      artUrl: jf ? jf.imageUrl(current.AlbumId || current.Id, { maxHeight: 128 }) : null,
      albumId: current.AlbumId || null,
      artistId: current.ArtistItems?.[0]?.Id || current.AlbumArtists?.[0]?.Id || null,
      artists: (current.ArtistItems?.length ? current.ArtistItems : current.AlbumArtists || []).map((a) => ({ Id: a.Id, Name: a.Name })),
      liked: Boolean(current.UserData?.IsFavorite),
      // Where the sound actually comes out, so every client can say "Playing
      // on Node" when the session is on a speaker rather than on a client.
      device: { id: device.id, kind: device.kind, name: device.name },
      queueIndex: index,
      playing, position, duration, volume, repeat, shuffle, at: Date.now(),
    } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, index, playing, Math.floor(position), duration, volume, repeat, shuffle, relayTarget, device]);

  // Publish the queue itself (not the index; that rides on now-playing) when
  // its identity changes. Debounced: a like re-creates the array, a shuffle
  // re-orders it, and each would otherwise ship the whole list at once.
  useEffect(() => {
    const r = relayRef.current;
    if (!r || relayTarget) return undefined;
    const t = setTimeout(() => r.reportQueue(queue.map(slimTrack)), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, relayTarget, relayInstance]);

  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!relayTarget?.playing) return undefined;
    const t = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [relayTarget?.playing]);

  // Interpolate the active player's playhead so the mirrored bar moves smoothly.
  const shownPosition = relayTarget
    ? (relayTarget.playing ? (relayTarget.position || 0) + (Date.now() - (relayTarget.at || Date.now())) / 1000 : (relayTarget.position || 0))
    : position;
  const shownDuration = relayTarget ? (relayTarget.duration || 0) : duration;
  const shownPlaying = relayTarget ? Boolean(relayTarget.playing) : playing;
  const shownVolume = relayTarget && typeof relayTarget.volume === 'number' ? relayTarget.volume : volume;
  const shownRepeat = relayTarget ? (relayTarget.repeat || 'off') : repeat;
  const shownShuffle = relayTarget ? (relayTarget.shuffle || 'off') : shuffle;

  // Media Session: the lock screen / Control Center / AirPods controls on the
  // phone (installed web app) and the desktop's media keys / Now Playing.
  // Shown for whatever the SESSION is playing: this device's own track, or the
  // one playing on another client or a speaker driven from here (then a silent
  // keep-alive element stands in for the media the OS wants to see). The
  // handlers route through the same functions the buttons use, which reach
  // the active player. Position state is pushed on each position change so
  // the lock-screen scrubber tracks the song.
  const msLocal = !relayTarget && device?.kind === 'local' && !!current;
  const msRemote = !msLocal && !!nowPlaying;
  const msRefs = useRef({}); msRefs.current = { toggle, next, previous, seek };
  // Lock screen / headset buttons: previous and next TRACK, never 10-second
  // skips (with seekbackward/seekforward set, iOS replaces the track buttons
  // with skips and greys them out).
  const msActions = () => {
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
    if (!ms) return;
    const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* action unsupported */ } };
    on('play', () => msRefs.current.toggle());
    on('pause', () => msRefs.current.toggle());
    on('previoustrack', () => msRefs.current.previous());
    on('nexttrack', () => msRefs.current.next());
    on('seekto', (d) => { if (typeof d?.seekTime === 'number') msRefs.current.seek(d.seekTime); });
    on('seekbackward', null); on('seekforward', null);
  };
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
    if (!ms) return undefined;
    if ((!msLocal && !msRemote) || !nowPlaying) { try { ms.metadata = null; ms.playbackState = 'none'; } catch { /* unsupported */ } return undefined; }
    const artwork = [];
    // One size: iOS fetches every listed artwork at once, on the same link as the first segments.
    if (jf && nowPlaying.artId) artwork.push({ src: jf.imageUrl(nowPlaying.artId, { maxHeight: 512 }), sizes: '512x512', type: 'image/jpeg' });
    else if (nowPlaying.artUrl) artwork.push({ src: nowPlaying.artUrl, sizes: '512x512', type: 'image/jpeg' });
    else if (jf && nowPlaying.artistId) artwork.push({ src: jf.imageUrl(nowPlaying.artistId, { maxHeight: 512 }), sizes: '512x512', type: 'image/jpeg' });
    try {
      ms.metadata = new window.MediaMetadata({
        title: nowPlaying.title || 'Unknown title',
        artist: nowPlaying.artist || '',
        album: relayTarget?.album || current?.Album || '',
        artwork,
      });
    } catch { /* MediaMetadata unsupported */ }
    msActions();
    return () => { for (const a of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto']) { try { ms.setActionHandler(a, null); } catch { /* unsupported */ } } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowPlaying?.itemId, nowPlaying?.title, nowPlaying?.artId, msLocal, msRemote, jf]);
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession;
    // The keep-alive only stands in while the sound is elsewhere; this
    // device's own playback carries the session by itself.
    keepAlive(msRemote && shownPlaying, shownPosition);
    if (!ms || (!msLocal && !msRemote)) return;
    try { ms.playbackState = shownPlaying ? 'playing' : 'paused'; } catch { /* unsupported */ }
    // iOS reads the action handlers when the media starts or stops: set
    // before the keep-alive element played, they were sometimes ignored and
    // the lock screen showed 10-second skips instead of previous / next.
    msActions();
    if (shownDuration > 0 && typeof ms.setPositionState === 'function') {
      try { ms.setPositionState({ duration: shownDuration, playbackRate: 1, position: Math.min(Math.max(0, shownPosition || 0), shownDuration) }); } catch { /* invalid state */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownPlaying, Math.floor(shownPosition || 0), shownDuration, nowPlaying?.itemId, msLocal, msRemote]);
  // The session's queue: the active player's published one while mirroring.
  // Its index only counts when it points at the track that is actually
  // playing (the queue and now-playing arrive as separate messages).
  const remoteQueue = relayTarget ? (remoteQueues[relayTargetId] || []) : null;
  const shownQueue = remoteQueue || queue;
  const shownIndex = relayTarget
    ? (typeof relayTarget.queueIndex === 'number' && remoteQueue[relayTarget.queueIndex]?.Id === relayTarget.itemId
        ? relayTarget.queueIndex
        : remoteQueue.findIndex((t) => t.Id === relayTarget.itemId))
    : index;

  return useMemo(
    () => ({
      device, setDevice, adoptActive, nowPlaying, nowPlayingId, external, patchQueue, syncLiked, contextId, addToQueue, removeFromQueue, moveInQueue, clearQueued, webAudio,
      relayDevices, lanDevices, registerDevices, attachRelay, applyRoster, executeCommand, roster, relay: relayInstance,
      queue: shownQueue, index: shownIndex, current, applyRemoteQueue, applySession, mirroring: !!relayTarget,
      playing: shownPlaying, position: shownPosition, duration: shownDuration, volume: shownVolume, error,
      repeat: shownRepeat, shuffle: shownShuffle, cycleRepeat, cycleShuffle, setShuffle: setShuffleRouted,
      playQueue, toggle, next, previous, seek, setVolume, skipTo,
      clearError: () => setError(null),
    }),
    // eslint-disable-next-line
    [device, setDevice, adoptActive, nowPlaying, nowPlayingId, external, patchQueue, syncLiked, contextId, addToQueue, removeFromQueue, moveInQueue, clearQueued, webAudio,
     relayDevices, lanDevices, registerDevices, attachRelay, applyRoster, executeCommand, roster, relayInstance, shownQueue, shownIndex, current, applyRemoteQueue, applySession, relayTarget,
     shownPlaying, shownPosition, shownDuration, shownVolume, error, shownRepeat, shownShuffle,
     cycleRepeat, cycleShuffle, setShuffleRouted, playQueue, toggle, next,
     previous, seek, setVolume, skipTo]
  );
}
