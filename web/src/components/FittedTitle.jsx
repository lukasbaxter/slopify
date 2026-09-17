import React, { useLayoutEffect, useRef, useState } from 'react';

// Spotify's entity-header title ladder: 96 -> 72 -> 48 -> 32px at weight 800,
// stepping down until the title fits in at most `maxLines`. A CSS clamp can't
// do this because it doesn't know whether the text wrapped.
const LADDER = [96, 72, 48, 32];

export default function FittedTitle({ text, maxLines = 2, className = '' }) {
  const ref = useRef(null);
  const [size, setSize] = useState(LADDER[0]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const fit = () => {
      for (const px of LADDER) {
        el.style.fontSize = `${px}px`;
        const lineH = px * 1.05;
        if (el.scrollHeight <= lineH * maxLines + 2) { setSize(px); return; }
      }
      setSize(LADDER[LADDER.length - 1]);
    };

    fit();
    // Re-fit when the column changes width: rail resize, panel open/close, window.
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement || el);
    return () => ro.disconnect();
  }, [text, maxLines]);

  return (
    <h1 ref={ref} className={className} style={{ fontSize: size }}>
      {text}
    </h1>
  );
}
