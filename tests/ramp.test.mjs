// ⏩ speed ramps up to 10× (Effect Controls graph): the shot keeps its length and plays that much more of the file.
import { test, assert, eq as same } from './harness.mjs';
import { setRamp, rampPts, clipDur, sourceAt } from '../public/js/model.js';

const media = { m1: { id: 'm1', duration: 120 } };

test('a flat 10× ramp: same 2 s on the timeline, 20 s of the file', () => {
  const c = { id: 'c', type: 'video', mediaId: 'm1', in: 0, out: 2 };
  setRamp(c, 'custom', media, [[0, 10], [1, 10]]);
  same(rampPts(c)[0][1], 10);
  assert(Math.abs(clipDur(c, media) - 2) < 0.01, `shot length ${clipDur(c, media)}`);
  assert(Math.abs(c.out - 20) < 0.05, `plays to ${c.out}`);
  assert(Math.abs(sourceAt(c, 1, 2) - 10) < 0.1, 'half way through the shot = 10 s into the file');
});

test('10× into slow motion: faster at the start than at the end', () => {
  const c = { id: 'c', type: 'video', mediaId: 'm1', in: 0, out: 2 };
  setRamp(c, 'custom', media, [[0, 10], [0.4, 10], [0.6, 0.5], [1, 0.5]]);
  const a = sourceAt(c, 0.2, 2) - sourceAt(c, 0, 2), b = sourceAt(c, 2, 2) - sourceAt(c, 1.8, 2);
  assert(a > b * 10, `start ${a.toFixed(2)} s vs end ${b.toFixed(2)} s of file per 0.2 s`);
});
