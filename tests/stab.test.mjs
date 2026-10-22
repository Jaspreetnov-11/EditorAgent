// 🎥 Warp Stabilizer / Stabilize: the settings become vid.stab's numbers in one place (effects.js stabOf), which the
// export (render2.mjs) and the monitor's stabilised copy (/api/stab) both use - and a change of setting is a new copy.
import { test, assert, eq as same } from './harness.mjs';
import { stabOf, newEffect } from '../public/js/effects.js';

test('no stabiliser: nothing to make', () => { same(stabOf({ type: 'video' }), null); });

test('Warp Stabilizer defaults: smooth motion, crop + auto-scale', () => {
  const s = stabOf({ type: 'video', effects: [newEffect('warpstab')] });
  same(s.detect, 'vidstabdetect=shakiness=6:accuracy=12:mincontrast=0.5');
  same(s.transform, 'optalgo=gauss:smoothing=30:optzoom=1:interpol=bicubic');
});

test('No Motion, Position only, more smoothness: other numbers, another copy', () => {
  const e = newEffect('warpstab'), base = stabOf({ effects: [e] }).key;
  Object.assign(e.p, { result: 'nomotion', method: 'position', smoothness: 100, addscale: 110 });
  const s = stabOf({ effects: [e] });
  assert(s.detect.includes('tripod=1') && s.transform.includes('maxangle=0') && s.transform.includes('zoom=10') && s.transform.includes('smoothing=60'), s.transform);
  assert(s.key !== base, 'a new copy for new settings');
});

test('an effect switched off: the simple Stabilize level (or nothing)', () => {
  const e = { ...newEffect('warpstab'), on: false };
  same(stabOf({ effects: [e] }), null);
  same(stabOf({ effects: [e], stabilize: 'strong' }).detect, 'vidstabdetect=shakiness=10:accuracy=12:mincontrast=0.5');
});
