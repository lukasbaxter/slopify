// How fast this device's link to the server is, for picking picture sizes.
// iPhones (and Safari) have no navigator.connection, so it is measured: the
// download rate of the app's own larger responses (pictures, library pages),
// smoothed. Until there is a measurement the browser's own hint is used, or
// 'medium'. Data Saver and a 2G/3G hint always mean 'slow'.

let mbps = null;
let tier = null;
let started = false;

function sample(e) {
  // transferSize 0 is a cache hit; tiny responses measure latency, not speed.
  if (!e.transferSize || e.transferSize < 24000 || e.duration < 15) return;
  const s = (e.transferSize * 8) / (e.duration * 1000); // Mbit/s
  mbps = mbps == null ? s : mbps * 0.7 + s * 0.3;
}

export function startLinkMeter() {
  if (started || typeof PerformanceObserver === 'undefined') return;
  started = true;
  try {
    const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) sample(e); });
    po.observe({ type: 'resource', buffered: true });
  } catch { /* no resource timing */ }
}

export function linkTier() {
  startLinkMeter();
  const c = typeof navigator !== 'undefined' ? navigator.connection : null;
  if (c?.saveData || /(^|-)2g$|^3g$/.test(c?.effectiveType || '')) return 'slow';
  const speed = mbps ?? (typeof c?.downlink === 'number' ? c.downlink : null);
  if (speed == null) return tier || 'medium';
  // A little hysteresis so pictures do not swap sizes back and forth on a
  // link that hovers near a threshold.
  const up = tier === 'fast' ? 6 : 10, mid = tier === 'slow' ? 3 : 1.5;
  tier = speed >= up ? 'fast' : speed >= mid ? 'medium' : 'slow';
  return tier;
}
