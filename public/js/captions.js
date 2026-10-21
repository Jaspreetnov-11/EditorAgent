// Captions kept in the project and edited line by line (the Captions panel), shown live in the viewer and burned
// into renders as ASS subtitles (engine/render2.mjs). project.captions = { on, style, cues: [{ id, start, end, text,
// words?: [{ t0, t1, w }] }] } in timeline seconds. Words give the karaoke highlight; without them (or after the text
// was edited to a different number of words) the words are spread evenly over the line.
import { uid } from './model.js';

export const CAPTION_PRESETS = {
  clean: { label: 'Clean white', font: 'Arial', size: 54, color: '#ffffff', hl: '#ffd400', box: '', outline: 3, pos: 'bottom', upper: false, anim: 'none', words: 7 },
  karaoke: { label: 'Yellow word highlight', font: 'Arial', size: 62, color: '#ffffff', hl: '#ffd400', box: '', outline: 4, pos: 'bottom', upper: false, anim: 'karaoke', words: 5 },
  box: { label: 'Black box', font: 'Arial', size: 52, color: '#ffffff', hl: '#ffd400', box: '#000000', outline: 0, pos: 'bottom', upper: false, anim: 'none', words: 7 },
  reel: { label: 'Reel pop (big, word by word)', font: 'Arial Black', size: 84, color: '#ffffff', hl: '#00e5ff', box: '', outline: 6, pos: 'middle', upper: true, anim: 'pop', words: 3 },
  saffron: { label: 'Saffron box', font: 'Arial', size: 54, color: '#ffffff', hl: '#0b2545', box: '#e8740c', outline: 0, pos: 'bottom', upper: false, anim: 'karaoke', words: 5 },
  news: { label: 'News lower (navy box)', font: 'Arial', size: 48, color: '#ffffff', hl: '#ffd400', box: '#0b2545', outline: 0, pos: 'bottom', upper: true, anim: 'none', words: 8 },
};
export const CAPTION_FONTS = ['Arial', 'Arial Black', 'Segoe UI', 'Verdana', 'Georgia', 'Impact', 'Nirmala UI', 'Mangal'];
export const defaultCaptions = () => ({ on: true, style: { preset: 'karaoke', ...CAPTION_PRESETS.karaoke }, cues: [] });
const DEVA = /[ऀ-ॿ]/;
const r3 = (x) => Math.round(x * 1000) / 1000;

// transcript sentences [{ start, end, text, words: [{ s, e, w }] }] (engine/transcribe.py --json) -> cues of n words,
// shifted by `offset` seconds onto the timeline
export function cuesFromSegments(segs, n = 5, offset = 0) {
  const out = [];
  for (const s of segs || []) {
    const ws = (s.words || []).filter((w) => w.w);
    if (!ws.length) { if (s.text?.trim()) out.push({ id: uid(), start: r3(s.start + offset), end: r3(s.end + offset), text: s.text.trim() }); continue; }
    const count = Math.max(1, Math.ceil(ws.length / n)), size = Math.ceil(ws.length / count); // balanced lines, no orphan word
    for (let i = 0; i < ws.length; i += size) {
      const g = ws.slice(i, i + size);
      out.push({ id: uid(), start: r3(g[0].s + offset), end: r3(g[g.length - 1].e + offset), text: g.map((w) => w.w).join(' '), words: g.map((w) => ({ t0: r3(w.s + offset), t1: r3(w.e + offset), w: w.w })) });
    }
  }
  // a line ends no later than the next starts
  out.forEach((c, i) => { const nx = out[i + 1]; if (nx && c.end > nx.start) c.end = r3(Math.max(c.start + 0.2, nx.start - 0.02)); });
  return out;
}
export function cuesFromSrt(txt, offset = 0) {
  return String(txt || '').replace(/\r/g, '').split(/\n\n+/).map((b) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)\n([\s\S]*)/.exec(b.trim());
    if (!m) return null;
    const t = (a, b2, c, d) => +a * 3600 + +b2 * 60 + +c + +d / 1000;
    return { id: uid(), start: r3(t(m[1], m[2], m[3], m[4]) + offset), end: r3(t(m[5], m[6], m[7], m[8]) + offset), text: m[9].trim().replace(/\n/g, ' ') };
  }).filter(Boolean);
}

// the words of a cue with times (real ones when they still match the text, else spread evenly)
export function wordsOf(c) {
  const toks = String(c.text || '').split(/\s+/).filter(Boolean);
  if (c.words?.length === toks.length) return c.words.map((w, i) => ({ ...w, w: toks[i] }));
  const d = (c.end - c.start) / Math.max(1, toks.length);
  return toks.map((w, i) => ({ t0: c.start + i * d, t1: c.start + (i + 1) * d, w }));
}
export const caseOf = (style, s) => (style.upper && !DEVA.test(s) ? s.toUpperCase() : s);

