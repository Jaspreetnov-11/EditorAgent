// 📱 Phone / tablet: the parts of the touch layout that are plain maths (no page) - which layout a screen gets, the
// phone timeline strip's rows, the texts a clip has to type in, pinch zoom. phone.js and touch.js use them; tests too.

// which layout: 'phone' (its own layout), 'tablet' (the full editor, touch-sized) or 'desktop' (as it always was).
// Only a touch screen (a coarse main pointer) gets a touch layout - a narrow desktop window stays the desktop editor.
// A phone turned sideways (short and wide) is still a phone. `pick`: the user's own choice (Desktop view on a phone).
export function deviceMode({ w, h, coarse, pick = '' }) {
  if (pick === 'phone' || pick === 'tablet' || pick === 'desktop') return pick;
  if (!coarse) return 'desktop';
  return Math.min(w, h) <= 500 && (w <= 640 || h <= 500) ? 'phone' : 'tablet';
}

// the strip on the phone: one row per track that has clips - picture tracks on top (V3, V2 … V1 the main story, taller),
// sound below; each block where its clip is (px = seconds × pxs) with what it is (video / image / text / graphic / audio)
const KIND_OF = (c) => (c.type === 'title' || (c.type === 'graphic' && c.gfx?.tpl === 'text') ? 'text' : c.type === 'graphic' ? 'graphic' : c.type === 'adjust' ? 'adjust' : c.type === 'image' ? 'image' : c.type === 'audio' ? 'audio' : 'video');
export function stripRows(lay, pxs) {
  const keys = Object.keys(lay || {}).filter((k) => /^[VA]\d+$/.test(k) && (lay[k] || []).some((x) => !x.clip?.gap));
  const num = (k) => +k.slice(1);
  const vs = keys.filter((k) => k[0] === 'V').sort((a, b) => num(b) - num(a)), as = keys.filter((k) => k[0] === 'A').sort((a, b) => num(a) - num(b));
  return [...vs, ...as].map((track) => ({
    track, main: track === 'V1', sound: track[0] === 'A',
    blocks: lay[track].filter((x) => !x.clip.gap).map((x) => ({
      id: x.clip.id, start: x.start, end: x.end, left: Math.round(x.start * pxs), width: Math.max(4, Math.round((x.end - x.start) * pxs)),
      kind: KIND_OF(x.clip), label: labelOf(x.clip),
    })),
  }));
}
function labelOf(c) {
  if (c.type === 'title') return String(c.text || 'Title');
  if (c.type === 'graphic') return String(c.gfx?.text || c.gfx?.title || c.gfx?.tpl || 'Graphic');
  if (c.type === 'adjust') return 'Adjustment';
  return String(c.name || '');
}

// the texts of a clip that can be typed on a phone: a title's text, a Type tool text, a graphic's heading / small line /
// lines ({ k, label, value, multi }). `fields`: the graphic template's field list (graphics.js gfxFields), passed in.
export function textFieldsOf(c, fields = []) {
  if (!c) return [];
  if (c.type === 'title') return [{ k: 'text', label: 'Text', value: String(c.text ?? ''), multi: true }];
  if (c.type !== 'graphic' || !c.gfx) return [];
  const out = [];
  if (c.gfx.tpl === 'text') out.push({ k: 'text', label: 'Text', value: String(c.gfx.text ?? ''), multi: true });
  for (const f of fields) {
    if (!f?.k || out.some((o) => o.k === f.k) || !(f.type === 'text' || f.type === 'area')) continue;
    out.push({ k: f.k, label: f.label || f.k, value: String(c.gfx[f.k] ?? ''), multi: f.type === 'area' });
  }
  return out;
}
// write a typed text back (titles keep it on the clip, graphics in clip.gfx); false when nothing changed
export function setText(c, k, v) {
  const o = c.type === 'title' ? c : c.gfx;
  if (!o || String(o[k] ?? '') === v) return false;
  o[k] = v;
  return true;
}

// two fingers apart / together: the new zoom from the distance between them now and when they touched (clamped)
export function pinchZoom(z0, d0, d1, min, max) {
  if (!(d0 > 0) || !(d1 > 0)) return z0;
  return Math.max(min, Math.min(max, z0 * (d1 / d0)));
}

// captions near the playhead first (the ones being heard now and just after), at most n
export function cuesAround(cues, t, n = 30) {
  const list = (cues || []).filter((c) => c && typeof c.text === 'string');
  const i = Math.max(0, list.findIndex((c) => c.end > t));
  const from = Math.max(0, Math.min(i - 2, list.length - n));
  return list.slice(from, from + n);
}
