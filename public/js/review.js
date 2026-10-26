// Review & share: 📝 notes at a moment of the timeline (yours and ones typed on a phone), 🕘 versions (auto backups +
// named versions: go back to an earlier edit, or bring it in as a sequence), 📱 phone review over the local network and
// 🔗 client review links over the internet (Send for review: comments, approve / changes per version).
// Notes are markers with a text: { id, t, note, by, done, at, phone, render } - the ruler draws them, orange until done.
// A client's comment also has { client: true, review: <link id>, version: <n> }.
import { ic } from './lineicons.js';
import { guarded } from './errlog.js';
import { S, on, emit, commit, saveNow } from './store.js';
import { api, enc } from './api.js';
import { fmtTC, seqOf, seqData, uid } from './model.js';
import { $, $$, esc, toast, modal } from './ui.js';

let root, showDone = false, phoneTimer = null;
const notes = () => (S.project?.markers || []).filter((m) => m.note);

export function mountNotesPanel(el) {
  root = el;
  el.innerHTML = `<div class="nt">
    <div class="nt-add"><textarea data-ntext rows="2" placeholder="Note at the playhead… (Shift+M)" aria-label="New note"></textarea>
      <div class="nt-row"><span class="muted small" data-nat></span><span class="grow"></span><button class="small primary" data-a="add">Add note</button></div></div>
    <div class="nt-row nt-tools"><label class="chk small"><input type="checkbox" data-done> Show done</label><span class="grow"></span>
      <button class="small" data-a="versions" title="Earlier versions of this edit - go back, or bring one in as a sequence">Versions</button>
      <button class="small" data-a="share" title="Watch the renders on a phone on the same Wi-Fi and send notes from there">Phone</button>
      <button class="small" data-a="send" title="Send a finished render to a client: a link they open anywhere, comment on and approve">Review</button></div>
    <div class="crv-strip" data-crv hidden></div>
    <div class="nt-list" data-list></div></div>`;
  const ta = $('[data-ntext]', el);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); } });
  ta.addEventListener('focus', drawAt);
  $('[data-done]', el).onchange = (e) => { showDone = e.target.checked; draw(); };
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'add') addNote();
    if (a === 'versions') openVersions();
    if (a === 'share') openShare();
    if (a === 'send') openSendReview();
    if (a === 'reviews') openReviews();
    const cp = e.target.closest('[data-crcopy]'); if (cp) copyLink(cp.dataset.crcopy);
    const t = e.target.closest('[data-seek]'); if (t) emit('seek', +t.dataset.seek);
    const d = e.target.closest('[data-tick]'); if (d) { const n = notes().find((x) => x.id === d.dataset.tick); if (n) { n.done = !n.done; commit(n.done ? 'Note done' : 'Note reopened'); } }
    const x = e.target.closest('[data-del]'); if (x) { S.project.markers = S.project.markers.filter((m) => m.id !== x.dataset.del); commit('Delete note'); }
  });
  el.addEventListener('dblclick', (e) => {
    const it = e.target.closest('[data-edit]'); if (!it) return;
    const n = notes().find((x) => x.id === it.dataset.edit), v = prompt('Edit note', n.note);
    if (v !== null && v.trim()) { n.note = v.trim(); commit('Edit note'); }
  });
  on('change', draw);
  on('seek', () => setTimeout(drawAt));
}

function drawAt() { if (root) $('[data-nat]', root).textContent = `at ${fmtTC(S.playhead, S.project?.settings.fps || 30)}`; }
export function refreshNotes() { draw(); drawAt(); }
function draw() { return guarded(null, 'Notes', drawNow); }
function drawNow() {
  if (!root || !S.project) return;
  drawAt();
  const all = notes().sort((a, b) => a.t - b.t), list = all.filter((n) => showDone || !n.done), open = all.filter((n) => !n.done).length;
  $('[data-list]', root).innerHTML = list.map((n) => `<div class="nt-item${n.done ? ' done' : ''}">
      <button class="link mono" data-seek="${n.t}" title="Go there">${fmtTC(n.t, S.project.settings.fps).replace(/^00:/, '')}</button>
      <div class="grow" data-edit="${n.id}" title="Double-click to edit">${noteHTML(n.note)}<div class="muted small">${esc(n.by || 'You')}${n.client && n.version ? ` · Version ${n.version}` : ''}${n.render ? ` · on ${esc(n.render)}` : ''}</div></div>
      <button class="icon-btn small" data-tick="${n.id}" title="${n.done ? 'Mark as not done' : 'Done'}" aria-label="Done">${n.done ? ic('undo') : '✓'}</button>
      <button class="icon-btn small" data-del="${n.id}" title="Delete note" aria-label="Delete note">✕</button></div>`).join('')
    || `<div class="muted pad">${all.length ? 'All notes are done ✓' : 'No notes yet. Pause where something needs a change and write it here - it shows on the timeline ruler. Notes from a phone () land here too.'}</div>`;
  const tab = document.querySelector('[data-ptab="notes"]');
  if (tab) tab.innerHTML = open ? `${open}` : ic('note');
}

