// refstyle.mjs - the "style DNA" of a reference video, so the agent can cut YOUR footage the same way
// (none of the reference's own shots are used): shot lengths in order, what happens on each cut (hard cut,
// white flash, dip to black, whip / motion blur, dissolve), its frame shape, its colour, and how tightly it cuts on
// the beat of its music. Cached per file.
// v2: also the LOOK of each shot - black & white, vignette, film grain, letterbox bars, blur, a warmer / cooler or
// brighter / darker part - which refAdjustLayers() turns into adjustment layers over the matching shots of an edit,
// so the effects of the reference come across too (not only its cuts).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { run } from './analyze.mjs';
import { newEffect } from '../public/js/effects.js';
import { uid } from '../public/js/model.js';
import { measure } from './colorstats.mjs';
import { beats } from './music.mjs';

const r3 = (x) => Math.round(x * 1000) / 1000;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export async function analyzeReference(file, { cacheFile, width = 0, height = 0, duration = 0 } = {}) {
  const st = fs.statSync(file);
  if (cacheFile && fs.existsSync(cacheFile)) {
    try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c.v === 2 && c.size === st.size) return c; } catch {}
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
    shots.push({ a, b, len: r3(b - a), cutIn: k === 0 ? null : cuts[k - 1].type, motion: r3(inside.length ? inside.reduce((s, f) => s + f.scene, 0) / inside.length : 0),
      blur: inside.length ? median(inside.map((f) => f.blur)) : 0 });
  }
  // 3b. the look of every shot (small frames across the piece + full-size crops for the grain)
  try { await shotLooks(file, dur, shots, blurMed); } catch {}
  for (const s of shots) { delete s.a; delete s.b; delete s.blur; }
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
  const res = { v: 2, size: st.size, duration: r3(dur), aspect, shots, avgShot: r3(dur / Math.max(1, shots.length)), counts, color: color && { mean: color.mean, std: color.std, sat: color.sat }, bpm, onBeat };
  if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(res));
  return res;
}

