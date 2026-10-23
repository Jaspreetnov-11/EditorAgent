// Premiere parity (chat 10): the EDL export, the new video effects and transitions.
import { test, assert, eq as same } from './harness.mjs';
import { placed, TRANSITIONS } from '../public/js/model.js';
import { VFX, newEffect } from '../public/js/effects.js';
import { buildEDL } from '../public/js/edl.js';

test('EDL: one event per V1 clip with source and record timecodes, speed as M2, overlays as comments', () => {
  const media = { a: { id: 'a', name: 'C0001.MP4', path: 'L:\\shoot\\C0001.MP4', duration: 60 }, b: { id: 'b', name: 'drone.mp4', path: 'Z:\\drone.mp4', duration: 30 } };
  const pj = { name: 'Test', settings: { fps: 25 }, tracks: { V1: [{ id: '1', type: 'video', mediaId: 'a', in: 10, out: 12 }, { id: '2', type: 'video', mediaId: 'b', in: 4, out: 8, speed: 2 }], V2: [{ id: '3', type: 'title', start: 1, dur: 2, text: 'x' }], A1: [] } };
  const r = buildEDL(pj, media, placed(pj, media));
  same(r.events, 2);
  assert(r.text.includes('001  C0001    V     C        00:00:10:00 00:00:12:00 00:00:00:00 00:00:02:00'), r.text);
  assert(r.text.includes('002  DRONE    V     C        00:00:04:00 00:00:08:00 00:00:02:00 00:00:04:00'), r.text);
  assert(/M2 {3}DRONE {4}.*050\.0/.test(r.text), 'speed 2x at 25 fps = 50.0');
  same(r.skipped, 1);
});

test('the new video effects make FFmpeg filters', () => {
  for (const k of ['bricon', 'tint', 'leavecolor', 'dblur', 'lens', 'basic3d', 'cornerpin', 'wave', 'offset', 'echo', 'posterizetime', 'strobe']) {
    const f = VFX[k].ff(newEffect(k).p, { W: 1920, H: 1080 });
    assert(typeof f === 'string' && f.length > 3 && !/NaN|undefined/.test(f), `${k}: ${f}`);
  }
});

test('60 transitions, every key a plain name (an FFmpeg xfade name or a custom shape - premierefx.test.mjs)', () => {
  same(TRANSITIONS.length, 60);
  assert(TRANSITIONS.every(([k]) => /^[a-z]+$/.test(k)));
});
