// 🤖 AI picture tools - turning what engine/vision.py saw (faces + motion, every 1/6 s) into edits:
//   followKeys  🎯 Follow faces: crop-position keyframes so a Fill-framed shot (16:9 in a 9:16 reel) keeps the person
//               (the one moving most - usually the speaker) in frame. Small moves pan smoothly, a jump to the other
//               side of the picture is a cut, and the frame holds still while the person stays inside a dead zone.
//   faceMasks   🙈 Blur faces: every face followed through the shot as a moving blur (clip.masks, see tracking.js)
import { srcSize, simplifyPath } from './tracking.js';

const r4 = (x) => Math.round(x * 1e4) / 1e4;

// visible part of the source in Fill framing: a fraction of its width (x) or height (y); 1 = nothing to move
export function fillWindow(m, W, H) {
  const [sw, sh] = srcSize(m);
  if (!(sw > 0 && sh > 0)) return { axis: null, win: 1 };
  const k = (W / H) / (sw / sh);
  return k < 0.999 ? { axis: 'x', win: k } : 1 / k < 0.999 ? { axis: 'y', win: 1 / k } : { axis: null, win: 1 };
}

// samples: [{ t (source s), faces: [[x, y, w, h, score, activity]], motion: [cx, cy, amount] }]
export function followKeys(samples, c, m, W, H) {
  const { axis, win } = fillWindow(m, W, H);
  if (!axis || !samples.length) return null;
  const sp = c.speed || 1, rel = (t) => Math.max(0, (t - (c.in || 0)) / sp);
  const A = axis === 'x' ? 0 : 1, S = axis === 'x' ? 2 : 3;
  // who to follow at each sample: the face that moves most (smoothed), sticking with the current one unless another
  // clearly moves more for a while; no face -> the action (motion centre) when there is enough of it
  const act = new Map(); let who = null;
  const target = samples.map((s) => {
    const faces = s.faces.filter((f) => f[4] > 0.5 && f[2] * f[3] > 0.0009);
    if (!faces.length) return s.motion[2] > 0.02 ? { c: s.motion[A], face: false } : null;
    // faces keep their identity by position (nearest to a known one)
    const keyOf = (f) => { const cx = f[0] + f[2] / 2; let best = null; for (const k of act.keys()) if (Math.abs(k - cx) < 0.12 && (best === null || Math.abs(k - cx) < Math.abs(best - cx))) best = k; return best ?? cx; };
    const cur = faces.map((f) => { const k = keyOf(f), a = (act.get(k) ?? 0) * 0.85 + (f[5] || 0) * 0.15 + f[2] * f[3] * 2; act.delete(k); act.set(f[0] + f[2] / 2, a); return { f, a, k: f[0] + f[2] / 2 }; });
    const best = cur.reduce((x, y) => (y.a > x.a ? y : x));
    const mine = who !== null ? cur.find((x) => Math.abs(x.k - who) < 0.12) : null;
    const pick = mine && best.a < mine.a * 1.35 ? mine : best;
    who = pick.k;
    // all faces fit in the window together -> frame their middle (a two-shot stays a two-shot)
    const lo = Math.min(...faces.map((f) => f[A])), hi = Math.max(...faces.map((f) => f[A] + f[S]));
    if (hi - lo < win * 0.85) return { c: (lo + hi) / 2, face: true };
    return { c: pick.f[A] + pick.f[S] / 2 + (axis === 'y' ? pick.f[S] * 0.6 : 0), face: true }; // vertical: some headroom
  });
  // fill gaps with the last known target; none at all -> centre
  let last = target.find(Boolean)?.c ?? 0.5;
  const tgt = target.map((x) => (x ? (last = x.c) : last));
  const crop = (cx) => r4(Math.min(1, Math.max(0, (cx - win / 2) / (1 - win))));
  // camera operator: hold while the subject stays in the middle 40% of the frame, pan (0.6 s) for small moves,
  // cut for jumps of more than half the window; never move more often than every 1.2 s
  const keys = [], dz = win * 0.2, MOVE = 0.6;
  let cur = tgt[0], lastMove = -9;
  keys.push({ t: 0, v: crop(cur), ease: 'io' });
  samples.forEach((s, i) => {
    const t = rel(s.t), want = tgt[i];
    if (Math.abs(want - cur) <= dz || t - lastMove < 1.2) return;
    // the target must stay put for a moment (not a glance)
    const ahead = tgt.slice(i, i + 4);
    if (ahead.some((x) => Math.abs(x - want) > dz)) return;
    const jump = Math.abs(want - cur) > win * 0.5;
    if (jump) { keys.push({ t: +Math.max(0, t - 0.04).toFixed(3), v: crop(cur), ease: 'hold' }); keys.push({ t: +t.toFixed(3), v: crop(want), ease: 'io' }); }
    else { keys.push({ t: +t.toFixed(3), v: crop(cur), ease: 'io' }); keys.push({ t: +(t + MOVE).toFixed(3), v: crop(want), ease: 'io' }); }
    cur = want; lastMove = t;
  });
  // tidy: keys in order, no two at the same moment, drop keys that change nothing
  const out = [];
  for (const k of keys.sort((a, b) => a.t - b.t)) {
    if (out.length && k.t - out[out.length - 1].t < 0.02) { out[out.length - 1] = k; continue; }
    out.push(k);
  }
  const moves = out.filter((k, i) => i && Math.abs(k.v - out[i - 1].v) > 0.002).length;
  return { axis: axis === 'x' ? 'cropX' : 'cropY', keys: out, moves, faces: target.filter((x) => x?.face).length / samples.length };
}

