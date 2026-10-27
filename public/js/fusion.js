// ✨ Fusion (Resolve-style node compositing) - the engine. A fusion is a graph of nodes; each node makes a picture
// (a canvas) from its inputs. The same code draws the Fusion page, the Edit viewer and the bake (a fusion on the
// timeline is a graphic clip { tpl: 'fusion', fusionId, fusion } that graphics.js hands to drawFusion).
//
// fusion = { id, name, w, h, dur, out: nodeId, nodes: [{ id, type, x, y, p: { params }, in: { slot: nodeId } }] }
// Params may be animated like Motion properties ({ k: [keys] }, motion.js val) - the inspector sets plain values.
import { val } from './motion.js';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const uidF = () => Math.random().toString(36).slice(2, 9);
const hex = (c) => { const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(c || ''); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : [255, 255, 255]; };
const BL = { normal: 'source-over', screen: 'screen', add: 'lighter', multiply: 'multiply', overlay: 'overlay', lighten: 'lighten', darken: 'darken', difference: 'difference', softlight: 'soft-light', hardlight: 'hard-light', color: 'color' };

// ---- node types: inputs, params (k, label, kind, default, min, max, step), colour in the graph ----
export const NODES = {
  mediaIn: { label: 'MediaIn', group: 'I/O', color: '#3fae6b', ins: [], params: [['mediaId', 'Clip', 'media', null], ['srcIn', 'Source start (s)', 'num', 0, 0, 99999, 0.04], ['speed', 'Speed', 'num', 1, 0.1, 8, 0.05], ['fit', 'Fit', 'select', 'cover', ['cover', 'contain', 'stretch']]] },
  mediaOut: { label: 'MediaOut', group: 'I/O', color: '#d0d4dc', ins: ['input'], params: [] },
  background: { label: 'Background', group: 'Generate', color: '#c94f4f', ins: [], params: [['type', 'Type', 'select', 'solid', ['solid', 'vertical', 'horizontal', 'radial']], ['c1', 'Colour 1', 'color', '#0b2545'], ['c2', 'Colour 2', 'color', '#ff9933'], ['alpha', 'Opacity %', 'num', 100, 0, 100, 1]] },
  text: { label: 'Text+', group: 'Generate', color: '#9b6bff', ins: ['input'], // (optional: the picture the text is written over)
    params: [['text', 'Text', 'text', 'LIMELIGHT'], ['font', 'Font', 'select', 'Nirmala UI', ['Nirmala UI', 'Segoe UI', 'Arial', 'Impact', 'Georgia', 'Bahnschrift', 'Mangal']], ['size', 'Size', 'num', 140, 8, 800, 1], ['weight', 'Weight', 'select', '800', ['400', '600', '700', '800', '900']], ['color', 'Colour', 'color', '#ffffff'], ['x', 'Centre X %', 'num', 50, -50, 150, 0.5], ['y', 'Centre Y %', 'num', 50, -50, 150, 0.5], ['tracking', 'Tracking', 'num', 0, -50, 400, 1], ['stroke', 'Outline width', 'num', 0, 0, 40, 0.5], ['strokeColor', 'Outline colour', 'color', '#000000']] },
  transform: { label: 'Transform', group: 'Transform', color: '#2f8cff', ins: ['input'], params: [['x', 'Move X px', 'num', 0, -4000, 4000, 1], ['y', 'Move Y px', 'num', 0, -4000, 4000, 1], ['scale', 'Size %', 'num', 100, 1, 1000, 1], ['rotation', 'Angle °', 'num', 0, -3600, 3600, 0.5], ['flip', 'Flip', 'select', 'none', ['none', 'horizontal', 'vertical']], ['opacity', 'Opacity %', 'num', 100, 0, 100, 1]] },
  color: { label: 'Color Corrector', group: 'Color', color: '#ff9933', ins: ['input'], params: [['brightness', 'Brightness %', 'num', 100, 0, 300, 1], ['contrast', 'Contrast %', 'num', 100, 0, 300, 1], ['saturation', 'Saturation %', 'num', 100, 0, 400, 1], ['hue', 'Hue °', 'num', 0, -180, 180, 1], ['tint', 'Tint colour', 'color', '#ff9933'], ['tintAmt', 'Tint %', 'num', 0, 0, 100, 1]] },
  duotone: { label: 'Duotone', group: 'Color', color: '#ff9933', ins: ['input'], params: [['dark', 'Shadows', 'color', '#0b2545'], ['light', 'Highlights', 'color', '#ffb15c'], ['mix', 'Mix %', 'num', 100, 0, 100, 1]] },
  blur: { label: 'Blur', group: 'Blur', color: '#5aa0ff', ins: ['input'], params: [['radius', 'Radius px', 'num', 12, 0, 200, 0.5]] },
  glow: { label: 'Glow', group: 'Blur', color: '#5aa0ff', ins: ['input'], params: [['radius', 'Spread px', 'num', 30, 0, 200, 1], ['intensity', 'Intensity %', 'num', 120, 0, 400, 1], ['threshold', 'Only bright parts %', 'num', 60, 0, 100, 1], ['color', 'Glow colour', 'color', '#ffffff'], ['tinted', 'Colour the glow', 'select', 'no', ['no', 'yes']]] },
  merge: { label: 'Merge', group: 'Composite', color: '#e0c050', ins: ['background', 'foreground', 'mask'], params: [['blend', 'Apply mode', 'select', 'normal', Object.keys(BL)], ['opacity', 'Blend %', 'num', 100, 0, 100, 1], ['x', 'Foreground X px', 'num', 0, -4000, 4000, 1], ['y', 'Foreground Y px', 'num', 0, -4000, 4000, 1], ['scale', 'Foreground size %', 'num', 100, 1, 1000, 1], ['shadow', 'Drop shadow', 'num', 0, 0, 200, 1]] },
  rectMask: { label: 'Rectangle Mask', group: 'Mask', color: '#8a8f99', ins: [], params: [['x', 'Centre X %', 'num', 50, -50, 150, 0.5], ['y', 'Centre Y %', 'num', 50, -50, 150, 0.5], ['w', 'Width %', 'num', 60, 0, 300, 0.5], ['h', 'Height %', 'num', 60, 0, 300, 0.5], ['round', 'Corner radius', 'num', 0, 0, 1000, 1], ['soft', 'Soft edge px', 'num', 20, 0, 400, 1], ['invert', 'Invert', 'select', 'no', ['no', 'yes']]] },
  ellipseMask: { label: 'Ellipse Mask', group: 'Mask', color: '#8a8f99', ins: [], params: [['x', 'Centre X %', 'num', 50, -50, 150, 0.5], ['y', 'Centre Y %', 'num', 50, -50, 150, 0.5], ['w', 'Width %', 'num', 60, 0, 300, 0.5], ['h', 'Height %', 'num', 70, 0, 300, 0.5], ['soft', 'Soft edge px', 'num', 60, 0, 400, 1], ['invert', 'Invert', 'select', 'no', ['no', 'yes']]] },
  // ✂ one-click roto: the subject of the clip, cut out with an AI matte (engine/matte.py, made by the Inspector button)
  // inputs add / remove: mask nodes (Rectangle / Ellipse Mask) for what the AI missed / took by mistake
  subject: { label: 'Subject Matte (AI)', group: 'Matte', color: '#36c27e', ins: ['input', 'add', 'remove'], params: [['matte', 'Subject', 'matte', null], ['mode', 'Show', 'select', 'cutout', ['cutout', 'background', 'matte']],
    ['choke', 'Shrink (+) / grow (−)', 'num', 0, -40, 40, 1], ['edge', 'Edge softness %', 'num', 100, 0, 100, 1], ['soft', 'Blur edge px', 'num', 1, 0, 30, 0.5]] },
  chromaKey: { label: 'Chroma Keyer', group: 'Matte', color: '#36c27e', ins: ['input'], params: [['key', 'Screen colour', 'color', '#00b140'], ['tolerance', 'Tolerance %', 'num', 30, 0, 100, 1], ['soft', 'Softness %', 'num', 12, 0, 100, 1], ['spill', 'Spill removal %', 'num', 60, 0, 100, 1]] },
  vignette: { label: 'Vignette', group: 'Film', color: '#b07cff', ins: ['input'], params: [['amount', 'Amount %', 'num', 55, 0, 100, 1], ['size', 'Size %', 'num', 70, 10, 150, 1], ['soft', 'Softness %', 'num', 60, 1, 100, 1], ['color', 'Colour', 'color', '#000000']] },
  grain: { label: 'Film Grain', group: 'Film', color: '#b07cff', ins: ['input'], params: [['amount', 'Amount %', 'num', 18, 0, 100, 1], ['size', 'Grain size', 'num', 2, 1, 6, 1], ['mono', 'Black & white grain', 'select', 'yes', ['yes', 'no']]] },
  split: { label: 'Chromatic Split', group: 'Stylize', color: '#ff5a8a', ins: ['input'], params: [['offset', 'Offset px', 'num', 8, 0, 100, 0.5], ['angle', 'Angle °', 'num', 0, -180, 180, 1], ['pulse', 'Pulse with time', 'select', 'no', ['no', 'yes']]] },
  glitch: { label: 'Glitch', group: 'Stylize', color: '#ff5a8a', ins: ['input'], params: [['amount', 'Amount %', 'num', 40, 0, 100, 1], ['slices', 'Slices', 'num', 12, 1, 60, 1], ['speed', 'Changes per second', 'num', 8, 1, 30, 1], ['rgb', 'Colour split', 'select', 'yes', ['yes', 'no']]] },
  lightLeak: { label: 'Light Leak', group: 'Film', color: '#ffcc33', ins: ['input'], params: [['color', 'Colour', 'color', '#ff7a1a'], ['color2', 'Second colour', 'color', '#ffd166'], ['amount', 'Strength %', 'num', 65, 0, 100, 1], ['speed', 'Drift speed', 'num', 1, 0, 10, 0.1], ['side', 'From', 'select', 'left', ['left', 'right', 'top', 'corner']]] },
  letterbox: { label: 'Letterbox', group: 'Film', color: '#b07cff', ins: ['input'], params: [['ratio', 'Aspect', 'select', '2.39', ['2.39', '2.0', '1.85']], ['color', 'Bar colour', 'color', '#000000']] },
  // (added 2026-10-28: more nodes to build by hand)
  levels: { label: 'Levels', group: 'Color', color: '#ff9933', ins: ['input'], params: [['black', 'Black point %', 'num', 0, 0, 90, 0.5], ['white', 'White point %', 'num', 100, 10, 100, 0.5], ['gamma', 'Midtones (gamma)', 'num', 1, 0.2, 3, 0.01], ['outBlack', 'Lift blacks %', 'num', 0, 0, 60, 0.5]] },
  blackWhite: { label: 'Black & White', group: 'Color', color: '#ff9933', ins: ['input'], params: [['contrast', 'Contrast %', 'num', 115, 0, 300, 1], ['mix', 'Mix %', 'num', 100, 0, 100, 1]] },
  invert: { label: 'Invert', group: 'Color', color: '#ff9933', ins: ['input'], params: [['mix', 'Mix %', 'num', 100, 0, 100, 1]] },
  posterize: { label: 'Posterize', group: 'Stylize', color: '#ff5a8a', ins: ['input'], params: [['levels', 'Colour levels', 'num', 5, 2, 32, 1]] },
  pixelate: { label: 'Pixelate', group: 'Stylize', color: '#ff5a8a', ins: ['input'], params: [['size', 'Block size px', 'num', 24, 1, 300, 1]] },
  sharpen: { label: 'Sharpen', group: 'Blur', color: '#5aa0ff', ins: ['input'], params: [['amount', 'Amount %', 'num', 60, 0, 300, 1]] },
  zoomBlur: { label: 'Zoom Blur', group: 'Blur', color: '#5aa0ff', ins: ['input'], params: [['amount', 'Amount %', 'num', 20, 0, 100, 1], ['x', 'Centre X %', 'num', 50, 0, 100, 0.5], ['y', 'Centre Y %', 'num', 50, 0, 100, 0.5]] },
  mirror: { label: 'Mirror', group: 'Transform', color: '#2f8cff', ins: ['input'], params: [['mode', 'Mirror', 'select', 'left', ['left', 'right', 'top', 'bottom', 'quad']]] },
  crop: { label: 'Crop', group: 'Transform', color: '#2f8cff', ins: ['input'], params: [['left', 'Left %', 'num', 0, 0, 100, 0.5], ['right', 'Right %', 'num', 0, 0, 100, 0.5], ['top', 'Top %', 'num', 0, 0, 100, 0.5], ['bottom', 'Bottom %', 'num', 0, 0, 100, 0.5], ['soft', 'Soft edge px', 'num', 0, 0, 200, 1]] },
  shake: { label: 'Camera Shake', group: 'Transform', color: '#2f8cff', ins: ['input'], params: [['amount', 'Amount px', 'num', 18, 0, 200, 1], ['speed', 'Shakes per second', 'num', 12, 1, 40, 1], ['rotate', 'Rotate °', 'num', 1.5, 0, 20, 0.1], ['zoom', 'Zoom in % (hides edges)', 'num', 6, 0, 50, 0.5]] },
  gradientMask: { label: 'Gradient Mask', group: 'Mask', color: '#8a8f99', ins: [], params: [['angle', 'Direction °', 'num', 90, -180, 180, 1], ['pos', 'Middle %', 'num', 50, -50, 150, 0.5], ['soft', 'Softness %', 'num', 40, 0, 200, 1], ['invert', 'Invert', 'select', 'no', ['no', 'yes']]] },
};
export const GROUPS = ['I/O', 'Generate', 'Composite', 'Color', 'Blur', 'Mask', 'Matte', 'Film', 'Stylize', 'Transform'];
// the presets' groups in the drop-down (STYLES[k].cat)
export const STYLE_CATS = ['Basic', 'Looks', 'Film', 'Glow & light', 'Stylize', 'Motion', 'Text & titles', 'Composite', 'Matte & roto'];
export function newNode(type, x = 0, y = 0, p = {}) {
  const d = NODES[type];
  return { id: uidF(), type, x, y, p: { ...Object.fromEntries(d.params.map(([k, , , def]) => [k, def])), ...p }, in: {} };
}
const P = (n, k, t) => { const v = val(n.p?.[k], t); return v ?? NODES[n.type].params.find((x) => x[0] === k)?.[3]; };