export function addNote(text) {
  const ta = root && $('[data-ntext]', root);
  const v = (text ?? ta?.value ?? '').trim();
  if (!v) { emit('notesTab'); setTimeout(() => ta?.focus(), 50); return; }
  (S.project.markers ||= []).push({ id: uid(), t: +S.playhead.toFixed(3), note: v, by: 'You', at: Date.now() });
  if (ta) ta.value = '';
  commit('Note');
  toast(`Note added at ${fmtTC(S.playhead, S.project.settings.fps)}`);
}

// notes typed on a phone wait on the server until the editor takes them onto the open timeline
export function watchPhoneNotes() {
  clearTimeout(phoneTimer);
  const tick = async () => {
    if (!S.proj) return;
    if (document.hidden) { phoneTimer = setTimeout(tick, 10000); return; } // (a tab in the background / a sleeping editor tab: when it is shown)
    try {
      const got = await api('GET', `/api/review/notes?p=${enc(S.proj)}&take=1`);
      if (got.length) {
        (S.project.markers ||= []).push(...got.map((n) => ({ ...n, id: n.id || uid() })));
        commit(`${got.length} note${got.length > 1 ? 's' : ''} from phone`);
        const ph = got.filter((n) => !n.client); // (a client's comments get their own toast - watchClientNews)
        if (ph.length) toast(`${ph.length} new note${ph.length > 1 ? 's' : ''} from ${[...new Set(ph.map((n) => n.by))].join(', ')} - see Notes`);
        if (got.length > ph.length) drawReviews();
      }
    } catch {}
    phoneTimer = setTimeout(tick, 10000);
  };
  tick();
  drawReviews(); watchClientNews();
}

