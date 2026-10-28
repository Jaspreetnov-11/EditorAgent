// 🎯 Mask tracking, like Premiere's mask tracker: the mask's shape where it is at the playhead is followed through the
// rest of the shot (engine/track.py: corner points inside its box, frame to frame) - the shape moves and grows /
// shrinks with the subject. Stored on the mask as m.track (shapemask.js maskAt); the render draws it the same way.
import { S, findClip, layout } from './store.js';
import { api, enc, watchJob } from './api.js';
import { ASPECTS, propAt } from './model.js';
import { toast } from './ui.js';
import { fitMap, framingOf, srcSize, srcTimeAt } from './tracking.js';
import { maskAt, maskBox, trackFromBoxes } from './shapemask.js';

// track mask m of clip id from the playhead to the end of the shot -> the mask with its new track (or null);
// scale: it grows / shrinks with the subject too (else it only moves)
export async function trackMask(id, m, onStage = () => {}, { scale = false } = {}) {
  const f = findClip(id), c = f?.clip, x = f && layout()[f.track].find((p) => p.clip.id === id);
  if (c?.type !== 'video') { toast('Tracking needs a video shot', 'err'); return null; }
  const md = S.mediaById[c.mediaId], rel = S.playhead - (x?.start ?? 0);
  if (!x || rel < 0 || rel >= x.end - x.start - 0.05) { toast('Put the playhead on this shot, where the subject is inside the mask', 'err'); return null; }
  if (!md?.playable) { toast("Wait for this shot's preview copy first (it is being made)", 'err'); return null; }
  const [W, H] = ASPECTS[S.project.settings.aspect] || [1920, 1080], [sw, sh] = srcSize(md);
  const fm = fitMap(framingOf(c, S.project.settings, W, H), sw, sh, W, H, propAt(c, 'cropX', rel), propAt(c, 'cropY', rel));
  // the mask's box (the picture's own place = the frame before Motion) -> fractions of the source picture, and back
  const now = { ...maskAt(m, rel) }; delete now.track;
  const b = maskBox(now), cl = (v) => Math.min(1, Math.max(0, v));
  const sx = (v) => cl((v * W - fm.ox) / fm.s / sw), sy = (v) => cl((v * H - fm.oy) / fm.s / sh);
  const src = { x: sx(b.x), y: sy(b.y) }; src.w = sx(b.x + b.w) - src.x; src.h = sy(b.y + b.h) - src.y;
  if (!(src.w > 0.005 && src.h > 0.005)) { toast('The mask is outside the picture', 'err'); return null; }
  onStage('Tracking the mask…');
  const job = await api('POST', `/api/track?p=${enc(S.proj)}`, { mediaId: c.mediaId, t0: srcTimeAt(c, rel), t1: c.out ?? md.duration, box: src });
  const r = (await watchJob(job.id, (j) => onStage(j.stage || 'Tracking the mask…'))).result;
  const sp = c.speed || 1;
  const boxes = (r.points || []).map((p) => ({ t: (p.t - (c.in || 0)) / sp, x: (fm.ox + p.x * sw * fm.s) / W, y: (fm.oy + p.y * sh * fm.s) / H, w: (p.w * sw * fm.s) / W, h: (p.h * sh * fm.s) / H }))
    .filter((p) => p.t >= rel - 0.05 && p.t <= x.end - x.start + 0.05);
  // (every other point is enough at 15 a second: the mask moves smoothly between them)
  const track = trackFromBoxes(boxes.filter((_, i) => i % 2 === 0 || i === boxes.length - 1), { scale });
  if (!track || track.keys.length < 2) { toast('Could not follow it - try a bigger mask over something with detail', 'err'); return null; }
  if (r.lost?.length > 10) toast(`Lost it ${r.lost.length} times (turned away or covered) - check it, and track again from there if needed`, 'err');
  // (the first key is where the drawn shape is now: before the playhead the mask stays there)
  return { ...now, track };
}
