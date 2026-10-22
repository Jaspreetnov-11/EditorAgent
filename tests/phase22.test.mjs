// Phase 22: 🧪 Auto QC rules (engine/qc.mjs), ▱ planar pin maths (public/js/tracking.js), 🎬 motion templates
// (public/js/aitemplates.js).
import { test, assert, eq } from './harness.mjs';
import { flashes, qcReport, addSpelling } from '../engine/qc.mjs';
import { orderQuad, pinAt, quadMatrix, simplifyPin } from '../public/js/tracking.js';
import { TEMPLATES, applyTemplate, clearTemplate } from '../public/js/aitemplates.js';

const frames = (n, f) => Array.from({ length: n }, (_, i) => ({ t: i / 25, YAVG: f(i), BRNG: 0, SATMAX: 60 }));
const base = (o = {}) => ({ info: { dur: 10, w: 1920, h: 1080, fps: 25 }, frames: frames(250, () => 120), black: [], freeze: [], silence: [], loud: { I: -14, LRA: 3, TP: -2 }, ...o });

test('QC: fast black / white flashing is caught, a steady picture is not', () => {
  eq(flashes(frames(250, () => 120)), []);
  const fl = flashes(frames(250, (i) => (i >= 50 && i < 125 ? (Math.floor(i / 2) % 2 ? 235 : 16) : 120)));
  assert(fl.length === 1 && fl[0].s >= 1.9 && fl[0].e <= 5.1, `one flashing stretch 2-5 s, got ${JSON.stringify(fl)}`);
  eq(flashes(frames(250, (i) => (Math.floor(i / 25) % 2 ? 200 : 60))), [], 'one change a second is fine');
});

test('QC: report per channel - loudness, shape, black holes, broadcast-safe', () => {
  const ok = qcReport(base(), { target: 'youtube', aspect: '16:9' });
  eq(ok.counts.fail, 0); assert(ok.items.some((i) => i.kind === 'loud' && i.level === 'ok'));
  const tv = qcReport(base(), { target: 'broadcast' });
  assert(tv.items.some((i) => i.kind === 'loud' && i.level === 'fail'), '-14 LUFS fails EBU R128 -23');
  const reel = qcReport(base(), { target: 'instagram' });
  assert(reel.items.some((i) => i.kind === 'shape' && i.level === 'fail'), '16:9 is wrong for a reel');
  const hole = qcReport(base({ black: [{ s: 4, e: 4.6 }] }), { target: 'youtube' });
  assert(hole.items[0].kind === 'black' && hole.items[0].level === 'fail' && hole.items[0].t === 4);
  const edge = qcReport(base({ black: [{ s: 0, e: 0.5 }, { s: 9.6, e: 10 }] }), { target: 'youtube' });
  assert(!edge.items.some((i) => i.kind === 'black' && i.level !== 'ok'), 'a fade from / to black at the ends is fine');
  const hot = qcReport(base({ frames: frames(250, () => 120).map((f) => ({ ...f, BRNG: 0.2 })) }), { target: 'broadcast' });
  assert(hot.items.some((i) => i.kind === 'safe' && i.level === 'fail'));
  const web = qcReport(base({ frames: frames(250, () => 120).map((f) => ({ ...f, BRNG: 0.2 })) }), { target: 'youtube' });
  assert(!web.items.some((i) => i.kind === 'safe' && i.level === 'fail'), 'not a rule on the web');
});

test('QC: spelling answers are merged with the title times', () => {
  const r = addSpelling(qcReport(base(), { target: 'youtube' }), [{ text: 'Chattisgarh', t: 2 }], '{"mistakes":[{"i":0,"wrong":"Chattisgarh","right":"Chhattisgarh","why":"official spelling"}]}');
  const s = r.items.find((i) => i.kind === 'spell');
  assert(s.level === 'fail' && s.t === 2 && /Chhattisgarh/.test(s.text));
  assert(addSpelling(qcReport(base(), {}), [{ text: 'x', t: 0 }], 'not json').items.some((i) => i.kind === 'spell' && i.level === 'warn'));
});

test('planar: clicked corners are ordered, the CSS matrix lands on them, keys interpolate and thin out', () => {
  eq(orderQuad([{ x: 0.8, y: 0.7 }, { x: 0.1, y: 0.1 }, { x: 0.2, y: 0.8 }, { x: 0.9, y: 0.2 }]).map((p) => [p.x, p.y]), [[0.1, 0.1], [0.9, 0.2], [0.2, 0.8], [0.8, 0.7]]);
  const w = 640, h = 360, q = [100, 50, 400, 80, 120, 300, 420, 250];
  const m = quadMatrix(w, h, q).match(/\((.*)\)/)[1].split(',').map(Number);
  const at = (x, y) => { const X = m[0] * x + m[4] * y + m[12], Y = m[1] * x + m[5] * y + m[13], W = m[3] * x + m[7] * y + m[15]; return [+(X / W).toFixed(2), +(Y / W).toFixed(2)]; };
  eq([at(0, 0), at(w, 0), at(0, h), at(w, h)].flat(), q);
  eq(pinAt([{ t: 0, q: Array(8).fill(0) }, { t: 2, q: Array(8).fill(1) }], 0.5), Array(8).fill(0.25));
  const line = Array.from({ length: 50 }, (_, i) => ({ t: i / 25, q: Array(8).fill(i / 100) }));
  eq(simplifyPin(line).length, 2, 'straight motion needs only the two ends');
});

test('templates: every one applies, keeps the shot length, and comes off cleanly', () => {
  const media = { m1: { id: 'm1', kind: 'video', duration: 30 } };
  const c0 = { id: 'c1', type: 'video', mediaId: 'm1', in: 2, out: 6, effects: [{ id: 'mine', type: 'blur', on: true, p: {} }] };
  for (const t of TEMPLATES) {
    const c = structuredClone(c0);
    applyTemplate(c, t, 4, media);
    assert(c.tpl?.id === t.id, t.id);
    assert(c.effects.some((e) => e.id === 'mine'), `${t.id}: the user's own effect stays`);
    clearTemplate(c, 4, media);
    if (!t.make(4).ramp) eq(c, c0, `${t.id} comes off cleanly`);
    else assert(!c.ramp && !c.tpl && c.effects.length === 1, `${t.id}: ramp taken off`);
  }
});
