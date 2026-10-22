// ⏩ Speed-ramp eases (model.js RAMP_EASES, like After Effects / Premiere): a ramp's shape between two keyframes, and a
// cut part of a ramped shot keeps its segment's ease.
import { test, assert, eq } from './harness.mjs';
import { profileAt, rampPart } from '../public/js/model.js';

const pts = (mode) => [[0, 1, ...(mode ? [0, 1, mode] : [])], [1, 3]];

test('Linear / Ease In / Ease Out / Easy Ease / Hold shape the ramp between two speeds', () => {
  eq(+profileAt(pts('linear'), 0.5).toFixed(3), 2);
  assert(profileAt(pts('in'), 0.5) < 2, 'Ease In starts gently');
  assert(profileAt(pts('out'), 0.5) > 2, 'Ease Out arrives gently');
  eq(+profileAt(pts(), 0.5).toFixed(3), 2, 'Easy Ease (S-curve) is half-way at the middle');
  assert(profileAt(pts(), 0.1) < profileAt(pts('linear'), 0.1), 'Easy Ease starts slower than Linear');
  eq(profileAt(pts('hold'), 0.99), 1, 'Hold keeps the first speed');
  eq(profileAt(pts('hold'), 1), 3, '…and jumps at the next keyframe');
  for (const m of [undefined, 'linear', 'in', 'out']) { eq(+profileAt(pts(m), 0).toFixed(3), 1); eq(+profileAt(pts(m), 1).toFixed(3), 3); }
});

test('a cut part of a ramped shot keeps the ease of its segment', () => {
  const c = { type: 'video', in: 0, out: 20, ramp: 'custom', rampPts: [[0, 1, 0, 1, 'in'], [1, 3]] };
  const half = rampPart(c, 0, 0.5, 10);
  eq(half.rampPts[0][4], 'in');
  // and plays the same speeds as before the cut
  for (const u of [0.1, 0.25, 0.4]) eq(+profileAt(half.rampPts, u / 0.5).toFixed(2), +profileAt(c.rampPts, u).toFixed(2));
});
