// 💥 VFX presets (the VFX page's gallery) and the AI prompt ("a big fireball behind him at 2 s" -> a preset + its
// parameters). A preset is any mix of:
//   layers:  VFX elements (vfxlib.js) - each becomes a graphic clip over the shot, on a free track above it
//   effects: picture effects on the shot itself (vfxfx.js / effects.js)
//   ramp:    a speed ramp (model.js RAMPS) with optical-flow in-betweens, zoom: a push-in over the shot
//   ai:      the AI matte the effects need ('depth' | 'sky'), made by the page right after it is applied
// No DOM here: the page, the agent tools and the tests use the same code.
import { KINDS, newVfx } from './vfxlib.js';
import { VFX_PIC } from './vfxfx.js';
import { uid, compTrack, setRamp, keepLength, clipDur, RAMPS } from './model.js';

export const CATS = ['Gunfire & impacts', 'Fire & explosions', 'Energy & sci-fi', 'Light & lens', 'Atmosphere', 'Distortion', 'Film', 'Time', 'Compositing'];
const L = (kind, p = {}, extra = {}) => ({ kind, p, ...extra });
const E = (type, p = {}) => ({ type, p });
export const PRESETS = [
  { id: 'muzzle', name: 'Muzzle flash - auto fire', cat: 'Gunfire & impacts', words: 'muzzle gun gunfire gunshot shooting firing rifle machine automatic goli bandook firing', layers: [L('muzzle')] },
  { id: 'shot', name: 'Single gunshot', cat: 'Gunfire & impacts', words: 'single shot pistol one gunshot bang', layers: [L('muzzle', { rate: 0, at: 0.3, size: 16 }), L('smoke', { at: 0.32, burst: 0.25, rate: 14, size: 5, life: 1.6, rise: 4, width: 2, x: 63, y: 55, opacity: 0.35, color: '#b5b5b5' })] },
  { id: 'hit', name: 'Bullet hit sparks', cat: 'Gunfire & impacts', words: 'bullet hit impact ricochet spark metal', layers: [L('sparks', { at: 0.3, burst: 0.12, rate: 260, speed: 70, spread: 120, life: 0.6 }), L('smoke', { at: 0.3, burst: 0.3, rate: 12, size: 6, life: 1.5, width: 2, y: 60, opacity: 0.4, color: '#a39a8c' })] },
  { id: 'impact', name: 'Impact shockwave', cat: 'Gunfire & impacts', words: 'impact punch slam hit shockwave', layers: [L('sparks', { at: 0.2, burst: 0.1, rate: 300, speed: 90, spread: 360, life: 0.5, color: '#ffe2a0' })], effects: [E('vxshock', { start: 0.2, strength: 35 })] },
  { id: 'explosion', name: 'Explosion', cat: 'Fire & explosions', words: 'explosion explode blast bomb boom dhamaka dhamaaka visfot', layers: [L('explosion'), L('smoke', { at: 0.4, burst: 1.4, rate: 12, size: 20, life: 5.5, rise: 15, wind: 2, width: 30, y: 56, color: '#6a625b', opacity: 0.5 })], effects: [E('vxshock', { start: 0.15, strength: 30, glow: 0.2 })] },
  { id: 'fireball', name: 'Fireball', cat: 'Fire & explosions', words: 'fireball fire ball inferno napalm gola', layers: [L('explosion', { size: 55, life: 2.4, ring: 0, debris: 12, color: '#ff5a1a', flash: 0.6 })] },
  { id: 'fire', name: 'Fire', cat: 'Fire & explosions', words: 'fire flames burning blaze aag jwala lapte', layers: [L('fire'), L('smoke', { y: 55, width: 14, rate: 4, size: 18, life: 4, opacity: 0.35, color: '#5a5550' })] },
  { id: 'campfire', name: 'Campfire / diya glow', cat: 'Fire & explosions', words: 'campfire bonfire small fire diya lamp candle', layers: [L('fire', { width: 9, height: 16, intensity: 0.8, embers: 8 })] },
  { id: 'smoke', name: 'Smoke plume', cat: 'Fire & explosions', words: 'smoke plume dhuan dhuaan', layers: [L('smoke', { color: '#4b4744', opacity: 0.65, size: 22, rate: 6 })] },
  { id: 'groundsmoke', name: 'Ground smoke', cat: 'Fire & explosions', words: 'ground smoke low mist stage smoke', layers: [L('smoke', { y: 98, width: 100, rise: 2, wind: 3, size: 30, rate: 8, life: 6, opacity: 0.45, color: '#c9c9c9' })] },
  { id: 'lightning', name: 'Lightning strike', cat: 'Energy & sci-fi', words: 'lightning thunder bolt bijli storm toofan', layers: [L('lightning')] },
  { id: 'beam', name: 'Energy beam', cat: 'Energy & sci-fi', words: 'energy beam power blast ray kamehameha', layers: [L('beam')] },
  { id: 'laser', name: 'Laser', cat: 'Energy & sci-fi', words: 'laser red beam sniper', layers: [L('beam', { width: 0.5, color: '#ff2a2a', wobble: 0, pulse: 0, grow: 0.08 })] },
  { id: 'shield', name: 'Force field', cat: 'Energy & sci-fi', words: 'force field shield bubble dome barrier kavach', layers: [L('forcefield')] },
  { id: 'hologram', name: 'Hologram', cat: 'Energy & sci-fi', words: 'hologram holographic projection sci-fi', effects: [E('vxholo')] },
  { id: 'glitch', name: 'Glitch', cat: 'Energy & sci-fi', words: 'glitch digital error broken signal', effects: [E('vxglitch')] },
  { id: 'corrupt', name: 'Data corruption', cat: 'Energy & sci-fi', words: 'corruption corrupted glitch datamosh hacked', effects: [E('vxglitch', { amount: 0.95, blocks: 30, rgb: 22, speed: 16 })] },
  { id: 'leakwarm', name: 'Light leak - warm', cat: 'Light & lens', words: 'light leak warm golden orange film leak', layers: [L('leak')] },
  { id: 'leakcool', name: 'Light leak - cool', cat: 'Light & lens', words: 'cool light leak blue teal', layers: [L('leak', { color: '#2a7bff', color2: '#7fe7ff', side: 'right' })] },
  { id: 'flareblue', name: 'Anamorphic flare - blue', cat: 'Light & lens', words: 'anamorphic flare lens flare blue streak jj abrams', layers: [L('flare')] },
  { id: 'flaregold', name: 'Anamorphic flare - gold', cat: 'Light & lens', words: 'gold golden flare sun warm streak', layers: [L('flare', { color: '#ffb347', x: 70, y: 30 })] },
  { id: 'dirt', name: 'Lens dirt + flare', cat: 'Light & lens', words: 'lens dirt dust on lens dirty lens smudge', layers: [L('flare', { color: '#ffd9a0', length: 60, ghosts: 0.3 }), L('dirt', { color: '#ffd9a0', x: 30, y: 35 })] },
  { id: 'rain', name: 'Rain', cat: 'Atmosphere', words: 'rain rainy drizzle barish baarish monsoon', layers: [L('rain')] },
  { id: 'storm', name: 'Thunder storm', cat: 'Atmosphere', words: 'storm thunderstorm heavy rain toofan aandhi', layers: [L('rain', { density: 900, speed: 320, angle: 18, opacity: 0.45, haze: 0.3 }), L('lightning', { rate: 0.35, at: 0.8, flash: 0.6, branches: 6 })] },
  { id: 'snow', name: 'Snow', cat: 'Atmosphere', words: 'snow snowfall winter barf himpaat', layers: [L('snow')] },
  { id: 'dust', name: 'Dust in the light', cat: 'Atmosphere', words: 'dust motes particles floating bokeh dhool', layers: [L('dust')] },
  { id: 'heat', name: 'Heat haze', cat: 'Atmosphere', words: 'heat haze shimmer desert mirage garmi', effects: [E('vxhaze', { area: 'bottom', amount: 8 })] },
  { id: 'fog', name: 'Depth fog (AI)', cat: 'Atmosphere', words: 'fog mist haze depth kohra dhund atmosphere', ai: 'depth', effects: [E('vxfog')] },
  { id: 'shock', name: 'Shockwave ripple', cat: 'Distortion', words: 'shockwave ripple wave distortion pulse', effects: [E('vxshock')] },
  { id: 'burn', name: 'Film burn', cat: 'Film', words: 'film burn burnt flash film', layers: [L('burn', { at: 0.8 })], atMid: 'at' },
  { id: 'burnout', name: 'Film burn - out', cat: 'Film', words: 'film burn transition end out', layers: [L('burn', { at: 0, life: 1.2, side: 'left' })], atEnd: 'at' },
  { id: 'bullet', name: 'Bullet time', cat: 'Time', words: 'bullet time matrix freeze slow motion slowmo frozen', ramp: 'bullet', zoom: 1.1 },
  { id: 'ramphit', name: 'Speed ramp - hit', cat: 'Time', words: 'speed ramp hit slow fast', ramp: 'hit' },
  { id: 'rampin', name: 'Ramp into slow motion', cat: 'Time', words: 'ramp into slow motion slow down', ramp: 'in' },
  { id: 'key', name: 'Chroma key Pro', cat: 'Compositing', words: 'chroma key green screen greenscreen keying spill', effects: [E('vxkey')] },
  { id: 'skysunset', name: 'New sky - sunset (AI)', cat: 'Compositing', words: 'sky replacement sunset sky aasmaan', ai: 'sky', effects: [E('vxsky', { top: '#1d3b78', horizon: '#ff9a5a' })] },
  { id: 'skydusk', name: 'New sky - blue hour (AI)', cat: 'Compositing', words: 'blue hour dusk evening sky night', ai: 'sky', effects: [E('vxsky', { top: '#0b1636', horizon: '#3f6fb5', bright: 0.9 })] },
  { id: 'skystorm', name: 'New sky - stormy (AI)', cat: 'Compositing', words: 'stormy dark clouds grey sky overcast', ai: 'sky', effects: [E('vxsky', { top: '#2b2f36', horizon: '#6b7480', bright: 0.85 })] },
  { id: 'dof', name: 'Cinematic depth of field (AI)', cat: 'Compositing', words: 'depth of field bokeh background blur dof cinematic portrait', ai: 'depth', effects: [E('vxdof')] },
  { id: 'screen', name: 'Screen replacement', cat: 'Compositing', words: 'screen replacement replace phone tv monitor laptop screen insert', layers: [L('screen')] },
];
export const presetById = (id) => PRESETS.find((p) => p.id === id) || null;

