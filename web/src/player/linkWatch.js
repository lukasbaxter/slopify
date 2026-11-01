// How the link is holding up, from what the playing song tells us: a song
// that stops mid-play for data, or takes seconds to start, is starving.
//
// On mobile data a starving song caps the quality the next songs climb to
// one rung lower for a while (320k -> 160k, 160k -> 96k), then full quality
// is tried again. The phone's own HLS player climbs as fast as the first
// few small segments arrive, and on 4G it went from 96k to 320k in 3 s and
// then could not keep 320k fed (a song sat at 0:00 for half a minute,
// 10-30). Wi-Fi is left alone: a stall there is rare and usually brief.
const CAP_MS = 10 * 60 * 1000;
let lastStarve = 0;
let capUntil = 0;

// Mobile data, or a phone that will not say (Android's WebView, inside the
// app, reports the type as 'unknown'; iPhones have no navigator.connection):
// a stall there is treated like one on mobile data. A computer, or a phone
// that says it is on Wi-Fi, is left alone.
export function onCellular() {
  const c = typeof navigator !== 'undefined' ? navigator.connection : null;
  if (c?.type === 'cellular') return true;
  if (c?.type && c.type !== 'unknown') return false;
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

export function noteStarve(why) {
  lastStarve = Date.now();
  if (onCellular()) capUntil = Date.now() + CAP_MS;
  return { why, capped: capUntil > Date.now() };
}

export const starvedWithin = (ms) => Date.now() - lastStarve < ms;

// The quality to climb to: the chosen one, or a rung lower while capped.
const LOWER = { alac: 'aac-320', 'aac-320': 'aac-160', 'aac-160': 'aac-96', 'aac-96': 'aac-96' };
export function cappedProfile(profile) {
  return Date.now() < capUntil && onCellular() ? LOWER[profile] || profile : profile;
}
