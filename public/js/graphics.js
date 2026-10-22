// 📊 Motion graphics & infographics - one drawing code for the viewer (live) and the render (baked frames), so what
// you see is what renders. A graphic is a clip { type: 'graphic', start, dur, gfx: { tpl, ...fields } } on an overlay
// track; drawGraphic(ctx, W, H, gfx, t, dur) paints it on a transparent W x H frame at t seconds into the clip.
// Templates: counter, stats, bars, columns, line, donut, progress, list, callout, route.
// 🎬 tpl 'comp' = a Motion page composition (motion.js), copied into the clip: { tpl: 'comp', compId, comp }.
import { drawComp, compMedia } from './motion.js';
import { drawFusion } from './fusion.js';
import { cutOut } from './mattecut.js';

export const THEMES = {
  mygov: { card: 'rgba(11,37,69,0.92)', text: '#ffffff', sub: '#c9d6ea', accent: '#ff9933', c2: '#138808', c3: '#4f8cff', grid: 'rgba(255,255,255,0.14)' },
  light: { card: 'rgba(255,255,255,0.95)', text: '#14213d', sub: '#5b6577', accent: '#e8590c', c2: '#138808', c3: '#1c64f2', grid: 'rgba(20,33,61,0.12)' },
  dark: { card: 'rgba(0,0,0,0.72)', text: '#ffffff', sub: '#b8bfcc', accent: '#ffcc33', c2: '#36c27e', c3: '#4f8cff', grid: 'rgba(255,255,255,0.15)' },
  tricolour: { card: 'rgba(255,255,255,0.96)', text: '#0b2545', sub: '#4a5568', accent: '#ff9933', c2: '#138808', c3: '#000080', grid: 'rgba(11,37,69,0.12)' },
};
// 🏷 the brand kit's colours (copied into the graphic when it is made / the look is chosen, so the bake key sees them)
export function brandTheme(b = {}) {
  const hex = (c, a) => { const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(c || ''); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : null; };
  const text = b.text || '#ffffff';
  return { card: hex(b.primary, 0.94) || THEMES.mygov.card, text, sub: hex(text, 0.78) || '#c9d6ea', accent: b.accent || '#ff9933', c2: b.accent2 || '#138808', c3: '#4f8cff', grid: hex(text, 0.15) || 'rgba(255,255,255,0.14)', solid: b.primary || '#0b2545' };
}
export const brandOf = (project) => (project?.brand?.primary ? { primary: project.brand.primary, accent: project.brand.accent, text: project.brand.text } : null);

// images inside graphics (a logo): loaded once, drawn when ready. setGfxAssets(fn) tells this module how a media id
// becomes a link; onAsset is called when one finishes loading (the viewer draws the frame again).
const IMGS = new Map();
let assetUrl = () => null, onAsset = () => {};
export function setGfxAssets(urlOf, loaded) { assetUrl = urlOf; onAsset = loaded || onAsset; }
function gfxImage(id) {
  if (!id || typeof Image === 'undefined') return null;
  const url = assetUrl(id); if (!url) return null;
  let x = IMGS.get(url);
  if (!x) { x = new Image(); x.decoding = 'async'; x.onload = () => onAsset(); x.src = url; IMGS.set(url, x); }
  return x.complete && x.naturalWidth ? x : null;
}
// before baking: wait until the graphic's images are loaded
export async function gfxReady(g) {
  const ids = [g?.logo, ...(g?.tpl === 'comp' ? compMedia(g.comp) : [])].filter(Boolean);
  await Promise.all(ids.map((id) => { gfxImage(id); const x = IMGS.get(assetUrl(id)); return x && !x.complete ? new Promise((ok) => { x.addEventListener('load', ok, { once: true }); x.addEventListener('error', ok, { once: true }); }) : null; }));
}

const POS = [['center', 'Centre'], ['left', 'Left half'], ['right', 'Right half'], ['lower', 'Lower third'], ['top', 'Top'], ['full', 'Full screen (own background)']];
const COMMON = [
  { k: 'title', label: 'Heading', type: 'text', ph: 'e.g. Houses built under PMAY' },
  { k: 'theme', label: 'Look', type: 'select', options: [['brand', '🏷 Brand kit (colours + font)'], ['mygov', 'MyGov navy + saffron'], ['tricolour', 'Tricolour on white'], ['light', 'Light card'], ['dark', 'Dark glass']] },
  { k: 'pos', label: 'Place', type: 'select', options: POS },
  { k: 'scale', label: 'Size', type: 'range', min: 0.5, max: 1.6, step: 0.05, def: 1 },
];
const DATA = { k: 'data', label: 'Data - one per line: Label, value', type: 'area', rows: 5, wide: true };

