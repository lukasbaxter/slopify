import { useEffect, useRef } from 'react';

// Drag to arrange Your Library (Sidebar.jsx): pointer events, so a mouse, a
// trackpad and a finger all work the same.
//
// - A mouse or pen lifts the row once it has moved 5 px (a click stays a
//   click); a finger lifts it after holding still for LONG_MS (a swipe
//   scrolls, a tap opens). Held and let go without moving: onHold (the menu).
// - The lifted row follows the pointer on a transform set every frame, the
//   others slide out of its way on transforms (their positions were measured
//   once at the lift, so nothing reads layout while it moves), and a line
//   marks where it lands. Over the middle of a folder the folder lights up
//   instead: let go there and the row goes into it.
// - Near the top or bottom edge the list scrolls, faster the closer it gets.
// - Escape, a cancelled pointer or the window losing focus put it back.
// onLift / onEnd: a drag starts / ends (onDrop or not).
// Rows are the list's [data-lib-row] elements, in order; a folder's carries
// data-lib-folder. Nothing here re-renders React while a row moves; onDrop
// gets { id, to, into } (to: the slot among all rows the row ends in; into:
// the folder it was dropped on) and the list re-renders in its new order,
// the lifted row settling into its place from where it was let go.
const MOUSE_SLOP = 5, TOUCH_SLOP = 8, LONG_MS = 380, EDGE = 56, MAX_SPEED = 18;

