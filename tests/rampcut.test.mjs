// ⚡ speed ramps: cutting (or Q / W trimming) a ramped shot must not move anything - both parts keep their length and
// every moment shows the frame it showed before the cut.
import { test, eq as same, assert } from './harness.mjs';
import { RAMPS, clipDur, sourceAt, rampPart, setRamp } from '../public/js/model.js';

const media = { m: { duration: 60 } };
const shot = (key) => { const c = { type: 'video', mediaId: 'm', in: 3, out: 8 }; setRamp(c, key, media, null, 4); return c; };

test('a cut through a ramped shot keeps both parts in place, frame for frame', () => {
  for (const key of Object.keys(RAMPS)) for (const u of [0.13, 0.37, 0.5, 0.81]) {
    const c = shot(key), D = clipDur(c, media), cut = u * D;
    const a = { ...c, ...rampPart(c, 0, u, D) }, b = { ...c, ...rampPart(c, u, 1, D) };
    const Da = clipDur(a, media), Db = clipDur(b, media);
    assert(Math.abs(Da + Db - D) < 0.01, `${key} @${u}: parts are ${Da.toFixed(3)} + ${Db.toFixed(3)}, the shot was ${D.toFixed(3)}`);
    same(a.out, b.in, `${key} @${u}: the parts meet at the same frame`);
    for (const t of [0.05, 0.3, 0.6, 0.95].map((k) => k * D)) {
      const want = sourceAt(c, t, D), got = t < cut ? sourceAt(a, t, Da) : sourceAt(b, t - cut, Db);
      assert(Math.abs(got - want) < 0.05, `${key} @${u}: at ${t.toFixed(2)}s it shows ${got.toFixed(3)} instead of ${want.toFixed(3)}`);
    }
  }
});
