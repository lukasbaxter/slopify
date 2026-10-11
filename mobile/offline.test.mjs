// node --test mobile/offline.test.mjs: the library bookkeeping in offline.js
// (the parts that need no phone). The module imports expo-file-system and the
// page, so the pure functions are loaded from its source with those stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'offline.js'), 'utf8')
  .replace("import * as FS from 'expo-file-system/legacy';", 'const FS = { documentDirectory: "file:///docs/" };')
  .replace("import PAGE from './offlinePage';", 'const PAGE = "";');
const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
const { emptyLib, upsert, remove, summary, pageData, hasSongs } = mod;

const tr = (id, albumId = 'al1') => ({ id, title: `T${id}`, artist: 'A', album: 'Al', albumId, durationMs: 1000 });
const got = (lib, id, albumId = 'al1') => { lib.tracks[id].file = `t/${id}.m4a`; lib.tracks[id].bytes = 10; lib.tracks[id].cover = `c/${albumId}.jpg`; };

test('upsert lists only songs not on the phone, once each', () => {
  const lib = emptyLib();
  assert.deepEqual(upsert(lib, { id: 'p1', name: 'One' }, [tr('a'), tr('b'), tr('a')]), ['a', 'b']);
  got(lib, 'a');
  assert.deepEqual(upsert(lib, { id: 'p2', name: 'Two' }, [tr('a'), tr('c')]), ['c']);
  assert.equal(lib.tracks.a.file, 't/a.m4a'); // re-adding keeps the file
  assert.equal(lib.collections[0].id, 'p2'); // newest first
  assert.deepEqual(upsert(lib, { id: 'p1', name: 'One again' }, [tr('a')]), []); // replaced in place
  assert.equal(lib.collections.length, 2); assert.equal(lib.collections.find((c) => c.id === 'p1').name, 'One again');
});

test('remove deletes only songs and covers nothing else holds', () => {
  const lib = emptyLib();
  upsert(lib, { id: 'p1', name: 'One', cover: 'c/col-p1.jpg' }, [tr('a'), tr('b', 'al2')]);
  upsert(lib, { id: 'p2', name: 'Two' }, [tr('a'), tr('c')]);
  got(lib, 'a'); got(lib, 'b', 'al2'); got(lib, 'c');
  const files = remove(lib, 'p1');
  assert.deepEqual(files.sort(), ['c/al2.jpg', 'c/col-p1.jpg', 't/b.m4a']);
  assert.ok(lib.tracks.a && lib.tracks.c && !lib.tracks.b);
  assert.deepEqual(remove(lib, 'nope'), []);
  assert.deepEqual(remove(lib, 'p2').sort(), ['c/al1.jpg', 't/a.m4a', 't/c.m4a']);
  assert.equal(hasSongs(lib), false);
});

test('summary and page data count what is on the phone', () => {
  const lib = emptyLib();
  upsert(lib, { id: 'p1', name: 'One' }, [tr('a'), tr('b')]);
  assert.equal(hasSongs(lib), false);
  got(lib, 'a');
  assert.deepEqual(summary(lib), { bytes: 10, collections: [{ id: 'p1', name: 'One', kind: 'playlist', total: 2, have: 1 }] });
  const p = pageData(lib, 'No connection');
  assert.deepEqual(Object.keys(p.tracks), ['a']); assert.equal(p.note, 'No connection'); assert.equal(hasSongs(lib), true);
});
