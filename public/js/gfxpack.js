// gfxpack.js - 🎬 Limelight's own motion template pack: openers, logo stings, titles, lower thirds, transitions,
// infographics, a broadcast / news package and social. Our own designs, drawn on the canvas like every graphic
// (graphics.js drawGraphic: the viewer draws it live, a render bakes the same frames). Hindi and English alike - the
// typewriters step by whole letters (grapheme clusters), so a matra never stands alone.
// Each template: { label, pack, dur, motion, common, def, fields } (as graphics.js GFX) and a draw function
// draw(ctx, W, H, g, t, dur, th, o) - th: the look's colours, o = { img(id), fam } (the logo loader, the font family).
// knobs: the template's own numbers the Presets page lets you change (how many shapes, how far they fly...) - read with
// kn(key, default) (gfxparams.js, g.ed.n); everything else (texts, colours, logo, timing...) is edited there for all of them.
import { eased, kn, logoEdit, logoPath, bgOn, mapCol, CUR } from './gfxparams.js';

// ---------------- helpers ----------------
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const P = (t, a, d) => clamp((t - a) / d); // progress of a step starting at a, lasting d
const E = { // (eased: the Presets page's motion feel can swap them all for one curve)
  out: eased((u) => 1 - Math.pow(1 - clamp(u), 3)),
  inOut: eased((u) => { u = clamp(u); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }),
  back: eased((u) => { u = clamp(u); const c = 1.7; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); }),
  expo: eased((u) => { u = clamp(u); return u >= 1 ? 1 : 1 - Math.pow(2, -10 * u); }),
};
const OUT = (t, dur, len = 0.45) => E.inOut((dur - t) / len); // 1, then down to 0 over the last `len` seconds
const F = (o, px, w = 700) => `${w} ${Math.max(1, Math.round(px))}px ${o.fam}`;
const solid = (th) => th.solid || String(th.card).replace(/[\d.]+\)$/, '1)');
const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('hi', { granularity: 'grapheme' }) : null;
export const graphemes = (s) => (SEG ? [...SEG.segment(String(s || ''))].map((x) => x.segment) : [...String(s || '')]);
// a pseudo-random number for frame n and seed k (glitches look the same in the viewer and the render)
const INDIC = /[\u0900-\u0DFF]/; // Devanagari … Sinhala
const rnd = (n, k = 0) => { const x = Math.sin(n * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2))); else ctx.rect(x, y, w, h); }
function fitPx(ctx, o, text, max, px, w = 700) { let s = px; ctx.font = F(o, s, w); while (s > 8 && ctx.measureText(text).width > max) { s *= 0.93; ctx.font = F(o, s, w); } return s; }
function text(ctx, o, s, x, y, px, { w = 700, color = '#fff', align = 'center', base = 'middle', spacing = 0, alpha = 1, max = 0 } = {}) {
  if (!s || alpha <= 0) return 0;
  ctx.save(); ctx.globalAlpha *= alpha;
  if (max) px = fitPx(ctx, o, s, max, px, w);
  ctx.font = F(o, px, w); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${INDIC.test(s) ? 0 : spacing}px`; // (spacing tears joined letters of Hindi apart)
  ctx.fillText(s, x, y);
  const m = ctx.measureText(s).width;
  ctx.restore();
  return m;
}
const offscreen = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h))) : typeof document !== 'undefined' && typeof document.createElement === 'function' ? Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.ceil(w)), height: Math.max(1, Math.ceil(h)) }) : null);
// the logo (an image of the media pool), fitted in a box; without one a round badge with the initials
// (its size, move and shape as changed on the Presets page: logoEdit)
function logoSize(o, g, box) {
  const img = o.img(g.logo), e = logoEdit(); box *= e.k;
  if (!img) return { img: null, w: box, h: box, dx: e.dx, dy: e.dy, shape: e.shape };
  const r = img.naturalWidth / img.naturalHeight;
  return { img, w: r > 1 ? box : box * r, h: r > 1 ? box / r : box, dx: e.dx, dy: e.dy, shape: e.shape };
}
function drawLogo(ctx, o, g, th, cx, cy, L, inner = false) {
  if (!inner) { cx += L.dx || 0; cy += L.dy || 0; } // (on its own canvas it stays in the middle - the canvas moves)
  if (L.img) { ctx.save(); if (logoPath(ctx, cx - L.w / 2, cy - L.h / 2, L.w, L.h, L.shape)) ctx.clip(); ctx.drawImage(L.img, cx - L.w / 2, cy - L.h / 2, L.w, L.h); ctx.restore(); return; }
  const r = L.w * 0.42;
  if (!logoPath(ctx, cx - r, cy - r, r * 2, r * 2, L.shape)) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); }
  const sw = (c) => (inner ? mapCol(c, CUR.g?.ed?.cmap) : c); // (its own canvas is not the wrapped one: the colour swaps here)
  ctx.fillStyle = sw(th.accent); ctx.fill();
  text(ctx, o, 'LOGO', cx, cy, r * 0.42, { w: 800, color: sw(solid(th)), spacing: r * 0.03 });
}
// the logo on its own canvas (to tint it, cut light into it)
function logoCanvas(o, g, th, L, pad = 0) {
  const c = offscreen(L.w + pad * 2, L.h + pad * 2); if (!c) return null;
  drawLogo(c.getContext('2d'), o, g, th, c.width / 2, c.height / 2, L, true);
  return c;
}
// a platform's mark, drawn (not an image): a coloured badge with a simple white sign
export const PLATFORMS = [['youtube', 'YouTube'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['x', 'X (Twitter)'], ['linkedin', 'LinkedIn'], ['whatsapp', 'WhatsApp'], ['web', 'Website']];
function platformIcon(ctx, o, p, x, y, s) {
  ctx.save(); ctx.translate(x, y);
  const r = s / 2;
  if (p === 'instagram') { const gr = ctx.createLinearGradient(-r, r, r, -r); gr.addColorStop(0, '#feda75'); gr.addColorStop(0.35, '#fa7e1e'); gr.addColorStop(0.65, '#d62976'); gr.addColorStop(1, '#4f5bd5'); ctx.fillStyle = gr; }
  else ctx.fillStyle = { youtube: '#ff0000', facebook: '#1877f2', x: '#111111', linkedin: '#0a66c2', whatsapp: '#25d366', web: '#4f8cff' }[p] || '#4f8cff';
  if (p === 'facebook' || p === 'whatsapp' || p === 'web') { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); } else { rr(ctx, -r, -r * (p === 'youtube' ? 0.72 : 1), s, s * (p === 'youtube' ? 0.72 : 1), s * 0.24); ctx.fill(); }
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = s * 0.08;
  if (p === 'youtube') { ctx.beginPath(); ctx.moveTo(-r * 0.28, -r * 0.34); ctx.lineTo(r * 0.38, 0); ctx.lineTo(-r * 0.28, r * 0.34); ctx.closePath(); ctx.fill(); }
  else if (p === 'instagram') { rr(ctx, -r * 0.55, -r * 0.55, r * 1.1, r * 1.1, r * 0.32); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, r * 0.26, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(r * 0.32, -r * 0.32, r * 0.07, 0, Math.PI * 2); ctx.fill(); }
  else if (p === 'whatsapp') { ctx.beginPath(); ctx.arc(0, 0, r * 0.52, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-r * 0.42, r * 0.3); ctx.lineTo(-r * 0.6, r * 0.62); ctx.lineTo(-r * 0.22, r * 0.48); ctx.fill(); }
  else if (p === 'web') { ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.ellipse(0, 0, r * 0.24, r * 0.55, 0, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-r * 0.55, 0); ctx.lineTo(r * 0.55, 0); ctx.stroke(); }
  else text(ctx, o, { facebook: 'f', x: 'X', linkedin: 'in' }[p] || '•', 0, s * 0.03, s * (p === 'linkedin' ? 0.5 : 0.62), { w: 800, color: '#fff' });
  ctx.restore();
}
// an own background for openers / stings: the look's colour with a soft dark vignette
function stage(ctx, W, H, th, g) {
  if (g.pos !== 'full') return;
  const gr = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.1, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  gr.addColorStop(0, 'rgba(255,255,255,0.06)'); gr.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
}

// ---------------- the fields they share ----------------
const BG = { k: 'pos', label: 'Background', type: 'select', options: [['full', 'Own background (the look\'s colour)'], ['center', 'Over the video']] };
const LOGO = { k: 'logo', label: 'Logo (image from the media pool)', type: 'select', options: [] };
const SIDE = { k: 'side', label: 'Side', type: 'select', options: [['left', 'Left'], ['right', 'Right']] };
const T = (k, label) => ({ k, label, type: 'text' });
const A = (k, label, rows = 3) => ({ k, label, type: 'area', rows, wide: true });
const C = (k, label) => ({ k, label, type: 'color' });
const M = { motion: true, common: ['theme', 'scale'] };

export const PACK_ORDER = ['Openers', 'Logo stings', 'Titles', 'Lower thirds', 'Transitions', 'Infographics', 'Broadcast / News', 'Social'];

export const PACK = {
  // ---- Openers
  op_cinema: { ...M, pack: 'Openers', label: 'Cinematic opener', dur: 5, def: { title: 'नई उड़ान', sub: 'A LIMELIGHT FILM', pos: 'full', theme: 'dark' }, fields: [T('title', 'Title'), T('sub', 'Line below'), BG] },
  op_promo: { ...M, knobs: [{ k: 'step', label: 'Time per flash word', min: 0.15, max: 1.5, step: 0.01, def: 0.42 }], pack: 'Openers', label: 'Fast promo opener', dur: 4, def: { words: 'BOLD\nFAST\nNEW', title: 'Big Sale', sub: 'Starts 1 November', pos: 'full', theme: 'mygov' }, fields: [A('words', 'Flash words - one per line'), T('title', 'Last title'), T('sub', 'Line below'), BG] },
  op_docu: { ...M, pack: 'Openers', label: 'Documentary opener', dur: 6, def: { title: 'माटी की कहानी\nStories of the Soil', place: 'BASTAR · CHHATTISGARH · 2026', pos: 'full', theme: 'dark' }, fields: [A('title', 'Title - one or two lines', 2), T('place', 'Place · year'), BG] },
  op_tiranga: { ...M, pack: 'Openers', label: 'Tricolour opener', dur: 5, def: { title: 'विकसित भारत', sub: 'Viksit Bharat @2047', pos: 'full', theme: 'mygov' }, fields: [T('title', 'Title'), T('sub', 'Line below'), BG] },
  // ---- Logo stings
  ls_sweep: { ...M, pack: 'Logo stings', label: 'Logo - light sweep', dur: 3.5, def: { logo: '', tagline: 'Limelight Films', pos: 'full', theme: 'dark' }, fields: [LOGO, T('tagline', 'Tagline'), BG] },
  ls_glitch: { ...M, knobs: [{ k: 'strips', label: 'Glitch strips', min: 1, max: 30, step: 1, def: 9 }, { k: 'shift', label: 'Colour split', min: 0, max: 4, step: 0.05, def: 1 }], pack: 'Logo stings', label: 'Logo - glitch', dur: 3.5, def: { logo: '', tagline: 'LIMELIGHT', pos: 'full', theme: 'dark' }, fields: [LOGO, T('tagline', 'Tagline'), BG] },
  ls_shapes: { ...M, knobs: [{ k: 'count', label: 'Shapes', min: 0, max: 40, step: 1, def: 9 }, { k: 'size', label: 'Shape size', min: 0.2, max: 4, step: 0.05, def: 1 }, { k: 'spread', label: 'Burst distance', min: 0, max: 3, step: 0.05, def: 1 }, { k: 'spin', label: 'Spin', min: 0, max: 5, step: 0.1, def: 1 }], pack: 'Logo stings', label: 'Logo - shapes burst', dur: 3.5, def: { logo: '', tagline: 'Creative Studio', pos: 'full', theme: 'mygov' }, fields: [LOGO, T('tagline', 'Tagline'), BG] },
  ls_minimal: { ...M, pack: 'Logo stings', label: 'Logo - minimal', dur: 3.5, def: { logo: '', tagline: 'since 2010', pos: 'full', theme: 'light' }, fields: [LOGO, T('tagline', 'Tagline'), BG] },
  // ---- Titles
  ti_split: { ...M, pack: 'Titles', label: 'Title - split reveal', dur: 4, def: { title: 'छत्तीसगढ़', sub: 'Heart of India', pos: 'center', theme: 'dark' }, fields: [T('title', 'Title'), T('sub', 'Line below'), { k: 'pos', label: 'Background', type: 'select', options: [['center', 'Over the video'], ['full', 'Own background']] }] },
  ti_type: { ...M, pack: 'Titles', label: 'Title - typewriter', dur: 4, def: { title: 'हर घर तक पहुँच', sub: 'Reaching every home', box: true, pos: 'center', theme: 'dark' }, fields: [T('title', 'Title'), T('sub', 'Line below'), { k: 'box', label: 'Dark box behind', type: 'check' }] },
  ti_stack: { ...M, pack: 'Titles', label: 'Title - colour blocks', dur: 4, def: { text: 'SAPNE\nHONGE\nSACH', align: 'left', pos: 'center', theme: 'mygov' }, fields: [A('text', 'Lines (up to 4)', 4), { k: 'align', label: 'Align', type: 'select', options: [['left', 'Left'], ['center', 'Centre']] }] },
  ti_outline: { ...M, pack: 'Titles', label: 'Title - outline draw', dur: 4, def: { title: 'INCREDIBLE', sub: 'अतुल्य', pos: 'center', theme: 'dark' }, fields: [T('title', 'Title'), T('sub', 'Line below')] },
  ti_quote: { ...M, pack: 'Titles', label: 'Quote card', dur: 6, def: { quote: 'सपने वो नहीं जो हम सोते हुए देखते हैं, सपने वो हैं जो हमें सोने नहीं देते।', author: 'Dr. A.P.J. Abdul Kalam', pos: 'full', theme: 'mygov' }, fields: [A('quote', 'Quote'), T('author', 'Who said it'), BG] },
  ti_chapter: { ...M, pack: 'Titles', label: 'Chapter title', dur: 4, def: { num: '01', title: 'शुरुआत', sub: 'The Beginning', pos: 'full', theme: 'dark' }, fields: [T('num', 'Number'), T('title', 'Title'), T('sub', 'Line below'), BG] },
  // ---- Lower thirds
  lt_news: { ...M, pack: 'Lower thirds', label: 'Lower third - news', dur: 6, def: { tag: 'LIVE', name: 'Ravi Sharma', role: 'Correspondent, Raipur', red: '#e11d2e', side: 'left', theme: 'mygov' }, fields: [T('tag', 'Box label (LIVE, channel)'), T('name', 'Name'), T('role', 'Second line'), C('red', 'Box colour'), SIDE] },
  lt_corp: { ...M, pack: 'Lower thirds', label: 'Lower third - corporate', dur: 5, def: { name: 'Priya Verma', role: 'Director, Limelight', side: 'left', theme: 'light' }, fields: [T('name', 'Name'), T('role', 'Second line'), SIDE] },
  lt_interview: { ...M, pack: 'Lower thirds', label: 'Lower third - interview', dur: 5, def: { name: 'सुनीता देवी', role: 'Self-help group, Kanker', side: 'left', theme: 'mygov' }, fields: [T('name', 'Name'), T('role', 'Second line'), SIDE] },
  lt_social: { ...M, pack: 'Lower thirds', label: 'Lower third - social handle', dur: 5, def: { platform: 'instagram', handle: '@limelightfilms', sub: 'Follow for more', side: 'left', theme: 'dark' }, fields: [{ k: 'platform', label: 'Platform', type: 'select', options: PLATFORMS }, T('handle', 'Handle'), T('sub', 'Small line'), SIDE] },
  lt_location: { ...M, pack: 'Lower thirds', label: 'Lower third - location', dur: 5, def: { place: 'चित्रकोट जलप्रपात', sub: 'Bastar, Chhattisgarh · 2026', side: 'left', theme: 'dark' }, fields: [T('place', 'Place'), T('sub', 'Second line'), SIDE] },
  // ---- Transitions (lay it over a cut: the picture is covered at the middle of the clip)
  tr_wipe: { ...M, pack: 'Transitions', label: 'Transition - colour wipe', dur: 1.2, def: { dir: 'right', theme: 'mygov' }, fields: [{ k: 'dir', label: 'Direction', type: 'select', options: [['right', 'To the right'], ['left', 'To the left'], ['up', 'Up'], ['down', 'Down']] }] },
  tr_iris: { ...M, pack: 'Transitions', label: 'Transition - circle', dur: 1.2, def: { theme: 'mygov' }, fields: [] },
  tr_leak: { ...M, pack: 'Transitions', label: 'Transition - light leak', dur: 1.6, def: { warmth: 'warm', theme: 'dark' }, fields: [{ k: 'warmth', label: 'Colour', type: 'select', options: [['warm', 'Warm (orange)'], ['gold', 'Golden'], ['cool', 'Cool (blue)'], ['pink', 'Pink']] }] },
  tr_glitch: { ...M, knobs: [{ k: 'strips', label: 'Glitch strips', min: 0.2, max: 3, step: 0.05, def: 1 }], pack: 'Transitions', label: 'Transition - glitch', dur: 0.8, def: { theme: 'dark' }, fields: [] },
  // ---- Infographics
  in_timeline: { ...M, pack: 'Infographics', label: 'Timeline (milestones)', dur: 7, def: { title: 'सफ़र अब तक', data: '2014, Yojana shuru\n2018, 1 crore ghar\n2022, 3 crore ghar\n2025, 4 crore ghar', pos: 'center', theme: 'mygov' }, fields: [T('title', 'Heading'), A('data', 'Milestones - one per line: Year, what happened', 5)] },
  in_compare: { ...M, pack: 'Infographics', label: 'Then vs now', dur: 5, def: { title: 'बदलाव', aLabel: '2014', aValue: '25%', bLabel: '2025', bValue: '97%', note: 'Villages with roads', pos: 'center', theme: 'mygov' }, fields: [T('title', 'Heading'), T('aLabel', 'Then (label)'), T('aValue', 'Then (value)'), T('bLabel', 'Now (label)'), T('bValue', 'Now (value)'), T('note', 'What it measures')] },
  in_icons: { ...M, pack: 'Infographics', label: 'Icon count (x out of 10)', dur: 5, def: { title: '10 में से 7 महिलाएँ', value: 7, icon: 'person', note: 'are members of a self-help group', pos: 'center', theme: 'mygov' }, fields: [T('title', 'Heading'), { k: 'value', label: 'How many (of 10)', type: 'range', min: 0, max: 10, step: 0.5, def: 7 }, { k: 'icon', label: 'Icon', type: 'select', options: [['person', 'Person'], ['house', 'House'], ['drop', 'Water drop'], ['tree', 'Tree']] }, T('note', 'Line below')] },
  in_steps: { ...M, pack: 'Infographics', label: 'Steps (how it works)', dur: 6, def: { title: 'आवेदन कैसे करें', data: 'Register online\nUpload documents\nVerification\nGet benefit', pos: 'center', theme: 'mygov' }, fields: [T('title', 'Heading'), A('data', 'Steps - one per line', 5)] },
  // ---- Broadcast / News
  bn_breaking: { ...M, pack: 'Broadcast / News', label: 'Breaking news (big)', dur: 6, def: { label: 'BREAKING NEWS', headline: 'मुख्यमंत्री ने 100 नई बसों को हरी झंडी दिखाई', red: '#e11d2e', pos: 'lower', theme: 'mygov' }, fields: [T('label', 'Label'), T('headline', 'Headline'), C('red', 'Colour'), { k: 'pos', label: 'Position', type: 'select', options: [['lower', 'Bottom'], ['center', 'Centre (full banner)']] }] },
  bn_headline: { ...M, pack: 'Broadcast / News', label: 'News headline strip', dur: 7, def: { tag: 'RAIPUR', headline: 'Bus service now reaches 850 villages', sub: 'Chief Minister Rural Bus Scheme', red: '#e11d2e', theme: 'mygov' }, fields: [T('tag', 'Tag (place / topic)'), T('headline', 'Headline'), T('sub', 'Line below'), C('red', 'Tag colour')] },
  bn_bug: { ...M, pack: 'Broadcast / News', label: 'Channel bug + LIVE + clock', dur: 10, def: { logo: '', channel: 'LIMELIGHT NEWS', clock: '10:30', live: true, red: '#e11d2e', theme: 'dark' }, fields: [LOGO, T('channel', 'Channel name (no logo)'), T('clock', 'Time shown'), { k: 'live', label: 'LIVE tag', type: 'check' }, C('red', 'LIVE colour')] },
  bn_live: { ...M, pack: 'Broadcast / News', label: 'LIVE from (place)', dur: 6, def: { place: 'Naya Raipur', date: '24 October 2026', red: '#e11d2e', theme: 'dark' }, fields: [T('place', 'Place'), T('date', 'Date / time'), C('red', 'LIVE colour')] },
  // ---- Social
  so_subscribe: { ...M, pack: 'Social', label: 'Subscribe button (click + bell)', dur: 4, def: { label: 'SUBSCRIBE', done: 'SUBSCRIBED', pos: 'lower', theme: 'dark' }, fields: [T('label', 'Button'), T('done', 'After the click'), { k: 'pos', label: 'Position', type: 'select', options: [['lower', 'Bottom'], ['center', 'Centre']] }] },
  so_follow: { ...M, pack: 'Social', label: 'Follow us (handles)', dur: 6, def: { title: 'हमें फ़ॉलो करें', data: 'instagram, @limelightfilms\nyoutube, Limelight Films\nfacebook, /limelightfilms\nx, @limelight', pos: 'full', theme: 'mygov' }, fields: [T('title', 'Heading'), A('data', 'One per line: platform, handle (youtube, instagram, facebook, x, linkedin, whatsapp, web)', 5), BG] },
  so_like: { ...M, pack: 'Social', label: 'Like · comment · share', dur: 4, def: { like: 'Like', comment: 'Comment', share: 'Share', pos: 'lower', theme: 'dark' }, fields: [T('like', 'Like'), T('comment', 'Comment'), T('share', 'Share'), { k: 'pos', label: 'Position', type: 'select', options: [['lower', 'Bottom'], ['center', 'Centre']] }] },
  so_hashtag: { ...M, pack: 'Social', label: 'Hashtag', dur: 4, def: { tag: 'HarGharTiranga', sub: 'Share your story', pos: 'lower', theme: 'mygov' }, fields: [T('tag', 'Hashtag (without #)'), T('sub', 'Small line'), { k: 'pos', label: 'Position', type: 'select', options: [['lower', 'Bottom'], ['center', 'Centre'], ['top', 'Top']] }] },
};

// ---------------- the drawings ----------------
export const PACK_DRAW = {
  // ===== Openers
  op_cinema(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), cx = W / 2, cy = H * 0.48;
    stage(ctx, W, H, th, g);
    const lineW = W * 0.34 * E.inOut(P(t, 0.25, 0.9)), ly = cy + u * 0.1;
    ctx.fillStyle = th.accent; ctx.fillRect(cx - lineW, ly, lineW * 2, Math.max(1, u * 0.004));
    // a soft light travelling along the line
    const fx = cx - lineW + lineW * 2 * E.inOut(P(t, 0.35, 1.2));
    if (P(t, 0.35, 1.2) > 0 && P(t, 0.35, 1.2) < 1) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; const gr = ctx.createRadialGradient(fx, ly, 0, fx, ly, u * 0.12); gr.addColorStop(0, 'rgba(255,240,200,0.9)'); gr.addColorStop(1, 'rgba(255,200,120,0)'); ctx.fillStyle = gr; ctx.fillRect(fx - u * 0.12, ly - u * 0.12, u * 0.24, u * 0.24); ctx.restore(); }
    const k = E.out(P(t, 0.4, 1.4)), sc = 1.08 - 0.08 * k;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(sc, sc);
    text(ctx, o, g.title, 0, 0, u * 0.13, { w: 800, color: th.text, spacing: u * (0.05 - 0.04 * k), alpha: P(t, 0.4, 1), max: W * 0.86 });
    ctx.restore();
    text(ctx, o, g.sub, cx, ly + u * 0.07, u * 0.034, { w: 600, color: th.sub, spacing: u * 0.012, alpha: P(t, 1.3, 0.7), max: W * 0.8 });
    // letterbox bars close in at the start
    const bar = H * 0.12 * E.out(P(t, 0, 0.9));
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar);
  },
  op_promo(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), words = lines(g.words).slice(0, 5), step = kn('step', 0.42), cols = [th.accent, th.c2, th.c3, solid(th)];
    const i = Math.floor(t / step);
    if (i < words.length) {
      const k = E.expo(P(t, i * step, 0.18)), col = cols[i % cols.length];
      ctx.fillStyle = col; ctx.fillRect(-W + W * k, 0, W, H);
      ctx.save(); ctx.translate(W / 2, H / 2); const s = 1.25 - 0.25 * E.out(P(t, i * step, step)); ctx.scale(s, s);
      text(ctx, o, words[i], 0, 0, u * 0.32, { w: 900, color: i % cols.length === 3 ? th.accent : '#fff', max: W * 0.9 });
      ctx.restore();
      return;
    }
    const t0 = words.length * step, k = E.out(P(t, t0, 0.5));
    if (g.pos === 'full' && !bgOn(g)) { ctx.fillStyle = solid(th); ctx.fillRect(0, 0, W, H); }
    ctx.fillStyle = th.accent; ctx.fillRect(0, H * 0.5 + u * 0.1, W * k, u * 0.02);
    ctx.fillStyle = th.c2; ctx.fillRect(W - W * k, H * 0.5 - u * 0.13, W * k, u * 0.012);
    text(ctx, o, g.title, W / 2, H * 0.47, u * 0.16, { w: 900, color: th.text, alpha: k, max: W * 0.86 });
    text(ctx, o, g.sub, W / 2, H * 0.5 + u * 0.19, u * 0.045, { w: 600, color: th.sub, alpha: P(t, t0 + 0.3, 0.4), max: W * 0.8 });
  },
  op_docu(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), L = lines(g.title).slice(0, 2);
    stage(ctx, W, H, th, g);
    const z = 1 + 0.035 * (t / dur);
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2);
    // thin frame lines
    ctx.strokeStyle = th.grid; ctx.lineWidth = Math.max(1, u * 0.002);
    const fl = E.inOut(P(t, 0, 1.2));
    ctx.beginPath(); ctx.moveTo(W * 0.08, H * 0.3); ctx.lineTo(W * 0.08 + W * 0.84 * fl, H * 0.3); ctx.moveTo(W * 0.92, H * 0.7); ctx.lineTo(W * 0.92 - W * 0.84 * fl, H * 0.7); ctx.stroke();
    L.forEach((s, i) => {
      const y = H * 0.46 + i * u * 0.13 - (L.length - 1) * u * 0.065, k = E.out(P(t, 0.6 + i * 0.5, 1.1)), px = i ? u * 0.07 : u * 0.11;
      ctx.save(); ctx.beginPath(); ctx.rect(0, y - px, W, px * 1.6); ctx.clip();
      text(ctx, o, s, W / 2, y + px * (1 - k), px, { w: i ? 500 : 700, color: i ? th.sub : th.text, max: W * 0.8, spacing: i ? u * 0.004 : 0 });
      ctx.restore();
    });
    const pl = graphemes(g.place), n = Math.floor(pl.length * P(t, 1.8, 1.4));
    text(ctx, o, pl.slice(0, n).join(''), W / 2, H * 0.7 - u * 0.05, u * 0.028, { w: 600, color: th.accent, spacing: u * 0.008, max: W * 0.8 });
    ctx.restore();
  },
  op_tiranga(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), cols = ['#ff9933', '#ffffff', '#138808'];
    if (g.pos === 'full' && !bgOn(g)) { const gr = ctx.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#0b2545'); gr.addColorStop(1, '#13315c'); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H); }
    // three ribbons sweep across, then settle as a thin tricolour line under the title
    const sweep = E.inOut(P(t, 0, 1.3)), settle = E.inOut(P(t, 1.1, 0.8)), bh = H * 0.16 * (1 - settle) + u * 0.008 * settle;
    const yLine = H * 0.58, w3 = W * 0.44 * settle + W * 1.2 * (1 - settle);
    cols.forEach((c, i) => {
      ctx.save(); ctx.fillStyle = c;
      const y = (1 - settle) * (H * 0.26 + i * H * 0.17) + settle * (yLine + i * bh * 1.15), x = (1 - settle) * (-W * 1.2 + W * 1.25 * sweep - i * W * 0.06) + settle * (W / 2 - w3 / 2);
      ctx.transform(1, 0, -0.35 * (1 - settle), 1, 0, 0); ctx.fillRect(x + (1 - settle) * y * 0.35, y, w3, bh); ctx.restore();
    });
    const k = E.out(P(t, 1.4, 0.9));
    text(ctx, o, g.title, W / 2, yLine - u * 0.1 + u * 0.03 * (1 - k), u * 0.13, { w: 800, color: '#ffffff', alpha: k, max: W * 0.86 });
    text(ctx, o, g.sub, W / 2, yLine + u * 0.09, u * 0.04, { w: 600, color: '#ffd8a8', alpha: P(t, 1.9, 0.6), spacing: u * 0.006, max: W * 0.8 });
  },

  // ===== Logo stings
  ls_sweep(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), cx = W / 2, cy = H * (g.tagline ? 0.45 : 0.5), L = logoSize(o, g, u * 0.4);
    stage(ctx, W, H, th, g);
    const k = E.out(P(t, 0, 0.9)), sc = 0.9 + 0.1 * k;
    const lc = logoCanvas(o, g, th, L);
    if (lc) {
      const lx = lc.getContext('2d'), sw = P(t, 0.9, 0.8);
      if (sw > 0 && sw < 1) { // light cut into the logo only
        lx.save(); lx.globalCompositeOperation = 'source-atop';
        const bx = -L.w * 0.6 + L.w * 2.2 * sw, gr = lx.createLinearGradient(bx - L.w * 0.25, 0, bx + L.w * 0.25, 0);
        gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        lx.fillStyle = gr; lx.setTransform(1, 0, -0.4, 1, L.h * 0.2, 0); lx.fillRect(-L.w, 0, L.w * 3, L.h); lx.restore();
      }
      ctx.save(); ctx.globalAlpha *= k; ctx.translate(cx + L.dx, cy + L.dy); ctx.scale(sc, sc);
      ctx.shadowColor = th.accent; ctx.shadowBlur = u * 0.05 * Math.sin(Math.PI * clamp(sw));
      ctx.drawImage(lc, -lc.width / 2, -lc.height / 2); ctx.restore();
    }
    text(ctx, o, g.tagline, cx, cy + L.h / 2 + u * 0.08, u * 0.04, { w: 600, color: th.text, spacing: u * (0.02 - 0.012 * E.out(P(t, 1.2, 1))), alpha: P(t, 1.2, 0.7), max: W * 0.8 });
  },
  ls_glitch(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), cx = W / 2, cy = H * (g.tagline ? 0.45 : 0.5), L = logoSize(o, g, u * 0.4), n = Math.floor(t * 24);
    stage(ctx, W, H, th, g);
    const lc = logoCanvas(o, g, th, L); if (!lc) return;
    const heavy = t < 0.9, blip = !heavy && rnd(n, 9) > 0.93 && t < dur - 0.5, amt = heavy ? 1 - t / 0.9 : blip ? 0.35 : 0;
    const tint = (col) => { const c = offscreen(lc.width, lc.height), x = c.getContext('2d'); x.drawImage(lc, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = col; x.fillRect(0, 0, c.width, c.height); return c; };
    if (amt > 0) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha *= 0.8;
      const d = u * 0.03 * amt * kn('shift', 1);
      ctx.drawImage(tint('#ff2a55'), cx + L.dx - lc.width / 2 - d * (0.5 + rnd(n, 1)), cy + L.dy - lc.height / 2);
      ctx.drawImage(tint('#22e6ff'), cx + L.dx - lc.width / 2 + d * (0.5 + rnd(n, 2)), cy + L.dy - lc.height / 2);
      ctx.restore();
      // sliced, shifted strips
      const S = Math.round(kn('strips', 9));
      for (let i = 0; i < S; i++) {
        const sy = (lc.height / S) * i, sh = lc.height / S, off = (rnd(n, 10 + i) - 0.5) * u * 0.12 * amt;
        ctx.drawImage(lc, 0, sy, lc.width, sh, cx + L.dx - lc.width / 2 + off, cy + L.dy - lc.height / 2 + sy, lc.width, sh);
      }
      if (rnd(n, 3) > 0.5) { ctx.fillStyle = `rgba(255,255,255,${0.15 * amt})`; ctx.fillRect(0, cy - u * 0.2 + rnd(n, 4) * u * 0.4, W, u * 0.01); }
    } else ctx.drawImage(lc, cx + L.dx - lc.width / 2, cy + L.dy - lc.height / 2);
    const tg = graphemes(g.tagline), k = Math.floor(tg.length * P(t, 1, 0.8));
    text(ctx, o, tg.slice(0, k).join('') + (k < tg.length && n % 2 ? '_' : ''), cx, cy + L.h / 2 + u * 0.08, u * 0.045, { w: 700, color: th.text, spacing: u * 0.012, max: W * 0.8 });
  },
  ls_shapes(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), cx = W / 2, cy = H * (g.tagline ? 0.45 : 0.5), L = logoSize(o, g, u * 0.38), cols = [th.accent, th.c2, th.c3];
    stage(ctx, W, H, th, g);
    const inK = E.inOut(P(t, 0, 0.8)), burst = E.out(P(t, 0.8, 0.9));
    const N = Math.round(kn('count', 9)), size = kn('size', 1), spread = kn('spread', 1), spin = kn('spin', 1);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + 0.3, far = Math.hypot(W, H) * 0.6, r = far * (1 - inK) + u * 0.06 + u * 0.55 * spread * burst;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, s = u * (0.05 + 0.02 * (i % 3)) * size * (1 - 0.7 * burst);
      ctx.save(); ctx.globalAlpha *= 1 - burst * 0.9; ctx.translate(x, y); ctx.rotate((t * 2 + i) * spin); ctx.fillStyle = cols[i % 3];
      if (i % 3 === 0) { ctx.beginPath(); ctx.arc(0, 0, s / 2, 0, Math.PI * 2); ctx.fill(); }
      else if (i % 3 === 1) ctx.fillRect(-s / 2, -s / 2, s, s);
      else { ctx.beginPath(); ctx.moveTo(0, -s / 2); ctx.lineTo(s / 2, s / 2); ctx.lineTo(-s / 2, s / 2); ctx.closePath(); ctx.fill(); }
      ctx.restore();
    }
    // a ring goes out as the logo pops
    if (burst > 0 && burst < 1) { ctx.beginPath(); ctx.arc(cx, cy, u * (0.12 + 0.5 * burst), 0, Math.PI * 2); ctx.strokeStyle = th.accent; ctx.lineWidth = u * 0.01 * (1 - burst); ctx.stroke(); }
    const k = E.back(P(t, 0.75, 0.6));
    if (k > 0) { ctx.save(); ctx.translate(cx, cy); ctx.scale(k, k); drawLogo(ctx, o, g, th, 0, 0, L); ctx.restore(); }
    text(ctx, o, g.tagline, cx, cy + L.h / 2 + u * 0.08, u * 0.045, { w: 700, color: th.text, alpha: P(t, 1.3, 0.6), max: W * 0.8 });
  },
  ls_minimal(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), cx = W / 2, cy = H * 0.45, L = logoSize(o, g, u * 0.34), out = OUT(t, dur, 0.6);
    stage(ctx, W, H, th, g);
    const k = E.out(P(t, 0.1, 1));
    ctx.save(); ctx.globalAlpha *= k; drawLogo(ctx, o, g, th, cx, cy + u * 0.03 * (1 - k), L); ctx.restore();
    const lw = u * 0.3 * E.inOut(P(t, 0.7, 0.8)) * out, ly = cy + L.h / 2 + u * 0.05;
    ctx.fillStyle = th.accent; ctx.fillRect(cx - lw / 2, ly, lw, Math.max(1, u * 0.004));
    text(ctx, o, g.tagline, cx, ly + u * 0.055, u * 0.04, { w: 600, color: th.text, spacing: u * 0.01, alpha: P(t, 1.2, 0.6), max: W * 0.8 });
  },

  // ===== Titles
  ti_split(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), cx = W / 2, cy = H * 0.47, px = u * 0.16;
    stage(ctx, W, H, th, g);
    const k = E.expo(P(t, 0.1, 0.9)), out = OUT(t, dur, 0.5), gap = u * 0.004;
    const half = (top, dx) => { ctx.save(); ctx.beginPath(); ctx.rect(0, top ? 0 : cy + gap, W, top ? cy - gap : H); ctx.clip(); text(ctx, o, g.title, cx + dx, cy, px, { w: 900, color: th.text, max: W * 0.9 }); ctx.restore(); };
    half(true, -W * (1 - k) - W * (1 - out)); half(false, W * (1 - k) + W * (1 - out));
    ctx.save(); ctx.globalAlpha *= 1 - P(t, 0.9, 0.3); ctx.fillStyle = th.accent; const lw = W * 0.5 * E.inOut(P(t, 0, 0.6)) * out; ctx.fillRect(cx - lw / 2, cy - u * 0.003, lw, u * 0.006); ctx.restore();
    text(ctx, o, g.sub, cx, cy + px * 0.85, u * 0.045, { w: 600, color: th.sub, spacing: u * 0.01, alpha: P(t, 0.9, 0.5) * out, max: W * 0.8 });
  },
  ti_type(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), cx = W / 2, cy = H * 0.5, px = u * 0.09;
    const tg = graphemes(g.title), n = Math.floor(tg.length * P(t, 0.2, Math.max(0.6, tg.length * 0.07))), shown = tg.slice(0, n).join('');
    const size = fitPx(ctx, o, g.title || '', W * 0.86, px, 800), full = ctx.measureText(g.title || '').width;
    if (g.box) { const bw = full + u * 0.12, bh = size * 1.6 + (g.sub ? u * 0.08 : 0); ctx.fillStyle = 'rgba(0,0,0,0.6)'; rr(ctx, cx - bw / 2, cy - size * 0.8, bw, bh, u * 0.015); ctx.fill(); }
    const w = text(ctx, o, shown, cx - full / 2, cy, size, { w: 800, color: th.text, align: 'left' });
    if (Math.floor(t * 2.4) % 2 === 0 || n < tg.length) { ctx.fillStyle = th.accent; ctx.fillRect(cx - full / 2 + w + u * 0.008, cy - size * 0.45, u * 0.008, size * 0.9); }
    text(ctx, o, g.sub, cx, cy + size * 0.85, u * 0.038, { w: 500, color: th.sub, alpha: P(t, 0.4 + tg.length * 0.07, 0.4), max: W * 0.8 });
  },
  ti_stack(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), L = lines(g.text).slice(0, 4), px = u * 0.12, lh = px * 1.3, cols = [th.accent, solid(th), th.c2, th.c3];
    const y0 = H / 2 - ((L.length - 1) * lh) / 2, left = g.align === 'left', out = OUT(t, dur, 0.45);
    L.forEach((s, i) => {
      ctx.font = F(o, px, 900); const tw = Math.min(W * 0.8, ctx.measureText(s).width), bw = tw + px * 0.6;
      const x0 = left ? W * 0.1 : W / 2 - bw / 2, y = y0 + i * lh, k = E.expo(P(t, 0.1 + i * 0.18, 0.5)) * out;
      ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(x0, y - lh * 0.45, bw * k, lh * 0.9);
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y - lh * 0.45, bw * k, lh * 0.9); ctx.clip();
      text(ctx, o, s, x0 + px * 0.3, y, px, { w: 900, color: i % cols.length === 1 ? th.accent : '#fff', align: 'left', max: W * 0.8 });
      ctx.restore();
    });
  },
  ti_outline(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), cx = W / 2, cy = H * 0.47;
    const px = fitPx(ctx, o, g.title || '', W * 0.88, u * 0.18, 900);
    ctx.save(); ctx.font = F(o, px, 900); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(1, u * 0.004); ctx.strokeStyle = th.text;
    const len = ctx.measureText(g.title || '').width * 3, d = E.inOut(P(t, 0, 1.3));
    ctx.setLineDash([len, len]); ctx.lineDashOffset = len * (1 - d); ctx.strokeText(g.title || '', cx, cy);
    ctx.setLineDash([]); ctx.globalAlpha *= E.out(P(t, 1.1, 0.7)); ctx.fillStyle = th.text; ctx.fillText(g.title || '', cx, cy);
    ctx.restore();
    text(ctx, o, g.sub, cx, cy + px * 0.75, u * 0.06, { w: 700, color: th.accent, alpha: P(t, 1.5, 0.5), max: W * 0.8 });
  },
  ti_quote(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), maxW = Math.min(W * 0.78, u * 1.3), px = u * 0.058;
    stage(ctx, W, H, th, g);
    // the quote broken into lines that fit, shown word by word
    ctx.font = F(o, px, 600); const words = String(g.quote || '').split(/\s+/).filter(Boolean), Ls = [];
    let cur = '';
    for (const w of words) { const nx = cur ? `${cur} ${w}` : w; if (ctx.measureText(nx).width > maxW && cur) { Ls.push(cur); cur = w; } else cur = nx; }
    if (cur) Ls.push(cur);
    const lh = px * 1.45, y0 = H * 0.46 - ((Ls.length - 1) * lh) / 2, shownW = Math.floor(words.length * P(t, 0.5, Math.min(dur * 0.5, 0.15 * words.length)));
    const q = E.back(P(t, 0, 0.5));
    ctx.save(); ctx.translate(W / 2 - maxW / 2 + u * 0.02, y0 - lh * 1.1); ctx.scale(q, q); ctx.fillStyle = th.accent;
    for (const dx of [0, u * 0.075]) { ctx.beginPath(); ctx.arc(dx, 0, u * 0.03, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(dx - u * 0.03, 0); ctx.quadraticCurveTo(dx - u * 0.03, -u * 0.06, dx + u * 0.02, -u * 0.075); ctx.lineTo(dx + u * 0.01, -u * 0.05); ctx.quadraticCurveTo(dx - u * 0.005, -u * 0.035, dx + u * 0.0, 0); ctx.fill(); }
    ctx.restore();
    let k = 0;
    Ls.forEach((l, i) => {
      const ws = l.split(' '), take = clamp(shownW - k, 0, ws.length); k += ws.length;
      text(ctx, o, ws.slice(0, take).join(' '), W / 2, y0 + i * lh, px, { w: 600, color: th.text });
    });
    text(ctx, o, g.author ? `— ${g.author}` : '', W / 2, y0 + Ls.length * lh + u * 0.05, u * 0.045, { w: 500, color: th.sub, alpha: P(t, 0.6 + 0.15 * words.length, 0.5), max: W * 0.8 });
  },
  ti_chapter(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), cx = W * 0.5, cy = H * 0.5;
    stage(ctx, W, H, th, g);
    const k = E.out(P(t, 0, 0.9));
    ctx.save(); ctx.font = F(o, u * 0.34, 900); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = Math.max(1, u * 0.004); ctx.strokeStyle = th.accent; ctx.globalAlpha *= 0.85 * k;
    ctx.strokeText(g.num || '', cx, cy - u * 0.14 + u * 0.06 * (1 - k)); ctx.restore();
    text(ctx, o, g.title, cx, cy + u * 0.12, u * 0.11, { w: 800, color: th.text, alpha: P(t, 0.5, 0.6), max: W * 0.86 });
    const lw = u * 0.24 * E.inOut(P(t, 0.7, 0.6)); ctx.fillStyle = th.accent; ctx.fillRect(cx - lw / 2, cy + u * 0.2, lw, u * 0.005);
    text(ctx, o, g.sub, cx, cy + u * 0.26, u * 0.04, { w: 500, color: th.sub, spacing: u * 0.01, alpha: P(t, 0.9, 0.5), max: W * 0.8 });
  },

  // ===== Lower thirds
  lt_news(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), right = g.side === 'right', y = H * 0.76, k = E.expo(P(t, 0, 0.6)) * OUT(t, dur, 0.4);
    ctx.font = F(o, u * 0.052, 800); const nw = Math.max(ctx.measureText(g.name || '').width, (ctx.font = F(o, u * 0.034, 500), ctx.measureText(g.role || '').width)) + u * 0.09;
    const tw = g.tag ? (ctx.font = F(o, u * 0.04, 900), ctx.measureText(g.tag).width + u * 0.06) : 0, total = Math.min(W * 0.9, tw + nw), x0 = right ? W * 0.95 - total : W * 0.05;
    ctx.save(); ctx.beginPath(); ctx.rect(right ? W * 0.95 - total * k : x0, 0, total * k, H); ctx.clip();
    if (g.tag) { ctx.fillStyle = g.red || '#e11d2e'; ctx.fillRect(x0, y, tw, u * 0.15); text(ctx, o, g.tag, x0 + tw / 2, y + u * 0.075, u * 0.04, { w: 900, color: '#fff' }); }
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x0 + tw, y, nw, u * 0.088); ctx.fillStyle = solid(th); ctx.fillRect(x0 + tw, y + u * 0.088, nw, u * 0.062);
    text(ctx, o, g.name, x0 + tw + u * 0.04, y + u * 0.046, u * 0.052, { w: 800, color: '#111', align: 'left', max: nw - u * 0.06 });
    text(ctx, o, g.role, x0 + tw + u * 0.04, y + u * 0.12, u * 0.034, { w: 500, color: '#fff', align: 'left', max: nw - u * 0.06 });
    ctx.restore();
  },
  lt_corp(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), right = g.side === 'right', y = H * 0.75, out = OUT(t, dur, 0.4);
    ctx.font = F(o, u * 0.055, 700); const nw = Math.max(ctx.measureText(g.name || '').width, (ctx.font = F(o, u * 0.034, 400), ctx.measureText(g.role || '').width)) + u * 0.1;
    const bar = E.out(P(t, 0, 0.35)) * out, pan = E.expo(P(t, 0.25, 0.6)) * out, x = right ? W * 0.95 : W * 0.05, dir = right ? -1 : 1;
    ctx.fillStyle = th.accent; ctx.fillRect(x - (right ? u * 0.012 : 0), y + u * 0.075 * (1 - bar), u * 0.012, u * 0.15 * bar);
    ctx.save(); const px = right ? x - u * 0.012 - nw * pan : x + u * 0.012; ctx.beginPath(); ctx.rect(px, y, nw * pan, u * 0.15); ctx.clip();
    ctx.fillStyle = th.card; ctx.fillRect(px, y, nw, u * 0.15);
    const tx = right ? x - u * 0.05 : x + u * 0.05, al = right ? 'right' : 'left', slide = (1 - pan) * u * 0.06 * dir * -1;
    text(ctx, o, g.name, tx + slide, y + u * 0.055, u * 0.055, { w: 700, color: th.text, align: al, max: nw - u * 0.06 });
    text(ctx, o, g.role, tx + slide * 1.5, y + u * 0.11, u * 0.034, { w: 400, color: th.sub, align: al, max: nw - u * 0.06 });
    ctx.restore();
  },
  lt_interview(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), right = g.side === 'right', r = u * 0.07, cy = H * 0.8, cxC = right ? W * 0.95 - r : W * 0.05 + r, out = OUT(t, dur, 0.4);
    ctx.font = F(o, u * 0.05, 800); const nw = Math.max(ctx.measureText(g.name || '').width, (ctx.font = F(o, u * 0.032, 500), ctx.measureText(g.role || '').width)) + u * 0.12;
    const pan = E.expo(P(t, 0.3, 0.6)) * out, x0 = right ? cxC - nw * pan : cxC;
    ctx.fillStyle = th.card; rr(ctx, x0, cy - r * 0.85, nw * pan, r * 1.7, r * 0.85); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.rect(x0, cy - r, nw * pan, r * 2); ctx.clip();
    const tx = right ? cxC - r * 1.35 : cxC + r * 1.35, al = right ? 'right' : 'left';
    text(ctx, o, g.name, tx, cy - r * 0.25, u * 0.05, { w: 800, color: th.text, align: al, max: nw - r * 1.6 });
    text(ctx, o, g.role, tx, cy + r * 0.38, u * 0.032, { w: 500, color: th.sub, align: al, max: nw - r * 1.6 });
    ctx.restore();
    const k = E.back(P(t, 0, 0.5)) * out, ini = String(g.name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => graphemes(w)[0]).join('');
    ctx.save(); ctx.translate(cxC, cy); ctx.scale(k, k); ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = th.accent; ctx.fill();
    text(ctx, o, ini.toUpperCase(), 0, 0, r * 0.8, { w: 800, color: '#fff' }); ctx.restore();
  },
  lt_social(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), right = g.side === 'right', s = u * 0.1, cy = H * 0.8, out = OUT(t, dur, 0.4);
    const ix = right ? W * 0.95 - s / 2 : W * 0.05 + s / 2;
    ctx.font = F(o, u * 0.05, 800); const nw = Math.max(ctx.measureText(g.handle || '').width, (ctx.font = F(o, u * 0.03, 500), ctx.measureText(g.sub || '').width)) + u * 0.06;
    const pan = E.expo(P(t, 0.3, 0.55)) * out;
    ctx.save(); const x0 = right ? ix - s * 0.7 - nw * pan : ix + s * 0.7; ctx.beginPath(); ctx.rect(x0, cy - s, nw * pan, s * 2); ctx.clip();
    const al = right ? 'right' : 'left', tx = right ? ix - s * 0.85 : ix + s * 0.85;
    text(ctx, o, g.handle, tx, cy - u * 0.012, u * 0.05, { w: 800, color: th.text, align: al });
    text(ctx, o, g.sub, tx, cy + u * 0.042, u * 0.03, { w: 500, color: th.sub, align: al });
    ctx.restore();
    const k = E.back(P(t, 0, 0.45)) * out;
    ctx.save(); ctx.translate(ix, cy); ctx.scale(k, k); ctx.rotate((1 - k) * -0.6); platformIcon(ctx, o, g.platform, 0, 0, s); ctx.restore();
  },
  lt_location(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), right = g.side === 'right', s = u * 0.075, cy = H * 0.8, out = OUT(t, dur, 0.4);
    const ix = right ? W * 0.95 - s / 2 : W * 0.05 + s / 2;
    // the pin drops and bounces
    const drop = E.back(P(t, 0, 0.55)), py = cy - u * 0.25 * (1 - drop);
    ctx.save(); ctx.globalAlpha *= clamp(t / 0.15) * out; ctx.translate(ix, py);
    ctx.fillStyle = th.accent; ctx.beginPath(); ctx.arc(0, -s * 0.2, s * 0.42, Math.PI, 0); ctx.lineTo(0, s * 0.62); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -s * 0.2, s * 0.16, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.restore();
    const al = right ? 'right' : 'left', tx = right ? ix - s * 0.8 : ix + s * 0.8, k = E.out(P(t, 0.35, 0.5)) * out;
    ctx.fillStyle = th.accent; ctx.fillRect(right ? tx - u * 0.42 * k : tx, cy + u * 0.005, u * 0.42 * k, Math.max(1, u * 0.003));
    text(ctx, o, g.place, tx, cy - u * 0.035, u * 0.052, { w: 800, color: th.text, align: al, alpha: k, max: W * 0.6 });
    text(ctx, o, g.sub, tx, cy + u * 0.045, u * 0.03, { w: 500, color: th.sub, align: al, alpha: P(t, 0.6, 0.4) * out, max: W * 0.6 });
  },

  // ===== Transitions (the picture is fully covered at the middle of the clip - lay it centred over a cut)
  tr_wipe(ctx, W, H, g, t, dur, th) {
    ctx.globalAlpha = 1; // (a transition uncovers the picture itself - no fade at its end)
    const u = clamp(t / dur), cols = [th.accent, solid(th), th.c2], dir = g.dir || 'right';
    ctx.save();
    if (dir === 'left') { ctx.translate(W, 0); ctx.scale(-1, 1); } else if (dir === 'up' || dir === 'down') { ctx.translate(W / 2, H / 2); ctx.rotate(dir === 'up' ? -Math.PI / 2 : Math.PI / 2); ctx.translate(-H / 2, -W / 2); [W, H] = [H, W]; }
    const span = W + H * 0.6;
    cols.forEach((c, i) => {
      const lag = i * 0.09, a = E.inOut(clamp((u - lag) / 0.5)), b = E.inOut(clamp((u - 0.5 - (0.18 - lag)) / 0.5));
      const x1 = -H * 0.6 + span * b, x2 = -H * 0.6 + span * a;
      if (x2 <= x1) return;
      ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x2 + H * 0.3, 0); ctx.lineTo(x2, H); ctx.lineTo(x1 - H * 0.3, H); ctx.closePath(); ctx.fill();
    });
    ctx.restore();
  },
  tr_iris(ctx, W, H, g, t, dur, th) {
    ctx.globalAlpha = 1; // (a transition uncovers the picture itself - no fade at its end)
    const u = clamp(t / dur), R = Math.hypot(W, H) / 2, cx = W / 2, cy = H / 2;
    if (u < 0.5) { const r = R * E.inOut(u / 0.5); ctx.fillStyle = th.accent; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = solid(th); ctx.beginPath(); ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2); ctx.fill(); }
    else { const r = R * E.inOut((u - 0.5) / 0.5) * 1.02; ctx.fillStyle = solid(th); ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'destination-out'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = th.accent; ctx.lineWidth = Math.min(W, H) * 0.02; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
  },
  tr_leak(ctx, W, H, g, t, dur) {
    ctx.globalAlpha = 1; // (a transition uncovers the picture itself - no fade at its end)
    const u = clamp(t / dur), peak = Math.sin(Math.PI * u), pal = { warm: ['255,140,40', '255,70,30', '255,210,120'], gold: ['255,200,80', '255,160,40', '255,240,180'], cool: ['80,160,255', '120,90,255', '190,230,255'], pink: ['255,90,170', '255,140,90', '255,200,230'] }[g.warmth] || ['255,140,40', '255,70,30', '255,210,120'];
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    pal.forEach((c, i) => {
      const x = W * (0.2 + 0.6 * ((u * (1 + i * 0.3) + i * 0.27) % 1)), y = H * (0.3 + 0.4 * Math.sin(u * 3 + i * 2)), r = Math.max(W, H) * (0.45 + 0.15 * i);
      const gr = ctx.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(${c},${0.85 * peak})`); gr.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    });
    ctx.fillStyle = `rgba(255,250,240,${clamp(peak - 0.55) * 1.6})`; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  },
  tr_glitch(ctx, W, H, g, t, dur, th) {
    ctx.globalAlpha = 1; // (a transition uncovers the picture itself - no fade at its end)
    const u = clamp(t / dur), n = Math.floor(t * 30), amt = Math.sin(Math.PI * u), cols = ['#ff2a55', '#22e6ff', '#ffffff', th.accent, '#000000'];
    if (Math.abs(u - 0.5) < 0.07) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); return; }
    const S = Math.round((6 + 14 * amt) * kn('strips', 1));
    for (let i = 0; i < S; i++) {
      if (rnd(n, i) > 0.35 + 0.4 * (1 - amt)) continue;
      const y = rnd(n, i + 50) * H, h = H * (0.01 + 0.08 * rnd(n, i + 90)), x = (rnd(n, i + 7) - 0.3) * W;
      ctx.fillStyle = cols[Math.floor(rnd(n, i + 3) * cols.length)]; ctx.globalAlpha = 0.5 + 0.5 * amt; ctx.fillRect(x, y, W * (0.3 + rnd(n, i + 11)), h);
    }
    ctx.globalAlpha = 1;
  },

  // ===== Infographics
  in_timeline(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), items = lines(g.data).slice(0, 7).map((l) => { const m = /^([^,|:]+)[,|:]\s*(.*)$/.exec(l); return m ? { year: m[1].trim(), what: m[2].trim() } : { year: l, what: '' }; });
    const x0 = W * 0.1, x1 = W * 0.9, y = H * 0.55, lineK = E.inOut(P(t, 0.3, 1.2)), out = OUT(t, dur, 0.4);
    text(ctx, o, g.title, W / 2, H * 0.24, u * 0.07, { w: 800, color: th.text, alpha: P(t, 0, 0.5) * out, max: W * 0.86 });
    ctx.fillStyle = th.grid; ctx.fillRect(x0, y - u * 0.003, (x1 - x0), u * 0.006);
    ctx.fillStyle = th.accent; ctx.fillRect(x0, y - u * 0.003, (x1 - x0) * lineK * out, u * 0.006);
    items.forEach((it, i) => {
      const x = items.length > 1 ? x0 + ((x1 - x0) * i) / (items.length - 1) : (x0 + x1) / 2, at = 0.5 + (1.2 * i) / Math.max(1, items.length - 1), k = E.back(P(t, at, 0.4)) * out, up = i % 2 === 0;
      ctx.save(); ctx.translate(x, y); ctx.scale(k, k); ctx.beginPath(); ctx.arc(0, 0, u * 0.022, 0, Math.PI * 2); ctx.fillStyle = th.accent; ctx.fill(); ctx.beginPath(); ctx.arc(0, 0, u * 0.01, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.restore();
      const a = P(t, at + 0.15, 0.4) * out, maxW = ((x1 - x0) / Math.max(1, items.length - 1)) * 0.95;
      text(ctx, o, it.year, x, y + (up ? -u * 0.12 : u * 0.1), u * 0.05, { w: 800, color: th.accent, alpha: a, max: maxW });
      text(ctx, o, it.what, x, y + (up ? -u * 0.06 : u * 0.16), u * 0.036, { w: 500, color: th.text, alpha: a, max: maxW });
    });
  },
  in_compare(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), out = OUT(t, dur, 0.4), cy = H * 0.55, xs = [W * 0.3, W * 0.7];
    text(ctx, o, g.title, W / 2, H * 0.24, u * 0.07, { w: 800, color: th.text, alpha: P(t, 0, 0.5) * out, max: W * 0.86 });
    const count = (v, k) => { const m = /-?[\d,]*\.?\d+/.exec(String(v || '')); if (!m) return v || ''; const d = (m[0].split('.')[1] || '').length, n = parseFloat(m[0].replace(/,/g, '')) * k; return String(v).slice(0, m.index) + n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }) + String(v).slice(m.index + m[0].length); };
    [[g.aLabel, g.aValue, th.sub, 0.3], [g.bLabel, g.bValue, th.accent, 0.9]].forEach(([lab, val, col, at], i) => {
      const k = E.out(P(t, at, 0.8)) * out;
      ctx.fillStyle = th.card; rr(ctx, xs[i] - u * 0.26, cy - u * 0.2, u * 0.52, u * 0.4, u * 0.03); ctx.globalAlpha *= 1; ctx.fill();
      text(ctx, o, lab, xs[i], cy - u * 0.12, u * 0.04, { w: 600, color: th.sub, alpha: k });
      text(ctx, o, count(val, E.out(P(t, at, 1.2))), xs[i], cy + u * 0.04, u * 0.12, { w: 900, color: col, alpha: k, max: u * 0.48 });
    });
    const ak = E.inOut(P(t, 0.7, 0.5)) * out, ax0 = W * 0.5 - u * 0.06, ax1 = ax0 + u * 0.12 * ak;
    ctx.strokeStyle = th.accent; ctx.lineWidth = u * 0.012; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(ax0, cy); ctx.lineTo(ax1, cy); ctx.stroke();
    if (ak > 0.9) { ctx.beginPath(); ctx.moveTo(ax1 - u * 0.035, cy - u * 0.035); ctx.lineTo(ax1, cy); ctx.lineTo(ax1 - u * 0.035, cy + u * 0.035); ctx.stroke(); }
    text(ctx, o, g.note, W / 2, cy + u * 0.29, u * 0.038, { w: 500, color: th.text, alpha: P(t, 1.4, 0.5) * out, max: W * 0.86 });
  },
  in_icons(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), out = OUT(t, dur, 0.4), v = clamp(+g.value || 0, 0, 10), s = Math.min(u * 0.11, W * 0.075), gap = s * 0.25, y = H * 0.54;
    text(ctx, o, g.title, W / 2, H * 0.27, u * 0.07, { w: 800, color: th.text, alpha: P(t, 0, 0.5) * out, max: W * 0.86 });
    const x0 = W / 2 - (10 * s + 9 * gap) / 2 + s / 2;
    const icon = (x, col, fillK) => {
      ctx.save(); ctx.translate(x, y); ctx.fillStyle = col;
      const shape = () => {
        ctx.beginPath();
        if (g.icon === 'house') { ctx.moveTo(-s * 0.45, -s * 0.05); ctx.lineTo(0, -s * 0.45); ctx.lineTo(s * 0.45, -s * 0.05); ctx.lineTo(s * 0.32, -s * 0.05); ctx.lineTo(s * 0.32, s * 0.42); ctx.lineTo(-s * 0.32, s * 0.42); ctx.lineTo(-s * 0.32, -s * 0.05); ctx.closePath(); }
        else if (g.icon === 'drop') { ctx.moveTo(0, -s * 0.45); ctx.bezierCurveTo(s * 0.45, s * 0.05, s * 0.4, s * 0.45, 0, s * 0.45); ctx.bezierCurveTo(-s * 0.4, s * 0.45, -s * 0.45, s * 0.05, 0, -s * 0.45); }
        else if (g.icon === 'tree') { ctx.arc(0, -s * 0.12, s * 0.32, 0, Math.PI * 2); ctx.rect(-s * 0.06, s * 0.1, s * 0.12, s * 0.35); }
        else { ctx.arc(0, -s * 0.28, s * 0.17, 0, Math.PI * 2); ctx.moveTo(-s * 0.3, s * 0.45); ctx.quadraticCurveTo(-s * 0.3, -s * 0.06, 0, -s * 0.06); ctx.quadraticCurveTo(s * 0.3, -s * 0.06, s * 0.3, s * 0.45); ctx.closePath(); }
      };
      shape(); ctx.fillStyle = th.grid; ctx.fill();
      if (fillK > 0) { ctx.save(); shape(); ctx.clip(); ctx.fillStyle = col; ctx.fillRect(-s / 2, s / 2 - s * fillK, s, s * fillK); ctx.restore(); }
      ctx.restore();
    };
    const filled = v * E.out(P(t, 0.4, 1.6));
    for (let i = 0; i < 10; i++) {
      const k = E.back(P(t, 0.05 * i, 0.35)) * out;
      ctx.save(); ctx.translate(x0 + i * (s + gap), y); ctx.scale(k, k); ctx.translate(-(x0 + i * (s + gap)), -y);
      icon(x0 + i * (s + gap), th.accent, clamp(filled - i)); ctx.restore();
    }
    text(ctx, o, g.note, W / 2, y + s * 0.95, u * 0.038, { w: 500, color: th.text, alpha: P(t, 1.2, 0.5) * out, max: W * 0.86 });
  },
  in_steps(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), steps = lines(g.data).slice(0, 6), out = OUT(t, dur, 0.4), n = steps.length || 1, y = H * 0.55, r = Math.min(u * 0.06, W / n / 4);
    text(ctx, o, g.title, W / 2, H * 0.25, u * 0.07, { w: 800, color: th.text, alpha: P(t, 0, 0.5) * out, max: W * 0.86 });
    const xs = steps.map((_, i) => W * 0.1 + (W * 0.8 * (i + 0.5)) / n);
    steps.forEach((s, i) => {
      const at = 0.4 + i * 0.5, k = E.back(P(t, at, 0.4)) * out;
      if (i > 0) { const a = E.inOut(P(t, at - 0.25, 0.3)) * out, xa = xs[i - 1] + r * 1.3, xb = xa + (xs[i] - r * 1.3 - xa) * a; ctx.strokeStyle = th.sub; ctx.lineWidth = u * 0.006; ctx.setLineDash([u * 0.015, u * 0.012]); ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke(); ctx.setLineDash([]); }
      ctx.save(); ctx.translate(xs[i], y); ctx.scale(k, k); ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = [th.accent, th.c2, th.c3][i % 3]; ctx.fill();
      text(ctx, o, String(i + 1), 0, 0, r, { w: 900, color: '#fff' }); ctx.restore();
      text(ctx, o, s, xs[i], y + r + u * 0.06, u * 0.034, { w: 600, color: th.text, alpha: P(t, at + 0.15, 0.4) * out, max: (W * 0.8) / n - u * 0.02 });
    });
  },

  // ===== Broadcast / News
  bn_breaking(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), red = g.red || '#e11d2e', big = g.pos === 'center', out = OUT(t, dur, 0.4);
    const y = big ? H * 0.38 : H * 0.72, bh = big ? u * 0.2 : u * 0.1, k = E.expo(P(t, 0, 0.5)) * out;
    // red band slides in, a white flash bar runs over it, then the headline bar opens below
    ctx.fillStyle = red; ctx.fillRect(0, y, W * k, bh);
    const fl = P(t, 0.35, 0.5); if (fl > 0 && fl < 1) { ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(W * fl - u * 0.15, y, u * 0.1, bh); }
    const pulse = 0.85 + 0.15 * Math.sin(t * 6);
    text(ctx, o, g.label, W * 0.05, y + bh / 2, bh * 0.55, { w: 900, color: '#fff', align: 'left', spacing: u * 0.006, alpha: P(t, 0.25, 0.3) * pulse * out, max: W * 0.9 });
    const hk = E.out(P(t, 0.6, 0.5)) * out, hh = big ? u * 0.13 : u * 0.085;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, y + bh, W * hk, hh);
    ctx.save(); ctx.beginPath(); ctx.rect(0, y + bh, W * hk, hh); ctx.clip();
    text(ctx, o, g.headline, W * 0.05, y + bh + hh / 2, hh * 0.55, { w: 800, color: '#111', align: 'left', max: W * 0.9 });
    ctx.restore();
  },
  bn_headline(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), out = OUT(t, dur, 0.4), y = H * 0.76, x = W * 0.05, w = W * 0.9;
    const tk = E.back(P(t, 0, 0.45)) * out; ctx.font = F(o, u * 0.034, 900); const tw = ctx.measureText(g.tag || '').width + u * 0.05;
    const mk = E.expo(P(t, 0.2, 0.6)) * out;
    ctx.fillStyle = 'rgba(255,255,255,0.96)'; ctx.fillRect(x, y, w * mk, u * 0.095);
    ctx.fillStyle = solid(th); ctx.fillRect(x, y + u * 0.095, w * E.expo(P(t, 0.4, 0.6)) * out, u * 0.06);
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w * mk, u * 0.16); ctx.clip();
    text(ctx, o, g.headline, x + u * 0.03, y + u * 0.05, u * 0.052, { w: 800, color: '#111', align: 'left', max: w - u * 0.06 });
    text(ctx, o, g.sub, x + u * 0.03, y + u * 0.126, u * 0.032, { w: 500, color: '#fff', align: 'left', alpha: P(t, 0.6, 0.4), max: w - u * 0.06 });
    ctx.restore();
    if (g.tag) { ctx.save(); ctx.translate(x, y); ctx.scale(1, tk); ctx.fillStyle = g.red || '#e11d2e'; ctx.fillRect(0, -u * 0.05, tw, u * 0.05); text(ctx, o, g.tag, tw / 2, -u * 0.025, u * 0.034, { w: 900, color: '#fff' }); ctx.restore(); }
  },
  bn_bug(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), k = E.out(P(t, 0, 0.5)), x = W * 0.95, y = H * 0.07;
    const L = logoSize(o, g, u * 0.11);
    ctx.save(); ctx.globalAlpha *= k * 0.92;
    if (o.img(g.logo)) drawLogo(ctx, o, g, th, x - L.w / 2, y + L.h / 2, L);
    else { ctx.font = F(o, u * 0.034, 900); const w = ctx.measureText(g.channel || '').width + u * 0.04; ctx.fillStyle = 'rgba(0,0,0,0.55)'; rr(ctx, x - w, y, w, u * 0.06, u * 0.008); ctx.fill(); text(ctx, o, g.channel, x - w / 2, y + u * 0.03, u * 0.034, { w: 900, color: '#fff' }); }
    ctx.restore();
    const by = y + (o.img(g.logo) ? L.h : u * 0.06) + u * 0.015;
    if (g.live !== false) {
      const lw = u * 0.11; ctx.save(); ctx.globalAlpha *= P(t, 0.3, 0.4); ctx.fillStyle = g.red || '#e11d2e'; rr(ctx, x - lw, by, lw, u * 0.045, u * 0.006); ctx.fill();
      ctx.globalAlpha *= 0.55 + 0.45 * Math.abs(Math.sin(t * 3)); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x - lw + u * 0.022, by + u * 0.0225, u * 0.009, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      text(ctx, o, 'LIVE', x - lw / 2 + u * 0.012, by + u * 0.0235, u * 0.028, { w: 900, color: '#fff', alpha: P(t, 0.3, 0.4) });
    }
    if (g.clock) text(ctx, o, g.clock, x, by + u * 0.085, u * 0.032, { w: 700, color: '#fff', align: 'right', alpha: P(t, 0.4, 0.4) });
  },
  bn_live(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), x = W * 0.05, y = H * 0.08, out = OUT(t, dur, 0.4), k = E.back(P(t, 0, 0.45)) * out, lw = u * 0.13, h = u * 0.06;
    ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
    ctx.fillStyle = g.red || '#e11d2e'; rr(ctx, 0, 0, lw, h, u * 0.008); ctx.fill();
    ctx.globalAlpha *= 0.5 + 0.5 * Math.abs(Math.sin(t * 3)); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(u * 0.026, h / 2, u * 0.011, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    text(ctx, o, 'LIVE', x + lw / 2 + u * 0.014, y + h / 2 + u * 0.001, u * 0.036, { w: 900, color: '#fff', alpha: k });
    const pk = E.expo(P(t, 0.3, 0.6)) * out; ctx.font = F(o, u * 0.042, 800); const pw = Math.max(ctx.measureText(g.place || '').width, (ctx.font = F(o, u * 0.028, 500), ctx.measureText(g.date || '').width)) + u * 0.06;
    ctx.save(); ctx.beginPath(); ctx.rect(x + lw, y, pw * pk, h * 1.6); ctx.clip();
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x + lw, y, pw, h * 1.6);
    text(ctx, o, g.place, x + lw + u * 0.03, y + h * 0.5, u * 0.042, { w: 800, color: '#fff', align: 'left' });
    text(ctx, o, g.date, x + lw + u * 0.03, y + h * 1.2, u * 0.028, { w: 500, color: '#ddd', align: 'left' });
    ctx.restore();
  },

  // ===== Social
  so_subscribe(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), out = OUT(t, dur, 0.4), cx = W / 2, cy = g.pos === 'center' ? H / 2 : H * 0.8;
    const k = E.back(P(t, 0, 0.5)) * out, clicked = t > 1.6, press = t > 1.5 && t < 1.7 ? 0.94 : 1;
    ctx.font = F(o, u * 0.05, 900); const bw = ctx.measureText(clicked ? g.done || '' : g.label || '').width + u * 0.12, bh = u * 0.1;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(k * press, k * press);
    ctx.fillStyle = clicked ? '#606060' : '#ff0000'; rr(ctx, -bw / 2, -bh / 2, bw, bh, u * 0.015); ctx.fill();
    text(ctx, o, clicked ? g.done : g.label, 0, u * 0.002, u * 0.05, { w: 900, color: '#fff' });
    ctx.restore();
    // the bell rings after the click
    const bk = E.back(P(t, 1.9, 0.4)) * out, bx = cx + bw / 2 + u * 0.09;
    if (bk > 0) {
      ctx.save(); ctx.translate(bx, cy); ctx.scale(bk, bk); ctx.rotate(Math.sin(t * 25) * 0.35 * clamp(1 - (t - 2.2) / 0.8));
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(-u * 0.035, u * 0.025); ctx.quadraticCurveTo(-u * 0.035, -u * 0.04, 0, -u * 0.04); ctx.quadraticCurveTo(u * 0.035, -u * 0.04, u * 0.035, u * 0.025); ctx.closePath(); ctx.fill();
      ctx.fillRect(-u * 0.042, u * 0.022, u * 0.084, u * 0.008); ctx.beginPath(); ctx.arc(0, u * 0.04, u * 0.01, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    // the pointer comes in, clicks, goes away
    const pa = E.inOut(P(t, 0.6, 0.8)), pb = E.inOut(P(t, 2, 0.6)), px = cx + W * 0.3 * (1 - pa) + u * 0.02 + W * 0.3 * pb, py = cy + H * 0.25 * (1 - pa) + u * 0.02 + H * 0.2 * pb;
    if (pa > 0 && pb < 1) { ctx.save(); ctx.translate(px, py); const s = u * 0.07 * press; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = s * 0.06; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, s); ctx.lineTo(s * 0.28, s * 0.74); ctx.lineTo(s * 0.48, s * 1.08); ctx.lineTo(s * 0.6, s * 1.0); ctx.lineTo(s * 0.4, s * 0.68); ctx.lineTo(s * 0.72, s * 0.68); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore(); }
  },
  so_follow(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), out = OUT(t, dur, 0.4), items = lines(g.data).slice(0, 5).map((l) => { const m = /^([^,]+),\s*(.+)$/.exec(l); return m ? { p: m[1].trim().toLowerCase(), h: m[2].trim() } : { p: 'web', h: l }; });
    stage(ctx, W, H, th, g);
    const lh = u * 0.13, y0 = H * 0.5 - ((items.length - 1) * lh) / 2 + u * 0.06, s = u * 0.09;
    text(ctx, o, g.title, W / 2, y0 - u * 0.17, u * 0.075, { w: 800, color: th.text, alpha: P(t, 0, 0.5) * out, max: W * 0.86 });
    ctx.font = F(o, u * 0.05, 700); const tw = Math.max(...items.map((it) => ctx.measureText(it.h).width), u * 0.3), x0 = W / 2 - (s + u * 0.04 + tw) / 2;
    items.forEach((it, i) => {
      const k = E.back(P(t, 0.3 + i * 0.2, 0.45)) * out, y = y0 + i * lh;
      ctx.save(); ctx.translate(x0 + s / 2, y); ctx.scale(k, k); platformIcon(ctx, o, it.p, 0, 0, s); ctx.restore();
      text(ctx, o, it.h, x0 + s + u * 0.04 + u * 0.05 * (1 - k), y, u * 0.05, { w: 700, color: th.text, align: 'left', alpha: clamp(k), max: W * 0.6 });
    });
  },
  so_like(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), out = OUT(t, dur, 0.4), cy = g.pos === 'center' ? H / 2 : H * 0.8, s = u * 0.1, gap = u * 0.22;
    const icons = [['like', g.like, '#ff3b5c'], ['comment', g.comment, '#4f8cff'], ['share', g.share, '#36c27e']];
    icons.forEach(([kind, label, col], i) => {
      const x = W / 2 + (i - 1) * gap, k = E.back(P(t, 0.2 + i * 0.3, 0.45)) * out;
      ctx.save(); ctx.translate(x, cy - u * 0.02); ctx.scale(k, k);
      ctx.beginPath(); ctx.arc(0, 0, s * 0.62, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = s * 0.08; ctx.lineJoin = 'round';
      if (kind === 'like') { ctx.beginPath(); ctx.moveTo(0, s * 0.3); ctx.bezierCurveTo(-s * 0.55, -s * 0.05, -s * 0.25, -s * 0.45, 0, -s * 0.15); ctx.bezierCurveTo(s * 0.25, -s * 0.45, s * 0.55, -s * 0.05, 0, s * 0.3); ctx.fill(); }
      else if (kind === 'comment') { rr(ctx, -s * 0.32, -s * 0.25, s * 0.64, s * 0.42, s * 0.1); ctx.fill(); ctx.beginPath(); ctx.moveTo(-s * 0.15, s * 0.15); ctx.lineTo(-s * 0.22, s * 0.32); ctx.lineTo(s * 0.02, s * 0.15); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(-s * 0.28, s * 0.25); ctx.quadraticCurveTo(-s * 0.2, -s * 0.12, s * 0.12, -s * 0.12); ctx.stroke(); ctx.beginPath(); ctx.moveTo(s * 0.05, -s * 0.3); ctx.lineTo(s * 0.32, -s * 0.12); ctx.lineTo(s * 0.05, s * 0.06); ctx.closePath(); ctx.fill(); }
      ctx.restore();
      text(ctx, o, label, x, cy + s * 0.85, u * 0.034, { w: 700, color: th.text, alpha: P(t, 0.35 + i * 0.3, 0.3) * out });
    });
  },
  so_hashtag(ctx, W, H, g, t, dur, th, o) {
    const u = Math.min(W, H) * (g.scale || 1), out = OUT(t, dur, 0.4), cy = g.pos === 'center' ? H / 2 : g.pos === 'top' ? H * 0.16 : H * 0.8;
    const tg = graphemes(g.tag), n = Math.floor(tg.length * P(t, 0.5, Math.max(0.5, tg.length * 0.05))), px = u * 0.06;
    ctx.font = F(o, px, 900); const full = ctx.measureText(`#${g.tag || ''}`).width, pw = full + u * 0.1, ph = px * 1.7, k = E.back(P(t, 0, 0.45)) * out;
    ctx.save(); ctx.translate(W / 2, cy); ctx.scale(k, k);
    ctx.shadowColor = th.accent; ctx.shadowBlur = u * 0.04 * (0.6 + 0.4 * Math.sin(t * 3));
    ctx.fillStyle = th.card; rr(ctx, -pw / 2, -ph / 2, pw, ph, ph / 2); ctx.fill(); ctx.shadowBlur = 0;
    const hw = text(ctx, o, '#', -full / 2, 0, px, { w: 900, color: th.accent, align: 'left' });
    text(ctx, o, tg.slice(0, n).join(''), -full / 2 + hw, 0, px, { w: 900, color: th.text, align: 'left' });
    ctx.restore();
    text(ctx, o, g.sub, W / 2, cy + ph * 0.9, u * 0.032, { w: 500, color: th.text, alpha: P(t, 1, 0.4) * out, max: W * 0.8 });
  },
};
