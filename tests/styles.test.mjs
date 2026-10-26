// 🎓 every editor's style (engine/styles.mjs): only the clips an editor's own edit touched are theirs - templates (one per
// clip, the latest state) and LUTs (counted once per clip); comps / node graphs are left out; a file per editor
import { test, eq, assert } from './harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStyles } from '../engine/styles.mjs';

const project = () => ({ tracks: {
  V1: [{ id: 'v1', type: 'video', color: { lut: 'Warm.cube', look: 'Film.cube' } }, { id: 'v2', type: 'video', color: { lut: 'Cold.cube' } }],
  V2: [{ id: 'g1', type: 'graphic', dur: 4, gfx: { tpl: 'op_cinema', title: 'नई उड़ान' } }, { id: 'c1', type: 'graphic', gfx: { tpl: 'comp' } }],
} });

test('styles: an edit counts only the clips it touched, for the editor who made it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-styles-')), st = createStyles(dir), pj = project();
  st.learn('Aman', 'Reel', pj, [{ o: 'set', p: ['tracks', 'V2', '#g1', 'gfx', 'title'], v: 'नई उड़ान' }, { o: 'set', p: ['tracks', 'V1', '#v1', 'color', 'lut'], v: 'Warm.cube' }]);
  const a = st.get('Aman');
  eq(a.templates.length, 1); eq(a.templates[0].tpl, 'op_cinema'); eq(a.templates[0].dur, 4);
  eq(Object.keys(a.luts).sort(), ['look:Film.cube', 'lut:Warm.cube']); // (v2's Cold.cube was not touched)
  eq(st.get('Riya').templates.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('styles: typing in a graphic keeps one template (latest words); a LUT counts once per clip; comps are skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-styles-')), st = createStyles(dir), pj = project();
  for (const w of ['N', 'Ne', 'New']) { pj.tracks.V2[0].gfx.title = w; st.learn('Aman', 'Reel', pj, [{ o: 'set', p: ['tracks', 'V2', '#g1', 'gfx', 'title'], v: w }]); }
  st.learn('Aman', 'Reel', pj, [{ o: 'set', p: ['tracks', 'V1', '#v1', 'color', 'lut'], v: 'Warm.cube' }]);
  st.learn('Aman', 'Reel', pj, [{ o: 'set', p: ['tracks', 'V1', '#v1', 'color', 'lut'], v: 'Warm.cube' }]);
  st.learn('Aman', 'Reel', pj, [{ o: 'set', p: ['tracks', 'V2', '#c1', 'gfx'], v: { tpl: 'comp' } }]);
  const a = st.get('Aman');
  eq(a.templates.length, 1); eq(a.templates[0].gfx.title, 'New');
  eq(a.luts['lut:Warm.cube'].uses, 1);
  st.flush();
  assert(fs.existsSync(path.join(dir, 'Aman.json')), 'a file per editor');
  eq(st.list()[0].name, 'Aman');
  fs.rmSync(dir, { recursive: true, force: true });
});
