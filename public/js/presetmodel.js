// presetmodel.js - 🎛 the Edit panel of the Presets page, built for any preset from what it declares: its fields (words,
// data, logo, look), its texts, the colours it draws with, its knobs (GFX[tpl].knobs), and the same background / timing /
// layout for all. Each section: { id, label, defs } - defs are fieldsHTML fields whose keys are paths into the graphic
// (ed.t.title.size, ed.cmap.#ff9933...: gfxparams.js says what each does). No DOM here (the tests build it too).
import { GFX, gfxFields, drawGraphic, THEMES, brandTheme } from './graphics.js';
import { textSources, parseCol, FEELS } from './gfxparams.js';

const WEIGHTS = [['', 'As designed'], ['300', 'Light'], ['400', 'Regular'], ['600', 'Semi-bold'], ['700', 'Bold'], ['900', 'Black']];
const SHAPES = [['', 'As designed'], ['circle', 'Circle'], ['rounded', 'Rounded square'], ['square', 'Square']];
const BGS = [['', 'As designed'], ['solid', 'Colour'], ['grad', 'Gradient'], ['image', 'Picture'], ['none', 'None (see-through)']];
const R = (k, label, min, max, step, def, unit) => ({ k, label, type: 'range', min, max, step, def, ...(unit ? { unit } : {}) });
// a field label made short: "Title - one or two lines" -> "Title", "Box label (LIVE, channel)" -> "Box label"
export const shortLabel = (s) => String(s || '').replace(/\s*[-(].*$/, '').trim() || String(s || '');

// the texts of a preset as editable parts: [{ k, label }] ('_' = numbers and any other text it draws)
export function textParts(tpl, g = GFX[tpl]?.def || {}) {
  if (tpl === 'text' || tpl === 'shape') return []; // (the Type tool's text / a shape: their own fields already say it all)
  return [...textSources(gfxFields(tpl), g).map((x) => ({ k: x.k, label: shortLabel(x.label) })), { k: '_', label: 'Other text (numbers, labels)' }];
}
export const hasLogo = (tpl) => gfxFields(tpl).some((f) => f.k === 'logo');

// 🎨 the colours a preset draws with (drawn a few times on a small canvas, counting each colour): [[hex, uses]]
export function presetColours(g, dur, mkCtx) {
  const rec = new Map();
  for (const f of [0.08, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) { try { drawGraphic(mkCtx(), 320, 180, g, dur * f, dur, { rec }); } catch {} }
  const own = new Set(gfxFields(g.tpl).filter((f) => f.type === 'color').map((f) => parseCol(g[f.k] ?? GFX[g.tpl]?.def?.[f.k])?.hex).filter(Boolean));
  return [...rec].filter(([h]) => !own.has(h)).sort((a, b) => b[1] - a[1]).slice(0, 14);
}
// what a colour is in the look ('Accent', 'Text'...) - or 'Colour 3'
export function colourName(g, hex, i) {
  const th = g.theme === 'brand' ? brandTheme(g.brand) : THEMES[g.theme] || THEMES.mygov;
  const names = [['accent', 'Accent'], ['c2', 'Second colour'], ['c3', 'Third colour'], ['text', 'Text'], ['sub', 'Small text'], ['solid', 'Background'], ['card', 'Card / background'], ['grid', 'Lines']];
  for (const [k, n] of names) if (parseCol(th[k])?.hex === hex) return n;
  return hex === '#ffffff' ? 'White' : hex === '#000000' ? 'Black' : `Colour ${i + 1}`;
}

// the sections of the Edit panel. opts: { logos: [[id, name]], images: [[id, name]], colours: [[hex, n]] }
export function presetModel(tpl, g, opts = {}) {
  const X = GFX[tpl]; if (!X) return [];
  const out = [];
  const fields = gfxFields(tpl).map((f) => (f.k === 'logo' ? { ...f, options: [['', 'None (round placeholder)'], ...(opts.logos || [])] } : f));
  out.push({ id: 'content', label: 'Words & content', defs: fields, font: tpl !== 'shape' });
  for (const p of textParts(tpl, g)) {
    const b = `ed.t.${p.k}.`;
    out.push({ id: `t:${p.k}`, label: `Text: ${p.label}`, path: `ed.t.${p.k}`, font: b + 'font', defs: [
      R(b + 'size', 'Size', 0.2, 4, 0.05, 1, '×'), { k: b + 'weight', label: 'Weight', type: 'select', options: WEIGHTS },
      { k: b + 'color', label: 'Colour', type: 'color', clear: true }, { k: b + 'italic', label: 'Italic', type: 'check' },
      R(b + 'x', 'Move X', -60, 60, 0.5, 0, '%'), R(b + 'y', 'Move Y', -60, 60, 0.5, 0, '%'),
      R(b + 'op', 'Opacity', 0, 1, 0.01, 1),
      { k: b + 'outline', label: 'Outline', type: 'color', clear: true }, R(b + 'outlineW', 'Outline width', 1, 30, 1, 4, 'px'),
      { k: b + 'shadow', label: 'Shadow', type: 'check' },
      { k: b + 'from', label: 'Shows from', type: 'num', min: 0, step: 0.1, unit: 's', ph: 'start' }, { k: b + 'to', label: 'Hides at', type: 'num', min: 0, step: 0.1, unit: 's', ph: 'end' },
    ] });
  }
  if (hasLogo(tpl)) out.push({ id: 'logo', label: 'Logo', path: 'ed.logo', defs: [
    R('ed.logo.size', 'Size', 0.2, 4, 0.05, 1, '×'), { k: 'ed.logo.shape', label: 'Shape', type: 'select', options: SHAPES },
    R('ed.logo.x', 'Move X', -60, 60, 0.5, 0, '%'), R('ed.logo.y', 'Move Y', -60, 60, 0.5, 0, '%'),
  ] });
  if (tpl !== 'text') out.push({ id: 'shapes', label: 'Shapes & lines', paths: ['ed.n', 'ed.sh'], defs: [
    ...(X.knobs || []).map((k) => R(`ed.n.${k.k}`, k.label, k.min, k.max, k.step, k.def)),
    R('ed.sh.op', 'Shapes opacity', 0, 1, 0.01, 1), R('ed.sh.lw', 'Line thickness', 0, 5, 0.05, 1, '×'),
  ] });
  const cols = opts.colours || [];
  if (cols.length) out.push({ id: 'colours', label: 'Colours', path: 'ed.cmap', defs: cols.map(([h], i) => ({ k: `ed.cmap.${h}`, label: colourName(g, h, i), type: 'color', def: h, clear: true })) });
  const bg = g.ed?.bg?.mode || '';
  out.push({ id: 'bg', label: 'Background', path: 'ed.bg', defs: [
    { k: 'ed.bg.mode', label: 'Background', type: 'select', options: BGS },
    ...(bg === 'solid' || bg === 'grad' ? [{ k: 'ed.bg.c1', label: bg === 'grad' ? 'From' : 'Colour', type: 'color', def: '#0b2545' }] : []),
    ...(bg === 'grad' ? [{ k: 'ed.bg.c2', label: 'To', type: 'color', def: '#13315c' }, R('ed.bg.angle', 'Angle', 0, 360, 1, 90, '°')] : []),
    ...(bg === 'image' ? [{ k: 'ed.bg.img', label: 'Picture (media pool)', type: 'select', options: [['', 'Pick a picture'], ...(opts.images || [])] }] : []),
    ...(bg && bg !== 'none' ? [R('ed.bg.dim', 'Darken', 0, 0.9, 0.01, 0)] : []),
  ] });
  const still = tpl === 'text' || tpl === 'shape';
  out.push({ id: 'time', label: 'Timing', path: 'ed.time', len: true, defs: [
    { k: 'ed.time.delay', label: 'Start after', type: 'num', min: 0, step: 0.1, unit: 's', ph: '0' },
    R('ed.time.speed', 'Speed', 0.25, 4, 0.05, 1, '×'),
    { k: 'ed.time.feel', label: 'Motion feel', type: 'select', options: FEELS },
    { k: 'ed.time.fadeIn', label: 'Fade in', type: 'num', min: 0, step: 0.1, unit: 's', ph: '0' },
    { k: 'ed.time.fadeOut', label: 'Fade out', type: 'num', min: 0, step: 0.1, unit: 's', ph: still ? '0' : '0.4' },
  ] });
  out.push({ id: 'layout', label: 'Position & size', path: 'ed.lay', defs: [
    R('ed.lay.x', 'Move X', -100, 100, 0.5, 0, '%'), R('ed.lay.y', 'Move Y', -100, 100, 0.5, 0, '%'),
    R('ed.lay.zoom', 'Zoom', 0.1, 4, 0.01, 1, '×'), R('ed.lay.rot', 'Rotate', -180, 180, 1, 0, '°'),
  ] });
  return out;
}
