// 🎬 Motion (public/js/motion.js): keyframes + easing, wiggle, stopwatch, parenting, text range selector, presets.
import { test, eq as same } from './harness.mjs';
import * as M from '../public/js/motion.js';

const near = (a, b, d = 1e-3) => Math.abs(a - b) <= d;
test('keyframes interpolate with the segment ease; hold keeps the value', () => {
  let p = M.setKey(0, 0, 0); p = M.setKey(p, 2, 100);
  same(near(M.val(p, 1), 50), true, 'linear half way');
  p.k[0].e = [...M.EASE.easy]; same(near(M.val(p, 1), 50, 0.5), true, 'easy ease is symmetric');
  same(M.val(p, 0.4) < 20, true, 'easy ease starts slow');
  p.k[0].hold = true; same(M.val(p, 1.9), 0);
  same(M.val(M.setKey(M.setKey('#000000', 0, '#000000'), 1, '#ffffff'), 0.5), '#808080');
});
test('stopwatch on/off, delete the last key, wiggle on a still value', () => {
  const on = M.stopwatch(42, 1); same(M.animated(on), true); same(M.val(on, 5), 42);
  same(M.stopwatch(on, 1), 42);
  same(M.delKey(on, 1), 42);
  const w = M.setWiggle(50, 0, { freq: 2, amp: 10 });
  same(Math.abs(M.val(w, 1.37) - 50) <= 10, true); same(M.val(w, 1.37), M.val(w, 1.37), 'repeatable');
  same(M.setWiggle(w, 0, null), 50);
});
test('a child follows its parent', () => {
  const c = M.newComp('t', 1000, 1000, 2), P = M.newLayer('null', c), C = M.newLayer('solid', c);
  P.tr.position = [500, 500]; P.tr.rotation = 90; C.parent = P.id; C.tr.position = [100, 0];
  c.layers = [C, P];
  const [x, y] = M.apply(M.worldMatrix(c, C, 0), [0, 0]);
  same(near(x, 500, 0.01) && near(y, 600, 0.01), true, `${x},${y}`);
});
test('range selector: square covers whole units, offset moves it', () => {
  same(M.selectorAmount({ start: 0, end: 50 }, 0, 4, 0), 1);
  same(M.selectorAmount({ start: 0, end: 50 }, 3, 4, 0), 0);
  same(M.selectorAmount({ start: 0, end: 50, offset: 50 }, 3, 4, 0), 1);
  same(near(M.selectorAmount({ start: 0, end: 100, shape: 'rampUp' }, 0, 2, 0), 0.25), true);
});
test('every preset makes a comp whose layers and keys are valid', () => {
  for (const [k, p] of Object.entries(M.COMP_PRESETS)) {
    const c = p.make(1920, 1080);
    same(c.layers.every((L) => L.id && L.tr && L.out > L.in), true, k);
    for (const L of c.layers) for (const r of M.layerKeys(L)) same(r.keys.every((x, i) => i === 0 || x.t >= r.keys[i - 1].t), true, `${k} keys sorted`);
  }
});
test('parallax: near layers move with the camera, far ones less; no depth = not at all', () => {
  const c = { w: 1920, h: 1080, camera: { pos: [100, 0], zoom: 1 }, layers: [] };
  const at = (L) => M.apply(M.worldMatrix(c, L, 0), [0, 0])[0];
  same(at({ tr: M.tr0(1920, 1080), depth: 0 }), 860);
  same(at({ tr: M.tr0(1920, 1080), depth: 300 }), 935);
  same(at({ tr: M.tr0(1920, 1080) }), 960);
});
