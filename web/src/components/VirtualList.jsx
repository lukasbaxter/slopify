import React, { useEffect, useRef, useState } from 'react';

/**
 * Windowed list: renders only the rows in view plus a buffer, so a 1,300-row
 * Liked Songs mounts ~30 rows instead of 1,300. Rows are a fixed height, which
 * is what track rows are, so positions are pure arithmetic.
 */
export default function VirtualList({ items, rowHeight = 56, overscan = 8, renderRow, getKey }) {
  const spacerRef = useRef(null);
  const [range, setRange] = useState({ start: 0, end: 40 });

  useEffect(() => {
    const el = spacerRef.current;
    if (!el) return undefined;
    // The nearest scrolling ancestor is the page's .content panel.
    const scroller = el.closest('.content') || el.parentElement;
    if (!scroller) return undefined;

    const recompute = () => {
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const scrollTop = Math.max(0, -top);
      const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
      const visible = Math.ceil(scroller.clientHeight / rowHeight) + overscan * 2;
      setRange({ start, end: Math.min(items.length, start + visible) });
    };

    recompute();
    scroller.addEventListener('scroll', recompute, { passive: true });
    window.addEventListener('resize', recompute);
    return () => {
      scroller.removeEventListener('scroll', recompute);
      window.removeEventListener('resize', recompute);
    };
  }, [items.length, rowHeight, overscan]);

  const { start, end } = range;
  const slice = items.slice(start, end);

  return (
    <div ref={spacerRef} style={{ position: 'relative', height: items.length * rowHeight }}>
      <div style={{ position: 'absolute', top: start * rowHeight, left: 0, right: 0 }}>
        {slice.map((item, i) => (
          <div key={getKey ? getKey(item, start + i) : start + i} style={{ height: rowHeight }}>
            {renderRow(item, start + i)}
          </div>
        ))}
      </div>
    </div>
  );
}