// raw frames of a file from FFmpeg (rgb24 or gray), as one buffer
function rawFrames(file, vf, pix) {
  return new Promise((ok) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-vf', vf, '-pix_fmt', pix, '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    const bufs = []; p.stdout.on('data', (d) => bufs.push(d)); p.on('close', () => ok(Buffer.concat(bufs))); p.on('error', () => ok(Buffer.alloc(0)));
  });
}
// What each shot looks like, as an editor would build it with effects: shot.look = { bw, vignette, grain, bars, blur,
// temp, exposure } (only what is clearly there). Colour and brightness are against the whole piece (its overall grade
// is matched shot by shot anyway), so only a part that is warmer / cooler / brighter / darker than the rest stands out.
async function shotLooks(file, dur, shots, blurMed) {
  const fps = dur > 300 ? 1 : dur > 90 ? 2 : 4, W = 64, H = 36;
  const rgb = await rawFrames(file, `fps=${fps},scale=${W}:${H}:flags=area`, 'rgb24');
  const n = Math.floor(rgb.length / (W * H * 3));
  if (n < 2) return;
  const frames = [];
  for (let k = 0; k < n; k++) {
    const o = k * W * H * 3, Y = new Float32Array(W * H);
    let sr = 0, sg = 0, sb = 0, sat = 0;
    for (let i = 0; i < W * H; i++) {
      const r = rgb[o + i * 3] / 255, g = rgb[o + i * 3 + 1] / 255, b = rgb[o + i * 3 + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      Y[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b; sr += r; sg += g; sb += b; sat += mx > 0.04 ? (mx - mn) / mx : 0;
    }
    // letterbox: rows at the top and bottom that are black right across
    const rowDark = (y) => { let s = 0; for (let x = 0; x < W; x++) s += Y[y * W + x]; return s / W < 0.035; };
    let top = 0; while (top < H / 3 && rowDark(top)) top++;
    let bot = 0; while (bot < H / 3 && rowDark(H - 1 - bot)) bot++;
    const y0 = top, y1 = H - bot, ih = y1 - y0;
    // vignette: the corners against the middle of the picture (inside the bars)
    const area = (xa, xb, ya, yb) => { let s = 0, c = 0; for (let y = Math.floor(ya); y < Math.ceil(yb); y++) for (let x = Math.floor(xa); x < Math.ceil(xb); x++) { s += Y[y * W + x]; c++; } return c ? s / c : 0; };
    const cw = W * 0.16, ch = Math.max(1, ih * 0.18);
    // (the BRIGHTEST corner: a real vignette darkens all four; a picture with one dark corner is not one)
    const corners = Math.max(area(0, cw, y0, y0 + ch), area(W - cw, W, y0, y0 + ch), area(0, cw, y1 - ch, y1), area(W - cw, W, y1 - ch, y1));
    const mid = area(W * 0.3, W * 0.7, y0 + ih * 0.3, y1 - ih * 0.3);
    frames.push({ t: k / fps, r: sr / (W * H), g: sg / (W * H), b: sb / (W * H), sat: sat / (W * H), y: (sr * 0.2126 + sg * 0.7152 + sb * 0.0722) / (W * H), bars: Math.min(top, bot) / H, vig: mid > 0.12 ? corners / mid : 1 });
  }
  // grain: how much neighbouring pixels differ in a full-size crop from the middle (scaled pictures smooth it away)
  const gw = 192, gh = 108, gfps = Math.max(0.5, fps / 2);
  const gray = await rawFrames(file, `fps=${gfps},crop=${gw}:${gh}`, 'gray');
  const gn = Math.floor(gray.length / (gw * gh)), noise = [];
  for (let k = 0; k < gn; k++) {
    const o = k * gw * gh; let s = 0, c = 0;
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
      const i = o + y * gw + x, v = gray[i], m = (gray[i - 1] + gray[i + 1] + gray[i - gw] + gray[i + gw]) / 4;
      if (m > 25 && m < 230) { s += Math.abs(v - m); c++; }
    }
    noise.push({ t: k / gfps, v: c ? s / c : 0 });
  }
  const all = { r: median(frames.map((f) => f.r)), g: median(frames.map((f) => f.g)), b: median(frames.map((f) => f.b)), y: median(frames.map((f) => f.y)) };
  const noiseMed = median(noise.map((x) => x.v));
  for (const s of shots) {
    const fr = frames.filter((f) => f.t >= s.a + 0.05 && f.t < s.b - 0.05), take = fr.length ? fr : frames.filter((f) => f.t >= s.a && f.t < s.b);
    if (!take.length) continue;
    const m = (k) => median(take.map((f) => f[k])), look = {};
    if (m('sat') < 0.06) look.bw = 1;
    const vig = m('vig'); if (vig < 0.7) look.vignette = r3(Math.min(1, Math.max(0.25, (0.9 - vig) / 0.45)));
    const bars = m('bars'); if (bars > 0.06) look.bars = r3(bars);
    const nz = median(noise.filter((x) => x.t >= s.a && x.t < s.b).map((x) => x.v)) || 0;
    if (nz > 4.2 && nz > noiseMed * 0.8) look.grain = r3(Math.min(1, Math.max(0.2, (nz - 3) / 8)));
    if (blurMed > 0 && s.blur > blurMed * 2.5 && s.b - s.a > 0.5) look.blur = 1;
    // a clearly warmer / cooler part than the rest (a graded section - not just a red wall); brightness is left to the
    // shot-by-shot grade (a dark room is not an effect)
    if (!look.bw) { const warm = (m('r') - m('b')) - (all.r - all.b); if (Math.abs(warm) > 0.15) look.temp = r3(Math.max(-1, Math.min(1, warm * 3))); }
    if (Object.keys(look).length) s.look = look;
  }
}

// 🎚 The reference's looks as adjustment layers over an edit: spans = the edit's shots in order ({ start, end } on the
// timeline); shot k of the edit gets the look of the reference's shot k (round again when the edit has more).
// Next shots with the same look share one layer. Returns adjustment clips (type 'adjust', refLook: true).
export function refAdjustLayers(ref, spans) {
  const shots = ref?.shots || [];
  if (!shots.length || !spans.length) return [];
  const key = (l) => (l ? JSON.stringify(l) : '');
  const out = [];
  spans.forEach((sp, k) => {
    const look = shots[k % shots.length].look, kk = key(look);
    if (!kk) return;
    const last = out[out.length - 1];
    if (last && last._k === kk && Math.abs(last._end - sp.start) < 0.05) { last._end = sp.end; return; }
    out.push({ _k: kk, _end: sp.end, start: sp.start, look });
  });
  return out.map((x) => {
    const L = x.look, effects = [];
    const fx = (type, p) => { const e = newEffect(type); Object.assign(e.p, p); effects.push(e); };
    if (L.bw) fx('bw', { amount: 1 });
    if (L.blur) fx('blur', { amount: 14 });
    if (L.grain) fx('grain', { amount: L.grain });
    if (L.vignette) fx('vignette', { amount: L.vignette });
    if (L.bars) { const pc = Math.round(L.bars * 1000) / 10; fx('crop', { top: pc, bottom: pc, left: 0, right: 0 }); }
    const color = {};
    if (L.temp) color.temp = L.temp;
    if (L.exposure) color.exposure = L.exposure;
    const what = [L.bw && 'black & white', L.blur && 'blur', L.grain && 'grain', L.vignette && 'vignette', L.bars && 'bars', L.temp && (L.temp > 0 ? 'warmer' : 'cooler'), L.exposure && (L.exposure > 0 ? 'brighter' : 'darker')].filter(Boolean).join(', ');
    return { id: uid(), type: 'adjust', start: r3(x.start), dur: r3(x._end - x.start), refLook: true, name: `Ref look: ${what}`, ...(effects.length ? { effects } : {}), ...(Object.keys(color).length ? { color } : {}) };
  });
}
// one line about the looks for the report / Claude: "looks: 4 shots black & white, 9 with vignette, bars"
export function describeLooks(r) {
  const n = (k) => (r.shots || []).filter((s) => s.look?.[k]).length, bits = [];
  for (const [k, l] of [['bw', 'black & white'], ['vignette', 'vignette'], ['grain', 'film grain'], ['bars', 'letterbox bars'], ['blur', 'blurred'], ['temp', 'warmer / cooler'], ['exposure', 'brighter / darker']]) if (n(k)) bits.push(`${n(k)} shots ${l}`);
  return bits.length ? `looks: ${bits.join(', ')}` : 'looks: no special effects on the shots';
}

// One line for the report: "38 shots, avg 1.4 s; 5 flashes, 2 dips; cuts on the beat 80%"
export function describeRef(r) {
  const c = r.counts || {}, bits = [`${r.shots.length} shots, avg ${r.avgShot}s`];
  const fx = [c.flash && `${c.flash} white flashes`, c.dip && `${c.dip} dips to black`, c.whip && `${c.whip} whip / blur cuts`, c.fade && `${c.fade} dissolves`].filter(Boolean);
  if (fx.length) bits.push(fx.join(', '));
  if (r.onBeat !== null && r.onBeat !== undefined) bits.push(`${Math.round(r.onBeat * 100)}% of cuts on the beat${r.bpm ? ` (${r.bpm} BPM)` : ''}`);
  return bits.join('; ');
}
