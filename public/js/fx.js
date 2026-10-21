// Teaser effects, shared by the viewer (a CSS approximation), engine/render2.mjs (exact, FFmpeg) and the agent:
//  - cut effects: clip.cutFx = { type, dur } plays from the clip's first frame, i.e. on the cut into it. Unlike a
//    transition it overlaps nothing, so the edit's timing (and its sync to the music beat) never changes.
//  - kinetic titles: title.anim = 'words' (one word at a time, punched in) or 'build' (the words add up).
//  - sound design: autoSfx() puts whooshes, hits, risers... on A3, lined up with what happens on the picture.
import { layoutV1, placed, uid, overlayTracks } from './model.js';

export const CUTFX = {
  flash: { label: 'White flash', dur: 0.25 },
  punch: { label: 'Punch zoom', dur: 0.3 },
  shake: { label: 'Camera shake', dur: 0.45 },
  glitch: { label: 'Glitch', dur: 0.3 },
  rgb: { label: 'RGB split', dur: 0.35 },
  whip: { label: 'Whip blur', dur: 0.22 },
  blur: { label: 'Focus pull (blur in)', dur: 0.45 },
  leak: { label: 'Light leak', dur: 0.9 },
  burn: { label: 'Film burn', dur: 0.6 },
  strobe: { label: 'Strobe', dur: 0.35 },
};
export const cutFxDur = (c) => (c?.cutFx?.type && CUTFX[c.cutFx.type] ? +c.cutFx.dur || CUTFX[c.cutFx.type].dur : 0);

