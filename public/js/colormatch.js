// 🎨 Colour match to any reference (Premiere's Color Match): the clip takes the colour of another clip on the timeline
// (with that clip's grade), of any video / photo in the Media pool, or of a still image uploaded for it (it goes into
// Media › Colour references). The look is measured on the server (POST /api/color/match, engine/colorstats.mjs) and
// becomes the clip's gain / offset, like Shot match on the Color page - which uses these same choices.
import { S, commit, layout, findClip } from './store.js';
import { api, enc, uploadFile } from './api.js';
import { $, esc, toast, modal } from './ui.js';
import { refreshMedia } from './mediapool.js';

const visual = (c) => c && !c.gap && (c.type === 'video' || c.type === 'image') && !S.mediaById[c.mediaId]?.template;
const timelineClips = () => { const L = layout(); return Object.keys(L).filter((t) => t[0] === 'V').flatMap((t) => L[t].map((x) => ({ ...x, track: t }))).filter((x) => visual(x.clip)); };
const usable = (m) => m && (m.kind === 'video' || m.kind === 'image') && m.status === 'ready' && !m.template; // (🎞 not a template: mostly clear)

// the <option>s of a reference picker: 'c:<clip id>' (timeline), 'm:<media id>' (pool), 'still' (upload one)
// skip: clip ids that are being matched (not a reference for themselves)
export function refOptions(skip = new Set(), sel = '') {
  const o = (v, label) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(label)}</option>`;
  const tl = timelineClips().filter((x) => !skip.has(x.clip.id));
  const pool = S.media.filter(usable).sort((a, b) => (a.bin === 'Colour references' ? -1 : 0) - (b.bin === 'Colour references' ? -1 : 0));
  return `${tl.length ? `<optgroup label="Timeline clips">${tl.map((x, i) => o(`c:${x.clip.id}`, `${x.track} · ${String(i + 1).padStart(2, '0')} · ${S.mediaById[x.clip.mediaId]?.name || ''}${x.clip.color && Object.keys(x.clip.color).length ? ' (graded)' : ''}`)).join('')}</optgroup>` : ''}`
    + `${pool.length ? `<optgroup label="Media pool">${pool.map((m) => o(`m:${m.id}`, `${m.kind === 'image' ? '🖼' : '🎞'} ${m.name}`)).join('')}</optgroup>` : ''}`
    + `<optgroup label="A still image">${o('still', '📷 Upload a reference still…')}</optgroup>`;
}

// a picked still image (or video) uploaded into Media › Colour references -> its key 'm:<id>' once it is read
export function uploadStill() {
  return new Promise((ok) => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*,video/*' });
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return ok(null);
      toast(`Uploading ${f.name}…`);
      try {
        const m = await uploadFile(S.proj, f, { bin: 'Colour references' });
        if (!m?.id) throw new Error(m?.error || 'Not an image or a video');
        for (let i = 0; i < 80; i++) { await refreshMedia(); const x = S.mediaById[m.id]; if (x?.status === 'ready') return ok(`m:${m.id}`); if (x?.status === 'error') throw new Error(x.error || 'It could not be read'); await new Promise((r) => setTimeout(r, 500)); }
        throw new Error('It is taking too long to read');
      } catch (e) { toast(e.message, 'err'); ok(null); }
    };
    inp.click();
  });
}

// key -> the reference the server measures: { mediaId, in, out, color }
export function refOf(key) {
  if (key?.startsWith('c:')) {
    const c = findClip(key.slice(2))?.clip;
    return c ? { mediaId: c.mediaId, in: c.in, out: c.out, color: c.color || null } : null;
  }
  if (key?.startsWith('m:')) { const m = S.mediaById[key.slice(2)]; return usable(m) ? { mediaId: m.id, in: 0, out: m.kind === 'image' ? 0 : m.duration } : null; }
  return null;
}

// match each clip to the reference (one undo step); returns how many changed
export async function matchClips(clips, ref, label = 'Color match', each = null) {
  let n = 0;
  for (const c of clips.filter(visual)) {
    const g = await api('POST', `/api/color/match?p=${enc(S.proj)}`, { target: { mediaId: c.mediaId, in: c.in, out: c.out, color: c.color }, ref });
    c.color = g; // (as Shot match always did: the grade becomes the match - its LUT kept - measured without the rest)
    each?.(c); n++;
  }
  if (n) commit(label);
  return n;
}

// right-click a clip > Color match to a reference…: for the clip (and the other selected picture clips)
export function openColorMatch(ids) {
  const clips = [...new Set(ids)].map((id) => findClip(id)?.clip).filter(visual);
  if (!clips.length) return toast('Color match works on video and photo clips', 'err');
  const skip = new Set(clips.map((c) => c.id));
  const dlg = modal('🎨 Color match', `<p class="muted small">${clips.length > 1 ? `${clips.length} clips take` : 'The clip takes'} the colour of the reference: another clip on the timeline (with its grade), any video or photo in Media, or a still image you upload. It sets Gain and Offset - fine-tune on the Color page.</p>
    <label class="fld"><span>Reference</span><select data-ref style="width:100%">${refOptions(skip)}</select></label>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px"><button data-close>Cancel</button><button class="primary" data-go>Match</button></div>`, { width: 480 });
  const sel = $('[data-ref]', dlg.el);
  sel.addEventListener('change', async () => {
    if (sel.value !== 'still') return;
    const k = await uploadStill();
    sel.innerHTML = refOptions(skip, k || '');
    if (!k) sel.selectedIndex = 0;
  });
  $('[data-go]', dlg.el).addEventListener('click', async (e) => {
    const ref = refOf(sel.value);
    if (!ref) return toast('Pick a reference', 'err');
    e.target.disabled = true; e.target.textContent = 'Matching…';
    try { const n = await matchClips(clips, ref); dlg.close(); toast(`🎨 ${n} clip${n > 1 ? 's' : ''} matched to ${sel.selectedOptions[0]?.textContent || 'the reference'}`); }
    catch (err) { toast(err.message, 'err'); e.target.disabled = false; e.target.textContent = 'Match'; }
  });
}
