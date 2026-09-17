// Hovering a seek bar draws a white line from the playhead to the cursor:
// the input gets --hov (cursor fraction) and a class, the CSS paints
// played / hovered / unplayed segments from --pct and --hov.
export const seekHover = {
  onMouseMove: (e) => {
    const el = e.currentTarget; const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    el.style.setProperty('--hov', `${(f * 100).toFixed(2)}%`);
    el.classList.add('hovering');
  },
  onMouseLeave: (e) => { e.currentTarget.classList.remove('hovering'); e.currentTarget.style.removeProperty('--hov'); },
};
