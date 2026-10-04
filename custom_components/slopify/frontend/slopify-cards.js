// Slopify's Lovelace card, loaded automatically by the integration.
//
// custom:slopify-now-playing  { entity }
//   Home Assistant's own media-control card, unchanged, with one addition:
//   tapping it (anywhere but its buttons) opens a full-screen Now Playing
//   view: the cover large over a blur of itself, title, artist and album,
//   a live progress bar, controls, volume, and the song's synced lyrics.

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const ICONS = {
  prev: 'M6,18V6H8V18H6M9.5,12L18,6V18L9.5,12Z',
  next: 'M16,18H18V6H16M6,18L14.5,12L6,6V18Z',
  play: 'M8,5.14V19.14L19,12.14L8,5.14Z',
  pause: 'M14,19H18V5H14M6,19H10V5H6V19Z',
  close: 'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
  volume: 'M14,3.23V5.29C16.89,6.15 19,8.83 19,12C19,15.17 16.89,17.84 14,18.7V20.77C18,19.86 21,16.28 21,12C21,7.72 18,4.14 14,3.23M16.5,12C16.5,10.23 15.5,8.71 14,7.97V16C15.5,15.29 16.5,13.76 16.5,12M3,9V15H7L12,20V4L7,9H3Z',
};
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

const STYLE = `
.snp { position: fixed; inset: 0; z-index: 9999; color: #fff; display: flex; overflow: hidden;
  font-family: var(--ha-font-family-body, Roboto, system-ui, sans-serif); background: #111;
  animation: snp-in .22s ease-out; -webkit-tap-highlight-color: transparent; }
@keyframes snp-in { from { opacity: 0; transform: scale(1.02); } to { opacity: 1; transform: none; } }
.snp-bg { position: absolute; inset: -10%; background-size: cover; background-position: center;
  filter: blur(48px) saturate(1.4) brightness(.55); transform: scale(1.1); transition: background-image .6s; }
.snp-shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(0,0,0,.25), rgba(0,0,0,.55)); }
.snp-close { position: absolute; top: max(16px, env(safe-area-inset-top)); right: 20px; z-index: 2; }
.snp-main { position: relative; z-index: 1; display: grid; grid-template-columns: auto minmax(0, 1fr); height: 100%;
  gap: clamp(24px, 4vw, 64px); align-items: center; width: 100%; padding: clamp(24px, 5vh, 56px) clamp(24px, 5vw, 72px); box-sizing: border-box; }
.snp-cover { width: min(70vh, 42vw); aspect-ratio: 1; border-radius: 14px; background: #222 center/cover no-repeat;
  box-shadow: 0 24px 60px rgba(0,0,0,.55); }
.snp-side { display: flex; flex-direction: column; min-width: 0; height: min(70vh, 42vw); }
.snp-title { font-size: clamp(26px, 3.4vw, 44px); font-weight: 700; line-height: 1.12; margin: 0;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-wrap: balance; }
.snp-sub { font-size: clamp(16px, 1.6vw, 21px); opacity: .78; margin-top: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.snp-lyrics { flex: 1; min-height: 0; overflow: hidden; margin: 22px 0 14px; position: relative;
  mask-image: linear-gradient(transparent, #000 18%, #000 78%, transparent); -webkit-mask-image: linear-gradient(transparent, #000 18%, #000 78%, transparent); }
.snp-lines { transition: transform .45s cubic-bezier(.2,.7,.2,1); }
.snp-line { font-size: clamp(20px, 2.3vw, 30px); font-weight: 700; line-height: 1.32; padding: 5px 0; opacity: .32; transition: opacity .3s; }
.snp-line.on { opacity: 1; }
.snp-plain .snp-line { opacity: .8; font-size: clamp(17px, 1.8vw, 23px); font-weight: 600; }
.snp-spacer { flex: 1; }
.snp-progress { margin-top: 8px; }
.snp-bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.22); overflow: hidden; cursor: pointer; }
.snp-fill { height: 100%; background: #fff; border-radius: 3px; width: 0; }
.snp-times { display: flex; justify-content: space-between; font-size: 13px; opacity: .7; margin-top: 6px; font-variant-numeric: tabular-nums; }
.snp-controls { display: flex; align-items: center; gap: 18px; margin-top: 14px; }
.snp button { background: none; border: 0; color: inherit; padding: 0; cursor: pointer; display: grid; place-items: center; border-radius: 50%; }
.snp button svg { width: 34px; height: 34px; fill: currentColor; }
.snp .snp-play { width: 68px; height: 68px; background: #fff; color: #111; }
.snp .snp-play svg { width: 36px; height: 36px; }
.snp .snp-close svg { width: 30px; height: 30px; }
.snp-vol { display: flex; align-items: center; gap: 10px; margin-left: auto; width: min(220px, 30%); }
.snp-vol svg { width: 22px; height: 22px; fill: currentColor; opacity: .8; flex: none; }
.snp-vol input { width: 100%; accent-color: #fff; }
.snp-where { font-size: 13px; opacity: .65; margin-top: 12px; letter-spacing: .02em; }
@media (orientation: portrait) {
  .snp-main { grid-template-columns: 1fr; align-content: center; justify-items: center; text-align: center; }
  .snp-cover { width: min(78vw, 46vh); }
  .snp-side { width: 100%; height: auto; }
  .snp-main { height: auto; min-height: 100%; }
  .snp-lyrics { display: none; }
  .snp-controls { justify-content: center; }
  .snp-vol { margin: 0; }
}
`;

