// 🎬 Video layers of Motion comps: <video> elements that give drawComp the right frame. One pool per user of them
// ('motion' page, 'view' = the Edit viewer, 'bake') so a bake never pulls the frame out from under the viewer.
//   frame(pool, id, t, redraw) - the element if it shows ~t now, else it seeks there and calls redraw when it does
//   exact(pool, id, t)         - waits until the element shows t exactly (baking: every frame right)
//   play(pool, items) / pause(pool) - keep a playing preview in step without seeking every frame
import { S } from './store.js';

const pools = new Map();
// the last good frame of each video: shown when the element has no frame for a moment (seeking, decoder busy
// while the edit plays) - otherwise the layer would vanish and the comp's background would flash through
const lastGood = new WeakMap();
function safe(v) {
  if (!v) return null;
  if (v.readyState >= 2 && !v.seeking && v.videoWidth) {
    let c = lastGood.get(v);
    const w = Math.min(960, v.videoWidth), h = Math.round((w * v.videoHeight) / v.videoWidth);
    if (!c) { c = document.createElement('canvas'); lastGood.set(v, c); }
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    try { c.getContext('2d').drawImage(v, 0, 0, w, h); c.dataset.ok = '1'; } catch {}
    return v;
  }
  const c = lastGood.get(v);
  return c?.dataset.ok ? c : null;
}
function el(pool, id) {
  const P = pools.get(pool) || pools.set(pool, new Map()).get(pool);
  let v = P.get(id);
  const url = String(id).startsWith('url:') ? String(id).slice(4) : S.mediaById[id]?.urls?.play; // ('url:…' = a matte file)
  if (!url) return null;
  if (!v || v.dataset.src !== url) {
    v = document.createElement('video');
    Object.assign(v, { muted: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
    v.dataset.src = url; v.src = url; P.set(id, v);
  }
  return v;
}
export function frame(pool, id, t, redraw) {
  const v = el(pool, id); if (!v) return null;
  if (!v.paused) v.pause(); // (stopped playing: back to exact frames)
  if (v.readyState < 2) { v.addEventListener('loadeddata', () => redraw?.(), { once: true }); if (v.readyState === 0) v.load(); return safe(v); }
  if (v.paused && !v.seeking && Math.abs(v.currentTime - t) > 0.02) {
    const ok = safe(v); // (the frame shown until the seek lands)
    v.currentTime = t;
    v.addEventListener('seeked', () => redraw?.(), { once: true });
    return ok;
  }
  return safe(v);
}
const once = (v, ev) => new Promise((ok) => v.addEventListener(ev, ok, { once: true }));
export async function exact(pool, id, t) {
  const v = el(pool, id); if (!v) return null;
  if (v.readyState < 2) await Promise.race([once(v, 'loadeddata'), new Promise((ok) => setTimeout(ok, 15000))]);
  if (Math.abs(v.currentTime - t) > 1 / 240 || v.seeking) { const s = once(v, 'seeked'); v.currentTime = t; await Promise.race([s, new Promise((ok) => setTimeout(ok, 5000))]); }
  return v;
}
export const get = (pool, id) => pools.get(pool)?.get(id) || null;
// while the edit plays: the video plays by itself at the layer's speed and is only pulled back when it drifts
// (seeking every frame made playback stutter)
export function follow(pool, id, t, rate = 1) {
  const v = el(pool, id); if (!v || v.readyState < 2) { if (v && v.readyState === 0) v.load(); return safe(v); }
  if (v.playbackRate !== rate) v.playbackRate = Math.min(4, Math.max(0.25, rate));
  if (Math.abs(v.currentTime - t) > 0.3) v.currentTime = t;
  if (v.paused) v.play().catch(() => {});
  return safe(v);
}
// a playing preview: each video plays by itself and is pulled back when it drifts
export function play(pool, items) {
  for (const { id, t } of items) {
    const v = el(pool, id); if (!v || v.readyState < 2) continue;
    if (Math.abs(v.currentTime - t) > 0.25) v.currentTime = t;
    if (v.paused) v.play().catch(() => {});
  }
}
export function pause(pool) { for (const v of pools.get(pool)?.values() || []) v.pause(); }
