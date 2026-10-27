// Clip video effects (Premiere's "Video Effects"): clip.effects = [{ id, type, on, p: { param: value } }], applied in
// order to the picture before Motion (position / scale / rotation). One registry for the Effects panel, Effect
// Controls, the viewer (a CSS approximation) and engine/render2.mjs (exact FFmpeg filters).
//   ff(p, ctx)  -> a filter chain (string), or { graph(inLabel, outLabel) } for effects that need several streams
//   css(p)      -> { filter, transform, clip } for live preview (null / missing = shown in Accurate preview only)
// ctx = { W, H } output size in pixels (amounts are given for a 1920-wide frame and scaled).
import { uid } from './model.js';
import { FILM_PARAMS, filmGraph, filmCss } from './film.js';
import { VFX_PIC } from './vfxfx.js'; // 💥 the VFX page's picture effects (heat haze, shockwave, glitch, hologram, keys, AI sky / fog / depth)

const n = (v, d) => (Number.isFinite(+v) ? +v : d);
// 🖥 live looks that CSS alone cannot do are SVG filters, added once to the page (only in the browser; the render uses FFmpeg)
const svgFx = (id, body) => {
  if (typeof document === 'undefined') return '';
  let defs = document.getElementById('vfxDefs');
  if (!defs) { defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); defs.id = 'vfxDefs'; defs.setAttribute('width', '0'); defs.setAttribute('height', '0'); defs.style.position = 'absolute'; document.body.append(defs); }
  if (!document.getElementById(id)) defs.insertAdjacentHTML('beforeend', `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${body}</filter>`);
  return `url(#${id})`;
};
// film grain as a small noise picture tiled over the shot; a = how strong (0..1)
export const grainCss = (a) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 ${(0.12 + 0.5 * a).toFixed(2)} 0'/></filter><rect width='100%' height='100%' filter='url(#g)'/></svg>`)}")`;
// perspective fills what falls outside the picture with its edge pixels (a smear): a thin black border first, so the
// uncovered part is black, as in Premiere
const PERSP_IN = 'pad=iw+4:ih+4:2:2:color=black,', PERSP_OUT = ',crop=iw-4:ih-4:2:2';
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
    ff: (p) => `vignette=angle=${(0.2 + 0.5 * n(p.amount, 0.5)).toFixed(3)}`,
    // live: darker edges drawn over the picture (the render's vignette filter is the exact one)
    css: (p) => { const a = n(p.amount, 0.5); return { overlay: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${Math.round(68 - 38 * a)}%, rgba(0,0,0,${(0.3 + 0.6 * a).toFixed(2)}) 100%)` }; } },
  grain: { label: 'Film grain', cat: 'Stylize', params: { amount: { label: 'Amount', min: 0, max: 1, step: 0.05, def: 0.4 } },
    ff: (p) => `noise=alls=${Math.round(4 + 20 * n(p.amount, 0.4))}:allf=t`, css: (p) => ({ overlay: grainCss(n(p.amount, 0.4)), grain: true }) },
  // 🎞 Limelight Film (film.js): print look, halation, bloom, grain in the midtones, vignette, gate weave, flicker
  film: { label: 'Limelight Film', cat: 'Stylize', params: FILM_PARAMS, ff: (p, ctx) => filmGraph(p, ctx), css: (p) => filmCss(p, grainCss) },
  oldfilm: { label: 'Old film', cat: 'Stylize', params: { amount: { label: 'Amount', min: 0, max: 1, step: 0.05, def: 0.7 } },
    ff: (p) => { const a = n(p.amount, 0.7); return `hue=s=${(1 - 0.7 * a).toFixed(2)},colorchannelmixer=rr=1:gg=${(1 - 0.08 * a).toFixed(3)}:bb=${(1 - 0.22 * a).toFixed(3)},noise=alls=${Math.round(8 + 18 * a)}:allf=t,eq=brightness='0.03*${a.toFixed(2)}*sin(t*37)':eval=frame,vignette=angle=${(0.3 + 0.35 * a).toFixed(2)}`; },
    css: (p) => ({ filter: `sepia(${(0.5 * n(p.amount, 0.7)).toFixed(2)}) contrast(1.05)` }) },
  rgbsplit: { label: 'RGB split', cat: 'Stylize', params: { amount: { label: 'Offset', min: 0, max: 40, step: 1, def: 8, unit: 'px' } },
    ff: (p, { W }) => { const o = Math.max(1, Math.round((n(p.amount, 8) * W) / 1920)); return `rgbashift=rh=${o}:bh=-${o}`; },
    // live: red moved right, blue left (an SVG filter per offset in viewer px)
    css: (p, k) => { const o = Math.max(1, Math.round(n(p.amount, 8) * k)); return { filter: svgFx(`vfx-rgb-${o}`, `<feColorMatrix in="SourceGraphic" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/><feOffset in="r" dx="${o}" result="r2"/><feColorMatrix in="SourceGraphic" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="g"/><feColorMatrix in="SourceGraphic" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="b"/><feOffset in="b" dx="${-o}" result="b2"/><feBlend in="r2" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b2" mode="screen"/>`) }; } },
  pixelate: { label: 'Pixelate (mosaic)', cat: 'Stylize', params: { size: { label: 'Block size', min: 4, max: 80, step: 1, def: 24, unit: 'px' } },
    ff: (p, { W, H }) => { const s = Math.max(2, Math.round((n(p.size, 24) * W) / 1920)); return `scale=${Math.max(2, Math.round(W / s))}:${Math.max(2, Math.round(H / s))},scale=${W}:${H}:flags=neighbor`; },
    // live: the classic SVG mosaic (a dot per block, grown to fill it)
    css: (p, k) => { const s = Math.max(2, Math.round(n(p.size, 24) * k)), h = Math.max(1, Math.floor(s / 2)); return { filter: svgFx(`vfx-px-${s}`, `<feFlood x="${h}" y="${h}" width="1" height="1"/><feComposite width="${s}" height="${s}"/><feTile result="a"/><feComposite in="SourceGraphic" in2="a" operator="in"/><feMorphology operator="dilate" radius="${h}"/>`) }; } },
  fliph: { label: 'Flip horizontal', cat: 'Transform', params: {}, ff: () => 'hflip', css: () => ({ transform: 'scaleX(-1)' }) },
  flipv: { label: 'Flip vertical', cat: 'Transform', params: {}, ff: () => 'vflip', css: () => ({ transform: 'scaleY(-1)' }) },
  mirror: { label: 'Mirror (left half)', cat: 'Transform', params: {},
    ff: () => ({ graph: (a, b) => `[${a}]split[${b}l][${b}m];[${b}m]crop=iw/2:ih:0:0,hflip[${b}r];[${b}l][${b}r]overlay=W/2:0[${b}]` }),
    css: () => ({}) }, // (live: the viewer draws it on a canvas - player.js pixFx)
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
  // ---- more of Premiere's Video Effects (Phase: Premiere parity). No css: shown in Accurate preview and the render. ----
  bricon: { label: 'Brightness & Contrast', cat: 'Colour', params: { bright: { label: 'Brightness', min: -100, max: 100, step: 1, def: 0 }, contrast: { label: 'Contrast', min: -100, max: 100, step: 1, def: 0 } },
    ff: (p) => `eq=brightness=${(n(p.bright, 0) / 250).toFixed(3)}:contrast=${(1 + n(p.contrast, 0) / 100).toFixed(3)}`,
    css: (p) => ({ filter: `brightness(${(1 + n(p.bright, 0) / 250).toFixed(3)}) contrast(${(1 + n(p.contrast, 0) / 100).toFixed(3)})` }) },
  tint: { label: 'Tint', cat: 'Colour', params: { hue: { label: 'Tint colour (hue)', min: 0, max: 360, step: 1, def: 30, unit: '°' }, amount: { label: 'Amount', min: 0, max: 1, step: 0.05, def: 0.6 } },
    ff: (p) => `colorize=hue=${n(p.hue, 30)}:saturation=0.45:lightness=0.5:mix=${n(p.amount, 0.6).toFixed(2)}`,
    css: (p) => ({ filter: `sepia(${n(p.amount, 0.6).toFixed(2)}) hue-rotate(${(n(p.hue, 30) - 38).toFixed(0)}deg)` }) },
  leavecolor: { label: 'Leave Color', cat: 'Colour', params: { color: { label: 'Colour to keep', type: 'color', def: '#d62828' }, similarity: { label: 'Match', min: 0.02, max: 0.6, step: 0.01, def: 0.25 }, blend: { label: 'Softness', min: 0, max: 0.5, step: 0.01, def: 0.1 } },
    ff: (p) => `colorhold=color=${String(p.color || '#d62828').replace('#', '0x')}:similarity=${n(p.similarity, 0.25)}:blend=${n(p.blend, 0.1)}` },
  dblur: { label: 'Directional blur', cat: 'Blur & sharpen', params: { angle: { label: 'Direction', min: 0, max: 360, step: 1, def: 0, unit: '°' }, length: { label: 'Blur length', min: 0, max: 80, step: 1, def: 20 } },
    ff: (p, { W }) => `dblur=angle=${n(p.angle, 0)}:radius=${Math.max(1, Math.round((n(p.length, 20) * W) / 1920))}`,
    css: (p, k) => ({ filter: `blur(${((n(p.length, 20) / 6) * k).toFixed(1)}px)` }) },
  lens: { label: 'Lens distortion', cat: 'Distort', params: { curve: { label: 'Curvature', min: -100, max: 100, step: 1, def: -30 } },
    ff: (p) => `lenscorrection=k1=${(n(p.curve, -30) / 100 * 0.6).toFixed(3)}:k2=${(n(p.curve, -30) / 100 * 0.15).toFixed(3)}` },
  basic3d: { label: 'Basic 3D', cat: 'Distort', params: { swivel: { label: 'Swivel (turn left / right)', min: -80, max: 80, step: 1, def: 25, unit: '°' }, tilt: { label: 'Tilt (lean back / forward)', min: -80, max: 80, step: 1, def: 0, unit: '°' } },
    // the frame turned in 3D and seen from 1.6 frame-widths away; its four corners are where perspective puts them
    ff: (p, { W, H }) => {
      const a = (n(p.swivel, 25) * Math.PI) / 180, b = (n(p.tilt, 0) * Math.PI) / 180, f = W * 1.6;
      const pt = (x, y) => { const x1 = x * Math.cos(a), z1 = -x * Math.sin(a), y2 = y * Math.cos(b) - z1 * Math.sin(b), z2 = y * Math.sin(b) + z1 * Math.cos(b), s = f / (f + z2);
        return [`W*${((W / 2 + x1 * s) / W).toFixed(5)}`, `H*${((H / 2 + y2 * s) / H).toFixed(5)}`]; };
      // (as parts of the picture's own W / H: the effect runs on the file's frames, whatever their size)
      const c = [pt(-W / 2, -H / 2), pt(W / 2, -H / 2), pt(-W / 2, H / 2), pt(W / 2, H / 2)].flat();
      return `${PERSP_IN}perspective=${c.join(':')}:sense=destination${PERSP_OUT}`;
    },
    css: (p, k) => ({ transform: `perspective(${Math.round(1920 * 1.6 * k)}px) rotateY(${n(p.swivel, 25)}deg) rotateX(${-n(p.tilt, 0)}deg)` }) },
  cornerpin: { label: 'Corner pin', cat: 'Distort',
    params: Object.fromEntries(['tl', 'tr', 'bl', 'br'].flatMap((c) => [[`${c}x`, { label: `${{ tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' }[c]} - across`, min: -50, max: 50, step: 0.5, def: 0, unit: '%' }], [`${c}y`, { label: `${{ tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' }[c]} - down`, min: -50, max: 50, step: 0.5, def: 0, unit: '%' }]])),
    // (corners as parts of the picture's own W / H - the effect runs on the file's frames, whatever their size)
    ff: (p) => { const X = (k, base) => `W*${(base + n(p[k], 0) / 100).toFixed(4)}`, Y = (k, base) => `H*${(base + n(p[k], 0) / 100).toFixed(4)}`;
      return `${PERSP_IN}perspective=${X('tlx', 0)}:${Y('tly', 0)}:${X('trx', 1)}:${Y('try', 0)}:${X('blx', 0)}:${Y('bly', 1)}:${X('brx', 1)}:${Y('bry', 1)}:sense=destination${PERSP_OUT}`; } },
  wave: { label: 'Wave warp', cat: 'Distort', params: { height: { label: 'Wave height', min: 0, max: 60, step: 1, def: 12, unit: 'px' }, width: { label: 'Wave width', min: 20, max: 600, step: 5, def: 160, unit: 'px' }, speed: { label: 'Speed', min: 0, max: 10, step: 0.5, def: 2 } },
    ff: (p, { W }) => { const k = W / 1920, A = (n(p.height, 12) * k).toFixed(1), L = (n(p.width, 160) * k).toFixed(1), sp = n(p.speed, 2), e = `p(X+${A}*sin(2*PI*Y/${L}+T*${sp}),Y)`;
      return `format=yuv444p,geq=lum='${e}':cb='${e}':cr='${e}'`; } },
  offset: { label: 'Offset (shift and wrap)', cat: 'Distort', params: { x: { label: 'Shift across', min: -100, max: 100, step: 1, def: 25, unit: '%' }, y: { label: 'Shift down', min: -100, max: 100, step: 1, def: 0, unit: '%' } },
    ff: (p) => { const e = `p(mod(X+W*${(n(p.x, 25) / 100).toFixed(3)}+W,W),mod(Y+H*${(n(p.y, 0) / 100).toFixed(3)}+H,H))`; return `format=yuv444p,geq=lum='${e}':cb='${e}':cr='${e}'`; } },
  echo: { label: 'Echo (trails)', cat: 'Time', params: { frames: { label: 'Echoes', min: 2, max: 8, step: 1, def: 4 }, decay: { label: 'Decay', min: 0.1, max: 0.95, step: 0.05, def: 0.6 } },
    ff: (p) => { const N = Math.round(n(p.frames, 4)), d = n(p.decay, 0.6); return `tmix=frames=${N}:weights='${Array.from({ length: N }, (_, i) => (d ** (N - 1 - i)).toFixed(3)).join(' ')}'`; } },
  posterizetime: { label: 'Posterize time (choppy)', cat: 'Time', params: { rate: { label: 'Frames a second', min: 2, max: 24, step: 1, def: 8 } },
    ff: (p) => `fps=${Math.round(n(p.rate, 8))}` },
  strobe: { label: 'Strobe light', cat: 'Stylize', params: { every: { label: 'Every (s)', min: 0.1, max: 2, step: 0.05, def: 0.4 }, on: { label: 'Flash length', min: 0.1, max: 0.9, step: 0.05, def: 0.25 }, color: { label: 'Colour', type: 'color', def: '#ffffff' }, amount: { label: 'Strength', min: 0.1, max: 1, step: 0.05, def: 0.6 } },
    ff: (p) => { const P = n(p.every, 0.4); return `drawbox=x=0:y=0:w=iw:h=ih:t=fill:color=${String(p.color || '#ffffff').replace('#', '0x')}@${n(p.amount, 0.6).toFixed(2)}:enable='lt(mod(t,${P}),${(P * n(p.on, 0.25)).toFixed(3)})'`; } },
  chromakey: { label: 'Green screen (chroma key)', cat: 'Keying', v2only: true,
    params: { color: { label: 'Key colour', type: 'color', def: '#00ff00' }, similarity: { label: 'Similarity', min: 0.01, max: 0.5, step: 0.01, def: 0.15 }, blend: { label: 'Edge softness', min: 0, max: 0.3, step: 0.01, def: 0.05 } },
    // applied in the final pass, where the overlay keeps its transparency (render2.mjs)
    ff: () => 'null', key: (p) => `chromakey=${String(p.color || '#00ff00').replace('#', '0x')}:${n(p.similarity, 0.15)}:${n(p.blend, 0.05)}`,
    css: () => ({}) }, // (live: keyed on a canvas by the viewer - player.js pixFx)
};

// ---- the rest of Premiere's Video Effects (engine/premiere-effects-gap.md), in Premiere's folders ----
// Written with p already holding every parameter (withDefaults below fills the missing ones and makes numbers numbers).
// pix(g, W, H, p, info) -> draws the live look into the viewer's canvas (player.js pixFx; info = { cv, rel, fps, name })
// key(p) -> like Green screen: a keying filter for the final pass (V2 overlays only)
// reads: the live drawing reads the pixels back (the viewer keeps that canvas small)
const hex6 = (c, d = '#ffffff') => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d).slice(1);
const hx = (c) => `0x${hex6(c)}`;
const rgbOf = (c) => { const v = parseInt(hex6(c), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
const rgba = (c, a) => `rgba(${rgbOf(c).join(',')},${(+a).toFixed(3)})`;
const f4 = (x) => (+x).toFixed(4);
const fid = (k, ...v) => `vfx-${k}-${v.map((x) => String(x).replace(/[^0-9a-z]/gi, '_')).join('-')}`;
// 🖥 SVG component-transfer stages, one function per colour channel ('R' / 'G' / 'B' -> the feFunc attributes)
const svgCt = (id, ...stages) => svgFx(id, stages.map((s) => (typeof s === 'string' ? s : `<feComponentTransfer>${['R', 'G', 'B'].map((c) => `<feFunc${c} ${s(c)}/>`).join('')}</feComponentTransfer>`)).join(''));
// a curve 0..1 -> 0..1 as an SVG table (sampled at n points)
const tbl = (f, n = 33) => `type="table" tableValues="${Array.from({ length: n }, (_, i) => Math.min(1, Math.max(0, f(i / (n - 1)))).toFixed(3)).join(' ')}"`;
// FFmpeg pixel moves: e = the expression of the source pixel, p(x, y), for every plane (planes the same size)
const warp = (e) => `format=yuv444p,geq=lum='${e}':cb='${e}':cr='${e}'`;
// the picture faded towards black where k (0..1, an expression) is below 1
const shade = (k) => `format=yuv444p,geq=lum='16+(p(X,Y)-16)*(${k})':cb='128+(p(X,Y)-128)*(${k})':cr='128+(p(X,Y)-128)*(${k})'`;
// per RGB channel: e(ch, value 0..255 of the colour c) -> the expression of the new value
const rgbGeq = (e) => `format=gbrp,geq=r='${e('r', 0)}':g='${e('g', 1)}':b='${e('b', 2)}',format=yuv420p`;
// a colour laid over the picture with coverage a (an expression 0..1): ch(X,Y) mixed towards the colour
const paint = (col, a) => { const c = rgbOf(col); return rgbGeq((ch, i) => `st(0,${a});${ch}(X,Y)*(1-ld(0))+${c[i]}*ld(0)`); };
const lutAll = (e) => `lutrgb=r='${e}':g='${e}':b='${e}'`;
const lumOf = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1)), h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function hsl2rgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2, k = Math.floor(((h % 360) + 360) % 360 / 60);
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][k] || [c, x, 0];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
// 🖥 live recolouring of the pixels near one colour (Change Color, Change to Color, Color Replace), as FFmpeg's colorkey
// measures it: distance in RGB / (255 * sqrt 3); match below sim, fading out over soft
function recolorPix(g, W, H, from, sim, soft, fn) {
  const [kr, kg, kb] = rgbOf(from), im = g.getImageData(0, 0, W, H), d = im.data, bl = Math.max(0.001, soft);
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.sqrt((d[i] - kr) ** 2 + (d[i + 1] - kg) ** 2 + (d[i + 2] - kb) ** 2) / 441.7;
    const m = dist < sim ? 1 : dist < sim + bl ? 1 - (dist - sim) / bl : 0;
    if (!m) continue;
    const [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]), o = hsl2rgb(...fn(h, s, l));
    for (let j = 0; j < 3; j++) d[i + j] = d[i + j] * (1 - m) + o[j] * m;
  }
  g.putImageData(im, 0, 0);
}
// the matching pixels (colorkey on a copy of the picture) show a changed copy (alt) - the rest stays as it was
const recolor = (from, sim, soft, alt) => ({ graph: (a, b) => `[${a}]split[${b}o][${b}c];[${b}c]${alt},format=yuv420p[${b}n];[${b}o]format=rgba,colorkey=${hx(from)}:${f4(Math.max(0.01, sim))}:${f4(soft)}[${b}k];[${b}n][${b}k]overlay=format=auto,format=yuv420p[${b}]` });
let focusCanvas = null; // (🎯 Focus Blur's live blurred copy)
const XY = { x: { label: 'Centre across', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, y: { label: 'Centre down', min: 0, max: 100, step: 0.5, def: 50, unit: '%' } };
const OPA = { label: 'Opacity', min: 0, max: 1, step: 0.05, def: 1 };
const SEL = (label, options, def) => ({ label, type: 'select', options, def });
const tmpCanvas = () => (tmpCanvas.c ||= document.createElement('canvas'));
// emboss: a 3x3 kernel that takes the difference across the light's direction (integers, as FFmpeg's convolution wants)
const embossK = (deg, relief, centre) => { const a = (deg * Math.PI) / 180, k = [];
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) k.push(i || j ? Math.round(-(i * Math.cos(a) - j * Math.sin(a)) * relief) : centre);
  return k; };