// ---------------- 🕘 versions ----------------
const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(ms).toLocaleString(); };
// 👤 who changed the edit since the version before (from the activity log), and who saved a named version
const editedBy = (v) => {
  const by = v.by || [], names = by.length > 3 ? `${by.slice(0, 3).join(', ')} +${by.length - 3}` : by.join(', ');
  const parts = [names && `Edited by <b>${esc(names)}</b>`, v.savedBy && `saved by <b>${esc(v.savedBy)}</b>`].filter(Boolean);
  return parts.length ? `<br><span class="ver-by small">${parts.join(' · ')}</span>` : '';
};
export async function openVersions() {
  const dlg = modal('Versions', `<p class="muted">The editor keeps a backup every few minutes while you work (the last 40). Save a version with a name to keep it for good - e.g. "Sent to client", "Before music change".</p>
    <div class="row-in"><input data-vlabel placeholder="Name this version, e.g. Sent to client" aria-label="Version name"><button class="primary" data-vsave>Save version</button></div>
    <div class="ver-list" data-vlist><div class="muted pad">Loading…</div></div>`, { width: 660 });
  const draw = async () => {
    const list = await api('GET', `/api/versions?p=${enc(S.proj)}`);
    $('[data-vlist]', dlg.el).innerHTML = list.map((v) => `<div class="ver-row${v.named ? ' named' : ''}">
      <span class="grow">${v.named ? `<b>${esc(v.label)}</b> · ` : ''}${esc(ago(v.mtime))}<br><span class="muted small">${esc(v.seq)}${v.seqs > 1 ? ` (+${v.seqs - 1} more sequence${v.seqs > 2 ? 's' : ''})` : ''} · ${v.clips} clips · ${Math.floor(v.duration / 60)}:${String(Math.round(v.duration % 60)).padStart(2, '0')}</span>${editedBy(v)}</span>
      <button class="small" data-vseq="${esc(v.file)}" data-named="${v.named ? 1 : 0}" title="Add that version's timeline to this project as a separate sequence - nothing is replaced">+ As sequence</button>
      <button class="small" data-vrestore="${esc(v.file)}" data-named="${v.named ? 1 : 0}" title="The whole project goes back to this version (the current state is backed up first)">Restore</button>
      ${v.named ? `<button class="icon-btn small" data-vdel="${esc(v.file)}" title="Delete this saved version" aria-label="Delete version">${ic('trash')}</button>` : ''}</div>`).join('') || '<div class="muted pad">No versions yet - they appear a few minutes after you start editing.</div>';
  };
  draw().catch((e) => toast(e.message, 'err'));
  dlg.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset, nq = `&named=${d.named}`;
    try {
      if (d.vsave !== undefined) {
        await saveNow();
        const v = await api('POST', `/api/versions/save?p=${enc(S.proj)}`, { label: $('[data-vlabel]', dlg.el).value.trim() || 'Version' });
        $('[data-vlabel]', dlg.el).value = ''; toast(`Saved version "${v.label}"`); draw();
      }
      if (d.vrestore) {
        if (!confirm('Go back to this version? The whole project (all sequences) returns to how it was then. What you have now is backed up first, so you can come back to it from this list.')) return;
        await saveNow();
        await api('POST', `/api/versions/restore?p=${enc(S.proj)}&file=${enc(d.vrestore)}${nq}`);
        dlg.close(); emit('reloadProject'); toast('Restored that version');
      }
      if (d.vseq) {
        const pj = await api('GET', `/api/versions/file?p=${enc(S.proj)}&file=${enc(d.vseq)}${nq}`);
        const name = `${seqOf(pj).name} (${new Date(pj.modified || Date.now()).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})`;
        (S.project.sequences ||= {})[uid()] = { name, data: seqData(pj), modified: Date.now() };
        commit('Version as sequence'); emit('seq');
        dlg.close(); toast(`Added "${name}" as a sequence - open it from next to the project name`);
      }
      if (d.vdel) { if (!confirm('Delete this saved version?')) return; await api('POST', `/api/versions/delete?p=${enc(S.proj)}&file=${enc(d.vdel)}`); draw(); }
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---------------- 📱 phone review ----------------
let qrLib = null;
const loadQr = () => (qrLib ||= new Promise((ok, bad) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; s.onload = () => ok(window.QRCode); s.onerror = bad; document.head.append(s); }));
export async function openShare() {
  const dlg = modal('Watch on a phone', '<div data-sh></div>', { width: 560 });
  const draw = (info) => {
    $('[data-sh]', dlg.el).innerHTML = info.on ? `<p>Phone review is <b class="good">on</b>. On a phone <b>on the same Wi-Fi</b>, open:</p>
      ${info.urls.map((u, i) => `<div class="sh-url"><div class="sh-qr" data-qr="${i}"></div><div class="grow"><div class="mono">${esc(u)}</div><button class="small" data-copy="${esc(u)}">Copy link</button></div></div>`).join('') || '<p class="warn">This computer has no network address right now - connect it to the Wi-Fi.</p>'}
      <ul class="muted small"><li>The phone sees the finished renders (Export) of every project, and can add notes at any moment of a video - they appear on your timeline as notes.</li>
      <li>Only someone with this link can open it, and only on your own network. Nothing goes on the internet.</li>
      <li>If the phone cannot open it: when Windows asked about the firewall, it needed <b>Allow</b> for private networks.</li></ul>
      <div class="dv-actions"><button data-sh-off>Turn off</button><button class="primary" data-close>Done</button></div>`
      : `<p>Watch your finished videos on a phone (yours or a client's sitting next to you) over this Wi-Fi, and collect notes at exact moments - they land on the timeline.</p>
      <p class="muted small">When you turn it on, Windows may ask whether Node.js can use the network: choose <b>Allow</b> for private networks.</p>
      <div class="dv-actions"><button class="primary" data-sh-on>Turn on phone review</button><button data-close>Cancel</button></div>`;
    if (info.on) loadQr().then((Q) => info.urls.forEach((u, i) => { const box = $(`[data-qr="${i}"]`, dlg.el); if (box) new Q(box, { text: u, width: 120, height: 120, colorDark: '#000', colorLight: '#fff' }); })).catch(() => $$('.sh-qr', dlg.el).forEach((q) => q.remove()));
  };
  draw(await api('GET', '/api/share'));
  dlg.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.shOn !== undefined) { b.disabled = true; b.textContent = 'Turning on…'; draw(await api('POST', '/api/share', { on: true })); }
      if (b.dataset.shOff !== undefined) { draw(await api('POST', '/api/share', { on: false })); toast('Phone review is off'); }
      if (b.dataset.copy) { await navigator.clipboard.writeText(b.dataset.copy); toast('Link copied'); }
    } catch (err) { toast(err.message, 'err'); draw(await api('GET', '/api/share')); }
  });
}

