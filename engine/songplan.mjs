// songplan.mjs - the 🎵 Song edit: plans a music video from a song's beats, bars, parts and sung lyrics (engine/song.py +
// transcribe.py on the voice stem). Used by agent.mjs.
//   fixLyrics: the heard lines (Whisper spells sung Hindi loosely) take the words the user typed, where they match
//   planSong:  lyric lines -> sections (what the picture should show), beats -> cuts (how fast it cuts, by part)
//   songFx:    flashes into choruses, punch-ins on strong beats, slow push-ins on calm parts
import { soundKey } from './translit.mjs';
import { CUTFX } from '../public/js/fx.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r3 = (x) => Math.round(x * 1000) / 1000;
// a sound skeleton (Roman, consonants) so "सप्ना" / "सपना" / "sapna" compare as the same word
const fold = (s) => soundKey(s).replace(/\B[aeiouy]/g, '').replace(/\s+/g, '');
const grams = (s) => { const f = [...fold(s)], g = new Set(); for (let i = 0; i + 2 < f.length; i++) g.add(f.slice(i, i + 3).join('')); return g; };
const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

// segs: [{ start, end, text, words }] heard; userText: the lyrics as typed (any line breaks / commas)
export function fixLyrics(segs, userText) {
  const phrases = String(userText || '').split(/[\n,।|॥]+/).map((x) => x.replace(/[⸻—–*"“”]+/g, ' ').trim()).filter((x) => x.length > 1);
  if (!phrases.length) return { segs, fixed: 0 };
  const pg = phrases.map(grams);
  let fixed = 0;
  const out = segs.map((s) => {
    const sg = grams(s.text);
    if (sg.size < 3) return s;
    let best = { f: 0 };
    // the heard line = 1-3 typed phrases in a row (a sung line often spans a comma)
    for (let i = 0; i < phrases.length; i++) {
      const g = new Set();
      for (let k = 0; k < 3 && i + k < phrases.length; k++) {
        for (const x of pg[i + k]) g.add(x);
        const o = overlap(sg, g), p = o / sg.size, r = o / Math.max(1, g.size), f = (2 * p * r) / Math.max(1e-6, p + r);
        if (f > best.f) best = { f, text: phrases.slice(i, i + k + 1).join(', ') };
      }
    }
    if (best.f < 0.45) return s;
    fixed++;
    const tw = best.text.split(/\s+/).filter(Boolean), ws = s.words || [];
    // word timings stay when the word count is the same; otherwise the captions spread the line evenly
    return { ...s, text: best.text, heard: s.text, words: ws.length === tw.length ? ws.map((w, i) => ({ ...w, w: tw[i] })) : undefined };
  });
  return { segs: out, fixed };
}

const ACT = { intro: 'intro', outro: 'outro', chorus: 'climax', verse: 'build', instrumental: 'build' };
// shot length in beats by part, before energy and pace
const BASE = { intro: 8, verse: 4, chorus: 2, instrumental: 4, outro: 8 };

// song: song.py result. lines: fixed lyric segments (song time) with `en` (English, for the pictures).
// [w0, w1]: the part of the song used (song time). pace: slow | medium | fast.
// shotTarget: a style's usual shot length (seconds) - then each part cuts around it (chorus faster, intro slower)
const STYLE_K = { intro: 2, verse: 1.25, chorus: 0.75, instrumental: 1, outro: 2 };
export function planSong({ song, lines, w0 = 0, w1 = song.duration, pace = 'medium', shotTarget = null }) {
  const total = r3(w1 - w0);
  const T = (t) => r3(t - w0);
  const beatsAll = song.beats.map((t, i) => ({ t, i })).filter((x) => x.t >= w0 - 0.01 && x.t <= w1 + 0.01);
  const B = beatsAll.map((x) => T(x.t)), E = beatsAll.map((x) => song.energy[x.i] ?? 0.5);
  const iv = B.slice(1).map((b, i) => b - B[i]).sort((a, b) => a - b), b = iv[iv.length >> 1] || 0.5;
  const downs = new Set(song.downbeats.map((t) => T(t)).filter((t) => t >= 0 && t <= total).map((t) => t.toFixed(2)));
  const isDown = (k) => downs.has(B[k].toFixed(2));
  const bar = b * 4;

  // lyric lines in the window; repeated lines (same words heard again) are the chorus / hook
  const L = lines.filter((s) => s.start >= w0 - 0.3 && s.start < w1 - 0.3 && s.text?.trim()).map((s) => ({ ...s, a: T(Math.max(w0, s.start)), z: T(Math.min(w1, s.end)) }));
  const lg = L.map((s) => grams(s.text));
  L.forEach((s, i) => { s.repeat = lg.some((g, j) => j !== i && Math.abs(L[j].a - s.a) > 8 && g.size > 2 && overlap(lg[i], g) / Math.max(1, Math.min(g.size, lg[i].size)) > 0.6); });
  // parts: song.py's parts, re-labelled by the lyrics (sung + repeated = chorus, no words = instrumental / intro / outro)
  const parts = song.sections.filter((p) => p.end > w0 && p.start < w1).map((p) => ({ ...p, a: Math.max(0, T(p.start)), z: Math.min(total, T(p.end)) }));
  for (const p of parts) {
    const inP = L.filter((s) => s.a >= p.a - 0.5 && s.a < p.z);
    const rep = inP.length ? inP.filter((s) => s.repeat).length / inP.length : 0;
    if (!inP.length) p.label = p.a < 1 ? 'intro' : p.z > total - 1 ? 'outro' : 'instrumental';
    else if (rep >= 0.5) p.label = 'chorus';
    else if (p.label !== 'chorus') p.label = 'verse';
  }
  const partAt = (t) => parts.find((p) => t >= p.a && t < p.z) || parts[parts.length - 1] || { label: 'verse', energy: 0.5 };

  // sections: one per sung line (until the next line); a long gap without words is its own picture-only section
  const sections = [];
  const gapSec = (a, z) => { if (z - a > 0.3) sections.push({ start: r3(a), end: r3(z), textId: null, text: null, orig: null }); };
  if (!L.length) gapSec(0, total);
  else if (L[0].a > 0.3) gapSec(0, L[0].a);
  L.forEach((s, i) => {
    const next = i + 1 < L.length ? L[i + 1].a : total;
    const sungEnd = Math.min(next, s.z + bar * 0.5);
    if (next - sungEnd > bar * 2) { sections.push({ start: r3(s.a), end: r3(sungEnd), textId: `l${i}`, text: (s.en || s.text).slice(0, 300), orig: s.text }); gapSec(sungEnd, next); }
    else sections.push({ start: r3(s.a), end: r3(next), textId: `l${i}`, text: (s.en || s.text).slice(0, 300), orig: s.text });
  });

  // cuts on beats: shot length by part and energy; a new sung line and a new part always cut (on the nearest beat)
  const nearest = (t) => { let k = 0; for (let j = 1; j < B.length; j++) if (Math.abs(B[j] - t) < Math.abs(B[k] - t)) k = j; return k; };
  const must = new Set([...L.map((s) => nearest(s.a)), ...parts.map((p) => nearest(p.a))].filter((k) => k > 0));
  const paceK = { fast: 0.5, medium: 1, slow: 2 }[pace] ?? 1;
  const lenBeats = (k) => {
    const p = partAt(B[k]), e = E[k] ?? 0.5;
    // (with a style its shot length leads; the song's energy only nudges it - halving it again cut on every beat)
    let n = shotTarget ? ((shotTarget * (STYLE_K[p.label] || 1)) / b) * (e > 0.85 ? 0.8 : e < 0.2 ? 1.4 : 1) + 0.2
      : (BASE[p.label] || 4) * paceK * (e > 0.78 ? 0.5 : e < 0.22 ? 2 : 1);
    n = Math.max(1, Math.round(n));
    while (n * b < 0.55) n *= 2;
    while (n * b > 6 && n > 1) n = Math.ceil(n / 2);
    return n;
  };
  const cutIdx = [0];
  if (B.length) {
    let k = 0;
    while (k < B.length - 1) {
      const n = lenBeats(k);
      let next = k + n;
      // longer shots land on bar lines
      if (n >= 4) { let j = Math.max(k + 1, Math.round(k + n * 0.75)); while (j < B.length && !isDown(j) && j < k + n + 2) j++; if (j < B.length && isDown(j)) next = j; }
      for (let j = k + 1; j < Math.min(next, B.length); j++) if (must.has(j) && B[j] - B[k] > 0.5) { next = j; break; }
      if (next >= B.length) break;
      cutIdx.push(next);
      k = next;
    }
  }
  const cuts = [0, ...cutIdx.slice(1).map((k) => B[k])].filter((t, i, a) => i === 0 || t - a[i - 1] > 0.4);
  if (B.length && B[0] > 0.6 && cuts[1] !== B[0]) cuts.splice(1, 0, B[0]); // the first beat after a soft start
  cuts.sort((x, y) => x - y);
  if (total - cuts[cuts.length - 1] < 0.6) cuts.pop();
  cuts.push(total);
  const secAt = (x) => sections.find((s) => x >= s.start && x < s.end) || sections[sections.length - 1];
  const slots = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], z = cuts[i + 1], mid = (a + z) / 2, p = partAt(mid);
    const k = nearest(mid);
    slots.push({ start: r3(a), end: r3(z), sec: secAt(mid), act: ACT[p.label] || 'build', part: p.label, energy: E[k] ?? 0.5, beat: b });
  }
  // captions: the sung lines with their word timings, on the timeline
  const capLines = L.map((s) => ({ start: s.a, end: s.z, text: s.text, fixed: s.heard !== undefined, words: s.words?.map((w) => ({ s: T(w.s), e: T(w.e), w: w.w })) }));
  return { sections, slots, total, parts: parts.map((p) => ({ start: r3(p.a), end: r3(p.z), label: p.label })), capLines, beat: b, bpm: song.bpm };
}

// finishing touches that never move a cut: a flash into every chorus, punch-ins on its strong beats,
// slow push-ins on long calm shots
export function songFx(V1, slots, fx = true) {
  let n = 0;
  V1.forEach((c, i) => {
    const sl = slots[i], prev = slots[i - 1], L = sl.end - sl.start;
    if (c.type === 'video' && L > 2.4 && (sl.part === 'intro' || sl.part === 'outro' || sl.part === 'verse')) c.keys = { 'transform.zoom': [{ t: 0, v: 1, ease: true }, { t: r3(L), v: 1.06 }] };
    if (!fx || !prev || (c.type !== 'video' && c.type !== 'image')) return;
    if (sl.part === 'chorus' && prev.part !== 'chorus') c.cutFx = { type: 'flash', dur: CUTFX.flash.dur };
    else if (sl.part !== prev.part && sl.part === 'instrumental') c.cutFx = { type: 'leak', dur: 0.9 };
    else if (c.type === 'video' && sl.part === 'chorus' && sl.energy > 0.7 && n++ % 4 === 0) c.cutFx = { type: 'punch', dur: CUTFX.punch.dur };
  });
  if (V1.length) { V1[0].fadeIn = 0.6; V1[V1.length - 1].fadeOut = 1.5; }
}