// what the viewer shows at time t: { cue, words: [{ w, active, pop }] } or null
export function captionAt(cap, t) {
  if (!cap?.on) return null;
  const cue = (cap.cues || []).find((c) => t >= c.start && t < c.end);
  if (!cue) return null;
  const ws = wordsOf(cue), anim = cap.style?.anim;
  // a word stays highlighted until the next one starts (as in the render)
  return { cue, words: ws.map((w, i) => {
    const on = anim !== 'none' && (i === 0 ? t >= cue.start : t >= w.t0) && t < (ws[i + 1]?.t0 ?? cue.end);
    return { w: caseOf(cap.style || {}, w.w), active: on, pop: on && anim === 'pop' ? Math.max(0, 1 - (t - w.t0) / 0.15) : 0 };
  }) };
}

// ---------------- ASS for renders ----------------
const assCol = (hex, a = 0) => { const h = /^#?([0-9a-f]{6})$/i.exec(hex || '') ? hex.replace('#', '') : 'ffffff'; return `&H${a.toString(16).padStart(2, '0').toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase(); };
const assT = (s) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`; };
const assEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, '\\N');

// W x H = the render's size. Sizes in the style are for a 1080-pixel short side.
export function buildAss(cap, W, H) {
  const st = { ...CAPTION_PRESETS.clean, ...(cap.style || {}) }, k = Math.min(W, H) / 1080;
  const deva = (cap.cues || []).some((c) => DEVA.test(c.text));
  const font = deva && !/nirmala|mangal/i.test(st.font) ? 'Nirmala UI' : st.font;
  const align = { bottom: 2, middle: 5, top: 8 }[st.pos] || 2, mv = Math.round(H * (st.pos === 'middle' ? 0 : 0.08));
  const boxed = !!st.box;
  const style = `Style: Cap,${font},${Math.round(st.size * k)},${assCol(st.color)},${assCol(st.hl)},${assCol(boxed ? st.box : '#000000')},${assCol(boxed ? st.box : '#000000', boxed ? 0 : 0x60)},-1,0,0,0,100,100,0,0,${boxed ? 3 : 1},${boxed ? Math.round(10 * k) : Math.round((st.outline ?? 3) * k)},${boxed ? 0 : Math.round(1 * k)},${align},${Math.round(W * 0.07)},${Math.round(W * 0.07)},${mv},1`;
  const lines = [];
  for (const c of cap.cues || []) {
    const ws = wordsOf(c).map((w) => ({ ...w, w: caseOf(st, w.w) }));
    if (!ws.length) continue;
    if (st.anim === 'none') { lines.push(`Dialogue: 0,${assT(c.start)},${assT(c.end)},Cap,,0,0,0,,${assEsc(ws.map((w) => w.w).join(' '))}`); continue; }
    // one event per word: the whole line, the spoken word in the highlight colour (and popped)
    ws.forEach((w, i) => {
      const a = i === 0 ? c.start : w.t0, b = i === ws.length - 1 ? c.end : ws[i + 1].t0;
      if (b - a < 0.01) return;
      const txt = ws.map((x, j) => (j === i ? `{\\c${assCol(st.hl)}${st.anim === 'pop' ? '\\fscx118\\fscy118\\t(0,140,\\fscx100\\fscy100)' : ''}}${assEsc(x.w)}{\\r}` : assEsc(x.w))).join(' ');
      lines.push(`Dialogue: 0,${assT(a)},${assT(b)},Cap,,0,0,0,,${txt}`);
    });
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${style}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join('\n')}\n`;
}

// editing helpers (the Captions panel and the Assistant)
export function splitCue(cues, id, t) {
  const i = cues.findIndex((c) => c.id === id), c = cues[i];
  if (!c || t <= c.start + 0.1 || t >= c.end - 0.1) return false;
  const ws = wordsOf(c), k = Math.max(1, Math.min(ws.length - 1, ws.findIndex((w) => w.t0 >= t)));
  if (ws.length < 2) return false;
  const a = { ...c, end: r3(ws[k].t0), text: ws.slice(0, k).map((w) => w.w).join(' '), words: ws.slice(0, k) };
  const b = { ...c, id: uid(), start: r3(ws[k].t0), text: ws.slice(k).map((w) => w.w).join(' '), words: ws.slice(k) };
  cues.splice(i, 1, a, b);
  return true;
}
export function mergeCue(cues, id) {
  const i = cues.findIndex((c) => c.id === id), a = cues[i], b = cues[i + 1];
  if (!a || !b) return false;
  cues.splice(i, 2, { ...a, end: b.end, text: `${a.text} ${b.text}`, words: [...wordsOf(a), ...wordsOf(b)] });
  return true;
}
