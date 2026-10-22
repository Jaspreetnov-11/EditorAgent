// ✂ cutting a ramped shot keeps the ramp that was drawn: each part gets the user's own points inside it (plus one at
// the cut), not a curve sampled into 24 dots; the parts still play exactly the file the whole shot played.
import { test, assert } from './harness.mjs';
import { rampPart, rampPts, sourceAt } from '../public/js/model.js';

const drawn = [[0, 5], [0.3, 5], [0.45, 0.5], [1, 0.5]];
const shot = () => ({ id: 'c', type: 'video', mediaId: 'm', in: 2, out: 9, ramp: 'custom', rampPts: drawn.map((p) => [...p]) });

test('a cut in the slow part: the first part keeps the drawn points, the second is one flat line', () => {
  const c = shot(), D = 1.6;
  const A = { ...c, ...rampPart(c, 0, 0.7, D) }, B = { ...c, ...rampPart(c, 0.7, 1, D) };
  assert(rampPts(A).length === 4, `first part ${rampPts(A).length} points: ${JSON.stringify(rampPts(A))}`);
  assert(rampPts(B).length === 2, `second part ${rampPts(B).length} points`);
  // nothing lost or doubled at the cut: the parts meet on the same frame, and cover the whole shot's file
  assert(Math.abs(A.out - B.in) < 0.002 && Math.abs(A.in - c.in) < 0.002, `${A.in}-${A.out} | ${B.in}-${B.out}`);
  assert(Math.abs(B.out - sourceAt(c, D, D)) < 0.002);
});

test('a cut inside the ramp itself: original points kept, one more at each end', () => {
  const c = shot(), D = 2;
  const A = { ...c, ...rampPart(c, 0, 0.4, D) };
  assert(rampPts(A).length === 3, JSON.stringify(rampPts(A))); // 0, 0.3 (drawn), the cut
  assert(Math.abs(A.out - sourceAt(c, 0.8, D)) < 0.002);
});
