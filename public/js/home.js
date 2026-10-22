// Home: every project (one folder each), and the New Project dialog.
import { S } from './store.js';
import { api, enc } from './api.js';
import { fmt } from './model.js';
import { $, $$, h, esc, toast, modal } from './ui.js';
import { pickFolder } from './mediapool.js';
import { icon } from './ui2.js';

const NAS = 'Z:\\', DEFAULT_PLACE = 'Z:\\Editor Projects'; // 💾 new projects are saved on the NAS
const FOLDER_SVG = '<svg class="pf-ic" viewBox="0 0 48 40" aria-hidden="true"><path class="pf-back" d="M4 6a3 3 0 0 1 3-3h11l4 4h19a3 3 0 0 1 3 3v24a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/><path class="pf-front" d="M4 14a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/></svg>';
import { openTeam } from './team.js';
import { openSessions } from './sessionsui.js';

export async function renderHome(el, openProject) {
  el.innerHTML = `<div class="home">
    <div class="home-brand" aria-label="Limelight Editor"><img src="/img/limelight-mark-dark.png" alt=""><div class="hb-word"><b>LIME<em>LIGHT</em></b><span><i></i>EDITOR<i></i></span></div></div>
    <div class="home-head">
      <div><h1>Projects</h1><p class="muted">Each project is saved in its own folder with its timeline, previews, subtitles and renders.<br><span class="mono" id="projRoot"></span></p></div>
      <div class="home-actions"><button class="small" data-a="team" hidden title="Admin: people who can sign in from other computers - names, passwords, roles (Owner / Editor / Viewer), shared folders, render farm">Team &amp; users</button><button class="small" data-a="sessions" hidden title="Who worked in the editor, when and for how long - the last 30 days">Sessions</button><button class="link small" data-a="deleted" hidden>Recycle Bin</button><button class="small home-refresh" data-a="refresh" title="Refresh: load the editor again (newest version) - always here">Refresh</button><button class="primary big" data-a="new">+ New project</button></div>
    </div>
    <div class="pf-bar" id="pfBar"></div>
    <div class="proj-grid" id="projGrid"><div class="muted">Loading…</div></div>
  </div>`;
  el.onclick = async (e) => {
    if (e.target.closest('[data-a="refresh"]')) return location.reload(); // (🔄 always on Home - also when the projects could not load)
    if (e.target.closest('[data-a="signin"]')) { location.href = '/team/logout'; return; } // (back to the sign-in page)
    if (e.target.closest('[data-a="new"]')) return newProjectDialog(openProject);
    if (e.target.closest('[data-a="deleted"]')) return deletedDialog(() => renderHome(el, openProject));
    if (e.target.closest('[data-a="team"]')) return openTeam(); // 👥 admin: users, passwords, roles
    if (e.target.closest('[data-a="sessions"]')) return openSessions(); // 📊 who worked how long
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); return deleteProject(del.dataset.del, () => renderHome(el, openProject)); }
    const mv = e.target.closest('[data-move]');
    if (mv) { e.stopPropagation(); return moveMenu(mv, mv.dataset.move, () => renderHome(el, openProject)); }
    const card = e.target.closest('[data-open]');
    if (e.target.closest('[data-folder]')) { e.stopPropagation(); const r = await api('POST', `/api/open-folder?p=${enc(e.target.closest('[data-folder]').dataset.folder)}`); toast(r.folder); return; }
    if (card) openProject(card.dataset.open);
  };
  try {
    const [list0, health, me, pf0] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/health'), api('GET', '/api/me').catch(() => ({})), api('GET', '/api/project-folders').catch(() => null)]);
    pf = pf0 || { folders: [], map: {}, old: true };
    // 📁 the folder chosen above the grid (remembered in this browser)
    let cur = 'all'; try { cur = localStorage.getItem('ve-home-folder') || 'all'; } catch {}
    if (cur !== 'all' && cur !== 'none' && !pf.folders.some((f) => f.id === cur)) cur = 'all';
    const inF = (p) => pf.map[p.name] || null, list = list0.filter((p) => cur === 'all' || (cur === 'none' ? !inF(p) : inF(p) === cur));
    renderBar(el, list0, cur, () => renderHome(el, openProject));
    // deleting / bringing back projects: the owner, on this computer
    const owner = me.role === 'owner';
    for (const a of ['team', 'sessions']) { const tb = $(`[data-a="${a}"]`, el); if (tb) tb.hidden = !owner; } // (the team's admin: owners only)
    S.health = health;
    $('#projRoot', el).textContent = health.projectsFolder;
    const grid = $('#projGrid', el);
    grid.innerHTML = `<button class="proj new" data-a="new"><span>+</span><b>New project</b><small>Save it in any folder - Z:, D: or a shared PC</small></button>` +
      list.map((p) => `<div class="proj" data-open="${esc(p.name)}" draggable="true" tabindex="0" role="button" aria-label="Open ${esc(p.name)}">
        <div class="proj-th" style="${p.thumb ? `background-image:url('${p.thumb}')` : ''}"><span class="badge">${esc(p.aspect || '')}</span></div>
        <div class="proj-info"><b>${esc(p.name)}</b>${inF(p) && cur === 'all' ? `<small class="pf-tag">${esc(pf.folders.find((f) => f.id === inF(p))?.name || '')}</small>` : ''}<small>${p.duration ? `${fmt(p.duration)} · ` : ''}${p.clips} clips · ${p.media} media</small>${p.place ? `<small class="mono" title="Saved in ${esc(p.place)}">${esc(p.place)}</small>` : ''}
        <small>${new Date(p.modified).toLocaleString()}</small></div>
        <div class="proj-btns"><button class="icon-btn" data-move="${esc(p.name)}" title="Move to a folder (or drag the card onto a folder above)" aria-label="Move ${esc(p.name)} to a folder">${icon('folderMove')}</button><button class="icon-btn" data-folder="${esc(p.name)}" title="Open project folder" aria-label="Open folder of ${esc(p.name)}">${icon('folder')}</button>${owner ? `<button class="icon-btn proj-del" data-del="${esc(p.name)}" title="Delete project (to the Recycle Bin, or for good)" aria-label="Delete ${esc(p.name)}">${icon('trash')}</button>` : ''}</div></div>`).join('');
    if (owner) api('GET', '/api/projects/deleted').then((d) => { const b = $('[data-a="deleted"]', el); if (b) { b.hidden = false; b.textContent = `Recycle Bin${d.length ? ` (${d.length})` : ''}`; } }).catch(() => {});
    $$('.proj[data-open]', grid).forEach((c) => {
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter') openProject(c.dataset.open); });
      c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/ve-project', c.dataset.open); e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('pf-dragging'); });
      c.addEventListener('dragend', () => document.body.classList.remove('pf-dragging'));
    });
    if (cur !== 'all' && !list.length) grid.insertAdjacentHTML('beforeend', '<div class="muted pf-empty">No projects in this folder yet - drag a project card onto the folder above, or use on a card.</div>');
  } catch (e) {
    // signed out (the session ended): straight to the sign-in page from here, instead of a dead end
    const out = /sign in/i.test(e.message);
    $('#projGrid', el).innerHTML = `<div class="err">Could not load projects: ${esc(e.message)}</div><p>${out ? '<button class="primary" data-a="signin">Sign in</button> ' : ''}<button data-a="refresh">Refresh</button></p>`;
  }
}

