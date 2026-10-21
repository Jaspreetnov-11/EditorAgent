// Clip video effects (Premiere's "Video Effects"): clip.effects = [{ id, type, on, p: { param: value } }], applied in
// order to the picture before Motion (position / scale / rotation). One registry for the Effects panel, Effect
// Controls, the viewer (a CSS approximation) and engine/render2.mjs (exact FFmpeg filters).
//   ff(p, ctx)  -> a filter chain (string), or { graph(inLabel, outLabel) } for effects that need several streams
//   css(p)      -> { filter, transform, clip } for live preview (null / missing = shown in Accurate preview only)
// ctx = { W, H } output size in pixels (amounts are given for a 1920-wide frame and scaled).
import { uid } from './model.js';

const n = (v, d) => (Number.isFinite(+v) ? +v : d);
export const VFX = {
  blur: { label: 'Gaussian blur', cat: 'Blur & sharpen', params: { amount: { label: 'Blurriness', min: 0, max: 60, step: 1, def: 12 } },
    ff: (p, { W }) => `gblur=sigma=${Math.max(0.1, (n(p.amount, 12) * W) / 1920 / 2).toFixed(2)}`,
    css: (p, k) => ({ filter: `blur(${((n(p.amount, 12) / 2) * k).toFixed(1)}px)` }) },
  sharpen: { label: 'Sharpen', cat: 'Blur & sharpen', params: { amount: { label: 'Amount', min: 0, max: 3, step: 0.1, def: 1 } },
    ff: (p) => `unsharp=5:5:${n(p.amount, 1).toFixed(2)}:5:5:0`, css: (p) => ({ filter: `contrast(${(1 + n(p.amount, 1) * 0.06).toFixed(3)})` }) },
  bw: { label: 'Black & white', cat: 'Colour', params: { amount: { label: 'Amount', min: 0, max: 1, step: 0.05, def: 1 } },
    ff: (p) => `hue=s=${(1 - n(p.amount, 1)).toFixed(2)}`, css: (p) => ({ filter: `grayscale(${n(p.amount, 1)})` }) },
  sepia: { label: 'Sepia (old photo)', cat: 'Colour', params: { amount: { label: 'Amount', min: 0, max: 1, step: 0.05, def: 0.8 } },
    ff: (p) => { const a = n(p.amount, 0.8), m = (x, y) => (x * a + y * (1 - a)).toFixed(3);
      return `colorchannelmixer=rr=${m(0.393, 1)}:rg=${m(0.769, 0)}:rb=${m(0.189, 0)}:gr=${m(0.349, 0)}:gg=${m(0.686, 1)}:gb=${m(0.168, 0)}:br=${m(0.272, 0)}:bg=${m(0.534, 0)}:bb=${m(0.131, 1)}`; },
    css: (p) => ({ filter: `sepia(${n(p.amount, 0.8)})` }) },
  hue: { label: 'Hue shift', cat: 'Colour', params: { deg: { label: 'Hue', min: -180, max: 180, step: 1, def: 30, unit: '°' } },
    ff: (p) => `hue=h=${n(p.deg, 30)}`, css: (p) => ({ filter: `hue-rotate(${n(p.deg, 30)}deg)` }) },
  invert: { label: 'Invert (negative)', cat: 'Colour', params: {}, ff: () => 'negate', css: () => ({ filter: 'invert(1)' }) },
  glow: { label: 'Glow (dreamy)', cat: 'Stylize', params: { amount: { label: 'Strength', min: 0, max: 1, step: 0.05, def: 0.45 }, radius: { label: 'Radius', min: 2, max: 60, step: 1, def: 20 } },
    ff: (p, { W }) => ({ graph: (a, b) => `[${a}]split[${b}x][${b}y];[${b}y]gblur=sigma=${((n(p.radius, 20) * W) / 1920).toFixed(1)},format=gbrp[${b}g];[${b}x]format=gbrp[${b}o];[${b}o][${b}g]blend=all_mode=screen:all_opacity=${n(p.amount, 0.45).toFixed(2)},format=yuv420p[${b}]` }),
    css: (p) => ({ filter: `brightness(${(1 + n(p.amount, 0.45) * 0.18).toFixed(3)}) saturate(1.08)` }) },
  vignette: { label: 'Vignette', cat: 'Stylize', params: { amount: { label: 'Amount', min: 0, max: 1, step: 0.05, def: 0.5 } },
    ff: (p) => `vignette=angle=${(0.2 + 0.5 * n(p.amount, 0.5)).toFixed(3)}`, css: null },
  grain: { label: 'Film grain', cat: 'Stylize', params: { amount: { label: 'Amount', min: 0, max: 1, step: 0.05, def: 0.4 } },
    ff: (p) => `noise=alls=${Math.round(4 + 20 * n(p.amount, 0.4))}:allf=t`, css: null },
  oldfilm: { label: 'Old film', cat: 'Stylize', params: { amount: { label: 'Amount', min: 0, max: 1, step: 0.05, def: 0.7 } },
    ff: (p) => { const a = n(p.amount, 0.7); return `hue=s=${(1 - 0.7 * a).toFixed(2)},colorchannelmixer=rr=1:gg=${(1 - 0.08 * a).toFixed(3)}:bb=${(1 - 0.22 * a).toFixed(3)},noise=alls=${Math.round(8 + 18 * a)}:allf=t,eq=brightness='0.03*${a.toFixed(2)}*sin(t*37)':eval=frame,vignette=angle=${(0.3 + 0.35 * a).toFixed(2)}`; },
    css: (p) => ({ filter: `sepia(${(0.5 * n(p.amount, 0.7)).toFixed(2)}) contrast(1.05)` }) },
  rgbsplit: { label: 'RGB split', cat: 'Stylize', params: { amount: { label: 'Offset', min: 0, max: 40, step: 1, def: 8, unit: 'px' } },
    ff: (p, { W }) => { const o = Math.max(1, Math.round((n(p.amount, 8) * W) / 1920)); return `rgbashift=rh=${o}:bh=-${o}`; }, css: null },
  pixelate: { label: 'Pixelate (mosaic)', cat: 'Stylize', params: { size: { label: 'Block size', min: 4, max: 80, step: 1, def: 24, unit: 'px' } },
    ff: (p, { W, H }) => { const s = Math.max(2, Math.round((n(p.size, 24) * W) / 1920)); return `scale=${Math.max(2, Math.round(W / s))}:${Math.max(2, Math.round(H / s))},scale=${W}:${H}:flags=neighbor`; }, css: null },
  fliph: { label: 'Flip horizontal', cat: 'Transform', params: {}, ff: () => 'hflip', css: () => ({ transform: 'scaleX(-1)' }) },
  flipv: { label: 'Flip vertical', cat: 'Transform', params: {}, ff: () => 'vflip', css: () => ({ transform: 'scaleY(-1)' }) },
  mirror: { label: 'Mirror (left half)', cat: 'Transform', params: {},
    ff: () => ({ graph: (a, b) => `[${a}]split[${b}l][${b}m];[${b}m]crop=iw/2:ih:0:0,hflip[${b}r];[${b}l][${b}r]overlay=W/2:0[${b}]` }), css: null },
  crop: { label: 'Crop', cat: 'Transform', params: { left: { label: 'Left', min: 0, max: 45, step: 0.5, def: 0, unit: '%' }, right: { label: 'Right', min: 0, max: 45, step: 0.5, def: 0, unit: '%' }, top: { label: 'Top', min: 0, max: 45, step: 0.5, def: 0, unit: '%' }, bottom: { label: 'Bottom', min: 0, max: 45, step: 0.5, def: 0, unit: '%' } },
    // cropped edges go black (on V2 they are black bars over the shot below)
    ff: (p) => { const e = (k) => n(p[k], 0) / 100, f = [];
      if (e('left')) f.push(`drawbox=x=0:y=0:w=iw*${e('left')}:h=ih:color=black:t=fill`);
      if (e('right')) f.push(`drawbox=x=iw*${(1 - e('right')).toFixed(4)}:y=0:w=iw*${e('right')}:h=ih:color=black:t=fill`);
      if (e('top')) f.push(`drawbox=x=0:y=0:w=iw:h=ih*${e('top')}:color=black:t=fill`);
      if (e('bottom')) f.push(`drawbox=x=0:y=ih*${(1 - e('bottom')).toFixed(4)}:w=iw:h=ih*${e('bottom')}:color=black:t=fill`);
      return f.join(',') || 'null'; },
    css: (p) => ({ clip: `inset(${n(p.top, 0)}% ${n(p.right, 0)}% ${n(p.bottom, 0)}% ${n(p.left, 0)}%)` }) },
  // Premiere's Warp Stabilizer, made with vid.stab (two passes in render2.mjs: analyse the shake, then move / scale the
  // picture). vid.stab moves, turns and zooms the whole frame, so Perspective and Subspace Warp work like Position, Scale,
  // Rotation; "Synthesize Edges" fills the uncovered edges from the frames before. Seen in Accurate preview and renders.
  warpstab: { label: 'Warp Stabilizer', cat: 'Distort', stab: true,
    params: {
      result: { label: 'Result', type: 'select', def: 'smooth', options: [['smooth', 'Smooth Motion'], ['nomotion', 'No Motion']] },
      smoothness: { label: 'Smoothness', min: 1, max: 100, step: 1, def: 50, unit: '%' },
      method: { label: 'Method', type: 'select', def: 'warp', options: [['warp', 'Subspace Warp'], ['perspective', 'Perspective'], ['psr', 'Position, Scale, Rotation'], ['position', 'Position']] },
      framing: { label: 'Framing', type: 'select', def: 'cropscale', options: [['cropscale', 'Stabilize, Crop, Auto-scale'], ['stabilize', 'Stabilize Only'], ['crop', 'Stabilize, Crop'], ['synth', 'Stabilize, Synthesize Edges']] },
      addscale: { label: 'Additional Scale', min: 100, max: 150, step: 1, def: 100, unit: '%' },
      detail: { label: 'Detailed Analysis', type: 'select', def: 'off', options: [['off', 'Off (faster)'], ['on', 'On (more exact, slower)']] },
    },
    ff: () => 'null', css: null },
  chromakey: { label: 'Green screen (chroma key)', cat: 'Keying', v2only: true,
    params: { color: { label: 'Key colour', type: 'color', def: '#00ff00' }, similarity: { label: 'Similarity', min: 0.01, max: 0.5, step: 0.01, def: 0.15 }, blend: { label: 'Edge softness', min: 0, max: 0.3, step: 0.01, def: 0.05 } },
    // applied in the final pass, where the overlay keeps its transparency (render2.mjs)
    ff: () => 'null', key: (p) => `chromakey=${String(p.color || '#00ff00').replace('#', '0x')}:${n(p.similarity, 0.15)}:${n(p.blend, 0.05)}`, css: null },
};
export const VFX_CATS = [...new Set(Object.values(VFX).map((x) => x.cat))];
export const defaultsOf = (type) => Object.fromEntries(Object.entries(VFX[type]?.params || {}).map(([k, d]) => [k, d.def]));
export const newEffect = (type) => ({ id: uid(), type, on: true, p: defaultsOf(type) });
export const activeEffects = (c) => (c?.effects || []).filter((e) => e.on !== false && VFX[e.type]);

// live preview: the combined CSS of a clip's effects; k = viewer px per 1920-wide output px
export function effectsCss(c, k = 0.3) {
  const f = [], t = [];
  let clip = '';
  for (const e of activeEffects(c)) {
    const r = VFX[e.type].css?.(e.p || {}, k);
    if (!r) continue;
    if (r.filter) f.push(r.filter);
    if (r.transform) t.push(r.transform);
    if (r.clip) clip = r.clip;
  }
  return { filter: f.join(' '), transform: t.join(' '), clip };
}
