// ⇋ Sync Lock on every track, like Premiere: a ripple on one track moves the sync-locked others, the main story too.
import { test, eq as same } from './harness.mjs';
import { syncShift, shiftStory, placed } from '../public/js/model.js';

const T = (id, dur) => ({ id, type: 'title', text: id, dur });
const G = (dur) => ({ id: `g${dur}`, type: 'title', gap: true, text: '', bg: '#000000', dur });
const proj = (v1, ts = {}) => ({ settings: {}, markers: [], trackState: ts, tracks: { V1: v1, V2: [{ id: 't', type: 'title', start: 6, dur: 2 }], A1: [{ id: 'a', type: 'audio', start: 6, in: 0, out: 2 }], A2: [{ id: 'm', type: 'audio', start: 6, in: 0, out: 2 }] } });
const starts = (p) => placed(p, {}).V1.map((x) => [x.clip.id, x.start]);

test('a ripple on A2 moves the sync-locked tracks, not A2 itself, not the unlocked ones', () => {
  const p = proj([T('s1', 4)], { V2: { sync: true }, A1: { sync: true } });
  syncShift(p, 5, -1, 'A2');
  same([p.tracks.V2[0].start, p.tracks.A1[0].start, p.tracks.A2[0].start], [5, 5, 6]);
});

test('a ripple on V1 (as before) never moves V1 through syncShift', () => {
  const p = proj([T('s1', 4)], { V1: { sync: true }, V2: { sync: true } });
  syncShift(p, 5, 2);
  same(p.tracks.V2[0].start, 8);
  same(starts(p), [['s1', 0]]);
});

test('V1 follows a ripple delete elsewhere across an empty stretch', () => {
  const p = proj([T('s1', 4), G(3), T('s2', 2)]);
  same(shiftStory(p, {}, 6, -2), true);
  same(starts(p), [['s1', 0], ['g3', 4], ['s2', 5]]);
});

test('V1 stays put where a shot is in the stretch (no shot is cut to keep sync)', () => {
  const p = proj([T('s1', 4), G(1), T('s2', 2)]);
  same(shiftStory(p, {}, 6, -2), false);
  same(starts(p), [['s1', 0], ['g1', 4], ['s2', 5]]);
});

test('V1 opens a gap for a ripple that pushes later (or grows the gap already there)', () => {
  const p = proj([T('s1', 4), T('s2', 2)]);
  shiftStory(p, {}, 4, 1.5);
  same(starts(p).map((x) => x[1]), [0, 4, 5.5]);
  shiftStory(p, {}, 5.5, 0.5);
  same(starts(p).map((x) => x[1]), [0, 4, 6]);
});

test('past the end of the main story nothing changes', () => {
  const p = proj([T('s1', 4)]);
  same(shiftStory(p, {}, 9, -2), true);
  same(starts(p), [['s1', 0]]);
});
