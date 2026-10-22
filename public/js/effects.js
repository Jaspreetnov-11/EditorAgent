// Clip video effects (Premiere's "Video Effects"): clip.effects = [{ id, type, on, p: { param: value } }], applied in
// order to the picture before Motion (position / scale / rotation). One registry for the Effects panel, Effect
// Controls, the viewer (a CSS approximation) and engine/render2.mjs (exact FFmpeg filters).
//   ff(p, ctx)  -> a filter chain (string), or { graph(inLabel, outLabel) } for effects that need several streams
//   css(p)      -> { filter, transform, clip } for live preview (null / missing = shown in Accurate preview only)
// ctx = { W, H } output size in pixels (amounts are given for a 1920-wide frame and scaled).
import { uid } from './model.js';

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
export function effectsCss(c, k = 0.3) {
  const f = [], t = [], ov = [];
  let clip = '', grain = false;
  for (const e of activeEffects(c)) {
    if (e.mask?.shape) continue;
    const r = VFX[e.type].css?.(e.p || {}, k);
    if (!r) continue;
    if (r.filter) f.push(r.filter);
    if (r.transform) t.push(r.transform);
    if (r.clip) clip = r.clip;
    if (r.grain) grain = r.overlay; else if (r.overlay) ov.push(r.overlay);
  }
  // overlay: backgrounds laid over the picture (vignette) - the viewer draws them on a layer above the shot
  return { filter: f.join(' '), transform: t.join(' '), clip, overlay: ov.join(', '), grain };
}
// ◯ the masked effects that have a live look: [{ id, filter, mask }]
export const maskedEffectsCss = (c, k = 0.3) => activeEffects(c).filter((e) => e.mask?.shape).map((e) => ({ id: e.id, filter: VFX[e.type].css?.(e.p || {}, k)?.filter || '', mask: e.mask })).filter((x) => x.filter);
