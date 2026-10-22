// 🎬 / ✨ Motion comps and Fusions on the edit go on V3 or higher, never over another clip - a busy V3 sends them to V4,
// and a clip made from a clip on V4 goes above it.
import { test, assert, eq as same } from './harness.mjs';
import { newProject, compTrack, trackList } from '../public/js/model.js';

const clip = (start, dur) => ({ id: `c${start}`, type: 'title', start, dur, text: 'x' });

test('a comp goes on V3 when V3 is free (V2 is left for titles and B-roll)', () => {
  const p = newProject('t');
  same(compTrack(p, 2, 3), 'V3');
  assert(Array.isArray(p.tracks.V3) && p.trackState.V3, 'V3 made in the project, not only shown');
});

test('V3 busy at that time: the track above, a new one when none is free', () => {
  const p = newProject('t');
  p.tracks.V3 = [clip(1, 4)];
  same(compTrack(p, 2, 3), 'V4');
  p.tracks.V4.push(clip(4, 2));
  same(compTrack(p, 2, 3), 'V5');
  // free again after the busy clips end; touching ends are not an overlap
  same(compTrack(p, 6, 2), 'V3');
  same(compTrack(p, 5, 1), 'V3');
});

test('made from a clip on V4: above it, on V5', () => {
  const p = newProject('t');
  p.tracks.V4 = [clip(0, 10)];
  p.trackState.V4 = { mute: false, hide: false, lock: false, volume: 1 };
  same(compTrack(p, 0, 10, {}, 'V4'), 'V5');
  same(trackList(p).filter((t) => t.kind === 'video')[0].id, 'V5');
});
