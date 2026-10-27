// 💥 VFX elements - Hollywood-style effects drawn over the picture: muzzle flash, explosion, sparks, smoke, fire,
// lightning, energy beams, force fields, light leaks, anamorphic flares, lens dirt, rain / snow / dust, film burn and a
// screen replacement. One drawing code for the VFX page, the Edit viewer and the render: an element on the timeline is a
// graphic clip { type: 'graphic', blend: 'screen' | '', gfx: { tpl: 'vfx', vfx } } that graphics.js hands to drawVfx and
// gfxui.js bakes like any graphic. Works in the browser and in Node (no DOM at import).
//
// vfx = { kind, seed, p: { param: value } }  - a value may be animated like a Motion property ({ k: [keys] }, motion.js)
// Every random choice comes from the seed, so a frame looks the same in the viewer, the bake and on every PC.
import { val } from './motion.js';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const TAU = Math.PI * 2, rad = (d) => (d * Math.PI) / 180;
const hexRgb = (c) => { const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(c || ''); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : [255, 255, 255]; };
const rgba = (c, a) => { const [r, g, b] = hexRgb(c); return `rgba(${r},${g},${b},${clamp(a).toFixed(3)})`; };
const mix = (c1, c2, k) => { const A = hexRgb(c1), B = hexRgb(c2); return `#${A.map((v, i) => Math.round(v + (B[i] - v) * clamp(k)).toString(16).padStart(2, '0')).join('')}`; };
// a repeatable random number for (seed, n): the same everywhere
export function hash(seed, n) { let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((n | 0) + 0x6d2b79f5, 0x85ebca6b)) >>> 0; h = Math.imul(h ^ (h >>> 15), h | 1); h ^= h + Math.imul(h ^ (h >>> 7), h | 61); return ((h ^ (h >>> 14)) >>> 0) / 4294967296; }
const R = (seed, i, j = 0) => hash(seed, i * 7919 + j * 104729 + 13);
const noise1 = (seed, x) => { const f = Math.floor(x), r = x - f, s = r * r * (3 - 2 * r); return (R(seed, f) * (1 - s) + R(seed, f + 1) * s) * 2 - 1; };
function glow(g, x, y, r, c, a, inner = '#ffffff', k0 = 0) {
  if (!(r > 0) || !(a > 0.002)) return;
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, rgba(k0 ? inner : c, a)); gr.addColorStop(Math.max(0.01, k0 || 0.01), rgba(c, a)); gr.addColorStop(1, rgba(c, 0));
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
}
// 🌫 a soft billowy puff (smoke / dust), drawn once per colour and kept
const sprites = new Map();
function puff(c, seed = 7) {
  const key = `${c}|${seed}`;
  if (sprites.has(key)) return sprites.get(key);
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const s = document.createElement('canvas'); s.width = s.height = 160;
  if (!s.getContext) return null;
  const g = s.getContext('2d');
  // (every blob stays inside the sprite - one cut off by its edge made the smoke look boxy)
  for (let i = 0; i < 26; i++) {
    const a = R(seed, i) * TAU, d = Math.sqrt(R(seed, i, 1)) * 30, r = 18 + R(seed, i, 2) * 30, dy = Math.sin(a) * d;
    // (lit from above: blobs on top lighter, underneath darker - the puff gets volume)
    const tone = dy < 0 ? mix(c, '#ffffff', (0.28 * -dy) / 30) : mix(c, '#000000', (0.3 * dy) / 30);
    glow(g, 80 + Math.cos(a) * d, 80 + dy, r, tone, 0.16 + 0.12 * R(seed, i, 3));
  }
  sprites.set(key, s);
  return s;
}

const XY = (x, y) => ({ x: { label: 'Position X', min: -20, max: 120, step: 0.5, def: x, unit: '%' }, y: { label: 'Position Y', min: -20, max: 120, step: 0.5, def: y, unit: '%' } });
const N = (label, def, min, max, step = 1, unit = '') => ({ label, def, min, max, step, unit });
const C = (label, def) => ({ label, type: 'color', def });
const SEL = (label, def, options) => ({ label, type: 'select', def, options });
const START = { at: N('Starts at', 0, 0, 120, 0.05, 's') };

