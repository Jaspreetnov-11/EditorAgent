// editstyle.mjs - 🎨 edit styles: learn how a finished timeline is cut (an edit someone liked) and make the agent cut the
// same way. A style is a small profile, saved in Library/styles/<name>.json:
//   shots     how long the shots are (median / p25 / p75 seconds)
//   videoShare  moving footage vs photos
//   motion    how often every shot moves, and the zoom moves it uses (1 -> 1.08, 1.12 -> 1 …)
//   cuts      transitions and cut effects (how often, which)
//   color     the creative grade put on every shot (contrast / saturation / temperature…)
//   look      the project look (film LUT, letterbox bars, vignette, Ken Burns on photos)
//   lyrics    lyrics / words as big titles on V2: their style (size, colour, box, animation) and lines per title
// learnStyle(project, mediaById) -> profile. The agent applies one with shotTarget / imageCost / styleMotion / lyricTitles.
import { uid } from '../public/js/model.js';

const r3 = (x) => Math.round(x * 1000) / 1000;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const count = (arr, key) => arr.reduce((o, x) => { const k = key(x); if (k) o[k] = (o[k] || 0) + 1; return o; }, {});

export function learnStyle(pj, byId, name = 'My style') {
  const V1 = (pj.tracks?.V1 || []).filter((c) => c.type === 'video' || c.type === 'image');
  if (V1.length < 4) throw new Error('The timeline needs at least a few shots on V1 to learn a style from');
  const len = (c) => (c.type === 'video' ? ((c.out ?? byId[c.mediaId]?.duration ?? 0) - (c.in || 0)) / (c.speed || 1) : c.dur || 3);
  const L = V1.map(len).filter((x) => x > 0.05);
  const zoomed = V1.filter((c) => c.keys?.['transform.zoom']?.length >= 2);
  const moves = count(zoomed, (c) => { const z = c.keys['transform.zoom']; return `${r3(z[0].v)}>${r3(z[z.length - 1].v)}`; });
  // the creative grade: keys that most shots share, at their usual value (auto white balance / exposure left out)
  const graded = V1.filter((c) => c.color && Object.keys(c.color).length);
  const color = {};
  if (graded.length >= V1.length * 0.5) for (const k of ['contrast', 'saturation', 'temp', 'tint', 'gamma', 'vibrance']) {
    const v = graded.map((c) => c.color[k]).filter((x) => typeof x === 'number');
    if (v.length >= graded.length * 0.5) color[k] = r3(median(v));
  }
  const titles = Object.entries(pj.tracks || {}).filter(([t]) => t[0] === 'V' && t !== 'V1').flatMap(([, l]) => l).filter((c) => c.type === 'title' && c.text);
  const lines = titles.map((c) => String(c.text).split('\n').length);
  const pick = (k) => { const v = count(titles, (c) => (c[k] === undefined ? '' : JSON.stringify(c[k]))); const top = Object.entries(v).sort((a, b) => b[1] - a[1])[0]; return top ? JSON.parse(top[0]) : undefined; };
  const S = pj.settings || {};
  return {
    name, from: pj.name, at: Date.now(),
    shots: { median: r3(median(L)), p25: r3(pct(L, 0.25)), p75: r3(pct(L, 0.75)) },
    videoShare: r3(V1.filter((c) => c.type === 'video').length / V1.length),
    motion: { share: r3(zoomed.length / V1.length), moves: Object.entries(moves).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => { const [a, b] = k.split('>').map(Number); return { from: a, to: b, n }; }) },
    cuts: { transitions: r3(V1.filter((c) => c.transitionIn).length / V1.length), transitionTypes: count(V1.filter((c) => c.transitionIn), (c) => c.transitionIn.type),
      fx: r3(V1.filter((c) => c.cutFx).length / V1.length), fxTypes: count(V1.filter((c) => c.cutFx), (c) => c.cutFx.type) },
    speedShare: r3(V1.filter((c) => c.speed && c.speed !== 1).length / V1.length),
    color: Object.keys(color).length ? color : null,
    look: { look: S.look || null, kenburns: !!S.kenburns, fit: S.fit || null },
    lyrics: titles.length >= 4 ? { titles: true, count: titles.length, lines: Math.max(1, Math.round(median(lines))),
      style: { textStyle: pick('textStyle') || 'center', size: pick('size'), textColor: pick('textColor') || '#ffffff', box: pick('box') || 'none', anim: pick('anim') || 'fade', font: pick('font') } } : null,
    captions: pj.captions?.on && pj.captions.cues?.length ? { style: pj.captions.style } : null,
  };
}

