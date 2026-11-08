// The Android app's media session relay (mobile/mediaSession.js): the page
// reports "none" whenever it has no song, which it also does for a moment
// between songs. Stopping the playback service on that tore it down mid-queue,
// and Android 12+ then refuses to start it again from the background.
import { describe, expect, it, vi, afterEach } from 'vitest';
// @ts-expect-error plain JS from the apps
import { mediaSessionRelay, NONE_GRACE_MS } from '../../mobile/mediaSession.js';

const playing = { type: 'mediasession', state: 'playing', metadata: { title: 'Airbag' }, actions: ['play', 'pause'] };
const none = { type: 'mediasession', state: 'none', metadata: null, actions: [] };

function setup() {
  const media = { update: vi.fn(), stop: vi.fn() };
  return { media, relay: mediaSessionRelay(media) };
}

describe('Android media session relay', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a gap between songs leaves the service up', () => {
    vi.useFakeTimers();
    const { media, relay } = setup();
    relay.message(playing);
    relay.message(none);
    vi.advanceTimersByTime(2000);
    relay.message({ ...playing, metadata: { title: 'Paranoid Android' } });
    vi.advanceTimersByTime(NONE_GRACE_MS * 2);
    expect(media.stop).not.toHaveBeenCalled();
    expect(media.update).toHaveBeenCalledTimes(2);
  });

  it('nothing playing for a while stops it', () => {
    vi.useFakeTimers();
    const { media, relay } = setup();
    relay.message(playing);
    relay.message(none);
    relay.message(none);
    vi.advanceTimersByTime(NONE_GRACE_MS - 1);
    expect(media.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(media.stop).toHaveBeenCalledTimes(1);
  });

  it('signing out stops it at once', () => {
    vi.useFakeTimers();
    const { media, relay } = setup();
    relay.message(playing);
    relay.stop();
    expect(media.stop).toHaveBeenCalledTimes(1);
    relay.message(none);
    vi.advanceTimersByTime(NONE_GRACE_MS * 2);
    expect(media.stop).toHaveBeenCalledTimes(2);
  });

  it('a module that throws does not break the page bridge', () => {
    vi.useFakeTimers();
    const media = { update: vi.fn(() => { throw new Error('gone'); }), stop: vi.fn(() => { throw new Error('gone'); }) };
    const relay = mediaSessionRelay(media);
    expect(() => relay.message(playing)).not.toThrow();
    relay.message(none);
    expect(() => vi.advanceTimersByTime(NONE_GRACE_MS)).not.toThrow();
    expect(() => relay.stop()).not.toThrow();
  });
});
