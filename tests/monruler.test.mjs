// 📏 monitor rulers: the marks along a ruler are in the frame's own pixels and sit where the picture is drawn.
import { test, eq as same, assert } from './harness.mjs';
import { rulerTicks, toFramePx, RULER } from '../public/js/monruler.js';

test('a 1080 px wide frame drawn 270 px wide: labels every 200 px, 0 at the picture\'s left edge', () => {
  const t = rulerTicks(40, 0.25, 40 + 270);
  same(t.filter((x) => x.label).map((x) => x.label), ['0', '200', '400', '600', '800', '1000']);
  const zero = t.find((x) => x.v === 0);
  same(zero.pos, 40, 'frame pixel 0 is at the picture\'s edge');
  same(t.find((x) => x.v === 1000).pos, 290);
  const gaps = t.slice(1).map((x, i) => x.pos - t[i].pos);
  assert(gaps.every((g) => g >= 6), 'small marks at least 6 px apart');
  assert(t.some((x) => x.kind === 'mid'), 'half-way marks between the labels');
});

test('zoomed in past the ruler\'s start: negative offset starts mid-frame, 100% zoom labels every 50 px', () => {
  const t = rulerTicks(-500, 1, 400);
  assert(t[0].pos >= 0 && t[0].v >= 500, 'starts where the ruler starts');
  same(t.filter((x) => x.label).map((x) => +x.label), [500, 550, 600, 650, 700, 750, 800, 850, 900]);
  // the area left of the picture counts down into negative pixels, like Premiere
  assert(rulerTicks(100, 1, 300).some((x) => x.v < 0), 'pixels left of the frame are negative');
});

test('nothing drawn without a scale or length; huge frames stay bounded', () => {
  same(rulerTicks(0, 0, 300), []);
  same(rulerTicks(0, -1, 300), []);
  same(rulerTicks(0, 1, 0), []);
  same(rulerTicks(NaN, 1, 300), []);
  assert(rulerTicks(0, 0.001, 5000).length < 3000);
});

test('a point on the picture -> frame pixels; the ruler is 16 px', () => {
  same(toFramePx(140, 40, 0.25), 400);
  same(toFramePx(39, 40, 0.25), -4);
  same(RULER, 16);
});
