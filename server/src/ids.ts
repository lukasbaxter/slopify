// Identity that survives renames and retags: a track's id is the MD5 of its
// DECODED audio (ffmpeg -f md5), so moving or retagging a file keeps every
// like, play and playlist row pointing at it. Albums and artists hash their
// names. Jellyfin's id for the same file is kept as an alias for migration.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function audioContentId(file: string): Promise<string> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'md5', '-'], { maxBuffer: 1 << 20 });
  const m = /MD5=([0-9a-f]{32})/i.exec(stdout);
  if (!m) throw new Error(`no audio hash for ${file}`);
  return m[1].toLowerCase();
}

export const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
export const artistId = (name: string) => crypto.createHash('sha1').update(`artist:${norm(name)}`).digest('hex').slice(0, 32);
export const albumId = (albumArtist: string, album: string) => crypto.createHash('sha1').update(`album:${norm(albumArtist)}|${norm(album)}`).digest('hex').slice(0, 32);
export const playlistId = () => crypto.randomBytes(16).toString('hex');
export const userId = () => crypto.randomBytes(16).toString('hex');
export const token = () => crypto.randomBytes(32).toString('base64url');

// Jellyfin: MD5 of UTF-16LE(type + path), then .NET Guid byte order.
export function jellyfinId(type: string, filePath: string): string {
  const h = crypto.createHash('md5').update(Buffer.from(type + filePath, 'utf16le')).digest();
  return Buffer.concat([h.subarray(0, 4).reverse(), h.subarray(4, 6).reverse(), h.subarray(6, 8).reverse(), h.subarray(8)]).toString('hex');
}
export const jellyfinAudioId = (jfPath: string) => jellyfinId('MediaBrowser.Controller.Entities.Audio.Audio', jfPath);

// Sort key: articles dropped, case folded ("The Fixture Band" -> "fixture band").
export const sortName = (s: string) => norm(s).replace(/^(the|a|an)\s+/, '');
