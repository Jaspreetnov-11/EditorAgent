// reels.mjs - Auto Reels: one long talk / speech / event video -> the best self-contained moments as 9:16 reels.
//   1. transcribe with word timings (cached per file + language + model)              transcribe.py
//   2. per-second loudness / brightness / blur                                          analyze.mjs
//   3. candidates = runs of whole sentences 20-60 s long, scored on: how much is speech, pace, energy (and applause
//      right after), a strong first line (question, number, short), your keywords, clean start/end (pauses)
//   4. tighten: long pauses inside a moment are cut out (jump cuts)
//   5. reframe: faces are found in the chosen moments and each shot gets a crop that keeps the speaker in frame;
//      the crop jumps (a cut) only when the speaker moves out of it for a second                faces.py
//   6. captions: word-by-word highlighted ASS captions in the reel's own timing
// findReels() does 1-5 and returns ranked candidates; buildReel() turns one into editable tracks + captions.
import fs from 'node:fs';
import path from 'node:path';
import { analyzeClip, run } from './analyze.mjs';
import { uid } from '../public/js/model.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const r3 = (x) => Math.round(x * 1000) / 1000;
const DEVA = /[ऀ-ॿ]/;
const QUESTION = /\?|क्या|क्यों|कैसे|कौन|कब|कितन|कहाँ|\b(why|how|what|who|when|where)\b/i;
const WEAK_START = /^(और|तो|लेकिन|पर|क्योंकि|इसलिए|मतलब|and|but|so|because|then|also|um+|uh+)\b/i;
const END_PUNCT = /[.?!।॥]$/;
const TARGET = { W: 1080, H: 1920 };