export function useLibraryDrag({ listRef, enabled, onDrop, onHold, canEnter, onLift, onEnd }) {
  const live = useRef(null);
  const opts = useRef({}); opts.current = { enabled, onDrop, onHold, canEnter, onLift, onEnd };

  // A lifted row on a touch screen: the finger must not scroll the list as
  // well. Only a non-passive listener can say so (React's are passive).
  useEffect(() => {
    const el = listRef.current; if (!el) return undefined;
    const stop = (e) => { if (live.current?.lifted && e.cancelable) e.preventDefault(); };
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, [listRef]);
  useEffect(() => () => end(true), []); // eslint-disable-line react-hooks/exhaustive-deps

  const style = (el, transform, transition) => { el.style.transform = transform; el.style.transition = transition; };

  function measure(s) {
    const list = listRef.current;
    const lr = list.getBoundingClientRect();
    s.listTop = lr.top; s.listLeft = lr.left; s.listBottom = lr.bottom; s.scroll0 = list.scrollTop;
    s.rows = [...list.querySelectorAll('[data-lib-row]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.libRow, el, folder: el.hasAttribute('data-lib-folder'), top: r.top - lr.top + list.scrollTop, left: r.left - lr.left, w: r.width, h: r.height };
    });
    s.from = s.rows.findIndex((r) => r.id === s.id);
    s.to = s.from; s.into = null;
  }

  function lift(s) {
    const list = listRef.current; if (!list) return;
    opts.current.onLift?.(s.id); // may re-render the list first (a folder drag shuts the folders)
    measure(s);
    if (s.from < 0) { live.current = null; return; }
    s.lifted = true;
    const me = s.rows[s.from];
    s.grabX = s.x - (s.listLeft + me.left); s.grabY = s.y - (s.listTop + me.top - s.scroll0);
    try { me.el.setPointerCapture(s.pointerId); } catch { /* gone */ }
    me.el.classList.add('lib-lifted');
    for (const r of s.rows) if (r !== me) r.el.style.transition = 'transform .18s cubic-bezier(.2,0,0,1)';
    list.classList.add('lib-dragging');
    document.documentElement.classList.add('lib-dragging-doc');
    window.getSelection?.()?.removeAllRanges?.();
    if (s.touch) { try { navigator.vibrate?.(10); } catch { /* not supported */ } }
    s.line = list.querySelector('.libdrop');
    frame();
  }

  // Where each row sits when the lifted one goes to slot `to`.
  function shiftOf(s, j) {
    if (j === s.from) return null;
    const k = j < s.from ? j : j - 1; // its place among the others
    const nj = k < s.to ? k : k + 1;
    const a = s.rows[j], b = s.rows[nj];
    return { dx: b.left - a.left, dy: b.top - a.top };
  }
  function applyShifts(s) {
    s.rows.forEach((r, j) => { if (j === s.from) return; const d = shiftOf(s, j); r.el.style.transform = d.dx || d.dy ? `translate3d(${d.dx}px, ${d.dy}px, 0)` : ''; });
    if (s.line) {
      const slot = s.rows[s.to];
      if (s.into || s.to === s.from) s.line.style.opacity = '0';
      else {
        // The line sits in the gap the others opened, where the row lands.
        const y = slot.top + slot.h / 2 - 1;
        s.line.style.opacity = '1';
        s.line.style.transform = `translate3d(${slot.left + 4}px, ${y}px, 0)`;
        s.line.style.width = `${Math.max(8, slot.w - 8)}px`;
      }
    }
  }

  function frame() {
    const s = live.current; if (!s?.lifted) return;
    const list = listRef.current; if (!list) { end(true); return; }
    // Auto-scroll near the edges.
    let v = 0;
    if (s.y < s.listTop + EDGE) v = -MAX_SPEED * Math.min(1, (s.listTop + EDGE - s.y) / EDGE);
    else if (s.y > s.listBottom - EDGE) v = MAX_SPEED * Math.min(1, (s.y - (s.listBottom - EDGE)) / EDGE);
    if (v) list.scrollTop += v;
    const scroll = list.scrollTop;
    const me = s.rows[s.from];
    // The lifted row: where the pointer holds it, wherever the list has scrolled.
    const dx = s.x - s.grabX - (s.listLeft + me.left);
    const dy = s.y - s.grabY - (s.listTop + me.top - scroll);
    me.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.02)`;
    // What it is over, in the list's own coordinates.
    const px = s.x - s.listLeft, py = s.y - s.listTop + scroll;
    // Over a row (where it shows now, moved aside or not): its first half
    // puts the lifted one before it, its second half after it, and the
    // middle of a folder into the folder. Over the gap the others opened,
    // nothing changes; that is what keeps the rows from flickering.
    let into = null, to = s.to, over = false;
    const grid = s.rows.some((r) => r.left !== s.rows[0].left);
    for (let j = 0; j < s.rows.length; j++) {
      if (j === s.from) continue;
      const r = s.rows[j]; const d = shiftOf(s, j); const top = r.top + d.dy, left = r.left + d.dx;
      if (px < left || px > left + r.w || py < top || py > top + r.h) continue;
      over = true;
      const f = grid ? (px - left) / r.w : (py - top) / r.h;
      const g = (py - top) / r.h;
      if (r.folder && g > 0.25 && g < 0.75 && opts.current.canEnter?.(s.id)) { into = r.id; break; }
      const k = j < s.from ? j : j - 1;
      to = f < 0.5 ? k : k + 1;
      break;
    }
    if (!over && !into) {
      const first = s.rows[0], last = s.rows[s.rows.length - 1];
      if (py < first.top) to = 0;
      else if (py > last.top + last.h) to = s.rows.length - 1;
    }
    const changed = to !== s.to || into !== s.into || !s.applied;
    if (into !== s.into) s.rows.forEach((r) => r.el.classList.toggle('lib-target', r.id === into));
    s.into = into; s.to = to;
    // Written only when the landing place changes; the frames between move the lifted row alone.
    if (changed) { applyShifts(s); s.applied = true; }
    s.raf = requestAnimationFrame(frame);
  }

  // cancel: everything slides back. Otherwise onDrop re-renders the list in
  // its new order and the lifted row settles from where it was let go.
  function end(cancel) {
    const s = live.current; live.current = null;
    if (!s) return;
    clearTimeout(s.timer);
    window.removeEventListener('pointermove', s.move); window.removeEventListener('pointerup', s.up); window.removeEventListener('pointercancel', s.cancel);
    window.removeEventListener('keydown', s.key, true); window.removeEventListener('blur', s.cancel);
    if (!s.lifted) return;
    cancelAnimationFrame(s.raf);
    const list = listRef.current;
    list?.classList.remove('lib-dragging');
    document.documentElement.classList.remove('lib-dragging-doc');
    if (s.line) s.line.style.opacity = '0';
    const me = s.rows[s.from];
    const at = me.el.getBoundingClientRect();
    me.el.classList.remove('lib-lifted');
    for (const r of s.rows) r.el.classList.remove('lib-target');
    // A click follows the pointerup of a drag: it is not a click on the row.
    const swallow = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    const moved = !cancel && (s.into || s.to !== s.from);
    if (!moved) {
      // Back to its own place, everyone else too.
      for (const r of s.rows) style(r.el, '', r === me ? 'transform .2s cubic-bezier(.2,0,0,1)' : 'transform .18s cubic-bezier(.2,0,0,1)');
      setTimeout(() => { for (const r of s.rows) r.el.style.transition = ''; }, 220);
      opts.current.onEnd?.();
      return;
    }
    // The others are already where the new order puts them: drop their
    // transforms without a transition, the re-render keeps them there.
    for (const r of s.rows) style(r.el, '', 'none');
    opts.current.onDrop?.({ id: s.id, to: s.to, into: s.into, rows: s.rows.map((r) => r.id) });
    // After React has committed (a microtask) and before the next paint.
    requestAnimationFrame(() => {
      for (const r of s.rows) r.el.style.transition = '';
      const el = list?.querySelector(`[data-lib-row="${CSS.escape(s.id)}"]`);
      if (!el || s.into) return;
      const now = el.getBoundingClientRect();
      style(el, `translate3d(${at.left - now.left}px, ${at.top - now.top}px, 0)`, 'none');
      el.getBoundingClientRect(); // commit the start before the transition
      style(el, '', 'transform .2s cubic-bezier(.2,0,0,1)');
      setTimeout(() => { el.style.transition = ''; }, 220);
    });
  }

  const onPointerDown = (id) => (e) => {
    if (!opts.current.enabled || live.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const touch = e.pointerType === 'touch';
    const s = { id, pointerId: e.pointerId, touch, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, lifted: false, held: false };
    live.current = s;
    s.move = (ev) => {
      if (ev.pointerId !== s.pointerId) return;
      s.x = ev.clientX; s.y = ev.clientY;
      const far = Math.hypot(s.x - s.x0, s.y - s.y0);
      if (!s.lifted) {
        if (touch) { if (far > TOUCH_SLOP) end(true); } // a scroll
        else if (far > MOUSE_SLOP) lift(s);
        return;
      }
      if (far > TOUCH_SLOP) s.held = false;
    };
    s.up = (ev) => {
      if (ev.pointerId !== s.pointerId) return;
      if (s.lifted && touch && s.held) {
        // Held still and let go: the long-press menu, not a drag.
        const hold = { id, x: s.x, y: s.y };
        end(true);
        const swallow = (x) => { x.stopImmediatePropagation(); x.preventDefault(); };
        for (const type of ['mousedown', 'mouseup', 'click']) document.addEventListener(type, swallow, true);
        setTimeout(() => { for (const type of ['mousedown', 'mouseup', 'click']) document.removeEventListener(type, swallow, true); }, 400);
        opts.current.onHold?.(hold);
        return;
      }
      end(false);
    };
    s.cancel = () => end(true);
    s.key = (ev) => { if (ev.key === 'Escape' && s.lifted) { ev.preventDefault(); ev.stopPropagation(); end(true); } };
    window.addEventListener('pointermove', s.move);
    window.addEventListener('pointerup', s.up);
    window.addEventListener('pointercancel', s.cancel);
    window.addEventListener('keydown', s.key, true);
    window.addEventListener('blur', s.cancel);
    if (touch) s.timer = setTimeout(() => { if (live.current === s) { s.held = true; lift(s); } }, LONG_MS);
  };

  return { onPointerDown, active: () => !!live.current?.lifted, pending: () => !!live.current };
}