export const GFX = {
  counter: { label: '🔢 Counter (number counts up)', dur: 4, def: { title: 'Houses built', value: 300000, prefix: '', suffix: '+', decimals: 0, pos: 'center', theme: 'mygov' },
    fields: [{ k: 'value', label: 'Number', type: 'num' }, { k: 'from', label: 'Start from', type: 'num', ph: '0' }, { k: 'prefix', label: 'Before (₹)', type: 'text' }, { k: 'suffix', label: 'After (+, %, crore)', type: 'text' }, { k: 'decimals', label: 'Decimals', type: 'num', min: 0, max: 3 }, { k: 'sub', label: 'Small line', type: 'text' }] },
  stats: { label: '🧮 Stat cards (2-4 numbers)', dur: 5, def: { title: 'Viksit Bharat in numbers', data: 'Toilets built, 11.5 crore\nBank accounts, 53 crore\nVillages lit, 100%', pos: 'center', theme: 'mygov' }, fields: [DATA] },
  bars: { label: '📊 Bar chart (sideways)', dur: 6, def: { title: 'Top states', data: 'Uttar Pradesh, 92\nMaharashtra, 78\nGujarat, 71\nChhattisgarh, 64', suffix: '%', pos: 'center', theme: 'mygov' }, fields: [DATA, { k: 'suffix', label: 'After each value', type: 'text' }] },
  columns: { label: '📶 Column chart (growth)', dur: 6, def: { title: 'Growth over the years', data: '2014, 25\n2017, 41\n2020, 58\n2023, 83\n2025, 97', suffix: '', pos: 'center', theme: 'mygov' }, fields: [DATA, { k: 'suffix', label: 'After each value', type: 'text' }] },
  line: { label: '📈 Line chart', dur: 6, def: { title: 'Rising every year', data: '2019, 12\n2020, 18\n2021, 27\n2022, 35\n2023, 52\n2024, 70', suffix: '', pos: 'center', theme: 'mygov' }, fields: [DATA, { k: 'suffix', label: 'After each value', type: 'text' }] },
  donut: { label: '🍩 Donut / share', dur: 5, def: { title: 'Who benefits', data: 'Women, 54\nMen, 38\nOthers, 8', suffix: '%', pos: 'center', theme: 'mygov' }, fields: [DATA, { k: 'suffix', label: 'After each value', type: 'text' }] },
  progress: { label: '⭕ Progress ring (percent)', dur: 4, def: { title: 'Households with tap water', value: 78, pos: 'center', theme: 'mygov' }, fields: [{ k: 'value', label: 'Percent', type: 'num', min: 0, max: 100 }, { k: 'sub', label: 'Small line', type: 'text' }] },
  list: { label: '✅ Points one by one', dur: 6, def: { title: 'What you get', data: 'Free LPG connection\n₹6,000 a year for farmers\n5 lakh health cover', pos: 'left', theme: 'mygov' }, fields: [{ ...DATA, label: 'Points - one per line' }] },
  callout: { label: '📍 Callout (point at something)', dur: 4, def: { title: 'New bridge', sub: '2.3 km · opened 2025', x: 40, y: 45, pos: 'center', theme: 'mygov' },
    fields: [{ k: 'sub', label: 'Small line', type: 'text' }, { k: 'x', label: 'Point at ↔ (% of frame)', type: 'range', min: 0, max: 100, step: 0.5, def: 50 }, { k: 'y', label: 'Point at ↕ (% of frame)', type: 'range', min: 0, max: 100, step: 0.5, def: 50 }] },
  route: { label: '🧭 Route line (journey on a map / shot)', dur: 5, def: { title: '', data: 'Raipur, 30, 60\nBilaspur, 45, 35\nAmbikapur, 62, 18', pos: 'center', theme: 'mygov' },
    fields: [{ k: 'data', label: 'Stops - one per line: Name, x %, y %', type: 'area', rows: 4, wide: true }] },

  // T text written with the Type tool (Premiere's Type tool / Essential Graphics text): placed where it was clicked on
  // the Program monitor, typed in place, styled in Effect Controls. No in / out animation (fade it with a transition).
  text: { label: 'T Text (Type tool)', dur: 5, motion: true, common: [],
    def: { text: 'Your text', size: 90, bold: true, italic: false, align: 'center', color: '#ffffff', stroke: false, strokeColor: '#000000', strokeW: 6,
      shadow: true, bg: false, bgColor: '#000000', bgOpacity: 0.6, x: 50, y: 50, track: 0, lead: 1.2 },
    fields: [{ k: 'text', label: 'Text (or type on the monitor)', type: 'area', rows: 3, wide: true },
      { k: 'size', label: 'Font size (px at 1080)', type: 'num', min: 8, max: 600, step: 2 },
      { k: 'bold', label: 'Bold', type: 'check' }, { k: 'italic', label: 'Italic', type: 'check' },
      { k: 'align', label: 'Align', type: 'select', options: [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']] },
      { k: 'track', label: 'Letter spacing', type: 'range', min: -10, max: 60, step: 1, def: 0 },
      { k: 'lead', label: 'Line spacing', type: 'range', min: 0.8, max: 2.5, step: 0.05, def: 1.2 },
      { k: 'color', label: 'Fill', type: 'color', def: '#ffffff' },
      { k: 'stroke', label: 'Stroke', type: 'check' }, { k: 'strokeColor', label: 'Stroke colour', type: 'color', def: '#000000' },
      { k: 'strokeW', label: 'Stroke width', type: 'range', min: 1, max: 40, step: 1, def: 6 },
      { k: 'shadow', label: 'Shadow', type: 'check' },
      { k: 'bg', label: 'Background', type: 'check' }, { k: 'bgColor', label: 'Background colour', type: 'color', def: '#000000' },
      { k: 'bgOpacity', label: 'Background opacity', type: 'range', min: 0, max: 1, step: 0.05, def: 0.6 },
      { k: 'x', label: 'Position ↔ (% of frame)', type: 'range', min: -20, max: 120, step: 0.5, def: 50 },
      { k: 'y', label: 'Position ↕ (% of frame)', type: 'range', min: -20, max: 120, step: 0.5, def: 50 }] },

  // 🎬 motion templates (Phase 19): lower thirds, kinetic text, logo reveal, end card, news strip
  lower3: { label: '🪪 Lower third (name + title)', dur: 5, motion: true, common: ['theme', 'scale'],
    def: { name: 'Shri Vishnu Deo Sai', role: 'Chief Minister, Chhattisgarh', style: 'bar', side: 'left', pos: 'lower', theme: 'mygov' },
    fields: [{ k: 'name', label: 'Name', type: 'text' }, { k: 'role', label: 'Title / second line', type: 'text' },
      { k: 'style', label: 'Style', type: 'select', options: [['bar', 'Bar - card with a strip'], ['split', 'Split - two-colour blocks'], ['line', 'Line - text + underline only'], ['pill', 'Pill - rounded tag']] },
      { k: 'side', label: 'Side', type: 'select', options: [['left', 'Left'], ['right', 'Right'], ['center', 'Centre']] },
      { k: 'pos', label: 'Top / bottom', type: 'select', options: [['lower', 'Bottom'], ['top', 'Top']] }] },
  kinetic: { label: '✨ Kinetic text (word by word)', dur: 4, motion: true, common: ['theme', 'scale'],
    def: { text: 'हर घर *जल*\nहर गाँव *विकास*', style: 'pop', align: 'center', pos: 'center', theme: 'mygov' },
    fields: [{ k: 'text', label: 'Text - one line each; *word* = highlight', type: 'area', rows: 3, wide: true },
      { k: 'style', label: 'Style', type: 'select', options: [['pop', 'Pop - words bounce in'], ['rise', 'Rise - from below'], ['type', 'Type - letter by letter'], ['stack', 'Stack - big words, highlight block']] },
      { k: 'align', label: 'Align', type: 'select', options: [['center', 'Centre'], ['left', 'Left']] },
      { k: 'pos', label: 'Position', type: 'select', options: [['center', 'Centre'], ['top', 'Top'], ['lower', 'Bottom'], ['full', 'Full screen (own background)']] }] },
  logoreveal: { label: '🌟 Logo reveal', dur: 4, motion: true, common: ['theme', 'scale'],
    def: { logo: '', tagline: 'Viksit Chhattisgarh', style: 'zoom', pos: 'full', theme: 'mygov' },
    fields: [{ k: 'logo', label: 'Logo (image from the media pool)', type: 'select', options: [] }, { k: 'tagline', label: 'Tagline', type: 'text' },
      { k: 'style', label: 'Style', type: 'select', options: [['zoom', 'Zoom + shine'], ['circle', 'Circle reveal'], ['lines', 'Lines meet']] },
      { k: 'pos', label: 'Background', type: 'select', options: [['full', 'Own background (brand colour)'], ['center', 'Over the video']] }] },
  endcard: { label: '🔚 End card (thank you + links)', dur: 5, motion: true, common: ['theme', 'scale'],
    def: { logo: '', title: 'धन्यवाद', lines: 'www.cgstate.gov.in\n@ChhattisgarhCMO\nHelpline 1800-233-0000', pos: 'full', theme: 'mygov' },
    fields: [{ k: 'logo', label: 'Logo (image from the media pool)', type: 'select', options: [] }, { k: 'title', label: 'Main line', type: 'text' },
      { k: 'lines', label: 'Lines below (website, handle, helpline)', type: 'area', rows: 3, wide: true }] },
  ticker: { label: '📰 Breaking / news strip', dur: 8, motion: true, common: ['theme', 'scale'],
    def: { label: 'BREAKING', text: 'Chief Minister Rural Bus Scheme: bus service now reaches 850 villages\n100 new buses start today', speed: 1, pos: 'lower', theme: 'mygov' },
    fields: [{ k: 'label', label: 'Label', type: 'text' }, { k: 'text', label: 'News - one line each', type: 'area', rows: 3, wide: true },
      { k: 'speed', label: 'Speed', type: 'range', min: 0.4, max: 2.5, step: 0.1, def: 1 },
      { k: 'pos', label: 'Position', type: 'select', options: [['lower', 'Bottom'], ['top', 'Top']] }] },
  // 🎞 Roll (credits) and Crawl, like Premiere's Roll / Crawl titles: the text moves the whole length of the clip -
  // credits rise from below the frame until the last line has gone out the top; a crawl runs right to left once
  credits: { label: '🎞 Rolling credits (roll)', dur: 12, motion: true, common: ['theme', 'scale'],
    def: { head: 'Thank you', text: 'Concept & Direction | Limelight\nCamera | Team Limelight\nEdit | Limelight Editor\n\nWith thanks to\nDepartment of Public Relations', bg: 'dark', theme: 'mygov' },
    fields: [{ k: 'head', label: 'Heading (first line, bigger)', type: 'text' }, { k: 'text', label: 'Lines - "Role | Name" puts them in two columns', type: 'area', rows: 6, wide: true },
      { k: 'bg', label: 'Background', type: 'select', options: [['dark', 'Dark'], ['none', 'None (over the picture)']] }] },
  crawl: { label: '➡ Crawl (one line across)', dur: 10, motion: true, common: ['theme', 'scale'],
    def: { text: 'Registrations open till 31 October - visit mygov.in', pos: 'lower', theme: 'mygov' },
    fields: [{ k: 'text', label: 'Text', type: 'area', rows: 2, wide: true }, { k: 'pos', label: 'Position', type: 'select', options: [['lower', 'Bottom'], ['middle', 'Middle'], ['top', 'Top']] }] },
};
// fields shown in Effect Controls for a template (its own first, then heading / look / place / size)
export const gfxFields = (tpl) => [...(GFX[tpl]?.fields || []), ...COMMON.filter((f) => (GFX[tpl]?.common || ['title', 'theme', 'pos', 'scale']).includes(f.k) && !(tpl === 'route' && f.k === 'pos'))];
export const newGraphic = (tpl) => ({ tpl, ...JSON.parse(JSON.stringify(GFX[tpl].def)) });

// ---------------- helpers ----------------
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const outCubic = (u) => 1 - Math.pow(1 - clamp(u), 3);
const outBack = (u) => { u = clamp(u); const c = 1.6; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); };
const num = (v) => { const x = parseFloat(String(v ?? '').replace(/[,₹%\s]/g, '').replace(/[^\d.\-]/g, '')); return Number.isFinite(x) ? x : 0; };
export const fmtNum = (v, d = 0) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
// "Label, value" lines; a value keeps its own words ("11.5 crore") for display, its number for sizes
export function rows(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split(/\s*[,:|\t]\s*(?=[^,:|\t]*$)/);
    return parts.length > 1 ? { label: parts[0], text: parts[1], v: num(parts[1]) } : { label: l, text: '', v: 0 };
  });
}
// the font family of the graphic being drawn (its own / the brand's), always with Nirmala UI behind it for Hindi
let FAM = '"Nirmala UI", "Segoe UI", Arial, sans-serif';
const FONT = (px, w = 700) => `${w} ${Math.round(px)}px ${FAM}`;
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
function fitText(ctx, text, max, px, w = 700) { let s = px; ctx.font = FONT(s, w); while (s > 8 && ctx.measureText(text).width > max) { s *= 0.92; ctx.font = FONT(s, w); } return s; }
// a number inside a value text counts up ("11.5 crore" -> 0.0 … 11.5 crore)
function countText(text, k) {
  const m = /-?[\d,]*\.?\d+/.exec(String(text));
  if (!m) return text;
  const d = (m[0].split('.')[1] || '').length, v = num(m[0]) * k;
  return text.slice(0, m.index) + fmtNum(v, d) + text.slice(m.index + m[0].length);
}

