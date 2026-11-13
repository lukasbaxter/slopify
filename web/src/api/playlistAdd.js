// "Add to playlist", the one way every menu does it (API.md 8.2): ask the
// server which songs the playlist has, ask about each one again (or about
// all of them at once), then one POST with what is kept.
import { t } from '../i18n.js';

// true for a song the playlist has, or one that came earlier in the batch.
export function markDuplicates(ids, existing) {
  const seen = new Set(existing);
  return ids.map((id) => { const dup = seen.has(id); seen.add(id); return dup; });
}

export function addedToast(name, added, skipped) {
  if (!skipped) return t('Added to {name}', { name });
  if (!added) return t('Already in {name}', { name });
  return t('Added {added} to {name}, skipped {skipped} already there', { added, name, skipped });
}

// ask({ track, playlist, left }) resolves { add, all }; left counts this one.
// Resolves { added, skipped }.
export async function addTracksToPlaylist(jf, playlist, tracks, ask) {
  const ids = tracks.map((x) => x.Id);
  if (!ids.length) return { added: 0, skipped: 0 };
  const dups = markDuplicates(ids, await jf.playlistContains(playlist.Id, [...new Set(ids)]));
  let left = dups.filter(Boolean).length, forAll = null;
  const keep = [];
  for (let i = 0; i < ids.length; i++) {
    if (!dups[i]) { keep.push(ids[i]); continue; }
    let add = forAll;
    if (add === null) {
      const a = await ask({ track: tracks[i], playlist, left });
      add = !!a?.add;
      if (a?.all) forAll = add;
    }
    if (add) keep.push(ids[i]);
    left--;
  }
  if (keep.length) await jf.addToPlaylist(playlist.Id, keep);
  return { added: keep.length, skipped: ids.length - keep.length };
}