// kinetic titles: [{ text, a, b }] - which words show when (timeline seconds). The last word holds to the end.
export function wordWindows(c, start, end) {
  const words = String(c.text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const step = Math.min(0.8, ((end - start) * 0.8) / words.length);
  return words.map((w, i) => ({ text: c.anim === 'build' ? words.slice(0, i + 1).join(' ') : w, a: start + i * step, b: i === words.length - 1 ? end : start + (i + 1) * step }));
}
export const isKinetic = (c) => c?.type === 'title' && (c.anim === 'words' || c.anim === 'build');

// ---------------- viewer preview ----------------
const hash = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
// { transform, filter, overlay: { background, opacity, blend } } for a clip `rel` seconds after it starts, or null
export function fxPreview(c, rel) {
  const D = cutFxDur(c);
  if (!D || rel < 0 || rel > D) return null;
  const u = rel / D, k = 1 - u, out = { transform: '', filter: '', overlay: null };
  switch (c.cutFx.type) {
    case 'flash': out.overlay = { background: '#fff', opacity: 0.85 * k ** 1.5 }; break;
    case 'strobe': out.overlay = { background: Math.floor(rel * 20) % 2 ? '#fff' : '#000', opacity: 0.6 }; break;
    case 'punch': out.transform = `scale(${(1 + 0.22 * k * k).toFixed(3)})`; break;
    case 'shake': out.transform = `translate(${(3 * k * Math.sin(rel * 71)).toFixed(2)}%, ${(3 * k * Math.cos(rel * 97)).toFixed(2)}%) scale(1.08)`; break;
    case 'glitch': { const s = Math.floor(rel * 30); out.transform = `translateX(${((hash(s) - 0.5) * 6).toFixed(2)}%)`; out.filter = `hue-rotate(${Math.round(hash(s + 7) * 360)}deg) saturate(2) contrast(1.3)`; break; }
    case 'rgb': out.transform = `translateX(${(1.5 * k * Math.sin(rel * 60)).toFixed(2)}%)`; out.filter = 'saturate(1.6) contrast(1.2)'; break;
    case 'whip': out.transform = `translateX(${(-8 * k).toFixed(2)}%)`; out.filter = `blur(${(14 * k).toFixed(1)}px)`; break;
    case 'blur': out.filter = `blur(${(10 * k).toFixed(1)}px)`; break;
    case 'leak': out.overlay = { background: 'radial-gradient(circle at 18% 15%, rgba(255,175,70,.95), rgba(255,95,0,.45) 40%, transparent 72%)', opacity: Math.sin(Math.PI * u), blend: 'screen' }; break;
    case 'burn': out.overlay = { background: 'radial-gradient(circle at 70% 60%, #fff6d0, #ff6a00 35%, transparent 75%)', opacity: Math.sin(Math.PI * u) ** 0.7, blend: 'screen' }; break;
    default: return null;
  }
  return out;
}

// ---------------- sound design ----------------
export const SFX_LABELS = { whoosh: 'Whoosh', swish: 'Swish', boom: 'Boom', impact: 'Impact', riser: 'Riser', reverse: 'Reverse swell', glitch: 'Glitch', tick: 'Tick', punch: 'Punch' };
const WHIP_TR = new Set(['hblur', 'slideleft', 'slideright', 'slideup', 'slidedown', 'smoothleft', 'smoothright', 'wipeleft', 'wiperight', 'squeezeh', 'coverleft', 'coverright', 'zoomin']);
const HIT_TR = new Set(['fadewhite', 'fadefast', 'circleopen', 'radial']);
const r3 = (x) => Math.round(x * 1000) / 1000;

// lib = { kind: { mediaId, peak } } (from /api/sfx). Returns the A3 clips: the effects already there that were not
// placed by this function (your own) are kept, the earlier automatic ones (clip.sfx) are replaced.
// Every effect is placed so its loudest moment (peak) lands on the cut / hit it belongs to.
export function autoSfx(project, media, lib, { amount = 1 } = {}) {
  const ev = [], V1 = layoutV1(project, media), P = placed(project, media);
  const total = Math.max(0, ...Object.values(P).flat().map((x) => x.end));
  const add = (t, kind, vol, pri) => { if (lib[kind] && t >= 0 && t <= total) ev.push({ t, kind, vol, pri }); };
  V1.forEach((x, i) => {
    const c = x.clip, cut = x.start + (x.overlap || 0) / 2, tr = i > 0 ? c.transitionIn?.type : null, fx = c.cutFx?.type, D = x.end - x.start;
    if (c.type === 'title' && i > 0) add(x.start, 'impact', 0.85, 4);
    else if (fx === 'glitch' || fx === 'rgb') add(cut, 'glitch', 0.45, 2);
    else if (fx === 'shake' || tr === 'fadewhite') add(cut, 'boom', 0.75, 3);
    else if (fx === 'flash' || fx === 'punch' || fx === 'strobe' || HIT_TR.has(tr)) add(cut, 'punch', 0.7, 2);
    else if (fx === 'whip' || WHIP_TR.has(tr)) add(cut, 'whoosh', 0.6, 2);
    else if (fx === 'leak' || fx === 'burn' || fx === 'blur') add(cut + 0.05, 'swish', 0.45, 1);
    // speed ramps: whoosh on the speed-up, a reverse swell into the slow-down
    if (c.type === 'video' && c.ramp === 'whoosh') add(x.start + 0.5 * D, 'whoosh', 0.55, 1);
    if (c.type === 'video' && (c.ramp === 'hit' || c.ramp === 'in')) add(x.start + (c.ramp === 'hit' ? 0.42 : 0.6) * D, 'reverse', 0.45, 1);
    if (c.type === 'video' && c.ramp === 'punch') add(x.start + 0.45 * D, 'punch', 0.6, 1);
  });
  // the drop: the first big hit after the opening gets an impact, with a riser building into it
  const drop = ev.find((e) => (e.kind === 'boom' || e.kind === 'punch') && e.t > Math.min(8, total * 0.2));
  if (drop && lib.impact) { drop.kind = 'impact'; drop.vol = 0.9; drop.pri = 5; }
  if (drop && lib.riser) ev.push({ t: drop.t, kind: 'riser', vol: 0.5, pri: 4, long: true });
  for (const x of overlayTracks(project).flatMap((id) => P[id] || [])) {
    const c = x.clip; if (c.type !== 'title' || c.disabled) continue;
    if (c.anim === 'words' || c.anim === 'build') wordWindows(c, x.start, x.end).forEach((w) => add(w.a, 'tick', 0.35, 0));
    else if (c.anim === 'slide') add(x.start + 0.1, 'swish', 0.35, 0);
  }
  // keep the strongest when two land on top of each other; fewer effects with a lower amount
  ev.sort((a, b) => b.pri - a.pri || a.t - b.t);
  const keep = [], gap = amount < 1 ? 0.9 : 0.3;
  // the same sound again too soon gets tiring (an edit with a transition on every cut would whoosh non-stop)
  const SAME = { whoosh: 1.8, swish: 1.5, glitch: 0.8, punch: 0.6, boom: 1.2, reverse: 3, tick: 0.15 };
  for (const e of ev) {
    if (!e.long && keep.some((k) => !k.long && Math.abs(k.t - e.t) < gap)) continue;
    if (keep.some((k) => k.kind === e.kind && Math.abs(k.t - e.t) < (SAME[e.kind] || 0) * (amount < 1 ? 1.6 : 1))) continue;
    if (amount < 1 && e.pri < 2) continue;
    keep.push(e);
  }
  const auto = keep.sort((a, b) => a.t - b.t).map((e) => {
    const L = lib[e.kind], start = e.t - (L.peak || 0);
    return { id: uid(), type: 'audio', mediaId: L.mediaId, start: r3(Math.max(0, start)), in: r3(Math.max(0, -start)), volume: e.vol, sfx: e.kind };
  }).filter((c) => !media?.[c.mediaId]?.duration || c.in < media[c.mediaId].duration - 0.05);
  const own = (project.tracks.A3 || []).filter((c) => !c.sfx);
  return [...own, ...auto].sort((a, b) => (a.start || 0) - (b.start || 0));
}
export const sfxCount = (project) => (project.tracks.A3 || []).filter((c) => c.sfx).length;
