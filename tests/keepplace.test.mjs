// 📌 a clip stays where it was put: changing a shot's speed or ramp never moves the shots after it on V1.
import { test, assert } from './harness.mjs';
import { keepLength, layoutV1, setRamp, clipDur } from '../public/js/model.js';

const media = { a: { id: 'a', duration: 60 }, b: { id: 'b', duration: 3 }, c: { id: 'c', duration: 60 } };
const proj = () => ({ tracks: { V1: [
  { id: 'v1', type: 'video', mediaId: 'a', in: 0, out: 4 },
  { id: 'v2', type: 'video', mediaId: 'b', in: 0, out: 2 },
  { id: 'v3', type: 'video', mediaId: 'c', in: 0, out: 5 },
  { id: 'v4', type: 'video', mediaId: 'c', in: 10, out: 13 },
] } });
const starts = (p) => Object.fromEntries(layoutV1(p, media).filter((x) => !x.clip.gap).map((x) => [x.clip.id, +x.start.toFixed(3)]));
const same = (a, b) => Object.keys(a).every((k) => Math.abs(a[k] - b[k]) < 0.002);

test('2× speed: the shot keeps its length (plays twice the file), later shots stay put', () => {
  const p = proj(), before = starts(p), c = p.tracks.V1[0], D = clipDur(c, media);
  c.speed = 2; keepLength(p, c, D, media);
  assert(same(before, starts(p)), JSON.stringify(starts(p)));
  assert(Math.abs(c.out - 8) < 0.01, `out ${c.out}`);
});

test('slow motion 0.5×: still the same length on the timeline', () => {
  const p = proj(), before = starts(p), c = p.tracks.V1[2], D = clipDur(c, media);
  c.speed = 0.5; keepLength(p, c, D, media);
  assert(same(before, starts(p)) && Math.abs(clipDur(c, media) - D) < 0.002);
});

test('the file runs out (a 3 s file at 4×): a gap holds the next shots at their timestamps', () => {
  const p = proj(), before = starts(p), c = p.tracks.V1[1], D = clipDur(c, media);
  c.speed = 4; keepLength(p, c, D, media);
  assert(p.tracks.V1[2].gap, 'gap after the shot');
  assert(same(before, starts(p)), JSON.stringify(starts(p)));
});

test('a speed ramp put on a shot: later shots stay put', () => {
  const p = proj(), before = starts(p), c = p.tracks.V1[0], D = clipDur(c, media);
  setRamp(c, 'custom', media, [[0, 10], [0.5, 10], [0.6, 0.5], [1, 0.5]]); keepLength(p, c, D, media);
  assert(same(before, starts(p)), JSON.stringify(starts(p)));
});

test('a transition longer than the shots: every cut stays where it was', async () => {
  const { setTransition } = await import('../public/js/model.js');
  const m = { a: { id: 'a', duration: 60 } };
  const p = { tracks: { V1: [0, 1, 2, 3].map((i) => ({ id: `c${i}`, type: 'video', mediaId: 'a', in: 0.1 + i * 10, out: 0.6 + i * 10 })) } };
  const end0 = layoutV1(p, m).at(-1).end;
  setTransition(p, m, 2, 'fade', 2);
  assert(Math.abs(layoutV1(p, m).at(-1).end - end0) < 0.002, `${end0} -> ${layoutV1(p, m).at(-1).end}`);
});
