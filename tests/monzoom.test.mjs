// 🎚 a monitor's time ruler and its zoom / scroll bar (Premiere's layout): marks for the visible part, round-end drags.
import { test, eq as same, assert } from './harness.mjs';
import { timeTicks, toView, fromView, dragView } from '../public/js/monzoom.js';

test('a 60 s edit over 600 px: labels every 10 s, small marks every 1 s', () => {
  const t = timeTicks(60, 0, 1, 600, 25);
  same(t.filter((x) => x.major).map((x) => x.t), [0, 10, 20, 30, 40, 50, 60]);
  same(t[1].t, 1);
  assert(t.every((x, i) => i === 0 || (x.t - t[i - 1].t) * 10 >= 7), 'marks at least 7 px apart');
});

test('zoomed into 1 s of a clip: marks in frames, only the visible part', () => {
  const t = timeTicks(60, 0.5, 0.5 + 1 / 60, 600, 25);
  assert(t[0].t >= 30 - 1e-6 && t.at(-1).t <= 31 + 1e-6, 'from 30 s to 31 s');
  assert(t.some((x) => Math.abs(x.t * 25 - Math.round(x.t * 25)) < 1e-6 && x.t % 1 !== 0), 'marks on frames');
  assert(t.length < 200);
});

test('nothing to draw without a length, a width or a view', () => {
  same(timeTicks(0, 0, 1, 500), []);
  same(timeTicks(10, 0, 1, 0), []);
  same(timeTicks(10, 0.5, 0.5, 500), []);
});

test('view maths: a time share <-> the ruler, the bar keeps inside 0..1 and a minimum width', () => {
  same(toView(0.5, 0.25, 0.75), 50);
  same(fromView(0.5, 0.25, 0.75), 0.5);
  same(dragView([0.2, 0.4], 'mid', 0.7), [0.8, 1], 'the middle stops at the end');
  same(dragView([0.2, 0.4], 'l', 0.5), [0.39, 0.4]);
  same(dragView([0.2, 0.4], 'r', 1), [0.2, 1]);
  same(dragView([0.2, 0.4], 'l', -1), [0, 0.4]);
});
