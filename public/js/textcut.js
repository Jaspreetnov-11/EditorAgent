// 📝 Text editing maths (no DOM): the words of the main story (V1) in timeline order, and edits made on them.
// A transcript is per media file (source seconds); a V1 clip shows the words between its In and Out.
//   wordsOf      -> [{ clipId, i, w, s, e (source), ts, te (timeline), seg (sentence key) }]
//   cutSource    removes source ranges from V1 clips (a clip splits into the parts that stay; the story closes up)
//                and pulls everything on the other tracks after a cut back by the same amount, so music / titles stay in sync
//   fillerCuts / pauseCuts / sentencesOf / roughCut
import { layoutV1, uid, rampPts } from './model.js';

export const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'hmm', 'hm', 'mm', 'er', 'erm', 'ah', 'aah', 'aa', 'aaa', 'eh', 'अ', 'आ', 'अं', 'उम्म', 'हम्म', 'अम्म', 'ह्म्म', 'ऊं', 'एं']);
const clean = (w) => w.toLowerCase().replace(/[.,!?।"'…\-]+/g, '').trim();
export const isFiller = (w) => FILLERS.has(clean(w));

export function wordsOf(project, media, transcripts) {
  const out = [];
  for (const x of layoutV1(project, media)) {
    const c = x.clip, tr = transcripts[c.mediaId];
    if (c.type !== 'video' || !tr || rampPts(c)) continue;
    const sp = c.speed || 1, a = c.in || 0, b = c.out ?? media[c.mediaId]?.duration ?? Infinity;
    const fix = project.wordFix?.[c.mediaId] || {};
    tr.segments.forEach((sg, si) => (sg.words || []).forEach((w, i) => {
      if (w.e <= a + 0.02 || w.s >= b - 0.02) return;
      out.push({ clipId: c.id, mediaId: c.mediaId, cin: a, cout: b, i, si, fixed: fix[`${si}:${i}`] !== undefined, w: fix[`${si}:${i}`] ?? w.w, s: w.s, e: w.e, ts: x.start + (Math.max(a, w.s) - a) / sp, te: x.start + (Math.min(b, w.e) - a) / sp, seg: `${c.id}:${si}` });
    }));
  }
  return out;
}

// the source range to cut for words[a..b] (inclusive) - from just before the first word to just after the last,
// never into the neighbouring words; pad = breathing room kept around speech
export function rangeOfWords(words, a, b, pad = 0.06) {
  const first = words[a], last = words[b], prev = words[a - 1], next = words[b + 1];
  const same = (x, y) => x && y && x.clipId === y.clipId;
  const s = same(prev, first) ? Math.max(prev.e + 0.01, first.s - pad) : first.s - pad;
  const e = same(next, last) ? Math.min(next.s - 0.01, last.e + pad) : last.e + pad;
  return { s, e };
}
// words[a..b] can span clips: one source range per clip
export function cutsForSelection(words, a, b) {
  const out = [];
  let i = a;
  while (i <= b) {
    let j = i;
    while (j + 1 <= b && words[j + 1].clipId === words[i].clipId) j++;
    out.push({ clipId: words[i].clipId, ...rangeOfWords(words, i, j) });
    i = j + 1;
  }
  return out;
}

// cuts: [{ clipId, s, e }] in source seconds. Returns seconds removed.
export function cutSource(project, media, cuts) {
  const before = layoutV1(project, media), startOf = Object.fromEntries(before.map((x) => [x.clip.id, x]));
  const byClip = {};
  for (const k of cuts) (byClip[k.clipId] ||= []).push(k);
  const shifts = []; // [timeline position where time was removed, seconds]
  const V1 = [];
  for (const c of project.tracks.V1) {
    const ks = byClip[c.id];
    if (!ks) { V1.push(c); continue; }
    const sp = c.speed || 1, a = c.in || 0, b = c.out ?? media[c.mediaId]?.duration ?? a;
    // the parts of [a, b] that stay
    const rm = ks.map((k) => [Math.max(a, k.s), Math.min(b, k.e)]).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
    const keep = []; let cur = a;
    for (const [x, y] of rm) { if (x > cur + 0.04) keep.push([cur, x]); cur = Math.max(cur, y); }
    if (b > cur + 0.04) keep.push([cur, b]);
    const x0 = startOf[c.id].start;
    for (const [x, y] of rm) shifts.push([x0 + (x - a) / sp, (y - x) / sp]);
    keep.forEach(([x, y], k) => {
      const n = JSON.parse(JSON.stringify(c));
      Object.assign(n, { id: k ? uid() : c.id, in: +x.toFixed(3), out: +y.toFixed(3) });
      if (k) { delete n.transitionIn; delete n.keys; delete n.masks; delete n.fadeIn; }
      if (k < keep.length - 1) delete n.fadeOut;
      V1.push(n);
    });
  }
  project.tracks.V1 = V1;
  // the other tracks follow the story: anything starting after a cut moves back by what was cut before it
  shifts.sort((p, q) => p[0] - q[0]);
  const removedBefore = (t) => shifts.reduce((s, [at, d]) => (at + d <= t + 1e-6 ? s + d : s), 0);
  for (const [id, list] of Object.entries(project.tracks)) {
    if (id === 'V1') continue;
    for (const c of list) { const d = removedBefore(c.start || 0); if (d) c.start = +Math.max(0, (c.start || 0) - d).toFixed(3); }
  }
  for (const m of project.markers || []) { const d = removedBefore(m.t); if (d) m.t = +Math.max(0, m.t - d).toFixed(3); }
  return shifts.reduce((s, [, d]) => s + d, 0);
}

export const fillerCuts = (words) => words.flatMap((w, i) => (isFiller(w.w) ? [{ clipId: w.clipId, ...rangeOfWords(words, i, i, 0.03) }] : []));
// silences longer than minGap between two words of the same clip, leaving `keep` seconds of air
// (also the silence at the start / end of a clip that has speech - a clip with no words at all, B-roll, is left alone)
export function pauseCuts(words, minGap = 0.7, keep = 0.25) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const a = words[i - 1], b = words[i], next = words[i + 1];
    if (!a || a.clipId !== b.clipId) { if (b.s - b.cin >= minGap) out.push({ clipId: b.clipId, s: b.cin, e: b.s - keep / 2 }); }
    else if (b.s - a.e >= minGap) out.push({ clipId: a.clipId, s: a.e + keep / 2, e: b.s - keep / 2 });
    if ((!next || next.clipId !== b.clipId) && b.cout - b.e >= minGap && Number.isFinite(b.cout)) out.push({ clipId: b.clipId, s: b.e + keep / 2, e: b.cout });
  }
  return out;
}

