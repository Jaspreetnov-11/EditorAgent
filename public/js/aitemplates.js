// 🎬 Motion templates (Phase 22, like Higgsfield's camera-move presets): one click puts a whole camera move on the
// selected shot - its zoom / position / rotation keyframes, a speed ramp, a cut effect and a look - built from the editor's
// own effects, so the viewer shows it live, the render makes it exactly, and every part stays editable (Effect Controls).
// apply() replaces what an earlier template put on the clip (c.tpl remembers which), never the user's own effects.
import { CUTFX } from './fx.js';
import { newEffect } from './effects.js';
import { setRamp } from './model.js';

const k = (t, v, ease) => ({ t: +t.toFixed(3), v, ...(ease ? { ease } : {}) });
const fx = (type, p = {}) => ({ ...newEffect(type), p: { ...newEffect(type).p, ...p }, tpl: true });

// each: { id, icon, label, sub, video?: needs moving footage, make(D) -> { keys, ramp, smooth, cutFx, effects } }
export const TEMPLATES = [
  { id: 'crashin', icon: '💥', label: 'Crash zoom in', sub: 'Fast punch into the subject', make: (D) => ({ keys: { 'transform.zoom': [k(0, 1), k(Math.min(0.35, D * 0.3), 1.55, 'in'), k(D, 1.6)] }, cutFx: { type: 'punch' }, effects: [fx('dblur', { length: 12 })] }) },
  { id: 'crashout', icon: '🌌', label: 'Crash zoom out (reveal)', sub: 'Starts tight, snaps out to the wide', make: (D) => ({ keys: { 'transform.zoom': [k(0, 1.7), k(Math.min(0.45, D * 0.35), 1, 'out')] }, cutFx: { type: 'whip' } }) },
  { id: 'dolly', icon: '🎥', label: 'Slow dolly in', sub: 'Smooth cinematic push', make: (D) => ({ keys: { 'transform.zoom': [k(0, 1), k(D, 1.14, 'io')] }, effects: [fx('vignette', { amount: 0.35 })] }) },
  { id: 'drone', icon: '🚁', label: 'Drone pull-back', sub: 'Rises and pulls away', make: (D) => ({ keys: { 'transform.zoom': [k(0, 1.3), k(D, 1, 'io')], 'transform.y': [k(0, 4), k(D, 0, 'io')] } }) },
  { id: 'arc', icon: '🌀', label: 'Arc / orbit', sub: 'Drifts sideways with a slight tilt', make: (D) => ({ keys: { 'transform.zoom': [k(0, 1.18), k(D, 1.18)], 'transform.x': [k(0, -5), k(D, 5, 'io')], 'transform.rotation': [k(0, -2), k(D, 2, 'io')] } }) },
  { id: 'roll', icon: '🔄', label: 'Barrel roll', sub: 'Spins into the shot', make: (D) => ({ keys: { 'transform.rotation': [k(0, -180), k(Math.min(0.6, D * 0.4), 0, 'out')], 'transform.zoom': [k(0, 1.6), k(Math.min(0.6, D * 0.4), 1.05, 'out')] }, effects: [fx('dblur', { length: 10 })] }) },
  { id: 'bullet', icon: '⏱', label: 'Bullet time', sub: 'Fast → almost frozen → fast', video: true, make: () => ({ ramp: 'bullet', smooth: true, cutFx: { type: 'flash' } }) },
  { id: 'hero', icon: '🦸', label: 'Hero slow-mo', sub: 'Slows to a crawl, with a push in', video: true, make: (D) => ({ ramp: 'hero', smooth: true, keys: { 'transform.zoom': [k(0, 1), k(D, 1.1, 'io')] } }) },
  { id: 'quake', icon: '📳', label: 'Earthquake / impact', sub: 'Hard camera shake on the cut', make: () => ({ cutFx: { type: 'shake', dur: 0.9 }, effects: [fx('rgbsplit', { amount: 4 })] }) },
  { id: 'glitch', icon: '📼', label: 'Glitch hit', sub: 'Digital glitch + RGB split', make: () => ({ cutFx: { type: 'glitch' }, effects: [fx('rgbsplit', { amount: 6 })] }) },
  { id: 'burn', icon: '🎞', label: 'Film burn memory', sub: 'Old-film look with a burn in', make: () => ({ cutFx: { type: 'burn' }, effects: [fx('oldfilm', { amount: 0.6 })] }) },
  { id: 'flashpop', icon: '🌟', label: 'Flash pop', sub: 'White flash and a glow', make: (D) => ({ cutFx: { type: 'flash' }, effects: [fx('glow', { amount: 0.35 })], keys: { 'transform.zoom': [k(0, 1.12), k(Math.min(0.3, D * 0.3), 1, 'out')] } }) },
  { id: 'trails', icon: '👻', label: 'Motion trails', sub: 'Dreamy echoes behind movement', video: true, make: () => ({ effects: [fx('echo', { frames: 5, decay: 0.65 }), fx('glow', { amount: 0.25 })] }) },
  { id: 'strobe', icon: '⚡', label: 'Party strobe', sub: 'Flashes on the beat (0.4 s)', make: () => ({ effects: [fx('strobe', { every: 0.4 })], cutFx: { type: 'strobe' } }) },
];
export const templateById = (id) => TEMPLATES.find((t) => t.id === id);

// put template t on clip c (D = its length on the timeline, kept as it is). Returns a short note of what was set.
// stack: added to the templates already on it (Labs - several at once; a later one wins where they set the same thing)
export function applyTemplate(c, t, D, media, { stack = false } = {}) {
  const had = stack && c.tpl ? c.tpl : null;
  if (!stack) clearTemplate(c, D, media);
  else if (c.tpl?.ids?.includes(t.id) || c.tpl?.id === t.id) return t.label; // (already on)
  const r = t.make(Math.max(0.2, D));
  if (r.keys) { c.keys ||= {}; for (const [p, ks] of Object.entries(r.keys)) c.keys[p] = ks.filter((q) => q.t <= D + 1e-6); }
  if (r.ramp && c.type === 'video') { setRamp(c, r.ramp, media, null, D); if (r.smooth) c.smooth = true; }
  if (r.cutFx && CUTFX[r.cutFx.type]) c.cutFx = { ...r.cutFx };
  if (r.effects?.length) c.effects = [...(c.effects || []), ...r.effects];
  const ids = [...(had?.ids || (had ? [had.id] : [])), t.id];
  c.tpl = { id: t.id, ids, keys: [...new Set([...(had?.keys || []), ...Object.keys(r.keys || {})])], ramp: !!(had?.ramp || r.ramp), cutFx: !!(had?.cutFx || r.cutFx) };
  return t.label;
}
// the templates on a clip, by name ("Crash zoom in + Film burn memory")
export const templateNames = (c) => (c?.tpl ? (c.tpl.ids || [c.tpl.id]).map((id) => templateById(id)?.label).filter(Boolean).join(' + ') : '');
// take back what a template put on (the clip's own effects and keyframes stay)
export function clearTemplate(c, D, media) {
  const t = c.tpl;
  if (!t) return false;
  for (const p of t.keys || []) delete c.keys?.[p];
  if (c.keys && !Object.keys(c.keys).length) delete c.keys;
  if (t.ramp) { setRamp(c, '', media, null, D); delete c.smooth; }
  if (t.cutFx) delete c.cutFx;
  if (c.effects) { c.effects = c.effects.filter((e) => !e.tpl); if (!c.effects.length) delete c.effects; }
  delete c.tpl;
  return true;
}
