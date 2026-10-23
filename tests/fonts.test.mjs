// 🔤 the fonts of this computer for the font picker (engine/fontnames.mjs): family, weight and italic from the files.
import fs from 'node:fs';
import path from 'node:path';
import { test, eq as same, assert } from './harness.mjs';
import { fontFaces, fontFile, FONT_DIRS } from '../engine/fontnames.mjs';

const arial = FONT_DIRS().map((d) => path.join(d, 'arial.ttf')).find((p) => fs.existsSync(p));

test('a font file gives its family, weight and italic (Arial regular / bold italic)', () => {
  if (!arial) return 'skip';
  same(fontFaces(fs.readFileSync(arial)), [{ family: 'Arial', weight: 400, italic: false }]);
  const bi = path.join(path.dirname(arial), 'arialbi.ttf');
  if (fs.existsSync(bi)) same(fontFaces(fs.readFileSync(bi)), [{ family: 'Arial', weight: 700, italic: true }]);
  same(fontFaces(Buffer.from('not a font at all')), []);
});

test('only a font file in the font folders is handed out - never a path', () => {
  if (!arial) return 'skip';
  assert(fontFile('arial.ttf'), 'arial.ttf is served');
  for (const bad of ['../server.mjs', '..\\server.mjs', 'C:/Windows/win.ini', 'arial.ttf/../x.ttf', 'notes.txt', '']) same(fontFile(bad), null, bad);
});