class NowPlayingView {
  constructor(entityId, onClose) {
    this.entityId = entityId;
    this.onClose = onClose;
    this.lyricsFor = null;
    this.lyrics = null;
    this.el = document.createElement('div');
    this.el.className = 'snp';
    this.el.innerHTML = `<style>${STYLE}</style>
      <div class="snp-bg"></div><div class="snp-shade"></div>
      <button class="snp-close" aria-label="Close">${svg(ICONS.close)}</button>
      <div class="snp-main">
        <div class="snp-cover"></div>
        <div class="snp-side">
          <h1 class="snp-title"></h1>
          <div class="snp-sub"></div>
          <div class="snp-lyrics"><div class="snp-lines"></div></div>
          <div class="snp-progress">
            <div class="snp-bar"><div class="snp-fill"></div></div>
            <div class="snp-times"><span class="snp-pos"></span><span class="snp-dur"></span></div>
          </div>
          <div class="snp-controls">
            <button class="snp-prev" aria-label="Previous">${svg(ICONS.prev)}</button>
            <button class="snp-play" aria-label="Play or pause"></button>
            <button class="snp-next" aria-label="Next">${svg(ICONS.next)}</button>
            <label class="snp-vol">${svg(ICONS.volume)}<input type="range" min="0" max="100" step="1" aria-label="Volume"></label>
          </div>
          <div class="snp-where"></div>
        </div>
      </div>`;
    const $ = (s) => this.el.querySelector(s);
    this.$ = $;
    $('.snp-close').addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => { if (e.target === this.el || e.target.classList?.contains('snp-shade')) this.close(); });
    $('.snp-prev').addEventListener('click', () => this.call('media_previous_track'));
    $('.snp-next').addEventListener('click', () => this.call('media_next_track'));
    $('.snp-play').addEventListener('click', () => this.call('media_play_pause'));
    $('.snp-vol input').addEventListener('change', (e) => this.call('volume_set', { volume_level: Number(e.target.value) / 100 }));
    $('.snp-bar').addEventListener('click', (e) => {
      const st = this.state(); const dur = st?.attributes?.media_duration;
      if (!dur) return;
      const r = e.currentTarget.getBoundingClientRect();
      this.call('media_seek', { seek_position: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur });
    });
    this.onKey = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this.onKey);
    document.body.appendChild(this.el);
    this.timer = setInterval(() => this.tick(), 250);
  }

  state() { return this.hass?.states?.[this.entityId]; }
  call(service, data = {}) { this.hass?.callService('media_player', service, { entity_id: this.entityId, ...data }); }

  update(hass) {
    this.hass = hass;
    const st = this.state();
    if (!st) return;
    const a = st.attributes || {};
    const $ = this.$;
    const pic = a.entity_picture ? `url("${a.entity_picture}")` : '';
    if (this.pic !== pic) {
      this.pic = pic;
      $('.snp-cover').style.backgroundImage = pic;
      $('.snp-bg').style.backgroundImage = pic;
    }
    $('.snp-title').textContent = a.media_title || (st.state === 'idle' ? 'Nothing playing' : a.friendly_name || '');
    $('.snp-sub').textContent = [a.media_artist, a.media_album_name].filter(Boolean).join(' · ');
    $('.snp-play').innerHTML = svg(st.state === 'playing' ? ICONS.pause : ICONS.play);
    $('.snp-dur').textContent = fmt(a.media_duration);
    const vol = $('.snp-vol');
    vol.style.visibility = typeof a.volume_level === 'number' ? 'visible' : 'hidden';
    if (typeof a.volume_level === 'number' && document.activeElement !== vol.querySelector('input')) vol.querySelector('input').value = Math.round(a.volume_level * 100);
    $('.snp-where').textContent = a.source ? `Playing on ${a.source}` : '';
    const track = (a.media_content_id || '').startsWith('track:') ? a.media_content_id : null;
    if (track !== this.lyricsFor) this.loadLyrics(track);
    this.tick();
  }

  async loadLyrics(track) {
    this.lyricsFor = track;
    this.lyrics = null;
    this.activeLine = -1;
    this.renderLyrics();
    if (!track || !this.hass) return;
    try {
      const res = await this.hass.callWS({ type: 'slopify/lyrics', entity_id: this.entityId });
      if (this.lyricsFor === track) { this.lyrics = res?.lines?.length ? res : null; this.renderLyrics(); }
    } catch { /* no lyrics: the space stays empty */ }
  }

  renderLyrics() {
    const box = this.$('.snp-lyrics'); const lines = this.$('.snp-lines');
    lines.style.transform = 'translateY(0)';
    if (!this.lyrics) { lines.innerHTML = ''; box.classList.remove('snp-plain'); return; }
    this.synced = this.lyrics.lines.some((l) => typeof l.start === 'number');
    box.classList.toggle('snp-plain', !this.synced);
    lines.innerHTML = this.lyrics.lines.map((l) => `<div class="snp-line">${(l.text || '♪').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</div>`).join('');
  }

  position() {
    const st = this.state(); const a = st?.attributes || {};
    if (typeof a.media_position !== 'number') return 0;
    let p = a.media_position;
    if (st.state === 'playing' && a.media_position_updated_at) p += (Date.now() - Date.parse(a.media_position_updated_at)) / 1000;
    return Math.min(p, a.media_duration || p);
  }

  tick() {
    const st = this.state(); if (!st) return;
    const a = st.attributes || {};
    const pos = this.position();
    this.$('.snp-pos').textContent = fmt(pos);
    this.$('.snp-fill').style.width = a.media_duration ? `${Math.min(100, (pos / a.media_duration) * 100)}%` : '0';
    if (!this.lyrics || !this.synced) return;
    const ls = this.lyrics.lines;
    let i = -1;
    for (let n = 0; n < ls.length; n++) if (typeof ls[n].start === 'number' && ls[n].start / 1000 <= pos + 0.25) i = n;
    if (i === this.activeLine) return;
    this.activeLine = i;
    const els = this.$('.snp-lines').children;
    for (let n = 0; n < els.length; n++) els[n].classList.toggle('on', n === i);
    const box = this.$('.snp-lyrics');
    const target = els[Math.max(0, i)];
    if (target) this.$('.snp-lines').style.transform = `translateY(${Math.max(0, target.offsetTop - box.clientHeight * 0.38) * -1}px)`;
  }

  close() {
    clearInterval(this.timer);
    document.removeEventListener('keydown', this.onKey);
    this.el.remove();
    this.onClose?.();
  }
}

