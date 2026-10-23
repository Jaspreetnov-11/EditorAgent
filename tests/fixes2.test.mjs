// Fixes from the second round of the timeline / Motion list: old keyboard presets get new commands, A3 is not skipped.
import { test, eq as same, assert } from './harness.mjs';
import { withNew, BUILTIN } from '../public/js/keys.js';
import { newProject, trackList, freeAudioTrack, ensureTrack } from '../public/js/model.js';

test('a keyboard preset made before Alt+↑ / ↓ existed gets them, unless it uses those keys or cleared them', () => {
  const old = JSON.parse(JSON.stringify(BUILTIN.premiere.map)); delete old.trackUp; delete old.trackDown;
  same([withNew(old).trackUp, withNew(old).trackDown], [['Alt+Up'], ['Alt+Down']]);
  const busy = { ...old, nudgeL: ['Alt+Up'] }; // (that key does something else in this preset: it stays so)
  same(withNew(busy).trackUp, []);
  same(withNew({ ...old, trackUp: [] }).trackUp, [], 'a cleared command stays cleared');
});

test('audio tracks: an empty A3 shows once there is an A4; a sound goes on a free A3 before a new track is made', () => {
  const p = newProject('T');
  ensureTrack(p, 'A3'); ensureTrack(p, 'A4'); p.tracks.A4.push({ id: 's', type: 'audio', mediaId: 'm', start: 0 });
  assert(trackList(p).some((t) => t.id === 'A3'), 'A3 shown between A2 and A4');
  const q = newProject('T'); ensureTrack(q, 'A3');
  q.tracks.A1.push({ id: 'v', type: 'audio', mediaId: 'm', start: 0, in: 0, out: 5 });
  same(freeAudioTrack(q, { m: { duration: 5 } }, 0, 5), 'A3');
});
