// 🖥 helper PCs (Phase 23): which PC gets a project, and the editor's files swapped for placeholders (engine/helpers.mjs)
import { test, assert, eq } from './harness.mjs';
import { helperScore, pickHelper, toTaskArgs } from '../engine/helpers.mjs';

const pc = (id, cores, more = {}) => ({ id, name: `PC-${id}`, specs: { cores, ramGB: 16, nvenc: false, ffprobe: true, ...more } });

test('a stronger PC counts for more; an NVIDIA encoder counts a lot', () => {
  assert(helperScore({ cores: 16 }) > helperScore({ cores: 8 }));
  assert(helperScore({ cores: 8, nvenc: true }) > helperScore({ cores: 12 }));
  eq(helperScore({}), 1);
});

test('projects are spread by strength and stay on their PC', () => {
  const hs = [pc('a', 24), pc('b', 8)], as = new Map();
  const got = ['p1', 'p2', 'p3', 'p4'].map((p) => pickHelper(p, hs, as).id);
  eq(got.filter((x) => x === 'a').length, 3, 'the 24-core PC takes most');
  eq(pickHelper('p2', hs, as).id, got[1], 'a project keeps its PC');
});

test('a pinned project goes to its PC while it is on; a PC that went off gives its projects to another', () => {
  const as = new Map();
  eq(pickHelper('film', [pc('a', 24), pc('b', 8)], as, { film: 'PC-b' }).id, 'b');
  eq(pickHelper('film', [pc('a', 24)], as, { film: 'PC-b' }).id, 'a', 'PC-b is off');
  eq(pickHelper('x', [], as), null);
  eq(pickHelper('x', [{ id: 'old', name: 'Old' }], as), null, 'an old worker (no specs) only renders shots');
});

test('a run that needs FFprobe is done on the editor when the project\'s PC has none', () => {
  const as = new Map();
  eq(pickHelper('p', [pc('a', 8, { ffprobe: false })], as, {}, 'ffprobe'), null);
  eq(as.get('p'), 'a', 'the project still belongs to that PC');
  eq(pickHelper('p', [pc('a', 8, { ffprobe: false })], as).id, 'a');
});

test('a PC in use by its own user takes nothing; a run needing several things goes only where all are', () => {
  const as = new Map(), hs = [pc('a', 24, { torch: true, cv2: true }), pc('b', 8, { cv2: true })];
  eq(pickHelper('p', hs, as, {}, ['torch', 'cv2']).id, 'a');
  hs[0].paused = true;
  eq(pickHelper('p', hs, as, {}, 'cv2').id, 'b', 'the busy PC\'s project went to the other one');
  eq(pickHelper('p', hs, as, {}, ['torch', 'cv2']), null, 'no other PC has a GPU: done on the editor');
});

test('the editor\'s own files become placeholders - every place they appear', () => {
  const f = 'Z:\\Shoot\\A.MXF', o = 'Z:\\P\\cache\\strips\\1.jpg';
  eq(toTaskArgs(['-ss', '1', '-i', f, '-ss', '2', '-i', f, '-y', o], [f], [o]), ['-ss', '1', '-i', '{{IN0}}', '-ss', '2', '-i', '{{IN0}}', '-y', '{{OUT0}}']);
});