// the panel a graphic lives in (px) for its place
function panel(W, H, g, aspectW, aspectH) {
  const s = g.scale || 1, vert = H > W, u = Math.min(W, H);
  let w = (vert ? W * 0.86 : W * aspectW) * s, h = (vert ? u * aspectH * 1.25 : H * aspectH) * s;
  w = Math.min(w, W * 0.96); h = Math.min(h, H * 0.9);
  const pos = g.pos || 'center';
  let x = (W - w) / 2, y = (H - h) / 2;
  if (pos === 'left') x = W * 0.05; else if (pos === 'right') x = W * 0.95 - w;
  if (pos === 'lower') y = H * 0.94 - h; else if (pos === 'top') y = H * 0.06;
  if (vert && (pos === 'left' || pos === 'right')) x = (W - w) / 2;
  return { x, y, w, h, u: u * s };
}

// ---------------- the drawing ----------------
// t: seconds into the clip, dur: its length. In: 0.6 s, out: fade over the last 0.4 s.
// video layers of comps get their frames from here (set by gfxui.js; a bake passes its own in `extra`)
let gfxVideo = null;
export function setGfxVideo(fn) { gfxVideo = fn; }
export function drawGraphic(ctx, W, H, g, t, dur, extra = {}) {
  // ⏱ responsive time: intro and outro play at their own speed, only the middle stretches
  if (rtimeOn(g)) { const [I, O, D0] = rtimeOf(g); t = rtimeMap(t, dur, D0, I, O); dur = D0; }
  if (g.tpl === 'comp') return g.comp ? drawComp(ctx, W, H, g.comp, t, { img: gfxImage, video: extra.video || gfxVideo, cut: cutOut }) : ctx.clearRect(0, 0, W, H);
  // ✨ a Fusion node graph (fusion.js)
  if (g.tpl === 'fusion') return g.fusion ? drawFusion(ctx, W, H, g.fusion, t, { img: gfxImage, video: extra.video || gfxVideo, cut: cutOut }) : ctx.clearRect(0, 0, W, H);
  const th = g.theme === 'brand' ? brandTheme(g.brand) : THEMES[g.theme] || THEMES.mygov;
  FAM = `${g.font ? `"${String(g.font).replace(/"/g, '')}", ` : ''}"Nirmala UI", "Segoe UI", Arial, sans-serif`;
  ctx.clearRect(0, 0, W, H);
  const fade = g.tpl === 'text' ? 1 : clamp((dur - t) / 0.4); // (Type tool text: no built-in fade, like Premiere)
  ctx.save();
  ctx.globalAlpha = fade;
  if (g.pos === 'full' && g.tpl !== 'route' && g.tpl !== 'callout') { ctx.fillStyle = th.solid || th.card.replace(/[\d.]+\)$/, '1)'); ctx.fillRect(0, 0, W, H); }
  // 📌 pinned: the graphic as drawn on this frame is moved (and fitted) to its edge / corner (Type tool text does this in textLayout)
  if (pinOn(g) && g.tpl !== 'text') {
    const b = gfxBox(W, H, g, dur);
    if (b) { const p = pinBox(b, W, H, g); ctx.translate(p.x - b.x * p.k, p.y - b.y * p.k); ctx.scale(p.k, p.k); }
  }
  (DRAW[g.tpl] || DRAW.counter)(ctx, W, H, g, t, dur, th);
  ctx.restore();
}

