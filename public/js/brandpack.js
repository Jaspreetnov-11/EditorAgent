// 🏷 Client brand packs: one pack per client / ministry / department ("MY Bharat", "Khelo India", "CG Govt") with its
// logo (corner, size, opacity), intro and outro clips, font, colours, caption style, lower-third style and end card
// text. Kept once in the shared Library (engine/brandpacks.mjs, Library/brandpacks/<id>/), applied to a project in one
// go. No DOM here: the editor (library.js) and the server (a new project started from a pack) both use applyPack.
//   pack: { id, name, client, notes, primary, accent, text, accent2, palette: ['#rrggbb'], font, capPreset,
//           logo, logoPos, logoScale, logoOpacity, intro, introDur, outro, outroDur, endText, ltTitle, ltMotion }
//   logo / intro / outro are file names inside the pack's folder (or a full path, for packs made from the old kit).
// In the project: project.brand = { pack: { id, name }, primary, accent, text, accent2, palette, font, lt, ltMotion },
// project.logo.pack = the pack the logo came from, and the intro / outro / end card on V1 carry brandClip.
import { CAPTION_PRESETS } from './captions.js';
import { TEMPLATES, templateById, applyTemplate } from './templates.js';

export const LOGO_POS = [['tr', 'Top right'], ['tl', 'Top left'], ['br', 'Bottom right'], ['bl', 'Bottom left']];
export const LT_TITLES = TEMPLATES.filter((t) => t.group === 'Lower thirds').map((t) => [t.id, t.label]);
export const LT_MOTION = [['bar', 'Bar - card with a strip'], ['split', 'Split - two-colour blocks'], ['line', 'Line - text + underline only'], ['pill', 'Pill - rounded tag']];
export const PACK_SLOTS = ['logo', 'intro', 'outro'];
export const PACK_DEFAULTS = { primary: '#0b2545', accent: '#ff9933', text: '#ffffff', accent2: '', palette: [], font: 'Arial', capPreset: 'karaoke',
  logoPos: 'tr', logoScale: 0.12, logoOpacity: 0.9, introDur: 2.5, outroDur: 3, endText: '', ltTitle: 'lt-navy', ltMotion: 'bar' };

