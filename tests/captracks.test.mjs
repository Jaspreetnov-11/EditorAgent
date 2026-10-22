// 🗂 caption tracks + 🌐 translate helpers (public/js/captions.js)
import { test, eq as same, assert } from './harness.mjs';
import { normalizeProject, newProject } from '../public/js/model.js';
import { buildAss, capTracks, capStack, addCapTrack, removeCapTrack, srtOf, cuesFromSrt, translatePrompt, parseTranslation, MAIN_TRACK, trackId } from '../public/js/captions.js';

const cue = (start, end, text) => ({ id: `${start}`, start, end, text });
const two = () => ({ on: true, style: { pos: 'bottom', anim: 'none', size: 54 }, cues: [cue(0, 1, 'hello there')], tracks: [{ id: 't2', name: 'Hindi', lang: 'hi', on: true, style: { pos: 'bottom', anim: 'none', size: 54 }, cues: [cue(0, 1, 'नमस्ते')] }] });
const events = (ass) => ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
const styleOf = (ass, n) => ass.split('\n').find((l) => l.startsWith(`Style: ${n},`))?.split(',');

test('an old project (one caption track) reads as track 1 and renders the same', () => {
  const c = { on: true, style: { anim: 'none' }, cues: [cue(0, 1, 'hi')] };
  same(capTracks(c).length, 1);
  same(trackId(c, c), MAIN_TRACK);
  const ass = buildAss(c, 1920, 1080);
  same(events(ass).length, 1);
  assert(!ass.includes('Cap2'), 'no second style');
  same(styleOf(ass, 'Cap')[21], '86', 'track 1 margin as before (8% of 1080)');
});

test('every shown track is burned in, the second stacked above the first', () => {
  const c = two(), ass = buildAss(c, 1920, 1080);
  same(events(ass).length, 2);
  assert(events(ass)[1].includes(',Cap2,'), 'track 2 has its own style');
  same(styleOf(ass, 'Cap2')[1], 'Nirmala UI', 'Hindi gets a Devanagari font');
  assert(+styleOf(ass, 'Cap2')[21] > +styleOf(ass, 'Cap')[21] + 40, 'track 2 sits higher');
  c.tracks[0].on = false;
  same(events(buildAss(c, 1920, 1080)).length, 1, 'a hidden track is not burned');
});

test('different positions do not stack; middle tracks are placed by hand', () => {
  const c = two(); c.tracks[0].style.pos = 'top';
  same(capStack(capTracks(c), 1920, 1080).get(c.tracks[0]), 0);
  c.style.pos = 'middle'; c.tracks[0].style.pos = 'middle';
  assert(events(buildAss(c, 1920, 1080))[1].includes('\\pos(960,'), 'stacked middle line has a position');
});

test('track 1 hidden: its lines go, the others still show without a gap', () => {
  const c = two(), pass = { ...c, cues: [] }; // (what render2 hands over)
  const ass = buildAss(pass, 1920, 1080);
  same(events(ass).length, 1);
  same(styleOf(ass, 'Cap2')[21], '86', 'track 2 takes the bottom place');
});

test('add / delete tracks; deleting track 1 moves track 2 up', () => {
  const c = two(), t = addCapTrack(c, { name: 'English', lang: 'en' });
  same(capTracks(c).length, 3);
  removeCapTrack(c, t.id); same(capTracks(c).length, 2);
  removeCapTrack(c, MAIN_TRACK);
  same(c.cues[0].text, 'नमस्ते'); same(c.name, 'Hindi'); same(capTracks(c).length, 1);
});

test('normalize keeps extra tracks sound', () => {
  const p = normalizeProject({ ...newProject('A'), captions: { on: true, cues: [], style: {}, tracks: [{ name: 'x' }, 'bad', null] } });
  same(p.captions.tracks.length, 1);
  assert(p.captions.tracks[0].id && Array.isArray(p.captions.tracks[0].cues), 'id + cues');
});

test('.srt out and back keeps the timings', () => {
  const cues = [cue(1.5, 3.25, 'one'), cue(3661.002, 3662, 'two')], back = cuesFromSrt(srtOf(cues));
  same(back.map((q) => [q.start, q.end, q.text]), [[1.5, 3.25, 'one'], [3661.002, 3662, 'two']]);
});

test('translate reply: same number of lines or nothing', () => {
  assert(translatePrompt(['a', 'b'], 'hinglish').includes('exactly 2 strings'), 'asks for the count');
  same(parseTranslation('Here:\n["Hello", " World  "]', 2), ['Hello', 'World']);
  same(parseTranslation('["one"]', 2), null);
  same(parseTranslation('sorry', 1), null);
});