// ---------------- 📌 Responsive Design (Premiere's "Pin to" + intro / outro) ----------------
// Pin to: g.pin = tl | t | tr | l | c | r | bl | b | br, pinMX / pinMY = margin from that edge (% of the frame's width /
// height, inward; for a centre pin an offset), pinSafe (default on) = measured from title safe (10% in) and kept inside it,
// pinW = also grow / shrink with the frame's width (against pinRef, the frame it was pinned on). A pinned graphic keeps its
// place against that edge whatever the sequence / export shape is, and never runs off the frame.
export const PIN_TPL = ['text', 'lower3', 'kinetic', 'logoreveal', 'ticker', 'counter', 'stats', 'bars', 'columns', 'line', 'donut', 'progress', 'list'];
export const PINS = [['', 'Not pinned'], ['tl', '↖ Top left'], ['t', '↑ Top'], ['tr', '↗ Top right'], ['l', '← Left'], ['c', '● Centre'], ['r', '→ Right'], ['bl', '↙ Bottom left'], ['b', '↓ Bottom'], ['br', '↘ Bottom right']];
export const SAFE = 0.1; // title safe: 10% in from every edge (the monitor's Guides)
export const pinOk = (g) => PIN_TPL.includes(g?.tpl) && g.pos !== 'full';
export const pinOn = (g) => !!g?.pin && pinOk(g);
// where a box { x, y, w, h } (frame px) of a graphic goes on a W x H frame when pinned: its new top-left and scale k
export function pinBox(b, W, H, g, { scale = true } = {}) {
  const pin = String(g.pin || 'c'), safe = g.pinSafe !== false;
  const R = safe ? { x: W * SAFE, y: H * SAFE, w: W * (1 - 2 * SAFE), h: H * (1 - 2 * SAFE) } : { x: 0, y: 0, w: W, h: H };
  const ref = Array.isArray(g.pinRef) && g.pinRef[0] > 0 && g.pinRef[1] > 0 ? g.pinRef : null;
  // (the templates already size themselves by the frame's short side; "scale with width" keeps the share of the width)
  let k = scale && g.pinW && ref ? (W / ref[0]) * (Math.min(ref[0], ref[1]) / Math.min(W, H)) : 1;
  if (scale && b.w > 0 && b.h > 0) k = Math.min(k, R.w / b.w, R.h / b.h); // never bigger than the room it has
  const w = b.w * k, h = b.h * k, mx = ((+g.pinMX || 0) / 100) * W, my = ((+g.pinMY || 0) / 100) * H;
  const hx = pin.endsWith('l') ? 0 : pin.endsWith('r') ? 1 : 0.5, vy = pin.startsWith('t') ? 0 : pin.startsWith('b') ? 1 : 0.5;
  let x = hx === 0 ? R.x + mx : hx === 1 ? R.x + R.w - w - mx : R.x + (R.w - w) / 2 + mx;
  let y = vy === 0 ? R.y + my : vy === 1 ? R.y + R.h - h - my : R.y + (R.h - h) / 2 + my;
  if (safe) { x = clamp(x, R.x, R.x + R.w - w); y = clamp(y, R.y, R.y + R.h - h); }
  return { x, y, w, h, k };
}
// the box a graphic covers on a W x H frame (its settled look: middle of the clip + just before the outro), measured from
// the pixels once and remembered; null where there is no canvas (tests) - then it is drawn unpinned
const BOXES = new Map();
let boxCv = null;
export function gfxBox(W, H, g, dur) {
  // (dur / t here are already the template's own time: drawn without the pin and without responsive time)
  const { pin, pinMX, pinMY, pinSafe, pinW, pinRef, rtime, intro, outro, ...raw } = g, key = JSON.stringify([raw, W, H, +(+dur).toFixed(3)]);
  if (BOXES.has(key)) return BOXES.get(key);
  if (!boxCv) { try { boxCv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : typeof document !== 'undefined' ? document.createElement('canvas') : null; } catch {} }
  if (!boxCv) return null;
  const q = Math.min(1, 480 / Math.max(W, H)), cw = Math.max(2, Math.ceil(W * q)), ch = Math.max(2, Math.ceil(H * q));
  boxCv.width = cw; boxCv.height = ch;
  const ctx = boxCv.getContext('2d', { willReadFrequently: true });
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (const t of [dur * 0.5, Math.max(0.05, dur - 0.55)]) {
    ctx.save(); ctx.setTransform(q, 0, 0, q, 0, 0); drawGraphic(ctx, W, H, raw, t, dur); ctx.restore();
    const d = ctx.getImageData(0, 0, cw, ch).data;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (d[(y * cw + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const b = x1 < 0 ? null : { x: x0 / q, y: y0 / q, w: (x1 - x0 + 1) / q, h: (y1 - y0 + 1) / q };
  if (BOXES.size > 300) BOXES.clear();
  BOXES.set(key, b);
  return b;
}

// ⏱ responsive time (Premiere's intro / outro): the template's intro and outro keep their length when the clip is made
// longer or shorter - only the middle (the hold) stretches. g.rtime on, g.intro / g.outro in seconds (defaults per template)
const RT = { counter: [3, 0.5], stats: [2.8, 0.5], bars: [3, 0.5], columns: [2.8, 0.5], line: [3, 0.5], donut: [2, 0.5], progress: [2, 0.5], list: [4.5, 0.5],
  callout: [1, 0.5], lower3: [1, 0.5], kinetic: [2.5, 0.5], logoreveal: [1.8, 0.5], endcard: [2, 0.5] };
export const rtimeOk = (g) => !!RT[g?.tpl];
export const rtimeOn = (g) => !!g?.rtime && rtimeOk(g);
export const rtimeOf = (g) => { const [i, o] = RT[g.tpl] || [0, 0]; return [Math.max(0, num(g.intro ?? i)), Math.max(0, num(g.outro ?? o)), GFX[g.tpl]?.dur || 5]; };
// t seconds into a clip of length d -> the time of the template's own D0-second animation (intro I, outro O)
export function rtimeMap(t, d, D0, I, O) {
  I = Math.min(I, D0); O = Math.min(O, D0 - I);
  if (!(d > 0)) return t;
  if (d < I + O) { const u = (t * (I + O)) / d; return u <= I ? u : D0 - (I + O - u); } // shorter than intro + outro: both squeezed
  if (t <= I) return t;
  if (t >= d - O) return D0 - (d - t);
  const mid = d - I - O;
  return mid > 0 ? I + ((t - I) * (D0 - I - O)) / mid : I;
}

function card(ctx, p, th, t, { pad = true } = {}) {
  const k = outBack(t / 0.6), a = clamp(t / 0.3);
  ctx.globalAlpha *= a;
  ctx.translate(p.x + p.w / 2, p.y + p.h / 2); ctx.scale(0.92 + 0.08 * k, 0.92 + 0.08 * k); ctx.translate(-(p.x + p.w / 2), -(p.y + p.h / 2));
  if (pad) { rr(ctx, p.x, p.y, p.w, p.h, p.u * 0.025); ctx.fillStyle = th.card; ctx.fill(); ctx.fillStyle = th.accent; ctx.fillRect(p.x, p.y, p.u * 0.012, p.h); }
}
function heading(ctx, p, g, th, t) {
  if (!g.title) return p.y + p.u * 0.04;
  ctx.save();
  const px = fitText(ctx, g.title, p.w * 0.88, p.u * 0.055);
  ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.globalAlpha *= clamp((t - 0.15) / 0.3);
  ctx.fillText(g.title, p.x + p.u * 0.05, p.y + p.u * 0.04);
  ctx.restore();
  return p.y + p.u * 0.04 + px * 1.5;
}

const DRAW = {
  // T Type tool text: fill, optional stroke, shadow and a background box behind the block
  text(ctx, W, H, g) {
    const L = textLayout(ctx, W, H, g), pad = L.px * 0.28;
    if (g.bg) {
      ctx.save(); ctx.globalAlpha *= Math.min(1, Math.max(0, g.bgOpacity ?? 0.6)); ctx.fillStyle = g.bgColor || '#000000';
      rr(ctx, L.x - pad, L.y - pad * 0.6, L.w + pad * 2, L.h + pad * 1.2, pad * 0.5); ctx.fill(); ctx.restore();
    }
    ctx.textBaseline = 'middle'; ctx.textAlign = g.align || 'center'; ctx.lineJoin = 'round';
    const ax = g.align === 'left' ? L.x : g.align === 'right' ? L.x + L.w : L.cx;
    L.lines.forEach((line, i) => {
      const y = L.y + L.lh * (i + 0.5);
      if (g.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = L.px * 0.12; ctx.shadowOffsetX = ctx.shadowOffsetY = L.px * 0.04; }
      if (g.stroke) { ctx.strokeStyle = g.strokeColor || '#000000'; ctx.lineWidth = (+g.strokeW || 6) * L.k * 2; ctx.strokeText(line, ax, y); ctx.shadowColor = 'transparent'; }
      ctx.fillStyle = g.color || '#ffffff'; ctx.fillText(line, ax, y);
      ctx.shadowColor = 'transparent';
    });
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  },
  counter(ctx, W, H, g, t, dur, th) {
    const p = panel(W, H, g, 0.42, 0.34);
    card(ctx, p, th, t);
    const k = outCubic((t - 0.3) / Math.max(0.5, Math.min(2.2, dur - 1.2)));
    const from = num(g.from), v = from + (num(g.value) - from) * k;
    const txt = `${g.prefix || ''}${fmtNum(v, +g.decimals || 0)}${g.suffix || ''}`;
    const full = `${g.prefix || ''}${fmtNum(num(g.value), +g.decimals || 0)}${g.suffix || ''}`;
    ctx.save(); const px = fitText(ctx, full, p.w * 0.86, p.u * 0.16, 800); ctx.restore();
    ctx.font = FONT(px, 800); ctx.fillStyle = th.accent; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const cy = p.y + p.h * (g.title ? 0.42 : 0.5);
    ctx.fillText(txt, p.x + p.w / 2, cy);
    ctx.globalAlpha *= clamp((t - 0.4) / 0.4);
    if (g.title) { ctx.font = FONT(fitText(ctx, g.title, p.w * 0.86, p.u * 0.05)); ctx.fillStyle = th.text; ctx.fillText(g.title, p.x + p.w / 2, p.y + p.h * 0.72); }
    if (g.sub) { ctx.font = FONT(fitText(ctx, g.sub, p.w * 0.86, p.u * 0.034, 500), 500); ctx.fillStyle = th.sub; ctx.fillText(g.sub, p.x + p.w / 2, p.y + p.h * 0.86); }
  },
  stats(ctx, W, H, g, t, dur, th) {
    const r = rows(g.data).slice(0, 4), vert = H > W;
    const p = panel(W, H, g, 0.82, vert ? 0.5 + r.length * 0.1 : 0.42);
    card(ctx, p, th, t);
    const top = heading(ctx, p, g, th, t), n = Math.max(1, r.length), cols = vert ? 1 : n;
    const cw = (p.w - p.u * 0.1) / cols, ch = (p.y + p.h - top - p.u * 0.04) / (vert ? n : 1);
    r.forEach((x, i) => {
      const a = clamp((t - 0.35 - i * 0.25) / 0.4), k = outCubic((t - 0.35 - i * 0.25) / 1.6);
      const cx = p.x + p.u * 0.05 + (vert ? 0 : i * cw), cy = top + (vert ? i * ch : 0);
      ctx.save(); ctx.globalAlpha *= a; ctx.translate(0, (1 - outCubic(a)) * p.u * 0.03);
      ctx.textAlign = vert ? 'left' : 'center'; ctx.textBaseline = 'top';
      const ax = vert ? cx : cx + cw / 2, val = x.text ? countText(x.text, k) : '';
      ctx.font = FONT(fitText(ctx, x.text || x.label, cw * 0.9, Math.min(ch * 0.5, p.u * 0.11), 800), 800); ctx.fillStyle = [th.accent, th.c2, th.c3, th.accent][i];
      ctx.fillText(val || x.label, ax, cy + ch * 0.05);
      if (x.text) { ctx.font = FONT(fitText(ctx, x.label, cw * 0.9, p.u * 0.04, 600), 600); ctx.fillStyle = th.text; ctx.fillText(x.label, ax, cy + ch * 0.62); }
      ctx.restore();
    });
  },
  bars(ctx, W, H, g, t, dur, th) {
    const r = rows(g.data).slice(0, 8), vert = H > W;
    const p = panel(W, H, g, 0.6, Math.min(0.85, 0.3 + r.length * 0.09));
    card(ctx, p, th, t);
    const top = heading(ctx, p, g, th, t), max = Math.max(1e-9, ...r.map((x) => x.v));
    const rowH = (p.y + p.h - top - p.u * 0.04) / Math.max(1, r.length), lw = p.w * (vert ? 0.34 : 0.3), bx = p.x + p.u * 0.05 + lw, bw = p.w - lw - p.u * 0.3;
    r.forEach((x, i) => {
      const k = outCubic((t - 0.4 - i * 0.18) / 1.2), y = top + i * rowH, bh = rowH * 0.56;
      ctx.globalAlpha = clamp((t - 0.3 - i * 0.18) / 0.3) * clamp((dur - t) / 0.4);
      ctx.font = FONT(fitText(ctx, x.label, lw - p.u * 0.02, Math.min(bh * 0.8, p.u * 0.042), 600), 600); ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(x.label, p.x + p.u * 0.05, y + rowH / 2);
      ctx.fillStyle = th.grid; rr(ctx, bx, y + (rowH - bh) / 2, bw, bh, bh / 2); ctx.fill();
      ctx.fillStyle = i === 0 ? th.accent : th.c2; rr(ctx, bx, y + (rowH - bh) / 2, Math.max(bh, bw * (x.v / max) * k), bh, bh / 2); ctx.fill();
      ctx.font = FONT(bh * 0.7, 800); ctx.fillStyle = th.text; ctx.textAlign = 'left';
      ctx.fillText(`${fmtNum(x.v * k, x.v % 1 ? 1 : 0)}${g.suffix || ''}`, bx + Math.max(bh, bw * (x.v / max) * k) + p.u * 0.012, y + rowH / 2);
    });
  },
  columns(ctx, W, H, g, t, dur, th) {
    const r = rows(g.data).slice(0, 10);
    const p = panel(W, H, g, 0.62, 0.62);
    card(ctx, p, th, t);
    const top = heading(ctx, p, g, th, t), max = Math.max(1e-9, ...r.map((x) => x.v));
    const base = p.y + p.h - p.u * 0.09, area = base - top - p.u * 0.06, cw = (p.w - p.u * 0.12) / Math.max(1, r.length);
    ctx.fillStyle = th.grid; ctx.fillRect(p.x + p.u * 0.05, base, p.w - p.u * 0.1, Math.max(1, p.u * 0.002));
    r.forEach((x, i) => {
      const k = outCubic((t - 0.4 - i * 0.12) / 1.1), h = area * (x.v / max) * k, bx = p.x + p.u * 0.06 + i * cw + cw * 0.18, bw = cw * 0.64;
      ctx.fillStyle = i === r.length - 1 ? th.accent : th.c2; rr(ctx, bx, base - h, bw, h, Math.min(bw * 0.15, h / 2)); ctx.fill();
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = th.text;
      ctx.globalAlpha = clamp((t - 0.6 - i * 0.12) / 0.4) * clamp((dur - t) / 0.4);
      ctx.font = FONT(fitText(ctx, `${fmtNum(x.v)}${g.suffix || ''}`, cw * 0.95, p.u * 0.036, 800), 800); ctx.fillText(`${fmtNum(x.v * k, x.v % 1 ? 1 : 0)}${g.suffix || ''}`, bx + bw / 2, base - h - p.u * 0.008);
      ctx.textBaseline = 'top'; ctx.font = FONT(fitText(ctx, x.label, cw * 0.95, p.u * 0.032, 600), 600); ctx.fillStyle = th.sub; ctx.fillText(x.label, bx + bw / 2, base + p.u * 0.015);
      ctx.globalAlpha = clamp((dur - t) / 0.4);
    });
  },
  line(ctx, W, H, g, t, dur, th) {
    const r = rows(g.data).slice(0, 16);
    const p = panel(W, H, g, 0.62, 0.62);
    card(ctx, p, th, t);
    const top = heading(ctx, p, g, th, t), max = Math.max(1e-9, ...r.map((x) => x.v)), min = Math.min(0, ...r.map((x) => x.v));
    const L = p.x + p.u * 0.08, R = p.x + p.w - p.u * 0.08, base = p.y + p.h - p.u * 0.09, T = top + p.u * 0.05;
    const pt = (i) => [L + ((R - L) * i) / Math.max(1, r.length - 1), base - ((r[i].v - min) / (max - min)) * (base - T)];
    ctx.strokeStyle = th.grid; ctx.lineWidth = Math.max(1, p.u * 0.002);
    for (let k = 0; k <= 3; k++) { const y = base - ((base - T) * k) / 3; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke(); }
    const prog = outCubic((t - 0.4) / Math.max(0.8, Math.min(2.5, dur - 1.5))) * (r.length - 1);
    // area + line drawn up to `prog`
    ctx.beginPath(); ctx.moveTo(...pt(0));
    for (let i = 1; i <= Math.floor(prog); i++) ctx.lineTo(...pt(i));
    const fi = Math.floor(prog), fr = prog - fi;
    let end = pt(fi);
    if (fi < r.length - 1 && fr > 0) { const a = pt(fi), b = pt(fi + 1); end = [a[0] + (b[0] - a[0]) * fr, a[1] + (b[1] - a[1]) * fr]; ctx.lineTo(...end); }
    ctx.strokeStyle = th.accent; ctx.lineWidth = p.u * 0.008; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    ctx.lineTo(end[0], base); ctx.lineTo(L, base); ctx.closePath();
    const gr = ctx.createLinearGradient(0, T, 0, base); gr.addColorStop(0, th.accent.length === 7 ? `${th.accent}55` : th.accent); gr.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = gr; ctx.fill();
    r.forEach((x, i) => {
      const [px, py] = pt(i), on = i <= prog + 0.01;
      ctx.globalAlpha = (on ? 1 : 0) * clamp((dur - t) / 0.4);
      ctx.fillStyle = th.text; ctx.beginPath(); ctx.arc(px, py, p.u * 0.008, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.font = FONT(p.u * 0.032, 800); ctx.fillText(`${fmtNum(x.v, x.v % 1 ? 1 : 0)}${g.suffix || ''}`, px, py - p.u * 0.015);
      ctx.globalAlpha = clamp((t - 0.3) / 0.4) * clamp((dur - t) / 0.4);
      ctx.textBaseline = 'top'; ctx.font = FONT(p.u * 0.03, 600); ctx.fillStyle = th.sub; ctx.fillText(x.label, px, base + p.u * 0.015);
    });
  },
  donut(ctx, W, H, g, t, dur, th) {
    const r = rows(g.data).slice(0, 6), vert = H > W, cols = [th.accent, th.c2, th.c3, '#e0b84c', '#c05ac0', '#888'];
    const p = panel(W, H, g, 0.56, vert ? 0.95 : 0.6);
    card(ctx, p, th, t);
    const top = heading(ctx, p, g, th, t), tot = r.reduce((a, x) => a + Math.max(0, x.v), 0) || 1;
    const rad = Math.min(vert ? p.w * 0.32 : (p.y + p.h - top) * 0.4, p.w * 0.25), cx = vert ? p.x + p.w / 2 : p.x + p.u * 0.06 + rad, cy = vert ? top + rad + p.u * 0.03 : (top + p.y + p.h) / 2;
    const k = outCubic((t - 0.35) / 1.4);
    let a0 = -Math.PI / 2;
    ctx.lineWidth = rad * 0.38;
    r.forEach((x, i) => {
      const a1 = a0 + (Math.max(0, x.v) / tot) * Math.PI * 2 * k;
      ctx.strokeStyle = cols[i]; ctx.beginPath(); ctx.arc(cx, cy, rad, a0, a1); ctx.stroke(); a0 = a1;
    });
    const lx = vert ? p.x + p.u * 0.06 : cx + rad * 1.4, ly0 = vert ? cy + rad * 1.35 : cy - (r.length * p.u * 0.065) / 2;
    r.forEach((x, i) => {
      ctx.globalAlpha = clamp((t - 0.6 - i * 0.15) / 0.3) * clamp((dur - t) / 0.4);
      const y = ly0 + i * p.u * 0.065;
      ctx.fillStyle = cols[i]; rr(ctx, lx, y, p.u * 0.03, p.u * 0.03, p.u * 0.006); ctx.fill();
      ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.font = FONT(p.u * 0.036, 800); ctx.fillText(`${fmtNum(x.v * k, x.v % 1 ? 1 : 0)}${g.suffix || ''}`, lx + p.u * 0.045, y - p.u * 0.004);
      const vw = ctx.measureText(`${fmtNum(x.v, x.v % 1 ? 1 : 0)}${g.suffix || ''}`).width;
      ctx.font = FONT(fitText(ctx, x.label, p.x + p.w - (lx + p.u * 0.07 + vw) - p.u * 0.04, p.u * 0.034, 500), 500); ctx.fillStyle = th.sub; ctx.fillText(x.label, lx + p.u * 0.06 + vw, y);
    });
  },
  progress(ctx, W, H, g, t, dur, th) {
    const p = panel(W, H, g, 0.42, 0.42);
    card(ctx, p, th, t);
    const v = clamp(num(g.value) / 100), k = outCubic((t - 0.3) / 1.6), rad = Math.min(p.h * 0.3, p.w * 0.2);
    const cx = p.x + p.w / 2, cy = p.y + p.h * (g.title ? 0.4 : 0.5);
    ctx.lineWidth = rad * 0.22; ctx.lineCap = 'round';
    ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = th.accent; ctx.beginPath(); ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * v * k); ctx.stroke();
    ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = FONT(rad * 0.62, 800);
    ctx.fillText(`${fmtNum(num(g.value) * k, num(g.value) % 1 ? 1 : 0)}%`, cx, cy);
    ctx.globalAlpha *= clamp((t - 0.5) / 0.4);
    if (g.title) { ctx.font = FONT(fitText(ctx, g.title, p.w * 0.9, p.u * 0.045)); ctx.fillText(g.title, cx, p.y + p.h * 0.8); }
    if (g.sub) { ctx.font = FONT(fitText(ctx, g.sub, p.w * 0.9, p.u * 0.03, 500), 500); ctx.fillStyle = th.sub; ctx.fillText(g.sub, cx, p.y + p.h * 0.91); }
  },
  list(ctx, W, H, g, t, dur, th) {
    const r = String(g.data || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 7);
    const p = panel(W, H, g, 0.48, Math.min(0.85, 0.28 + r.length * 0.1));
    card(ctx, p, th, t);
    const top = heading(ctx, p, g, th, t), rowH = (p.y + p.h - top - p.u * 0.03) / Math.max(1, r.length);
    const gap = Math.max(0.35, Math.min(0.9, (dur - 1.5) / Math.max(1, r.length)));
    r.forEach((s, i) => {
      const a = clamp((t - 0.5 - i * gap) / 0.3), y = top + i * rowH + rowH / 2, d = Math.min(rowH * 0.6, p.u * 0.05);
      ctx.save(); ctx.globalAlpha *= a; ctx.translate((1 - outCubic(a)) * -p.u * 0.04, 0);
      ctx.fillStyle = th.c2; ctx.beginPath(); ctx.arc(p.x + p.u * 0.07, y, d / 2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = d * 0.14; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(p.x + p.u * 0.07 - d * 0.22, y); ctx.lineTo(p.x + p.u * 0.07 - d * 0.05, y + d * 0.18); ctx.lineTo(p.x + p.u * 0.07 + d * 0.24, y - d * 0.18); ctx.stroke();
      ctx.font = FONT(fitText(ctx, s, p.w - p.u * 0.16, Math.min(rowH * 0.5, p.u * 0.045), 600), 600); ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(s, p.x + p.u * 0.11, y);
      ctx.restore();
    });
  },
  callout(ctx, W, H, g, t, dur, th) {
    const u = Math.min(W, H) * (g.scale || 1), px = (num(g.x ?? 50) / 100) * W, py = (num(g.y ?? 50) / 100) * H;
    // pulsing dot, a line out to the label, the label box
    const pulse = (t * 1.2) % 1;
    ctx.fillStyle = th.accent; ctx.globalAlpha *= clamp(t / 0.2);
    ctx.save(); ctx.globalAlpha *= 1 - pulse; ctx.strokeStyle = th.accent; ctx.lineWidth = u * 0.006; ctx.beginPath(); ctx.arc(px, py, u * (0.015 + 0.05 * pulse), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    ctx.beginPath(); ctx.arc(px, py, u * 0.014, 0, Math.PI * 2); ctx.fill();
    const right = px < W * 0.6, up = py > H * 0.35, ex = px + (right ? 1 : -1) * u * 0.16, ey = py + (up ? -1 : 1) * u * 0.12;
    const k = outCubic((t - 0.2) / 0.5);
    ctx.strokeStyle = th.accent; ctx.lineWidth = u * 0.005; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + (ex - px) * k, py + (ey - py) * k); ctx.stroke();
    if (!g.title && !g.sub) return;
    ctx.globalAlpha *= clamp((t - 0.55) / 0.3);
    ctx.font = FONT(u * 0.045); const tw = ctx.measureText(g.title || '').width; ctx.font = FONT(u * 0.03, 500); const sw = ctx.measureText(g.sub || '').width;
    const bw = Math.max(tw, sw) + u * 0.06, bh = u * (g.sub ? 0.12 : 0.08), bx = right ? ex : ex - bw, by = ey - bh / 2;
    rr(ctx, bx, by, bw, bh, u * 0.015); ctx.fillStyle = th.card; ctx.fill(); ctx.fillStyle = th.accent; ctx.fillRect(right ? bx : bx + bw - u * 0.008, by, u * 0.008, bh);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = th.text; ctx.font = FONT(u * 0.045); ctx.fillText(g.title || '', bx + u * 0.03, by + u * 0.015);
    if (g.sub) { ctx.font = FONT(u * 0.03, 500); ctx.fillStyle = th.sub; ctx.fillText(g.sub, bx + u * 0.03, by + u * 0.07); }
  },
  route(ctx, W, H, g, t, dur, th) {
    const stops = String(g.data || '').split(/\r?\n/).map((l) => l.split(/\s*,\s*/)).filter((p) => p.length >= 3).map((p) => ({ name: p[0], x: (num(p[1]) / 100) * W, y: (num(p[2]) / 100) * H }));
    if (stops.length < 2) return;
    const u = Math.min(W, H) * (g.scale || 1);
    const segs = stops.slice(1).map((s, i) => Math.hypot(s.x - stops[i].x, s.y - stops[i].y)), total = segs.reduce((a, b) => a + b, 0);
    const k = outCubic((t - 0.3) / Math.max(1, dur - 1.2)) * total;
    ctx.lineWidth = u * 0.008; ctx.lineCap = 'round'; ctx.strokeStyle = th.accent; ctx.setLineDash([u * 0.022, u * 0.016]);
    ctx.beginPath(); ctx.moveTo(stops[0].x, stops[0].y);
    let left = k, head = [stops[0].x, stops[0].y];
    for (let i = 0; i < segs.length && left > 0; i++) {
      const f = Math.min(1, left / segs[i]), a = stops[i], b = stops[i + 1];
      head = [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f]; ctx.lineTo(...head); left -= segs[i];
    }
    ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = th.accent; ctx.beginPath(); ctx.arc(head[0], head[1], u * 0.012, 0, Math.PI * 2); ctx.fill();
    let acc = 0;
    stops.forEach((s, i) => {
      if (i) acc += segs[i - 1];
      const a = clamp((k - acc + u * 0.05) / (u * 0.05)); // a pin appears as the line reaches it
      if (a <= 0) return;
      ctx.save(); ctx.globalAlpha *= a;
      // map pin
      const r = u * 0.022; ctx.fillStyle = i === stops.length - 1 ? th.c2 : th.accent;
      ctx.beginPath(); ctx.arc(s.x, s.y - r * 1.6, r, Math.PI * 0.85, Math.PI * 2.15); ctx.lineTo(s.x, s.y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s.x, s.y - r * 1.6, r * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.font = FONT(u * 0.036); const tw = ctx.measureText(s.name).width;
      rr(ctx, s.x - tw / 2 - u * 0.015, s.y + u * 0.012, tw + u * 0.03, u * 0.055, u * 0.01); ctx.fillStyle = th.card; ctx.fill();
      ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(s.name, s.x, s.y + u * 0.022);
      ctx.restore();
    });
    if (g.title) { ctx.globalAlpha *= clamp((t - 0.2) / 0.3); ctx.font = FONT(u * 0.05); ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = u * 0.01; ctx.fillText(g.title, W * 0.05, H * 0.06); }
  },

  // ---------------- 🎬 motion templates (Phase 19) ----------------
  // 🪪 name + designation. Styles: bar (card wipes in behind an accent strip), split (two blocks), line (text over an
  // underline, no card), pill (rounded tag). It slides back out over its last half second.
  lower3(ctx, W, H, g, t, dur, th) {
    const u = Math.min(W, H) * (g.scale || 1), vert = H > W, side = vert ? 'center' : g.side || 'left';
    const nameS = fitText(ctx, g.name || ' ', W * 0.8, u * 0.058, 800), roleS = fitText(ctx, g.role || ' ', W * 0.8, u * 0.036, 500);
    ctx.font = FONT(nameS, 800); const nw = ctx.measureText(g.name || '').width;
    ctx.font = FONT(roleS, 500); const rw = ctx.measureText(g.role || '').width;
    const padX = u * 0.03, w = Math.max(nw, rw) + padX * 2 + u * 0.012, h = nameS * 1.25 + (g.role ? roleS * 1.45 : 0) + u * 0.035;
    const x = side === 'right' ? W * 0.95 - w : side === 'center' ? (W - w) / 2 : W * 0.05;
    const y = g.pos === 'top' ? H * 0.08 : H * (vert ? 0.74 : 0.8) - h / 2;
    const inK = outCubic((t - 0.1) / 0.5), outK = clamp((dur - t) / 0.5), k = Math.min(inK, outCubic(outK));
    const style = g.style || 'bar', dir = side === 'right' ? -1 : 1;
    const nameIn = clamp((t - 0.3) / 0.35) * outK, roleIn = clamp((t - 0.45) / 0.35) * outK;
    const text = (cx, align) => {
      ctx.textAlign = align; ctx.textBaseline = 'top';
      ctx.save(); ctx.globalAlpha *= nameIn; ctx.font = FONT(nameS, 800); ctx.fillStyle = style === 'line' ? '#fff' : th.text;
      if (style === 'line') { ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = u * 0.012; }
      ctx.fillText(g.name || '', cx + dir * (1 - nameIn) * u * 0.04, y + u * 0.018); ctx.restore();
      if (g.role) { ctx.save(); ctx.globalAlpha *= roleIn; ctx.font = FONT(roleS, 500); ctx.fillStyle = style === 'split' ? th.solid || '#0b2545' : style === 'line' ? '#f2f2f2' : th.sub; // (split: dark text on the accent block)
        if (style === 'line') { ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = u * 0.012; }
        ctx.fillText(g.role, cx + dir * (1 - roleIn) * u * 0.04, y + u * 0.018 + nameS * 1.3); ctx.restore(); }
    };
    ctx.save();
    if (style === 'line') {
      ctx.fillStyle = th.accent; const lw = w * k; ctx.fillRect(dir > 0 ? x : x + w - lw, y + h - u * 0.008, lw, u * 0.006);
      text(side === 'right' ? x + w : side === 'center' ? x + w / 2 : x, side === 'right' ? 'right' : side === 'center' ? 'center' : 'left');
    } else if (style === 'split') {
      const h1 = nameS * 1.25 + u * 0.03;
      ctx.beginPath(); ctx.rect(dir > 0 ? x : x + w - w * k, y, w * k, h + u * 0.01); ctx.clip();
      ctx.fillStyle = th.solid || th.card; ctx.fillRect(x, y, w, h1);
      if (g.role) { const k2 = outCubic((t - 0.25) / 0.45) * outK; ctx.fillStyle = th.accent; ctx.fillRect(dir > 0 ? x : x + w - w * k2, y + h1, w * k2, h - h1 + u * 0.01); }
      text(side === 'right' ? x + w - padX : x + padX, side === 'right' ? 'right' : 'left');
    } else {
      const r = style === 'pill' ? h / 2 : u * 0.008;
      ctx.fillStyle = th.accent; const sh = h * clamp(t / 0.25) * outK; ctx.fillRect(dir > 0 ? x : x + w - u * 0.012, y + (h - sh) / 2, u * 0.012, sh);
      ctx.beginPath(); ctx.rect(dir > 0 ? x + u * 0.012 : x - 1, y - 2, (w - u * 0.012) * k + 1, h + 4); ctx.clip();
      rr(ctx, dir > 0 ? x + u * 0.012 : x, y, w - u * 0.012, h, r); ctx.fillStyle = th.card; ctx.fill();
      text(side === 'right' ? x + w - u * 0.012 - padX : x + u * 0.012 + padX, side === 'right' ? 'right' : 'left');
    }
    ctx.restore();
  },

  // ✨ words that arrive one by one. *Word* = highlighted in the accent colour. Styles: pop, rise, type (letter by
  // letter - Hindi letters stay whole), stack (big lines, highlights on a colour block).
  kinetic(ctx, W, H, g, t, dur, th) {
    const u = Math.min(W, H) * (g.scale || 1), style = g.style || 'pop';
    const lines = String(g.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 6);
    if (!lines.length) return;
    const words = lines.map((l) => l.split(/\s+/).map((w) => ({ hi: /^\*.*\*$/.test(w), s: w.replace(/^\*|\*$/g, '') })));
    const n = words.flat().length, step = Math.min(0.22, Math.max(0.06, (dur * 0.45) / n));
    const big = style === 'stack' ? 0.13 : 0.085, maxW = W * 0.86;
    const sizes = lines.map((l) => fitText(ctx, l.replace(/\*/g, ''), maxW, u * big, 800));
    const total = sizes.reduce((a, s) => a + s * 1.25, 0);
    let y = (g.pos === 'top' ? H * 0.12 : g.pos === 'lower' ? H * 0.88 - total : (H - total) / 2);
    const outK = clamp((dur - t) / 0.45);
    const fill = (w) => (w.hi && style !== 'stack' ? th.accent : g.pos === 'full' ? th.text : '#ffffff');
    let idx = 0;
    // letter-by-letter: whole letters (a Hindi letter with its matra is one)
    const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('hi', { granularity: 'grapheme' }) : null;
    const letters = (s) => (seg ? [...seg.segment(s)].map((x) => x.segment) : [...s]);
    const allLetters = letters(lines.join(' ').replace(/\*/g, '')).length;
    let shown = Math.floor(clamp(t / Math.max(0.6, dur * 0.55)) * allLetters);
    words.forEach((ws, li) => {
      const px = sizes[li]; ctx.font = FONT(px, 800);
      const space = ctx.measureText(' ').width, widths = ws.map((w) => ctx.measureText(w.s).width);
      const lineW = widths.reduce((a, b) => a + b, 0) + space * (ws.length - 1);
      let x = g.align === 'left' ? W * 0.07 : (W - lineW) / 2;
      ws.forEach((w, wi) => {
        const t0 = 0.15 + idx * step, a = clamp((t - t0) / 0.3), kk = outBack((t - t0) / 0.45);
        ctx.save();
        ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.font = FONT(px, 800);
        if (g.pos !== 'full') { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = u * 0.014; }
        ctx.globalAlpha *= outK;
        if (style === 'type') {
          const ls = letters(w.s), vis = ls.slice(0, Math.max(0, shown)).join(''); shown -= ls.length + 1;
          ctx.fillStyle = fill(w); ctx.fillText(vis, x, y);
          if (shown < 0 && shown > -ls.length - 2 && Math.floor(t * 2.5) % 2 === 0) { const cw = ctx.measureText(vis).width; ctx.fillStyle = th.accent; ctx.fillRect(x + cw + px * 0.06, y + px * 0.1, px * 0.07, px * 1.0); }
        } else if (style === 'rise') {
          ctx.beginPath(); ctx.rect(x - px * 0.1, y - px * 0.1, widths[wi] + px * 0.2, px * 1.35); ctx.clip();
          ctx.globalAlpha *= a; ctx.fillStyle = fill(w); ctx.fillText(w.s, x, y + (1 - outCubic((t - t0) / 0.4)) * px * 1.2);
        } else if (style === 'stack') {
          if (w.hi) { const bw = widths[wi] * clamp((t - t0) / 0.3); ctx.shadowBlur = 0; ctx.fillStyle = th.accent; ctx.fillRect(x - px * 0.08, y - px * 0.02, bw + px * 0.16, px * 1.18); }
          ctx.globalAlpha *= a; ctx.fillStyle = w.hi ? th.solid || '#0b2545' : fill(w); if (w.hi) ctx.shadowBlur = 0;
          ctx.fillText(w.s, x, y + (1 - outCubic((t - t0) / 0.35)) * px * 0.35);
        } else {
          const cx = x + widths[wi] / 2, cy = y + px * 0.55, sc = 0.3 + 0.7 * kk;
          ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
          ctx.globalAlpha *= a; ctx.fillStyle = fill(w); ctx.fillText(w.s, x, y);
        }
        ctx.restore();
        x += widths[wi] + space; idx++;
      });
      y += px * 1.25;
    });
  },

  // 🌟 the logo arrives. Styles: zoom (springs in, a light sweeps across), circle (a growing circle reveals it), lines
  // (accent lines meet, the logo fades in). The tagline follows letter-spaced.
  logoreveal(ctx, W, H, g, t, dur, th) {
    const u = Math.min(W, H) * (g.scale || 1), cx = W / 2, cy = H * (g.tagline ? 0.44 : 0.5), style = g.style || 'zoom';
    const img = gfxImage(g.logo), box = u * 0.42;
    let lw = box, lh = box;
    if (img) { const r = img.naturalWidth / img.naturalHeight; if (r > 1) lh = box / r; else lw = box * r; }
    const outK = clamp((dur - t) / 0.5);
    const drawLogo = (alpha) => {
      ctx.save(); ctx.globalAlpha *= alpha;
      if (img) ctx.drawImage(img, cx - lw / 2, cy - lh / 2, lw, lh);
      else { ctx.beginPath(); ctx.arc(cx, cy, box * 0.42, 0, Math.PI * 2); ctx.fillStyle = th.accent; ctx.fill(); ctx.font = FONT(box * 0.16, 800); ctx.fillStyle = th.solid || '#0b2545'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('LOGO', cx, cy); }
      ctx.restore();
    };
    ctx.save(); ctx.globalAlpha *= outK;
    if (style === 'circle') {
      const r = outCubic((t - 0.1) / 0.8) * Math.hypot(lw, lh) * 0.62;
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r + 1, 0, Math.PI * 2); ctx.clip(); drawLogo(1); ctx.restore();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.strokeStyle = th.accent; ctx.lineWidth = u * 0.008; ctx.globalAlpha *= clamp(1 - (t - 0.7) / 0.4); ctx.stroke();
    } else if (style === 'lines') {
      const k = outCubic((t - 0.05) / 0.6), L = W * 0.5;
      ctx.fillStyle = th.accent;
      ctx.save(); ctx.globalAlpha *= clamp(1 - (t - 0.8) / 0.4);
      ctx.fillRect(cx - L + (L - lw / 2) * k - lw / 2 * (1 - k), cy - lh / 2 - u * 0.02, lw * 0.6, u * 0.006);
      ctx.fillRect(cx + lw / 2 - lw * 0.6 + (L - lw / 2) * (1 - k), cy + lh / 2 + u * 0.014, lw * 0.6, u * 0.006);
      ctx.restore();
      drawLogo(clamp((t - 0.45) / 0.45));
    } else {
      const k = outBack((t - 0.05) / 0.7), sc = 0.55 + 0.45 * k;
      ctx.save(); ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy); drawLogo(clamp(t / 0.35));
      // light sweep over the logo only
      const sw = (t - 0.7) / 0.6;
      if (sw > 0 && sw < 1) {
        ctx.globalCompositeOperation = 'source-atop';
        const gx = cx - lw + sw * lw * 2, grad = ctx.createLinearGradient(gx - lw * 0.25, 0, gx + lw * 0.25, 0);
        grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.65)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad; ctx.fillRect(cx - lw / 2, cy - lh / 2, lw, lh);
      }
      ctx.restore();
    }
    if (g.tagline) {
      const a = clamp((t - 0.9) / 0.5), sp = (1 - outCubic((t - 0.9) / 0.8)) * u * 0.03;
      const px = fitText(ctx, g.tagline, W * 0.8, u * 0.05, 600);
      ctx.font = FONT(px, 600); ctx.globalAlpha *= a; ctx.fillStyle = g.pos === 'full' ? th.text : '#ffffff'; ctx.textBaseline = 'top';
      if (g.pos !== 'full') { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = u * 0.012; }
      const chars = [...g.tagline], widths = chars.map((c) => ctx.measureText(c).width), tw = widths.reduce((s, x) => s + x, 0) + sp * (chars.length - 1);
      // spacing between letters only for Latin text (it would break Hindi letters apart)
      if (/[ऀ-ॿ]/.test(g.tagline) || !sp) { ctx.textAlign = 'center'; ctx.fillText(g.tagline, cx, cy + box * 0.62); }
      else { let x = cx - tw / 2; ctx.textAlign = 'left'; chars.forEach((c, i) => { ctx.fillText(c, x, cy + box * 0.62); x += widths[i] + sp; }); }
    }
    ctx.restore();
  },

  // 🔚 the closing card: logo, a big line (Dhanyavaad / Thank you), then website / handles / helpline, one after another
  endcard(ctx, W, H, g, t, dur, th) {
    const u = Math.min(W, H) * (g.scale || 1), vert = H > W;
    // moving accent shapes in the corners
    ctx.save(); ctx.globalAlpha *= 0.9;
    const sweep = outCubic(t / 0.9);
    ctx.fillStyle = th.accent; ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W * 0.32 * sweep, H); ctx.lineTo(0, H - H * 0.32 * sweep); ctx.fill();
    ctx.globalAlpha *= 0.55; ctx.beginPath(); ctx.moveTo(W, 0); ctx.lineTo(W - W * 0.22 * sweep, 0); ctx.lineTo(W, H * 0.22 * sweep); ctx.fill();
    ctx.restore();
    const img = gfxImage(g.logo), box = u * (vert ? 0.3 : 0.24);
    let y = H * (vert ? 0.24 : 0.18);
    if (img || g.logo) {
      let lw = box, lh = box; if (img) { const r = img.naturalWidth / img.naturalHeight; if (r > 1) lh = box / r; else lw = box * r; }
      const k = outBack(t / 0.6);
      ctx.save(); ctx.globalAlpha *= clamp(t / 0.3); ctx.translate(W / 2, y + lh / 2); ctx.scale(0.7 + 0.3 * k, 0.7 + 0.3 * k);
      if (img) ctx.drawImage(img, -lw / 2, -lh / 2, lw, lh); else { ctx.beginPath(); ctx.arc(0, 0, box * 0.4, 0, Math.PI * 2); ctx.fillStyle = th.accent; ctx.fill(); }
      ctx.restore(); y += lh + u * 0.05;
    }
    if (g.title) {
      const px = fitText(ctx, g.title, W * 0.86, u * 0.12, 800), a = clamp((t - 0.35) / 0.4);
      ctx.save(); ctx.globalAlpha *= a; ctx.font = FONT(px, 800); ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(g.title, W / 2, y + (1 - outCubic((t - 0.35) / 0.5)) * u * 0.04); ctx.restore();
      y += px * 1.3;
      ctx.fillStyle = th.accent; const lw = u * 0.18 * outCubic((t - 0.6) / 0.4); ctx.fillRect(W / 2 - lw / 2, y, lw, u * 0.008); y += u * 0.04;
    }
    String(g.lines || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5).forEach((l, i) => {
      const px = fitText(ctx, l, W * 0.8, u * 0.045, 500), t0 = 0.75 + i * 0.18;
      ctx.save(); ctx.globalAlpha *= clamp((t - t0) / 0.35); ctx.font = FONT(px, 500); ctx.fillStyle = th.sub; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(l, W / 2, y + (1 - outCubic((t - t0) / 0.4)) * u * 0.03); ctx.restore();
      y += px * 1.55;
    });
  },

  // 📰 breaking / news strip: a label block and a line of text running along the bottom
  credits(ctx, W, H, g, t, dur, th) {
    const u = Math.min(W, H) * (g.scale || 1), lh = u * 0.06, head = u * 0.085;
    if (g.bg !== 'none') { ctx.fillStyle = th.solid || '#0b0b0f'; ctx.fillRect(0, 0, W, H); }
    const lines = String(g.text || '').split('\n'), total = (g.head ? head * 2 : 0) + lines.length * lh;
    // from just below the frame to just above it, evenly over the whole clip
    let y = H + (-(H + total) * clamp(t / Math.max(0.1, dur)));
    ctx.save(); ctx.textBaseline = 'top'; ctx.fillStyle = th.text;
    if (g.head) { ctx.font = FONT(head, 800); ctx.textAlign = 'center'; ctx.fillText(g.head, W / 2, y); y += head * 2; }
    for (const ln of lines) {
      const [a, b] = ln.split('|').map((x) => x.trim());
      if (b !== undefined) {
        ctx.font = FONT(lh * 0.55, 500); ctx.globalAlpha = 0.75; ctx.textAlign = 'right'; ctx.fillText(a, W / 2 - lh * 0.4, y + lh * 0.1);
        ctx.globalAlpha = 1; ctx.font = FONT(lh * 0.6, 700); ctx.textAlign = 'left'; ctx.fillText(b, W / 2 + lh * 0.4, y + lh * 0.05);
      } else if (a) { ctx.font = FONT(lh * 0.62, 700); ctx.textAlign = 'center'; ctx.fillText(a, W / 2, y); }
      y += lh;
    }
    ctx.restore();
  },
  crawl(ctx, W, H, g, t, dur, th) {
    const u = Math.min(W, H) * (g.scale || 1), h = u * 0.07, y = g.pos === 'top' ? H * 0.06 : g.pos === 'middle' ? H / 2 - h / 2 : H - h - H * 0.07;
    ctx.save(); ctx.font = FONT(h * 0.62, 700); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const text = String(g.text || '').replace(/\s*\n\s*/g, '   •   '), tw = ctx.measureText(text).width;
    // in from the right edge, out past the left edge, once over the clip
    const x = W - (W + tw) * clamp(t / Math.max(0.1, dur));
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, y, W, h);
    ctx.fillStyle = th.text; ctx.fillText(text, x, y + h / 2);
    ctx.restore();
  },
  ticker(ctx, W, H, g, t, dur, th) {
    const u = Math.min(W, H) * (g.scale || 1), h = u * 0.075, y = g.pos === 'top' ? H * 0.04 : H - h - H * 0.05;
    const k = outCubic(t / 0.45), outK = outCubic(clamp((dur - t) / 0.4));
    ctx.save();
    ctx.beginPath(); ctx.rect(0, y - 2, W * Math.min(k, outK), h + 4); ctx.clip();
    ctx.fillStyle = th.solid || th.card; ctx.fillRect(0, y, W, h);
    ctx.font = FONT(h * 0.5, 800); const lab = (g.label || 'BREAKING').toUpperCase(), lw = ctx.measureText(lab).width + h * 0.8;
    // the moving text, clipped right of the label
    ctx.save(); ctx.beginPath(); ctx.rect(lw, y, W - lw, h); ctx.clip();
    ctx.font = FONT(h * 0.46, 600); ctx.fillStyle = th.text; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const text = String(g.text || '').replace(/\s*\n\s*/g, '   •   '), tw = ctx.measureText(text).width, speed = u * 0.18 * (+g.speed || 1);
    const x0 = W - (t - 0.4) * speed, gap = W * 0.3;
    for (let x = ((x0 - lw) % (tw + gap) + (tw + gap)) % (tw + gap) + lw - (tw + gap); x < W; x += tw + gap) ctx.fillText(text, x, y + h / 2);
    ctx.restore();
    ctx.fillStyle = th.accent; ctx.fillRect(0, y, lw, h);
    // a little live pulse on the label
    ctx.fillStyle = th.solid || '#0b2545'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = FONT(h * 0.5, 800);
    ctx.fillText(lab, lw / 2 + h * 0.12, y + h / 2);
    ctx.globalAlpha *= 0.5 + 0.5 * Math.sin(t * 6); ctx.beginPath(); ctx.arc(h * 0.28, y + h / 2, h * 0.1, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.restore();
  },
};

// T where a Type tool text sits on a W x H frame: its lines, font, line height and box (x, y = its top-left, w, h);
// the viewer uses it to hit-test and to put the typing box exactly over the text
export function textLayout(ctx, W, H, g) {
  const L = textLayoutAt(ctx, W, H, g);
  if (!pinOn(g)) return L;
  // 📌 pinned: the block (with its background box) goes to its edge, at the size the pin gives it
  const pad = g.bg ? L.px * 0.28 : 0, box = (l) => ({ x: l.x - pad, y: l.y - pad * 0.6, w: l.w + pad * 2, h: l.h + pad * 1.2 });
  const p0 = pinBox(box(L), W, H, g), M = Math.abs(p0.k - 1) > 1e-6 ? textLayoutAt(ctx, W, H, g, p0.k) : L;
  const p = pinBox(box(M), W, H, g, { scale: false }), dx = p.x + pad - M.x, dy = p.y + pad * 0.6 - M.y;
  return { ...M, x: M.x + dx, y: M.y + dy, cx: M.cx + dx, cy: M.cy + dy };
}
function textLayoutAt(ctx, W, H, g, s = 1) {
  const k = (Math.min(W, H) / 1080) * s, px = Math.max(4, (+g.size || 90) * k), lh = px * (+g.lead || 1.2);
  const fam = `${g.font ? `"${String(g.font).replace(/"/g, '')}", ` : ''}"Nirmala UI", "Segoe UI", Arial, sans-serif`;
  const font = `${g.italic ? 'italic ' : ''}${g.bold === false ? 400 : 700} ${Math.round(px)}px ${fam}`;
  ctx.font = font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${((+g.track || 0) * px) / 100}px`;
  const lines = String(g.text ?? '').split(/\r?\n/);
  const widths = lines.map((l) => ctx.measureText(l || ' ').width), w = Math.max(px * 0.5, ...widths), h = lh * lines.length;
  const cx = ((g.x ?? 50) / 100) * W, cy = ((g.y ?? 50) / 100) * H;
  return { lines, widths, px, lh, font, k, x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
}

// fingerprint of a graphic as it will be baked (content + frame size + rate + length)
export function gfxKey(g, W, H, fps, dur) {
  const s = JSON.stringify([g, W, H, fps, +(+dur).toFixed(3), 2]);
  let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