// ---- apply: changes the project in place. at = { start, dur } of the shot on the timeline, track = its track ----
// returns { clips: [new graphic clips], effects: [effect ids], ramp } (undo is the caller's commit)
export function applyPreset(project, clip, preset, media, at, track = 'V1', over = {}) {
  const out = { clips: [], effects: [], ramp: null };
  const start = +at.start || 0, dur = Math.max(0.2, +at.dur || clipDur(clip, media) || 3);
  for (const l of preset.layers || []) {
    const p = { ...l.p, ...(over[l.kind] || {}) };
    if (preset.atMid && !(over[l.kind] && preset.atMid in over[l.kind])) p[preset.atMid] = +(dur / 2).toFixed(2);
    if (preset.atEnd && !(over[l.kind] && preset.atEnd in over[l.kind])) p[preset.atEnd] = +Math.max(0, dur - 0.7).toFixed(2);
    const id = compTrack(project, start, dur, media, track);
    const c = { id: uid(), type: 'graphic', start: +start.toFixed(3), dur: +dur.toFixed(3), gfx: { tpl: 'vfx', vfx: newVfx(l.kind, p) }, vfxOf: clip.id };
    if (KINDS[l.kind].blend) c.blend = KINDS[l.kind].blend;
    project.tracks[id].push(c);
    out.clips.push({ track: id, clip: c });
  }
  if (preset.effects?.length && (clip.type === 'video' || clip.type === 'image')) {
    clip.effects ||= [];
    for (const e of preset.effects) {
      const x = { id: uid(), type: e.type, on: true, p: { ...e.p, ...(over[e.type] || {}) } };
      clip.effects.push(x);
      out.effects.push(x.id);
    }
  }
  if (preset.ramp && clip.type === 'video' && RAMPS[preset.ramp]) {
    const D0 = clipDur(clip, media);
    if (setRamp(clip, preset.ramp, media)) { keepLength(project, clip, D0, media); clip.smooth = true; out.ramp = preset.ramp; }
    if (preset.zoom) { clip.keys ||= {}; clip.keys['transform.zoom'] = [{ t: 0, v: 1, ease: true }, { t: +D0.toFixed(3), v: preset.zoom }]; }
  }
  return out;
}

