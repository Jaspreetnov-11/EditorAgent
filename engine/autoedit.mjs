#!/usr/bin/env node
// autoedit.mjs - rule-based automatic edit (no AI).
// Picks lively moments (motion + loudness, skipping dark/black frames), cuts them to music beats
// or to a reference video's shot rhythm, optionally matching the reference's brightness/colour.
// Usage: node autoedit.mjs <request.json> <out-project.json>
//
// request: { dir, cacheDir, clips: [names], mode: "highlights"|"reference", target: 30, pace: "fast"|"medium"|"slow",
//            aspect, music, reference, useRefAudio, matchLook, keepSound, title, endText }
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beats, bestSection } from './music.mjs';

const [reqFile, outFile] = process.argv.slice(2);
const req = JSON.parse(fs.readFileSync(reqFile, 'utf8').replace(/^\uFEFF/, ''));
// media can be referenced by id with an explicit path map (v2 projects) or by file name inside req.dir
const P = (n) => req.paths?.[n] ?? path.join(req.dir, n);
const IMAGE = /\.(jpg|jpeg|png|webp|bmp|tif|tiff)$/i;
const log = (s) => console.log(s);

function ffLog(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.error) throw new Error('ffmpeg not found');
  return r.stderr;
}
function probe(f) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout || '{}');
  const v = j.streams?.find((s) => s.codec_type === 'video');
  return { duration: +j.format?.duration || 0, width: v?.width, height: v?.height, hasAudio: !!j.streams?.find((s) => s.codec_type === 'audio') };
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] || 0; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r2 = (x) => Math.round(x * 100) / 100;

// ---- per-second analysis of one video (cached by file mtime) ----
// fps: 2 is plenty for picking moments; a reference needs ~10 to place its cuts within 0.1 s.
function analyze(name, fps = 2) {
  const file = P(name), st = fs.statSync(file);
  const cache = path.join(req.cacheDir, `${name}.analysis${fps === 2 ? '' : fps}.json`);
  if (fs.existsSync(cache)) {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (c.mtime === st.mtimeMs && c.v === 2) return c;
  }
  const info = probe(file);
  const secs = Math.max(1, Math.ceil(info.duration));
  const motion = Array.from({ length: secs }, () => []), luma = Array.from({ length: secs }, () => []), sat = [];
  const cuts = [];
  let t = 0;
  const out = ffLog(['-i', file, '-an', '-vf', `fps=${fps},scale=160:-2,select='gte(scene,0)',signalstats,metadata=print`, '-f', 'null', '-']);
  for (const line of out.split(/\r?\n/)) {
    let m;
    if ((m = /pts_time:([\d.]+)/.exec(line))) t = +m[1];
    else if ((m = /lavfi\.scene_score=([\d.]+)/.exec(line))) {
      const s = +m[1], k = Math.min(secs - 1, Math.floor(t));
      motion[k].push(s);
      if (s > 0.3 && t > 0.3 && !(cuts.length && t - cuts[cuts.length - 1] < 0.25)) cuts.push(r2(t));
    } else if ((m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line))) luma[Math.min(secs - 1, Math.floor(t))].push(+m[1]);
    else if ((m = /lavfi\.signalstats\.SATAVG=([\d.]+)/.exec(line))) sat.push(+m[1]);
  }
  const loud = new Array(secs).fill(null);
  if (info.hasAudio) {
    const lo = Array.from({ length: secs }, () => []);
    for (const m of ffLog(['-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-']).matchAll(/t:\s*([\d.]+)\s+TARGET:[^M]*M:\s*(-?[\d.]+|-inf)/g))
      lo[Math.min(secs - 1, Math.floor(+m[1]))].push(m[2] === '-inf' ? -70 : +m[2]);
    lo.forEach((a, i) => (loud[i] = a.length ? mean(a) : null));
  }
  const res = {
    v: 2, mtime: st.mtimeMs, duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio,
    motion: motion.map(mean), luma: luma.map((a) => (a.length ? mean(a) : 128)), loud, cuts,
    yavg: mean(luma.flat()), satavg: mean(sat),
  };
  fs.writeFileSync(cache, JSON.stringify(res));
  return res;
}