// ---------------- 1-5: find ----------------
// ctx: { opts, m (media item + proxyPath), cacheDir, python, root, log(msg), progress(pct) }
// opts: { lang, model, count, minLen, maxLen, keywords, tighten }
export async function findReels(ctx) {
  const { opts, m, cacheDir, python, root, log, progress } = ctx;
  const src = m.proxyPath && fs.existsSync(m.proxyPath) ? m.proxyPath : m.path;
  const minLen = clamp(+opts.minLen || 20, 5, 170), maxLen = clamp(+opts.maxLen || 60, minLen + 5, 180);
  const warnings = [];
  const dir = path.join(cacheDir, 'reels');
  fs.mkdirSync(dir, { recursive: true });

  // 1. words
  const model = opts.model || 'medium', lang = opts.lang || 'auto';
  const tjson = path.join(dir, `${m.id}-${lang}-${model}.json`);
  let tr = null;
  try { tr = JSON.parse(fs.readFileSync(tjson, 'utf8')); if (tr.mtime !== m.mtime) tr = null; } catch {}
  if (!tr) {
    log(`Listening to the whole video (${model} model; long talks take a while, the first run downloads the model)…`);
    const a = await run(python, [path.join(root, 'engine', 'transcribe.py'), m.path, '--lang', lang, '--task', 'transcribe', '--model', model,
      '--words', '3', '--out', path.join(dir, `${m.id}.srt`), '--json', tjson, ...(opts.keywords ? ['--prompt', opts.keywords] : [])],
    { onErr: (l) => { const x = /^PROGRESS (\d+)/.exec(l); if (x) progress(2 + 0.6 * +x[1]); } });
    if (a.code !== 0) throw new Error(`Transcription failed: ${a.stderr.slice(-300)}`);
    tr = JSON.parse(fs.readFileSync(tjson, 'utf8'));
    tr.mtime = m.mtime;
    fs.writeFileSync(tjson, JSON.stringify(tr));
  }
  progress(62);
  const units = toUnits(tr.segments);
  if (units.length < 3) throw new Error('Hardly any speech in this video. Auto Reels needs a talk, speech or interview; for music-led event footage use the Agent > Event highlights.');

  // 2. loudness / picture facts per second
  log('Measuring energy and picture quality…');
  const facts = await analyzeClip(src, path.join(cacheDir, 'analysis', `${m.id}.json`), { hasAudio: m.hasAudio, duration: m.duration });
  progress(72);
  const loudAll = facts.loud.filter((x) => x !== null && x > -60), loudMed = median(loudAll);
  const sec = (arr, a, b) => arr.slice(Math.floor(a), Math.max(Math.floor(a) + 1, Math.ceil(b)));

  // 3. candidates
  log('Scoring every possible moment…');
  const kws = String(opts.keywords || '').split(/[,\n;]+/).map((k) => k.trim().toLowerCase()).filter((k) => k.length > 1);
  const cands = [];
  for (let i = 0; i < units.length; i++) {
    const gapBefore = i === 0 ? units[i].start : units[i].start - units[i - 1].end;
    for (let j = i; j < units.length; j++) {
      const a = units[i].start, b = units[j].end, dur = b - a;
      if (dur > maxLen) break;
      if (dur < minLen) continue;
      const us = units.slice(i, j + 1), words = us.flatMap((u) => u.words);
      const gapAfter = j === units.length - 1 ? (m.duration || b + 1) - b : units[j + 1].start - b;
      const text = us.map((u) => u.text).join(' ');
      const spoken = us.reduce((s, u) => s + (u.end - u.start), 0) / dur;
      const wps = words.length / dur;
      const loud = sec(facts.loud, a, b).filter((x) => x !== null);
      const after = sec(facts.loud, b, b + 3).filter((x) => x !== null);
      const energy = clamp(((mean(loud) || loudMed) - loudMed + 6) / 12, 0, 1);
      const applause = after.length && Math.max(...after) > loudMed + 5 && gapAfter > 1 ? 0.5 : 0;
      const first = us[0].text.trim();
      let hook = 0;
      if (first.split(/\s+/).length <= 14) hook += 0.3;
      if (QUESTION.test(first)) hook += 0.4;
      if (/\d/.test(first)) hook += 0.2;
      if (WEAK_START.test(first)) hook -= 0.5;
      const lower = text.toLowerCase(), hits = kws.filter((k) => lower.includes(k)).length;
      const kw = kws.length ? (hits ? Math.min(1, hits / 2) : -0.3) : 0;
      const clean = (gapBefore >= 0.3 ? 0.5 : 0) + (gapAfter >= 0.4 ? 0.3 : 0) + (END_PUNCT.test(us[us.length - 1].text.trim()) ? 0.2 : 0);
      const luma = mean(sec(facts.luma, a, b)), blur = mean(sec(facts.blur, a, b));
      const pic = (luma < 30 ? -0.8 : 0) + (blur > 0.6 ? -0.4 : 0);
      const lenPen = (Math.abs(dur - (minLen + maxLen) / 2) / (maxLen - minLen)) * 0.3;
      const parts = { speech: clamp(spoken, 0, 1), pace: clamp((wps - 1.2) / 1.5, 0, 1), energy, applause, hook, keywords: kw, clean };
      const score = 1.2 * parts.speech + 0.6 * parts.pace + 0.8 * energy + applause + hook + 1.5 * kw + 0.6 * clean + pic - lenPen;
      cands.push({ start: a, end: b, i, j, score, parts, text, hook: first, words });
    }
  }
  if (!cands.length) throw new Error(`No stretch of ${minLen}-${maxLen} s made of whole sentences was found. Try a wider length range.`);
  cands.sort((x, y) => y.score - x.score);
  const want = clamp(+opts.count || 3, 1, 12), picked = [];
  for (const c of cands) {
    if (picked.some((p) => c.start < p.end + 1 && c.end > p.start - 1)) continue;
    picked.push(c);
    if (picked.length >= want + 3) break; // a few spares to swap in
  }
  progress(78);

  // 4. tighten pauses
  for (const c of picked) c.pieces = pieces(c, opts.tighten !== false, m.duration);

  // 5. faces -> crops (landscape / square footage only)
  const srcW = Math.abs(m.rotation || 0) % 180 === 90 ? m.height : m.width, srcH = Math.abs(m.rotation || 0) % 180 === 90 ? m.width : m.height;
  const vertical = srcW && srcH && srcW / srcH <= TARGET.W / TARGET.H + 0.01;
  if (!vertical && m.hasVideo !== false) {
    log('Finding the speaker in each moment…');
    const req = path.join(dir, 'faces-req.json'), out = path.join(dir, 'faces-out.json');
    fs.writeFileSync(req, JSON.stringify({ file: src, width: srcW || 1920, height: srcH || 1080, fps: 3, spans: picked.map((c) => [c.pieces[0][0], c.pieces[c.pieces.length - 1][1]]) }));
    const f = await run(python, [path.join(root, 'engine', 'faces.py'), req, out], { onErr: (l) => { const x = /^PROGRESS (\d+)/.exec(l); if (x) progress(78 + 0.2 * +x[1]); } });
    if (f.code === 0) {
      const res = JSON.parse(fs.readFileSync(out, 'utf8'));
      picked.forEach((c, k) => (c.crops = crops(res.spans[k].samples, srcW, srcH, res.spans[k].cuts)));
    } else warnings.push(`Face tracking is not available (${/No module named 'cv2'/.test(f.stderr) ? 'install with: pip install "opencv-python-headless<5"' : f.stderr.trim().split('\n').pop()}) - reels use a blurred-background frame instead.`);
  }
  for (const c of picked) {
    if (vertical) c.crops = [{ a: c.start - 1, b: c.end + 1, cx: 0.5, fit: 'fill' }];
    else if (!c.crops) c.crops = [{ a: c.start - 1, b: c.end + 1, cx: 0.5, fit: 'blur' }];
    c.face = vertical ? 'vertical' : c.crops.some((x) => x.fit === 'fill') ? 'tracked' : 'none';
  }
  progress(100);
  return {
    language: tr.language, duration: m.duration, warnings,
    candidates: picked.map((c, k) => ({
      id: `r${k + 1}`, rank: k + 1, start: r3(c.start), end: r3(c.end), length: r3(c.pieces.reduce((s, [a, b]) => s + b - a, 0)),
      score: r3(c.score), parts: Object.fromEntries(Object.entries(c.parts).map(([x, v]) => [x, r3(v)])), text: c.text, hook: c.hook,
      pieces: c.pieces.map(([a, b]) => [r3(a), r3(b)]), crops: c.crops, face: c.face, words: c.words, suggested: k < want,
    })),
  };
}