// ---------------- 📁 folders on Home ----------------
let pf = { folders: [], map: {} };
async function savePF(next, refresh) {
  if (pf.old) return toast('Restart the editor once to use folders (Start Video Editor)', 'err');
  try { pf = await api('POST', '/api/project-folders', { folders: next.folders, map: next.map }); refresh(); } catch (e) { toast(e.message, 'err'); }
}
const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
function renderBar(el, list, cur, refresh) {
  const bar = $('#pfBar', el), count = (id) => list.filter((p) => (id === 'none' ? !pf.map[p.name] : pf.map[p.name] === id)).length;
  // big folder tiles (a folder picture, its name, how many projects); drop a project card on one to move it there
  const chip = (id, label, n, kind = 'folder', extra = '') => `<button class="pf-chip pf-${kind}${cur === id ? ' on' : ''}" data-pf="${id}"${id !== 'all' ? ' data-drop' : ''} title="${label}">${FOLDER_SVG}<b>${label}</b><i>${n} project${n === 1 ? '' : 's'}</i>${extra}</button>`;
  bar.innerHTML = chip('all', 'All projects', list.length, 'all') + pf.folders.map((f) => chip(f.id, esc(f.name), count(f.id), 'folder', `<span class="pf-x" data-pfedit="${f.id}" title="Rename / delete">⋯</span>`)).join('')
    + (pf.folders.length ? chip('none', 'Not in a folder', count('none'), 'none') : '') + '<button class="pf-chip add" data-pfnew><span class="pf-plus">+</span><b>New folder</b></button>';
  const pick = (id) => { try { localStorage.setItem('ve-home-folder', id); } catch {} refresh(); };
  bar.onclick = (e) => {
    const ed = e.target.closest('[data-pfedit]');
    if (ed) { e.stopPropagation(); return folderMenu(ed, ed.dataset.pfedit, refresh); }
    if (e.target.closest('[data-pfnew]')) { const name = prompt('New folder name (e.g. Client, 2026, Reels)')?.trim(); if (!name) return; const id = newId(); return savePF({ folders: [...pf.folders, { id, name }], map: pf.map }, () => pick(id)); }
    const c = e.target.closest('[data-pf]'); if (c) pick(c.dataset.pf);
  };
  // drop a project card on a folder (or on "Not in a folder")
  for (const c of $$('[data-drop]', bar)) {
    c.ondragover = (e) => { if (e.dataTransfer.types.includes('text/ve-project')) { e.preventDefault(); c.classList.add('drop'); } };
    c.ondragleave = () => c.classList.remove('drop');
    c.ondrop = (e) => { e.preventDefault(); c.classList.remove('drop'); const p = e.dataTransfer.getData('text/ve-project'); if (p) moveTo(p, c.dataset.pf === 'none' ? null : c.dataset.pf, refresh); };
  }
}
function moveTo(project, id, refresh) {
  const map = { ...pf.map }; if (id) map[project] = id; else delete map[project];
  savePF({ folders: pf.folders, map }, refresh);
  toast(id ? `"${project}" → ${pf.folders.find((f) => f.id === id)?.name}` : `"${project}" taken out of its folder`);
}
function popMenu(anchor, items, fn) {
  document.querySelector('.ui-menu')?.remove();
  const m = document.createElement('div'); m.className = 'ui-menu';
  m.innerHTML = items.map(([k, l]) => (k === '-' ? '<hr>' : `<button data-k="${esc(k)}">${l}</button>`)).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${Math.min(innerHeight - m.offsetHeight - 8, r.bottom + 4)}px`; m.style.left = `${Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.left))}px`;
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
  m.onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; m.remove(); document.removeEventListener('pointerdown', close, true); fn(b.dataset.k); };
}
function moveMenu(anchor, project, refresh) {
  const now = pf.map[project];
  popMenu(anchor, [...pf.folders.map((f) => [f.id, `${f.id === now ? '● ' : '📁 '}${esc(f.name)}`]), ['-'], ['__new', '＋ New folder…'], ...(now ? [['__out', 'Take out of the folder']] : [])], (k) => {
    if (k === '__out') return moveTo(project, null, refresh);
    if (k === '__new') { const name = prompt('New folder name')?.trim(); if (!name) return; const id = newId(); return savePF({ folders: [...pf.folders, { id, name }], map: { ...pf.map, [project]: id } }, refresh); }
    moveTo(project, k, refresh);
  });
}
function folderMenu(anchor, id, refresh) {
  const f = pf.folders.find((x) => x.id === id); if (!f) return;
  popMenu(anchor, [['rename', 'Rename'], ['delete', 'Delete folder (projects stay)']], (k) => {
    if (k === 'rename') { const name = prompt('Folder name', f.name)?.trim(); if (name) savePF({ folders: pf.folders.map((x) => (x.id === id ? { ...x, name } : x)), map: pf.map }, refresh); }
    if (k === 'delete' && confirm(`Delete the folder "${f.name}"? Its projects are not deleted - they go back to All projects.`)) {
      const map = Object.fromEntries(Object.entries(pf.map).filter(([, v]) => v !== id));
      try { localStorage.setItem('ve-home-folder', 'all'); } catch {}
      savePF({ folders: pf.folders.filter((x) => x.id !== id), map }, refresh);
    }
  });
}

// 👤 the signed-in person's folder in Z:\Editor Projects: the one named like them ("Vishal", or "Venky Visuals" for venky).
// On the editor computer itself (no sign-in) it is the owner's. The folder is made when it is not there yet.
async function myFolder() {
  try {
    const me = await api('GET', '/api/me');
    if (me.home) return me.home;
    const name = String(me.local ? me.owner || '' : me.name || '').trim();
    if (!name || name === 'Owner') return DEFAULT_PLACE;
    const r = await api('GET', `/api/fs?path=${enc(DEFAULT_PLACE)}`), n = name.toLowerCase();
    const hit = r.dirs.find((x) => x.name.toLowerCase() === n) || r.dirs.find((x) => x.name.toLowerCase().startsWith(`${n} `));
    return hit ? hit.path : `${DEFAULT_PLACE}\\${name[0].toUpperCase()}${name.slice(1)}`;
  } catch { return DEFAULT_PLACE; }
}

// 📂 File > Open: a Premiere Pro / Resolve XML (Final Cut Pro 7 XML) becomes a new project with the same cut, saved in
// your own folder; the footage is used where the XML points (the NAS). Resolves with the new project's name.
export function openXmlFile() {
  return new Promise((done) => {
    const inp = h('<input type="file" accept=".xml,text/xml" hidden>');
    document.body.append(inp);
    inp.onchange = async () => {
      const f = inp.files[0]; inp.remove();
      if (!f) return done(null);
      toast(`Opening ${f.name}…`);
      try {
        const r = await api('POST', '/api/projects/open-xml', { xml: await f.text(), place: await myFolder() });
        toast(`${r.name}: ${r.clips} clips from the XML${r.missingCount ? ` - ${r.missingCount} file${r.missingCount > 1 ? 's' : ''} not found (they are left out)` : ''}`, r.missingCount ? 'err' : '');
        if (r.notes?.length) setTimeout(() => toast(r.notes.join(' '), ''), 4000);
        done(r.name);
      } catch (e) { toast(e.message, 'err'); done(null); }
    };
    inp.click();
  });
}

export function newProjectDialog(openProject) {
  const d = new Date();
  const def = `Project ${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  // 📍 where it is saved: the signed-in person's own folder on the NAS (Z:\Editor Projects\Vishal, ...\Venky Visuals),
  // else Z:\Editor Projects; Browse picks any other folder on the NAS
  let place = DEFAULT_PLACE, home = DEFAULT_PLACE, touched = false;
  const body = h(`<form class="np" autocomplete="off">
    <label class="fld wide"><span>Project name</span><input name="name" value="${esc(def)}" required></label>
    <div class="fld wide"><span>Format</span><div class="fmt-cards">
      ${[['16:9', 'YouTube / Film', 64, 36], ['9:16', 'Reel / Shorts', 27, 48], ['1:1', 'Square post', 42, 42], ['4:5', 'Feed post', 38, 48]].map(([v, l, w, hh], i) =>
        `<label class="fmt"><input type="radio" name="aspect" value="${v}"${i === 0 ? ' checked' : ''}><span><i style="width:${w}px;height:${hh}px"></i><b>${v}</b><small>${l}</small></span></label>`).join('')}
    </div></div>
    <label class="fld"><span>Start from a template</span><select name="template"><option value="">Blank project</option></select></label>
    <label class="fld"><span>Frame rate</span><select name="fps"><option>24</option><option>25</option><option selected>30</option><option>50</option><option>60</option></select></label>
    <div class="fld wide"><span>Save project in</span>
      <div class="row-in"><input name="place" readonly><button type="button" data-browse>Browse…</button><button type="button" data-def title="Back to your own folder">My folder</button></div>
      <small>A folder on the NAS (Z:\\) - your own folder unless you pick another. The project gets its own folder inside it. Add footage once it opens (+ Folder).</small></div>
    <div class="np-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Create project</button></div>
  </form>`);
  const dlg = modal('New project', body, { width: 620 });
  api('GET', '/api/library').then((l) => { body.template.insertAdjacentHTML('beforeend', (l.templates || []).map((t) => `<option value="${esc(t.name)}">${esc(t.name)}${t.aspect ? ` (${esc(t.aspect)})` : ''}</option>`).join('')); }).catch(() => {});
  const showPlace = () => { body.place.value = place; };
  showPlace();
  myFolder().then((f) => { home = f; if (!touched) { place = f; showPlace(); } });
  $('[data-browse]', body).onclick = async () => { const f = await pickFolder('Save project in', '', { only: NAS, start: place }); if (f) { place = f; touched = true; showPlace(); } };
  $('[data-def]', body).onclick = () => { place = home; touched = true; showPlace(); };
  body.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('[type=submit]', body); btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const r = await api('POST', '/api/projects', { name: body.name.value.trim(), aspect: body.aspect.value, fps: +body.fps.value, place, template: body.template.value });
      dlg.close();
      // (an editor not restarted since this option came saves in Projects - say so instead of quietly ignoring the folder)
      if (place && !String(r.folder || '').toLowerCase().startsWith(place.toLowerCase())) toast(`Saved in ${r.folder || 'Projects'} - saving in another folder works after the editor is restarted`, 'err');
      toast(r.imported ? `Project created - ${r.imported} clips imported, previews are being prepared` : 'Project created');
      openProject(r.name);
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'Create project'; }
  };
  setTimeout(() => body.name.select(), 50);
}

