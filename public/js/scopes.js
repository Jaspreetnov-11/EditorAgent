// Video scopes drawn from a small graded RGBA frame: Waveform, RGB Parade, Vectorscope, Histogram.
import { LUMA } from './colormath.js';

const GRID = '#ffffff22', TXT = '#ffffff66';

export function drawScope(canvas, type, px, w, h) {
  const W = canvas.width, H = canvas.height, g = canvas.getContext('2d');
  g.fillStyle = '#07080a'; g.fillRect(0, 0, W, H);
  if (!px) { g.fillStyle = TXT; g.font = '12px Segoe UI'; g.fillText('No picture', 10, 20); return; }
  ({ waveform, parade, vector, histogram }[type] || waveform)(g, W, H, px, w, h);
}

// Accumulate hits into a buffer then map counts to brightness (log-ish so faint traces still show).
function paint(g, W, H, acc, tint, gain = 1) {
  const img = g.createImageData(W, H), d = img.data;
  let max = 1; for (let i = 0; i < acc.length; i++) if (acc[i] > max) max = acc[i];
  const norm = 1 / Math.log1p(max * 0.25);
  for (let i = 0; i < acc.length; i++) {
    if (!acc[i]) { d[i * 4 + 3] = 255; d[i * 4] = 7; d[i * 4 + 1] = 8; d[i * 4 + 2] = 10; continue; }
    const k = Math.min(1, Math.log1p(acc[i] * gain) * norm * 1.4);
    const c = typeof tint === 'function' ? tint(i) : tint;
    d[i * 4] = 7 + c[0] * k; d[i * 4 + 1] = 8 + c[1] * k; d[i * 4 + 2] = 10 + c[2] * k; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
function levels(g, W, H, x0 = 0, x1 = W) {
  g.strokeStyle = GRID; g.fillStyle = TXT; g.font = '10px Segoe UI'; g.lineWidth = 1;
  for (const v of [0, 25, 50, 75, 100]) {
    const y = Math.round(6 + (1 - v / 100) * (H - 12)) + 0.5;
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    if (x0 === 0) g.fillText(String(v), 2, y - 2);
  }
}
const rowOf = (v, H) => Math.round(6 + (1 - Math.min(1, Math.max(0, v))) * (H - 12));

function waveform(g, W, H, px, w, h) {
  const acc = new Float32Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, l = (LUMA[0] * px[i] + LUMA[1] * px[i + 1] + LUMA[2] * px[i + 2]) / 255;
    acc[rowOf(l, H) * W + Math.floor((x / w) * W)]++;
  }
  paint(g, W, H, acc, [140, 230, 160]);
  levels(g, W, H);
}

function parade(g, W, H, px, w, h) {
  const acc = new Float32Array(W * H), cw = Math.floor(W / 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, col = Math.floor((x / w) * (cw - 4));
    for (let c = 0; c < 3; c++) acc[rowOf(px[i + c] / 255, H) * W + c * cw + 2 + col]++;
  }
  paint(g, W, H, acc, (i) => { const c = Math.min(2, Math.floor((i % W) / cw)); return [[255, 70, 70], [70, 230, 90], [80, 130, 255]][c]; });
  levels(g, W, H);
  g.strokeStyle = GRID; for (const x of [cw, cw * 2]) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
}

function vector(g, W, H, px, w, h) {
  const S = Math.min(W, H), cx = W / 2, cy = H / 2, R = S * 0.46;
  const acc = new Float32Array(W * H), col = new Float32Array(W * H * 3);
  for (let i = 0; i < w * h * 4; i += 4) {
    const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255, Y = LUMA[0] * r + LUMA[1] * gg + LUMA[2] * b;
    const cb = (b - Y) / 1.8556, cr = (r - Y) / 1.5748;
    const x = Math.round(cx + cb * 2 * R), y = Math.round(cy - cr * 2 * R);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const k = y * W + x; acc[k]++; col[k * 3] += r; col[k * 3 + 1] += gg; col[k * 3 + 2] += b;
  }
  paint(g, W, H, acc, (k) => { const n = acc[k] || 1; return [80 + 175 * (col[k * 3] / n), 80 + 175 * (col[k * 3 + 1] / n), 80 + 175 * (col[k * 3 + 2] / n)]; }, 2);
  g.strokeStyle = GRID; g.lineWidth = 1;
  for (const f of [1, 0.75, 0.5, 0.25]) { g.beginPath(); g.arc(cx, cy, R * f, 0, Math.PI * 2); g.stroke(); }
  g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
  // 75% colour-bar targets
  g.font = '10px Segoe UI'; g.fillStyle = TXT;
  for (const [lab, r, gg, b] of [['R', 0.75, 0, 0], ['Yl', 0.75, 0.75, 0], ['G', 0, 0.75, 0], ['Cy', 0, 0.75, 0.75], ['B', 0, 0, 0.75], ['Mg', 0.75, 0, 0.75]]) {
    const Y = LUMA[0] * r + LUMA[1] * gg + LUMA[2] * b, x = cx + ((b - Y) / 1.8556) * 2 * R, y = cy - ((r - Y) / 1.5748) * 2 * R;
    g.strokeRect(x - 5, y - 5, 10, 10); g.fillText(lab, x + 7, y + 3);
  }
  // skin-tone line (~123 degrees)
  const a = (123 * Math.PI) / 180;
  g.strokeStyle = '#ffb36688'; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy - Math.sin(a) * R); g.stroke();
  g.fillStyle = '#ffb366aa'; g.fillText('skin', cx + Math.cos(a) * R * 0.75 - 26, cy - Math.sin(a) * R * 0.75);
}

function histogram(g, W, H, px, w, h) {
  const bins = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  for (let i = 0; i < w * h * 4; i += 4) { bins[0][px[i]]++; bins[1][px[i + 1]]++; bins[2][px[i + 2]]++; }
  let max = 1; for (const b of bins) for (let i = 1; i < 255; i++) max = Math.max(max, b[i]);
  g.globalCompositeOperation = 'lighter';
  [['#ff4646', 0], ['#46e65a', 1], ['#5082ff', 2]].forEach(([c, k]) => {
    g.fillStyle = `${c}99`; g.beginPath(); g.moveTo(0, H);
    for (let i = 0; i < 256; i++) g.lineTo((i / 255) * W, H - Math.min(1, bins[k][i] / max) * (H - 8));
    g.lineTo(W, H); g.closePath(); g.fill();
  });
  g.globalCompositeOperation = 'source-over';
  g.strokeStyle = GRID; for (const v of [0.25, 0.5, 0.75]) { g.beginPath(); g.moveTo(v * W + 0.5, 0); g.lineTo(v * W + 0.5, H); g.stroke(); }
}