class SlopifyNowPlayingCard extends HTMLElement {
  setConfig(config) {
    if (!config?.entity) throw new Error('Choose a Slopify player (entity)');
    this._config = config;
    this._inner = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._inner) this._inner.hass = hass;
    else this._build();
    this._view?.update(hass);
  }

  async _build() {
    if (this._building) return;
    this._building = true;
    const helpers = await window.loadCardHelpers();
    const inner = helpers.createCardElement({ type: 'media-control', entity: this._config.entity });
    inner.hass = this._hass;
    this.replaceChildren(inner);
    this._inner = inner;
    this.addEventListener('click', (e) => {
      // The card's own buttons, seek bar and menu keep their jobs.
      const own = e.composedPath().some((el) => el.tagName && /^(HA-ICON-BUTTON|HA-SLIDER|HA-BUTTON|BUTTON|MWC-|HA-SVG-ICON)/.test(el.tagName));
      if (!own) this.open();
    });
  }

  open() {
    if (this._view) return;
    this._view = new NowPlayingView(this._config.entity, () => { this._view = null; });
    this._view.update(this._hass);
  }

  getCardSize() { return this._inner?.getCardSize?.() ?? 3; }

  static getStubConfig(hass) {
    const entity = Object.keys(hass.states).find((e) => e.startsWith('media_player.slopify'));
    return { entity: entity || '' };
  }
}

if (!customElements.get('slopify-now-playing')) {
  customElements.define('slopify-now-playing', SlopifyNowPlayingCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'slopify-now-playing',
    name: 'Slopify Now Playing',
    description: 'The media control card; tap it for a full-screen Now Playing view with the cover, controls and synced lyrics.',
  });
}
