#!/usr/bin/env node
// music.mjs - music analysis shared by the app and autoedit.mjs (no AI).
//   node music.mjs best <file> <seconds>   -> {"in":..,"out":..,"bpm":..}  most energetic section, snapped to a beat
//   node music.mjs beats <file>             -> {"period":..,"first":..,"bpm":..}
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r2 = (x) => Math.round(x * 100) / 100;

function duration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return +r.stdout || 0;
}

// Beat grid: energy-onset envelope + autocorrelation tempo, refined to a fractional lag.
export function beats(file, maxSecs = 240) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-t', String(maxSecs), '-ac', '1', '-ar', '22050', '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
  const buf = r.stdout;
  if (!buf?.length) return null;
  const x = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const hop = 256, sr = 22050, fr = sr / hop, env = [];
  let prev = 0;
  for (let i = 0; i + 1024 < x.length; i += hop) {
    let e = 0;
    for (let j = i; j < i + 1024; j++) e += (x[j] / 32768) ** 2;
    const le = Math.log(e + 1e-6);
    env.push(Math.max(0, le - prev));
    prev = le;
  }
  if (env.length < fr * 4) return null;
  const ac = (lag) => { let s = 0; for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag]; return s; };
  let best = { score: -1 };
  for (let lag = Math.round(fr * 0.33); lag <= Math.round(fr * 1.0); lag++) {
    const bpm = (60 * fr) / lag;
    const s = ac(lag) * Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.6) ** 2); // prefer tempi near 120 BPM
    if (s > best.score) best = { score: s, lag };
  }
  // Lags are whole hops (~12 ms); refine, otherwise cuts drift off the beat over a 30-60 s edit.
  const [a, b, c] = [ac(best.lag - 1), ac(best.lag), ac(best.lag + 1)];
  const lag = best.lag + (a - 2 * b + c !== 0 ? clamp((0.5 * (a - c)) / (a - 2 * b + c), -0.5, 0.5) : 0);
  let phase = { s: -1, off: 0 };
  for (let off = 0; off < lag; off++) {
    let s = 0;
    for (let k = 0, i = off; i < env.length; i = Math.round(off + ++k * lag)) s += env[i];
    if (s > phase.s) phase = { s, off };
  }
  return { period: lag / fr, first: phase.off / fr, bpm: Math.round((60 * fr) / lag) };
}

// How hard the music hits over time: momentary loudness every 0.1 s from `start` for `len` seconds, smoothed and
// scaled 0..1 between the quiet and loud parts of this stretch. Drives the cutting rhythm (calm = long shots, drop = fast cuts).
export function energyCurve(file, start = 0, len = 60) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(start), '-t', String(len), '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const pts = [...r.stderr.matchAll(/t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-inf)/g)].map((m) => [+m[1], m[2] === '-inf' ? -70 : Math.max(-70, +m[2])]);
  if (pts.length < 5) return null;
  const v = pts.map((p) => p[1]), sorted = [...v].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.1)], hi = sorted[Math.floor(sorted.length * 0.95)];
  const sm = v.map((_, i) => { const w = v.slice(Math.max(0, i - 5), i + 6); return w.reduce((a, b) => a + b, 0) / w.length; });
  const step = pts.length > 1 ? pts[1][0] - pts[0][0] : 0.1;
  const val = sm.map((x) => clamp((x - lo) / Math.max(1, hi - lo), 0, 1));
  return { step, val, at: (t) => val[clamp(Math.round(t / step), 0, val.length - 1)] };
}

// Most energetic section of length `len` (short-term loudness), with a bonus for starting where the
// music lifts (chorus / drop entry), snapped back to the nearest beat so cuts stay on the grid.
export function bestSection(file, len) {
  const total = duration(file);
  if (!total) return null;
  if (len >= total - 0.5) return { in: 0, out: r2(total), bpm: beats(file)?.bpm ?? null };
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const pts = [...r.stderr.matchAll(/t:\s*([\d.]+)\s+TARGET:.*?M:\s*\S+\s+S:\s*(-?[\d.]+|-inf)/g)].map((m) => [+m[1], m[2] === '-inf' ? -70 : Math.max(-70, +m[2])]);
  if (pts.length < 10) return { in: 0, out: r2(Math.min(total, len)), bpm: null };
  const step = pts.length > 1 ? pts[1][0] - pts[0][0] : 0.1;
  const S = pts.map((p) => p[1]);
  const pre = [0];
  for (const v of S) pre.push(pre[pre.length - 1] + v);
  const avg = (i, j) => (pre[clamp(j, 0, S.length)] - pre[clamp(i, 0, S.length)]) / Math.max(1, clamp(j, 0, S.length) - clamp(i, 0, S.length));
  const n = Math.round(len / step), k3 = Math.round(3 / step);
  let best = { s: -Infinity, i: 0 };
  // skip the first ~2 s (fade-ins, applause) unless the song is short
  for (let i = Math.min(Math.round(2 / step), S.length - n); i + n <= S.length; i++) {
    const body = avg(i, i + n), lift = i > k3 ? avg(i, i + k3) - avg(i - k3, i) : 0;
    const s = body + 0.35 * Math.max(0, lift);
    if (s > best.s) best = { s, i };
  }
  let start = pts[best.i][0] - 3; // ebur128 short-term is a trailing 3 s window
  const grid = beats(file);
  if (grid) start = grid.first + Math.round((start - grid.first) / grid.period) * grid.period;
  start = clamp(start, 0, Math.max(0, total - len));
  return { in: r2(start), out: r2(Math.min(total, start + len)), bpm: grid?.bpm ?? null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, file, secs] = process.argv.slice(2);
  if (cmd === 'best') console.log(JSON.stringify(bestSection(file, +secs || 30)));
  else if (cmd === 'beats') console.log(JSON.stringify(beats(file)));
  else console.log('usage: node music.mjs best <file> <seconds> | beats <file>');
}