// ---- the elements: params (shown as controls, keyframable), blend with the picture, draw(g, W, H, p, t, dur, x) ----
// x = { seed, U (size unit: sqrt(W*H)), img(id), video(id, t, rate) }
export const KINDS = {
  muzzle: { label: 'Muzzle flash', blend: 'screen', params: { ...XY(62, 55), angle: N('Direction', 0, -180, 180, 1, '°'), size: N('Size', 14, 2, 60, 0.5, '%'), rate: N('Shots a second (0 = one)', 9, 0, 25, 0.5), ...START, burst: N('Firing for (0 = whole clip)', 0, 0, 60, 0.1, 's'), color: C('Colour', '#ffb347'), light: N('Light on the scene', 0.45, 0, 1, 0.05) },
    draw(g, W, H, p, t, dur, x) {
      if (t < p.at || (p.burst > 0 && t > p.at + p.burst)) return;
      const rt = p.rate, i = rt > 0 ? Math.floor((t - p.at) * rt) : 0, since = rt > 0 ? t - p.at - i / rt : t - p.at, on = rt > 0 ? Math.min(0.05, 0.55 / rt) : 0.07;
      if (since > on) return;
      const k = 1 - (since / on) * 0.6, s = x.seed + i * 31, L = (x.U * p.size) / 100 * (0.8 + 0.45 * R(s, 1)), px = (W * p.x) / 100, py = (H * p.y) / 100;
      g.globalCompositeOperation = 'lighter';
      glow(g, px, py, x.U * 0.7, p.color, p.light * 0.5 * k);
      g.save(); g.translate(px, py); g.rotate(rad(p.angle + (R(s, 2) - 0.5) * 8));
      const petal = (len, w, a) => {
        g.save(); g.rotate(a);
        const gr = g.createLinearGradient(0, 0, len, 0);
        gr.addColorStop(0, rgba('#ffffff', k)); gr.addColorStop(0.3, rgba(mix('#fff3c4', p.color, 0.3), 0.95 * k)); gr.addColorStop(0.75, rgba(p.color, 0.55 * k)); gr.addColorStop(1, rgba(p.color, 0));
        g.fillStyle = gr; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(len * 0.4, w, len, 0); g.quadraticCurveTo(len * 0.4, -w, 0, 0); g.fill(); g.restore();
      };
      petal(L, L * 0.16, 0);
      petal(L * 0.62, L * 0.11, rad(-6 + R(s, 3) * 12));
      for (const sd of [-1, 1]) petal(L * (0.32 + 0.2 * R(s, 4 + sd)), L * 0.08, sd * rad(38 + 22 * R(s, 6 + sd)));
      petal(L * 0.18, L * 0.08, Math.PI);
      glow(g, L * 0.05, 0, L * 0.32, '#fff6d8', k);
      g.strokeStyle = rgba('#ffe2a0', 0.9 * k); g.lineWidth = Math.max(1, x.U * 0.0014); g.lineCap = 'round';
      for (let j = 0; j < 6; j++) { const a = rad((R(s, 10 + j) - 0.5) * 50), d0 = L * (0.5 + R(s, 20 + j) * 0.5), d1 = d0 + L * 0.25; g.beginPath(); g.moveTo(Math.cos(a) * d0, Math.sin(a) * d0); g.lineTo(Math.cos(a) * d1, Math.sin(a) * d1); g.stroke(); }
      g.restore();
    } },
  explosion: { label: 'Explosion / fireball', blend: 'screen', params: { ...XY(50, 58), size: N('Size', 38, 5, 150, 0.5, '%'), at: N('Goes off at', 0.15, 0, 120, 0.05, 's'), life: N('Burns for', 1.6, 0.3, 6, 0.05, 's'), hot: C('Hot core', '#fff1c1'), color: C('Fire', '#ff7a1a'), dark: C('Embers', '#8a1c06'), flash: N('Flash', 0.8, 0, 1, 0.05), ring: N('Shock ring', 0.5, 0, 1, 0.05), debris: N('Debris', 40, 0, 150, 1) },
    draw(g, W, H, p, t, dur, x) {
      const a = t - p.at, life = p.life;
      if (a < 0 || a > life * 1.7) return;
      const cx = (W * p.x) / 100, cy = (H * p.y) / 100, Rr = (x.U * p.size) / 100, s = x.seed;
      g.globalCompositeOperation = 'lighter';
      if (a < 0.3) glow(g, cx, cy, x.U * 1.3, p.color, p.flash * 0.75 * (1 - a / 0.3), p.hot, 0.15);
      for (let i = 0; i < 44; i++) {
        const ai = (a - R(s, i, 4) * 0.18 * life) / life;
        if (ai <= 0 || ai > 1) continue;
        const ang = R(s, i) * TAU, sp = 0.25 + R(s, i, 1) * 0.8, e = 1 - (1 - Math.min(1, ai * 1.7)) ** 3;
        const px = cx + Math.cos(ang) * Rr * sp * e * 0.9, py = cy + Math.sin(ang) * Rr * sp * e * 0.55 - Rr * 0.45 * ai * ai;
        const r = Rr * (0.16 + R(s, i, 2) * 0.2) * (0.45 + 1.15 * e), heat = clamp(1 - ai * 1.35), al = (1 - ai) ** 1.5 * 0.5;
        const gr = g.createRadialGradient(px, py, 0, px, py, r);
        gr.addColorStop(0, rgba(mix(p.color, p.hot, heat), al)); gr.addColorStop(0.45, rgba(mix(p.dark, p.color, heat * 0.8 + 0.2), al * 0.7)); gr.addColorStop(1, rgba(p.dark, 0));
        g.fillStyle = gr; g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
        // (a billowy puff over each blob, in four heat steps: the fire gets its rolling texture)
        const hq = Math.round(heat * 3) / 3, pf = puff(mix(p.dark, mix(p.color, p.hot, hq), 0.35 + 0.65 * hq), 3 + (i % 4));
        if (pf) { g.save(); g.globalAlpha = clamp(al * 0.9); g.translate(px, py); g.rotate(R(s, i, 5) * TAU + ai * (R(s, i, 6) - 0.5)); g.drawImage(pf, -r * 1.25, -r * 1.25, r * 2.5, r * 2.5); g.restore(); }
      }
      if (p.ring > 0 && a < 0.55) { g.strokeStyle = rgba(p.hot, p.ring * 0.55 * (1 - a / 0.55)); g.lineWidth = Rr * 0.07 * (1 - a / 0.55) + 1; g.beginPath(); g.ellipse(cx, cy, Rr * (0.3 + a * 4.2), Rr * (0.3 + a * 4.2) * 0.42, 0, 0, TAU); g.stroke(); }
      g.lineCap = 'round';
      for (let i = 0; i < p.debris; i++) {
        const ang = rad(-90 + (R(s, i, 7) - 0.5) * 170), v = Rr * (1.6 + 3.2 * R(s, i, 8)), gy = x.U * 1.1, tt = a;
        const px = cx + Math.cos(ang) * v * tt, py = cy + Math.sin(ang) * v * tt + 0.5 * gy * tt * tt, vx = Math.cos(ang) * v, vy = Math.sin(ang) * v + gy * tt, al = clamp(1 - a / (life * 1.2));
        if (al <= 0) continue;
        g.strokeStyle = rgba(mix(p.color, p.hot, R(s, i, 9)), al); g.lineWidth = Math.max(1, x.U * 0.0022);
        g.beginPath(); g.moveTo(px, py); g.lineTo(px - vx * 0.03, py - vy * 0.03); g.stroke();
      }
    } },
  sparks: { label: 'Sparks', blend: 'screen', params: { ...XY(50, 60), dir: N('Direction', -90, -180, 180, 1, '°'), spread: N('Spread', 70, 0, 360, 1, '°'), rate: N('Sparks a second', 70, 1, 400, 1), speed: N('Speed', 55, 5, 250, 1), gravity: N('Gravity', 90, -100, 300, 1), life: N('Life', 0.8, 0.1, 3, 0.05, 's'), ...START, burst: N('Spraying for (0 = whole clip)', 0, 0, 60, 0.05, 's'), thick: N('Thickness', 1, 0.3, 5, 0.1), color: C('Colour', '#ffc35a') },
    draw(g, W, H, p, t, dur, x) {
      const s = x.seed, U = x.U, cx = (W * p.x) / 100, cy = (H * p.y) / 100, n0 = Math.max(0, Math.floor((t - p.life - p.at) * p.rate)), n1 = Math.floor((t - p.at) * p.rate);
      const last = p.burst > 0 ? Math.floor(p.burst * p.rate) : Infinity;
      g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
      for (let i = Math.max(n0, n1 - 600); i <= Math.min(n1, last); i++) {
        const a = t - p.at - i / p.rate, life = p.life * (0.5 + R(s, i, 3) * 0.7);
        if (a < 0 || a > life) continue;
        const ang = rad(p.dir + (R(s, i) - 0.5) * p.spread), v = ((U * p.speed) / 100) * (0.35 + R(s, i, 1) * 0.9), gy = (U * p.gravity) / 100;
        const px = cx + Math.cos(ang) * v * a, py = cy + Math.sin(ang) * v * a + 0.5 * gy * a * a, vx = Math.cos(ang) * v, vy = Math.sin(ang) * v + gy * a;
        const k = 1 - a / life;
        g.strokeStyle = rgba(mix(p.color, '#ffffff', k * 0.6), Math.min(1, k * 1.4)); g.lineWidth = Math.max(0.7, (U * 0.0018 * p.thick) * (0.5 + k));
        g.beginPath(); g.moveTo(px, py); g.lineTo(px - vx * 0.035, py - vy * 0.035); g.stroke();
      }
      if (n1 >= 0 && (p.burst <= 0 || t - p.at < p.burst)) glow(g, cx, cy, U * 0.05, p.color, 0.5);
    } },
  smoke: { label: 'Smoke', blend: '', params: { ...XY(50, 75), width: N('Source width', 12, 0, 100, 0.5, '%'), rate: N('Puffs a second', 7, 0.5, 30, 0.5), rise: N('Rise speed', 9, -20, 60, 0.5), wind: N('Wind', 2, -40, 40, 0.5), size: N('Puff size', 16, 2, 80, 0.5, '%'), life: N('Life', 4, 0.5, 12, 0.1, 's'), ...START, burst: N('Puffing for (0 = whole clip)', 0, 0, 60, 0.1, 's'), color: C('Colour', '#8e8e8e'), opacity: N('Opacity', 0.55, 0, 1, 0.05) },
    draw(g, W, H, p, t, dur, x) {
      const sp = puff(p.color, 7 + (x.seed % 5));
      if (!sp) return;
      const s = x.seed, U = x.U, n1 = Math.floor((t - p.at) * p.rate), n0 = Math.max(0, Math.floor((t - p.at - p.life * 1.3) * p.rate)), last = p.burst > 0 ? Math.floor(p.burst * p.rate) : Infinity;
      for (let i = Math.max(n0, n1 - 120); i <= Math.min(n1, last); i++) {
        const life = p.life * (0.7 + R(s, i, 5) * 0.6), a = t - p.at - i / p.rate;
        if (a < 0 || a > life) continue;
        const k = a / life, sz = (U * p.size) / 100 * (0.45 + 1.4 * k) * (0.7 + 0.6 * R(s, i, 1));
        const px = (W * p.x) / 100 + (R(s, i) - 0.5) * (U * p.width) / 100 + (U * p.wind) / 100 * a + noise1(s + i, a * 0.6) * U * 0.03;
        const py = (H * p.y) / 100 - (U * p.rise) / 100 * a * (0.8 + 0.4 * R(s, i, 2));
        const al = p.opacity * Math.min(1, a / 0.35) * (1 - k) ** 1.3;
        g.save(); g.globalAlpha = clamp(al); g.translate(px, py); g.rotate(R(s, i, 3) * TAU + a * (R(s, i, 4) - 0.5) * 0.6);
        g.drawImage(sp, -sz, -sz, sz * 2, sz * 2); g.restore();
      }
    } },
  fire: { label: 'Fire', blend: 'screen', params: { ...XY(50, 85), width: N('Width', 22, 2, 100, 0.5, '%'), height: N('Height', 38, 5, 120, 0.5, '%'), intensity: N('Intensity', 1, 0.1, 2.5, 0.05), speed: N('Speed', 1, 0.2, 3, 0.05), hot: C('Hot', '#ffe08a'), color: C('Flame', '#ff4d1a'), embers: N('Embers a second', 14, 0, 80, 1) },
    draw(g, W, H, p, t, dur, x) {
      const s = x.seed, U = x.U, cx = (W * p.x) / 100, cy = (H * p.y) / 100, w = (U * p.width) / 100, h = (U * p.height) / 100, rate = 85 * p.intensity, life = 0.75 / p.speed;
      g.globalCompositeOperation = 'lighter';
      glow(g, cx, cy - h * 0.15, w * 1.7, p.color, 0.22 * p.intensity * (0.85 + 0.15 * noise1(s, t * 9)));
      const n1 = Math.floor(t * rate);
      for (let i = Math.max(0, n1 - Math.ceil(life * rate * 1.3)); i <= n1; i++) {
        const lf = life * (0.55 + R(s, i, 2) * 0.6), a = t - i / rate;
        if (a < 0 || a > lf) continue;
        const k = a / lf, off = R(s, i) - 0.5;
        const px = cx + off * w * (1 - 0.65 * k) + noise1(s + i, t * 3 + i) * w * 0.12 * k, py = cy - h * k ** 0.85 * (0.7 + 0.5 * R(s, i, 1));
        const r = w * 0.24 * (1 - 0.65 * k) * (0.6 + 0.6 * R(s, i, 3)) * (1 - Math.abs(off) * 0.6), al = (1 - k) ** 1.2 * 0.5;
        const gr = g.createRadialGradient(px, py, 0, px, py, r);
        gr.addColorStop(0, rgba(k < 0.3 ? mix('#ffffff', p.hot, k / 0.3) : mix(p.hot, p.color, (k - 0.3) / 0.7), al)); gr.addColorStop(1, rgba(p.color, 0));
        g.fillStyle = gr; g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
      }
      g.fillStyle = rgba(p.hot, 0.9);
      const e1 = Math.floor(t * p.embers);
      for (let i = Math.max(0, e1 - p.embers * 3); i <= e1 && p.embers > 0; i++) {
        const a = t - i / p.embers, lf = 2 + R(s, i, 9) * 1.5;
        if (a < 0 || a > lf) continue;
        const px = cx + (R(s, i, 7) - 0.5) * w + noise1(s + i * 3, a * 1.5) * w * 0.4, py = cy - h * 0.3 - (h * 0.9 * a) / lf * 1.6, sz = Math.max(1, U * 0.0022);
        g.globalAlpha = clamp((1 - a / lf) * (0.6 + 0.4 * Math.sin(a * 20 + i))); g.fillRect(px, py, sz, sz);
      }
      g.globalAlpha = 1;
    } },
  lightning: { label: 'Lightning', blend: 'screen', params: { x: N('Start X', 45, -20, 120, 0.5, '%'), y: N('Start Y', -2, -20, 120, 0.5, '%'), x2: N('End X', 55, -20, 120, 0.5, '%'), y2: N('End Y', 80, -20, 120, 0.5, '%'), rate: N('Strikes a second (0 = one)', 1.2, 0, 10, 0.1), ...START, branches: N('Branches', 4, 0, 12, 1), jag: N('Jaggedness', 1, 0.2, 2.5, 0.05), glow: N('Glow', 1, 0, 3, 0.05), color: C('Colour', '#b9d4ff'), flash: N('Sky flash', 0.35, 0, 1, 0.05) },
    draw(g, W, H, p, t, dur, x) {
      if (t < p.at) return;
      const i = p.rate > 0 ? Math.floor((t - p.at) * p.rate) : 0, lt = p.rate > 0 ? t - p.at - i / p.rate : t - p.at, s = x.seed + i * 97;
      if (lt > 0.22 || (p.rate > 0 && i > 0 && R(s, 1) < 0.2)) return;
      const b = lt < 0.04 ? 1 : lt < 0.07 ? 0.25 : lt < 0.12 ? 0.9 : clamp(1 - (lt - 0.12) / 0.1);
      const bolt = (ax, ay, bx, by, depth, k0) => {
        let pts = [[ax, ay], [bx, by]], off = Math.hypot(bx - ax, by - ay) * 0.18 * p.jag;
        for (let d = 0; d < depth; d++) {
          const nx = [];
          for (let j = 0; j < pts.length - 1; j++) {
            const [x1, y1] = pts[j], [x2, y2] = pts[j + 1], l = Math.hypot(x2 - x1, y2 - y1) || 1, r = (R(s, k0 + d * 997 + j) - 0.5) * 2 * off;
            nx.push(pts[j], [(x1 + x2) / 2 + (-(y2 - y1) / l) * r, (y1 + y2) / 2 + ((x2 - x1) / l) * r]);
          }
          nx.push(pts[pts.length - 1]); pts = nx; off /= 2;
        }
        return pts;
      };
      const ax = (W * p.x) / 100, ay = (H * p.y) / 100, bx = (W * p.x2) / 100, by = (H * p.y2) / 100, main = bolt(ax, ay, bx, by, 7, 1), paths = [[main, 1]];
      for (let k = 0; k < p.branches; k++) {
        const j = Math.floor((0.15 + 0.6 * R(s, 50 + k)) * (main.length - 1)), [sx, sy] = main[j], L = Math.hypot(bx - ax, by - ay) * (0.18 + 0.25 * R(s, 60 + k));
        const a = Math.atan2(by - ay, bx - ax) + (R(s, 70 + k) < 0.5 ? -1 : 1) * rad(25 + 35 * R(s, 80 + k));
        paths.push([bolt(sx, sy, sx + Math.cos(a) * L, sy + Math.sin(a) * L, 5, 1000 + k * 300), 0.55]);
      }
      g.globalCompositeOperation = 'lighter';
      if (p.flash > 0) { g.fillStyle = rgba(p.color, p.flash * 0.28 * b); g.fillRect(0, 0, W, H); }
      g.lineJoin = 'round'; g.lineCap = 'round';
      for (const [w, a, c] of [[0.035 * p.glow, 0.1, p.color], [0.014 * p.glow, 0.25, p.color], [0.0045, 0.9, mix(p.color, '#ffffff', 0.7)], [0.0018, 1, '#ffffff']]) {
        for (const [pts, k] of paths) { g.strokeStyle = rgba(c, a * b * k); g.lineWidth = Math.max(0.6, x.U * w * k); g.beginPath(); pts.forEach(([px, py], j) => (j ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke(); }
      }
      glow(g, bx, by, x.U * 0.12 * p.glow, p.color, 0.5 * b);
    } },
  beam: { label: 'Energy beam', blend: 'screen', params: { x: N('From X', 15, -20, 120, 0.5, '%'), y: N('From Y', 50, -20, 120, 0.5, '%'), x2: N('To X', 85, -20, 120, 0.5, '%'), y2: N('To Y', 45, -20, 120, 0.5, '%'), width: N('Width', 1.6, 0.2, 10, 0.1, '%'), color: C('Colour', '#46d4ff'), pulse: N('Pulse a second', 6, 0, 30, 0.5), wobble: N('Wobble', 0.6, 0, 4, 0.05), grow: N('Shoots out in (0 = at once)', 0.25, 0, 5, 0.05, 's') },
    draw(g, W, H, p, t, dur, x) {
      const ax = (W * p.x) / 100, ay = (H * p.y) / 100, bx0 = (W * p.x2) / 100, by0 = (H * p.y2) / 100, k = p.grow > 0 ? clamp(t / p.grow) : 1;
      const bx = ax + (bx0 - ax) * k, by = ay + (by0 - ay) * k, L = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / L, ny = (bx - ax) / L, w = (x.U * p.width) / 100, s = x.seed;
      const pu = 0.85 + 0.15 * Math.sin(TAU * p.pulse * t), pts = [];
      for (let j = 0; j <= 32; j++) { const u = j / 32, o = noise1(s, u * 6 + t * 4) * w * p.wobble * Math.sin(Math.PI * u); pts.push([ax + (bx - ax) * u + nx * o, ay + (by - ay) * u + ny * o]); }
      g.globalCompositeOperation = 'lighter'; g.lineCap = 'round'; g.lineJoin = 'round';
      for (const [ww, a, c] of [[7, 0.07, p.color], [3.4, 0.16, p.color], [1.7, 0.4, p.color], [0.55, 0.95, '#ffffff']]) {
        g.strokeStyle = rgba(c, a * pu); g.lineWidth = Math.max(1, w * ww * (c === '#ffffff' ? 1 : pu)); g.beginPath(); pts.forEach(([px, py], j) => (j ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke();
      }
      glow(g, ax, ay, w * 6, p.color, 0.6 * pu, '#ffffff', 0.2);
      glow(g, bx, by, w * 9 * (0.9 + 0.3 * noise1(s + 5, t * 12)), p.color, 0.75 * pu, '#ffffff', 0.25);
    } },
  forcefield: { label: 'Force field', blend: 'screen', params: { ...XY(50, 50), radius: N('Radius', 30, 3, 120, 0.5, '%'), color: C('Colour', '#59c6ff'), hex: N('Hex cells', 0.7, 0, 1, 0.05), cells: N('Cell size', 7, 3, 20, 0.5, '%'), ripple: N('Ripple speed', 1, 0, 5, 0.05), pulse: N('Pulse', 0.3, 0, 1, 0.05) },
    draw(g, W, H, p, t, dur, x) {
      const cx = (W * p.x) / 100, cy = (H * p.y) / 100, Rr = (x.U * p.radius) / 100, pu = 1 - p.pulse * 0.5 * (1 + Math.sin(t * 5));
      g.globalCompositeOperation = 'lighter';
      const gr = g.createRadialGradient(cx, cy, Rr * 0.55, cx, cy, Rr);
      gr.addColorStop(0, rgba(p.color, 0)); gr.addColorStop(0.85, rgba(p.color, 0.18 * pu)); gr.addColorStop(1, rgba(p.color, 0.5 * pu));
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, Rr, 0, TAU); g.fill();
      g.strokeStyle = rgba(mix(p.color, '#ffffff', 0.5), 0.75 * pu); g.lineWidth = Math.max(1, Rr * 0.012); g.beginPath(); g.arc(cx, cy, Rr, 0, TAU); g.stroke();
      if (p.hex > 0) {
        const sz = Math.max(4, (x.U * p.cells) / 100), hw = sz * Math.sqrt(3) / 2;
        g.save(); g.beginPath(); g.arc(cx, cy, Rr, 0, TAU); g.clip(); g.lineWidth = Math.max(0.7, sz * 0.06);
        for (let row = -Math.ceil(Rr / (sz * 1.5)) - 1; row <= Math.ceil(Rr / (sz * 1.5)) + 1; row++) {
          for (let col = -Math.ceil(Rr / (hw * 2)) - 1; col <= Math.ceil(Rr / (hw * 2)) + 1; col++) {
            const hx = cx + col * hw * 2 + (row & 1) * hw, hy = cy + row * sz * 1.5, d = Math.hypot(hx - cx, hy - cy) / Rr;
            if (d > 1.05) continue;
            const w = Math.max(0, Math.sin(d * 9 - t * p.ripple * 5)) ** 6, a = p.hex * (0.06 + 0.5 * w + 0.25 * d ** 4) * pu;
            g.strokeStyle = rgba(p.color, a); g.beginPath();
            for (let v = 0; v < 6; v++) { const an = rad(60 * v + 30); const px = hx + Math.cos(an) * sz * 0.92, py = hy + Math.sin(an) * sz * 0.92; v ? g.lineTo(px, py) : g.moveTo(px, py); }
            g.closePath(); g.stroke();
          }
        }
        g.restore();
      }
    } },
  leak: { label: 'Light leak', blend: 'screen', params: { color: C('Colour', '#ff7a1a'), color2: C('Second colour', '#ffd166'), side: SEL('From', 'left', [['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['corner', 'Corner']]), strength: N('Strength', 0.7, 0, 1.5, 0.05), speed: N('Drift speed', 1, 0, 5, 0.05), size: N('Size', 70, 20, 200, 1, '%') },
    draw(g, W, H, p, t, dur, x) {
      const s = x.seed, U = x.U, sd = p.side, base = { left: [0, 0.5], right: [1, 0.5], top: [0.5, 0], corner: [0, 0] }[sd] || [0, 0.5];
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const dx = noise1(s + i * 11, t * 0.25 * p.speed + i) * 0.25, dy = noise1(s + i * 23, t * 0.2 * p.speed + i * 3) * 0.35, br = 0.65 + 0.35 * noise1(s + i * 5, t * 0.5 * p.speed);
        glow(g, W * (base[0] + (sd === 'right' ? -dx : dx)), H * (base[1] + dy), (U * p.size) / 100 * (0.7 + 0.25 * i), i === 1 ? p.color2 : p.color, p.strength * 0.55 * br);
      }
    } },
  flare: { label: 'Anamorphic flare', blend: 'screen', params: { ...XY(30, 35), color: C('Colour', '#4aa8ff'), length: N('Streak length', 90, 10, 200, 1, '%'), strength: N('Strength', 1, 0, 2, 0.05), flicker: N('Flicker', 0.2, 0, 1, 0.05), ghosts: N('Ghosts', 0.5, 0, 1, 0.05) },
    draw(g, W, H, p, t, dur, x) {
      const cx = (W * p.x) / 100, cy = (H * p.y) / 100, U = x.U, f = p.strength * (1 + p.flicker * 0.25 * noise1(x.seed, t * 9)), L = (W * p.length) / 100;
      g.globalCompositeOperation = 'lighter';
      for (const [hh, a] of [[0.05, 0.12], [0.012, 0.45], [0.004, 0.9]]) {
        const gr = g.createLinearGradient(cx - L, 0, cx + L, 0);
        gr.addColorStop(0, rgba(p.color, 0)); gr.addColorStop(0.42, rgba(p.color, a * f * 0.7)); gr.addColorStop(0.5, rgba(mix(p.color, '#ffffff', 0.8), a * f)); gr.addColorStop(0.58, rgba(p.color, a * f * 0.7)); gr.addColorStop(1, rgba(p.color, 0));
        g.fillStyle = gr; g.beginPath(); g.ellipse(cx, cy, L, Math.max(1, U * hh), 0, 0, TAU); g.fill();
      }
      glow(g, cx, cy, U * 0.09, p.color, 0.8 * f, '#ffffff', 0.25);
      if (p.ghosts > 0) {
        const vx = W / 2 - cx, vy = H / 2 - cy;
        [[0.55, 0.05, 0.25], [0.95, 0.022, 0.4], [1.35, 0.08, 0.15], [1.7, 0.035, 0.3], [2.1, 0.12, 0.08]].forEach(([k, r, a], i) => {
          const gx = cx + vx * k, gy = cy + vy * k, rr = U * r, c = i % 2 ? mix(p.color, '#7cffc8', 0.4) : p.color;
          const gr = g.createRadialGradient(gx, gy, rr * 0.6, gx, gy, rr);
          gr.addColorStop(0, rgba(c, a * p.ghosts * f * 0.5)); gr.addColorStop(0.85, rgba(c, a * p.ghosts * f)); gr.addColorStop(1, rgba(c, 0));
          g.fillStyle = gr; g.beginPath(); g.arc(gx, gy, rr, 0, TAU); g.fill();
        });
      }
    } },
  dirt: { label: 'Lens dirt', blend: 'screen', params: { ...XY(35, 35), strength: N('Strength', 0.6, 0, 1.5, 0.05), spread: N('Light spread', 60, 10, 150, 1, '%'), amount: N('Dirt amount', 60, 10, 200, 1), color: C('Light colour', '#ffe2b8') },
    draw(g, W, H, p, t, dur, x) {
      const s = x.seed, U = x.U, cx = (W * p.x) / 100, cy = (H * p.y) / 100, sp = (U * p.spread) / 100;
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < p.amount; i++) {
        const px = R(s, i) * W, py = R(s, i, 1) * H, d = Math.hypot(px - cx, py - cy), lit = Math.exp(-((d / sp) ** 2));
        if (lit < 0.02) continue;
        const r = U * (0.008 + 0.05 * R(s, i, 2) ** 2.5), a = p.strength * lit * (0.08 + 0.25 * R(s, i, 3));
        if (R(s, i, 4) < 0.25) { g.strokeStyle = rgba(p.color, a); g.lineWidth = Math.max(0.7, r * 0.12); g.beginPath(); g.arc(px, py, r, 0, TAU); g.stroke(); } else glow(g, px, py, r, p.color, a);
      }
      glow(g, cx, cy, sp * 0.8, p.color, p.strength * 0.12);
    } },
  rain: { label: 'Rain', blend: 'screen', params: { density: N('Drops', 350, 10, 1500, 10), angle: N('Angle', 12, -45, 45, 1, '°'), speed: N('Speed', 230, 40, 600, 5), length: N('Drop length', 5, 0.5, 20, 0.1, '%'), opacity: N('Opacity', 0.35, 0, 1, 0.05), color: C('Colour', '#cfe0ff'), haze: N('Haze', 0.15, 0, 1, 0.05) },
    draw(g, W, H, p, t, dur, x) {
      const s = x.seed, U = x.U, a = rad(p.angle), dx = Math.sin(a), dy = Math.cos(a), L = (U * p.length) / 100, span = H + L * 2, tw = W + span * Math.abs(dx);
      if (p.haze > 0) { const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, rgba(p.color, p.haze * 0.25)); gr.addColorStop(1, rgba(p.color, p.haze * 0.05)); g.fillStyle = gr; g.fillRect(0, 0, W, H); }
      g.lineCap = 'round';
      for (let b = 0; b < 3; b++) {
        g.strokeStyle = rgba(p.color, p.opacity * (0.45 + 0.3 * b)); g.lineWidth = Math.max(0.6, U * 0.0009 * (1 + b * 0.6)); g.beginPath();
        for (let i = b; i < p.density; i += 3) {
          const v = ((U * p.speed) / 100) * (0.75 + 0.5 * R(s, i, 1)), d = (R(s, i, 2) * span + t * v) % span - L, x0 = R(s, i) * tw - (dx > 0 ? span * dx : 0);
          const px = x0 + d * dx, py = d * dy, l = L * (0.6 + 0.6 * R(s, i, 3));
          g.moveTo(px, py); g.lineTo(px - dx * l, py - dy * l);
        }
        g.stroke();
      }
    } },
  snow: { label: 'Snow', blend: '', params: { density: N('Flakes', 260, 10, 1500, 10), size: N('Flake size', 1, 0.3, 4, 0.05), speed: N('Fall speed', 9, 1, 60, 0.5), wind: N('Wind', 3, -40, 40, 0.5), opacity: N('Opacity', 0.85, 0, 1, 0.05), color: C('Colour', '#ffffff') },
    draw(g, W, H, p, t, dur, x) {
      const s = x.seed, U = x.U;
      g.fillStyle = rgba(p.color, p.opacity);
      for (let i = 0; i < p.density; i++) {
        const z = 0.4 + R(s, i, 3) * 0.9, v = (U * p.speed) / 100 * z, span = H + 20;
        const py = (R(s, i, 1) * span + t * v) % span - 10, px = ((R(s, i) * W + ((U * p.wind) / 100) * z * t + Math.sin(t * (0.6 + R(s, i, 4)) + i) * U * 0.012) % W + W) % W;
        const r = Math.max(0.6, U * 0.0016 * p.size * z);
        g.globalAlpha = clamp(0.4 + 0.6 * z); g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
      }
      g.globalAlpha = 1;
    } },
  dust: { label: 'Dust motes', blend: 'screen', params: { density: N('Motes', 120, 5, 800, 5), size: N('Size', 1, 0.3, 5, 0.05), drift: N('Drift', 1, 0, 5, 0.05), twinkle: N('Twinkle', 0.5, 0, 1, 0.05), opacity: N('Opacity', 0.55, 0, 1, 0.05), color: C('Colour', '#ffe7c2'), bokeh: N('Big soft ones', 6, 0, 40, 1) },
    draw(g, W, H, p, t, dur, x) {
      const s = x.seed, U = x.U;
      g.globalCompositeOperation = 'lighter'; g.fillStyle = rgba(p.color, 1);
      for (let i = 0; i < p.density; i++) {
        const px = ((R(s, i) * W + noise1(s + i, t * 0.15 * p.drift) * U * 0.08 + t * p.drift * U * 0.006) % W + W) % W, py = ((R(s, i, 1) * H + noise1(s + i * 7, t * 0.12 * p.drift) * U * 0.08 - t * p.drift * U * 0.004) % H + H) % H;
        const tw = 1 - p.twinkle * 0.5 * (1 + Math.sin(t * (1 + 3 * R(s, i, 2)) + i));
        g.globalAlpha = clamp(p.opacity * tw * (0.3 + 0.7 * R(s, i, 3))); const r = Math.max(0.6, U * 0.0013 * p.size * (0.5 + R(s, i, 4)));
        g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
      }
      g.globalAlpha = 1;
      for (let i = 0; i < p.bokeh; i++) glow(g, ((R(s, 900 + i) * W + t * U * 0.01 * p.drift) % W), R(s, 950 + i) * H + noise1(s + 900 + i, t * 0.1) * U * 0.05, U * (0.03 + 0.05 * R(s, 990 + i)), p.color, p.opacity * 0.18);
    } },
  burn: { label: 'Film burn', blend: 'screen', params: { color: C('Burn colour', '#ff5a00'), hot: C('Hot centre', '#ffe6a3'), side: SEL('From', 'right', [['right', 'Right'], ['left', 'Left'], ['top', 'Top'], ['bottom', 'Bottom']]), strength: N('Strength', 1, 0, 2, 0.05), speed: N('Speed', 1, 0.1, 5, 0.05), at: N('Peaks at (0 = steady)', 0, 0, 120, 0.05, 's'), life: N('Burn length', 1.2, 0.2, 10, 0.05, 's') },
    draw(g, W, H, p, t, dur, x) {
      const s = x.seed, U = x.U;
      const env = p.at > 0 ? Math.max(0, Math.sin(Math.PI * clamp((t - p.at + p.life / 2) / p.life))) : 0.8 + 0.2 * noise1(s, t * 2 * p.speed);
      if (env <= 0.01) return;
      const base = { right: [1, 0.5], left: [0, 0.5], top: [0.5, 0], bottom: [0.5, 1] }[p.side] || [1, 0.5];
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) {
        const along = noise1(s + i * 13, t * 0.4 * p.speed + i * 2) * 0.55, inw = 0.1 + 0.25 * (0.5 + 0.5 * noise1(s + i * 29, t * 0.7 * p.speed)) * env;
        const px = base[1] === 0.5 ? W * Math.abs(base[0] - inw) : W * (0.5 + along), py = base[1] === 0.5 ? H * (0.5 + along) : H * Math.abs(base[1] - inw);
        const r = U * (0.25 + 0.35 * (0.5 + 0.5 * noise1(s + i * 7, t * 0.8 * p.speed))) * env;
        glow(g, px, py, r, p.color, p.strength * 0.5 * env, p.hot, 0.3);
      }
      if (env > 0.7) { g.fillStyle = rgba(p.hot, (env - 0.7) * p.strength * 0.6); g.fillRect(0, 0, W, H); }
    } },
  screen: { label: 'Screen replacement', blend: '', params: { mediaId: { label: 'Picture / video', type: 'media', def: null }, srcIn: N('Video starts at', 0, 0, 99999, 0.04, 's'), q: { label: 'Corners (TL TR BL BR, % of the frame)', type: 'quad', def: [30, 25, 70, 25, 30, 75, 70, 75] }, opacity: N('Opacity', 1, 0, 1, 0.05), glare: N('Glass glare', 0.15, 0, 1, 0.05), bright: N('Screen brightness', 1, 0.3, 2, 0.05) },
    draw(g, W, H, p, t, dur, x) {
      const src = p.mediaId && (x.video?.(p.mediaId, (+p.srcIn || 0) + t, 1) || x.img?.(p.mediaId));
      const q = Array.isArray(p.q) && p.q.length === 8 ? p.q : KINDS.screen.params.q.def, P = [0, 1, 2, 3].map((i) => [(W * q[i * 2]) / 100, (H * q[i * 2 + 1]) / 100]);
      g.save(); g.globalAlpha = clamp(p.opacity);
      const sw = src?.videoWidth || src?.naturalWidth || src?.width, sh = src?.videoHeight || src?.naturalHeight || src?.height;
      if (src && sw && sh) {
        if (p.bright !== 1) g.filter = `brightness(${p.bright})`;
        warp(g, src, sw, sh, P);
        g.filter = 'none';
      } else { g.fillStyle = 'rgba(30,30,30,0.85)'; quadPath(g, P); g.fill(); }
      if (p.glare > 0) {
        const gr = g.createLinearGradient(P[0][0], P[0][1], P[3][0], P[3][1]);
        gr.addColorStop(0, `rgba(255,255,255,${(p.glare * 0.5).toFixed(3)})`); gr.addColorStop(0.45, 'rgba(255,255,255,0)'); gr.addColorStop(1, `rgba(255,255,255,${(p.glare * 0.15).toFixed(3)})`);
        g.fillStyle = gr; quadPath(g, P); g.fill();
      }
      g.restore();
    } },
};
const quadPath = (g, P) => { g.beginPath(); g.moveTo(...P[0]); g.lineTo(...P[1]); g.lineTo(...P[3]); g.lineTo(...P[2]); g.closePath(); };
// a picture into four corners in perspective: a grid of small triangles, each drawn with its own affine transform
// (canvas has no perspective) - the corners bilinear, fine enough that the seams do not show
function warp(g, src, sw, sh, P, n = 12) {
  const at = (u, v) => [(1 - v) * ((1 - u) * P[0][0] + u * P[1][0]) + v * ((1 - u) * P[2][0] + u * P[3][0]), (1 - v) * ((1 - u) * P[0][1] + u * P[1][1]) + v * ((1 - u) * P[2][1] + u * P[3][1])];
  const tri = (s0, s1, s2, d0, d1, d2) => {
    const [x0, y0] = s0, [x1, y1] = s1, [x2, y2] = s2, [u0, v0] = d0, [u1, v1] = d1, [u2, v2] = d2;
    const den = x0 * (y2 - y1) - x1 * y2 + x2 * y1 + (x1 - x2) * y0;
    if (Math.abs(den) < 1e-9) return;
    const a = -(y0 * (u2 - u1) - y1 * u2 + y2 * u1 + (y1 - y2) * u0) / den, b = (y1 * v2 + y0 * (v1 - v2) - y2 * v1 + (y2 - y1) * v0) / den;
    const c = (x0 * (u2 - u1) - x1 * u2 + x2 * u1 + (x1 - x2) * u0) / den, d = -(x1 * v2 + x0 * (v1 - v2) - x2 * v1 + (x2 - x1) * v0) / den;
    const e = (x0 * (y2 * u1 - y1 * u2) + y0 * (x1 * u2 - x2 * u1) + (x2 * y1 - x1 * y2) * u0) / den, f = (x0 * (y2 * v1 - y1 * v2) + y0 * (x1 * v2 - x2 * v1) + (x2 * y1 - x1 * y2) * v0) / den;
    // (a hair bigger than the triangle, so neighbours overlap and no hairline gap shows)
    const mx = (u0 + u1 + u2) / 3, my = (v0 + v1 + v2) / 3, grow = (px, py) => [px + (px - mx) * 0.02, py + (py - my) * 0.02];
    g.save(); g.beginPath(); g.moveTo(...grow(u0, v0)); g.lineTo(...grow(u1, v1)); g.lineTo(...grow(u2, v2)); g.closePath(); g.clip();
    g.transform(a, b, c, d, e, f); g.drawImage(src, 0, 0, sw, sh); g.restore();
  };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const u0 = i / n, u1 = (i + 1) / n, v0 = j / n, v1 = (j + 1) / n, A = at(u0, v0), B = at(u1, v0), Cc = at(u0, v1), D = at(u1, v1);
    tri([u0 * sw, v0 * sh], [u1 * sw, v0 * sh], [u0 * sw, v1 * sh], A, B, Cc);
    tri([u1 * sw, v0 * sh], [u1 * sw, v1 * sh], [u0 * sw, v1 * sh], B, D, Cc);
  }
}

// the drawing's version: part of a baked element's key (graphics.js gfxKey) - raise it when a look changes, so renders
// bake the new look instead of reusing frames of the old one
export const VFX_V = 1;
export const defaultsOf = (kind) => Object.fromEntries(Object.entries(KINDS[kind]?.params || {}).map(([k, d]) => [k, Array.isArray(d.def) ? [...d.def] : d.def]));
export const newVfx = (kind, p = {}, seed = Math.floor(Math.random() * 1e6)) => ({ kind, seed, p: { ...defaultsOf(kind), ...p } });
// every parameter at time t (keyframes and wiggle worked out, missing ones filled in)
export function paramsAt(v, t) {
  const d = KINDS[v.kind]; if (!d) return {};
  const o = {};
  for (const [k, x] of Object.entries(d.params)) { const q = val(v.p?.[k], t); o[k] = q === undefined || q === null ? x.def : typeof x.def === 'number' ? (Number.isFinite(+q) ? +q : x.def) : q; }
  return o;
}
// t: seconds into the clip; extra: { img(id), video(id, t, rate) } (graphics.js passes its loaders)
export function drawVfx(g, W, H, v, t, dur, extra = {}) {
  g.clearRect(0, 0, W, H);
  const d = KINDS[v?.kind]; if (!d) return;
  g.save();
  try { d.draw(g, W, H, paramsAt(v, t), t, dur, { seed: (v.seed | 0) || 1, U: Math.sqrt(W * H), img: extra.img, video: extra.video }); } finally { g.restore(); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; }
}
// the videos a bake has to show at t (screen replacement)
export const vfxVideos = (v, t) => (v?.kind === 'screen' && val(v.p?.mediaId, t) ? [{ id: val(v.p.mediaId, t), t: (+val(v.p.srcIn, t) || 0) + t }] : []);