// Whisper segments -> sentence-like units (split at . ? ! । and at pauses > 0.7 s), each with its words.
function toUnits(segments) {
  const units = [];
  for (const s of segments) {
    const ws = s.words?.length ? s.words : [{ s: s.start, e: s.end, w: s.text }];
    let cur = [];
    const flush = () => { if (cur.length) units.push({ start: cur[0].s, end: cur[cur.length - 1].e, words: cur, text: cur.map((w) => w.w).join(' ') }); cur = []; };
    ws.forEach((w, k) => {
      if (cur.length && w.s - cur[cur.length - 1].e > 0.7) flush();
      cur.push(w);
      if (END_PUNCT.test(w.w) && k < ws.length - 1) flush();
    });
    flush();
  }
  return units.filter((u) => u.end > u.start);
}

// Source spans that make up the reel: lead-in / tail, and pauses longer than 0.6 s cut down to 0.3 s.
function pieces(c, tighten, fileDur) {
  const a = Math.max(0, c.start - 0.12), b = Math.min(fileDur || c.end + 1, c.end + 0.4);
  if (!tighten) return [[a, b]];
  const out = [];
  let s = a;
  for (let k = 1; k < c.words.length; k++) {
    const gap = c.words[k].s - c.words[k - 1].e;
    if (gap > 0.6) { out.push([s, c.words[k - 1].e + 0.15]); s = c.words[k].s - 0.15; }
  }
  out.push([s, b]);
  return out.filter(([x, y]) => y - x > 0.2);
}

