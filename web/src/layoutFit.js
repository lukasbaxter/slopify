import { useEffect, useState } from 'react';

// The desktop layout's columns for a window width: library rail, main view,
// right panel (queue / lyrics / now playing), with the gaps between. They
// always add up to the window, so nothing is ever cut off at the right.
// - The library rail folds to its covers-only width (RAIL_COLLAPSED) while
//   the main view would get less than MAIN_FIT next to the rail at its own
//   width; it opens again when there is room (the same sum, so it never flips
//   back and forth). A rail folded by hand stays folded.
// - The right panel gives up width (down to PANEL_FLOOR) before the main
//   view goes under MAIN_MIN.
export const MAIN_FIT = 560, MAIN_MIN = 360, PANEL_FLOOR = 240;
const GAP = 8; // --gap: the app's padding on each side and the gaps between columns

export function fitColumns({ width, railW, panelW, panel, collapsedW }) {
  const shell = width - 2 * GAP;
  const panelSpace = panel ? GAP + panelW : 0;
  const fold = railW > collapsedW && shell - railW - GAP - panelSpace < MAIN_FIT;
  const rail = fold ? collapsedW : railW;
  const panelOut = panel ? Math.min(panelW, Math.max(PANEL_FLOOR, shell - rail - 2 * GAP - MAIN_MIN)) : panelW;
  return { rail, panel: panelOut, folded: fold };
}

export function useWindowWidth() {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}
