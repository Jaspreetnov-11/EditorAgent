// 🎨 Lumetri-style curves (public/js/colormath.js): straight curves change nothing, an S-curve adds contrast,
// a Hue vs Sat dip only touches that colour, and the render's baked .cube is the same maths.
import { test, eq as same } from './harness.mjs';
import { curveTable, curveTables, applyCurves, hasCurves, isNeutral } from '../public/js/colormath.js';

const near = (a, b, d = 0.01) => a.every((v, i) => Math.abs(v - b[i]) <= d);
test('no curves = no change', () => {
  same(hasCurves({}), false); same(isNeutral({ curves: {} }), true);
  const T = curveTables({});
  for (const p of [[0.1, 0.5, 0.9], [0.8, 0.2, 0.3], [0.5, 0.5, 0.5]]) same(near(applyCurves(p, T), p), true, String(p));
});
test('an S-curve darkens shadows and lifts highlights, never overshoots', () => {
  const t = curveTable([[0, 0], [0.25, 0.15], [0.75, 0.85], [1, 1]], 'rgb');
  same(t[64] < 0.2, true); same(t[191] > 0.8, true);
  same(t.every((v, i) => i === 0 || v >= t[i - 1] - 1e-6), true, 'monotone');
  same(isNeutral({ curves: { m: [[0.25, 0.15]] } }), false);
});
test('Hue vs Sat at orange desaturates orange but leaves blue alone', () => {
  const T = curveTables({ hue: { hs: [[0.0, 0.5], [0.08, 0.1], [0.16, 0.5]] } });
  const o = applyCurves([0.95, 0.55, 0.15], T), b = applyCurves([0.15, 0.35, 0.8], T);
  same(Math.max(...o) - Math.min(...o) < 0.4, true, 'orange less saturated');
  same(near(b, [0.15, 0.35, 0.8], 0.02), true, 'blue unchanged');
});
test('the renderer bakes curves into a .cube', async () => {
  const { colorFilters } = await import('../engine/color.mjs');
  const f = colorFilters({ curves: { m: [[0.5, 0.6]] } }, { stage: (p) => p });
  same(f.length, 1); same(/^lut3d=file=.*post-[0-9a-f]+\.cube/.test(f[0]), true);
});
test('Lumetri: a switched-off section is left out, values stay', async () => {
  const { activeGrade, isNeutral } = await import('../public/js/colormath.js');
  const c = { exposure: 1, vig: { amount: -0.5 }, off: { vignette: true, basic: true } };
  same(activeGrade(c).vig, undefined); same(activeGrade(c).exposure, undefined); same(c.vig.amount, -0.5);
  same(isNeutral(c), true); same(isNeutral({ vig: { amount: -0.5 } }), false);
});
test('Lumetri: HSL secondary changes only the picked colour; the render bakes it', async () => {
  const { postFn } = await import('../public/js/colormath.js');
  const f = postFn({ hsl: { hue: 0.08, width: 0.15, sat2: 0 } });
  const o = f([0.9, 0.5, 0.1]), b = f([0.2, 0.3, 0.8]);
  same(Math.max(...o) - Math.min(...o) < 0.02, true, 'orange greyed'); same(near(b, [0.2, 0.3, 0.8]), true, 'blue kept');
  const { colorFilters } = await import('../engine/color.mjs');
  same(colorFilters({ hsl: { hue: 0.08, sat2: 0 }, vig: { amount: -0.4 } }, { stage: (p) => p }).map((x) => x.split('=')[0]), ['lut3d', 'format']);
});
