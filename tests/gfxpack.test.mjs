// 🎬 Limelight's motion template pack (public/js/gfxpack.js): every template is complete, in a pack, and draws at every
// moment without an error; Hindi steps by whole letters
import { test, eq, assert } from './harness.mjs';
import { GFX, newGraphic, drawGraphic, gfxFields } from '../public/js/graphics.js';
import { PACK, PACK_ORDER, PACK_DRAW, graphemes } from '../public/js/gfxpack.js';

// a canvas stand-in that records what is drawn (enough of the 2D API for the templates)
function fakeCtx() {
  const calls = { text: [], fill: 0 };
  const grad = { addColorStop() {} };
  const target = {
    globalAlpha: 1, font: '10px x', letterSpacing: '0px', canvas: { width: 1920, height: 1080 },
    measureText: (s) => ({ width: String(s).length * 20 }), createLinearGradient: () => grad, createRadialGradient: () => grad,
    fillText: (s) => calls.text.push(String(s)), fill: () => { calls.fill++; }, fillRect: () => { calls.fill++; },
  };
  return { calls, ctx: new Proxy(target, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }) };
}

test('pack: 35 templates in 8 packs, each with its drawing, settings for all its fields and a length', () => {
  const keys = Object.keys(PACK);
  eq(keys.length, 35);
  eq([...new Set(keys.map((k) => PACK[k].pack))], PACK_ORDER);
  for (const k of keys) {
    const x = PACK[k];
    assert(GFX[k] === x && typeof PACK_DRAW[k] === 'function', `${k} is a graphic with a drawing`);
    assert(x.motion && x.dur > 0 && x.label, `${k} label / length`);
    for (const f of x.fields) assert(f.k && ['text', 'area', 'select', 'range', 'num', 'check', 'color'].includes(f.type), `${k}.${f.k} type`);
    for (const f of x.fields) if (f.k !== 'logo') assert(f.k in x.def, `${k}: ${f.k} has a default`);
    assert(gfxFields(k).some((f) => f.k === 'theme'), `${k} has a look`);
  }
});

test('pack: every template draws at the start, middle and end - in Hindi too - without an error', () => {
  for (const k of Object.keys(PACK)) {
    const d = PACK[k].dur;
    for (const t of [0, d * 0.1, d * 0.35, d * 0.5, d * 0.75, d - 0.01]) {
      const { ctx, calls } = fakeCtx();
      drawGraphic(ctx, 1920, 1080, newGraphic(k), t, d);
      if (t >= d * 0.75 && t < d - 0.01) assert(calls.fill + calls.text.length > 0, `${k} draws something at ${t.toFixed(2)}s`);
    }
    // a vertical frame (reels) and the brand look
    const { ctx } = fakeCtx();
    drawGraphic(ctx, 1080, 1920, { ...newGraphic(k), theme: 'brand', brand: { primary: '#123456', accent: '#ff0055' } }, PACK[k].dur / 2, PACK[k].dur);
  }
});

test('pack: Hindi words are typed whole letter by whole letter (a matra never alone)', () => {
  eq(graphemes('हर घर'), ['ह', 'र', ' ', 'घ', 'र']);
  eq(graphemes('पहुँच'), ['प', 'हुँ', 'च']);
  eq(graphemes('क्षेत्र').length, 2);
  const { ctx, calls } = fakeCtx();
  drawGraphic(ctx, 1920, 1080, { ...newGraphic('ti_type'), title: 'पहुँच' }, 0.44, PACK.ti_type.dur); // (0.6 s for the word: at 0.44 s one letter of three)
  assert(calls.text.some((s) => s === 'प' || s === 'पहुँ'), `typed so far: ${calls.text.join(' | ')}`);
  assert(!calls.text.some((s) => s === 'पह'), 'never half a letter');
});