const size = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1048576))} MB`);

// 🗑 delete: the folder moves to the Recycle Bin (restorable), or - ticked - is deleted for good. The footage is never touched.
async function deleteProject(name, refresh) {
  const choice = await new Promise((done) => {
    const dlg = modal('Delete project', `<p>Delete <b>${esc(name)}</b>?</p>
      <p class="muted small" data-note>The project folder (timeline, previews, subtitles, renders) moves to the <b>Recycle Bin</b> - you can restore it from the Projects page. Your original footage is not touched.</p>
      <label class="row-in del-perm"><input type="checkbox" data-perm> <span>Delete permanently - skip the Recycle Bin <b class="err">(cannot be undone)</b></span></label>
      <label class="row-in"><span>Type the project name to confirm</span></label><input data-confirm placeholder="${esc(name)}" autocomplete="off">
      <div class="dv-actions"><button data-close>Cancel</button><button class="danger" data-go disabled>Move to Recycle Bin</button></div>`, { width: 480, onClose: () => done(null) });
    const inp = $('[data-confirm]', dlg.el), go = $('[data-go]', dlg.el), perm = $('[data-perm]', dlg.el), note = $('[data-note]', dlg.el);
    inp.oninput = () => { go.disabled = inp.value.trim() !== name; };
    perm.onchange = () => {
      go.textContent = perm.checked ? 'Delete forever' : 'Move to Recycle Bin';
      note.innerHTML = perm.checked ? 'The project folder - timeline, previews, subtitles, renders, and files the editor made inside it (voice-overs, packed media) - is <b>deleted for good</b>. Your original footage outside the project is not touched.'
        : 'The project folder (timeline, previews, subtitles, renders) moves to the <b>Recycle Bin</b> - you can restore it from the Projects page. Your original footage is not touched.';
    };
    go.onclick = () => { done({ permanent: perm.checked }); dlg.close(); }; // (resolve first: closing calls onClose, which says no)
    setTimeout(() => inp.focus(), 50);
  });
  if (!choice) return;
  try {
    const r = await api('POST', `/api/projects/delete?p=${enc(name)}${choice.permanent ? '&permanent=1' : ''}`);
    toast(r.permanent ? `"${name}" deleted for good (${size(r.freed)} freed)` : `"${name}" moved to the Recycle Bin`);
    refresh();
  } catch (e) { toast(e.message, 'err'); }
}

// the Recycle Bin: restore a project, delete one for good, or empty it
async function deletedDialog(refresh) {
  let list = [];
  try { list = await api('GET', '/api/projects/deleted'); } catch (e) { return toast(e.message, 'err'); }
  const dlg = modal('Recycle Bin', '<div data-bin></div>', { width: 600 });
  const box = $('[data-bin]', dlg.el);
  const draw = () => {
    const total = list.reduce((n, x) => n + (x.bytes || 0), 0);
    box.innerHTML = `<p class="muted small">Deleted projects wait here. <b>Restore</b> puts one back on the Projects page; <b>Delete forever</b> frees its disk space for good. Your original footage is never touched.</p>
      <div class="dv-list">${list.map((x) => `<div class="dv-item"><span class="grow"><b>${esc(x.name)}</b><br><span class="muted small">deleted ${new Date(x.deleted).toLocaleString()} · ${size(x.bytes || 0)}</span></span>
        <button class="small" data-restore="${esc(x.folder)}">↺ Restore</button><button class="small danger" data-purge="${esc(x.folder)}" data-name="${esc(x.name)}">Delete forever</button></div>`).join('') || '<div class="muted pad">The Recycle Bin is empty.</div>'}</div>
      <div class="dv-actions">${list.length ? `<button class="danger" data-empty>Empty Recycle Bin (${list.length} · ${size(total)})</button>` : ''}<span class="grow"></span><button data-close>Close</button></div>`;
  };
  draw();
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.restore) {
        b.disabled = true;
        const r = await api('POST', `/api/projects/restore?folder=${enc(b.dataset.restore)}`); toast(`↺ Restored as "${r.name}"`);
        list = list.filter((x) => x.folder !== b.dataset.restore); draw(); refresh();
      } else if (b.dataset.purge) {
        if (!confirm(`Delete "${b.dataset.name}" for good?

This cannot be undone. Your original footage is not touched.`)) return;
        b.disabled = true;
        const r = await api('POST', `/api/projects/purge?folder=${enc(b.dataset.purge)}`); toast(`Deleted for good (${size(r.freed)} freed)`);
        list = list.filter((x) => x.folder !== b.dataset.purge); draw(); refresh();
      } else if (b.dataset.empty !== undefined) {
        if (!confirm(`Delete all ${list.length} project${list.length > 1 ? 's' : ''} in the Recycle Bin for good?

This cannot be undone. Your original footage is not touched.`)) return;
        b.disabled = true;
        const r = await api('POST', '/api/projects/empty-bin'); toast(`Recycle Bin emptied (${size(r.freed)} freed)`);
        list = []; draw(); refresh();
      }
    } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  });
}
