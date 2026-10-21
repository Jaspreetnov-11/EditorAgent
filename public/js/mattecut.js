// ✂ Subject cut-out with a matte video (engine/matte.py: white = the subject). Used by Motion video layers and the
// Fusion "Subject Matte" node - the same pixels in the viewer and in the bake.
//   mode 'cutout'     the subject only (the rest transparent)
//   mode 'background' everything but the subject
//   mode 'matte'      the matte itself, black & white
const pool = [];
function cnv(i, w, h) {
  let c = pool[i];
  if (!c) { c = pool[i] = document.createElement('canvas'); }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}
// Refine (manual): choke -0.45..0.45 (+ shrinks the subject, - grows it), edge 0..1 (0 = a hard edge, 1 = as the AI
// gave it); add / remove: pictures (mask nodes) whose white parts are added to / taken out of the subject.
// returns a new canvas w x h (callers draw it right away)
export function cutOut(src, matte, w, h, mode = 'cutout', soft = 0, { choke = 0, edge = 1, add = null, remove = null } = {}) {
  w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const g = out.getContext('2d', { willReadFrequently: true });
  if (mode !== 'matte') g.drawImage(src, 0, 0, w, h);
  const m = cnv(0, w, h), mg = m.getContext('2d', { willReadFrequently: true });
  mg.clearRect(0, 0, w, h);
  mg.filter = soft > 0 ? `blur(${soft}px)` : 'none';
  mg.drawImage(matte, 0, 0, w, h);
  mg.filter = 'none';
  const md = mg.getImageData(0, 0, w, h).data;
  const pix = (img, i) => { if (!img) return null; const c = cnv(i, w, h), x = c.getContext('2d', { willReadFrequently: true }); x.clearRect(0, 0, w, h); x.drawImage(img, 0, 0, w, h); return x.getImageData(0, 0, w, h).data; };
  const ad = pix(add, 1), rd = pix(remove, 2);
  const c0 = 0.5 + Math.max(-0.45, Math.min(0.45, +choke || 0)), hw = 0.02 + 0.48 * Math.max(0, Math.min(1, edge ?? 1)), lo = c0 - hw, span = 2 * hw;
  const refine = choke || (edge ?? 1) < 1 || ad || rd;
  const d = mode === 'matte' ? g.createImageData(w, h) : g.getImageData(0, 0, w, h), px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    let a = md[i];
    if (refine) {
      a = Math.min(1, Math.max(0, (a / 255 - lo) / span));
      if (ad) a = Math.max(a, (ad[i] * ad[i + 3]) / 65025);
      if (rd) a *= 1 - (rd[i] * rd[i + 3]) / 65025;
      a *= 255;
    }
    if (mode === 'matte') { px[i] = px[i + 1] = px[i + 2] = a; px[i + 3] = 255; }
    else px[i + 3] = (px[i + 3] * (mode === 'background' ? 255 - a : a)) / 255;
  }
  g.putImageData(d, 0, 0);
  return out;
}
// the URL of a matte file of the open project, as compvideo.js ids ('url:…')
export const matteId = (proj, file) => `url:/api/matte/file?p=${encodeURIComponent(proj)}&f=${encodeURIComponent(file)}`;