// the timecode of the source at t seconds into the clip, as drawtext's text expansion writes it (HH:MM:SS:FF)
const tcText = (inS, sp, F) => { const T = `(t*${f4(sp)}+${f4(inS)})`; return `%{eif:floor(${T}/3600):d:2}:%{eif:mod(floor(${T}/60),60):d:2}:%{eif:mod(floor(${T}),60):d:2}:%{eif:mod(floor(${T}*${F}),${F}):d:2}`; };
const tcAt = (s, F) => { const f = Math.floor(s * F + 1e-6), p2 = (v) => String(v).padStart(2, '0'); return `${p2(Math.floor(f / F / 3600))}:${p2(Math.floor(f / F / 60) % 60)}:${p2(Math.floor(f / F) % 60)}:${p2(f % F)}`; };
// Premiere's Blend modes (the Blend effect) - FFmpeg's blend modes; 'colour' = this layer's colour on the brightness below
const BLENDS = [['crossfade', 'Crossfade'], ['colour', 'Color only'], ['tint', 'Tint only'], ['darken', 'Darken only'], ['lighten', 'Lighten only'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['difference', 'Difference']];
const TXT_POS = [['bc', 'Bottom centre'], ['bl', 'Bottom left'], ['br', 'Bottom right'], ['tc', 'Top centre'], ['tl', 'Top left'], ['tr', 'Top right'], ['c', 'Centre']];
const txtXY = (pos, m) => [pos.endsWith('l') ? `${m}` : pos.endsWith('r') ? `w-tw-${m}` : '(w-tw)/2', pos[0] === 't' ? `${m}` : pos[0] === 'b' ? `h-th-${m}` : '(h-th)/2'];
// burnt-in text (Timecode, Clip Name): drawtext with the render's own font and a text file (no escaping of : in the graph)
function burnText(text, p, { W, font, textfile }, expand = false) {
  if (!font || !textfile) return 'null';
  const fs = Math.round((p.size * W) / 1920), [x, y] = txtXY(p.pos, Math.round(fs * 0.6));
  return `drawtext=fontfile=${font()}:textfile=${textfile(text)}${expand ? '' : ':expansion=none'}:fontsize=${fs}:fontcolor=white:box=1:boxcolor=black@${f4(p.bg)}:boxborderw=${Math.round(fs * 0.25)}:x=${x}:y=${y}`;
}
function burnPix(g, W, text, p) {
  const fs = Math.max(6, (p.size * W) / 1920), m = fs * 0.6;
  g.save(); g.font = `${Math.round(fs)}px Consolas, monospace`; g.textBaseline = 'top';
  const tw = g.measureText(text).width, b = fs * 0.25, H = g.canvas.height;
  const x = p.pos.endsWith('l') ? m : p.pos.endsWith('r') ? W - tw - m : (W - tw) / 2, y = p.pos[0] === 't' ? m : p.pos[0] === 'b' ? H - fs - m : (H - fs) / 2;
  g.fillStyle = `rgba(0,0,0,${p.bg})`; g.fillRect(x - b, y - b, tw + 2 * b, fs + 2 * b); g.fillStyle = '#fff'; g.fillText(text, x, y); g.restore();
}

const MORE = {
  // ---------- Adjust ----------
  levels: { label: 'Levels', cat: 'Adjust', params: { ib: { label: 'Input black', min: 0, max: 254, step: 1, def: 0 }, iw: { label: 'Input white', min: 1, max: 255, step: 1, def: 255 }, gamma: { label: 'Gamma', min: 0.1, max: 5, step: 0.05, def: 1 }, ob: { label: 'Output black', min: 0, max: 255, step: 1, def: 0 }, ow: { label: 'Output white', min: 0, max: 255, step: 1, def: 255 } },
    ff: (p) => lutAll(`clip(${p.ob}+${p.ow - p.ob}*pow(clip((val-${p.ib})/${Math.max(1, p.iw - p.ib)},0,1),${f4(1 / p.gamma)}),0,255)`),
    css: (p) => ({ filter: svgCt(fid('lv', p.ib, p.iw, p.gamma, p.ob, p.ow), () => `type="linear" slope="${f4(255 / Math.max(1, p.iw - p.ib))}" intercept="${f4(-p.ib / Math.max(1, p.iw - p.ib))}"`, () => `type="gamma" amplitude="1" exponent="${f4(1 / p.gamma)}" offset="0"`, () => `type="linear" slope="${f4((p.ow - p.ob) / 255)}" intercept="${f4(p.ob / 255)}"`) }) },
  procamp: { label: 'ProcAmp', cat: 'Adjust', params: { bright: { label: 'Brightness', min: -100, max: 100, step: 1, def: 0 }, contrast: { label: 'Contrast', min: 0, max: 200, step: 1, def: 100 }, hue: { label: 'Hue', min: -180, max: 180, step: 1, def: 0, unit: '°' }, sat: { label: 'Saturation', min: 0, max: 200, step: 1, def: 100 } },
    ff: (p) => `eq=brightness=${f4(p.bright / 250)}:contrast=${f4(p.contrast / 100)}:saturation=${f4(p.sat / 100)}${p.hue ? `,hue=h=${p.hue}` : ''}`,
    css: (p) => ({ filter: `brightness(${f4(1 + p.bright / 250)}) contrast(${f4(p.contrast / 100)}) saturate(${f4(p.sat / 100)}) hue-rotate(${p.hue}deg)` }) },
  extract: { label: 'Extract', cat: 'Adjust', params: { black: { label: 'Black input level', min: 0, max: 255, step: 1, def: 0 }, white: { label: 'White input level', min: 0, max: 255, step: 1, def: 255 }, soft: { label: 'Softness', min: 0, max: 100, step: 1, def: 0 }, invert: SEL('Invert', [['off', 'Off'], ['on', 'On']], 'off') },
    // the brightness band black..white goes white, the rest black (softness ramps the edges)
    ff: (p) => { const s = Math.max(1, p.soft * 2.55), e = `255*clip(min((val-${p.black})/${f4(s)}+1,(${p.white}-val)/${f4(s)}+1),0,1)`; return `lutyuv=y='${p.invert === 'on' ? `255-${e}` : e}':u=128:v=128`; },
    css: (p) => { const s = Math.max(1, p.soft * 2.55), f = (x) => { const v = Math.min(1, Math.max(0, Math.min((x * 255 - p.black) / s + 1, (p.white - x * 255) / s + 1))); return p.invert === 'on' ? 1 - v : v; };
      return { filter: svgCt(fid('ex', p.black, p.white, p.soft, p.invert), '<feColorMatrix type="saturate" values="0"/>', () => tbl(f, 65)) }; } },
  lighting: { label: 'Lighting Effects', cat: 'Adjust', params: { ...XY, x: { ...XY.x, def: 40 }, y: { ...XY.y, def: 35 }, radius: { label: 'Radius', min: 5, max: 150, step: 1, def: 60, unit: '%' }, intensity: { label: 'Intensity', min: 0, max: 2, step: 0.05, def: 1 }, ambient: { label: 'Ambience', min: 0, max: 1, step: 0.05, def: 0.25 }, color: { label: 'Light colour', type: 'color', def: '#fff4e0' } },
    // one spotlight (Omni): light falls off from the centre; ambience lights the rest
    ff: (p) => { const c = rgbOf(p.color); return rgbGeq((ch, i) => `clip(${ch}(X,Y)*(${f4(p.ambient)}+${f4(p.intensity)}*max(0,1-pow(hypot(X-W*${f4(p.x / 100)},Y-H*${f4(p.y / 100)})/(W*${f4(p.radius / 100)}),2)))*${f4(c[i] / 255)},0,255)`); },
    css: (p) => ({ overlay: `radial-gradient(circle at ${p.x}% ${p.y}%, ${rgba(p.color, Math.max(0, p.intensity - 1) * 0.3)} 0%, rgba(0,0,0,0) ${(p.radius * 0.35).toFixed(1)}%, rgba(0,0,0,${f4(Math.min(0.95, 1 - p.ambient))}) ${(p.radius * 0.75).toFixed(1)}%)` }) },
  autolevels: { label: 'Auto Levels / Contrast / Color', cat: 'Adjust', params: { mode: SEL('Mode', [['levels', 'Auto Levels'], ['contrast', 'Auto Contrast'], ['color', 'Auto Color']], 'levels'), smooth: { label: 'Temporal smoothing (frames)', min: 0, max: 60, step: 1, def: 10 }, blend: { label: 'Blend with original', min: 0, max: 1, step: 0.05, def: 0 } },
    ff: (p) => `normalize=smoothing=${Math.round(p.smooth)}:independence=${p.mode === 'contrast' ? 0 : 1}:strength=${f4(1 - p.blend)}` },

  // ---------- Blur & sharpen ----------
  unsharp: { label: 'Unsharp Mask', cat: 'Blur & sharpen', params: { amount: { label: 'Amount', min: 0, max: 250, step: 1, def: 50, unit: '%' }, radius: { label: 'Radius', min: 1, max: 11, step: 1, def: 2, unit: 'px' } },
    ff: (p, { W }) => { const s = Math.min(23, Math.max(3, 2 * Math.round((p.radius * W) / 1920) + 1)); return `unsharp=${s}:${s}:${f4(Math.min(5, p.amount / 50))}:${s}:${s}:0`; },
    css: (p) => ({ filter: `contrast(${f4(1 + p.amount / 1500)})` }) },
  flicker: { label: 'Reduce Interlace Flicker', cat: 'Blur & sharpen', params: { soft: { label: 'Softness', min: 0.1, max: 10, step: 0.1, def: 1 } },
    ff: (p, { H }) => `gblur=sigma=0.01:sigmaV=${f4((p.soft * H) / 1080)}`, css: (p, k) => ({ filter: `blur(${f4(p.soft * k * 0.3)}px)` }) },

  // ---------- Channel ----------
  solidcomp: { label: 'Solid Composite', cat: 'Channel', params: { color: { label: 'Colour', type: 'color', def: '#ff8a00' }, opacity: { ...OPA, def: 0.5 } },
    ff: (p) => `drawbox=x=0:y=0:w=iw:h=ih:t=fill:color=${hx(p.color)}@${f4(p.opacity)}`, css: (p) => ({ overlay: `linear-gradient(${rgba(p.color, p.opacity)}, ${rgba(p.color, p.opacity)})` }) },
  arith: { label: 'Arithmetic', cat: 'Channel', params: { op: SEL('Operator', [['add', 'Add'], ['sub', 'Subtract'], ['mul', 'Multiply'], ['min', 'Min'], ['max', 'Max'], ['diff', 'Difference']], 'add'), r: { label: 'Red value', min: 0, max: 255, step: 1, def: 0 }, g: { label: 'Green value', min: 0, max: 255, step: 1, def: 0 }, b: { label: 'Blue value', min: 0, max: 255, step: 1, def: 0 } },
    ff: (p) => { const e = (v) => ({ add: `clip(val+${v},0,255)`, sub: `clip(val-${v},0,255)`, mul: `val*${v}/255`, min: `min(val,${v})`, max: `max(val,${v})`, diff: `abs(val-${v})` })[p.op] || 'val'; return `lutrgb=r='${e(p.r)}':g='${e(p.g)}':b='${e(p.b)}'`; },
    css: (p) => { const f = (v) => (x) => ({ add: x + v, sub: x - v, mul: x * v, min: Math.min(x, v), max: Math.max(x, v), diff: Math.abs(x - v) })[p.op] ?? x, v = { R: p.r / 255, G: p.g / 255, B: p.b / 255 };
      return { filter: svgCt(fid('ar', p.op, p.r, p.g, p.b), (c) => tbl(f(v[c]))) }; } },

  // ---------- Color Correction ----------
  ascdl: { label: 'ASC CDL', cat: 'Color Correction',
    params: { ...Object.fromEntries(['r', 'g', 'b'].flatMap((c) => { const N = { r: 'Red', g: 'Green', b: 'Blue' }[c]; return [[`${c}s`, { label: `${N} slope`, min: 0, max: 4, step: 0.01, def: 1 }], [`${c}o`, { label: `${N} offset`, min: -1, max: 1, step: 0.01, def: 0 }], [`${c}p`, { label: `${N} power`, min: 0.1, max: 4, step: 0.01, def: 1 }]]; })), sat: { label: 'Saturation', min: 0, max: 2, step: 0.01, def: 1 } },
    ff: (p) => { const e = (c) => `255*pow(clip(val/255*${f4(p[`${c}s`])}+${f4(p[`${c}o`])},0,1),${f4(p[`${c}p`])})`; return `lutrgb=r='${e('r')}':g='${e('g')}':b='${e('b')}'${p.sat !== 1 ? `,hue=s=${f4(p.sat)}` : ''}`; },
    css: (p) => { const c = (C) => C.toLowerCase();
      return { filter: svgCt(fid('cdl', ...['r', 'g', 'b'].flatMap((x) => [p[`${x}s`], p[`${x}o`], p[`${x}p`]]), p.sat), (C) => `type="linear" slope="${f4(p[`${c(C)}s`])}" intercept="${f4(p[`${c(C)}o`])}"`, (C) => `type="gamma" amplitude="1" exponent="${f4(p[`${c(C)}p`])}" offset="0"`, `<feColorMatrix type="saturate" values="${f4(p.sat)}"/>`) }; } },
  changecolor: { reads: true, label: 'Change Color', cat: 'Color Correction', params: { color: { label: 'Colour to change', type: 'color', def: '#d62828' }, hue: { label: 'Hue transform', min: -180, max: 180, step: 1, def: 120, unit: '°' }, light: { label: 'Lightness transform', min: -100, max: 100, step: 1, def: 0 }, sat: { label: 'Saturation transform', min: -100, max: 100, step: 1, def: 0 }, match: { label: 'Matching tolerance', min: 0.02, max: 0.6, step: 0.01, def: 0.25 }, soft: { label: 'Matching softness', min: 0, max: 0.5, step: 0.01, def: 0.1 } },
    ff: (p) => recolor(p.color, p.match, p.soft, `hue=h=${p.hue}:s=${f4(1 + p.sat / 100)}:b=${f4(p.light / 10)}`),
    pix: (g, W, H, p) => recolorPix(g, W, H, p.color, p.match, p.soft, (h, s, l) => [h + p.hue, Math.min(1, s * (1 + p.sat / 100)), Math.min(1, Math.max(0, l + p.light / 200))]) },
  changetocolor: { reads: true, label: 'Change to Color', cat: 'Color Correction', params: { from: { label: 'From', type: 'color', def: '#d62828' }, to: { label: 'To', type: 'color', def: '#2a6fdb' }, match: { label: 'Tolerance', min: 0.02, max: 0.6, step: 0.01, def: 0.25 }, soft: { label: 'Softness', min: 0, max: 0.5, step: 0.01, def: 0.1 } },
    // the hue (and saturation) of "from" becomes that of "to"; the shading of the picture stays
    ff: (p) => { const a = rgb2hsl(...rgbOf(p.from)), b = rgb2hsl(...rgbOf(p.to)); return recolor(p.from, p.match, p.soft, `hue=h=${Math.round(b[0] - a[0])}:s=${f4(Math.min(10, b[1] / Math.max(0.05, a[1])))}`); },
    pix: (g, W, H, p) => { const a = rgb2hsl(...rgbOf(p.from)), b = rgb2hsl(...rgbOf(p.to)); recolorPix(g, W, H, p.from, p.match, p.soft, (h, s, l) => [h + b[0] - a[0], Math.min(1, s * Math.min(10, b[1] / Math.max(0.05, a[1]))), l]); } },
  chanmix: { label: 'Channel Mixer', cat: 'Color Correction',
    params: Object.fromEntries(['r', 'g', 'b'].flatMap((o) => ['r', 'g', 'b'].map((i) => [`${o}${i}`, { label: `${{ r: 'Red', g: 'Green', b: 'Blue' }[o]} - ${{ r: 'Red', g: 'Green', b: 'Blue' }[i]}`, min: -200, max: 200, step: 1, def: o === i ? 100 : 0, unit: '%' }]))),
    ff: (p) => `colorchannelmixer=${['r', 'g', 'b'].flatMap((o) => ['r', 'g', 'b'].map((i) => `${o}${i}=${f4(p[`${o}${i}`] / 100)}`)).join(':')}`,
    css: (p) => { const m = ['r', 'g', 'b'].map((o) => `${['r', 'g', 'b'].map((i) => f4(p[`${o}${i}`] / 100)).join(' ')} 0 0`).join(' ');
      return { filter: svgFx(fid('cm', ...['r', 'g', 'b'].flatMap((o) => ['r', 'g', 'b'].map((i) => p[`${o}${i}`]))), `<feColorMatrix type="matrix" values="${m} 0 0 0 1 0"/>`) }; } },
  colorbalance: { label: 'Color Balance', cat: 'Color Correction',
    params: Object.fromEntries(['s', 'm', 'h'].flatMap((t) => ['r', 'g', 'b'].map((c) => [`${c}${t}`, { label: `${{ s: 'Shadow', m: 'Midtone', h: 'Highlight' }[t]} ${{ r: 'red', g: 'green', b: 'blue' }[c]} balance`, min: -100, max: 100, step: 1, def: 0 }]))),
    ff: (p) => `colorbalance=${['s', 'm', 'h'].flatMap((t) => ['r', 'g', 'b'].map((c) => `${c}${t}=${f4(p[`${c}${t}`] / 100)}`)).join(':')}` },
  colorbalancehls: { label: 'Color Balance (HLS)', cat: 'Color Correction', params: { hue: { label: 'Hue', min: -180, max: 180, step: 1, def: 0, unit: '°' }, light: { label: 'Lightness', min: -100, max: 100, step: 1, def: 0 }, sat: { label: 'Saturation', min: -100, max: 100, step: 1, def: 0 } },
    ff: (p) => `hue=h=${p.hue}:s=${f4(1 + p.sat / 100)}:b=${f4(p.light / 10)}`,
    css: (p) => ({ filter: `hue-rotate(${p.hue}deg) saturate(${f4(1 + p.sat / 100)}) brightness(${f4(1 + p.light / 200)})` }) },
  equalize: { label: 'Equalize', cat: 'Color Correction', params: { amount: { label: 'Amount to equalize', min: 0, max: 1, step: 0.05, def: 0.5 } },
    ff: (p) => `histeq=strength=${f4(p.amount)}:intensity=0.21` },
  limiter: { label: 'Video Limiter', cat: 'Color Correction', params: { lo: { label: 'Luma min', min: 0, max: 64, step: 1, def: 16 }, hi: { label: 'Luma max', min: 180, max: 255, step: 1, def: 235 } },
    ff: (p) => `limiter=min=${Math.round(p.lo)}:max=${Math.round(p.hi)}:planes=1` },

  // ---------- Distort ----------
  magnify: { label: 'Magnify', cat: 'Distort', params: { ...XY, size: { label: 'Size (radius)', min: 2, max: 60, step: 0.5, def: 18, unit: '%' }, mag: { label: 'Magnification', min: 100, max: 600, step: 5, def: 200, unit: '%' } },
    ff: (p) => { const cx = `W*${f4(p.x / 100)}`, cy = `H*${f4(p.y / 100)}`, m = f4(p.mag / 100); return warp(`st(0,lt(hypot(X-${cx},Y-${cy}),W*${f4(p.size / 100)}));p(if(ld(0),${cx}+(X-${cx})/${m},X),if(ld(0),${cy}+(Y-${cy})/${m},Y))`); },
    pix: (g, W, H, p, { cv }) => { const cx = (W * p.x) / 100, cy = (H * p.y) / 100, r = (W * p.size) / 100, m = p.mag / 100;
      g.save(); g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.clip(); g.drawImage(cv, cx - r / m, cy - r / m, (2 * r) / m, (2 * r) / m, cx - r, cy - r, 2 * r, 2 * r); g.restore(); } },
  spherize: { label: 'Spherize', cat: 'Distort', params: { ...XY, radius: { label: 'Radius', min: 2, max: 80, step: 0.5, def: 30, unit: '%' }, amount: { label: 'Amount (- pinches)', min: -100, max: 100, step: 1, def: 60 } },
    ff: (p) => { const cx = `W*${f4(p.x / 100)}`, cy = `H*${f4(p.y / 100)}`, e = f4(Math.pow(2, p.amount / 100) - 1);
      return warp(`st(0,hypot(X-${cx},Y-${cy})/(W*${f4(p.radius / 100)}));st(1,if(lt(ld(0),1),pow(max(ld(0),0.001),${e}),1));p(${cx}+(X-${cx})*ld(1),${cy}+(Y-${cy})*ld(1))`); } },
  twirl: { label: 'Twirl', cat: 'Distort', params: { ...XY, angle: { label: 'Angle', min: -720, max: 720, step: 1, def: 180, unit: '°' }, radius: { label: 'Twirl radius', min: 2, max: 100, step: 0.5, def: 35, unit: '%' } },
    ff: (p) => { const cx = `W*${f4(p.x / 100)}`, cy = `H*${f4(p.y / 100)}`;
      return warp(`st(0,hypot(X-${cx},Y-${cy})/(W*${f4(p.radius / 100)}));st(1,if(lt(ld(0),1),${f4((p.angle * Math.PI) / 180)}*pow(1-ld(0),2),0));p(${cx}+(X-${cx})*cos(ld(1))-(Y-${cy})*sin(ld(1)),${cy}+(X-${cx})*sin(ld(1))+(Y-${cy})*cos(ld(1)))`); } },
  transform: { label: 'Transform', cat: 'Distort', params: { x: { label: 'Position across', min: -100, max: 100, step: 0.5, def: 0, unit: '%' }, y: { label: 'Position down', min: -100, max: 100, step: 0.5, def: 0, unit: '%' }, scale: { label: 'Scale', min: 5, max: 400, step: 1, def: 100, unit: '%' }, rot: { label: 'Rotation', min: -360, max: 360, step: 0.5, def: 0, unit: '°' }, skew: { label: 'Skew', min: -70, max: 70, step: 0.5, def: 0, unit: '°' }, opacity: { label: 'Opacity', min: 0, max: 100, step: 1, def: 100, unit: '%' } },
    // each output pixel looks up where it came from (the moves undone in reverse order); outside the picture is black
    ff: (p) => { const a = (p.rot * Math.PI) / 180, C = f4(Math.cos(a)), S = f4(Math.sin(a)), s = f4(Math.max(0.01, p.scale / 100)), T = f4(Math.tan((p.skew * Math.PI) / 180)), o = f4(p.opacity / 100);
      const pre = `st(0,X-W/2-W*${f4(p.x / 100)});st(1,Y-H/2-H*${f4(p.y / 100)});st(3,(-ld(0)*${S}+ld(1)*${C})/${s});st(2,(ld(0)*${C}+ld(1)*${S})/${s}-${T}*ld(3));st(4,W/2+ld(2));st(5,H/2+ld(3));st(6,between(ld(4),0,W-1)*between(ld(5),0,H-1)*${o})`;
      const pl = (k) => `${pre};${k}+(p(ld(4),ld(5))-${k})*ld(6)`;
      return `format=yuv444p,geq=lum='${pl(16)}':cb='${pl(128)}':cr='${pl(128)}'`; },
    css: (p) => ({ transform: `translate(${p.x}%, ${p.y}%) rotate(${p.rot}deg) scale(${f4(p.scale / 100)}) skewX(${p.skew}deg)`, filter: p.opacity < 100 ? `opacity(${f4(p.opacity / 100)})` : '' }) },
  turbulent: { label: 'Turbulent Displace', cat: 'Distort', params: { amount: { label: 'Amount', min: 0, max: 100, step: 1, def: 20, unit: 'px' }, size: { label: 'Size', min: 10, max: 600, step: 5, def: 140, unit: 'px' }, speed: { label: 'Evolution speed', min: 0, max: 5, step: 0.1, def: 1 } },
    ff: (p, { W }) => { const k = W / 1920, A = f4(p.amount * k), L = f4(p.size * k), v = f4(p.speed);
      return warp(`p(X+${A}*sin(Y/${L}+T*${v})*cos(X/(1.7*${L})+T*${v}*0.7),Y+${A}*cos(X/${L}-T*${v}*0.8)*sin(Y/(1.3*${L})+T*${v}*0.5))`); } },

  // ---------- Generate ----------
  grad4: { label: '4-Color Gradient', cat: 'Generate', params: { c1: { label: 'Top left', type: 'color', def: '#e8c547' }, c2: { label: 'Top right', type: 'color', def: '#3fb950' }, c3: { label: 'Bottom left', type: 'color', def: '#d1499b' }, c4: { label: 'Bottom right', type: 'color', def: '#3b6fd8' }, opacity: OPA },
    ff: (p) => { const c = [p.c1, p.c2, p.c3, p.c4].map(rgbOf);
      return rgbGeq((ch, i) => `st(0,X/W);st(1,Y/H);${ch}(X,Y)*${f4(1 - p.opacity)}+${f4(p.opacity)}*((1-ld(0))*(1-ld(1))*${c[0][i]}+ld(0)*(1-ld(1))*${c[1][i]}+(1-ld(0))*ld(1)*${c[2][i]}+ld(0)*ld(1)*${c[3][i]})`); },
    // live: a 2x2 picture of the corners stretched over the frame (the browser's smoothing is the same bilinear blend)
    pix: (g, W, H, p) => { const t = tmpCanvas(); t.width = 2; t.height = 2; const tg = t.getContext('2d'), im = tg.createImageData(2, 2);
      [p.c1, p.c2, p.c3, p.c4].forEach((c, i) => { im.data.set([...rgbOf(c), 255], i * 4); }); tg.putImageData(im, 0, 0);
      g.save(); g.globalAlpha = p.opacity; g.imageSmoothingEnabled = true; g.drawImage(t, 0.5, 0.5, 1, 1, 0, 0, W, H); g.restore(); } },
  ramp: { label: 'Ramp', cat: 'Generate', params: { shape: SEL('Ramp shape', [['linear', 'Linear'], ['radial', 'Radial']], 'linear'), sx: { label: 'Start across', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, sy: { label: 'Start down', min: 0, max: 100, step: 0.5, def: 0, unit: '%' }, c1: { label: 'Start colour', type: 'color', def: '#000000' }, ex: { label: 'End across', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, ey: { label: 'End down', min: 0, max: 100, step: 0.5, def: 100, unit: '%' }, c2: { label: 'End colour', type: 'color', def: '#ffffff' }, opacity: OPA },
    ff: (p) => { const a = rgbOf(p.c1), b = rgbOf(p.c2), sx = `W*${f4(p.sx / 100)}`, sy = `H*${f4(p.sy / 100)}`, dx = `(W*${f4((p.ex - p.sx) / 100)})`, dy = `(H*${f4((p.ey - p.sy) / 100)})`;
      const t = p.shape === 'radial' ? `clip(hypot(X-${sx},Y-${sy})/max(1,hypot(${dx},${dy})),0,1)` : `clip(((X-${sx})*${dx}+(Y-${sy})*${dy})/max(1,${dx}*${dx}+${dy}*${dy}),0,1)`;
      return rgbGeq((ch, i) => `st(0,${t});${ch}(X,Y)*${f4(1 - p.opacity)}+${f4(p.opacity)}*(${a[i]}+${b[i] - a[i]}*ld(0))`); },
    pix: (g, W, H, p) => { const sx = (W * p.sx) / 100, sy = (H * p.sy) / 100, ex = (W * p.ex) / 100, ey = (H * p.ey) / 100;
      const gr = p.shape === 'radial' ? g.createRadialGradient(sx, sy, 0, sx, sy, Math.max(1, Math.hypot(ex - sx, ey - sy))) : g.createLinearGradient(sx, sy, ex, ey);
      gr.addColorStop(0, p.c1); gr.addColorStop(1, p.c2); g.save(); g.globalAlpha = p.opacity; g.fillStyle = gr; g.fillRect(0, 0, W, H); g.restore(); } },
  // 🎯 Focus Blur: the picture sharp inside a circle (the subject), blurred outside it - a shallow-focus look. The mask is
  // worked out small and scaled up (soft anyway), so it costs about as much as a Gaussian blur
  focusblur: { label: 'Focus blur', cat: 'Blur & sharpen', params: { ...XY, size: { label: 'Sharp area', min: 0, max: 100, step: 0.5, def: 22, unit: '%' }, feather: { label: 'Feather', min: 0, max: 100, step: 0.5, def: 18, unit: '%' }, amount: { label: 'Blurriness', min: 0, max: 60, step: 1, def: 16 } },
    ff: (p, { W, H }) => ({ graph: (a, b) => {
      const mw = 192, mh = Math.max(2, Math.round((mw * H) / W)), s = Math.max(0.1, (n(p.amount, 16) * W) / 1920 / 2).toFixed(2);
      const m = `255*clip((hypot(X-${f4((mw * n(p.x, 50)) / 100)},Y-${f4((mh * n(p.y, 50)) / 100)})-${f4((mw * n(p.size, 22)) / 100)})/${f4(Math.max(0.5, (mw * n(p.feather, 18)) / 100))}+0.5,0,1)`;
      return `[${a}]split=3[${b}x][${b}y][${b}z];[${b}y]gblur=sigma=${s}[${b}g];[${b}z]scale=${mw}:${mh},format=gray,geq=lum='${m}',scale=${W}:${H}[${b}m];` +
        `[${b}g][${b}m]alphamerge[${b}k];[${b}x][${b}k]overlay=format=auto,format=yuv420p[${b}]`;
    } }),
    // live: the frame blurred on a second canvas, cut to outside the circle with the same soft edge, laid back over it
    pix: (g, W, H, p) => {
      const t = focusCanvas || (focusCanvas = document.createElement('canvas'));
      if (t.width !== W || t.height !== H) { t.width = W; t.height = H; }
      const tg = t.getContext('2d'), cx = (W * n(p.x, 50)) / 100, cy = (H * n(p.y, 50)) / 100, r = (W * n(p.size, 22)) / 100, f = Math.max(0.5, (W * n(p.feather, 18)) / 100);
      tg.clearRect(0, 0, W, H); tg.filter = `blur(${((n(p.amount, 16) * W) / 1920 / 2).toFixed(2)}px)`; tg.drawImage(g.canvas, 0, 0); tg.filter = 'none';
      const gr = tg.createRadialGradient(cx, cy, Math.max(0, r - f / 2), cx, cy, r + f / 2);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
      tg.globalCompositeOperation = 'destination-in'; tg.fillStyle = gr; tg.fillRect(0, 0, W, H); tg.globalCompositeOperation = 'source-over';
      g.drawImage(t, 0, 0);
    } },
  circle: { label: 'Circle', cat: 'Generate', params: { ...XY, radius: { label: 'Radius', min: 0, max: 100, step: 0.5, def: 15, unit: '%' }, feather: { label: 'Feather', min: 0, max: 400, step: 1, def: 4, unit: 'px' }, color: { label: 'Colour', type: 'color', def: '#ffffff' }, opacity: OPA, invert: SEL('Invert circle', [['off', 'Off'], ['on', 'On']], 'off') },
    ff: (p, { W }) => { const a = `clip((W*${f4(p.radius / 100)}-hypot(X-W*${f4(p.x / 100)},Y-H*${f4(p.y / 100)}))/${f4(Math.max(1, (p.feather * W) / 1920))}+0.5,0,1)`; return paint(p.color, `${p.invert === 'on' ? `(1-${a})` : a}*${f4(p.opacity)}`); },
    pix: (g, W, H, p) => { const cx = (W * p.x) / 100, cy = (H * p.y) / 100, r = (W * p.radius) / 100, f = Math.max(0.5, (p.feather * W) / 1920 / 2), gr = g.createRadialGradient(cx, cy, Math.max(0, r - f), cx, cy, r + f), on = p.invert === 'on';
      gr.addColorStop(0, rgba(p.color, on ? 0 : 1)); gr.addColorStop(1, rgba(p.color, on ? 1 : 0)); g.save(); g.globalAlpha = p.opacity; g.fillStyle = gr; g.fillRect(0, 0, W, H); g.restore(); } },
  ellipse: { label: 'Ellipse', cat: 'Generate', params: { ...XY, w: { label: 'Width', min: 1, max: 150, step: 0.5, def: 40, unit: '%' }, h: { label: 'Height', min: 1, max: 150, step: 0.5, def: 50, unit: '%' }, thick: { label: 'Thickness', min: 1, max: 400, step: 1, def: 30, unit: 'px' }, soft: { label: 'Softness', min: 0, max: 100, step: 1, def: 15, unit: '%' }, color: { label: 'Colour', type: 'color', def: '#ffffff' }, opacity: OPA },
    // a ring: how far a pixel is from the ellipse's line, in pixels, against half the thickness
    ff: (p, { W }) => { const rx = `(W*${f4(p.w / 200)})`, ry = `(H*${f4(p.h / 200)})`, t = Math.max(1, (p.thick * W) / 1920) / 2, sf = Math.max(0.5, (t * p.soft) / 100);
      return paint(p.color, `clip((${f4(t)}-abs(hypot((X-W*${f4(p.x / 100)})/${rx},(Y-H*${f4(p.y / 100)})/${ry})-1)*min(${rx},${ry}))/${f4(sf)}+0.5,0,1)*${f4(p.opacity)}`); },
    pix: (g, W, H, p) => { g.save(); g.globalAlpha = p.opacity; g.strokeStyle = p.color; g.lineWidth = Math.max(1, (p.thick * W) / 1920); g.beginPath(); g.ellipse((W * p.x) / 100, (H * p.y) / 100, (W * p.w) / 200, (H * p.h) / 200, 0, 0, 2 * Math.PI); g.stroke(); g.restore(); } },
  checker: { label: 'Checkerboard', cat: 'Generate', params: { size: { label: 'Square size', min: 4, max: 600, step: 1, def: 120, unit: 'px' }, color: { label: 'Colour', type: 'color', def: '#ffffff' }, opacity: OPA },
    ff: (p, { W }) => { const s = f4(Math.max(2, (p.size * W) / 1920)); return paint(p.color, `mod(floor(X/${s})+floor(Y/${s}),2)*${f4(p.opacity)}`); },
    pix: (g, W, H, p) => { const s = Math.max(2, (p.size * W) / 1920); g.save(); g.globalAlpha = p.opacity; g.fillStyle = p.color;
      for (let y = 0, j = 0; y < H; y += s, j++) for (let x = 0, i = 0; x < W; x += s, i++) if ((i + j) % 2) g.fillRect(x, y, s, s); g.restore(); } },
  grid: { label: 'Grid', cat: 'Generate', params: { size: { label: 'Cell size', min: 8, max: 600, step: 1, def: 160, unit: 'px' }, border: { label: 'Border', min: 1, max: 60, step: 1, def: 3, unit: 'px' }, color: { label: 'Colour', type: 'color', def: '#ffffff' }, opacity: OPA },
    ff: (p, { W }) => { const s = f4(Math.max(2, (p.size * W) / 1920)), b = f4(Math.max(1, (p.border * W) / 1920)); return paint(p.color, `max(lt(mod(X,${s}),${b}),lt(mod(Y,${s}),${b}))*${f4(p.opacity)}`); },
    pix: (g, W, H, p) => { const s = Math.max(2, (p.size * W) / 1920), b = Math.max(1, (p.border * W) / 1920); g.save(); g.globalAlpha = p.opacity; g.fillStyle = p.color;
      for (let x = 0; x < W; x += s) g.fillRect(x, 0, b, H); for (let y = 0; y < H; y += s) g.fillRect(0, y, W, b); g.restore(); } },
  flare: { label: 'Lens Flare', cat: 'Generate', params: { x: { label: 'Flare centre across', min: 0, max: 100, step: 0.5, def: 25, unit: '%' }, y: { label: 'Flare centre down', min: 0, max: 100, step: 0.5, def: 25, unit: '%' }, bright: { label: 'Flare brightness', min: 10, max: 300, step: 1, def: 100, unit: '%' }, color: { label: 'Colour', type: 'color', def: '#ffe2b0' } },
    // a bright glow at the centre and three ghosts on the line through the middle of the frame (added light)
    ff: (p) => { const c = rgbOf(p.color), b = p.bright / 100, fx = p.x / 100, fy = p.y / 100, spot = (u, v, r, k) => `${f4(k)}*exp(-pow(hypot(X-W*${f4(u)},Y-H*${f4(v)})/(W*${f4(r)}),2))`;
      const ghosts = [[0.6, 0.03, 0.25], [1.3, 0.05, 0.18], [1.7, 0.08, 0.12]].map(([t, r, k]) => spot(fx + (0.5 - fx) * t, fy + (0.5 - fy) * t, r, k * b));
      return rgbGeq((ch, i) => `clip(${ch}(X,Y)+${c[i]}*(${spot(fx, fy, 0.12, 1.2 * b)}+${ghosts.join('+')}),0,255)`); },
    pix: (g, W, H, p) => { const b = p.bright / 100, fx = (W * p.x) / 100, fy = (H * p.y) / 100, spot = (x, y, r, k) => { const gr = g.createRadialGradient(x, y, 0, x, y, r * 2); gr.addColorStop(0, rgba(p.color, Math.min(1, k))); gr.addColorStop(1, rgba(p.color, 0)); g.fillStyle = gr; g.fillRect(x - r * 2, y - r * 2, r * 4, r * 4); };
      g.save(); g.globalCompositeOperation = 'lighter'; spot(fx, fy, W * 0.12, 1.2 * b);
      for (const [t, r, k] of [[0.6, 0.03, 0.25], [1.3, 0.05, 0.18], [1.7, 0.08, 0.12]]) spot(fx + (W / 2 - fx) * t, fy + (H / 2 - fy) * t, W * r, k * b); g.restore(); } },

  // ---------- Image Control ----------
  cbrgb: { label: 'Color Balance (RGB)', cat: 'Image Control', params: { r: { label: 'Red', min: 0, max: 200, step: 1, def: 100 }, g: { label: 'Green', min: 0, max: 200, step: 1, def: 100 }, b: { label: 'Blue', min: 0, max: 200, step: 1, def: 100 } },
    ff: (p) => `colorchannelmixer=rr=${f4(p.r / 100)}:gg=${f4(p.g / 100)}:bb=${f4(p.b / 100)}`,
    css: (p) => ({ filter: svgFx(fid('cb', p.r, p.g, p.b), `<feColorMatrix type="matrix" values="${f4(p.r / 100)} 0 0 0 0 0 ${f4(p.g / 100)} 0 0 0 0 0 ${f4(p.b / 100)} 0 0 0 0 0 1 0"/>`) }) },
  colorreplace: { reads: true, label: 'Color Replace', cat: 'Image Control', params: { target: { label: 'Target colour', type: 'color', def: '#d62828' }, color: { label: 'Replace colour', type: 'color', def: '#2a6fdb' }, match: { label: 'Similarity', min: 0.02, max: 0.6, step: 0.01, def: 0.25 }, soft: { label: 'Softness', min: 0, max: 0.5, step: 0.01, def: 0.05 } },
    ff: (p) => { const [h, s] = rgb2hsl(...rgbOf(p.color)); return recolor(p.target, p.match, p.soft, `colorize=hue=${Math.round(h)}:saturation=${f4(s)}:lightness=0.5:mix=1`); },
    pix: (g, W, H, p) => { const [h, s] = rgb2hsl(...rgbOf(p.color)); recolorPix(g, W, H, p.target, p.match, p.soft, (h0, s0, l) => [h, s, l]); } },
  gamma: { label: 'Gamma Correction', cat: 'Image Control', params: { g: { label: 'Gamma (10 = none; higher is darker)', min: 1, max: 28, step: 0.5, def: 10 } },
    ff: (p) => lutAll(`255*pow(val/255,${f4(p.g / 10)})`),
    css: (p) => ({ filter: svgCt(fid('gm', p.g), () => `type="gamma" amplitude="1" exponent="${f4(p.g / 10)}" offset="0"`) }) },

  // ---------- Keying (V2 overlays: keyed in the final pass, like Green screen) ----------
  lumakey: { label: 'Luma Key', cat: 'Keying', v2only: true, params: { thr: { label: 'Brightness to key', min: 0, max: 1, step: 0.01, def: 0 }, tol: { label: 'Tolerance', min: 0, max: 1, step: 0.01, def: 0.15 }, soft: { label: 'Softness', min: 0, max: 1, step: 0.01, def: 0.1 } },
    ff: () => 'null', key: (p) => `format=yuva420p,lumakey=threshold=${f4(p.thr)}:tolerance=${f4(p.tol)}:softness=${f4(p.soft)}`,
    pix: (g, W, H, p) => { const im = g.getImageData(0, 0, W, H), d = im.data;
      for (let i = 0; i < d.length; i += 4) { const x = Math.abs(lumOf(d[i], d[i + 1], d[i + 2]) - p.thr); if (x <= p.tol) d[i + 3] = 0; else if (p.soft > 0 && x < p.tol + p.soft) d[i + 3] = Math.round(d[i + 3] * ((x - p.tol) / p.soft)); }
      g.putImageData(im, 0, 0); } },
  colorkey: { label: 'Color Key', cat: 'Keying', v2only: true, params: { color: { label: 'Key colour', type: 'color', def: '#00ff00' }, similarity: { label: 'Colour tolerance', min: 0.01, max: 0.6, step: 0.01, def: 0.2 }, blend: { label: 'Edge feather', min: 0, max: 0.3, step: 0.01, def: 0.05 } },
    ff: () => 'null', key: (p) => `format=rgba,colorkey=${hx(p.color)}:${f4(p.similarity)}:${f4(p.blend)},format=yuva420p`,
    pix: (g, W, H, p) => { const [kr, kg, kb] = rgbOf(p.color), bl = Math.max(0.001, p.blend), im = g.getImageData(0, 0, W, H), d = im.data;
      for (let i = 0; i < d.length; i += 4) { const x = Math.sqrt((d[i] - kr) ** 2 + (d[i + 1] - kg) ** 2 + (d[i + 2] - kb) ** 2) / 441.7; if (x < p.similarity) d[i + 3] = 0; else if (x < p.similarity + bl) d[i + 3] = Math.round(d[i + 3] * ((x - p.similarity) / bl)); }
      g.putImageData(im, 0, 0); } },

  // ---------- Noise & Grain ----------
  noise: { label: 'Noise', cat: 'Noise & Grain', params: { amount: { label: 'Amount of noise', min: 0, max: 100, step: 1, def: 20, unit: '%' }, color: SEL('Colour noise', [['on', 'On'], ['off', 'Off (mono)']], 'on') },
    ff: (p) => { const s = Math.round(p.amount); return p.color === 'off' ? `noise=c0s=${s}:c0f=t+u` : `noise=alls=${s}:allf=t+u`; }, css: (p) => ({ overlay: grainCss(Math.min(1, p.amount / 60)), grain: true }) },
  median: { label: 'Median', cat: 'Noise & Grain', params: { radius: { label: 'Radius', min: 1, max: 30, step: 1, def: 3, unit: 'px' } },
    ff: (p, { W }) => `median=radius=${Math.max(1, Math.min(127, Math.round((p.radius * W) / 1920)))}`, css: (p, k) => ({ filter: `blur(${f4(p.radius * k * 0.4)}px)` }) },
  dust: { label: 'Dust & Scratches', cat: 'Noise & Grain', params: { radius: { label: 'Radius', min: 1, max: 10, step: 1, def: 2, unit: 'px' }, thr: { label: 'Threshold', min: 0, max: 255, step: 1, def: 12 } },
    // pixels that differ from their neighbourhood's median by more than the threshold take the median
    ff: (p, { W }) => ({ graph: (a, b) => `[${a}]split[${b}o][${b}c];[${b}c]median=radius=${Math.max(1, Math.round((p.radius * W) / 1920))}[${b}m];[${b}o][${b}m]blend=all_expr='if(gt(abs(A-B),${Math.round(p.thr)}),B,A)'[${b}]` }) },
  noisehls: { label: 'Noise HLS', cat: 'Noise & Grain', params: { hue: { label: 'Hue noise', min: 0, max: 100, step: 1, def: 0, unit: '%' }, light: { label: 'Lightness noise', min: 0, max: 100, step: 1, def: 20, unit: '%' }, sat: { label: 'Saturation noise', min: 0, max: 100, step: 1, def: 0, unit: '%' } },
    ff: (p) => { const l = Math.round(p.light * 0.8), c = Math.round(Math.max(p.hue, p.sat) * 0.6); return `noise=c0s=${l}:c0f=t+u${c ? `:c1s=${c}:c1f=t+u:c2s=${c}:c2f=t+u` : ''}`; },
    css: (p) => ({ overlay: grainCss(Math.min(1, p.light / 60)), grain: true }) },

  // ---------- Perspective ----------
  bevel: { label: 'Bevel Edges', cat: 'Perspective', params: { size: { label: 'Edge thickness', min: 1, max: 120, step: 1, def: 16, unit: 'px' }, light: { label: 'Light intensity', min: 0, max: 1, step: 0.05, def: 0.4 } },
    ff: (p, { W }) => { const s = Math.max(1, Math.round((p.size * W) / 1920)), a = f4(p.light * 0.8);
      return [`drawbox=x=0:y=0:w=iw:h=${s}:t=fill:color=white@${a}`, `drawbox=x=0:y=0:w=${s}:h=ih:t=fill:color=white@${a}`, `drawbox=x=0:y=ih-${s}:w=iw:h=${s}:t=fill:color=black@${a}`, `drawbox=x=iw-${s}:y=0:w=${s}:h=ih:t=fill:color=black@${a}`].join(','); },
    css: (p, k) => { const s = Math.max(1, p.size * k).toFixed(1), a = f4(p.light * 0.8);
      return { overlay: [['bottom', 255], ['right', 255], ['top', 0], ['left', 0]].map(([d, v]) => `linear-gradient(to ${d}, rgba(${v},${v},${v},${a}) ${s}px, rgba(0,0,0,0) ${s}px)`).join(', ') }; } },

  // ---------- Stylize ----------
  emboss: { label: 'Emboss', cat: 'Stylize', params: { dir: { label: 'Direction', min: 0, max: 360, step: 1, def: 45, unit: '°' }, relief: { label: 'Relief', min: 1, max: 10, step: 1, def: 3 } },
    ff: (p) => `convolution=0m='${embossK(p.dir, p.relief, 0).join(' ')}':0rdiv=1:0bias=128:1m='0 0 0 0 0 0 0 0 0':1rdiv=1:1bias=128:2m='0 0 0 0 0 0 0 0 0':2rdiv=1:2bias=128`,
    css: (p) => ({ filter: svgFx(fid('em', p.dir, p.relief), `<feColorMatrix type="saturate" values="0"/><feConvolveMatrix order="3" kernelMatrix="${embossK(p.dir, p.relief, 0).join(' ')}" divisor="1" bias="0.5" preserveAlpha="true"/>`) }) },
  coloremboss: { label: 'Color Emboss', cat: 'Stylize', params: { dir: { label: 'Direction', min: 0, max: 360, step: 1, def: 45, unit: '°' }, relief: { label: 'Relief', min: 1, max: 10, step: 1, def: 2 } },
    ff: (p) => `convolution=0m='${embossK(p.dir, p.relief, 1).join(' ')}':0rdiv=1:0bias=0:1m='0 0 0 0 1 0 0 0 0':1rdiv=1:2m='0 0 0 0 1 0 0 0 0':2rdiv=1`,
    css: (p) => ({ filter: svgFx(fid('cem', p.dir, p.relief), `<feConvolveMatrix order="3" kernelMatrix="${embossK(p.dir, p.relief, 1).join(' ')}" divisor="1" preserveAlpha="true"/>`) }) },
  findedges: { label: 'Find Edges', cat: 'Stylize', params: { invert: SEL('Invert (dark background)', [['off', 'Off'], ['on', 'On']], 'off'), blend: { label: 'Blend with original', min: 0, max: 1, step: 0.05, def: 0 } },
    ff: (p) => { const e = `hue=s=0,edgedetect=low=0.05:high=0.2:mode=wires:planes=1${p.invert === 'on' ? '' : ',negate'}`;
      return p.blend > 0 ? { graph: (a, b) => `[${a}]split[${b}o][${b}c];[${b}c]${e}[${b}e];[${b}e][${b}o]blend=all_mode=normal:all_opacity=${f4(p.blend)},format=yuv420p[${b}]` } : e; },
    css: (p) => ({ filter: svgFx(fid('fe', p.invert, p.blend), `<feConvolveMatrix in="SourceGraphic" order="3" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" divisor="1" preserveAlpha="true" result="e"/>${p.invert === 'on' ? '' : '<feComponentTransfer in="e" result="e"><feFuncR type="table" tableValues="1 0"/><feFuncG type="table" tableValues="1 0"/><feFuncB type="table" tableValues="1 0"/></feComponentTransfer>'}<feComposite in="SourceGraphic" in2="e" operator="arithmetic" k1="0" k2="${f4(p.blend)}" k3="${f4(1 - p.blend)}" k4="0"/>`) }) },
  posterize: { label: 'Posterize', cat: 'Stylize', params: { levels: { label: 'Level', min: 2, max: 32, step: 1, def: 6 } },
    ff: (p) => { const N = Math.round(p.levels); return lutAll(`floor(val*${N}/256)*255/${N - 1}`); },
    css: (p) => { const N = Math.round(p.levels); return { filter: svgCt(fid('po', N), () => `type="discrete" tableValues="${Array.from({ length: N }, (_, i) => f4(i / (N - 1))).join(' ')}"`) }; } },
  solarize: { label: 'Solarize', cat: 'Stylize', params: { thr: { label: 'Threshold', min: 0, max: 255, step: 1, def: 128 } },
    ff: (p) => lutAll(`if(gt(val,${Math.round(p.thr)}),255-val,val)`),
    css: (p) => ({ filter: svgCt(fid('so', p.thr), () => tbl((x) => (x * 255 > p.thr ? 1 - x : x), 129)) }) },
  threshold: { label: 'Threshold', cat: 'Stylize', params: { level: { label: 'Level', min: 0, max: 255, step: 1, def: 128 } },
    ff: (p) => `hue=s=0,${lutAll(`if(gt(val,${Math.round(p.level)}),255,0)`)}`,
    css: (p) => ({ filter: svgCt(fid('th', p.level), '<feColorMatrix type="saturate" values="0"/>', () => tbl((x) => (x * 255 > p.level ? 1 : 0), 256).replace('type="table"', 'type="discrete"')) }) },
  replicate: { label: 'Replicate', cat: 'Stylize', params: { count: { label: 'Count', min: 2, max: 16, step: 1, def: 2 } },
    ff: (p) => { const N = Math.round(p.count); return warp(`p(mod(X*${N},W),mod(Y*${N},H))`); },
    pix: (g, W, H, p, { cv }) => { const N = Math.round(p.count), t = tmpCanvas(); t.width = W; t.height = H; t.getContext('2d').drawImage(cv, 0, 0);
      g.clearRect(0, 0, W, H); for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) g.drawImage(t, (i * W) / N, (j * H) / N, W / N, H / N); } },

  // ---------- Transform ----------
  edgefeather: { label: 'Edge Feather', cat: 'Transform', params: { amount: { label: 'Amount', min: 0, max: 500, step: 1, def: 80, unit: 'px' } },
    ff: (p, { W }) => shade(`clip(min(min(X,W-1-X),min(Y,H-1-Y))/${f4(Math.max(1, (p.amount * W) / 1920))},0,1)`),
    css: (p, k) => { const s = Math.max(0.5, p.amount * k).toFixed(1); return { overlay: ['bottom', 'right', 'top', 'left'].map((d) => `linear-gradient(to ${d}, rgba(0,0,0,1), rgba(0,0,0,0) ${s}px)`).join(', ') }; } },

  // ---------- Transition (static wipes; the wiped part is black - on V2 the shot below shows only through the real transitions) ----------
  linwipe: { label: 'Linear Wipe', cat: 'Transition', params: { done: { label: 'Transition completion', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, angle: { label: 'Wipe angle', min: 0, max: 360, step: 1, def: 90, unit: '°' }, feather: { label: 'Feather', min: 0, max: 400, step: 1, def: 0, unit: 'px' } },
    // the position of a pixel along the wipe's direction, 0..1 across the frame, against the completion
    ff: (p, { W }) => { const a = (p.angle * Math.PI) / 180, dx = f4(Math.sin(a)), dy = f4(-Math.cos(a)), L = `(abs(W*${dx})+abs(H*${dy}))`, F = f4(Math.max(1, (p.feather * W) / 1920));
      return shade(`clip((((X-W/2)*${dx}+(Y-H/2)*${dy})/${L}+0.5-${f4(p.done / 100)})*${L}/${F}+0.5,0,1)`); },
    css: (p, k) => { const c = p.done; return { overlay: `linear-gradient(${p.angle}deg, rgba(0,0,0,1) ${c}%, rgba(0,0,0,0) calc(${c}% + ${Math.max(0.5, p.feather * k).toFixed(1)}px))` }; } },
  radwipe: { label: 'Radial Wipe', cat: 'Transition', params: { done: { label: 'Transition completion', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, start: { label: 'Start angle', min: 0, max: 360, step: 1, def: 0, unit: '°' }, dir: SEL('Wipe', [['cw', 'Clockwise'], ['ccw', 'Counterclockwise']], 'cw') },
    ff: (p) => { const a = `mod(atan2(X-W/2,H/2-Y)-${f4((p.start * Math.PI) / 180)}+4*PI,2*PI)/(2*PI)`; return shade(`gte(${p.dir === 'ccw' ? `1-${a}` : a},${f4(p.done / 100)})`); },
    css: (p) => ({ overlay: p.dir === 'ccw' ? `conic-gradient(from ${p.start}deg, rgba(0,0,0,0) ${(360 - p.done * 3.6).toFixed(1)}deg, rgba(0,0,0,1) 0)` : `conic-gradient(from ${p.start}deg, rgba(0,0,0,1) ${(p.done * 3.6).toFixed(1)}deg, rgba(0,0,0,0) 0)` }) },
  blinds: { label: 'Venetian Blinds', cat: 'Transition', params: { done: { label: 'Transition completion', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, angle: { label: 'Direction', min: 0, max: 180, step: 1, def: 0, unit: '°' }, width: { label: 'Width', min: 4, max: 600, step: 1, def: 80, unit: 'px' } },
    ff: (p, { W }) => { const a = (p.angle * Math.PI) / 180, w = f4(Math.max(2, (p.width * W) / 1920)); return shade(`gte(mod(X*${f4(Math.sin(a))}+Y*${f4(Math.cos(a))}+100*${w},${w})/${w},${f4(p.done / 100)})`); },
    css: (p, k) => { const w = Math.max(2, p.width * k); return { overlay: `repeating-linear-gradient(${180 - p.angle}deg, rgba(0,0,0,1) 0 ${((w * p.done) / 100).toFixed(2)}px, rgba(0,0,0,0) ${((w * p.done) / 100).toFixed(2)}px ${w.toFixed(2)}px)` }; } },
  blockdiss: { label: 'Block Dissolve', cat: 'Transition', params: { done: { label: 'Transition completion', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, bw: { label: 'Block width', min: 1, max: 400, step: 1, def: 24, unit: 'px' }, bh: { label: 'Block height', min: 1, max: 400, step: 1, def: 24, unit: 'px' } },
    // each block has a fixed random number (a hash of its row and column); blocks below the completion go
    ff: (p, { W }) => { const bw = f4(Math.max(1, (p.bw * W) / 1920)), bh = f4(Math.max(1, (p.bh * W) / 1920));
      return shade(`st(0,sin(floor(X/${bw})*12.9898+floor(Y/${bh})*78.233)*43758.5453);gte(ld(0)-floor(ld(0)),${f4(p.done / 100)})`); } },

  // ---------- Utility ----------
  cineon: { label: 'Cineon Converter', cat: 'Utility', params: { black: { label: '10 bit black point', min: 0, max: 400, step: 1, def: 95 }, white: { label: '10 bit white point', min: 500, max: 1023, step: 1, def: 685 }, gamma: { label: 'Gamma', min: 0.1, max: 4, step: 0.05, def: 1.7 } },
    // log (film scan) to linear light, shown with the display gamma
    ff: (p) => { const k = 0.002 / 0.6, gn = 1 / (1 - Math.pow(10, (p.black - p.white) * k)); return lutAll(`255*pow(clip(pow(10,(val*1023/255-${p.white})*${f4(k)})*${f4(gn)}-${f4(gn - 1)},0,1),${f4(1 / p.gamma)})`); },
    css: (p) => { const k = 0.002 / 0.6, gn = 1 / (1 - Math.pow(10, (p.black - p.white) * k)); return { filter: svgCt(fid('cin', p.black, p.white, p.gamma), () => tbl((x) => Math.pow(Math.min(1, Math.max(0, Math.pow(10, (x * 1023 - p.white) * k) * gn - (gn - 1))), 1 / p.gamma), 65)) }; } },

  // ---------- Video ----------
  timecode: { label: 'Timecode', cat: 'Video', params: { pos: SEL('Position', TXT_POS, 'bc'), size: { label: 'Size', min: 12, max: 160, step: 1, def: 48, unit: 'px' }, bg: { label: 'Background opacity', min: 0, max: 1, step: 0.05, def: 0.6 } },
    // the source's own time (clip in-point + time into the clip at its speed), HH:MM:SS:FF at the output frame rate
    ff: (p, ctx) => burnText(tcText(+ctx.clip?.in || 0, +ctx.clip?.speed || 1, Math.round(ctx.F || 30)), p, ctx, true),
    pix: (g, W, H, p, { rel = 0, fps = 30, c }) => burnPix(g, W, tcAt((+c?.in || 0) + rel * (+c?.speed || 1), Math.round(fps)), p) },
  clipname: { label: 'Clip Name', cat: 'Video', params: { pos: SEL('Position', TXT_POS, 'bl'), size: { label: 'Size', min: 12, max: 160, step: 1, def: 40, unit: 'px' }, bg: { label: 'Background opacity', min: 0, max: 1, step: 0.05, def: 0.6 } },
    ff: (p, ctx) => burnText(ctx.name || 'Clip', p, ctx), pix: (g, W, H, p, { name }) => burnPix(g, W, name || 'Clip', p) },

  // ======== round 2: the ones first left out (engine/premiere-effects-gap.md) ========
  // ---------- Adjust / Blur & sharpen ----------
  convkernel: { label: 'Convolution Kernel', cat: 'Adjust',
    params: { ...Object.fromEntries([11, 12, 13, 21, 22, 23, 31, 32, 33].map((k) => [`m${k}`, { label: `M${k}`, min: -30, max: 30, step: 1, def: k === 22 ? 1 : 0 }])), scale: { label: 'Scale (divide by)', min: 1, max: 100, step: 1, def: 1 }, offset: { label: 'Offset', min: -255, max: 255, step: 1, def: 0 } },
    ff: (p) => { const m = KERN(p); return `format=gbrp,convolution=${[0, 1, 2].map((i) => `${i}m='${m}':${i}rdiv=${f4(1 / p.scale)}:${i}bias=${Math.round(p.offset)}`).join(':')},format=yuv420p`; },
    css: (p) => ({ filter: svgFx(fid('ck', KERN(p), p.scale, p.offset), `<feConvolveMatrix order="3" kernelMatrix="${KERN(p)}" divisor="${p.scale}" bias="${f4(p.offset / 255)}" preserveAlpha="true"/>`) }) },
  shadowhl: { label: 'Shadow/Highlight', cat: 'Adjust', params: { shadows: { label: 'Shadow amount', min: 0, max: 100, step: 1, def: 35 }, highlights: { label: 'Highlight amount', min: 0, max: 100, step: 1, def: 0 } },
    // the shadows lifted and the highlights pulled down; the middle stays
    ff: (p) => lutAll(`255*clip(${SHL('val/255', p)},0,1)`),
    css: (p) => ({ filter: svgCt(fid('shl', p.shadows, p.highlights), () => tbl((x) => shl(x, p), 65)) }) },
  camerablur: { label: 'Camera Blur', cat: 'Blur & sharpen', params: { amount: { label: 'Percent blur', min: 0, max: 100, step: 1, def: 15 } },
    // a lens-like (flat, round-ish) blur: a box blur twice is close to a disc
    ff: (p, { W }) => { const r = Math.max(1, Math.round((p.amount * W) / 1920 / 2)); return `avgblur=sizeX=${r}:sizeY=${r},avgblur=sizeX=${r}:sizeY=${r}`; },
    css: (p, k) => ({ filter: `blur(${f4(p.amount * k * 0.45)}px)` }) },
  channelblur: { label: 'Channel Blur', cat: 'Blur & sharpen', params: { r: { label: 'Red blurriness', min: 0, max: 60, step: 1, def: 10 }, g: { label: 'Green blurriness', min: 0, max: 60, step: 1, def: 0 }, b: { label: 'Blue blurriness', min: 0, max: 60, step: 1, def: 0 } },
    // (gbrp's planes are green 1, blue 2, red 4)
    ff: (p, { W }) => { const f = [['g', 1], ['b', 2], ['r', 4]].filter(([c]) => p[c] > 0).map(([c, pl]) => `gblur=sigma=${f4(Math.max(0.1, (p[c] * W) / 1920 / 2))}:planes=${pl}`); return f.length ? `format=gbrp,${f.join(',')},format=yuv420p` : 'null'; } },

  // ---------- Channel ----------
  blendfx: { label: 'Blend', cat: 'Channel', v2only: true, params: { mode: SEL('Mode', BLENDS, 'crossfade'), amount: { label: 'Blend with original', min: 0, max: 1, step: 0.05, def: 0.5 } },
    // blends this layer with everything below it, in the final pass (like the track Blend mode, with Premiere's modes)
    ff: () => 'null', blend: (p) => ({ mode: p.mode, amount: p.amount }) },

  // ---------- Generate ----------
  lightning: { label: 'Lightning', cat: 'Generate', params: { sx: { label: 'Start across', min: 0, max: 100, step: 0.5, def: 20, unit: '%' }, sy: { label: 'Start down', min: 0, max: 100, step: 0.5, def: 10, unit: '%' }, ex: { label: 'End across', min: 0, max: 100, step: 0.5, def: 75, unit: '%' }, ey: { label: 'End down', min: 0, max: 100, step: 0.5, def: 90, unit: '%' }, width: { label: 'Core width', min: 1, max: 40, step: 0.5, def: 5, unit: 'px' }, amp: { label: 'Detail amplitude', min: 0, max: 300, step: 1, def: 70, unit: 'px' }, speed: { label: 'Changes a second', min: 0, max: 30, step: 1, def: 10 }, color: { label: 'Outside colour', type: 'color', def: '#8fb8ff' } },
    // the bolt: the straight line start-end bent by three sines that jump to new phases (speed) times a second
    ff: (p, { W }) => { const k = W / 1920, b = bolt(p, k, 'W', 'H'), c = rgbOf(p.color), w = f4(Math.max(0.5, p.width * k));
      return rgbGeq((ch, i) => `${b};clip(${ch}(X,Y)+255*exp(-pow(ld(4)/${w},2))+${c[i]}*0.8*exp(-pow(ld(4)/(6*${w}),2)),0,255)`); },
    pix: (g, W, H, p, { rel = 0 }) => { const k = W / 1920, n = Math.floor(rel * p.speed), [sx, sy, ex, ey] = [p.sx * W, p.sy * H, p.ex * W, p.ey * H].map((v) => v / 100), L = Math.hypot(ex - sx, ey - sy) || 1;
      g.save(); g.lineCap = g.lineJoin = 'round'; g.globalCompositeOperation = 'lighter'; g.beginPath();
      for (let i = 0; i <= 60; i++) { const u = i / 60, o = boltOff(u, n, p.amp * k); g.lineTo(sx + (ex - sx) * u - ((ey - sy) / L) * o, sy + (ey - sy) * u + ((ex - sx) / L) * o); }
      g.strokeStyle = rgba(p.color, 0.6); g.lineWidth = p.width * k * 6; g.shadowColor = p.color; g.shadowBlur = p.width * k * 8; g.stroke(); g.shadowBlur = 0; g.strokeStyle = '#fff'; g.lineWidth = p.width * k * 1.4; g.stroke(); g.restore(); } },
  cellpattern: { label: 'Cell Pattern', cat: 'Generate', params: { size: { label: 'Size', min: 10, max: 400, step: 1, def: 80, unit: 'px' }, contrast: { label: 'Contrast', min: 0.2, max: 4, step: 0.05, def: 1.2 }, invert: SEL('Invert', [['off', 'Off'], ['on', 'On']], 'off'), speed: { label: 'Evolution speed', min: 0, max: 5, step: 0.1, def: 0.5 }, opacity: OPA },
    // Bubbles: the distance to the nearest of one jittered point per grid cell (the 3 x 3 cells around)
    ff: (p, { W }) => { const s = f4(Math.max(4, (p.size * W) / 1920)), v = `clip(ld(9)/${s}*${f4(p.contrast)},0,1)`, val = p.invert === 'on' ? `(1-${v})` : v, o = f4(p.opacity);
      const pre = `st(0,floor(X/${s}));st(1,floor(Y/${s}));st(9,1e9);${CELLS(s, f4(p.speed))}`;
      return `format=yuv444p,geq=lum='${pre};p(X,Y)*(1-${o})+(16+219*${val})*${o}':cb='128+(p(X,Y)-128)*(1-${o})':cr='128+(p(X,Y)-128)*(1-${o})'`; } },
  eyedropper: { label: 'Eyedropper Fill', cat: 'Generate', reads: true, params: { x: { label: 'Sample point across', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, y: { label: 'Sample point down', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, radius: { label: 'Sample radius', min: 1, max: 200, step: 1, def: 20, unit: 'px' }, opacity: OPA },
    // the average colour around the sample point, each frame, laid over the picture
    ff: (p, { W, H }) => { const r = Math.max(1, Math.round((p.radius * W) / 1920));
      return { graph: (a, b) => `[${a}]split[${b}o][${b}s];[${b}s]crop=w=${2 * r}:h=${2 * r}:x='clip(iw*${f4(p.x / 100)}-${r},0,iw-ow)':y='clip(ih*${f4(p.y / 100)}-${r},0,ih-oh)',scale=1:1:flags=area,scale=${W}:${H},format=rgba,colorchannelmixer=aa=${f4(p.opacity)}[${b}c];[${b}o][${b}c]overlay=format=auto,format=yuv420p[${b}]` }; },
    pix: (g, W, H, p) => { const r = Math.max(1, Math.round((p.radius * W) / 1920)), x = Math.max(0, Math.min(W - 2 * r, (W * p.x) / 100 - r)), y = Math.max(0, Math.min(H - 2 * r, (H * p.y) / 100 - r));
      const d = g.getImageData(x, y, 2 * r, 2 * r).data, s = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) s[j] += d[i + j];
      g.save(); g.globalAlpha = p.opacity; g.fillStyle = `rgb(${s.map((v) => Math.round(v / (d.length / 4))).join(',')})`; g.fillRect(0, 0, W, H); g.restore(); } },
  writeon: { label: 'Write-on', cat: 'Generate', params: { sx: { label: 'Brush start across', min: 0, max: 100, step: 0.5, def: 15, unit: '%' }, sy: { label: 'Brush start down', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, ex: { label: 'Brush end across', min: 0, max: 100, step: 0.5, def: 85, unit: '%' }, ey: { label: 'Brush end down', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, size: { label: 'Brush size', min: 1, max: 200, step: 1, def: 24, unit: 'px' }, start: { label: 'Starts at', min: 0, max: 30, step: 0.1, def: 0, unit: 's' }, dur: { label: 'Writes in', min: 0.1, max: 30, step: 0.1, def: 1.5, unit: 's' }, color: { label: 'Colour', type: 'color', def: '#ffffff' }, opacity: OPA, style: SEL('Paint style', [['on', 'On original image'], ['reveal', 'Reveal original image']], 'on') },
    // the brush moves from start to end in the given time; everything it has passed stays painted
    ff: (p, { W }) => { const r = f4(Math.max(0.5, (p.size * W) / 1920 / 2)), sx = `W*${f4(p.sx / 100)}`, sy = `H*${f4(p.sy / 100)}`, dx = `(W*${f4((p.ex - p.sx) / 100)})`, dy = `(H*${f4((p.ey - p.sy) / 100)})`;
      const a = `st(0,clip((T-${f4(p.start)})/${f4(p.dur)},0,1));st(1,clip(((X-${sx})*${dx}+(Y-${sy})*${dy})/max(1,${dx}*${dx}+${dy}*${dy}),0,ld(0)));gt(ld(0),0)*clip((${r}-hypot(X-${sx}-ld(1)*${dx},Y-${sy}-ld(1)*${dy}))/1.5+0.5,0,1)`;
      if (p.style === 'reveal') return rgbGeq((ch) => `${ch}(X,Y)*(${a})`);
      return paint(p.color, `(${a})*${f4(p.opacity)}`); },
    pix: (g, W, H, p, { rel = 0 }) => { const pr = Math.min(1, Math.max(0, (rel - p.start) / p.dur)), sx = (W * p.sx) / 100, sy = (H * p.sy) / 100;
      g.save(); g.lineCap = 'round'; g.lineWidth = Math.max(1, (p.size * W) / 1920); g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + ((W * (p.ex - p.sx)) / 100) * pr, sy + ((H * (p.ey - p.sy)) / 100) * pr);
      if (p.style === 'reveal') { g.globalCompositeOperation = 'destination-in'; g.strokeStyle = '#000'; if (pr > 0) g.stroke(); else g.clearRect(0, 0, W, H); } else if (pr > 0) { g.globalAlpha = p.opacity; g.strokeStyle = p.color; g.stroke(); }
      g.restore(); } },

  // ---------- Immersive Video (360 footage: equirectangular) ----------
  vrproj: { label: 'VR Projection', cat: 'Immersive Video', params: { pan: { label: 'Pan', min: -180, max: 180, step: 1, def: 0, unit: '°' }, tilt: { label: 'Tilt', min: -90, max: 90, step: 1, def: 0, unit: '°' }, roll: { label: 'Roll', min: -180, max: 180, step: 1, def: 0, unit: '°' }, fov: { label: 'Field of view', min: 20, max: 160, step: 1, def: 90, unit: '°' } },
    // a flat view looking into the sphere (the shot is a 360 equirectangular picture)
    ff: (p, { W, H }) => `v360=input=e:output=flat:yaw=${p.pan}:pitch=${p.tilt}:roll=${p.roll}:h_fov=${p.fov}:v_fov=${f4((2 * Math.atan(Math.tan((p.fov * Math.PI) / 360) * (H / W)) * 180) / Math.PI)}:w=${W}:h=${H},setsar=1` },
  vrrotate: { label: 'VR Rotate Sphere', cat: 'Immersive Video', params: { tilt: { label: 'Tilt (X axis)', min: -180, max: 180, step: 1, def: 0, unit: '°' }, pan: { label: 'Pan (Y axis)', min: -180, max: 180, step: 1, def: 0, unit: '°' }, roll: { label: 'Roll (Z axis)', min: -180, max: 180, step: 1, def: 0, unit: '°' } },
    ff: (p, { W, H }) => `v360=input=e:output=e:yaw=${p.pan}:pitch=${p.tilt}:roll=${p.roll}:w=${W}:h=${H},setsar=1` },
  vrplane: { label: 'VR Plane to Sphere', cat: 'Immersive Video', params: { pan: { label: 'Pan', min: -180, max: 180, step: 1, def: 0, unit: '°' }, tilt: { label: 'Tilt', min: -90, max: 90, step: 1, def: 0, unit: '°' }, fov: { label: 'Size (field of view)', min: 10, max: 180, step: 1, def: 60, unit: '°' } },
    // a flat shot laid onto the 360 sphere (black around it), to put over 360 footage on V2
    ff: (p, { W, H }) => `v360=input=flat:output=e:ih_fov=${p.fov}:iv_fov=${f4((2 * Math.atan(Math.tan((p.fov * Math.PI) / 360) * (H / W)) * 180) / Math.PI)}:yaw=${p.pan}:pitch=${p.tilt}:w=${W}:h=${H}:alpha_mask=1,premultiply=inplace=1,format=yuv420p,setsar=1` },

  // ---------- Keying ----------
  alphaadjust: { label: 'Alpha Adjust', cat: 'Keying', v2only: true, params: { opacity: { label: 'Opacity', min: 0, max: 100, step: 1, def: 100, unit: '%' }, mode: SEL('Alpha', [['keep', 'As it is'], ['ignore', 'Ignore alpha'], ['invert', 'Invert alpha'], ['only', 'Mask only']], 'keep') },
    ff: () => 'null',
    key: (p) => { const o = f4(p.opacity / 100), a = { ignore: '255', invert: '255-val', only: 'val' }[p.mode] || 'val'; return `format=yuva420p,lutyuv=${p.mode === 'only' ? 'y=235:u=128:v=128:' : ''}a='clip((${a})*${o},0,255)'`; },
    pix: (g, W, H, p) => { const im = g.getImageData(0, 0, W, H), d = im.data, o = p.opacity / 100;
      for (let i = 0; i < d.length; i += 4) { const a = p.mode === 'ignore' ? 255 : p.mode === 'invert' ? 255 - d[i + 3] : d[i + 3]; if (p.mode === 'only') d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = a * o; }
      g.putImageData(im, 0, 0); } },
  despill: { label: 'Spill Suppressor', cat: 'Keying', params: { color: SEL('Screen colour', [['green', 'Green'], ['blue', 'Blue']], 'green'), mix: { label: 'Suppression', min: 0, max: 1, step: 0.05, def: 0.5 }, expand: { label: 'Spread', min: 0, max: 1, step: 0.05, def: 0 } },
    // (Premiere: Ultra Key's spill suppression / Remove Matte) the green or blue cast left on the edges taken out
    ff: (p) => `format=gbrp,despill=type=${p.color === 'blue' ? 'blue' : 'green'}:mix=${f4(p.mix)}:expand=${f4(p.expand)},format=yuv420p` },

  // ---------- Noise & Grain ----------
  noisealpha: { label: 'Noise Alpha', cat: 'Noise & Grain', v2only: true, params: { amount: { label: 'Amount', min: 0, max: 100, step: 1, def: 50, unit: '%' } },
    // random holes in the layer's transparency, new each frame (the shot below shows through)
    ff: () => 'null', key: (p) => `format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*(1-${f4(p.amount / 100)}*(${RNDN}-floor(${RNDN})))'`,
    pix: (g, W, H, p) => { const im = g.getImageData(0, 0, W, H), d = im.data, a = p.amount / 100; for (let i = 3; i < d.length; i += 4) d[i] *= 1 - a * Math.random(); g.putImageData(im, 0, 0); } },

  // ---------- Perspective: on the layer's shape after Motion (final pass - the picture's own outline casts them) ----------
  dropshadow: { label: 'Drop Shadow', cat: 'Perspective', post: true, params: { color: { label: 'Shadow colour', type: 'color', def: '#000000' }, opacity: { label: 'Opacity', min: 0, max: 1, step: 0.05, def: 0.5 }, dir: { label: 'Direction', min: 0, max: 360, step: 1, def: 135, unit: '°' }, dist: { label: 'Distance', min: 0, max: 400, step: 1, def: 20, unit: 'px' }, soft: { label: 'Softness', min: 0, max: 200, step: 1, def: 20, unit: 'px' } },
    ff: () => 'null',
    post: (p, { W }) => { const k = W / 1920, a = (p.dir * Math.PI) / 180, dx = Math.round(Math.sin(a) * p.dist * k), dy = Math.round(-Math.cos(a) * p.dist * k);
      return (i, o) => shadowG(i, o, p, Math.max(0.01, (p.soft * k) / 2), `${dx}`, `${dy}`); },
    css: (p, k) => { const a = (p.dir * Math.PI) / 180; return { filter: `drop-shadow(${(Math.sin(a) * p.dist * k).toFixed(1)}px ${(-Math.cos(a) * p.dist * k).toFixed(1)}px ${(p.soft * k * 0.5).toFixed(1)}px ${rgba(p.color, p.opacity)})` }; } },
  radialshadow: { label: 'Radial Shadow', cat: 'Perspective', post: true, params: { color: { label: 'Shadow colour', type: 'color', def: '#000000' }, opacity: { label: 'Opacity', min: 0, max: 1, step: 0.05, def: 0.5 }, lx: { label: 'Light source across', min: -50, max: 150, step: 1, def: 30, unit: '%' }, ly: { label: 'Light source down', min: -50, max: 150, step: 1, def: 20, unit: '%' }, dist: { label: 'Projection distance', min: 0, max: 100, step: 1, def: 10, unit: '%' }, soft: { label: 'Softness', min: 0, max: 200, step: 1, def: 15, unit: 'px' } },
    // the outline thrown away from a point light: the shadow is the layer grown about the light
    post: (p, { W, H }) => { const s = 1 + p.dist / 100, x = Math.round((W * p.lx) / 100 * (1 - s)), y = Math.round((H * p.ly) / 100 * (1 - s));
      return (i, o) => shadowG(i, o, p, Math.max(0.01, (p.soft * W) / 1920 / 2), `${x}`, `${y}`, `scale=iw*${f4(s)}:ih*${f4(s)},`); },
    ff: () => 'null',
    css: (p, k) => { const dx = (50 - p.lx) * p.dist * 0.02, dy = (50 - p.ly) * p.dist * 0.02; return { filter: `drop-shadow(${(dx * 19.2 * k).toFixed(1)}px ${(dy * 10.8 * k).toFixed(1)}px ${(p.soft * k * 0.5).toFixed(1)}px ${rgba(p.color, p.opacity)})` }; } },
  bevelalpha: { label: 'Bevel Alpha', cat: 'Perspective', post: true, params: { edge: { label: 'Edge thickness', min: 1, max: 60, step: 0.5, def: 6, unit: 'px' }, angle: { label: 'Light angle', min: 0, max: 360, step: 1, def: 315, unit: '°' }, light: { label: 'Light intensity', min: 0, max: 1, step: 0.05, def: 0.5 } },
    // the layer's outline (its alpha, softened) embossed, laid on the picture as light and shade
    post: (p, { W }) => (i, o) => `[${i}]split[${o}p][${o}a];[${o}a]alphaextract,gblur=sigma=${f4(Math.max(0.5, (p.edge * W) / 1920))},convolution=0m='${embossK(p.angle, 2, 0).join(' ')}':0rdiv=1:0bias=128,format=yuva420p[${o}r];[${o}p][${o}r]blend=c0_mode=hardlight:c0_opacity=${f4(p.light)}:c1_mode=normal:c1_opacity=1:c2_mode=normal:c2_opacity=1:c3_mode=normal:c3_opacity=1[${o}]`,
    ff: () => 'null' },

  // ---------- Stylize ----------
  roughen: { label: 'Roughen Edges', cat: 'Stylize', params: { border: { label: 'Border', min: 1, max: 400, step: 1, def: 40, unit: 'px' }, rough: { label: 'Edge sharpness / roughness', min: 0, max: 1, step: 0.05, def: 0.6 }, scale: { label: 'Scale', min: 5, max: 400, step: 1, def: 60, unit: 'px' }, speed: { label: 'Evolution speed', min: 0, max: 5, step: 0.1, def: 0 } },
    // the frame's edge eaten away along a ragged line (black on V1)
    ff: (p, { W }) => { const k = W / 1920, B = f4(p.border * k), L = f4(Math.max(2, p.scale * k)), v = f4(p.speed);
      const nz = `(0.5+0.25*sin(X/${L}+T*${v})*cos(Y/(0.8*${L})-T*${v})+0.15*sin((X+Y)/(0.37*${L})+T*${v}*1.3)+0.1*sin((X-2*Y)/(0.19*${L})))`;
      return shade(`clip((min(min(X,W-1-X),min(Y,H-1-Y))-${B}*(1-${f4(p.rough)}+${f4(p.rough)}*${nz}))/1.5,0,1)`); } },
  texturize: { label: 'Texturize', cat: 'Stylize', params: { kind: SEL('Texture', [['canvas', 'Canvas'], ['brick', 'Brick'], ['burlap', 'Burlap']], 'canvas'), size: { label: 'Texture size', min: 2, max: 200, step: 1, def: 8, unit: 'px' }, relief: { label: 'Texture contrast', min: 0, max: 2, step: 0.05, def: 1 } },
    // a height pattern lit from the top left (its emboss), added to the brightness
    ff: (p, { W }) => { const s = f4(Math.max(1, (p.size * W) / 1920)), h = (x, y) => TEX[p.kind] ? TEX[p.kind](x, y, s) : TEX.canvas(x, y, s);
      return `format=yuv444p,geq=lum='clip(p(X,Y)+${f4(p.relief * 40)}*(${h('(X-1)', '(Y-1)')}-(${h('(X+1)', '(Y+1)')})),0,255)':cb='p(X,Y)':cr='p(X,Y)'`; } },

  // ---------- Transform ----------
  hhold: { label: 'Horizontal Hold', cat: 'Transform', params: { skew: { label: 'Skew', min: -100, max: 100, step: 1, def: 20, unit: '%' } },
    ff: (p) => warp(`p(mod(X+Y/H*W*${f4(p.skew / 100)}+100*W,W),Y)`) },
  vhold: { label: 'Vertical Hold', cat: 'Transform', params: { offset: { label: 'Offset', min: -100, max: 100, step: 1, def: 0, unit: '%' }, speed: { label: 'Roll (frames a second)', min: -5, max: 5, step: 0.05, def: 0.5 } },
    ff: (p) => warp(`p(X,mod(Y+H*(${f4(p.offset / 100)}+${f4(p.speed)}*T)+100*H,H))`) },

  // ---------- Transition ----------
  gradwipe: { label: 'Gradient Wipe', cat: 'Transition', params: { done: { label: 'Transition completion', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, soft: { label: 'Transition softness', min: 0, max: 100, step: 1, def: 10, unit: '%' }, pattern: SEL('Gradient layer', [['linear', 'Linear (left to right)'], ['radial', 'Radial (from the middle)'], ['diamond', 'Diamond'], ['clouds', 'Clouds'], ['self', 'The shot\'s own brightness']], 'linear'), invert: SEL('Invert gradient', [['off', 'Off'], ['on', 'On']], 'off') },
    // pixels whose gradient value is below the completion go black; softness blends the edge
    ff: (p) => { const g0 = GRAD[p.pattern] || GRAD.linear, gv = p.invert === 'on' ? `(1-${g0})` : g0, s = Math.max(0.005, p.soft / 100), c = (p.done / 100) * (1 + s) - s;
      return shade(`clip((${gv}-${f4(c)})/${f4(s)},0,1)`); },
    css: (p) => { const s = Math.max(0.5, p.soft), c = p.done * (1 + s / 100) - s, stops = `rgba(0,0,0,1) ${c.toFixed(1)}%, rgba(0,0,0,0) ${(c + s).toFixed(1)}%`;
      return p.pattern === 'linear' ? { overlay: `linear-gradient(${p.invert === 'on' ? 270 : 90}deg, ${stops})` } : p.pattern === 'radial' && p.invert !== 'on' ? { overlay: `radial-gradient(circle closest-corner at 50% 50%, ${stops})` } : {}; } },

  // ---------- done in Python with OpenCV (engine/pyfx.py): first in the stack, on the shot's own frames, before it is
  // rendered - seen in Accurate preview and renders (on a helper PC only when it has Python with OpenCV) ----------
  paintbucket: { label: 'Paint Bucket', cat: 'Generate', py: true, params: { x: { label: 'Fill point across (of the shot)', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, y: { label: 'Fill point down', min: 0, max: 100, step: 0.5, def: 50, unit: '%' }, tol: { label: 'Tolerance', min: 0, max: 100, step: 1, def: 10 }, color: { label: 'Colour', type: 'color', def: '#ff3b30' }, opacity: OPA, feather: { label: 'Feather', min: 0, max: 40, step: 0.5, def: 1, unit: 'px' }, mode: SEL('Paint', [['fill', 'Fill'], ['stroke', 'Stroke (the edge only)']], 'fill'), stroke: { label: 'Stroke width', min: 1, max: 40, step: 1, def: 6, unit: 'px' } },
    ff: () => 'null' },
  brushstrokes: { label: 'Brush Strokes', cat: 'Stylize', py: true, params: { angle: { label: 'Stroke angle', min: 0, max: 360, step: 1, def: 135, unit: '°' }, length: { label: 'Stroke length', min: 3, max: 80, step: 1, def: 18, unit: 'px' }, texture: { label: 'Stroke texture', min: 0, max: 3, step: 0.1, def: 1 }, blend: { label: 'Blend with original', min: 0, max: 1, step: 0.05, def: 0 } },
    ff: () => 'null' },
  rollingshutter: { label: 'Rolling Shutter Repair', cat: 'Distort', py: true, params: { rate: { label: 'Rolling shutter rate', min: 0, max: 100, step: 1, def: 50, unit: '%' }, order: SEL('Scan direction', [['top', 'Top to bottom'], ['bottom', 'Bottom to top']], 'top'), method: SEL('Method', [['shift', 'Displacement (whole frame)'], ['warp', 'Warp (band by band)']], 'shift') },
    ff: () => 'null' },

  // ---------- Video ----------
  sdrconform: { label: 'SDR Conform', cat: 'Video', params: { src: SEL('Source', [['pq', 'HDR10 (PQ)'], ['hlg', 'HLG']], 'pq'), method: SEL('Tone mapping', [['hable', 'Hable (filmic)'], ['mobius', 'Mobius (keeps colour)'], ['reinhard', 'Reinhard'], ['clip', 'Clip']], 'hable'), npl: { label: 'Reference white', min: 80, max: 1000, step: 1, def: 203, unit: ' nits' }, desat: { label: 'Highlight desaturation', min: 0, max: 2, step: 0.05, def: 0 } },
    // an HDR shot brought to normal (Rec.709) brightness and colour: to linear light, tone-mapped, back to 709
    ff: (p) => `zscale=tin=${p.src === 'hlg' ? 'arib-std-b67' : 'smpte2084'}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=${Math.round(p.npl)}:p=bt2020:m=bt2020nc:r=tv,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=${p.method}:desat=${f4(p.desat)},zscale=t=bt709:m=bt709:r=tv,format=yuv420p` },
};
// the 3 x 3 kernel as FFmpeg / SVG want it
const KERN = (p) => [11, 12, 13, 21, 22, 23, 31, 32, 33].map((k) => Math.round(p[`m${k}`])).join(' ');
// Shadow/Highlight: shadows lifted by s, highlights pulled down by h (x 0..1 - the curve as an FFmpeg expression and in JS)
const SHL = (x, p) => `(${x}+${f4((p.shadows / 100) * 1.7)}*${x}*pow(1-${x},3)-${f4((p.highlights / 100) * 1.7)}*pow(${x},3)*(1-${x}))`;
const shl = (x, p) => x + (p.shadows / 100) * 1.7 * x * (1 - x) ** 3 - (p.highlights / 100) * 1.7 * x ** 3 * (1 - x);
// a fixed random number for each pixel and frame (fraction below) - Noise Alpha
const RNDN = 'sin(X*12.9898+Y*78.233+N*37.719)*43758.5453';
// Lightning: how far the bolt bends at u (0..1 along it) in flash n; geq: ld(4) = this pixel's distance from the bolt
const boltOff = (u, n, A) => A * Math.sin(Math.PI * u) * (0.5 * Math.sin(u * 17 + n * 2.1) + 0.3 * Math.sin(u * 41 + n * 5.3) + 0.2 * Math.sin(u * 97 + n * 9.7));
function bolt(p, k, Wv, Hv) {
  const sx = `${Wv}*${f4(p.sx / 100)}`, sy = `${Hv}*${f4(p.sy / 100)}`, dx = `(${Wv}*${f4((p.ex - p.sx) / 100)})`, dy = `(${Hv}*${f4((p.ey - p.sy) / 100)})`, L = `max(1,hypot(${dx},${dy}))`;
  return `st(0,((X-${sx})*${dx}+(Y-${sy})*${dy})/(${L}*${L}));st(1,((Y-${sy})*${dx}-(X-${sx})*${dy})/${L});st(2,floor(T*${f4(p.speed)}));` +
    `st(3,${f4(p.amp * k)}*sin(PI*clip(ld(0),0,1))*(0.5*sin(ld(0)*17+ld(2)*2.1)+0.3*sin(ld(0)*41+ld(2)*5.3)+0.2*sin(ld(0)*97+ld(2)*9.7)));st(4,if(between(ld(0),0,1),abs(ld(1)-ld(3)),1e5))`;
}
// Cell Pattern: the 9 nearest cell points (one per grid cell, moving a little), the smallest distance kept in ld(9)
const CELLS = (s, v) => [-1, 0, 1].flatMap((dj) => [-1, 0, 1].map((di) => { const i = `(ld(0)+${di})`, j = `(ld(1)+${dj})`;
  return `st(9,min(ld(9),hypot(X-(${i}+0.5+0.4*sin(sin(${i}*127.1+${j}*311.7)*43758+T*${v}))*${s},Y-(${j}+0.5+0.4*sin(sin(${i}*269.5+${j}*183.3)*43758+T*${v}*1.3))*${s})))`; })).join(';');
// Texturize: height patterns h(x, y) -1..1 (s = the texture's size in pixels)
const TEX = {
  canvas: (x, y, s) => `(0.6*sin(2*PI*${x}/${s})*sin(2*PI*${y}/${s})+0.4*sin(2*PI*(${x}+${y})/(1.7*${s})))`,
  burlap: (x, y, s) => `(0.5*sin(2*PI*${x}/${s}+2*sin(${y}/(3*${s})))+0.5*sin(2*PI*${y}/${s}+2*sin(${x}/(3*${s}))))`,
  brick: (x, y, s) => `(1-2*max(lt(mod(${y},4*${s}),${s}/2),lt(mod(${x}+if(mod(floor(${y}/(4*${s})),2),4*${s},0),8*${s}),${s}/2)))`,
};
// Gradient Wipe: the gradient layers, 0..1 (as geq expressions on yuv444p)
const GRAD = { linear: '(X/W)', radial: 'clip(hypot(X/W-0.5,(Y/H-0.5)*H/W)/hypot(0.5,0.5*H/W),0,1)', diamond: 'clip(abs(X/W-0.5)+abs(Y/H-0.5),0,1)',
  clouds: 'clip(0.5+0.22*sin(X/W*7.3+sin(Y/H*5.1)*2)+0.18*sin(Y/H*9.7-sin(X/W*3.3)*2)+0.1*sin((X+Y)/W*23),0,1)', self: '((p(X,Y)-16)/219)' };
// a shadow of the layer's alpha: in its colour, softened, moved (dx, dy) - and the layer laid on it (yuva in, yuva out)
function shadowG(i, o, p, sigma, dx, dy, grow = '') {
  const [Y, U, V] = yuvOf(p.color);
  return `[${i}]split=3[${o}p][${o}s][${o}z];[${o}z]lutyuv=a=0[${o}b];[${o}s]${grow}lutyuv=y=${Y}:u=${U}:v=${V}:a='val*${f4(p.opacity)}',gblur=sigma=${f4(sigma)}:planes=8[${o}h];` +
    `[${o}b][${o}h]overlay=x=${dx}:y=${dy}:format=yuv420[${o}c];[${o}c][${o}p]overlay=format=yuv420[${o}]`;
}
// a colour in limited-range BT.709 YUV
const yuvOf = (c) => { const [r, g, b] = rgbOf(c).map((v) => v / 255), y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [Math.round(16 + 219 * y), Math.round(128 + 224 * ((b - y) / 1.8556)), Math.round(128 + 224 * ((r - y) / 1.5748))]; };
// 🎨 the Blend effect of a layer, if any: { mode, amount, css (mix-blend-mode) } - the render and the viewer use it
export function blendOf(c) {
  const e = activeEffects(c).find((x) => VFX[x.type]?.blend);
  if (!e) return null;
  const b = VFX[e.type].blend(e.p || {});
  return { ...b, css: { crossfade: 'normal', colour: 'color', tint: 'color', darken: 'darken', lighten: 'lighten', multiply: 'multiply', screen: 'screen', overlay: 'overlay', difference: 'difference' }[b.mode] || 'normal' };
}
// ▱ the effects that work on the layer's shape after Motion (final pass), in order
export const postEffects = (c) => activeEffects(c).filter((e) => VFX[e.type]?.post);
// 🐍 the effects done by engine/pyfx.py (OpenCV), as it wants them: [{ type, p }] with every parameter filled in
export const pyEffects = (c) => activeEffects(c).filter((e) => VFX[e.type]?.py).map((e) => ({ type: e.type, p: { ...defaultsOf(e.type), ...(e.p || {}) } }));
// the transitions done by engine/pyfx.py (Morph Cut); the project uses Python when a clip has one of these or a py effect
export const PY_TRANSITIONS = new Set(['morphcut']);
export const usesPython = (project) => JSON.stringify(project?.tracks || {}).match(/"type":"(\w+)"/g)?.some((m) => { const t = m.slice(8, -1); return VFX[t]?.py || PY_TRANSITIONS.has(t); }) || false;
// every parameter filled in (numbers as numbers) before an effect's ff / css / pix / key sees it
function withDefaults(d) {
  const fill = (p) => Object.fromEntries(Object.entries(d.params).map(([k, x]) => [k, typeof x.def === 'number' ? n(p?.[k], x.def) : p?.[k] ?? x.def]));
  const o = { ...d, ff: (p, ctx = {}) => d.ff(fill(p), ctx) };
  if (d.css) o.css = (p, k = 0.3) => d.css(fill(p), k);
  if (d.pix) o.pix = (g, W, H, p, info = {}) => d.pix(g, W, H, fill(p), info);
  if (d.key) o.key = (p) => d.key(fill(p));
  if (d.post) o.post = (p, ctx = {}) => d.post(fill(p), ctx);
  if (d.blend) o.blend = (p) => d.blend(fill(p));
  return o;
}
for (const [k, d] of Object.entries(MORE)) VFX[k] = withDefaults(d);
Object.assign(VFX, VFX_PIC); // (they fill their own defaults: keyframes and AI mattes ride in p)
export const VFX_CATS = [...new Set(Object.values(VFX).map((x) => x.cat))];
export const defaultsOf = (type) => Object.fromEntries(Object.entries(VFX[type]?.params || {}).map(([k, d]) => [k, d.def]));
export const newEffect = (type) => ({ id: uid(), type, on: true, p: defaultsOf(type) });
export const activeEffects = (c) => (c?.effects || []).filter((e) => e.on !== false && VFX[e.type]);

// 🎥 how a shot is stabilised (vid.stab): the Warp Stabilizer effect's settings - or the simple Stabilize level - as
// vid.stab's numbers. The render (render2.mjs) and the monitor's stabilised copy (server /api/stab) both use these,
// so what the monitor shows is what the export makes. key: the same settings give the same copy. null: not stabilised.
// Measured on a steady DJI drone shot (feature tracking, 4K px of shake: the shot itself 0.40): the old settings made it
// 2.5x shakier (1.07) - vid.stab read the sky and clouds as camera shake, and its newer L1 path follower jiggled the
// frame. mincontrast=0.5 (flat areas are not measured) + the Gaussian path: 0.50 - and a shot shaken by hand (116 px)
// comes out at 0.71 where the old ones left 3.66. Crop + Auto-scale is one zoom for the whole shot (like Premiere),
// not a zoom that breathes.
export function stabOf(c) {
  const ws = activeEffects(c).find((e) => VFX[e.type]?.stab); // (the effect wins over the simple Stabilize)
  if (!ws && !c?.stabilize) return null;
  const p = ws?.p || {}, st = { light: [5, 12], medium: [7, 20], strong: [10, 35] }[c.stabilize] || [7, 20];
  const detailed = p.detail === 'on', tripod = !!ws && p.result === 'nomotion';
  const s = {
    shake: ws ? (detailed ? 9 : 6) : st[0], acc: detailed ? 15 : 12, tripod,
    smoothing: ws ? Math.max(1, Math.round((Math.min(100, Math.max(1, +p.smoothness || 50)) / 100) * 60)) : st[1],
    framing: ws ? ({ stabilize: 'optzoom=0:crop=black', crop: 'optzoom=1', synth: 'optzoom=0:crop=keep', cropscale: 'optzoom=1' }[p.framing] || 'optzoom=1') : 'optzoom=1:zoomspeed=0.2',
    extra: ws ? Math.max(0, Math.min(50, (+p.addscale || 100) - 100)) : 0, noTurn: p.method === 'position',
  };
  s.detect = `vidstabdetect=shakiness=${s.shake}:accuracy=${s.acc}:mincontrast=0.5${tripod ? ':tripod=1' : ''}`;
  s.transform = `optalgo=gauss:smoothing=${s.smoothing}:${s.framing}${s.extra ? `:zoom=${s.extra}` : ''}${tripod ? ':tripod=1' : ''}${s.noTurn ? ':maxangle=0' : ''}:interpol=bicubic`;
  s.key = `${s.detect}|${s.transform}`;
  return s;
}

// live preview: the combined CSS of a clip's effects; k = viewer px per 1920-wide output px
// (an effect with a mask is left out here - the viewer lays it over just the masked part, maskedEffectsCss)
// rel: seconds into the clip - an effect with a time window (e.from / e.to, Labs) shows only inside it
export const inWindow = (e, rel) => rel === undefined || ((e.from === undefined || rel >= e.from) && (e.to === undefined || rel <= e.to));
export function effectsCss(c, k = 0.3, rel) {
  const f = [], t = [], ov = [];
  let clip = '', grain = false;
  for (const e of activeEffects(c)) {
    if (e.mask?.shape || !inWindow(e, rel)) continue;
    const r = VFX[e.type].css?.(e.p || {}, k);
    if (!r) continue;
    if (r.filter) f.push(r.filter);
    if (r.transform) t.push(r.transform);
    if (r.clip) clip = r.clip;
    if (r.grain) grain = r.overlay; else if (r.overlay) ov.push(r.overlay);
    if (r.overlays) ov.push(...r.overlays); // (more than one: 🎞 Limelight Film's vignette next to its grain)
  }
  // overlay: backgrounds laid over the picture (vignette) - the viewer draws them on a layer above the shot
  return { filter: f.join(' '), transform: t.join(' '), clip, overlay: ov.join(', '), grain };
}
// ◯ the masked effects that have a live look: [{ id, filter, mask }]
export const maskedEffectsCss = (c, k = 0.3) => activeEffects(c).filter((e) => e.mask?.shape).map((e) => ({ id: e.id, filter: VFX[e.type].css?.(e.p || {}, k)?.filter || '', mask: e.mask })).filter((x) => x.filter);
