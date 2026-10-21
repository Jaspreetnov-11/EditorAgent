// refstyle.mjs - the "style DNA" of a reference video, so the agent can cut YOUR footage the same way
// (none of the reference's own shots are used): shot lengths in order, what happens on each cut (hard cut,
// white flash, dip to black, whip / motion blur, dissolve), its frame shape, its colour, and how tightly it cuts on
// the beat of its music. Cached per file.
import fs from 'node:fs';
import { run } from './analyze.mjs';
import { measure } from './colorstats.mjs';
import { beats } from './music.mjs';

const r3 = (x) => Math.round(x * 1000) / 1000;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export async function analyzeReference(file, { cacheFile, width = 0, height = 0, duration = 0 } = {}) {
  const st = fs.statSync(file);
  if (cacheFile && fs.existsSync(cacheFile)) {
    try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c.v === 1 && c.size === st.size) return c; } catch {}
  }
  // 10 frames a second: enough to place cuts within 0.1 s and to see a 2-frame flash
  const r = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-an', '-vf',
    "fps=10,scale=160:-2,blurdetect=block_width=16:block_height=16,select='gte(scene,0)',signalstats,metadata=print", '-f', 'null', '-']);
  const fr = [];
  let cur = null;
  for (const line of r.stderr.split(/\r?\n/)) {
    let m;
    if ((m = /pts_time:([\d.]+)/.exec(line))) { cur = { t: +m[1], scene: 0, y: 128, blur: 0 }; fr.push(cur); }
    else if (!cur) continue;
    else if ((m = /lavfi\.scene_score=([\d.]+)/.exec(line))) cur.scene = +m[1];
    else if ((m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line))) cur.y = +m[1];
    else if ((m = /lavfi\.blur=([\d.]+)/.exec(line))) cur.blur = +m[1];
  }
  if (fr.length < 10) throw new Error('Could not read the reference video');
  const dur = duration || fr[fr.length - 1].t + 0.1;
  // 1. cuts (hard), and dissolves: a run of medium scene changes
  const cuts = [];
  for (let i = 1; i < fr.length; i++) {
    const f = fr[i];
    if (f.scene > 0.3 && !(cuts.length && f.t - cuts[cuts.length - 1].t < 0.25)) cuts.push({ t: f.t, i, type: 'cut' });
  }
  for (let i = 1; i + 3 < fr.length; i++) {
    const run4 = fr.slice(i, i + 4);
    if (run4.every((f) => f.scene > 0.06 && f.scene <= 0.3 && f.y > 30) && !cuts.some((c) => Math.abs(c.t - fr[i + 2].t) < 0.6)) {
      cuts.push({ t: fr[i + 2].t, i: i + 2, type: 'fade' }); i += 4;
    }
  }
  cuts.sort((a, b) => a.t - b.t);
  // 2. what happens on each cut: compare a window around it with the shots on both sides
  const blurMed = median(fr.map((f) => f.blur)) || 1;
  for (const c of cuts) {
    if (c.type !== 'cut') continue;
    const win = fr.slice(Math.max(0, c.i - 2), c.i + 3), side = [...fr.slice(Math.max(0, c.i - 8), c.i - 2), ...fr.slice(c.i + 3, c.i + 9)];
    const yMax = Math.max(...win.map((f) => f.y)), yMin = Math.min(...win.map((f) => f.y)), ySide = median(side.map((f) => f.y));
    const bl = Math.max(...win.map((f) => f.blur));
    if (yMax > ySide + 45 && yMax > 150) c.type = 'flash';
    else if (yMin < 22 && ySide > 40) c.type = 'dip';
    else if (bl > blurMed * 1.8) c.type = 'whip';
  }
  // 3. shots: lengths in order, how lively each is
  const edges = [0, ...cuts.map((c) => c.t), dur];
  const shots = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const a = edges[k], b = edges[k + 1];
    if (b - a < 0.15) continue;
    const inside = fr.filter((f) => f.t > a + 0.1 && f.t < b - 0.1);
    shots.push({ len: r3(b - a), cutIn: k === 0 ? null : cuts[k - 1].type, motion: r3(inside.length ? inside.reduce((s, f) => s + f.scene, 0) / inside.length : 0) });
  }
  // 4. colour of the whole piece (a few frames from across it) and beat sync of its cuts
  let color = null;
  try { color = await measure(file, { tin: dur * 0.05, tout: dur * 0.95 }); } catch {}
  let onBeat = null, bpm = null;
  try {
    const g = beats(file);
    if (g?.period) {
      bpm = g.bpm;
      const hard = cuts.filter((c) => c.type !== 'fade');
      const near = hard.filter((c) => { const k = (c.t - g.first) / g.period; return Math.abs(k - Math.round(k)) * g.period < 0.08; });
      onBeat = hard.length ? r3(near.length / hard.length) : null;
    }
  } catch {}
  const aspect = width && height ? (height > width * 1.3 ? '9:16' : height > width * 1.1 ? '4:5' : Math.abs(width - height) < width * 0.1 ? '1:1' : '16:9') : null;
  const counts = cuts.reduce((o, c) => ((o[c.type] = (o[c.type] || 0) + 1), o), {});
  const res = { v: 1, size: st.size, duration: r3(dur), aspect, shots, avgShot: r3(dur / Math.max(1, shots.length)), counts, color: color && { mean: color.mean, std: color.std, sat: color.sat }, bpm, onBeat };
  if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(res));
  return res;
}

// One line for the report: "38 shots, avg 1.4 s; 5 flashes, 2 dips; cuts on the beat 80%"
export function describeRef(r) {
  const c = r.counts || {}, bits = [`${r.shots.length} shots, avg ${r.avgShot}s`];
  const fx = [c.flash && `${c.flash} white flashes`, c.dip && `${c.dip} dips to black`, c.whip && `${c.whip} whip / blur cuts`, c.fade && `${c.fade} dissolves`].filter(Boolean);
  if (fx.length) bits.push(fx.join(', '));
  if (r.onBeat !== null && r.onBeat !== undefined) bits.push(`${Math.round(r.onBeat * 100)}% of cuts on the beat${r.bpm ? ` (${r.bpm} BPM)` : ''}`);
  return bits.join('; ');
}
