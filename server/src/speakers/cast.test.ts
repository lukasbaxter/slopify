import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CastTransport, castDeps, CAST_TIMEOUT_MS } from './transports.js';

// A fake Chromecast: launches a media player; `answer` decides whether the
// player replies to requests at all (a receiver that went away does not).
let launches = 0; let answer = true; let lastPlayer: any = null;
class FakePlayer extends EventEmitter {
  getStatus(cb: any) { if (answer) cb(null, { playerState: 'PLAYING', currentTime: 10, media: { duration: 200, contentId: 'u', metadata: {} }, mediaSessionId: 1 }); }
  stop(cb: any) { if (answer) cb(null, {}); }
  pause(cb: any) { if (answer) cb(null, {}); }
  play(cb: any) { if (answer) cb(null, {}); }
}
class FakeClient extends EventEmitter {
  connect(_h: string, cb: any) { cb(); }
  launch(_r: any, cb: any) { launches += 1; lastPlayer = new FakePlayer(); cb(null, lastPlayer); }
  getStatus(cb: any) { if (answer) cb(null, { volume: { level: 0.5, muted: false } }); }
  setVolume(_v: any, cb: any) { if (answer) cb(null, {}); }
  stop(_p: any, cb: any) { if (answer) cb(null, {}); }
  close() {}
}

describe('Cast transport when the receiver goes away', () => {
  const saved = { ...castDeps };
  beforeEach(() => { vi.useFakeTimers(); castDeps.Client = FakeClient as any; castDeps.DefaultMediaReceiver = {} as any; launches = 0; answer = true; });
  afterEach(() => { vi.useRealTimers(); Object.assign(castDeps, saved); });
  const dev = { id: 'cast:tv', kind: 'cast', name: 'TV', model: 'Cast', host: '10.0.0.9', port: 8009 } as any;

  it('a status read the receiver never answers comes back as gone, instead of hanging the player', async () => {
    const t = new CastTransport(dev);
    await t.pause(); // connects and launches
    answer = false;
    const st = t.status();
    await vi.advanceTimersByTimeAsync(CAST_TIMEOUT_MS + 100);
    await expect(st).resolves.toMatchObject({ gone: true });
  });

  it('the receiver app closing reads as gone, and stopping then never launches it again', async () => {
    const t = new CastTransport(dev);
    await t.pause();
    expect(launches).toBe(1);
    lastPlayer.emit('close');
    await expect(t.status()).resolves.toMatchObject({ gone: true });
    await t.stop();
    expect(launches).toBe(1);
  });
});
