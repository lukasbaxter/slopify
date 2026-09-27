import { describe, expect, it } from 'vitest';
import { formatOf } from './library.js';

describe('formatOf', () => {
  it('names formats the way listeners know them', () => {
    expect(formatOf({ codec: 'MPEG 1 Layer 3', bitrate: 320000, sample_rate: 44100, bit_depth: null, path: '/m/a.mp3' })).toMatchObject({ codec: 'MP3', lossless: false, bitrate: 320000 });
    expect(formatOf({ codec: 'FLAC', bitrate: 996070, sample_rate: 96000, bit_depth: 24, path: '/m/a.flac' })).toMatchObject({ codec: 'FLAC', lossless: true, sampleRate: 96000, bitDepth: 24 });
    expect(formatOf({ codec: 'PCM', bitrate: 1411200, sample_rate: 44100, bit_depth: 16, path: '/m/a.wav' })).toMatchObject({ codec: 'WAV', lossless: true });
    expect(formatOf({ codec: 'PCM', bitrate: 1411200, sample_rate: 44100, bit_depth: 16, path: '/m/a.aiff' })?.codec).toBe('AIFF');
    expect(formatOf({ codec: 'MPEG-4/AAC', bitrate: 256000, sample_rate: 44100, bit_depth: null, path: '/m/a.m4a' })).toMatchObject({ codec: 'AAC', lossless: false });
    expect(formatOf({ codec: null, bitrate: null, sample_rate: null, bit_depth: null, path: '' })).toBeNull();
  });
});