// Face samples -> crop segments { a, b, cx (0..1 crop position), fit }.
// Every camera shot (scene cut in the source) gets one steady crop on its main face, like a locked-off camera.
// Long shots (a speaker on one camera) only re-centre when the face stays outside the middle of the crop for ~1 s.
function crops(samples, srcW, srcH, sceneCuts = []) {
  if (!samples?.length) return null;
  const scale = Math.max(TARGET.W / srcW, TARGET.H / srcH), iw = srcW * scale;
  const cropFrac = TARGET.W / iw; // visible width as a fraction of the source width
  const toCx = (u) => clamp((u * iw - TARGET.W / 2) / Math.max(1, iw - TARGET.W), 0, 1);
  const withFace = samples.filter((s) => s.faces.length).length;
  if (withFace < Math.max(2, samples.length * 0.2)) return null;

  const t0 = samples[0].t - 0.5, t1 = samples[samples.length - 1].t + 0.5;
  const bounds = [t0, ...sceneCuts.filter((c) => c > t0 + 0.3 && c < t1 - 0.3), t1];
  const segs = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const a = bounds[k], b = bounds[k + 1];
    const ss = samples.filter((s) => s.t >= a && s.t < b);
    // main face of the shot: per sample the biggest face; the shot's position is the median (robust to misses)
    const xs = ss.map((s) => (s.faces.length ? s.faces.reduce((x, y) => (y[2] > x[2] ? y : x))[0] : null));
    const seen = xs.filter((x) => x !== null);
    if (!seen.length) { segs.push({ a, b, cx: null }); continue; }
    if (b - a < 6 || seen.length < 6) { segs.push({ a, b, cx: median(seen) }); continue; }
    // long shot: follow the speaker with held re-frames
    let last = seen[0];
    const filled = xs.map((x) => (x === null ? last : (last = x)));
    const sm = filled.map((_, i) => median(filled.slice(Math.max(0, i - 2), i + 3)));
    const dead = cropFrac * 0.25, hold = 3;
    let c0 = median(sm.slice(0, 6)), segStart = a, out = 0;
    for (let i = 0; i < sm.length; i++) {
      out = Math.abs(sm[i] - c0) > dead ? out + 1 : 0;
      const t = ss[i - hold + 1].t;
      if (out >= hold && t - segStart >= 3 && b - t >= 2) {
        segs.push({ a: segStart, b: t, cx: c0 });
        segStart = t; c0 = median(sm.slice(i - hold + 1, i + 6)); out = 0;
      }
    }
    segs.push({ a: segStart, b, cx: c0 });
  }
  // shots without a face keep the neighbouring crop (B-roll), or the centre
  const known = segs.filter((s) => s.cx !== null);
  segs.forEach((s, i) => { if (s.cx === null) s.cx = (segs.slice(0, i).reverse().find((x) => x.cx !== null) || known[0]).cx; });
  // merge neighbours that ended up in the same place (after clamping to the frame edge)
  const merged = [];
  for (const s of segs.map((x) => ({ ...x, cx: toCx(x.cx) }))) {
    const p = merged[merged.length - 1];
    if (p && Math.abs(p.cx - s.cx) < 0.04) p.b = s.b; else merged.push(s);
  }
  merged[0].a -= 5; merged[merged.length - 1].b += 5; // cover lead-in / tail
  return merged.map((s) => ({ a: r3(s.a), b: r3(s.b), cx: r3(s.cx), fit: 'fill' }));
}

