// 🎛 every part of a preset editable (public/js/gfxparams.js + presetmodel.js): the Edit panel is built for all 44 presets,
// nothing changed draws exactly as before, and each change (texts, colours, logo, shapes, background, timing, layout)
// reaches the drawing - the same drawGraphic the render bakes with
import { test, eq, assert } from './harness.mjs';
import { GFX, newGraphic, drawGraphic, gfxFields } from '../public/js/graphics.js';
import { PACK_ORDER } from '../public/js/gfxpack.js';
import { matchText, textSources, fontWith, mapCol, parseCol, tidyEd, hasEdit, editTime, editFade } from '../public/js/gfxparams.js';
import { presetModel, presetColours, textParts } from '../public/js/presetmodel.js';

// the 44 presets of the Presets page: the pack's groups, then the motion templates
const PRESETS = Object.keys(GFX).filter((k) => PACK_ORDER.includes(GFX[k].pack) || (GFX[k].motion && !GFX[k].pack));

// a canvas stand-in that keeps the state each text / fill is drawn with
function fakeCtx() {
  const log = [], grad = { addColorStop(o, c) { log.push({ op: 'stop', c }); } };
  let st = { tx: 0, ty: 0, alpha: 1, fillStyle: '#000', strokeStyle: '#000', font: '10px x', lineWidth: 1 };
  const stack = [];
  const target = {
    canvas: { width: 1920, height: 1080 }, letterSpacing: '0px', textAlign: 'start', textBaseline: 'alphabetic',
    save() { stack.push({ ...st }); }, restore() { if (stack.length) st = stack.pop(); },
    translate(x, y) { st.tx += x; st.ty += y; }, scale() {}, rotate() {}, transform() {}, setTransform() {},
    measureText: (s) => ({ width: String(s).length * (parseFloat(/(\d*\.?\d+)px/.exec(st.font)?.[1]) || 10) * 0.5 }),
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    fillText: (s, x, y) => log.push({ op: 'text', s: String(s), x: x + st.tx, y: y + st.ty, font: st.font, fill: st.fillStyle, alpha: st.alpha }),
    strokeText: (s) => log.push({ op: 'stroke', s: String(s), stroke: st.strokeStyle }),
    fill: () => log.push({ op: 'fill', fill: st.fillStyle, alpha: st.alpha }), fillRect: (x, y, w, h) => log.push({ op: 'rect', fill: st.fillStyle, w, h, alpha: st.alpha }),
    stroke: () => log.push({ op: 'line', stroke: st.strokeStyle, lw: st.lineWidth }),
  };
  const STATE = new Set(['fillStyle', 'strokeStyle', 'font', 'lineWidth', 'globalAlpha']);
  const ctx = new Proxy(target, {
    get: (t, k) => (k === 'globalAlpha' ? st.alpha : STATE.has(k) ? st[k] : k in t ? t[k] : () => {}),
    set: (t, k, v) => { if (k === 'globalAlpha') st.alpha = v; else if (STATE.has(k)) st[k] = v; else t[k] = v; return true; },
  });
  return { ctx, log };
}
const draw = (g, t, dur = GFX[g.tpl].dur, W = 1920, H = 1080) => { const f = fakeCtx(); drawGraphic(f.ctx, W, H, g, t, dur); return f.log; };
const texts = (log, s) => log.filter((x) => x.op === 'text' && (!s || x.s === s));

test('presets: 44 on the page, each with an Edit panel - words, every text, logo, shapes, background, timing, layout', () => {
  eq(PRESETS.length, 44);
  for (const k of PRESETS) {
    const g = newGraphic(k), secs = presetModel(k, g, { colours: [['#ff9933', 3]] }), ids = secs.map((s) => s.id);
    for (const id of ['content', 'bg', 'time', 'layout', 'colours']) assert(ids.includes(id), `${k}: ${id} section`);
    if (k !== 'text') assert(ids.includes('shapes'), `${k}: shapes section`);
    const tf = gfxFields(k).filter((f) => f.type === 'text' || f.type === 'area').map((f) => f.k);
    if (k !== 'text' && k !== 'shape') for (const f of tf) assert(ids.includes(`t:${f}`), `${k}: text part ${f}`);
    if (gfxFields(k).some((f) => f.k === 'logo')) assert(ids.includes('logo'), `${k}: logo section`);
    for (const s of secs) for (const d of s.defs) assert(d.k && d.type, `${k}/${s.id}: field ${JSON.stringify(d).slice(0, 60)}`);
    for (const kn of GFX[k].knobs || []) assert(secs.find((s) => s.id === 'shapes').defs.some((d) => d.k === `ed.n.${kn.k}`), `${k}: knob ${kn.k}`);
  }
  assert(textParts('ls_shapes').some((p) => p.k === 'tagline'), 'the tagline is a text part');
});

