// 🛡 normalizeProject: whatever a project file holds, the editor gets something every panel can draw.
import { test, eq as same, assert } from './harness.mjs';
import { normalizeProject, newProject, placed, totalDuration } from '../public/js/model.js';
import { buildAss } from '../public/js/captions.js';

test('captions without a style or cues get them (the CC panel could not open)', () => {
  const p = normalizeProject({ ...newProject('A'), captions: { on: false } });
  assert(Array.isArray(p.captions.cues) && typeof p.captions.style === 'object', 'cues + style');
  assert(buildAss(p.captions, 1920, 1080).includes('Style: Cap'), 'the render can still write its subtitles');
});

test('missing settings / tracks / trackState / markers are filled in; a sound project stays the same', () => {
  const p = normalizeProject({ name: 'B' });
  same(['V1', 'V2', 'A1', 'A2'].every((t) => Array.isArray(p.tracks[t]) && p.trackState[t]), true);
  assert(p.settings.aspect && p.settings.fps && Array.isArray(p.markers), 'settings + markers');
  const good = newProject('C'); good.tracks.V1.push({ id: 'a', type: 'title', text: 'x', dur: 2 });
  const copy = JSON.parse(JSON.stringify(good));
  same(normalizeProject(copy), good);
});

test('junk inside tracks is dropped or repaired, never left for a panel to trip on', () => {
  const p = newProject('D');
  p.tracks.V1 = [null, 5, 'x', { type: 'video', mediaId: 'm', in: 'abc', out: 3, effects: 'blur' }, { type: 'nonsense' }, { id: 'g', type: 'graphic' }];
  p.tracks.V9 = 'not a list'; p.tracks.weird = []; p.trackState = null; p.markers = [{ t: 1 }, { t: 'x' }, 7];
  normalizeProject(p);
  same(p.tracks.V1.length, 2);
  const v = p.tracks.V1[0];
  assert(v.id && !('in' in v) && !('effects' in v), 'a bad number and a bad effects list are taken out');
  assert(p.tracks.V1[1].gfx && p.tracks.V1[1].gfx.tpl, 'a graphic without its drawing gets an empty text');
  same(p.tracks.V9, []); assert(!('weird' in p.tracks), 'not a track id'); same(p.markers, [{ t: 1 }]);
  const media = { m: { duration: 10 } };
  assert(Number.isFinite(totalDuration(p, media)) && placed(p, media).V1.length === 2, 'the timeline can be laid out');
});

test('sequences and the open sequence are repaired too', () => {
  const p = newProject('E');
  p.sequences = { s1: { name: 7, data: { tracks: { V1: 'x' }, captions: { on: true } } }, s2: 'bad' };
  p.seq = 'main';
  normalizeProject(p);
  same(Object.keys(p.sequences), ['s1']);
  same(p.sequences.s1.name, 'Sequence');
  assert(Array.isArray(p.sequences.s1.data.tracks.V1) && Array.isArray(p.sequences.s1.data.captions.cues), 'its data is sound');
  assert(!('seq' in p), 'a seq that is not { id } goes');
});

test('not a project at all is handed back as it is (the caller decides)', () => {
  same(normalizeProject(null), null);
  same(normalizeProject('x'), 'x');
});
