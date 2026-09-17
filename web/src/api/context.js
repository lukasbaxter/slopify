// The queue context id for an entity. Artists are prefixed so the player can
// tell "keep playing this artist" from "start this album/playlist over" when
// the queue runs out. Strip it with ctxItemId() before asking Jellyfin.
export const ctxOf = (it) => (it?.Type === 'MusicArtist' ? `artist:${it.Id}` : it?.Id ?? null);
export const ctxItemId = (ctx) => (typeof ctx === 'string' && ctx.startsWith('artist:') ? ctx.slice(7) : ctx);
