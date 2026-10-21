// 🎯 Tracking in Effect Controls: blur / pixelate a moving thing on a shot, or make an overlay (title, logo, image,
// video) follow a moving thing in the shot below it. The box is drawn on the viewer at the playhead and tracked to
// the end of the shot by the server (engine/track.py).
import { S, commit, findClip, layout } from './store.js';
import { api, enc, watchJob } from './api.js';
import { ASPECTS, propAt, uid, fmt } from './model.js';
import { esc, toast } from './ui.js';
import { pickBox } from './player.js';
import { fitMap, framingOf, srcSize, srcTimeAt, simplifyPath, followKeys } from './tracking.js';

// a box drawn on the viewer (fractions of the frame) -> fractions of clip c's source picture at clip time rel
function toSource(box, c, rel) {
  const m = S.mediaById[c.mediaId], [W, H] = ASPECTS[S.project.settings.aspect] || [1920, 1080], [sw, sh] = srcSize(m);
  const f = fitMap(framingOf(c, S.project.settings, W, H), sw, sh, W, H, propAt(c, 'cropX', rel), propAt(c, 'cropY', rel));
  // undo the shot's Motion (zoom about the centre, then the position shift)
  const z = +propAt(c, 'transform.zoom', rel) || 1, tx = ((+propAt(c, 'transform.x', rel) || 0) / 100) * W, ty = ((+propAt(c, 'transform.y', rel) || 0) / 100) * H;
  const un = (px, py) => [W / 2 + (px - W / 2 - tx) / z, H / 2 + (py - H / 2 - ty) / z];
  const [x0, y0] = un(box.x * W, box.y * H), [x1, y1] = un((box.x + box.w) * W, (box.y + box.h) * H);
  const sx = (v) => (v - f.ox) / f.s / sw, sy = (v) => (v - f.oy) / f.s / sh;
  const x = Math.max(0, sx(x0)), y = Math.max(0, sy(y0));
  return { x, y, w: Math.min(1, sx(x1)) - x, h: Math.min(1, sy(y1)) - y };
}

async function track(c, rel, hint) {
  const m = S.mediaById[c.mediaId];
  if (!m?.playable) { toast('Wait for this shot\'s preview copy first (it is being made)', 'err'); return null; }
  const box = await pickBox(hint);
  if (!box) return null;
  const src = toSource(box, c, rel);
  if (!(src.w > 0.005 && src.h > 0.005)) { toast('That box is outside the picture', 'err'); return null; }
  toast('🎯 Tracking…');
  const job = await api('POST', `/api/track?p=${enc(S.proj)}`, { mediaId: c.mediaId, t0: srcTimeAt(c, rel), t1: c.out ?? m.duration, box: src });
  const r = (await watchJob(job.id, () => {})).result;
  if (r.lost?.length > 10) toast(`Lost it ${r.lost.length} times (turned away or covered) - check the result and redo from there if needed`, 'err');
  return simplifyPath(r.points);
}
const relOf = (id) => { const f = findClip(id), x = layout()[f.track].find((p) => p.clip.id === id), rel = S.playhead - x.start; return rel >= 0 && rel < x.end - x.start ? { x, rel } : null; };

export async function addMask(id, type, render) {
  const c = findClip(id)?.clip, at = relOf(id);
  if (!at) return toast('Move the playhead onto this shot, where the thing is visible', 'err');
  try {
    const path = await track(c, at.rel, `Drag a box around what to ${type === 'pixelate' ? 'pixelate' : 'blur'} (face, number plate…) · Esc cancels`);
    if (!path) return;
    (c.masks ||= []).push({ id: uid(), type, amount: 0.6, path });
    commit(`Tracked ${type}`); render();
    toast(`🎯 ${type === 'pixelate' ? 'Mosaic' : 'Blur'} follows it from ${fmt(path[0].t - (c.in || 0))} to ${fmt(path[path.length - 1].t - (c.in || 0))} of the shot`);
  } catch (err) { toast(err.message, 'err'); }
}

