// 🧩 Hisse (Phase 16): parts of a timeline given to people - "0-30s: Rahul", "V2 graphics: Priya". Shown as a band
// over the timeline; when someone changes a clip inside a part that is someone else's, they get a warning (it is not
// blocked - the team decides). Stored in project.zones (one list for all sequences, each zone names its sequence), so it
// reaches everyone live like any other change.
import { S, on, commit, layout } from './store.js';
import { placed, seqOf, trackList, fmt, parseTime, uid } from './model.js';
import { esc, toast, modal } from './ui.js';

export const myName = () => S.me?.name || 'Owner';
const curSeq = () => seqOf(S.project).id;
export const zonesHere = () => (S.project?.zones || []).filter((z) => (z.seq || 'main') === curSeq());
const COLORS = ['#ffb020', '#4cc9f0', '#f72585', '#80ed99', '#b388ff', '#ff7b54', '#ffd6a5', '#06d6a0'];
const colorOf = (name) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
export const zoneColor = (z) => z.color || colorOf(z.name);

// the clips a change touched, with where they were before and are now
function touched(ops, before) {
  const out = new Map();
  for (const op of ops) {
    if (op.p[0] !== 'tracks' || !op.p[1]) continue;
    const id = typeof op.p[2] === 'string' && op.p[2][0] === '#' ? op.p[2].slice(1) : op.o === 'del' ? op.id : op.v?.id;
    if (id !== undefined) out.set(String(id), op.p[1]);
  }
  if (!out.size) return [];
  const span = (pj) => { const m = new Map(); try { for (const [t, list] of Object.entries(placed(pj, S.mediaById))) for (const x of list) m.set(String(x.clip.id), { t, s: x.start, e: x.end }); } catch {} return m; };
  const a = span(before), b = span(S.project), res = [];
  for (const [id, track] of out) {
    const r = [a.get(id), b.get(id)].filter(Boolean);
    if (r.length) res.push({ track, s: Math.min(...r.map((x) => x.s)), e: Math.max(...r.map((x) => x.e)) });
  }
  return res;
}

// a warning when your change lands in someone else's part (once per part every 20s, so a drag does not spam)
const warned = new Map();
on('ops', ({ ops, before }) => {
  const zs = zonesHere().filter((z) => z.name !== myName());
  if (!zs.length || !before) return;
  for (const c of touched(ops, before)) {
    const z = zs.find((x) => (!x.track || x.track === c.track) && c.s < x.end && c.e > x.start);
    if (!z || Date.now() - (warned.get(z.id) || 0) < 20000) continue;
    warned.set(z.id, Date.now());
    toast(`⚠ This zone belongs to ${z.name} (${fmt(z.start)}–${fmt(z.end)}${z.track ? `, ${z.track}` : ''}). Your change was made - let them know (or press Ctrl+Z).`, 'err');
    return;
  }
});

// the band over the timeline canvas (called by timeline.js after every draw)
export function zoneBandsHTML(zoom) {
  return zonesHere().map((z) => `<div class="zone-band" style="left:${z.start * zoom}px;width:${Math.max(2, (z.end - z.start) * zoom)}px;--zone:${esc(zoneColor(z))}" title="${esc(z.name)}: ${fmt(z.start)}–${fmt(z.end)}${z.track ? ` (${esc(z.track)})` : ' (all tracks)'}${z.note ? ` - ${esc(z.note)}` : ''}"><span>🧩 ${esc(z.name)}${z.track ? ` · ${esc(z.track)}` : ''}</span></div>`).join('');
}

export function openZones() {
  if (!S.project) return;
  const people = [...new Set([myName(), ...(S.peopleAll || []).map((p) => p.name), ...(S.project.zones || []).map((z) => z.name)])].filter(Boolean);
  // a new part starts as the selected clips' span, or 30s from the playhead
  const L = layout(), sel = Object.values(L).flat().filter((x) => S.sel.has(x.clip.id));
  const s0 = sel.length ? Math.min(...sel.map((x) => x.start)) : +S.playhead || 0, e0 = sel.length ? Math.max(...sel.map((x) => x.end)) : s0 + 30;
  const dlg = modal('🧩 Zones - who owns which part of the timeline', `
    <p class="muted">Assign parts of the timeline to people. If someone else changes a zone, they get a warning (the change is not blocked). Only zones of this sequence ("${esc(seqOf(S.project).name)}") are shown.</p>
    <div class="dv-list" data-zl></div>
    <h4>New zone</h4>
    <div class="fgrid">
      <label class="fld"><span>Owner</span><input data-zn list="zonePeople" value="${esc(myName())}"><datalist id="zonePeople">${people.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></label>
      <label class="fld"><span>Track</span><select data-zt><option value="">All tracks</option>${trackList(S.project).map((t) => `<option>${esc(t.id || t)}</option>`).join('')}</select></label>
      <label class="fld"><span>Start</span><input data-zs value="${fmt(s0)}"></label>
      <label class="fld"><span>End</span><input data-ze value="${fmt(e0)}"></label>
      <label class="fld" style="grid-column:1/-1"><span>Note (optional)</span><input data-zx placeholder="e.g. intro + titles"></label>
    </div>
    <div class="dv-actions"><button class="primary" data-zadd>+ Add zone</button><button data-close>Close</button></div>`, { width: 640 });
  const box = dlg.el.querySelector('[data-zl]');
  const draw = () => {
    box.innerHTML = zonesHere().sort((a, b) => a.start - b.start).map((z) => `<div class="dv-item"><i class="zone-dot" style="background:${esc(zoneColor(z))}"></i>
      <span class="grow"><b>${esc(z.name)}</b> · ${fmt(z.start)}–${fmt(z.end)} · ${z.track ? esc(z.track) : 'all tracks'}${z.note ? ` <span class="muted small">${esc(z.note)}</span>` : ''}</span>
      <button class="link small" data-zrm="${esc(z.id)}">Remove</button></div>`).join('') || '<div class="muted pad">No zones assigned yet.</div>';
  };
  draw();
  dlg.el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.zrm) {
      S.project.zones = (S.project.zones || []).filter((z) => z.id !== b.dataset.zrm);
      commit('Zone removed'); draw();
    }
    if (b.dataset.zadd !== undefined) {
      const name = dlg.el.querySelector('[data-zn]').value.trim(), start = parseTime(dlg.el.querySelector('[data-zs]').value), end = parseTime(dlg.el.querySelector('[data-ze]').value);
      if (!name) return toast('Enter a name', 'err');
      if (!(end > start) || !(start >= 0)) return toast('Enter a valid start and end time (e.g. 0:00 and 0:30)', 'err');
      const track = dlg.el.querySelector('[data-zt]').value, note = dlg.el.querySelector('[data-zx]').value.trim();
      const clash = zonesHere().find((z) => z.name !== name && (!z.track || !track || z.track === track) && start < z.end && end > z.start);
      if (clash && !confirm(`This overlaps ${clash.name}'s zone (${fmt(clash.start)}–${fmt(clash.end)}). Add it anyway?`)) return;
      (S.project.zones ||= []).push({ id: uid(), seq: curSeq(), name, start: +start.toFixed(3), end: +end.toFixed(3), track, ...(note ? { note } : {}) });
      commit(`Zone: ${name} ${fmt(start)}–${fmt(end)}`); draw();
      toast(`🧩 ${fmt(start)}–${fmt(end)} is now ${name}'s zone`);
    }
  });
}