test('presets: nothing changed draws exactly as before (old projects and their bakes stay the same)', () => {
  for (const k of PRESETS) for (const f of [0.2, 0.6, 0.97]) {
    const g = newGraphic(k), d = GFX[k].dur;
    eq(draw({ ...g, ed: {} }, d * f), draw(g, d * f), `${k} at ${f}`);
    eq(draw({ ...g, ed: { t: { title: {} }, cmap: {} } }, d * f), draw(g, d * f), `${k} empty edits at ${f}`);
  }
});

test('presets: a drawn string is found as its text - whole, a line, a part, typed so far, with # or *', () => {
  const g = { title: 'नई उड़ान', sub: 'A LIMELIGHT FILM', data: '2014, Yojana shuru\n2018, 1 crore ghar', tag: 'HarGharTiranga', text: 'हर घर *जल*' };
  const src = textSources([{ k: 'title', type: 'text' }, { k: 'sub', type: 'text' }, { k: 'data', type: 'area' }, { k: 'tag', type: 'text' }, { k: 'text', type: 'area' }], g);
  eq(matchText(src, 'नई उड़ान'), 'title');
  eq(matchText(src, 'नई'), 'title'); // typed so far
  eq(matchText(src, 'A LIMELIGHT FILM'), 'sub');
  eq(matchText(src, 'Yojana shuru'), 'data');
  eq(matchText(src, '2018'), 'data');
  eq(matchText(src, '#HarGharTiranga'), 'tag');
  eq(matchText(src, 'जल'), 'text');
  eq(matchText(src, '3,00,000+'), '_');
});

test('presets: fonts, colours and the clean-up of the edits', () => {
  eq(fontWith('700 52px "Nirmala UI", Arial', { size: 2, weight: '900', font: 'Poppins' }), '900 104px "Poppins", "Nirmala UI", Arial');
  eq(fontWith('52px Arial', { italic: true }), 'italic 52px Arial');
  eq(parseCol('rgba(11,37,69,0.92)'), { hex: '#0b2545', a: 0.92 });
  eq(parseCol('#FFF'), { hex: '#ffffff', a: 1 });
  const rec = new Map();
  eq(mapCol('rgba(255,153,51,0.5)', { '#ff9933': '#00ff00' }, rec), 'rgba(0,255,0,0.5)');
  eq(mapCol('#123456', { '#ff9933': '#00ff00' }, rec), '#123456');
  eq(rec.get('#ff9933'), 1);
  const g = tidyEd({ tpl: 'ti_split', ed: { t: { title: { size: undefined, color: '' } }, bg: { mode: '' } } });
  assert(!('ed' in g) && !hasEdit(g), 'empty edits leave no trace');
  eq(editTime({ ed: { time: { delay: 1, speed: 2 } } }, 3, 5), [4, 8]);
  eq(+editFade({}, 4.8, 5).toFixed(6), 0.5); // (the designs' 0.4 s fade out)
  eq(editFade({ ed: { time: { fadeOut: 0, fadeIn: 1 } } }, 0.5, 5), 0.5);
});

test('presets: a text keeps its words but takes its own size, font, colour, place and time', () => {
  const g = newGraphic('ls_shapes'), d = GFX.ls_shapes.dur, t = d * 0.7;
  const before = texts(draw(g, t), 'Creative Studio')[0];
  assert(before, 'the tagline is drawn');
  const g2 = { ...g, ed: { t: { tagline: { size: 2, color: '#ff0000', weight: '300', font: 'Poppins', x: 10, y: -5, outline: '#000000' } } } };
  const log = draw(g2, t), after = texts(log, 'Creative Studio')[0];
  eq(after.fill, '#ff0000');
  assert(/^300 /.test(after.font) && /"Poppins"/.test(after.font), after.font);
  eq(Math.round(parseFloat(/(\d*\.?\d+)px/.exec(after.font)[1])), Math.round(parseFloat(/(\d*\.?\d+)px/.exec(before.font)[1]) * 2));
  eq(Math.round(after.x - before.x), 192); eq(Math.round(after.y - before.y), -54);
  assert(log.some((x) => x.op === 'stroke' && x.s === 'Creative Studio'), 'the outline');
  // shown only from 3 s
  const late = { ...g, ed: { t: { tagline: { from: 3 } } } };
  eq(texts(draw(late, t), 'Creative Studio')[0].alpha, 0);
  assert(texts(draw(late, 3.3), 'Creative Studio')[0].alpha > 0, 'shows after 3 s');
});

