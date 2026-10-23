// 🎬 motion graphics (Phase 19): every template, every style, Hindi and English, wide and tall frames - drawn from the
// first frame to the last without an error, nothing drawn at NaN, and the typewriter never cuts a Hindi letter apart.
import { test, assert, eq as same } from './harness.mjs';
import { GFX, drawGraphic, newGraphic, gfxFields, brandTheme, gfxKey, textLayout } from '../public/js/graphics.js';

// a stand-in for a canvas 2D context: records text drawn and checks every number it gets
function fakeCtx() {
  const texts = [], bad = [];
  const num = (name, args) => { for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) bad.push(`${name}(${args.join(', ')})`); };
  const grad = { addColorStop() {} };
  const ctx = new Proxy({ texts, bad, globalAlpha: 1, font: '10px x' }, {
    get(o, k) {
      if (k in o) return o[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * (parseFloat(/(\d+(\.\d+)?)px/.exec(o.font)?.[1]) || 10) * 0.55 });
      if (k === 'fillText') return (s, ...a) => { num('fillText', a); texts.push(String(s)); };
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return (...a) => { num(k, a); return grad; };
      return (...a) => num(String(k), a);
    },
    set(o, k, v) { o[k] = v; return true; },
  });
  return ctx;
}
const styles = (tpl) => (gfxFields(tpl).find((f) => f.k === 'style')?.options || [['']]).map((x) => x[0]);
const MOTION = Object.entries(GFX).filter(([, x]) => x.motion).map(([k]) => k);

test('motion templates are there with their fields', () => {
  for (const k of ['lower3', 'kinetic', 'logoreveal', 'endcard', 'ticker']) assert(MOTION.includes(k), `${k} missing`);
  // (the Type tool's text and the Rectangle / Ellipse tools' shape have their own look - fill, stroke, box - not a theme / size)
  for (const k of MOTION.filter((m) => m !== 'text' && m !== 'shape')) { const f = gfxFields(k).map((x) => x.k); assert(f.includes('theme') && f.includes('scale'), `${k}: look + size`); assert(!f.includes('title') || k === 'endcard', `${k}: no stray heading field`); }
});

test('Type tool text: placed where it was put, its box grows with the words and lines', () => {
  const g = { ...newGraphic('text'), text: 'Hello', x: 25, y: 75, size: 100 }, ctx = fakeCtx();
  const a = textLayout(ctx, 1920, 1080, g), b = textLayout(ctx, 1920, 1080, { ...g, text: 'Hello there\nsecond line' });
  assert(Math.abs(a.cx - 480) < 1e-6 && Math.abs(a.cy - 810) < 1e-6, 'centre at 25% / 75%');
  assert(b.w > a.w && Math.abs(b.h - 2 * a.h) < 1e-6, 'wider for more words, twice as tall for two lines');
  same(newGraphic('text').tpl, 'text');
});

test('every template x style x frame shape draws first to last frame without errors', () => {
  let frames = 0;
  for (const [tpl, x] of Object.entries(GFX)) for (const style of styles(tpl)) for (const [W, H] of [[1920, 1080], [1080, 1920], [1080, 1080]]) for (const theme of ['mygov', 'brand']) {
    const g = { ...newGraphic(tpl), ...(style ? { style } : {}), theme, brand: { primary: '#123456', accent: '#ffaa00', text: '#ffffff' }, font: 'Arial' };
    for (let t = 0; t <= x.dur; t += x.dur / 23) {
      const ctx = fakeCtx();
      drawGraphic(ctx, W, H, g, t, x.dur);
      assert(!ctx.bad.length, `${tpl}/${style} ${W}x${H} t=${t.toFixed(2)}: ${ctx.bad[0]}`);
      frames++;
    }
  }
  assert(frames > 1000, `${frames} frames`);
});

test('the full text is on screen in the middle of a graphic', () => {
  const at = (tpl, extra = {}) => { const g = { ...newGraphic(tpl), ...extra }, ctx = fakeCtx(); drawGraphic(ctx, 1920, 1080, g, GFX[tpl].dur * 0.6, GFX[tpl].dur); return ctx.texts.join(' | '); };
  const l3 = at('lower3');
  assert(l3.includes('Shri Vishnu Deo Sai') && l3.includes('Chief Minister'), `lower third: ${l3}`);
  for (const st of ['pop', 'rise', 'stack']) { const k = at('kinetic', { style: st }); assert(['हर', 'घर', 'जल', 'गाँव', 'विकास'].every((w) => k.includes(w)), `kinetic ${st}: ${k}`); assert(!k.includes('*'), 'highlight marks are not drawn'); }
  const e = at('endcard'); assert(e.includes('धन्यवाद') && e.includes('Helpline'), `end card: ${e}`);
  assert(at('ticker').includes('BREAKING'), 'ticker label');
});

test('typewriter keeps Hindi letters whole (no lone matra / halant)', () => {
  const g = { ...newGraphic('kinetic'), style: 'type', text: 'स्वच्छ भारत मिशन' }, dur = 4;
  const lone = /^[ा-्ंःँ]/; // a sign that cannot start a letter
  for (let t = 0; t <= dur; t += 0.05) {
    const ctx = fakeCtx(); drawGraphic(ctx, 1920, 1080, g, t, dur);
    for (const s of ctx.texts) {
      // every drawn piece must be a prefix of a word made of whole letters
      const seg = [...new Intl.Segmenter('hi', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);
      assert(!seg.some((x) => lone.test(x)), `cut letter at t=${t.toFixed(2)}: "${s}"`);
    }
  }
});

test('brand theme follows the brand colours; a bad colour falls back', () => {
  const th = brandTheme({ primary: '#102030', accent: '#ff0000', text: '#ffffff' });
  assert(th.card.startsWith('rgba(16,32,48,') && th.accent === '#ff0000' && th.solid === '#102030', JSON.stringify(th));
  const fb = brandTheme({ primary: 'not-a-colour' });
  assert(fb.card && fb.accent, 'fallback');
});

test('a brand colour change gives a new bake key (the render does not reuse the old picture)', () => {
  const g = { ...newGraphic('lower3'), theme: 'brand', brand: { primary: '#000000', accent: '#ffffff', text: '#ffffff' } };
  const k1 = gfxKey(g, 1920, 1080, 30, 5), k2 = gfxKey({ ...g, brand: { ...g.brand, primary: '#111111' } }, 1920, 1080, 30, 5);
  assert(k1 !== k2, 'keys differ');
});
