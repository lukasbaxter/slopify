import { useEffect, useRef, useState } from 'react';

// The playhead for things that DISPLAY it (seek bars, time labels): a value
// that moves every `every` ms while playing, re-rendering only the component
// that asked. The player keeps the real clock in refs (positionNow); its
// React `position` is a coarse copy that changes every few seconds, so a
// whole-app re-render never lands between visualizer frames.
export function usePlayhead(player, every = 250) {
  const read = () => (player.positionNow ? player.positionNow() : player.position || 0);
  const [pos, setPos] = useState(read);
  const playing = !!player.playing;
  const coarse = player.position || 0;
  const track = player.nowPlaying?.itemId || null;
  useEffect(() => {
    setPos(read());
    if (!playing) return undefined;
    const t = setInterval(() => setPos(read()), every);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, coarse, track, every]);
  return pos;
}

// The seek bar itself, moved on every frame while a song plays: its fill and
// thumb are set straight on the element, so the bar glides instead of
// stepping (it used to move once a second, in whole seconds) and nothing
// re-renders for it. `held`: someone is dragging it, or it is not playing;
// React's own value stands then.
export function useSmoothSeek(ref, player, duration, held) {
  const live = useRef(player);
  live.current = player;
  const playing = !!player.playing;
  const track = player.nowPlaying?.itemId || null;
  useEffect(() => {
    const el = ref.current;
    if (!el || held || !playing || !(duration > 0)) return undefined;
    let raf = 0;
    const frame = () => {
      const p = live.current;
      const pos = Math.max(0, Math.min(p.positionNow ? p.positionNow() : p.position || 0, duration));
      el.style.setProperty('--pct', `${(pos / duration) * 100}%`);
      el.value = String(pos);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [ref, playing, duration, held, track]);
}