// "interest" score per second: motion + loudness, heavy penalty for near-black/blown-out frames
function scoreOf(a) {
  const mHi = pct(a.motion, 0.95) || 1;
  return a.motion.map((m, i) => {
    let s = clamp(m / mHi, 0, 1);
    if (a.loud[i] !== null) s = 0.6 * s + 0.4 * clamp((a.loud[i] + 50) / 40, 0, 1);
    if (a.luma[i] < 25 || a.luma[i] > 235) s -= 1;
    return s;
  });
}

// ---- main ----
const PACE = { fast: 1.5, medium: 2.5, slow: 4 }[req.pace] || 2.5;
let target = +req.target || 30;
let aspect = req.aspect || '9:16';
let slots = [];
let look = null;
let musicIn = 0;
const project = {
  name: req.name || 'auto_edit', aspect, fps: 30, fit: '', kenburns: true, transition: { type: 'cut', duration: 0.5 }, clips: [],
  music: { src: '', volume: 0.8, duck: false }, vo: { src: '', start: 0, volume: 1 }, logo: { src: '', pos: 'tr', scale: 0.12, opacity: 0.9 },
  subtitles: '', audio: { originalVolume: 1, loudness: -14 }, crf: 20,
};

const total = req.clips.length + (req.reference ? 1 : 0) + (req.music ? 1 : 0);
let step = 0;
const analysis = {};
for (const n of req.clips) {
  log(`[${++step}/${total}] Analyzing ${n}`);
  if (!IMAGE.test(P(n))) analysis[n] = analyze(n);
}

if (req.mode === 'reference') {
  if (!req.reference) throw new Error('Choose a reference video');
  log(`[${++step}/${total}] Reading reference rhythm: ${req.reference}`);
  const ref = analyze(req.reference, 10);
  const ratio = ref.width / ref.height;
  aspect = Object.entries({ '9:16': 9 / 16, '4:5': 0.8, '1:1': 1, '16:9': 16 / 9 }).sort((a, b) => Math.abs(a[1] - ratio) - Math.abs(b[1] - ratio))[0][0];
  const edges = [0, ...ref.cuts, ref.duration];
  for (let i = 1; i < edges.length; i++) {
    const d = edges[i] - edges[i - 1];
    if (d < 0.5 && slots.length) slots[slots.length - 1] += d; else slots.push(d);
  }
  target = ref.duration;
  look = { yavg: ref.yavg, satavg: ref.satavg };
  log(`  reference: ${ref.duration.toFixed(1)}s, ${slots.length} shots, avg shot ${(ref.duration / slots.length).toFixed(2)}s, format ${aspect}`);
  if (req.useRefAudio && ref.hasAudio) {
    project.music = { src: req.reference, volume: 1, duck: false };
    project.audio.originalVolume = 0;
  }
} else {
  let grid = null;
  if (req.music) {
    log(`[${++step}/${total}] Finding beats in ${req.music}`);
    grid = beats(P(req.music));
    if (grid) log(`  music tempo ~${grid.bpm} BPM, cutting on the beat`);
    if (req.musicBest !== false) {
      // Start the music at its most energetic section; that start is snapped to a beat,
      // so relative to it the first beat is at 0.
      const sec = bestSection(P(req.music), target);
      if (sec?.in > 0) {
        musicIn = sec.in;
        if (grid) grid = { ...grid, first: 0 };
        log(`  using the best part of the music from ${Math.floor(musicIn / 60)}:${String(Math.round(musicIn % 60)).padStart(2, '0')}`);
      }
    }
  }
  if (grid) {
    const per = Math.max(1, Math.round(PACE / grid.period));
    const n = per > 2 ? Math.round(per / 2) * 2 : per; // whole bars feel natural
    const len = n * grid.period;
    let t = grid.first + len;
    slots.push(t);
    while (t + len <= target + len / 2) { slots.push(len); t += len; }
  } else {
    const n = Math.max(1, Math.round(target / PACE));
    slots = Array(n).fill(target / n);
  }
}
project.aspect = aspect;

