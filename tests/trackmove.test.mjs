// ⇅ Alt+↑ / Alt+↓ track moves, ➕ new tracks, 📐 Set to Frame Size / Fill Frame, 🎭 blend modes and ◆ keyframe selection.
import { test, eq as same, assert } from './harness.mjs';
import { newProject, moveClipsTrack, ensureTrack, frameScale, linkAudioOf, BLEND_MODES, BLEND_CSS, blendFF, trackList } from '../public/js/model.js';
import { pickKeys, keysInRange, moveKeys, settleKeys, deleteKeys, inSel } from '../public/js/kfsel.js';

const media = { a: { duration: 6, hasAudio: true, width: 1920, height: 1080 }, b: { duration: 5, hasAudio: true, width: 3840, height: 2160 }, p: { duration: 0, width: 1080, height: 1920 } };
const where = (p, id) => Object.entries(p.tracks).find(([, l]) => l.some((c) => c.id === id))?.[0];
const gap = (len) => ({ id: `g${Math.random()}`, type: 'title', gap: true, text: '', bg: '#000000', dur: len });

test('Alt+↑ moves an overlay clip one track up and keeps its time; Alt+↓ brings it back', () => {
  const p = newProject('T');
  p.tracks.V2.push({ id: 'x', type: 'video', mediaId: 'a', start: 2 });
  const r = moveClipsTrack(p, media, ['x'], 1);
  same([r.moved, where(p, 'x'), p.tracks.V3.find((c) => c.id === 'x').start], [1, 'V3', 2]);
  moveClipsTrack(p, media, ['x'], -1);
  same(where(p, 'x'), 'V2');
});

test('the top video track: Alt+↑ makes a new one; audio below the last track too', () => {
  const p = newProject('T');
  const top = trackList(p).find((t) => t.kind === 'video').id;
  ensureTrack(p, top); p.tracks[top].push({ id: 'x', type: 'image', mediaId: 'p', start: 0, dur: 3 });
  moveClipsTrack(p, media, ['x'], 1);
  same(where(p, 'x'), `V${+top.slice(1) + 1}`);
  assert(p.trackState[`V${+top.slice(1) + 1}`], 'the new track has its state');
  const lastA = [...trackList(p)].reverse().find((t) => t.kind === 'audio').id;
  ensureTrack(p, lastA); p.tracks[lastA].push({ id: 's', type: 'audio', mediaId: 'a', start: 1 });
  moveClipsTrack(p, media, ['s'], -1);
  same(where(p, 's'), `A${+lastA.slice(1) + 1}`);
});

test('audio goes up / down on screen: Alt+↑ from A2 is A1, nothing above A1', () => {
  const p = newProject('T');
  p.tracks.A2.push({ id: 's', type: 'audio', mediaId: 'a', start: 0 });
  moveClipsTrack(p, media, ['s'], 1);
  same(where(p, 's'), 'A1');
  const r = moveClipsTrack(p, media, ['s'], 1);
  same([r.moved, r.stayed, where(p, 's')], [0, 1, 'A1']);
});

test('a linked picture takes its sound along (V2 -> V3 with A1 -> A2), keeping the time', () => {
  const p = newProject('T');
  const v = { id: 'v', type: 'video', mediaId: 'a', start: 3 }; p.tracks.V2.push(v); linkAudioOf(p, media, v);
  const s = Object.values(p.tracks).flat().find((c) => c.type === 'audio' && c.link === v.link), from = where(p, s.id);
  moveClipsTrack(p, media, ['v', s.id], 1); // (both selected, as a click on a linked clip selects them)
  same([where(p, 'v'), where(p, s.id), s.start], ['V3', `A${+from.slice(1) + 1}`, 3]);
});

test('a busy or locked track there: the clip stays; one undo-able change for the rest', () => {
  const p = newProject('T');
  p.tracks.V2.push({ id: 'x', type: 'video', mediaId: 'a', start: 0 }, { id: 'y', type: 'video', mediaId: 'a', start: 20 });
  ensureTrack(p, 'V3'); p.tracks.V3.push({ id: 'z', type: 'video', mediaId: 'b', start: 2 });
  const r = moveClipsTrack(p, media, ['x', 'y'], 1);
  same([r.moved, r.stayed, where(p, 'x'), where(p, 'y')], [1, 1, 'V2', 'V3']);
  p.trackState.V2.lock = true;
  same(moveClipsTrack(p, media, ['y'], -1).moved, 0);
});

test('main story: up leaves a gap (nothing else moves), down onto V1 uses the overwrite it is given', () => {
  const p = newProject('T');
  p.tracks.V1.push({ id: 'a1', type: 'video', mediaId: 'a', in: 0, out: 2 }, { id: 'a2', type: 'video', mediaId: 'a', in: 0, out: 3 }, { id: 'a3', type: 'video', mediaId: 'a', in: 0, out: 1 });
  const opt = { liftV1: (c, i) => p.tracks.V1.splice(i, 1, gap(3)), toV1: (c, t) => { p.tracks.V1.push(c); c.at = t; } };
  moveClipsTrack(p, media, ['a2'], 1, opt);
  same([where(p, 'a2'), p.tracks.V2.find((c) => c.id === 'a2').start, p.tracks.V1.map((c) => (c.gap ? 'gap' : c.id))], ['V2', 2, ['a1', 'gap', 'a3']]);
  moveClipsTrack(p, media, ['a2'], -1, opt);
  same([where(p, 'a2'), p.tracks.V1.at(-1).at], ['V1', 2]);
  same(moveClipsTrack(p, media, ['a1'], 1).moved, 0, 'without liftV1 a V1 clip stays');
});