// ---------------- 6: one candidate -> tracks + captions ----------------
// opts: { captions: 'karaoke' | 'plain' | 'none', hookTitle, musicId, logo }
export function buildReel(c, m, opts = {}) {
  const V1 = [];
  let t = 0;
  const map = []; // [srcA, srcB, timelineStart]
  for (const [a, b] of c.pieces) {
    map.push([a, b, t]);
    // split each piece where the crop changes
    const cuts = [a, ...c.crops.map((x) => x.b).filter((x) => x > a + 0.3 && x < b - 0.3), b];
    for (let k = 0; k < cuts.length - 1; k++) {
      const x0 = cuts[k], x1 = cuts[k + 1], mid = (x0 + x1) / 2;
      const cr = c.crops.find((x) => mid >= x.a && mid < x.b) || c.crops[c.crops.length - 1];
      V1.push({ id: uid(), type: 'video', mediaId: m.id, in: r3(x0), out: r3(x1), fit: cr.fit, ...(cr.fit === 'fill' ? { cropX: cr.cx } : {}) });
    }
    t += b - a;
  }
  const total = t;
  const toTL = (s) => { const p = map.find(([a, b]) => s >= a - 0.01 && s <= b + 0.01); return p ? p[2] + (s - p[0]) : null; };
  if (V1.length) { V1[0].fadeIn = 0.15; V1[V1.length - 1].fadeOut = 0.3; }

  const V2 = [];
  if (opts.hookTitle && c.hook) {
    const words = c.hook.split(/\s+/);
    V2.push({ id: uid(), type: 'title', text: words.length > 9 ? `${words.slice(0, 9).join(' ')}…` : c.hook, start: 0, dur: Math.min(3.5, total), textStyle: 'top' });
  }
  const A2 = opts.musicId ? [{ id: uid(), type: 'audio', mediaId: opts.musicId, start: 0, in: 0, loop: true, dur: r3(total), volume: 0.18, duck: true, fadeOut: 1.5 }] : [];
  const ass = opts.captions === 'none' ? null : captions(c.words.map((w) => ({ ...w, t0: toTL(w.s), t1: toTL(w.e) })).filter((w) => w.t0 !== null && w.t1 !== null), total, opts.captions !== 'plain');
  return { tracks: { V1, V2, A1: [], A2, A3: [] }, ass, duration: r3(total) };
}

// Captions: 3 words a line (2 when long), the word being spoken in yellow. PlayRes = the 1080x1920 frame.
function captions(words, total, karaoke) {
  const T = (s) => { s = Math.max(0, s); const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return `${h}:${String(mm).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}`; };
  const esc = (s) => s.replace(/[{}]/g, '').replace(/\\/g, '');
  const deva = words.some((w) => DEVA.test(w.w));
  const groups = [];
  let g = [];
  for (const w of words) {
    const letters = g.reduce((n, x) => n + x.w.length, 0) + w.w.length;
    if (g.length && (g.length >= 3 || letters > 22 || w.t0 - g[g.length - 1].t1 > 0.5 || END_PUNCT.test(g[g.length - 1].w))) { groups.push(g); g = []; }
    g.push(w);
  }
  if (g.length) groups.push(g);
  const lines = [];
  groups.forEach((gr, gi) => {
    const next = groups[gi + 1]?.[0].t0 ?? total;
    const end = Math.min(next, gr[gr.length - 1].t1 + 0.4);
    if (!karaoke) { lines.push(`Dialogue: 0,${T(gr[0].t0)},${T(end)},Cap,,0,0,0,,${gr.map((w) => esc(w.w)).join(' ')}`); return; }
    gr.forEach((w, k) => {
      const a = k === 0 ? gr[0].t0 : w.t0, b = k === gr.length - 1 ? end : gr[k + 1].t0;
      if (b - a < 0.02) return;
      const txt = gr.map((x, n) => (n === k ? `{\\c&H00D4FF&}${esc(x.w)}{\\c&HFFFFFF&}` : esc(x.w))).join(' ');
      lines.push(`Dialogue: 0,${T(a)},${T(b)},Cap,,0,0,0,,${txt}`);
    });
  });
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${TARGET.W}
PlayResY: ${TARGET.H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${deva ? 'Nirmala UI' : 'Arial'},${deva ? 96 : 92},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,80,80,560,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join('\n')}
`;
}
