import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const Chevron = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className="ctx-chev">
    <path d="M6 3.5 10.5 8 6 12.5 5 11.5 8.5 8 5 4.5z" />
  </svg>
);

const PAD = 8;

// Keep a box on screen: slide it up when it would run off the bottom, and
// open it leftwards when it would run off the right. Spotify does the same
// with its context menu, which is why it never spills past the footer.
function fit(x, y, w, h, preferLeft = false) {
  const W = window.innerWidth, H = window.innerHeight;
  let nx = preferLeft ? x - w : x;
  if (nx + w > W - PAD) nx = Math.max(PAD, W - PAD - w);
  if (nx < PAD) nx = PAD;
  let ny = y;
  if (ny + h > H - PAD) ny = Math.max(PAD, H - PAD - h);
  return { x: nx, y: ny };
}

const hoverable = () => typeof window === 'undefined' || !window.matchMedia || window.matchMedia('(hover: hover)').matches;

function Panel({ x, y, items, onClose, depth = 0, anchorRight = false, onEnter, onLeave, header = null }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x, y, ready: false });
  const [open, setOpen] = useState(null); // index of the open submenu
  const [subAt, setSubAt] = useState(null);
  const closeTimer = useRef(null);

  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ ...fit(x, y, r.width, r.height, anchorRight), ready: true });
  }, [x, y, anchorRight, items.length]);

  const openSub = (i, target) => {
    clearTimeout(closeTimer.current);
    if (open === i) return; // already open: do not re-measure and jump
    const r = target.getBoundingClientRect();
    const menu = ref.current.getBoundingClientRect();
    // Open to the right of the panel; Panel() flips it left when there is no room.
    const spaceRight = window.innerWidth - menu.right;
    setSubAt({ x: spaceRight > 240 ? menu.right + 2 : menu.left - 2, y: r.top - 4, left: spaceRight <= 240 });
    setOpen(i);
  };
  const scheduleClose = () => { closeTimer.current = setTimeout(() => setOpen(null), 400); };

  return (
    <>
      <div
        ref={ref}
        className={`ctxmenu ctxmenu-fixed ${depth ? 'ctxmenu-sub' : ''}`}
        style={{ left: pos.x, top: pos.y, visibility: pos.ready ? 'visible' : 'hidden' }}
        onMouseLeave={() => { if (open != null) scheduleClose(); onLeave?.(); }}
        onMouseEnter={() => { clearTimeout(closeTimer.current); onEnter?.(); }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Phone sheets carry what the menu is about (art, title, subtitle) at the top, like Spotify's. Hidden on desktop. */}
        {header && depth === 0 && (
          <div className="ctxmenu-head">
            {header.image ? <img src={header.image} alt="" className={header.round ? 'round' : ''} /> : header.icon ? <span className="ctxmenu-head-ico">{header.icon}</span> : null}
            <div className="ctxmenu-head-text"><b>{header.title}</b>{header.sub && <small>{header.sub}</small>}</div>
          </div>
        )}
        {items.map((it, i) => {
          if (!it) return null;
          if (it.sep) return <div key={`sep${i}`} className="ctxmenu-sep" />;
          if (it.slider) {
            // A range inside the menu; dragging it must not close the menu.
            return (
              <div key={it.key || it.label} className="ctxslider" onMouseEnter={() => setOpen(null)} onClick={(e) => e.stopPropagation()}>
                <div className="ctxslider-head"><span className="ctx-label">{it.label}</span><span className="ctxslider-val">{it.format ? it.format(it.value) : it.value}</span></div>
                <input type="range" min={it.min ?? 0} max={it.max ?? 1} step={it.step ?? 0.01} value={it.value} onChange={(e) => it.onChange?.(Number(e.target.value))} style={{ '--pct': `${((it.value - (it.min ?? 0)) / ((it.max ?? 1) - (it.min ?? 0))) * 100}%` }} />
              </div>
            );
          }
          if (it.label && !it.onClick && !it.sub) return <div key={`lbl${i}`} className="ctxmenu-label">{it.label}</div>;
          return (
            <button
              key={it.key || it.label}
              className={`ctxitem ${it.danger ? 'danger' : ''} ${open === i ? 'open' : ''}`}
              disabled={it.disabled}
              // Hover opens submenus on a pointer; on touch, tapping the row does (a synthetic enter opened them at once).
              onMouseEnter={(e) => { if (!hoverable()) return; if (it.sub) openSub(i, e.currentTarget); else setOpen(null); }}
              onClick={(e) => {
                e.stopPropagation();
                if (it.sub) { openSub(i, e.currentTarget); return; }
                onClose();
                it.onClick?.();
              }}
            >
              <span className="ctx-ico">{it.icon || null}</span>
              <span className="ctx-label">{it.label}</span>
              {it.checked && <svg className="ctx-check" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.985 2.383 5.127 12.754 1.388 8.375l-1.14 1.048 4.879 5.617L15.184 3.36l-1.199-.977z" /></svg>}
              {it.sub && <Chevron />}
            </button>
          );
        })}
      </div>
      {open != null && items[open]?.sub && subAt && (
        // The submenu is a sibling, not a child: hovering it must cancel THIS
        // panel's pending close, or it vanishes the moment the pointer arrives.
        <Panel x={subAt.x} y={subAt.y} items={items[open].sub} onClose={onClose} depth={depth + 1} anchorRight={subAt.left}
          onEnter={() => clearTimeout(closeTimer.current)} onLeave={() => scheduleClose()} />
      )}
    </>
  );
}

/**
 * Spotify-style context menu. `items`: [{ label, icon, onClick, sub: [...],
 * danger, disabled } | { sep: true } | { label } (a heading)].
 * Rendered in a portal at a fixed screen position, kept on screen, with
 * hover-opened submenus. Closes on outside click, Escape, scroll or resize.
 */
export default function ContextMenu({ x, y, items, onClose, anchorRight = false, header = null }) {
  useEffect(() => {
    const down = (e) => { if (!e.target.closest?.('.ctxmenu')) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    const bye = () => onClose();
    // The USER scrolling the page under the menu closes it (wheel / touch);
    // scrolling inside a long submenu must not, and neither must programmatic
    // scrolls -- the lyrics pane following the song fires scroll events every
    // few seconds and used to close any open menu.
    const scrolled = (e) => { if (!e.target?.closest?.('.ctxmenu')) onClose(); };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', bye);
    document.addEventListener('wheel', scrolled, { capture: true, passive: true });
    document.addEventListener('touchmove', scrolled, { capture: true, passive: true });
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', bye);
      document.removeEventListener('wheel', scrolled, true);
      document.removeEventListener('touchmove', scrolled, true);
    };
  }, [onClose]);
  // The phone scrim is a real element: a tap on it closes the sheet and goes
  // no further (a tap that fell through used to open whatever row was under
  // the finger). Desktop hides it.
  return createPortal(
    <>
      <div className="ctxmenu-scrim" onClick={(e) => { e.stopPropagation(); onClose(); }} onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }} />
      <Panel x={x} y={y} items={items} onClose={onClose} anchorRight={anchorRight} header={header} />
    </>,
    document.body,
  );
}
