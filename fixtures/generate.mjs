// The fixture library: 30 short generated tracks with real tags, folder
// covers, .lrc sidecars, one deliberately mistagged file and one
// instrumental. Generated (never committed) so CI and local tests run
// against a library that is not anyone's real one. Needs ffmpeg.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] || 'fixtures/music');
const ARTISTS = [
  { name: 'The Fixture Band', albums: [{ title: 'First Light', year: 2019, n: 8 }, { title: 'Second Wind', year: 2021, n: 6 }] },
  { name: 'Ada Lovelace', albums: [{ title: 'Analytical', year: 2020, n: 7 }] },
  { name: 'Various Artists', albums: [{ title: 'Sampler', year: 2022, n: 9, various: true }] },
];
const WORDS = ['river', 'signal', 'window', 'harbour', 'ember', 'lantern', 'meadow', 'static', 'orbit', 'velvet'];
const pick = (i, k) => WORDS[(i * 7 + k * 3) % WORDS.length];

fs.rmSync(OUT, { recursive: true, force: true });
let n = 0;
for (const artist of ARTISTS) {
  for (const album of artist.albums) {
    const dir = path.join(OUT, artist.name, album.title);
    fs.mkdirSync(dir, { recursive: true });
    // a folder cover: solid colour PNG with a stripe, 600x600
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${((0x224466 + n * 0x111111) & 0xffffff).toString(16).padStart(6, '0')}:s=600x600`, '-frames:v', '1', path.join(dir, 'cover.png')]);
    for (let t = 1; t <= album.n; t++) {
      n++;
      const title = `${pick(n, 1)} ${pick(n, 2)}`.replace(/\b\w/g, (c) => c.toUpperCase());
      const trackArtist = album.various ? `Guest ${t}` : artist.name;
      const secs = 4 + (n % 5); // 4-8 s each
      const instrumental = n === 11;
      const mistagged = n === 23; // tags claim another artist/title than the folder
      const file = path.join(dir, `${String(t).padStart(2, '0')}. ${title}.mp3`);
      const meta = mistagged
        ? { title: 'Wrong Title', artist: 'Wrong Artist', album: 'Wrong Album' }
        : { title, artist: trackArtist, album: album.title };
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${220 + n * 17}:duration=${secs}`, '-ac', '2', '-ar', '44100', '-b:a', '128k',
        '-metadata', `title=${meta.title}`, '-metadata', `artist=${meta.artist}`, '-metadata', `album=${meta.album}`,
        '-metadata', `album_artist=${album.various ? 'Various Artists' : artist.name}`, '-metadata', `track=${t}/${album.n}`, '-metadata', `date=${album.year}`,
        '-metadata', `genre=${n % 2 ? 'Electronic' : 'Folk'}`, file]);
      if (!instrumental && n % 4 !== 0) {
        const lines = [];
        for (let s = 0; s < secs; s += 1.5) lines.push(`[00:${String(Math.floor(s)).padStart(2, '0')}.${String(Math.round((s % 1) * 100)).padStart(2, '0')}] line ${Math.floor(s / 1.5) + 1} of ${title}`);
        fs.writeFileSync(file.replace(/\.mp3$/, '.lrc'), lines.join('\n') + '\n');
      }
    }
  }
}
console.log(`fixture library: ${n} tracks in ${OUT}`);
