// 🔊 Audio effects (public/js/audioeffects.js): every effect, at its defaults and with its settings moved, is a filter
// chain FFmpeg runs (on a mono test tone - the chain makes it stereo first); fades keep their shapes.
import { spawnSync } from 'node:child_process';
import { test, assert, eq } from './harness.mjs';
import { AFX, aeffectFilters, newAudioEffect, fadeShape, fadeCurve } from '../public/js/audioeffects.js';

const runs = (list) => {
  const chain = aeffectFilters(list).join(',');
  if (!chain) return true;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=0.5', '-af', chain, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${list.map((e) => e.type).join('+')}: ${r.stderr.trim().split(/\r?\n/).pop()}`);
  return true;
};
const moved = (type) => { // every number half-way up its range, every choice its last option
  const e = newAudioEffect(type);
  for (const [k, p] of Object.entries(AFX[type].params)) e.p[k] = p.type === 'select' ? p.options[p.options.length - 1][0] : +(p.min + (p.max - p.min) * 0.5).toFixed(3);
  return e;
};

test('every audio effect renders with FFmpeg - at its defaults and with its settings moved', () => {
  if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0) return 'skipped: no FFmpeg';
  for (const type of Object.keys(AFX)) { runs([newAudioEffect(type)]); runs([moved(type)]); }
});

test('a long chain of audio effects in one go', () => {
  if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0) return 'skipped: no FFmpeg';
  assert(runs(['amplify', 'deesser', 'dynamics', 'multiband', 'analogdelay', 'geq30', 'phaser', 'studio', 'mastering', 'stereoexp', 'pitch', 'balance'].map(moved)));
});

test('effects switched off or unknown add nothing; meters change nothing', () => {
  const e = newAudioEffect('bass'); e.on = false;
  eq(aeffectFilters([e, { type: 'nope' }, newAudioEffect('loudnessmeter')]), []);
});

test('fade shapes: Constant Gain is straight, Constant Power rises fast, Exponential starts slow', () => {
  eq(fadeShape(0.5, 'gain'), 0.5);
  assert(fadeShape(0.5, 'power') > 0.7 && fadeShape(0.5, 'exp') < 0.2);
  for (const k of ['gain', 'power', 'exp']) { eq(fadeShape(0, k), 0); eq(fadeShape(1, k), 1); }
  eq([fadeCurve('gain'), fadeCurve('power'), fadeCurve('exp'), fadeCurve(undefined)], ['tri', 'qsin', 'exp', 'tri']);
});