const HEX = /^#[0-9a-f]{6}$/i;
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const hex = (v, d) => (HEX.test(v || '') ? v.toLowerCase() : d);
const num = (v, lo, hi, d) => (v !== '' && v != null && Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
const oneOf = (v, list, d) => (list.some(([k]) => k === v) ? v : d);

// a pack as saved: every field present and sane (the server cleans whatever a page or an older file sends)
export function cleanPack(p = {}) {
  const D = PACK_DEFAULTS;
  const palette = [...new Set((Array.isArray(p.palette) ? p.palette : []).filter((c) => HEX.test(c || '')).map((c) => c.toLowerCase()))].slice(0, 8);
  return {
    id: str(p.id, 40), name: str(p.name, 80) || 'Untitled pack', client: str(p.client, 120), notes: str(p.notes, 500),
    primary: hex(p.primary, D.primary), accent: hex(p.accent, D.accent), text: hex(p.text, D.text), accent2: hex(p.accent2, ''), palette,
    font: str(p.font, 60) || D.font, capPreset: CAPTION_PRESETS[p.capPreset] ? p.capPreset : D.capPreset,
    logo: str(p.logo, 500), logoPos: oneOf(p.logoPos, LOGO_POS, D.logoPos), logoScale: num(p.logoScale, 0.03, 0.5, D.logoScale), logoOpacity: num(p.logoOpacity, 0.1, 1, D.logoOpacity),
    intro: str(p.intro, 500), introDur: num(p.introDur, 0.5, 15, D.introDur), outro: str(p.outro, 500), outroDur: num(p.outroDur, 0.5, 15, D.outroDur),
    endText: str(p.endText, 200), ltTitle: oneOf(p.ltTitle, LT_TITLES, D.ltTitle), ltMotion: oneOf(p.ltMotion, LT_MOTION, D.ltMotion),
    ...(p.saved ? { saved: +p.saved || 0 } : {}), ...(p.by ? { by: str(p.by, 60) } : {}),
  };
}

// the colours a pack (or a project's brand) offers in colour pickers, each once
export const packColors = (b) => (b ? [...new Set([b.primary, b.accent, b.text, b.accent2, ...(b.palette || [])].filter((c) => HEX.test(c || '')).map((c) => c.toLowerCase()))] : []);

// a title in the brand's colours: its box / strip / card background in the main colour, its bar in the accent and,
// where it sits on a brand colour, its words in the brand's text colour
export function recolorTitle(c, b) {
  if (c.type !== 'title' || !b?.primary) return;
  let onBrand = false;
  if (c.box && c.box !== 'none') { c.box = b.primary; onBrand = true; }
  if (c.strip) { c.strip = b.primary; onBrand = true; }
  if (c.accent) c.accent = b.accent;
  if (c.bg && !c.mediaId) { c.bg = b.primary; onBrand = true; }
  if (onBrand && b.text) c.textColor = b.text;
}
const isLowerThird = (c) => c.type === 'title' && LT_TITLES.some(([id]) => id === c.template);

// Apply a pack to a project (changes it in place; the caller commits, so it is one Ctrl+Z).
// files = the project's media items for the pack's files: { logo, intro, outro } ({ id, kind, duration }) - a missing
// one is left out. What an earlier pack put in (its intro / outro / end card, its logo) is replaced, never stacked.
// opts: intro / outro false = leave that piece out this time; uid makes clip ids.
export function applyPack(P, pack, files = {}, { intro = true, outro = true, uid } = {}) {
  const b = cleanPack(pack), mkId = uid || (() => Math.random().toString(36).slice(2, 10));
  P.tracks ||= {}; P.tracks.V1 ||= [];
  const oldLogo = P.logo?.pack ? P.logo.mediaId : null;
  // 🔁 the earlier pack's pieces go first
  P.tracks.V1 = P.tracks.V1.filter((c) => !c.brandClip);
  if (P.logo?.pack) { const { pack: _p, ...rest } = P.logo; P.logo = { ...rest, mediaId: '' }; }
  // logo in its corner
  if (files.logo) P.logo = { ...(P.logo || {}), mediaId: files.logo.id, pos: b.logoPos, scale: b.logoScale, opacity: b.logoOpacity, pack: b.id || b.name };
  // captions: the pack's style in its font, the highlight in the accent, a box in the main colour
  const preset = CAPTION_PRESETS[b.capPreset];
  P.captions = { ...(P.captions || {}), on: P.captions?.on ?? false, cues: P.captions?.cues || [],
    style: { ...(P.captions?.style || {}), ...preset, preset: 'brand', font: b.font, hl: b.accent, ...(preset.box ? { box: b.primary } : {}) } };
  // titles: lower thirds take the pack's lower-third look (their words stay), then everything in the brand colours
  const lt = templateById(b.ltTitle);
  const brand = { primary: b.primary, accent: b.accent, text: b.text, ...(b.accent2 ? { accent2: b.accent2 } : {}) };
  for (const l of Object.values(P.tracks)) for (const c of l || []) {
    if (isLowerThird(c) && lt) applyTemplate(c, lt);
    recolorTitle(c, b);
    // motion graphics in the brand look follow the new pack (colours, font, lower-third style, logo)
    if (c.type === 'graphic' && c.gfx?.theme === 'brand') {
      c.gfx.brand = { ...brand }; c.gfx.font = b.font;
      if (c.gfx.tpl === 'lower3') c.gfx.style = b.ltMotion;
      if ('logo' in c.gfx && (!c.gfx.logo || c.gfx.logo === oldLogo)) c.gfx.logo = files.logo?.id || '';
    }
  }
  P.brand = { pack: { id: b.id, name: b.name }, ...brand, palette: b.palette, font: b.font, lt: b.ltTitle, ltMotion: b.ltMotion };
  // intro at the start, outro (or the end card) at the end of the main story
  const shot = (m, dur, role) => ({ id: mkId(), type: m.kind === 'image' ? 'image' : 'video', mediaId: m.id,
    ...(m.kind === 'image' ? { dur } : { in: 0, ...(m.duration > 0 ? { out: +m.duration.toFixed(3) } : {}) }), brandClip: role });
  if (intro && files.intro) P.tracks.V1.unshift(shot(files.intro, b.introDur, 'intro'));
  if (outro && files.outro) P.tracks.V1.push({ ...shot(files.outro, b.outroDur, 'outro'), transitionIn: { type: 'fadeblack', dur: 0.5 } });
  else if (outro && b.endText) P.tracks.V1.push({ id: mkId(), type: 'title', text: b.endText, dur: b.outroDur, bg: b.primary, textColor: b.text, accent: b.accent, brandClip: 'outro', transitionIn: { type: 'fadeblack', dur: 0.5 } });
  return P;
}
