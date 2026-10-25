import { useEffect, useState } from 'react';

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
