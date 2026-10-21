// colorstats.mjs - measures a clip's colour (a few sampled frames) and proposes grades:
//   autoGrade: LOG detection + white balance + exposure + black/white levels + saturation
//   matchGrade: makes a clip's channel means/spreads match a (graded) reference clip
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LUMA, colorFilters, stager } from './color.mjs';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r3 = (x) => Math.round(x * 1000) / 1000;

// colour statistics do not need the exact frame: the keyframe at / before t is decoded alone (a camera original
// would otherwise decode up to a second of 4K frames to reach t) - about 10x faster on long-GOP footage
const KEY = ['-noaccurate_seek', '-skip_frame', 'nokey'];
function grab(file, t, filters, cwd, key = true) {
  return new Promise((ok) => {
    const vf = [...filters, 'scale=128:-2:flags=area', 'format=rgb24'].join(',');
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...(key ? KEY : []), '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', 'pipe:1'], { cwd, windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('close', () => ok(Buffer.concat(chunks)));
    p.on('error', () => ok(Buffer.alloc(0)));
  }).then((b) => (b.length || !key ? b : grab(file, t, filters, cwd, false))); // no keyframe there (long-GOP stock / screen recordings): decode to t
}

// Frames at 10/30/50/70/90% of [tin, tout] (one frame for images), optionally through a grade first.
export async function measure(file, { tin = 0, tout = 0, image = false, color = null, luts = {} } = {}) {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'vstat-'));
  const pre = color ? colorFilters(color, { luts, stage: stager(wd) }) : [];
  const times = image || tout - tin < 0.5 ? [tin] : [0.1, 0.3, 0.5, 0.7, 0.9].map((k) => tin + (tout - tin) * k);
  const bufs = await Promise.all(times.map((t) => grab(file, t, pre, wd)));
  fs.rmSync(wd, { recursive: true, force: true });
  const px = Buffer.concat(bufs);
  if (px.length < 300) return null;
  const hist = new Uint32Array(256);
  let n = 0, sat = 0;
  const sum = [0, 0, 0], sq = [0, 0, 0], neutral = [0, 0, 0];
  let nn = 0;
  for (let i = 0; i + 2 < px.length; i += 3) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const l = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    hist[Math.min(255, Math.round(l * 255))]++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx > 0 ? (mx - mn) / mx : 0;
    sat += s; n++;
    sum[0] += r; sum[1] += g; sum[2] += b; sq[0] += r * r; sq[1] += g * g; sq[2] += b * b;
    if (l > 0.15 && l < 0.85 && s < 0.3) { neutral[0] += r; neutral[1] += g; neutral[2] += b; nn++; }
  }
  const pct = (p) => { let acc = 0; const target = n * p; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i / 255; } return 1; };
  const mean = sum.map((s) => s / n), std = sq.map((s, i) => Math.sqrt(Math.max(1e-6, s / n - mean[i] * mean[i])));
  const nm = nn > n * 0.02 ? neutral.map((s) => s / nn) : mean;
  return { p1: pct(0.01), p5: pct(0.05), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), sat: sat / n, mean, std, neutral: nm, frames: times.length };
}

// LOG footage looks flat (no deep blacks, no bright whites) and washed out.
export const looksLog = (s, m = {}) => s && s.p99 - s.p1 < 0.62 && s.p1 > 0.05 && s.sat < 0.2 && (/10|12/.test(m.pixfmt || '') || /mxf/i.test(m.name || '') || s.p99 < 0.8);

export function autoGrade(s, { strength = 1 } = {}) {
  const k = clamp(strength, 0, 1);
  const out = {};
  // white balance from near-neutral midtones
  const [rm, gm, bm] = s.neutral;
  if (rm + bm > 0.02) {
    const t = clamp(((bm - rm) / (0.12 * (rm + bm))) * 0.8 * k, -0.8, 0.8);
    const rb = (rm + bm) / 2, ti = clamp(((gm - rb) / (0.08 * gm + 0.04 * rb)) * 0.8 * k, -0.8, 0.8);
    if (Math.abs(t) > 0.03) out.temp = r3(t);
    if (Math.abs(ti) > 0.03) out.tint = r3(ti);
  }
  // exposure: bring the median towards ~42%, without pushing the brightest 1% past white
  let exp = Math.log2(0.42 / Math.max(0.02, s.p50)) * 0.65 * k;
  if (s.p99 > 0.05) exp = Math.min(exp, Math.log2(1.0 / s.p99));
  exp = clamp(exp, -1.5, 1.5);
  if (Math.abs(exp) > 0.06) out.exposure = r3(exp);
  // levels: blacks to ~2%, whites to ~95%: v' = v*gain + offset (applied after exposure + contrast pivot)
  const m = Math.pow(2, out.exposure || 0), lo = s.p1 * m, hi = Math.min(1, s.p99 * m);
  if (hi - lo > 0.05) {
    const tlo = 0.02, thi = Math.max(Math.min(hi, 1), 0.95);
    let a = clamp((thi - tlo) / (hi - lo), 0.85, 2.4);
    a = 1 + (a - 1) * k;
    const off = clamp((tlo - a * lo) * k, -0.9, 0.2);
    if (Math.abs(a - 1) > 0.02) out.gain = { y: r3(a - 1) };
    if (Math.abs(off) > 0.01) out.offset = { y: r3(off) };
  }
  if (s.sat < 0.16) out.saturation = r3(1 + 0.18 * k);
  return out;
}

// Per-channel gain + offset so the target's channel means/spreads land on the reference's.
export function matchGrade(t, r) {
  const gain = {}, offset = {};
  ['r', 'g', 'b'].forEach((ch, i) => {
    const kk = clamp(r.std[i] / Math.max(0.01, t.std[i]), 0.5, 2.5);
    const off = r.mean[i] - t.mean[i] * kk;
    gain[ch] = r3(kk - 1); offset[ch] = r3(clamp(off, -1, 1));
  });
  return { gain: { y: 0, ...gain }, offset: { y: 0, ...offset } };
}