// one line summary for the style list
export const describeStyle = (p) => [
  `shots ~${p.shots.median}s`, p.videoShare > 0.8 ? 'video only' : p.videoShare < 0.3 ? 'mostly photos' : 'video + photos',
  p.motion.share > 0.5 ? 'every shot moves' : null, p.cuts.transitions < 0.05 && p.cuts.fx < 0.05 ? 'clean cuts' : p.cuts.transitions > 0.3 ? 'dissolves' : null,
  p.color ? 'own grade' : null, p.look?.look?.letterbox ? `${p.look.look.letterbox}:1 bars` : null, p.lyrics?.titles ? 'lyrics as titles' : null,
].filter(Boolean).join(' · ');

// how much a photo costs against moving footage when the style is (almost) all video
export const imageCost = (p) => (!p ? 0 : p.videoShare > 0.85 ? 1.6 : p.videoShare > 0.6 ? 0.6 : 0);

// the style's camera moves, given to the shots in turn (weighted by how often the style used each), over the shot length
export function styleMotion(V1, slots, p) {
  if (!p || p.motion.share < 0.5 || !p.motion.moves.length) return;
  const bag = p.motion.moves.flatMap((m) => Array(Math.max(1, Math.round((m.n / p.motion.moves[0].n) * 4))).fill(m));
  let k = 0;
  V1.forEach((c, i) => {
    if (c.type !== 'video' && c.type !== 'image') return;
    const L = slots[i] ? slots[i].end - slots[i].start : c.dur || 2;
    const m = bag[(k++ * 7) % bag.length];
    c.keys = { ...(c.keys || {}), 'transform.zoom': [{ t: 0, v: m.from, ease: true }, { t: r3(L), v: m.to }] };
    if (c.type === 'image') c.kenburns = false; // (the style's move instead of the automatic photo zoom)
  });
}

// sung lines -> big titles on V2 in the style's look, one after another (each until the next line starts)
export function lyricTitles(lines, p, total) {
  if (!p?.lyrics?.titles || !lines?.length) return [];
  const st = p.lyrics.style, n = p.lyrics.lines;
  const split = (t) => {
    const s = String(t).replace(/\s+/g, ' ').trim();
    if (n < 2 || s.length < 16) return s;
    // break at the comma nearest the middle, else at the space nearest the middle
    // (only breaks well inside the line count: a comma at the very end would leave an empty second line)
    const mid = s.length / 2, inside = (i) => i > s.length * 0.25 && i < s.length * 0.75, near = (a, b) => Math.abs(a - mid) - Math.abs(b - mid);
    const at = [...s.matchAll(/[,،।]\s*/g)].map((m) => m.index + m[0].length).filter(inside).sort(near)[0]
      ?? [...s.matchAll(/ /g)].map((m) => m.index).filter(inside).sort(near)[0];
    const x = at ? s.slice(0, at).trim() : '', y = at ? s.slice(at).trim() : '';
    return x && y ? `${x}\n${y}` : s;
  };
  // a heard line that is really two sung lines (long): two titles, the time shared by their length
  const MAXC = 44;
  const pieces = lines.flatMap((l, i) => {
    const end = Math.min(total, i + 1 < lines.length ? lines[i + 1].start : l.end + 1.2, l.end + 2.5);
    const s = String(l.text).replace(/\s+/g, ' ').trim();
    if (s.length <= MAXC) return [{ start: l.start, end, text: s }];
    const mid = s.length / 2, at = [...s.matchAll(/[,،।]\s*|\s/g)].map((m) => m.index + m[0].length).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0] || Math.round(mid);
    const t = l.start + (end - l.start) * (at / s.length);
    return [{ start: l.start, end: t, text: s.slice(0, at).trim() }, { start: t, end, text: s.slice(at).trim() }];
  });
  return pieces.map((x) => ({ id: uid(), type: 'title', start: r3(x.start), dur: r3(Math.max(0.8, x.end - x.start)), text: split(x.text), textStyle: st.textStyle, ...(st.size ? { size: st.size } : {}),
    textColor: st.textColor, box: st.box, anim: st.anim, ...(st.font ? { font: st.font } : {}) }));
}
