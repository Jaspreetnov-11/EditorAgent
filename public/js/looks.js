// Cinematic look and stabilisation, shared by the Inspector, the Assistant and the Agent / Re-edit.
//   settings.look = { letterbox: '' | '1.85' | '2.0' | '2.39', vignette: 0..1, grain: 0..1 }   (renderer: engine/render2.mjs)
//   clip.stabilize = '' | 'light' | 'medium' | 'strong'                                        (vid.stab, render + accurate preview)
// Film looks (engine/looklut.mjs writes LUTs/Looks/<name> (look).cube). css = rough live preview; renders are exact.
export const FILM_LOOKS = [
  ['Teal & Orange', 'contrast(1.14) saturate(1.1) sepia(.08) hue-rotate(-6deg)'], ['Warm Film', 'contrast(1.1) saturate(.9) sepia(.22)'],
  ['Golden Hour', 'contrast(1.08) saturate(1.05) sepia(.32)'], ['Moody Dark', 'brightness(.86) contrast(1.18) saturate(.74)'],
  ['Travel Vivid', 'contrast(1.12) saturate(1.38)'], ['Indian Heritage', 'contrast(1.14) saturate(1.22) sepia(.16)'],
  ['Bleach Bypass', 'contrast(1.3) saturate(.55)'], ['Clean Natural', 'contrast(1.06) saturate(1.08)'],
];
export const lookLut = (name) => (name ? `${name} (look).cube` : '');
export const lookCss = (lk) => { const n = (lk?.lut || '').replace(' (look).cube', ''); const f = FILM_LOOKS.find((x) => x[0] === n); return f && (lk.mix ?? 1) > 0.05 ? f[1] : ''; };
export function setFilmLook(p, name, mix = 0.85) { p.settings.look = { ...(p.settings.look || {}), lut: lookLut(name), mix }; }
export const LETTERBOX = [['', 'None'], ['1.85', '1.85:1 (film)'], ['2.0', '2:1'], ['2.39', '2.39:1 (cinemascope)']];
export const STABILIZE = [['', 'Off'], ['light', 'Light (keeps natural movement)'], ['medium', 'Medium'], ['strong', 'Strong (handheld / walking)']];

const pictureClips = (p) => Object.keys(p.tracks).filter((t) => t[0] === 'V').flatMap((t) => p.tracks[t]).filter((c) => c.type === 'video' || c.type === 'image');

// Film look: bars (landscape formats), soft vignette, light grain, plus a gentle grade on every shot:
// a little more contrast, slightly muted colours, warm highlights and cool (teal) shadows.
export function applyCinematic(p, { bars = true, grade = false, strength = 1 } = {}) {
  const landscape = ['16:9'].includes(p.settings.aspect);
  p.settings.look = { ...(p.settings.look || {}), letterbox: bars && landscape ? '2.39' : '', vignette: 0.45 * strength, grain: 0.25 * strength };
  if (!p.settings.look.lut) Object.assign(p.settings.look, { lut: lookLut('Teal & Orange'), mix: Math.min(1, 0.85 * strength) });
  if (!grade) return;
  for (const c of pictureClips(p)) {
    const g = (c.color ||= {});
    if (g._cine) continue; // only once per clip
    g.contrast = +((g.contrast ?? 1) * (1 + 0.1 * strength)).toFixed(3);
    g.saturation = +((g.saturation ?? 1) * (1 - 0.08 * strength)).toFixed(3);
    g.temp = +Math.min(1, (+g.temp || 0) + 0.1 * strength).toFixed(3);
    g.lift = { ...(g.lift || {}), b: +((g.lift?.b || 0) + 0.025 * strength).toFixed(3), g: +((g.lift?.g || 0) + 0.01 * strength).toFixed(3) };
    g.gain = { ...(g.gain || {}), r: +((g.gain?.r || 0) + 0.02 * strength).toFixed(3) };
    g._cine = 1;
  }
}
export function removeCinematic(p) {
  p.settings.look = { letterbox: '', vignette: 0, grain: 0, lut: '', mix: 0.85 };
  for (const c of pictureClips(p)) {
    const g = c.color; if (!g?._cine) continue;
    g.contrast = +(g.contrast / 1.1).toFixed(3); g.saturation = +(g.saturation / 0.92).toFixed(3); g.temp = +(g.temp - 0.1).toFixed(3);
    if (g.lift) { g.lift.b = +(g.lift.b - 0.025).toFixed(3); g.lift.g = +(g.lift.g - 0.01).toFixed(3); }
    if (g.gain) g.gain.r = +(g.gain.r - 0.02).toFixed(3);
    delete g._cine;
  }
}
export function stabilizeClips(list, level = 'medium') {
  let n = 0;
  for (const c of list) if (c.type === 'video') { if (level) c.stabilize = level; else delete c.stabilize; n++; }
  return n;
}
export const stabilizeAll = (p, level = 'medium') => stabilizeClips(pictureClips(p), level);