// ---------------- 🔗 client review links (internet) ----------------
// Send for review: a secret link to one finished render that a client opens anywhere (no sign-in), comments on at
// moments and approves or asks for changes. A new render goes on the same link as the next version. Their comments come
// back as 💬 notes (above); the strip in 📝 Notes shows each link's versions: ⏳ waiting, ✏️ changes, ✅ approved.
// stored note / comment text keeps its old form ('✅ Approved…', '✏️ Changes requested…', '… ✏️' when drawn - written by
// the server and parsed below); on screen the marks are left out
const DEC_RE = /^(✅|✏\uFE0F?)\s*/u, DRAW_RE = /\s*✏\uFE0F?$/u;
const notePlain = (s) => String(s ?? '').replace(DEC_RE, '').replace(DRAW_RE, '');
const noteHTML = (s) => { const t = String(s ?? ''); return `${esc(notePlain(t))}${DRAW_RE.test(t) ? ' (drawing)' : ''}`; };
const STW = { waiting: 'Waiting', changes: 'Changes requested', approved: 'Approved' };
let crvLinks = [], crvDoor = true, newsTimer = null, newsSince = Date.now();
const crvGet = () => api('GET', `/api/clientreview?proj=${enc(S.proj)}`).then((r) => { crvLinks = r.links; crvDoor = r.door; reviewBadge(); return r; });
// 💬 the menu bar's Review button: how many client comments came since this project's reviews were last opened here
const seenKey = () => `ve-crv-seen:${S.proj}`;
function reviewBadge() {
  const b = document.getElementById('reviewBadge'); if (!b) return;
  let seen = 0; try { seen = +localStorage.getItem(seenKey()) || 0; } catch {}
  const n = crvLinks.reduce((k, l) => k + l.comments.filter((c) => !c.team && c.at > seen).length, 0);
  b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n);
}
// Review (menu bar): the project's review links and what the clients said - or straight to sending one when there is none
export async function openReviewHub() {
  if (!S.proj) return;
  try { await crvGet(); } catch (e) { return toast(e.message, 'err'); }
  try { localStorage.setItem(seenKey(), String(Date.now())); } catch {}
  reviewBadge();
  return crvLinks.length ? openReviews() : openSendReview();
}
const copyLink = (url) => navigator.clipboard.writeText(url).then(() => toast('Review link copied - send it to the client'), () => prompt('Copy this link', url));
const verChips = (l) => l.versions.map((v) => `<span class="crv-v ${v.status}" title="Version ${v.n}: ${STW[v.status]}${v.decidedBy ? ` by ${esc(v.decidedBy)}` : ''}">V${v.n}</span>`).join('');
async function drawReviews() {
  const box = root && $('[data-crv]', root);
  if (!box || !S.proj) return;
  try { await crvGet(); } catch { return; }
  const live = crvLinks.filter((l) => !l.expired);
  box.hidden = !live.length;
  box.innerHTML = live.slice(0, 4).map((l) => `<div class="crv-row"><span class="grow" title="${esc(l.title)}">${esc(l.client || l.title)}</span>${verChips(l)}
      <button class="icon-btn small" data-crcopy="${esc(l.url)}" title="Copy the client's link" aria-label="Copy link">${ic('copy')}</button></div>`).join('')
    + `<button class="link small" data-a="reviews">All client reviews${live.length > 4 ? ` (${live.length})` : ''} · comments · replies</button>`;
}
// what clients said (every project): a toast, and the strip when it is this project
function watchClientNews() {
  if (newsTimer) return;
  const tick = async () => {
    if (document.hidden) { newsTimer = setTimeout(tick, 15000); return; }
    try {
      const got = await api('GET', `/api/clientreview/news?since=${newsSince}`);
      if (got.length) {
        newsSince = Math.max(...got.map((x) => x.at));
        const last = got[got.length - 1], dec = got.find((x) => /^(✅|✏️ Changes)/.test(x.note));
        toast(dec ? `${dec.by}: ${notePlain(dec.note)}${dec.project !== S.proj ? ` - ${dec.project}` : ''}` : `${got.length > 1 ? `${got.length} comments` : 'A comment'} from ${last.by} on "${last.title}"${last.project !== S.proj ? ` (${last.project})` : ''}: ${notePlain(last.note)}`);
        if (got.some((x) => x.project === S.proj)) drawReviews();
      }
    } catch {}
    newsTimer = setTimeout(tick, 15000);
  };
  newsTimer = setTimeout(tick, 15000);
}