// ---- choose a moment for every slot ----
const scores = Object.fromEntries(Object.entries(analysis).map(([n, a]) => [n, scoreOf(a)]));
const used = Object.fromEntries(req.clips.map((n) => [n, []]));
const useCount = Object.fromEntries(req.clips.map((n) => [n, 0]));
const picks = [];
let prevClip = null;
for (const [i, L] of slots.entries()) {
  let best = null;
  for (const n of req.clips) {
    const penalty = (n === prevClip ? 0.25 : 0) + 0.08 * useCount[n];
    if (IMAGE.test(P(n))) {
      // photos may repeat (heavily penalised) so a photos-only edit can still fill every slot
      const s = 0.45 - penalty - 0.3 * useCount[n];
      if (!best || s > best.s) best = { n, s, start: 0 };
      continue;
    }
    const a = analysis[n], sc = scores[n];
    if (a.duration < L + 0.2) continue;
    const cuts = [0, ...a.cuts, a.duration];
    for (let st = 0.2; st + L <= a.duration - 0.1; st += 0.5) {
      if (used[n].some(([u0, u1]) => st < u1 && st + L > u0)) continue;
      const crossesCut = cuts.some((c) => c > st + 0.15 && c < st + L - 0.15);
      const win = sc.slice(Math.floor(st), Math.ceil(st + L));
      const s = mean(win) - (crossesCut ? 0.3 : 0) - penalty;
      if (!best || s > best.s) best = { n, s, start: st };
    }
  }
  if (!best) { // footage exhausted: allow reuse of the longest clip
    const n = req.clips.filter((c) => !IMAGE.test(P(c))).sort((x, y) => analysis[y].duration - analysis[x].duration)[0];
    if (!n || analysis[n].duration < 0.5) throw new Error('Not enough footage for this length - add more clips or shorten the target.');
    best = { n, s: 0, start: (i * 1.7) % Math.max(0.1, analysis[n].duration - L) };
  }
  picks.push({ ...best, L, order: i });
  if (!IMAGE.test(P(best.n))) used[best.n].push([best.start, best.start + L]);
  useCount[best.n]++;
  prevClip = best.n;
}

// Keep story order: sort chosen moments by (clip order, time), then lay them onto the slot lengths.
const order = (p) => req.clips.indexOf(p.n) * 1e6 + p.start;
const chrono = [...picks].sort((a, b) => order(a) - order(b));
project.clips = chrono.map((p, i) => {
  const L = slots[i];
  if (IMAGE.test(P(p.n))) return { type: 'image', src: p.n, duration: r2(L) };
  const a = analysis[p.n];
  const mid = p.start + p.L / 2, s = clamp(mid - L / 2, 0, Math.max(0, a.duration - L));
  const c = { type: 'video', src: p.n, in: r2(s), out: r2(Math.min(a.duration, s + L)) };
  if (look && a.yavg) {
    const b = clamp((look.yavg - a.yavg) / 255, -0.2, 0.2), sat = clamp(a.satavg ? look.satavg / a.satavg : 1, 0.6, 1.6);
    if (Math.abs(b) > 0.02 || Math.abs(sat - 1) > 0.05) c.color = { brightness: r2(b), saturation: r2(sat), contrast: 1 };
  }
  return c;
});

if (req.music && req.mode !== 'reference') {
  project.music = { src: req.music, volume: req.keepSound ? 0.5 : 0.9, duck: !!req.keepSound, ...(musicIn ? { in: musicIn } : {}) };
  project.audio.originalVolume = req.keepSound ? 1 : 0;
}
if (req.title && project.clips[0]) Object.assign(project.clips[0], { text: req.title, textStyle: 'center', textDuration: Math.min(3, slots[0]) });
if (req.endText) {
  const last = project.clips[project.clips.length - 1];
  project.clips.push({ type: 'card', text: req.endText, duration: 2.5, bg: '#0b2545', fadeOut: 1 });
  if (last) last.fadeOut = undefined;
}
project.clips.forEach((c, i) => (c.id = `a${i}${Math.random().toString(36).slice(2, 6)}`));

fs.writeFileSync(outFile, JSON.stringify(project, null, 2));
const len = project.clips.reduce((s, c) => s + (c.type === 'video' ? c.out - c.in : c.duration), 0);
log(`Auto edit ready: ${project.clips.length} clips, ${len.toFixed(1)}s, ${aspect}`);
