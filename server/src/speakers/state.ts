// What each BluOS speaker is doing on its own: its volume, its inputs
// (Bluetooth, HDMI, Spotify...) and whatever it plays that is not Slopify's.
// Polled for every app, so a speaker can be shown and controlled as a whole
// (volume, inputs, play/pause) even while no Slopify music is on it.
import type { Discovery } from './discovery.js';
import { BluOSTransport } from './transports.js';
import { heldVolume, releaseSpeaker } from './player.js';

export type SpeakerInput = { id: string; name: string };
export type SpeakerState = {
  volume: number | null; muted: boolean; state: string | null; playing: boolean;
  title: string | null; artist: string | null; album: string | null; image: string | null; input: string | null; inputs: SpeakerInput[];
};

const POLL_EVERY = 5000;
const INPUTS_EVERY = 5 * 60 * 1000;

export class SpeakerStates {
  private states = new Map<string, SpeakerState>();
  private inputs = new Map<string, { at: number; list: { id: string; name: string; url: string }[] }>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private discovery: Discovery, private onChange: () => void) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_EVERY); this.timer.unref();
    void this.poll();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  get(id: string) { return this.states.get(id) ?? null; }

  private async inputsOf(t: BluOSTransport, id: string) {
    const have = this.inputs.get(id);
    if (have && Date.now() - have.at < INPUTS_EVERY) return have.list;
    const list = await t.inputs().catch(() => have?.list ?? []);
    this.inputs.set(id, { at: Date.now(), list });
    return list;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    let changed = false;
    try {
      for (const d of this.discovery.list().filter((x) => x.kind === 'bluos')) {
        const t = new BluOSTransport(d);
        try {
          const [st, inputs] = await Promise.all([t.status(), this.inputsOf(t, d.id)]);
          // An input (Bluetooth, HDMI) by its name; a service (Spotify, TuneIn) by
          // the name the speaker gives it, listed among the inputs or not.
          const input = st.service === 'Capture' ? inputs.find((i) => i.id === st.inputId)?.name ?? null
            : inputs.find((i) => i.name.toLowerCase() === String(st.service || '').toLowerCase())?.name ?? (st.serviceName || null);
          const image = st.image ? (/^https?:\/\//.test(st.image) ? st.image : `http://${d.host}:${d.port}${st.image.startsWith('/') ? '' : '/'}${st.image}`) : null;
          const next: SpeakerState = {
            volume: st.volume, muted: !!st.muted, state: st.state, playing: st.playing,
            title: st.title ?? null, artist: st.artist ?? null, album: st.album ?? null, image, input, inputs: inputs.map(({ id, name }) => ({ id, name })),
          };
          if (JSON.stringify(next) !== JSON.stringify(this.states.get(d.id))) { this.states.set(d.id, next); changed = true; }
        } catch { /* asleep or gone: keep the last reading */ }
      }
    } finally { this.busy = false; }
    if (changed) this.onChange();
  }

  private speaker(id: string) {
    const d = this.discovery.get(id);
    if (!d) throw Object.assign(new Error(`no such speaker ${id}`), { status: 404 });
    if (d.kind !== 'bluos') throw Object.assign(new Error(`${d.name} can only play Slopify music`), { status: 400 });
    return { d, t: new BluOSTransport(d) };
  }

  async setVolume(id: string, level: number) {
    const { t } = this.speaker(id);
    const v = Math.max(0, Math.min(100, Math.round(level)));
    heldVolume(id, v);
    await t.setVolume(v);
    await this.poll();
  }

  // Play one of the speaker's own inputs there (and only there).
  async playInput(id: string, name: string) {
    const { d, t } = this.speaker(id);
    const input = (await this.inputsOf(t, d.id)).find((i) => i.name.toLowerCase() === name.toLowerCase() || i.id === name);
    if (!input) throw Object.assign(new Error(`${d.name} has no input called ${name}`), { status: 404 });
    await releaseSpeaker(id);
    await t.standAlone().catch(() => {});
    await t.playUrl(input.url);
    await this.poll();
  }

  // Play/pause/skip whatever the speaker plays on its own.
  async control(id: string, action: string) {
    const { t } = this.speaker(id);
    if (action === 'pause') await t.pause();
    else if (action === 'play') await t.resume();
    else if (action === 'next') await t.skip();
    else if (action === 'previous') await t.back();
    else throw Object.assign(new Error(`unknown action ${action}`), { status: 400 });
    await this.poll();
  }
}
