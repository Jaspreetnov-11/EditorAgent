// 📍 Markers like Premiere's: a name, a comment, one of Premiere's marker colours and a length (a range marker shows as
// a band on the ruler). Double-click a marker on the ruler (or press M on one) to edit it; Window › Markers lists them
// all - click one to go there. project.markers = [{ t, dur?, name?, comment?, color?, note?, done? }] (notes are the
// 📝 review notes, kept as they are).
import { S, commit, emit } from './store.js';
import { fmtTC, parseTime } from './model.js';
import { $, $$, esc, toast, modal } from './ui.js';

export const MARKER_COLORS = [['#4f8cff', 'Blue'], ['#36c27e', 'Green'], ['#e8d44d', 'Yellow'], ['#ff9933', 'Orange'], ['#e24c4c', 'Red'], ['#c85fd6', 'Purple'], ['#3fc7c7', 'Cyan'], ['#f06fb0', 'Rose']];
const list = () => (S.project.markers ||= []);
const tc = (t) => fmtTC(t, S.project.settings.fps);

export function editMarker(mk, after) {
  const d = modal('Marker', `<div class="mk-edit">
    <label class="fld"><span>Name</span><input data-k="name" value="${esc(mk.name || '')}" placeholder="e.g. CM arrives"></label>
    <div class="row-in"><label class="fld"><span>In</span><input data-k="t" value="${esc(tc(mk.t))}"></label>
      <label class="fld"><span>Duration (s)</span><input data-k="dur" type="number" min="0" step="0.1" value="${(+mk.dur || 0).toFixed(2)}"></label></div>
    <label class="fld"><span>Comment</span><textarea data-k="comment" rows="3">${esc(mk.comment || mk.note || '')}</textarea></label>
    <div class="mk-colors">${MARKER_COLORS.map(([c, n]) => `<button class="mk-c${(mk.color || '#4f8cff') === c ? ' on' : ''}" data-c="${c}" title="${n}" style="background:${c}"></button>`).join('')}</div>
    <div class="dv-actions"><button class="danger" data-del>Delete</button><span class="grow"></span><button data-close>Cancel</button><button class="primary" data-ok>OK</button></div></div>`, { width: 440 });
  let color = mk.color || '#4f8cff';
  d.el.addEventListener('click', (e) => { const c = e.target.closest('[data-c]'); if (c) { color = c.dataset.c; $$('[data-c]', d.el).forEach((b) => b.classList.toggle('on', b === c)); } });
  $('[data-del]', d.el).onclick = () => { const L = list(), i = L.indexOf(mk); if (i >= 0) L.splice(i, 1); d.close(); commit('Delete marker'); after?.(); };
  $('[data-ok]', d.el).onclick = () => {
    const v = (k) => $(`[data-k="${k}"]`, d.el).value;
    // (the box shows HH:MM:SS:FF - frames last; anything else as the editor reads times)
    const tv = v('t').trim(), p4 = tv.split(':').map(Number), fps = S.project.settings.fps || 30;
    const t = p4.length === 4 && p4.every(Number.isFinite) ? p4[0] * 3600 + p4[1] * 60 + p4[2] + p4[3] / fps : parseTime(tv);
    if (Number.isFinite(t)) mk.t = +Math.max(0, t).toFixed(3);
    const dur = +v('dur'); if (dur > 0) mk.dur = +dur.toFixed(3); else delete mk.dur;
    const nm = v('name').trim(); if (nm) mk.name = nm; else delete mk.name;
    const cm = v('comment').trim();
    if (mk.note !== undefined) mk.note = cm || mk.note; else if (cm) mk.comment = cm; else delete mk.comment;
    mk.color = color;
    if (!list().includes(mk)) list().push(mk);
    list().sort((a, b) => a.t - b.t);
    d.close(); commit('Marker'); after?.();
  };
  setTimeout(() => $('[data-k="name"]', d.el)?.focus(), 30);
}

// the marker at (or within a few pixels of) time t on the ruler
export const markerNear = (t, px = 6) => list().find((m) => Math.abs(m.t - t) * S.zoom <= px || (m.dur && t >= m.t && t <= m.t + m.dur));

export function openMarkersList() {
  if (!S.project) return;
  const d = modal('Markers', '<div class="mk-list" data-list></div>', { width: 620 });
  const draw = () => {
    const L = list();
    $('[data-list]', d.el).innerHTML = L.length ? `<table class="mk-t"><thead><tr><th></th><th>In</th><th>Duration</th><th>Name</th><th>Comment</th><th></th></tr></thead><tbody>${L.map((m, i) => `<tr data-i="${i}">
      <td><i class="mk-dot" style="background:${m.color || (m.note ? (m.done ? '#36c27e' : '#ff9933') : '#4f8cff')}"></i></td><td class="mono">${tc(m.t)}</td><td class="mono">${m.dur ? `${(+m.dur).toFixed(2)} s` : ''}</td>
      <td>${esc(m.name || (m.note ? 'Note' : ''))}</td><td class="muted small">${esc((m.comment || m.note || '').slice(0, 80))}</td><td><button class="link small" data-ed="${i}">Edit</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No markers yet - press M on the timeline to add one at the playhead.</p>';
  };
  d.el.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-ed]'); if (ed) { editMarker(list()[+ed.dataset.ed], draw); return; }
    const r = e.target.closest('tr[data-i]'); if (r) { emit('seek', list()[+r.dataset.i].t); }
  });
  draw();
}
