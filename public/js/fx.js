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
// ⚡ hits (Labs): the same effects at any moment of a clip - c.hits = [{ t, type, dur }] (seconds into the clip)
export const hitsOf = (c) => (Array.isArray(c?.hits) ? c.hits.filter((h) => CUTFX[h.type] && h.t >= 0) : []);
export function fxPreview(c, rel) {
  const D0 = cutFxDur(c);
  if (D0 && rel >= 0 && rel <= D0) return fxAt(c.cutFx.type, rel, D0);
  for (const h of hitsOf(c)) { const d = +h.dur || CUTFX[h.type].dur; if (rel >= h.t && rel <= h.t + d) return fxAt(h.type, rel - h.t, d); }
  return null;
}
// the look of cut effect `type` at `rel` seconds into its `D` seconds
function fxAt(type, rel, D) {
  const u = rel / D, k = 1 - u, out = { transform: '', filter: '', overlay: null };
  switch (type) {
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

// ---------------- transitions: Premiere's shapes FFmpeg's xfade has no name for ----------------
// xfade=transition=custom: P runs 1 -> 0 over the transition (1 = all A, the outgoing shot), A / B = this pixel of the
// two shots, a0(x, y) / b0(x, y)... = a pixel of plane 0 / 1 / 2; X, Y, W, H are in the plane's own pixels.
// (No st() / ld(): xfade runs one expression on several threads, which share those registers - the picture breaks up.)
const at = (s, x, y) => `if(eq(PLANE,0),${s}0(${x},${y}),if(eq(PLANE,1),${s}1(${x},${y}),${s}2(${x},${y})))`;
const ANG = 'atan2(X-W/2,H/2-Y)'; // the angle from 12 o'clock, clockwise
const ROW7 = 'mod(floor(Y/(H/7)),2)', CELL = 'mod(floor(X/(W/8))+floor(Y/(H/8)),2)';
const RND = 'sin(floor(X/(W/16))*12.9898+floor(Y/(H/9))*78.233)*43758.5453'; // a fixed random number per block (fraction below)
const SX = 'if(lt(X,W/2),X+(1-P)*W/2,X-(1-P)*W/2)', SY = 'if(lt(Y,H/2),Y+(1-P)*H/2,Y-(1-P)*H/2)', BX = `if(${ROW7},X+P*W,X-P*W)`;
const FS = 'abs(2*P-1)', FX = `(W/2+(X-W/2)/max(${FS},0.001))`;
export const XFADE_EXPR = {
  adddissolve: 'if(eq(PLANE,0),min(255,16+max(0,A-16)*min(1,2*P)+max(0,B-16)*min(1,2*(1-P))),A*P+B*(1-P))',
  nonadddissolve: 'if(eq(PLANE,0),max(A*min(1,2*P),B*min(1,2*(1-P))),A*P+B*(1-P))',
  iriscross: 'if(max(lt(abs(X/W-0.5),(1-P)/2)*lt(abs(Y/H-0.5),1-P),lt(abs(Y/H-0.5),(1-P)/2)*lt(abs(X/W-0.5),1-P)),B,A)',
  irisdiamond: 'if(lt(abs(X/W-0.5)+abs(Y/H-0.5),1-P),B,A)',
  clockwipe: `if(lt(mod(${ANG}+2*PI,2*PI)/(2*PI),1-P),B,A)`,
  wedgewipe: `if(lt(abs(${ANG})/PI,1-P),B,A)`,
  pinwheel: `if(lt(mod(${ANG}+2*PI,PI/4)/(PI/4),1-P),B,A)`,
  inset: 'if(lt(X/W,1-P)*lt(Y/H,1-P),B,A)',
  venetian: 'if(lt(mod(Y,H/10)/(H/10),1-P),B,A)',
  bandwipe: `if(lt(if(${ROW7},1-X/W,X/W),1-P),B,A)`,
  checkerwipe: `if(lt(mod(X,W/8)/(W/8),2*(1-P)-${CELL}),B,A)`,
  checkerboard: `if(lt(mod(Y,H/8)/(H/8),2*(1-P)-${CELL}),B,A)`,
  randomblocks: `if(lt(${RND}-floor(${RND}),1-P),B,A)`,
  // A in four quarters, each moving out to its corner
  centersplit: `if(eq(lt(X,W/2),lt(${SX},W/2))*eq(lt(Y,H/2),lt(${SY},H/2)),${at('a', SX, SY)},B)`,
  // bands of B sliding in from alternate sides
  bandslide: `if(between(${BX},0,W-1),${at('b', BX, 'Y')},A)`,
  // A squeezed to a line, then B opened from it (black behind)
  flipover: `if(lt(abs(X-W/2),${FS}*W/2),if(gt(P,0.5),${at('a', FX, 'Y')},${at('b', FX, 'Y')}),if(PLANE,128,16))`,
};
// the xfade options of a transition type
export const xfadeOf = (type) => (XFADE_EXPR[type] ? `transition=custom:expr='${XFADE_EXPR[type]}'` : `transition=${type}`);

// 🖥 The monitor's live look of a transition, q = 0..1 through it (the render's xfade is the exact one):
// { show: [[x%, y%], ...] where the incoming shot is seen (one polygon; null = all of it), cur / prev: { tx, ty (% moves),
// sx (horizontal squeeze), op (opacity) } } - or null: shown as a dissolve. ar = the frame's width / height.
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// several shapes as one polygon: each joined to the corner by a line out and the same line back (no area)
const joined = (shapes) => shapes.filter((s) => s.length).flatMap((s) => [[0, 0], ...s, s[0], [0, 0]]);
const fan = (a0, a1, ar, steps = 24) => { const R = 300 * Math.max(ar, 1), pts = [[50, 50]];
  for (let i = 0; i <= steps; i++) { const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180; pts.push([50 + (Math.sin(a) * R) / ar, 50 - Math.cos(a) * R]); }
  return pts; };
const circleAt = (r, ar) => Array.from({ length: 48 }, (_, i) => { const a = (i / 48) * 2 * Math.PI, R = r * Math.hypot(ar, 1); return [50 + (Math.cos(a) * R * 100) / ar, 50 + Math.sin(a) * R * 100]; });
export function trLive(type, q, ar = 16 / 9) {
  q = Math.min(1, Math.max(0, q));
  const r = 1 - q, P = (x) => +(x * 100).toFixed(3);
  switch (type) {
    case 'wipeleft': return { show: rect(P(r), 0, 100, 100) };
    case 'wiperight': return { show: rect(0, 0, P(q), 100) };
    case 'wipeup': return { show: rect(0, P(r), 100, 100) };
    case 'wipedown': return { show: rect(0, 0, 100, P(q)) };
    case 'vertopen': return { show: rect(P(r / 2), 0, 100 - P(r / 2), 100) };
    case 'horzopen': return { show: rect(0, P(r / 2), 100, 100 - P(r / 2)) };
    case 'vertclose': return { show: joined([rect(0, 0, P(q / 2), 100), rect(100 - P(q / 2), 0, 100, 100)]) };
    case 'horzclose': return { show: joined([rect(0, 0, 100, P(q / 2)), rect(0, 100 - P(q / 2), 100, 100)]) };
    case 'circleopen': return { show: circleAt(q / 2, ar) };
    case 'inset': return { show: rect(0, 0, P(q), P(q)) };
    case 'irisdiamond': return { show: [[50, 50 - P(q)], [50 + P(q), 50], [50, 50 + P(q)], [50 - P(q), 50]] };
    case 'iriscross': { const a = P(q / 2), b = Math.min(50, P(q));
      return { show: [[50 - a, 50 - b], [50 + a, 50 - b], [50 + a, 50 - a], [50 + b, 50 - a], [50 + b, 50 + a], [50 + a, 50 + a], [50 + a, 50 + b], [50 - a, 50 + b], [50 - a, 50 + a], [50 - b, 50 + a], [50 - b, 50 - a], [50 - a, 50 - a]] }; }
    case 'clockwipe': return { show: fan(0, 360 * q, ar, 48) };
    case 'wedgewipe': return { show: fan(-180 * q, 180 * q, ar) };
    case 'pinwheel': return { show: Array.from({ length: 8 }, (_, k) => fan(45 * k, 45 * k + 45 * q, ar, 4)).flat() };
    case 'venetian': return { show: joined(Array.from({ length: 10 }, (_, i) => rect(0, i * 10, 100, i * 10 + P(q / 10)))) };
    case 'bandwipe': return { show: joined(Array.from({ length: 7 }, (_, i) => (i % 2 ? rect(100 - P(q), (i * 100) / 7, 100, ((i + 1) * 100) / 7) : rect(0, (i * 100) / 7, P(q), ((i + 1) * 100) / 7)))) };
    case 'checkerwipe': case 'checkerboard': {
      const cells = [];
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const f = Math.min(1, Math.max(0, 2 * q - ((i + j) % 2))); if (f > 0) cells.push(type === 'checkerwipe' ? rect(i * 12.5, j * 12.5, i * 12.5 + 12.5 * f, j * 12.5 + 12.5) : rect(i * 12.5, j * 12.5, i * 12.5 + 12.5, j * 12.5 + 12.5 * f)); }
      return { show: cells.length ? joined(cells) : [[0, 0], [0, 0], [0, 0]] }; }
    // moves: push (both move), slide / cover (the new shot moves in over the old), reveal (the old moves away)
    case 'slideleft': return { cur: { tx: P(r) }, prev: { tx: -P(q) } };
    case 'slideright': return { cur: { tx: -P(r) }, prev: { tx: P(q) } };
    case 'slideup': return { cur: { ty: P(r) }, prev: { ty: -P(q) } };
    case 'slidedown': return { cur: { ty: -P(r) }, prev: { ty: P(q) } };
    case 'coverleft': return { cur: { tx: P(r) }, show: rect(P(r), 0, 100, 100) };
    case 'coverright': return { cur: { tx: -P(r) }, show: rect(0, 0, P(q), 100) };
    case 'coverup': return { cur: { ty: P(r) }, show: rect(0, P(r), 100, 100) };
    case 'coverdown': return { cur: { ty: -P(r) }, show: rect(0, 0, 100, P(q)) };
    case 'revealleft': return { prev: { tx: -P(q) }, show: rect(P(r), 0, 100, 100) };
    case 'flipover': return q < 0.5 ? { cur: { op: 0 }, prev: { sx: 1 - 2 * q } } : { cur: { sx: 2 * q - 1 }, prev: { op: 0 } };
    default: return null;
  }
}
export const polyCss = (pts, evenodd = false) => `polygon(${evenodd ? 'evenodd, ' : ''}${pts.map(([x, y]) => `${+x.toFixed(3)}% ${+y.toFixed(3)}%`).join(', ')})`;

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