test('presets: colours swap everywhere, shapes and knobs change, a background and the timing apply', () => {
  const g = newGraphic('ls_shapes'), d = GFX.ls_shapes.dur;
  // MyGov's saffron accent swapped for green: no saffron left, green in its place
  const sw = draw({ ...g, ed: { cmap: { '#ff9933': '#00aa44' } } }, d * 0.3);
  assert(!sw.some((x) => parseCol(x.fill)?.hex === '#ff9933'), 'no saffron left');
  assert(sw.some((x) => parseCol(x.fill)?.hex === '#00aa44'), 'green in its place');
  // more shapes
  const n = (log) => log.filter((x) => x.op === 'fill' || x.op === 'rect').length;
  assert(n(draw({ ...g, ed: { n: { count: 30 } } }, 0.5)) > n(draw(g, 0.5)) + 15, 'shapes count');
  // shapes see-through
  assert(draw({ ...g, ed: { sh: { op: 0.5 } } }, 0.5).filter((x) => x.op === 'fill').every((x) => x.alpha <= 0.5 + 1e-9), 'shapes opacity');
  // a solid background first, over the preset's own
  const bg = draw({ ...newGraphic('ti_split'), ed: { bg: { mode: 'solid', c1: '#112233' } } }, 1);
  eq(bg[0].op, 'rect'); eq(bg[0].fill, '#112233'); eq(bg[0].w, 1920);
  // start after 1 s: at 1 s it is the first frame
  eq(draw({ ...g, ed: { time: { delay: 1 } } }, 1).filter((x) => x.op === 'text'), draw(g, 0).filter((x) => x.op === 'text'));
  // the logo's own size
  assert(presetModel('ls_shapes', g).some((s) => s.id === 'logo'), 'logo section');
});

test('presets: the colours of a preset are found by drawing it (the Colours section)', () => {
  const list = presetColours(newGraphic('ls_shapes'), GFX.ls_shapes.dur, () => fakeCtx().ctx);
  assert(list.some(([h]) => h === '#ff9933'), `accent found: ${JSON.stringify(list)}`);
  assert(list.length <= 14, 'kept short');
  const lt = presetColours(newGraphic('lt_news'), GFX.lt_news.dur, () => fakeCtx().ctx);
  assert(!lt.some(([h]) => h === '#e11d2e'), 'its own colour field is not listed twice');
});

test('presets: all 44 draw with every kind of edit, start to end, wide and vertical', () => {
  const ed = { t: { title: { size: 1.4, color: '#ff00ff', x: 5, from: 0.2, to: 3, shadow: true, outline: '#000000' }, _: { size: 0.8 } },
    logo: { size: 1.5, x: 10, y: -10, shape: 'rounded' }, cmap: { '#ffffff': '#fafafa', '#ff9933': '#00ff00' }, sh: { op: 0.6, lw: 2 },
    n: { count: 20, strips: 5, step: 0.3 }, bg: { mode: 'grad', c1: '#000000', c2: '#ffffff', angle: 45, dim: 0.3 },
    time: { delay: 0.3, speed: 1.5, fadeIn: 0.3, fadeOut: 0.6, feel: 'bouncy' }, lay: { x: 5, y: -5, zoom: 0.9, rot: 3 } };
  for (const k of PRESETS) {
    const d = GFX[k].dur;
    for (const f of [0, 0.15, 0.4, 0.6, 0.85, 0.999]) draw({ ...newGraphic(k), ed }, d * f, d);
    draw({ ...newGraphic(k), ed }, d / 2, d, 1080, 1920);
    for (const feel of ['smooth', 'snappy', 'linear']) draw({ ...newGraphic(k), ed: { time: { feel } } }, d / 2, d);
  }
});