// ---- drawing ----
function cnv(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
// evaluate the graph at t; returns the canvas of node `id` (W x H, transparent where nothing is)
export function evalNode(f, id, t, W, H, opts, memo = new Map(), depth = 0) {
  if (memo.has(id)) return memo.get(id);
  const n = f.nodes.find((x) => x.id === id);
  if (!n || depth > 60) return null;
  const k = W / (f.w || W); // params are in fusion pixels; the canvas may be smaller (viewer)
  const inp = (slot) => (n.in?.[slot] ? evalNode(f, n.in[slot], t, W, H, opts, memo, depth + 1) : null);
  const out = cnv(W, H), g = out.getContext('2d'), p = (key) => P(n, key, t);
  switch (n.type) {
    case 'mediaIn': {
      const st = (+p('srcIn') || 0) + t * (+p('speed') || 1), el = opts.video?.(p('mediaId'), st, +p('speed') || 1);
      if (el) {
        const sw = el.videoWidth || el.naturalWidth || W, sh = el.videoHeight || el.naturalHeight || H, fit = p('fit');
        const s = fit === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
        if (fit === 'stretch') g.drawImage(el, 0, 0, W, H); else g.drawImage(el, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s);
      } else if (opts.placeholder) { g.fillStyle = '#ffffff10'; g.fillRect(0, 0, W, H); }
      break;
    }
    case 'mediaOut': { const a = inp('input'); if (a) g.drawImage(a, 0, 0); break; }
    case 'background': {
      const ty = p('type'), c1 = p('c1'), c2 = p('c2');
      let fill = c1;
      if (ty === 'vertical') { fill = g.createLinearGradient(0, 0, 0, H); fill.addColorStop(0, c1); fill.addColorStop(1, c2); }
      if (ty === 'horizontal') { fill = g.createLinearGradient(0, 0, W, 0); fill.addColorStop(0, c1); fill.addColorStop(1, c2); }
      if (ty === 'radial') { fill = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2); fill.addColorStop(0, c1); fill.addColorStop(1, c2); }
      g.globalAlpha = clamp((+p('alpha')) / 100); g.fillStyle = fill; g.fillRect(0, 0, W, H);
      break;
    }
    case 'text': {
      { const under = inp('input'); if (under) g.drawImage(under, 0, 0); } // written over its input, when it has one
      const size = (+p('size') || 100) * k;
      g.font = `${p('weight')} ${size}px "${String(p('font')).replace(/"/g, '')}", "Nirmala UI", Arial, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if ('letterSpacing' in g) g.letterSpacing = `${(+p('tracking') || 0) * size / 1000}px`;
      const lines = String(p('text') ?? '').split('\n'), lh = size * 1.15, x = (W * p('x')) / 100, y0 = (H * p('y')) / 100 - ((lines.length - 1) * lh) / 2;
      lines.forEach((ln, i) => {
        if (+p('stroke') > 0) { g.lineWidth = +p('stroke') * k * 2; g.strokeStyle = p('strokeColor'); g.lineJoin = 'round'; g.strokeText(ln, x, y0 + i * lh); }
        g.fillStyle = p('color'); g.fillText(ln, x, y0 + i * lh);
      });
      break;
    }
    case 'transform': {
      const a = inp('input'); if (!a) break;
      g.globalAlpha = clamp(+p('opacity') / 100);
      g.translate(W / 2 + (+p('x') || 0) * k, H / 2 + (+p('y') || 0) * k); g.rotate(((+p('rotation') || 0) * Math.PI) / 180);
      const s = (+p('scale') || 100) / 100; g.scale(s * (p('flip') === 'horizontal' ? -1 : 1), s * (p('flip') === 'vertical' ? -1 : 1));
      g.drawImage(a, -W / 2, -H / 2);
      break;
    }
    case 'color': {
      const a = inp('input'); if (!a) break;
      g.filter = `brightness(${p('brightness') / 100}) contrast(${p('contrast') / 100}) saturate(${p('saturation') / 100}) hue-rotate(${p('hue')}deg)`;
      g.drawImage(a, 0, 0); g.filter = 'none';
      if (+p('tintAmt') > 0) { g.globalCompositeOperation = 'color'; g.globalAlpha = clamp(p('tintAmt') / 100); g.fillStyle = p('tint'); g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'destination-in'; g.globalAlpha = 1; g.drawImage(a, 0, 0); }
      break;
    }
    case 'duotone': {
      const a = inp('input'); if (!a) break;
      g.drawImage(a, 0, 0);
      const d = g.getImageData(0, 0, W, H), px = d.data, A = hex(p('dark')), B = hex(p('light')), m = clamp(p('mix') / 100);
      for (let i = 0; i < px.length; i += 4) { const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255; for (let c = 0; c < 3; c++) px[i + c] = px[i + c] * (1 - m) + (A[c] + (B[c] - A[c]) * l) * m; }
      g.putImageData(d, 0, 0);
      break;
    }
    case 'blur': { const a = inp('input'); if (!a) break; g.filter = `blur(${(+p('radius') || 0) * k}px)`; g.drawImage(a, 0, 0); g.filter = 'none'; break; }
    case 'glow': {
      const a = inp('input'); if (!a) break;
      g.drawImage(a, 0, 0);
      // the bright parts, blurred, added on top
      const b = cnv(W, H), bg = b.getContext('2d'), th = clamp(p('threshold') / 100);
      bg.filter = `brightness(${1 - th * 0.6}) contrast(${1 + th * 4})`; bg.drawImage(a, 0, 0); bg.filter = 'none';
      if (p('tinted') === 'yes') { bg.globalCompositeOperation = 'source-in'; bg.fillStyle = p('color'); bg.globalAlpha = 0.85; bg.fillRect(0, 0, W, H); }
      const c = cnv(W, H), cg = c.getContext('2d'); cg.filter = `blur(${(+p('radius') || 0) * k}px)`; cg.drawImage(b, 0, 0);
      g.globalCompositeOperation = 'lighter'; let left = (+p('intensity') || 0) / 100;
      while (left > 0) { g.globalAlpha = Math.min(1, left); g.drawImage(c, 0, 0); left -= 1; }
      break;
    }
    case 'merge': {
      const bgc = inp('background'), fg = inp('foreground'), mask = inp('mask');
      if (bgc) g.drawImage(bgc, 0, 0);
      if (fg) {
        let F = fg;
        if (mask) { F = cnv(W, H); const fg2 = F.getContext('2d'); fg2.drawImage(fg, 0, 0); fg2.globalCompositeOperation = 'destination-in'; fg2.drawImage(mask, 0, 0); }
        g.save();
        g.globalCompositeOperation = BL[p('blend')] || 'source-over'; g.globalAlpha = clamp(p('opacity') / 100);
        const s = (+p('scale') || 100) / 100, sh = +p('shadow') || 0;
        if (sh) { g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = sh * k; g.shadowOffsetY = sh * k * 0.35; }
        g.translate(W / 2 + (+p('x') || 0) * k, H / 2 + (+p('y') || 0) * k); g.scale(s, s); g.drawImage(F, -W / 2, -H / 2);
        g.restore();
      }
      break;
    }
    case 'rectMask': case 'ellipseMask': {
      const cx = (W * p('x')) / 100, cy = (H * p('y')) / 100, w = (W * p('w')) / 100, h = (H * p('h')) / 100, soft = (+p('soft') || 0) * k;
      if (soft > 0) g.filter = `blur(${soft / 2}px)`;
      g.fillStyle = '#fff'; g.beginPath();
      if (n.type === 'ellipseMask') g.ellipse(cx, cy, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
      else if (g.roundRect) g.roundRect(cx - w / 2, cy - h / 2, w, h, Math.min((+p('round') || 0) * k, w / 2, h / 2)); else g.rect(cx - w / 2, cy - h / 2, w, h);
      g.fill(); g.filter = 'none';
      if (p('invert') === 'yes') { g.globalCompositeOperation = 'xor'; g.fillRect(0, 0, W, H); }
      break;
    }
    case 'subject': {
      const a = inp('input'); if (!a) break;
      const sp = +n.p.mSpeed || 1, mt = p('matte') && opts.video?.(p('matte'), t * sp, sp);
      if (!mt || !opts.cut) { if (p('mode') === 'background' || !p('matte')) g.drawImage(a, 0, 0); break; } // (no matte yet: the picture as it is)
      g.drawImage(opts.cut(a, mt, W, H, p('mode'), (+p('soft') || 0) * k, { choke: (+p('choke') || 0) / 100, edge: (p('edge') ?? 100) / 100, add: inp('add'), remove: inp('remove') }), 0, 0);
      break;
    }
    case 'chromaKey': {
      const a = inp('input'); if (!a) break;
      g.drawImage(a, 0, 0);
      const d = g.getImageData(0, 0, W, H), px = d.data, K = hex(p('key')), tol = (p('tolerance') / 100) * 255, sf = Math.max(1, (p('soft') / 100) * 255), sp = p('spill') / 100;
      const kc = K.indexOf(Math.max(...K)); // the screen's main channel (green / blue)
      for (let i = 0; i < px.length; i += 4) {
        const dist = Math.hypot(px[i] - K[0], px[i + 1] - K[1], px[i + 2] - K[2]);
        const al = clamp((dist - tol) / sf);
        px[i + 3] *= al;
        if (sp > 0) { const others = (px[i + (kc + 1) % 3] + px[i + (kc + 2) % 3]) / 2; if (px[i + kc] > others) px[i + kc] = px[i + kc] - (px[i + kc] - others) * sp; }
      }
      g.putImageData(d, 0, 0);
      break;
    }
    case 'vignette': {
      const a = inp('input'); if (a) g.drawImage(a, 0, 0);
      const r = (Math.hypot(W, H) / 2) * (p('size') / 100), soft = clamp(p('soft') / 100, 0.01, 1);
      const gr = g.createRadialGradient(W / 2, H / 2, r * (1 - soft), W / 2, H / 2, r);
      const [cr, cgc, cb] = hex(p('color'));
      gr.addColorStop(0, `rgba(${cr},${cgc},${cb},0)`); gr.addColorStop(1, `rgba(${cr},${cgc},${cb},${clamp(p('amount') / 100)})`);
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = gr; g.fillRect(0, 0, W, H);
      break;
    }
    case 'grain': {
      const a = inp('input'); if (a) g.drawImage(a, 0, 0);
      const sz = Math.max(1, Math.round((+p('size') || 2) * k)), gw = Math.ceil(W / sz), gh = Math.ceil(H / sz), nz = cnv(gw, gh), ng = nz.getContext('2d'), d = ng.createImageData(gw, gh);
      let seed = Math.floor(t * 24) * 9973 + 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const amt = (p('amount') / 100) * 255, mono = p('mono') === 'yes';
      for (let i = 0; i < d.data.length; i += 4) { const v = (rnd() - 0.5) * amt; d.data[i] = 128 + v; d.data[i + 1] = 128 + (mono ? v : (rnd() - 0.5) * amt); d.data[i + 2] = 128 + (mono ? v : (rnd() - 0.5) * amt); d.data[i + 3] = 255; }
      ng.putImageData(d, 0, 0);
      g.globalCompositeOperation = 'overlay'; g.imageSmoothingEnabled = false; g.drawImage(nz, 0, 0, gw * sz, gh * sz);
      g.globalCompositeOperation = 'destination-in'; if (a) g.drawImage(a, 0, 0);
      break;
    }
    case 'split': {
      const a = inp('input'); if (!a) break;
      const off = (+p('offset') || 0) * k * (p('pulse') === 'yes' ? 0.5 + 0.5 * Math.abs(Math.sin(t * 4)) : 1), an = ((+p('angle') || 0) * Math.PI) / 180, dx = Math.cos(an) * off, dy = Math.sin(an) * off;
      const ch = (rgb, x, y) => { const c = cnv(W, H), cg = c.getContext('2d'); cg.drawImage(a, x, y); cg.globalCompositeOperation = 'multiply'; cg.fillStyle = rgb; cg.fillRect(0, 0, W, H); cg.globalCompositeOperation = 'destination-in'; cg.drawImage(a, x, y); return c; };
      g.globalCompositeOperation = 'lighter';
      g.drawImage(ch('#ff0000', -dx, -dy), 0, 0); g.drawImage(ch('#00ff00', 0, 0), 0, 0); g.drawImage(ch('#0000ff', dx, dy), 0, 0);
      break;
    }
    case 'glitch': {
      const a = inp('input'); if (!a) break;
      const step = Math.floor(t * (+p('speed') || 8)); let seed = step * 7919 + 13; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const amt = clamp(p('amount') / 100), n2 = Math.max(1, Math.round(+p('slices') || 12));
      g.drawImage(a, 0, 0);
      if (rnd() < 0.35 + amt * 0.6) for (let i = 0; i < n2; i++) {
        if (rnd() > amt) continue;
        const y = rnd() * H, h = (rnd() * H) / n2, dx = (rnd() - 0.5) * W * 0.12 * amt;
        g.drawImage(a, 0, y, W, h, dx, y, W, h);
        if (p('rgb') === 'yes') { g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.35; g.fillStyle = rnd() > 0.5 ? '#ff0040' : '#00e0ff'; g.fillRect(0, y, W, h); g.restore(); }
      }
      break;
    }
    case 'lightLeak': {
      const a = inp('input'); if (a) g.drawImage(a, 0, 0);
      const s = p('side'), ph = t * (+p('speed') || 0) * 0.6, amt = clamp(p('amount') / 100);
      const x = s === 'right' ? W * (1 - 0.1 * Math.sin(ph)) : s === 'top' ? W * (0.5 + 0.3 * Math.sin(ph)) : W * (0.1 * Math.sin(ph)), y = s === 'top' ? 0 : s === 'corner' ? 0 : H * (0.4 + 0.25 * Math.sin(ph * 0.7));
      const r = Math.hypot(W, H) * (0.55 + 0.1 * Math.sin(ph * 1.3)), gr = g.createRadialGradient(x, y, 0, x, y, r);
      const [r1, g1, b1] = hex(p('color')), [r2, g2, b2] = hex(p('color2'));
      gr.addColorStop(0, `rgba(${r2},${g2},${b2},${amt})`); gr.addColorStop(0.35, `rgba(${r1},${g1},${b1},${amt * 0.7})`); gr.addColorStop(1, `rgba(${r1},${g1},${b1},0)`);
      g.globalCompositeOperation = 'screen'; g.fillStyle = gr; g.fillRect(0, 0, W, H);
      break;
    }
    case 'letterbox': {
      const a = inp('input'); if (a) g.drawImage(a, 0, 0);
      const bh = Math.max(0, (H - W / (+p('ratio') || 2.39)) / 2);
      g.fillStyle = p('color'); g.fillRect(0, 0, W, bh); g.fillRect(0, H - bh, W, bh);
      break;
    }
    case 'levels': case 'blackWhite': case 'invert': case 'posterize': {
      const a = inp('input'); if (!a) break;
      if (n.type === 'blackWhite') g.filter = `grayscale(${clamp(p('mix') / 100)}) contrast(${(+p('contrast') || 100) / 100})`;
      g.drawImage(a, 0, 0); g.filter = 'none';
      if (n.type === 'blackWhite') break;
      const d = g.getImageData(0, 0, W, H), px = d.data;
      if (n.type === 'invert') { const m = clamp(p('mix') / 100); for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) px[i + c] += (255 - 2 * px[i + c]) * m; }
      if (n.type === 'posterize') { const L = Math.max(2, Math.round(+p('levels') || 5)) - 1; for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) px[i + c] = (Math.round((px[i + c] / 255) * L) / L) * 255; }
      if (n.type === 'levels') {
        const b = clamp(p('black') / 100), w = Math.max(b + 0.01, clamp(p('white') / 100)), gm = 1 / Math.max(0.05, +p('gamma') || 1), ob = clamp(p('outBlack') / 100), lut = new Uint8ClampedArray(256);
        for (let v = 0; v < 256; v++) lut[v] = (ob + (1 - ob) * Math.pow(clamp((v / 255 - b) / (w - b)), gm)) * 255;
        for (let i = 0; i < px.length; i += 4) { px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]]; }
      }
      g.putImageData(d, 0, 0);
      break;
    }
    case 'pixelate': {
      const a = inp('input'); if (!a) break;
      const sz = Math.max(1, (+p('size') || 1) * k), sw = Math.max(1, Math.round(W / sz)), sh = Math.max(1, Math.round(H / sz)), sm = cnv(sw, sh);
      sm.getContext('2d').drawImage(a, 0, 0, sw, sh); g.imageSmoothingEnabled = false; g.drawImage(sm, 0, 0, W, H);
      break;
    }
    case 'sharpen': {
      const a = inp('input'); if (!a) break;
      // unsharp: the picture plus (picture - its blur) x amount
      g.drawImage(a, 0, 0);
      const amt = (+p('amount') || 0) / 100; if (!amt) break;
      const bl = cnv(W, H), bg = bl.getContext('2d'); bg.filter = `blur(${Math.max(0.6, 1.4 * k)}px)`; bg.drawImage(a, 0, 0);
      const d = g.getImageData(0, 0, W, H), e = bg.getImageData(0, 0, W, H), px = d.data, bp = e.data;
      for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) px[i + c] = px[i + c] + (px[i + c] - bp[i + c]) * amt;
      g.putImageData(d, 0, 0);
      break;
    }
    case 'zoomBlur': {
      const a = inp('input'); if (!a) break;
      const amt = clamp(p('amount') / 100), cx = (W * p('x')) / 100, cy = (H * p('y')) / 100, N = 10;
      g.drawImage(a, 0, 0);
      for (let i = 1; i <= N; i++) { const s = 1 + (amt * 0.25 * i) / N; g.globalAlpha = 0.5 / i + 0.05; g.setTransform(s, 0, 0, s, cx - cx * s, cy - cy * s); g.drawImage(a, 0, 0); }
      g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
      break;
    }
    case 'mirror': {
      const a = inp('input'); if (!a) break;
      const m = p('mode'), hw = W / 2, hh = H / 2;
      g.drawImage(a, 0, 0);
      const flipX = (sx) => { g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(a, sx, 0, hw, H, sx, 0, hw, H); g.restore(); };
      if (m === 'left') flipX(hw); // the left half, mirrored into the right
      if (m === 'right') flipX(0);
      if (m === 'top' || m === 'bottom') { g.save(); g.translate(0, H); g.scale(1, -1); const sy = m === 'top' ? hh : 0; g.drawImage(a, 0, sy, W, hh, 0, sy, W, hh); g.restore(); }
      if (m === 'quad') { const q = cnv(Math.ceil(hw), Math.ceil(hh)); q.getContext('2d').drawImage(a, 0, 0, W, H, 0, 0, hw, hh);
        for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) { g.save(); g.translate(sx < 0 ? W : 0, sy < 0 ? H : 0); g.scale(sx, sy); g.drawImage(q, 0, 0, hw, hh); g.restore(); } }
      break;
    }
    case 'crop': {
      const a = inp('input'); if (!a) break;
      const x0 = (W * p('left')) / 100, x1 = W * (1 - p('right') / 100), y0 = (H * p('top')) / 100, y1 = H * (1 - p('bottom') / 100), sf = (+p('soft') || 0) * k;
      if (x1 <= x0 || y1 <= y0) break;
      if (sf > 0) { g.filter = `blur(${sf / 2}px)`; g.fillStyle = '#fff'; g.fillRect(x0, y0, x1 - x0, y1 - y0); g.filter = 'none'; g.globalCompositeOperation = 'source-in'; g.drawImage(a, 0, 0); }
      else g.drawImage(a, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      break;
    }
    case 'shake': {
      const a = inp('input'); if (!a) break;
      // smooth random wobble: two sines per axis, a new pattern each "beat"
      const sp = +p('speed') || 12, ph = t * sp, A = (+p('amount') || 0) * k, z = 1 + (+p('zoom') || 0) / 100;
      const nx = Math.sin(ph * 1.7) * 0.6 + Math.sin(ph * 3.1 + 1) * 0.4, ny = Math.sin(ph * 2.3 + 2) * 0.6 + Math.sin(ph * 4.1) * 0.4, nr = Math.sin(ph * 1.3 + 4);
      g.translate(W / 2 + nx * A, H / 2 + ny * A); g.rotate(((+p('rotate') || 0) * nr * Math.PI) / 180); g.scale(z, z); g.drawImage(a, -W / 2, -H / 2);
      break;
    }
    case 'gradientMask': {
      const an = ((+p('angle') || 0) * Math.PI) / 180, dx = Math.cos(an), dy = Math.sin(an), half = (Math.abs(dx) * W + Math.abs(dy) * H) / 2;
      const mid = (p('pos') / 100 - 0.5) * 2 * half, sf = Math.max(1, (p('soft') / 100) * half), cx = W / 2 + dx * mid, cy = H / 2 + dy * mid;
      const gr = g.createLinearGradient(cx - dx * sf, cy - dy * sf, cx + dx * sf, cy + dy * sf), inv = p('invert') === 'yes';
      gr.addColorStop(0, inv ? '#ffffffff' : '#ffffff00'); gr.addColorStop(1, inv ? '#ffffff00' : '#ffffffff');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      break;
    }
    default: break;
  }
  memo.set(id, out);
  return out;
}
export function drawFusion(ctx, W, H, f, t, opts = {}, nodeId = null) {
  ctx.clearRect(0, 0, W, H);
  const id = nodeId || f.out || f.nodes.find((n) => n.type === 'mediaOut')?.id;
  const c = id && evalNode(f, id, t, W, H, opts);
  if (c) ctx.drawImage(c, 0, 0);
}
// the clips a fusion shows at t (to seek them before a bake)
export function fusionVideos(f, t) {
  return [...(f?.nodes || []).filter((n) => n.type === 'mediaIn' && n.p?.mediaId).map((n) => ({ id: n.p.mediaId, t: (+val(n.p.srcIn, t) || 0) + t * (+val(n.p.speed, t) || 1) })),
    ...(f?.nodes || []).filter((n) => n.type === 'subject' && n.p?.matte).map((n) => ({ id: n.p.matte, t: t * (+n.p.mSpeed || 1) }))];
}

// ---- ready-made styles: graphs built around the clip's MediaIn ----
// each returns { nodes, out }; `src` = the MediaIn node made for the clip
const chain = (src, specs, x0 = 220) => {
  const nodes = [src]; let prev = src, x = x0;
  for (const [type, p] of specs) { const n = newNode(type, x, src.y, p); n.in.input = prev.id; nodes.push(n); prev = n; x += 170; }
  const out = newNode('mediaOut', x, src.y); out.in.input = prev.id; nodes.push(out);
  return { nodes, out: out.id };
};
export const STYLES = {
  plain: { cat: 'Basic', name: 'Plain (MediaIn → MediaOut)', make: (src) => chain(src, []) },
  bloom: { cat: 'Glow & light', name: 'Glow Bloom', make: (src) => chain(src, [['glow', { radius: 40, intensity: 140, threshold: 55 }], ['color', { contrast: 108, saturation: 112 }]]) },
  film: { cat: 'Film', name: 'Film Look (grain + vignette + leak)', make: (src) => chain(src, [['color', { contrast: 112, saturation: 85, tint: '#ffb15c', tintAmt: 12 }], ['lightLeak', { amount: 35, speed: 0.6 }], ['vignette', { amount: 55 }], ['grain', { amount: 16 }], ['letterbox', {}]]) },
  glitch: { cat: 'Stylize', name: 'Chroma Split / Glitch', make: (src) => chain(src, [['split', { offset: 10, pulse: 'yes' }], ['glitch', { amount: 45, slices: 14, speed: 10 }]]) },
  leak: { cat: 'Glow & light', name: 'Light Leak', make: (src) => chain(src, [['lightLeak', { amount: 70, speed: 1.2, side: 'corner' }], ['color', { brightness: 104, saturation: 110 }]]) },
  duotone: { cat: 'Looks', name: 'Duotone (navy + saffron)', make: (src) => chain(src, [['duotone', { dark: '#0b2545', light: '#ffb15c' }], ['grain', { amount: 10 }]]) },
  neon: { cat: 'Text & titles', name: 'Neon Text over the clip', make: (src) => {
    const dim = newNode('color', 220, src.y, { brightness: 55, saturation: 70 }); dim.in.input = src.id;
    const tx = newNode('text', 220, src.y + 140, { text: 'NASHA MUKT BHARAT', color: '#ffd166', size: 150, weight: '900' });
    const gl = newNode('glow', 390, src.y + 140, { radius: 28, intensity: 220, threshold: 0, tinted: 'yes', color: '#ff7a1a' }); gl.in.input = tx.id;
    const mg = newNode('merge', 560, src.y, { blend: 'normal' }); mg.in.background = dim.id; mg.in.foreground = gl.id;
    const out = newNode('mediaOut', 730, src.y); out.in.input = mg.id;
    return { nodes: [src, dim, tx, gl, mg, out], out: out.id };
  } },
  pip: { cat: 'Composite', name: 'Picture-in-Picture with shadow', make: (src) => {
    const bg = newNode('background', 220, src.y - 140, { type: 'radial', c1: '#16365f', c2: '#060b14' });
    const msk = newNode('rectMask', 220, src.y + 140, { w: 100, h: 100, round: 60, soft: 0 });
    const mg = newNode('merge', 420, src.y, { scale: 62, x: 260, y: -40, shadow: 60 }); mg.in.background = bg.id; mg.in.foreground = src.id; mg.in.mask = msk.id;
    const tx = newNode('text', 420, src.y + 140, { text: 'Breaking', size: 90, x: 22, y: 82, color: '#ff9933' });
    const mg2 = newNode('merge', 600, src.y, {}); mg2.in.background = mg.id; mg2.in.foreground = tx.id;
    const out = newNode('mediaOut', 780, src.y); out.in.input = mg2.id;
    return { nodes: [src, bg, msk, mg, tx, mg2, out], out: out.id };
  } },
  greenscreen: { cat: 'Matte & roto', name: 'Green-screen composite', make: (src) => {
    const bg = newNode('background', 220, src.y - 140, { type: 'vertical', c1: '#ffb15c', c2: '#0b2545' });
    const key = newNode('chromaKey', 220, src.y, {}); key.in.input = src.id;
    const mg = newNode('merge', 420, src.y, {}); mg.in.background = bg.id; mg.in.foreground = key.id;
    const out = newNode('mediaOut', 600, src.y); out.in.input = mg.id;
    return { nodes: [src, bg, key, mg, out], out: out.id };
  } },
  roto: { cat: 'Matte & roto', name: 'Roto: the subject only (AI)', make: (src) => chain(src, [['subject', { mode: 'cutout' }]]) },
  behind: { cat: 'Matte & roto', name: 'Text behind the subject (AI roto)', make: (src) => {
    const tx = newNode('text', 220, src.y - 120, { text: 'LIMELIGHT', size: 260, weight: '900', y: 42 }); tx.in.input = src.id;
    const sb = newNode('subject', 220, src.y + 120, { mode: 'cutout' }); sb.in.input = src.id;
    const mg = newNode('merge', 420, src.y, {}); mg.in.background = tx.id; mg.in.foreground = sb.id;
    const out = newNode('mediaOut', 600, src.y); out.in.input = mg.id;
    return { nodes: [src, tx, sb, mg, out], out: out.id };
  } },
  spotlight: { cat: 'Composite', name: 'Spotlight (ellipse mask + blur outside)', make: (src) => {
    const bl = newNode('blur', 220, src.y - 140, { radius: 22 }); bl.in.input = src.id;
    const dim = newNode('color', 390, src.y - 140, { brightness: 55 }); dim.in.input = bl.id;
    const msk = newNode('ellipseMask', 220, src.y + 140, { w: 45, h: 70, soft: 120 });
    const mg = newNode('merge', 560, src.y, {}); mg.in.background = dim.id; mg.in.foreground = src.id; mg.in.mask = msk.id;
    const out = newNode('mediaOut', 730, src.y); out.in.input = mg.id;
    return { nodes: [src, bl, dim, msk, mg, out], out: out.id };
  } },
  // (added 2026-10-28: many more, by group)
  tealOrange: { cat: 'Looks', name: 'Teal & Orange (cinema)', make: (src) => chain(src, [['levels', { outBlack: 4, gamma: 1.05 }], ['duotone', { dark: '#0e3a4a', light: '#ffb070', mix: 35 }], ['color', { contrast: 112, saturation: 115 }], ['vignette', { amount: 40 }]]) },
  bw: { cat: 'Looks', name: 'Black & White (classic)', make: (src) => chain(src, [['blackWhite', { contrast: 125 }], ['vignette', { amount: 45 }], ['grain', { amount: 12 }]]) },
  bwHigh: { cat: 'Looks', name: 'Black & White (high contrast)', make: (src) => chain(src, [['blackWhite', { contrast: 170 }], ['levels', { black: 6, white: 94 }]]) },
  warm: { cat: 'Looks', name: 'Warm golden hour', make: (src) => chain(src, [['color', { brightness: 104, contrast: 106, saturation: 112, tint: '#ffa64d', tintAmt: 18 }], ['lightLeak', { amount: 25, speed: 0.4, side: 'corner' }]]) },
  cold: { cat: 'Looks', name: 'Cold blue night', make: (src) => chain(src, [['color', { brightness: 88, contrast: 115, saturation: 80, tint: '#3d7bff', tintAmt: 22 }], ['vignette', { amount: 50 }]]) },
  faded: { cat: 'Looks', name: 'Faded matte', make: (src) => chain(src, [['levels', { outBlack: 12, white: 96, gamma: 1.1 }], ['color', { saturation: 80, contrast: 92 }]]) },
  punch: { cat: 'Looks', name: 'Punchy (contrast + clarity)', make: (src) => chain(src, [['color', { contrast: 125, saturation: 120 }], ['sharpen', { amount: 70 }]]) },
  bleach: { cat: 'Looks', name: 'Bleach bypass', make: (src) => chain(src, [['color', { contrast: 135, saturation: 50 }], ['levels', { black: 3 }]]) },
  cyber: { cat: 'Looks', name: 'Cyberpunk (magenta + cyan)', make: (src) => chain(src, [['duotone', { dark: '#2a0a4a', light: '#38e8ff', mix: 70 }], ['glow', { radius: 26, intensity: 120, threshold: 65, tinted: 'yes', color: '#ff2fb3' }]]) },
  negative: { cat: 'Looks', name: 'Negative (invert)', make: (src) => chain(src, [['invert', {}]]) },
  vintage: { cat: 'Film', name: 'Vintage 70s', make: (src) => chain(src, [['levels', { outBlack: 10, gamma: 1.08 }], ['color', { saturation: 85, tint: '#e0a060', tintAmt: 20 }], ['lightLeak', { amount: 40, speed: 0.5 }], ['grain', { amount: 22, size: 3 }], ['vignette', { amount: 55 }]]) },
  oldfilm: { cat: 'Film', name: 'Old sepia film', make: (src) => chain(src, [['blackWhite', { contrast: 110 }], ['color', { tint: '#b08850', tintAmt: 45 }], ['grain', { amount: 30, size: 3 }], ['vignette', { amount: 65, size: 60 }]]) },
  scope: { cat: 'Film', name: 'Cinemascope (2.39 bars + grade)', make: (src) => chain(src, [['color', { contrast: 112, saturation: 105 }], ['vignette', { amount: 35 }], ['letterbox', { ratio: '2.39' }]]) },
  dream: { cat: 'Glow & light', name: 'Dreamy soft glow', make: (src) => chain(src, [['glow', { radius: 60, intensity: 90, threshold: 30 }], ['color', { brightness: 106, contrast: 92, saturation: 90 }]]) },
  sunflare: { cat: 'Glow & light', name: 'Sun flare (warm leak top)', make: (src) => chain(src, [['lightLeak', { amount: 75, speed: 0.8, side: 'top', color: '#ff9a3c', color2: '#fff3c4' }], ['glow', { radius: 30, intensity: 80, threshold: 70 }]]) },
  pixel: { cat: 'Stylize', name: 'Pixelate (censor / retro)', make: (src) => chain(src, [['pixelate', { size: 28 }]]) },
  comic: { cat: 'Stylize', name: 'Poster / comic', make: (src) => chain(src, [['sharpen', { amount: 120 }], ['posterize', { levels: 5 }], ['color', { saturation: 140 }]]) },
  vhs: { cat: 'Stylize', name: 'VHS tape', make: (src) => chain(src, [['split', { offset: 5 }], ['glitch', { amount: 20, slices: 8, speed: 6 }], ['levels', { outBlack: 8 }], ['grain', { amount: 25 }]]) },
  kaleido: { cat: 'Stylize', name: 'Mirror / kaleidoscope', make: (src) => chain(src, [['mirror', { mode: 'quad' }]]) },
  mirrorH: { cat: 'Stylize', name: 'Mirror left → right', make: (src) => chain(src, [['mirror', { mode: 'left' }]]) },
  shakeHit: { cat: 'Motion', name: 'Camera shake', make: (src) => chain(src, [['shake', { amount: 16, speed: 14 }]]) },
  earthquake: { cat: 'Motion', name: 'Earthquake (heavy shake + blur)', make: (src) => chain(src, [['shake', { amount: 40, speed: 22, rotate: 3, zoom: 12 }], ['zoomBlur', { amount: 18 }]]) },
  punchZoom: { cat: 'Motion', name: 'Zoom blur punch', make: (src) => chain(src, [['zoomBlur', { amount: 45 }], ['color', { brightness: 108, contrast: 110 }]]) },
  titleBlur: { cat: 'Text & titles', name: 'Title over blurred clip', make: (src) => {
    const bl = newNode('blur', 220, src.y, { radius: 18 }); bl.in.input = src.id;
    const dim = newNode('color', 390, src.y, { brightness: 60 }); dim.in.input = bl.id;
    const tx = newNode('text', 560, src.y, { text: 'TITLE', size: 180, weight: '900' }); tx.in.input = dim.id;
    const out = newNode('mediaOut', 730, src.y); out.in.input = tx.id;
    return { nodes: [src, bl, dim, tx, out], out: out.id };
  } },
  lowerBar: { cat: 'Text & titles', name: 'Lower third (bar + name)', make: (src) => {
    const bar = newNode('background', 220, src.y + 140, { type: 'horizontal', c1: '#ff9933', c2: '#ff993300' });
    const msk = newNode('rectMask', 220, src.y + 280, { x: 30, y: 82, w: 60, h: 12, soft: 0 });
    const mg = newNode('merge', 420, src.y, {}); mg.in.background = src.id; mg.in.foreground = bar.id; mg.in.mask = msk.id;
    const tx = newNode('text', 590, src.y, { text: 'Naam / Name', size: 64, weight: '800', x: 24, y: 82, color: '#ffffff' }); tx.in.input = mg.id;
    const out = newNode('mediaOut', 760, src.y); out.in.input = tx.id;
    return { nodes: [src, bar, msk, mg, tx, out], out: out.id };
  } },
  bigTitle: { cat: 'Text & titles', name: 'Cinematic title (bars + glow text)', make: (src) => {
    const lb = newNode('letterbox', 220, src.y, { ratio: '2.39' }); lb.in.input = src.id;
    const tx = newNode('text', 220, src.y + 140, { text: 'LIMELIGHT', size: 200, weight: '900', tracking: 300, color: '#ffffff' });
    const gl = newNode('glow', 390, src.y + 140, { radius: 24, intensity: 110, threshold: 0 }); gl.in.input = tx.id;
    const mg = newNode('merge', 560, src.y, {}); mg.in.background = lb.id; mg.in.foreground = gl.id;
    const out = newNode('mediaOut', 730, src.y); out.in.input = mg.id;
    return { nodes: [src, lb, tx, gl, mg, out], out: out.id };
  } },
  fadeColor: { cat: 'Composite', name: 'Gradient fade to colour (bottom)', make: (src) => {
    const bg = newNode('background', 220, src.y + 140, { c1: '#0b2545' });
    const gm = newNode('gradientMask', 220, src.y + 280, { angle: 90, pos: 75, soft: 35 });
    const mg = newNode('merge', 420, src.y, {}); mg.in.background = src.id; mg.in.foreground = bg.id; mg.in.mask = gm.id;
    const out = newNode('mediaOut', 600, src.y); out.in.input = mg.id;
    return { nodes: [src, bg, gm, mg, out], out: out.id };
  } },
  tiltShift: { cat: 'Composite', name: 'Tilt-shift (miniature)', make: (src) => {
    const bl = newNode('blur', 220, src.y - 140, { radius: 14 }); bl.in.input = src.id;
    const sat = newNode('color', 220, src.y + 140, { saturation: 135, contrast: 110 }); sat.in.input = src.id;
    const gm = newNode('ellipseMask', 390, src.y + 280, { w: 200, h: 34, soft: 160 });
    const mg = newNode('merge', 560, src.y, {}); mg.in.background = bl.id; mg.in.foreground = sat.id; mg.in.mask = gm.id;
    const out = newNode('mediaOut', 730, src.y); out.in.input = mg.id;
    return { nodes: [src, bl, sat, gm, mg, out], out: out.id };
  } },
  censor: { cat: 'Composite', name: 'Blur a part (censor box)', make: (src) => {
    const px = newNode('pixelate', 220, src.y - 140, { size: 30 }); px.in.input = src.id;
    const msk = newNode('rectMask', 220, src.y + 140, { w: 25, h: 30, soft: 6 });
    const mg = newNode('merge', 420, src.y, {}); mg.in.background = src.id; mg.in.foreground = px.id; mg.in.mask = msk.id;
    const out = newNode('mediaOut', 600, src.y); out.in.input = mg.id;
    return { nodes: [src, px, msk, mg, out], out: out.id };
  } },
  colorPop: { cat: 'Matte & roto', name: 'Colour pop: subject in colour, rest B&W (AI)', make: (src) => {
    const bw = newNode('blackWhite', 220, src.y - 140, {}); bw.in.input = src.id;
    const sb = newNode('subject', 220, src.y + 140, { mode: 'cutout' }); sb.in.input = src.id;
    const mg = newNode('merge', 420, src.y, {}); mg.in.background = bw.id; mg.in.foreground = sb.id;
    const out = newNode('mediaOut', 600, src.y); out.in.input = mg.id;
    return { nodes: [src, bw, sb, mg, out], out: out.id };
  } },
  bgBlur: { cat: 'Matte & roto', name: 'Background blur (portrait, AI)', make: (src) => {
    const bl = newNode('blur', 220, src.y - 140, { radius: 16 }); bl.in.input = src.id;
    const sb = newNode('subject', 220, src.y + 140, { mode: 'cutout' }); sb.in.input = src.id;
    const mg = newNode('merge', 420, src.y, {}); mg.in.background = bl.id; mg.in.foreground = sb.id;
    const out = newNode('mediaOut', 600, src.y); out.in.input = mg.id;
    return { nodes: [src, bl, sb, mg, out], out: out.id };
  } },
};
export function newFusion(name, w, h, dur, mediaIn, style = 'plain') {
  const src = newNode('mediaIn', 40, 160, mediaIn);
  const { nodes, out } = STYLES[style].make(src);
  return { id: uidF(), name, w, h, dur, nodes, out };
}
// a node's inputs that would make a loop if connected from `from`
export function wouldLoop(f, from, to) {
  const seen = new Set(), stack = [from];
  while (stack.length) { const id = stack.pop(); if (id === to) return true; if (seen.has(id)) continue; seen.add(id); const n = f.nodes.find((x) => x.id === id); if (n) stack.push(...Object.values(n.in || {})); }
  return false;
}
