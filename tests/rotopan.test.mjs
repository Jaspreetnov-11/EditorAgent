// ✒ Pen masks with Bezier curves, 🎯 masks that follow the subject (mask tracking) and 🎧 pan keyframes.
import { test, eq, assert } from './harness.mjs';
import { flattenPen, penPathD, maskAlpha, maskAt, untrackMask, trackFromBoxes, trackAt, maskBox, movedMask, unmovedMask, newMask } from '../public/js/shapemask.js';
import { panGains, trackPanAt, propAt, KEYABLE } from '../public/js/model.js';

const near = (a, b, e = 1e-4) => Math.abs(a - b) < e;

test('pen: corner points stay straight lines; a curved point bends its sides', () => {
  const sq = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
  eq(flattenPen(sq), sq, 'corners only');
  const curved = [[0.5, 0.2, 0.15, 0], [0.8, 0.8], [0.2, 0.8]];
  const F = flattenPen(curved, 8);
  assert(F.length === 3 + 7 + 7, `pieces ${F.length}`); // (side 0->1: its out handle, side 2->0: its in handle - 7 more points each)
  assert(/C/.test(penPathD(curved)) && !/C/.test(penPathD(sq)), 'svg path');
  // a curve point with handles apart (Alt): its in side uses its own handle
  const apart = flattenPen([[0.5, 0.2, 0.1, 0, 0, -0.1], [0.8, 0.8], [0.2, 0.8]], 8);
  assert(apart.length > 3, 'apart');
  // the filled shape: a bulging top edge covers more than the straight triangle
  const W = 96, H = 54, sum = (a) => a.reduce((s, v) => s + v, 0);
  const tri = sum(maskAlpha({ ...newMask('pen'), feather: 0, pts: [[0.5, 0.2], [0.8, 0.8], [0.2, 0.8]] }, W, H));
  const bulge = sum(maskAlpha({ ...newMask('pen'), feather: 0, pts: [[0.5, 0.2, 0.25, 0], [0.8, 0.8], [0.2, 0.8, 0, -0.3]] }, W, H));
  assert(bulge > tri * 1.05, `bulge ${bulge} vs ${tri}`);
});

test('pen handles move with Motion (scaled, not shifted) and back', () => {
  const m = { ...newMask('pen'), pts: [[0.4, 0.4, 0.1, 0.05], [0.6, 0.4], [0.5, 0.6]] };
  const mv = movedMask(m, { zoom: 2, x: 10, y: 0 });
  assert(near(mv.pts[0][2], 0.2) && near(mv.pts[0][3], 0.1), 'handle scaled');
  const back = unmovedMask(mv, { zoom: 2, x: 10, y: 0 });
  back.pts.forEach((p, i) => p.forEach((v, j) => assert(near(v, m.pts[i][j]), `pt ${i}.${j}`)));
});

test('mask tracking: boxes -> moves and growth; the mask follows, holds at the ends, and an edit goes back to the drawn shape', () => {
  const boxes = [{ t: 1, x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, { t: 2, x: 0.5, y: 0.4, w: 0.2, h: 0.2 }, { t: 3, x: 0.5, y: 0.4, w: 0.4, h: 0.4 }];
  eq(trackFromBoxes(boxes).keys.map((k) => k.s), [1, 1, 1], 'position only by default');
  const tr = trackFromBoxes(boxes, { scale: true });
  eq(tr.ax, 0.5); eq(tr.ay, 0.5); eq(tr.keys.map((k) => k.s), [1, 1, 2]);
  const m = { ...newMask('ellipse'), x: 0.5, y: 0.5, w: 0.2, h: 0.2, track: tr };
  const a = maskAt(m, 2), b = maskAt(m, 1.5), c = maskAt(m, 3), before = maskAt(m, 0), after = maskAt(m, 9);
  assert(near(a.x, 0.6) && near(a.w, 0.2), 'moved right');
  assert(near(b.x, 0.55), 'half way');
  assert(near(c.x, 0.6 + 0.1) && near(c.w, 0.4), `grew about the anchor ${c.x}`); // (the box grew from its top-left: its centre moved)
  assert(near(before.x, 0.5) && near(after.x, c.x), 'holds');
  eq(trackAt({ shape: 'ellipse' }, 1), null);
  // edit the shape where it is at t=3 (move it a bit) -> stored as the drawn shape; maskAt gives the edit back
  const edited = { ...c, x: c.x + 0.02 }, stored = untrackMask(edited, 3);
  assert(near(maskAt(stored, 3).x, edited.x) && near(stored.w, 0.2), 'round trip');
  // pen points (and their handles) move and scale too
  const p = { ...newMask('pen'), pts: [[0.45, 0.45, 0.02, 0], [0.55, 0.45], [0.5, 0.55]], track: tr };
  const pc = maskAt(p, 3).pts;
  assert(near(pc[0][2], 0.04), 'handle scaled');
  const box = maskBox(maskAt(p, 3));
  assert(box.w > 0.15 && box.w < 0.25, `box ${box.w}`);
});

test('pan: a balance - the far side turns down; tracks have pan and pan keyframes; clips key pan like volume', () => {
  eq(panGains(0), [1, 1]); eq(panGains(-1), [1, 0]); eq(panGains(1), [0, 1]); eq(panGains(0.5), [0.5, 1]); eq(panGains(7), [0, 1]);
  eq(trackPanAt({}, 3), 0); eq(trackPanAt({ pan: -0.4 }, 3), -0.4);
  assert(near(trackPanAt({ pan: 0.9, panKeys: [{ t: 0, v: -1 }, { t: 2, v: 1 }] }, 1), 0), 'keys win');
  eq(KEYABLE.pan.def, 0);
  eq(propAt({}, 'pan', 1), 0);
  assert(near(propAt({ keys: { pan: [{ t: 0, v: -1 }, { t: 4, v: 1 }] } }, 'pan', 1), -0.5), 'clip pan keys');
});