// sentences of the transcript inside the V1 clips, with their source span
export function sentencesOf(words) {
  const by = new Map();
  for (const w of words) { const g = by.get(w.seg) || by.set(w.seg, { key: w.seg, clipId: w.clipId, mediaId: w.mediaId, words: [] }).get(w.seg); g.words.push(w); }
  return [...by.values()].map((g) => ({ ...g, text: g.words.map((w) => w.w).join(' '), s: g.words[0].s, e: g.words[g.words.length - 1].e, ts: g.words[0].ts }));
}
// a new main story from chosen sentences (in the order given): one clip per sentence, a little air around each
export function roughCut(sentences, base = {}) {
  return sentences.map((x) => ({ ...JSON.parse(JSON.stringify(base[x.clipId] || {})), id: uid(), type: 'video', mediaId: x.mediaId, in: +Math.max(0, x.s - 0.12).toFixed(3), out: +(x.e + 0.2).toFixed(3), transitionIn: undefined, keys: undefined, masks: undefined }));
}

// ---- more clean-ups (Text page presets) ----
// spoken fillers that are words or short phrases (basically, matlab, you know…)
const PHRASES = [['you', 'know'], ['i', 'mean'], ['sort', 'of'], ['kind', 'of'], ['मतलब'], ['matlab'], ['basically'], ['actually'], ['literally'], ['यानी'], ['ki', 'kya', 'hai'], ['क्या', 'है', 'कि']];
export function verbalCuts(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) for (const ph of PHRASES) {
    if (ph.every((p, k) => words[i + k] && clean(words[i + k].w) === p && words[i + k].clipId === words[i].clipId)) { out.push({ clipId: words[i].clipId, ...rangeOfWords(words, i, i + ph.length - 1, 0.03) }); i += ph.length - 1; break; }
  }
  return out;
}
// "main main", "the the the": the repeats go, the last one stays
export function stutterCuts(words) {
  const out = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1], b = words[i];
    if (a.clipId === b.clipId && clean(a.w) && clean(a.w) === clean(b.w) && b.s - a.e < 0.8) out.push({ clipId: a.clipId, ...rangeOfWords(words, i - 1, i - 1, 0.02) });
  }
  return out;
}
// retakes: a sentence said again soon after (mostly the same words) - the earlier take goes, the last take stays
const toks = (t) => new Set(t.toLowerCase().replace(/[.,!?।"'…\-]+/g, ' ').split(/\s+/).filter((x) => x.length > 1));
export function retakes(sentences, sim = 0.6, within = 40) {
  const drop = [];
  for (let i = 0; i < sentences.length; i++) for (let j = i + 1; j < sentences.length && sentences[j].ts - sentences[i].ts < within; j++) {
    const A = toks(sentences[i].text), B = toks(sentences[j].text); if (A.size < 3) break;
    const inter = [...A].filter((x) => B.has(x)).length, j2 = inter / (A.size + B.size - inter);
    if (j2 >= sim) { drop.push(sentences[i]); break; }
  }
  return drop;
}
export const retakeCuts = (words) => retakes(sentencesOf(words)).map((x) => ({ clipId: x.clipId, s: x.s - 0.08, e: x.e + 0.08 }));
// only the silence before the first and after the last word of each clip
export function headTailCuts(words, keep = 0.15) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const p = words[i - 1], w = words[i], n = words[i + 1];
    if ((!p || p.clipId !== w.clipId) && w.s - w.cin > keep + 0.1) out.push({ clipId: w.clipId, s: w.cin, e: w.s - keep });
    if ((!n || n.clipId !== w.clipId) && Number.isFinite(w.cout) && w.cout - w.e > keep + 0.1) out.push({ clipId: w.clipId, s: w.e + keep, e: w.cout });
  }
  return out;
}
export const PAUSE_PRESETS = { natural: { label: 'Natural (over 0.8 s, keep 0.35 s)', min: 0.8, keep: 0.35 }, tight: { label: 'Tight (over 0.5 s, keep 0.25 s)', min: 0.5, keep: 0.25 },
  podcast: { label: 'Podcast (over 0.35 s, keep 0.2 s)', min: 0.35, keep: 0.2 }, reels: { label: 'Reels jump-cut (over 0.2 s, keep 0.08 s)', min: 0.2, keep: 0.08 } };
// highlights: the most "complete" sentences (not too short, not fillers) in story order until the length is reached
export function pickHighlights(sentences, seconds, filter = () => true) {
  const ok = sentences.filter((x) => filter(x) && x.words.length >= 4 && x.e - x.s >= 1.2);
  const score = (x) => Math.min(x.words.length, 25) - x.words.filter((w) => isFiller(w.w)).length * 3 + (/[!?]$/.test(x.text.trim()) ? 2 : 0);
  const best = [...ok].sort((a, b) => score(b) - score(a)), chosen = [];
  let d = 0;
  for (const x of best) { const len = x.e - x.s + 0.32; if (d + len > seconds * 1.08) continue; chosen.push(x); d += len; if (d >= seconds * 0.92) break; }
  return chosen.sort((a, b) => a.ts - b.ts);
}