// faces -> tracks (nearest face in the next samples, gaps up to 1 s bridged) -> moving blur masks
export function faceMasks(samples, { amount = 0.7, type = 'blur', minSeen = 3 } = {}) {
  const tracks = [];
  for (const s of samples) {
    const used = new Set();
    for (const f of s.faces.filter((x) => x[4] > 0.55)) {
      const cx = f[0] + f[2] / 2, cy = f[1] + f[3] / 2;
      let best = null, bd = Infinity;
      tracks.forEach((tr, i) => {
        const p = tr.pts[tr.pts.length - 1];
        if (used.has(i) || s.t - p.t > 1.0) return;
        const d = Math.hypot(p.x + p.w / 2 - cx, p.y + p.h / 2 - cy);
        if (d < Math.max(p.w, f[2]) * 1.2 && d < bd) { bd = d; best = i; }
      });
      const pt = { t: s.t, x: f[0], y: f[1], w: f[2], h: f[3] };
      if (best === null) tracks.push({ pts: [pt] }); else { tracks[best].pts.push(pt); used.add(best); }
    }
  }
  return tracks.filter((tr) => tr.pts.length >= minSeen).map((tr, i) => {
    // a little bigger than the detected box (hair, chin), smoothed over 3 samples, and held 0.3 s past the ends
    const P = tr.pts, sm = P.map((p, k) => { const nb = P.slice(Math.max(0, k - 1), k + 2), avg = (q) => nb.reduce((a, b) => a + b[q], 0) / nb.length; return { t: p.t, x: avg('x'), y: avg('y'), w: avg('w'), h: avg('h') }; });
    const grow = (p) => ({ t: +p.t.toFixed(3), x: r4(p.x - p.w * 0.12), y: r4(p.y - p.h * 0.15), w: r4(p.w * 1.24), h: r4(p.h * 1.3) });
    const path = simplifyPath(sm.map(grow), 0.004);
    path.unshift({ ...path[0], t: +Math.max(0, path[0].t - 0.3).toFixed(3) });
    path.push({ ...path[path.length - 1], t: +(path[path.length - 1].t + 0.3).toFixed(3) });
    return { id: `face${i}`, type, amount, auto: 'faces', path };
  });
}