// ---- 🧠 AI prompt -> a preset and its parameters (understands English, Hindi and Hinglish words) ----
const COLORS = { red: '#ff2a2a', laal: '#ff2a2a', blue: '#2f8cff', neela: '#2f8cff', green: '#27e07a', hara: '#27e07a', purple: '#a35bff', pink: '#ff4fb4', gold: '#ffb347', golden: '#ffb347', sunehra: '#ffb347', orange: '#ff7a1a', white: '#ffffff', safed: '#ffffff', cyan: '#36e0ff', teal: '#22c3b5', yellow: '#ffd23f', peela: '#ffd23f' };
const COLOR_KEY = { muzzle: 'color', explosion: 'color', sparks: 'color', smoke: 'color', fire: 'color', lightning: 'color', beam: 'color', forcefield: 'color', leak: 'color', flare: 'color', dirt: 'color', rain: 'color', snow: 'color', dust: 'color', burn: 'color', vxholo: 'color', vxshock: 'color', vxfog: 'color' };
const SIZE_KEY = { muzzle: 'size', explosion: 'size', smoke: 'size', fire: ['width', 'height'], forcefield: 'radius', beam: 'width', flare: 'length' };
const POWER_KEY = { fire: 'intensity', rain: 'density', snow: 'density', dust: 'density', sparks: 'rate', leak: 'strength', flare: 'strength', burn: 'strength', vxglitch: 'amount', vxhaze: 'amount', vxshock: 'strength', vxfog: 'density', vxdof: 'blur' };
// (words that only change a preset - colour, size, strength, place - never choose one on their own)
const MODS = new Set([...Object.keys(COLORS), 'big', 'bigger', 'large', 'huge', 'massive', 'giant', 'bada', 'small', 'tiny', 'chhota', 'chota', 'little', 'heavy', 'intense', 'strong', 'extreme', 'zyada', 'tez', 'lots', 'dense', 'subtle', 'light', 'soft', 'halka', 'thoda', 'gentle', 'slight', 'left', 'right', 'center', 'centre', 'middle', 'at', 'after', 'behind', 'the', 'a', 'on', 'in', 'of']);
const words = (s) => String(s || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{M}\d.]+/gu) || [];
// -> { preset, over: { kind or effect type: { param: value } }, why: ['...'] } or null when nothing fits
export function fromPrompt(text) {
  const w = words(text), s = w.join(' ');
  if (!w.length) return null;
  let best = null, bestScore = 0;
  for (const p of PRESETS) {
    const keys = new Set(words(`${p.words} ${p.name}`));
    let sc = 0;
    for (const x of w) if (keys.has(x) && !MODS.has(x)) sc += x.length > 3 ? 2 : 1;
    // two-word phrases count extra ("light leak", "bullet time", "green screen")
    for (let i = 0; i < w.length - 1; i++) if (` ${p.words} ${p.name.toLowerCase()} `.includes(` ${w[i]} ${w[i + 1]} `)) sc += 3;
    if (sc > bestScore) { best = p; bestScore = sc; }
  }
  if (!best) return null;
  const why = [best.name], over = {};
  const targets = [...(best.layers || []).map((l) => l.kind), ...(best.effects || []).map((e) => e.type)];
  const set = (map, val, label) => {
    let done = false;
    for (const t of targets) {
      const k = map[t];
      // (a colour goes to the light, fire and effects - the smoke of an explosion stays smoke-coloured)
      if (!k || (map === COLOR_KEY && t === 'smoke' && best.layers?.[0]?.kind !== 'smoke')) continue;
      for (const kk of [].concat(k)) {
        const d = KINDS[t]?.params[kk] || VFX_PIC[t]?.params[kk], base = (best.layers || []).find((l) => l.kind === t)?.p?.[kk] ?? (best.effects || []).find((e) => e.type === t)?.p?.[kk] ?? d?.def;
        let v = typeof val === 'function' ? val(base) : val;
        if (typeof v === 'number' && d) v = Math.min(d.max ?? v, Math.max(d.min ?? v, v));
        (over[t] ||= {})[kk] = v; done = true;
      }
    }
    if (done && label) why.push(label);
  };
  const col = w.find((x) => COLORS[x]);
  if (col) set(COLOR_KEY, COLORS[col], `${col} colour`);
  if (/\b(huge|massive|giant|bada|bahut bada|big|large|bigger)\b/.test(s)) set(SIZE_KEY, (b) => +(b * (/(huge|massive|giant)/.test(s) ? 1.8 : 1.4)).toFixed(2), 'bigger');
  if (/\b(small|tiny|chhota|chota|little)\b/.test(s)) set(SIZE_KEY, (b) => +(b * 0.6).toFixed(2), 'smaller');
  if (/\b(heavy|intense|strong|extreme|zyada|tez|lots|dense)\b/.test(s)) set(POWER_KEY, (b) => +(b * 1.6).toFixed(2), 'stronger');
  if (/\b(subtle|soft|halka|thoda|gentle|slight)\b/.test(s)) set(POWER_KEY, (b) => +(b * 0.55).toFixed(2), 'subtler');
  // where: left / right / top / bottom / centre
  const pos = /\b(left|baayen|bayen)\b/.test(s) ? { x: 25 } : /\b(right|daayen|dayen)\b/.test(s) ? { x: 75 } : /\b(center|centre|middle|beech)\b/.test(s) ? { x: 50 } : null;
  if (pos) { for (const l of best.layers || []) if ('x' in KINDS[l.kind].params) Object.assign((over[l.kind] ||= {}), pos); why.push(pos.x < 50 ? 'on the left' : pos.x > 50 ? 'on the right' : 'in the middle'); }
  // when: "at 2 s", "2 sec par", "after 1.5"
  const tm = /(?:at|after|par|pe|@)\s*(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)?\b|(\d+(?:\.\d+)?)\s*(?:s|sec|second|seconds)\s*(?:par|pe|me|mein)?\b/.exec(s);
  if (tm) { const t = +(tm[1] ?? tm[2]); const at0 = (l) => +(l.p.at ?? KINDS[l.kind].params.at.def), first = (best.layers || []).find((l) => 'at' in KINDS[l.kind].params);
    // (the layers keep their timing to each other: the smoke of an explosion still comes after its flash)
    for (const l of best.layers || []) if ('at' in KINDS[l.kind].params) (over[l.kind] ||= {}).at = +(t + at0(l) - at0(first)).toFixed(2); for (const e of best.effects || []) if (e.type === 'vxshock') (over.vxshock ||= {}).start = t; why.push(`at ${t} s`); }
  // 🧍 "behind him / her / the person": keep the subject clean (picture effects) - the page makes the subject matte
  const subject = /\b(behind|peeche|piche|background only|not on (him|her|the person|people)|keep (him|her|the person) clean)\b/.test(s);
  if (subject) why.push('subject kept clean (AI matte)');
  return { preset: best, over, why, subject };
}
