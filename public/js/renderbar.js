// renderbar.js - 🟥🟨🟩 the render bar, like Premiere's: where the live monitor can only approximate (red: render-only
// work; yellow: live approximations) and what has been rendered (green). Red stretches are rendered by themselves in the
// background, one section at a time, while the editor is idle (server: POST /api/render/section, preview quality, on a
// helper PC when one is free) - and the Program monitor plays a section's rendered video where the bar is green
// (player.js drawRendered), so every effect plays exactly, smoothly. A section's key is made from only the clips in it,
// so changing one part of the edit keeps every other section's render. Off / on: localStorage 've-bgrender' ('0' = off).
import { S, on, emit, layout, saveNow } from './store.js';
import { api, enc, watchJob } from './api.js';
import { trackKind } from './model.js';
import { VFX } from './effects.js';
import { AFX } from './audioeffects.js';

// 'red' | 'yellow' | null for one clip (the same rule the bar always had)
export function clipLoad(c) {
  if (c.gap) return null;
  const red = c.stabilize || c.enhance || c.smooth || c.filled || c.afx || (c.effects || []).some((e) => e.on !== false && (!VFX[e.type]?.css || VFX[e.type]?.stab))
    || (c.aeffects || []).some((e) => e.on !== false && !AFX[e.type]?.live && !AFX[e.type]?.meter);
  if (red) return 'red';
  return c.effects?.length || c.aeffects?.length || (c.color && Object.keys(c.color).length) || c.masks?.length || c.cutFx?.type || c.transitionIn || c.ramp || c.type === 'graphic' ? 'yellow' : null;
}

// a short stable hash of a string (FNV-1a, 2 x 32 bits) -> 13 base-36 characters
function hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return (h1.toString(36) + h2.toString(36)).padEnd(13, '0').slice(0, 13);
}

let secCache = null;
on('change', () => { secCache = null; });
// the red stretches of the picture (video tracks), joined where they touch: [{ a, b, key }]. The key covers every picture
// clip that overlaps the section (with where it sits), the frame settings and the sequence - nothing outside it.
export function sections() {
  if (secCache) return secCache;
  const L = layout(), red = [];
  for (const [tr, list] of Object.entries(L)) {
    if (trackKind(tr) === 'audio') continue;
    for (const x of list) if (!x.clip.disabled && clipLoad(x.clip) === 'red') red.push([x.start, x.end]);
  }
  red.sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const [a, b] of red) { const m = merged[merged.length - 1]; if (m && a <= m[1] + 0.04) m[1] = Math.max(m[1], b); else merged.push([a, b]); }
  const st = S.project.settings || {}, seq = S.seqMap?.mine || '';
  secCache = merged.filter(([a, b]) => b - a > 0.05).map(([a, b]) => {
    const inside = [];
    for (const [tr, list] of Object.entries(L)) {
      if (trackKind(tr) === 'audio') continue;
      for (const x of list) if (x.end > a && x.start < b) inside.push([tr, +x.start.toFixed(3), +x.end.toFixed(3), x.clip]);
    }
    const key = hash(JSON.stringify([+a.toFixed(3), +b.toFixed(3), seq, st.aspect, st.fps, st.look, S.project.trackState, inside]));
    return { a, b, key };
  });
  return secCache;
}

// which sections have a render on the server: key -> url
const ready = new Map();
let readyFor = null;
async function loadReady() {
  const p = S.proj; readyFor = p; ready.clear();
  try { for (const k of await api('GET', `/api/render/sections?p=${enc(p)}`)) ready.set(k, `/pf/${enc(p)}/renders/_sec_${k}.mp4`); } catch {}
  emit('renderbar');
}
// the rendered section at timeline time t, when it is still the edit as it is now: { a, b, url } or null
export function renderedAt(t) {
  if (!S.project || !ready.size) return null;
  const s = sections().find((x) => t >= x.a && t < x.b - 0.02);
  return s && ready.has(s.key) ? { a: s.a, b: s.b, url: ready.get(s.key) } : null;
}
// green stretches for the bar: [[a, b]]
export const greenParts = () => (S.project ? sections().filter((s) => ready.has(s.key)).map((s) => [s.a, s.b]) : []);

// ⚙ the background renderer: the first red section with no render, when the editor has been idle for a few seconds
export const bgOn = () => { try { return localStorage.getItem('ve-bgrender') !== '0'; } catch { return true; } };
export function setBg(v) { try { localStorage.setItem('ve-bgrender', v ? '1' : '0'); } catch {} emit('renderbar'); }
let lastEdit = Date.now(), busy = false;
const failed = new Map(); // key -> when it failed (tried again after 5 minutes)
on('change', () => { lastEdit = Date.now(); });
async function tick() {
  if (!S.project || !S.proj) return;
  if (readyFor !== S.proj) await loadReady();
  if (busy || !bgOn() || S.progPlaying || Date.now() - lastEdit < 4000 || document.hidden) return;
  const todo = sections().find((s) => !ready.has(s.key) && Date.now() - (failed.get(s.key) || 0) > 300000);
  if (!todo) return;
  busy = true;
  const p = S.proj;
  try {
    await saveNow(); // (the server renders the saved project)
    if (sections().every((s) => s.key !== todo.key)) return; // (changed while saving)
    const started = await api('POST', `/api/render/section?p=${enc(p)}`, { a: todo.a, b: todo.b, key: todo.key, seq: S.seqMap?.mine, fast: true });
    const j = await watchJob(started.id, () => {});
    if (S.proj === p && j?.result?.url) { ready.set(todo.key, j.result.url); emit('renderbar'); }
  } catch { failed.set(todo.key, Date.now()); }
  finally { busy = false; }
}
if (typeof window !== 'undefined') setInterval(() => { tick().catch(() => {}); }, 2000);
