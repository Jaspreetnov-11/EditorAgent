// 📊 Sessions (owner): who worked in the editor, when and for how long - the last 30 days. Time counts only while a tab
// was really in use (engine/presence.mjs). Per person: today / 7 days / 30 days, a bar per day, every session, and the
// sign-ins from other computers. ⬇ CSV gives the month as a spreadsheet.
import { api } from './api.js';
import { esc, toast, modal } from './ui.js';

const dur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const day = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function openSessions() {
  const dlg = modal('Sessions - who worked, when, how long', '<div data-ss><div class="muted pad">Loading…</div></div>', { width: 900 });
  const box = dlg.el.querySelector('[data-ss]');
  let data;
  try { data = await api('GET', '/api/team/sessions'); } catch (e) { box.innerHTML = `<p class="warn">${esc(e.message)}</p>`; return; }
  const open = new Set();
  const days = Array.from({ length: 30 }, (_, i) => { const d = new Date(data.now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 29 + i); return d; });
  const draw = () => {
    const ppl = data.people;
    const maxDay = Math.max(1, ...ppl.flatMap((p) => Object.values(p.days)));
    box.innerHTML = `
      <p class="muted small">Time counts only while someone is really using the editor (its tab in front, mouse or keys used in the last 5 minutes). A pause of more than 3 minutes, or another project, starts a new session. The last ${data.keepDays} days are kept.</p>
      ${ppl.length ? `<table class="ss-tab"><thead><tr><th>Person</th><th>Today</th><th>7 days</th><th>30 days</th><th>Sessions</th><th>Last seen</th><th class="ss-bars-h">Last 30 days</th></tr></thead><tbody>
        ${ppl.map((p) => `<tr class="ss-row${open.has(p.name) ? ' open' : ''}" data-p="${esc(p.name)}">
          <td><b>${esc(p.name)}</b>${p.online ? ' <span class="good small">● working now</span>' : ''}</td><td>${dur(p.today)}</td><td>${dur(p.week)}</td><td><b>${dur(p.month)}</b></td><td>${p.sessions}</td>
          <td class="muted">${day(p.lastSeen)} ${hm(p.lastSeen)}</td>
          <td><div class="ss-bars">${days.map((d) => { const v = p.days[key(d)] || 0; return `<i style="height:${Math.round((v / maxDay) * 100)}%" title="${day(d)}: ${dur(v)}"></i>`; }).join('')}</div></td></tr>
          ${open.has(p.name) ? `<tr class="ss-detail"><td colspan="7"><div class="ss-list">${p.list.map((s) => `<div><span>${day(s.start)}</span><span class="mono">${hm(s.start)} - ${hm(s.end + 60000)}</span><b>${dur(s.ms)}</b><span class="grow">${esc(s.project || '(home)')}</span><span class="muted small">${esc(s.where || '')}</span></div>`).join('')}</div></td></tr>` : ''}`).join('')}
      </tbody></table>` : '<p class="muted">No sessions yet - they appear as people work in the editor.</p>'}
      <h4>Sign-ins from other computers</h4>
      <div class="ss-list ss-logins">${data.logins.length ? data.logins.slice(0, 60).map((l) => `<div><span>${day(l.t)}</span><span class="mono">${hm(l.t)}</span><b>${esc(l.name)}</b><span class="muted small grow">${esc(l.ip || '')}</span></div>`).join('') : '<div class="muted">None in the last 30 days.</div>'}</div>
      <div class="row-in" style="justify-content:flex-end"><button class="small" data-csv>CSV (30 days)</button><button class="small" data-reload>↻ Refresh</button></div>`;
  };
  box.addEventListener('click', async (e) => {
    const r = e.target.closest('.ss-row');
    if (r) { open.has(r.dataset.p) ? open.delete(r.dataset.p) : open.add(r.dataset.p); return draw(); }
    if (e.target.closest('[data-reload]')) { data = await api('GET', '/api/team/sessions').catch((er) => { toast(er.message, 'err'); return data; }); return draw(); }
    if (e.target.closest('[data-csv]')) {
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = [['Person', 'Date', 'Start', 'End', 'Minutes', 'Project', 'From'].map(q).join(',')];
      for (const p of data.people) for (const s of [...p.list].reverse()) rows.push([p.name, key(new Date(s.start)), hm(s.start), hm(s.end + 60000), Math.round(s.ms / 60000), s.project, s.where].map(q).join(','));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv' }));
      a.download = `Limelight sessions ${key(new Date())}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  });
  draw();
}
