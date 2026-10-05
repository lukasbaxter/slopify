import React, { useEffect, useRef, useState } from 'react';

/**
 * A single line that marquee-scrolls when its text overflows (Spotify's
 * long-title treatment): measured once per text/width change, then a pure
 * CSS animation with a 2s pause at each end and a fade at the right edge.
 */
export default function Marquee({ text, className, as: Tag = 'div' }) {
  const box = useRef(null), inner = useRef(null);
  const [dist, setDist] = useState(0);
  useEffect(() => {
    const b = box.current, i = inner.current; if (!b || !i) return undefined;
    const measure = () => setDist(Math.max(0, i.scrollWidth - b.clientWidth));
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(b);
    return () => ro?.disconnect();
  }, [text]);
  const dur = 4 + dist / 30; // 30px/s plus the two pauses
  return (
    <Tag ref={box} className={`${className} marquee ${dist > 0 ? 'overflow' : ''}`} style={dist > 0 ? { '--marquee-dist': `-${dist + 24}px`, '--marquee-dur': `${dur}s` } : undefined}>
      <span ref={inner} className="marquee-inner">{text}</span>
    </Tag>
  );
}