export async function openSendReview(render) {
  const [list] = await Promise.all([api('GET', `/api/renders?p=${enc(S.proj)}`), crvGet()]).catch((e) => { toast(e.message, 'err'); return [null]; });
  if (!list) return;
  const vids = list.filter((r) => /\.(mp4|m4v|webm)$/i.test(r.name));
  if (!vids.length) return toast('Render the video first (Export) - then send it for review', 'err');
  const live = crvLinks.filter((l) => !l.off);
  const dlg = modal('Send for review', `<p class="muted">The client gets a link to this one video - they watch it anywhere (phone or computer, no sign-in), comment at moments and press <b>Approve</b> or <b>Request changes</b>. Their comments land here as notes.</p>
    ${crvDoor ? '' : '<p class="warn small">Team editing is off, so the link only opens on this computer. Turn on Team (with the office domain) so clients can open it from outside.</p>'}
    <label class="fld"><span>Video</span><select data-cr-render>${vids.map((r) => `<option${r.name === render ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
    ${live.length ? `<label class="fld"><span>Send as</span><select data-cr-link><option value="">A new link</option>${live.map((l) => `<option value="${esc(l.id)}">Version ${l.versions.length + 1} on "${esc(l.client || l.title)}" (the same link)</option>`).join('')}</select></label>` : ''}
    <div data-cr-new><label class="fld"><span>Client name</span><input data-cr-client placeholder="Optional, e.g. MY Bharat team" maxlength="60"></label>
    <label class="fld"><span>Password</span><input data-cr-pw type="text" autocomplete="off" placeholder="Optional - the client types it once"></label>
    <label class="fld"><span>Link works for</span><select data-cr-days><option value="0">Until you turn it off</option><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label></div>
    <div data-cr-done></div>
    <div class="dv-actions"><button data-close>Cancel</button><button class="primary" data-cr-make>Make link</button></div>`, { width: 560 });
  const linkSel = $('[data-cr-link]', dlg.el);
  if (linkSel) linkSel.onchange = () => { $('[data-cr-new]', dlg.el).hidden = !!linkSel.value; };
  $('[data-cr-make]', dlg.el).onclick = async (e) => {
    const b = e.target; b.disabled = true;
    try {
      const l = await api('POST', `/api/clientreview?proj=${enc(S.proj)}`, linkSel?.value ? { render: $('[data-cr-render]', dlg.el).value, link: linkSel.value }
        : { render: $('[data-cr-render]', dlg.el).value, client: $('[data-cr-client]', dlg.el).value.trim(), password: $('[data-cr-pw]', dlg.el).value, days: +$('[data-cr-days]', dlg.el).value });
      const v = l.versions[l.versions.length - 1];
      $('[data-cr-done]', dlg.el).innerHTML = `<div class="sh-url"><div class="grow"><b>${v.n > 1 ? `Version ${v.n} is on the link` : 'Link ready'} ✓</b><div class="mono small crv-url">${esc(l.url)}</div></div><button class="primary small" data-crcopy2>Copy link</button></div>`;
      $('[data-crcopy2]', dlg.el).onclick = () => copyLink(l.url);
      b.hidden = true; $('.dv-actions [data-close]', dlg.el).textContent = 'Done';
      copyLink(l.url); drawReviews();
    } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  };
}

export async function openReviews() {
  const dlg = modal('Client reviews', `<div class="nt-row crv-top"><span class="grow muted small">Each link shows the client one video - they comment at moments and approve. Click a time to jump there on the timeline.</span>
    <button class="primary small" data-crsend>Send a render for review…</button></div><div data-crl><div class="muted pad">Loading…</div></div>`, { width: 720 });
  $('[data-crsend]', dlg.el).onclick = () => { dlg.el.close?.(); openSendReview(); };
  const fps = S.project?.settings.fps || 30;
  const draw = async () => {
    await crvGet();
    $('[data-crl]', dlg.el).innerHTML = crvLinks.map((l) => {
      const tops = l.comments.filter((c) => !c.parent).sort((a, b) => b.v - a.v || a.t - b.t);
      return `<div class="crv-card${l.expired ? ' off' : ''}">
        <div class="nt-row"><b class="grow">${esc(l.client || l.title)}</b>${verChips(l)}</div>
        <div class="muted small">${esc(l.title)} · made ${new Date(l.created).toLocaleDateString()}${l.by ? ` by ${esc(l.by)}` : ''}${l.hasPw ? ' · password' : ''}${l.off ? ' · turned off' : l.expired ? ' · expired' : l.expires ? ` · works until ${new Date(l.expires).toLocaleDateString()}` : ''}</div>
        <div class="nt-row"><span class="mono small grow crv-url">${esc(l.url)}</span><button class="small" data-crcopy="${esc(l.url)}">Copy link</button>
          <button class="small" data-croff="${esc(l.id)}" data-v="${l.off ? 0 : 1}">${l.off ? 'Turn on' : 'Turn off'}</button><button class="icon-btn small" data-crdel="${esc(l.id)}" title="Delete this link and its comments" aria-label="Delete link">${ic('trash')}</button></div>
        ${tops.map((c) => `<div class="nt-item"><button class="link mono" data-seek="${+c.t || 0}" title="Go there on the timeline">${fmtTC(c.t, fps).replace(/^00:/, '')}</button>
          <div class="grow">${noteHTML(c.text)}${c.draw ? ' (drawing)' : ''}<div class="muted small">${esc(c.by)} · Version ${c.v} · ${new Date(c.at).toLocaleString()}</div>
          ${l.comments.filter((r) => r.parent === c.id).map((r) => `<div class="crv-reply">${esc(r.text)} <span class="muted small">${esc(r.by)}${r.team ? ' (team)' : ''}</span></div>`).join('')}
          <div class="row-in"><input data-crr="${esc(c.id)}" data-link="${esc(l.id)}" placeholder="Reply to the client… (Enter)" aria-label="Reply"></div></div></div>`).join('') || '<div class="muted small pad">No comments yet.</div>'}
      </div>`;
    }).join('') || '<div class="muted pad">No review links yet. Use Review (or Send for review on a finished render in Export).</div>';
  };
  draw().catch((e) => toast(e.message, 'err'));
  const edit = (body) => api('POST', `/api/clientreview/edit?proj=${enc(S.proj)}`, body).then(() => { draw(); drawReviews(); }).catch((e) => toast(e.message, 'err'));
  dlg.el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-crcopy],[data-croff],[data-crdel],[data-seek]'); if (!t) return;
    if (t.dataset.crcopy) copyLink(t.dataset.crcopy);
    if (t.dataset.croff) edit({ link: t.dataset.croff, off: t.dataset.v === '1' });
    if (t.dataset.crdel && confirm('Delete this review link? The client can no longer open it, and its comments here go too (the notes on the timeline stay).')) edit({ link: t.dataset.crdel, remove: true });
    if (t.dataset.seek) emit('seek', +t.dataset.seek);
  });
  dlg.el.addEventListener('keydown', async (e) => {
    const i = e.target.closest('[data-crr]'); if (!i || e.key !== 'Enter' || !i.value.trim()) return;
    try { await api('POST', `/api/clientreview/reply?proj=${enc(S.proj)}`, { link: i.dataset.link, parent: i.dataset.crr, text: i.value.trim() }); toast('Reply sent - the client sees it on the review page'); draw(); }
    catch (err) { toast(err.message, 'err'); }
  });
}