export async function addFollow(id, render) {
  const ov = findClip(id)?.clip, L = layout(), [W, H] = ASPECTS[S.project.settings.aspect] || [1920, 1080];
  const tx = L.V1.find((x) => S.playhead >= x.start && S.playhead < x.end && x.clip.type === 'video');
  if (!tx) return toast('Put the playhead on a video shot (V1) that shows the thing to follow', 'err');
  try {
    const path = await track(tx.clip, S.playhead - tx.start, 'Drag a box around the thing this overlay should follow · Esc cancels');
    if (!path) return;
    const k = followKeys(path, tx.clip, tx.start, S.mediaById[tx.clip.mediaId], ov.start || 0, W, H, framingOf(tx.clip, S.project.settings, W, H));
    if (!k) return toast('The tracked part is before this overlay starts', 'err');
    if (ov.type === 'title') ov.follow = k;
    else {
      const bx = +ov.transform?.x || 0, by = +ov.transform?.y || 0;
      ov.keys = { ...(ov.keys || {}), 'transform.x': k.x.map((q) => ({ ...q, v: +(q.v + bx).toFixed(2) })), 'transform.y': k.y.map((q) => ({ ...q, v: +(q.v + by).toFixed(2) })) };
    }
    commit('Follow tracked thing'); render();
    toast('📌 It now follows the tracked thing - press Space to watch');
  } catch (err) { toast(err.message, 'err'); }
}

export function trackingHTML(c, track) {
  const vid = c.type === 'video', ovl = track !== 'V1' && (c.type === 'title' || c.type === 'image' || c.type === 'video');
  const masks = (c.masks || []).map((mk) => `<div class="efx" data-mask="${mk.id}"><div class="efx-h"><b>${mk.type === 'pixelate' ? '🔲 Mosaic' : '🌫 Blur'}</b><small class="muted">${fmt(mk.path[0].t - (c.in || 0))} → ${fmt(mk.path[mk.path.length - 1].t - (c.in || 0))}</small><span class="grow"></span><button class="icon-btn small" data-mdel title="Remove">✕</button></div>
      <label class="fld"><span>Strength</span><input type="range" min="0" max="1" step="0.05" value="${mk.amount ?? 0.6}" data-mamt></label></div>`).join('');
  const following = c.follow?.x?.length || (c.keys?.['transform.x']?.length > 3);
  return `${vid ? `<div class="row-in"><button class="small" data-trk="blur" title="Hide a face / number plate that moves: draw a box at the playhead">🌫 Blur a moving thing</button><button class="small" data-trk="pixelate">🔲 Pixelate a moving thing</button></div>${masks}` : ''}
    ${ovl ? `<div class="row-in"><button class="small" data-trk="follow" title="Make this ${esc(c.type)} move with something in the shot below (name tag on a person, logo on a car)">📌 Follow a moving thing…</button>${following ? '<button class="small" data-trk="unfollow">✕ Stop following</button>' : ''}</div>` : ''}
    <small class="hint">Put the playhead where the thing is clearly visible, press a button, then drag a box around it on the viewer. It is tracked to the end of the shot.</small>`;
}

export function bindTracking(root, id, render) {
  root.querySelectorAll('[data-trk]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.trk, c = findClip(id)?.clip;
    if (k === 'blur' || k === 'pixelate') return addMask(id, k, render);
    if (k === 'follow') return addFollow(id, render);
    if (k === 'unfollow') { delete c.follow; if (c.keys) { delete c.keys['transform.x']; delete c.keys['transform.y']; if (!Object.keys(c.keys).length) delete c.keys; } commit('Stop following'); render(); }
  }));
  root.querySelectorAll('[data-mask]').forEach((el) => {
    const c = () => findClip(id)?.clip, mk = () => c()?.masks?.find((x) => x.id === el.dataset.mask);
    el.querySelector('[data-mdel]').onclick = () => { const cl = c(); cl.masks = cl.masks.filter((x) => x.id !== el.dataset.mask); if (!cl.masks.length) delete cl.masks; commit('Remove tracked mask'); render(); };
    const r = el.querySelector('[data-mamt]');
    r.oninput = () => { mk().amount = +r.value; };
    r.onchange = () => commit('Mask strength', `mask-${el.dataset.mask}`);
  });
}