test('Set to Frame Size / Fill Frame: the Scale that fits inside / covers the frame', () => {
  // a 9:16 photo in a 16:9 sequence, fitted by default: fit = 1, fill = 16/9 / (9/16) of the fit
  same(frameScale({}, media.p, '16:9', '', 'fit'), 1);
  same(frameScale({}, media.p, '16:9', '', 'fill'), +((1920 / 1080) / (1080 / 1920)).toFixed(4));
  // a 4K 16:9 clip fills a 16:9 frame either way
  same([frameScale({}, media.b, '16:9', '', 'fit'), frameScale({}, media.b, '16:9', '', 'fill')], [1, 1]);
  // a clip set to Fill framing: Set to Frame Size scales it down to fit
  same(frameScale({ fit: 'fill' }, media.p, '16:9', '', 'fit'), +((1080 / 1920) / (1920 / 1080)).toFixed(4));
});

test('blend modes: every one has an FFmpeg mode and a monitor look', () => {
  assert(BLEND_MODES.length >= 15, 'Premiere-like list');
  for (const [k] of BLEND_MODES.slice(1)) {
    assert(/^all_(mode=\w+|expr=')/.test(blendFF(k)), `ffmpeg ${k}`);
    assert(BLEND_CSS[k] || ['darken', 'multiply', 'lighten', 'screen', 'overlay', 'difference', 'exclusion'].includes(k), `css ${k}`);
  }
});

test('keyframes: click selects one, Shift/Ctrl adds or takes away, a box picks a range', () => {
  const c = { keys: { 'transform.zoom': [{ t: 0, v: 1 }, { t: 1, v: 1.2 }, { t: 2, v: 1.1 }], opacity: [{ t: 0.5, v: 1 }, { t: 1.5, v: 0 }] } };
  const z = c.keys['transform.zoom'], o = c.keys.opacity;
  let sel = pickKeys([], { p: 'transform.zoom', k: z[1] });
  sel = pickKeys(sel, { p: 'opacity', k: o[0] }, 'toggle');
  same(sel.length, 2);
  sel = pickKeys(sel, { p: 'opacity', k: o[0] }, 'toggle');
  same([sel.length, inSel(sel, z[1])], [1, true]);
  sel = pickKeys(sel, { p: 'opacity', k: o[1] }, 'set');
  same(sel.map((s) => s.k), [o[1]]);
  same(keysInRange(c, ['transform.zoom', 'opacity'], 1.6, 0.4).map((s) => s.k.t), [1, 0.5, 1.5]);
});

test('keyframes: the selected ones move together, clamped to the clip, and settle over an old key on the same frame', () => {
  const c = { keys: { 'transform.zoom': [{ t: 0, v: 1 }, { t: 1, v: 1.2 }, { t: 2, v: 1.1 }], opacity: [{ t: 0.5, v: 1 }, { t: 3, v: 0 }] } };
  const z = c.keys['transform.zoom'], o = c.keys.opacity;
  const sel = [{ p: 'transform.zoom', k: z[0] }, { p: 'opacity', k: o[0] }];
  const d = moveKeys(c, sel, [0, 0.5], 0.75, 4);
  same([d, z.map((k) => k.t), o.map((k) => k.t)], [0.75, [0.75, 1, 2], [1.25, 3]]);
  same(moveKeys(c, sel, [0, 0.5], -3, 4), 0, 'none before the clip start');
  same(moveKeys(c, sel, [0, 0.5], 10, 4), 3.5, 'none past its end');
  moveKeys(c, [{ p: 'transform.zoom', k: z.find((k) => k.v === 1) }], [0], 1, 4); // onto the key at 1 s
  same(settleKeys(c, [{ p: 'transform.zoom', k: z.find((k) => k.v === 1) }]), 1);
  same(c.keys['transform.zoom'].map((k) => [k.t, k.v]), [[1, 1], [2, 1.1]]);
});

test('keyframes: Delete removes all the selected ones; a property left with none keeps its last value', () => {
  const c = { keys: { 'transform.zoom': [{ t: 0, v: 1 }, { t: 1, v: 1.3 }], opacity: [{ t: 0, v: 1 }, { t: 1, v: 0.5 }, { t: 2, v: 0 }] } };
  const many = [];
  for (let i = 0; i < 40; i++) c.keys.opacity.push({ t: 3 + i * 0.1, v: i / 40 }); // (many keys on one property)
  const n = deleteKeys(c, [...c.keys['transform.zoom'].map((k) => ({ p: 'transform.zoom', k })), { p: 'opacity', k: c.keys.opacity[1] }, ...many]);
  same([n, c.keys['transform.zoom'], c.transform.zoom, c.keys.opacity.length], [3, undefined, 1.3, 42]);
});
