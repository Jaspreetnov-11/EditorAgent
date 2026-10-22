// 🧱 Sequence › Arrange layers (and every reference edit): V1 story, V2 adjustment layers, V3 comps / Fusions, V4 text -
// and a clip that would cover another one at the same time goes one track up.
import { test, eq as same } from './harness.mjs';
import { newProject, arrangeLayers } from '../public/js/model.js';

const adj = (id, start, dur) => ({ id, type: 'adjust', start, dur, effects: [] });
const comp = (id, start, dur) => ({ id, type: 'graphic', start, dur, gfx: { tpl: 'comp', comp: {} } });
const text = (id, start, dur) => ({ id, type: 'title', start, dur, text: 'x' });
const broll = (id, start, dur) => ({ id, type: 'image', mediaId: 'm', start, dur });
const where = (p) => Object.fromEntries(Object.entries(p.tracks).flatMap(([t, l]) => l.map((c) => [c.id, t])));

test('looks on V2, comps on V3, text on V4 - whatever track they were on', () => {
  const p = newProject('t');
  p.tracks.V2 = [text('t1', 0, 3), comp('c1', 1, 2)];
  p.tracks.V5 = [adj('a1', 0, 4)];
  arrangeLayers(p);
  same(where(p), { a1: 'V2', c1: 'V3', t1: 'V4' });
});

test('two at the same time: the second goes one track up; one after the other: the same track', () => {
  const p = newProject('t');
  p.tracks.V2 = [text('t1', 0, 3), text('t2', 2, 3), text('t3', 6, 1), adj('a1', 0, 2), adj('a2', 2, 2)];
  arrangeLayers(p);
  const w = where(p);
  same([w.a1, w.a2], ['V2', 'V2']);
  same([w.t1, w.t2, w.t3], ['V4', 'V5', 'V4']);
});

test('b-roll under its look: the look goes above it, the comp and text above that', () => {
  const p = newProject('t');
  p.tracks.V3 = [broll('b1', 0, 4), adj('a1', 1, 2), comp('c1', 1, 1), text('t1', 1, 1)];
  arrangeLayers(p);
  same(where(p), { b1: 'V2', a1: 'V3', c1: 'V4', t1: 'V5' });
});
