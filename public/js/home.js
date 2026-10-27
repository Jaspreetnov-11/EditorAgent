// Home: every project (one folder each), and the New project dialog.
// The page: the big logo and the folders down the left, Home / Folders / Shared and a big search along the top with
// Dashboard / Team / Recycle Bin on the right, the projects as a board or a list, and the project clicked shown at the
// right (double-click, Enter or Open project opens it).
import { ic } from './lineicons.js';
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
import { tagChips, tagColor, editTags } from './tags.js';
import { mountHomeStart } from './starthere.js';

// 🏷 search box + tag chips (kept while Home is open); a tag just changed here is shown at once (the list from the server
// catches up a moment later)
let homeQ = '', homeTag = '';
// the project picked (shown at the right), the board or the list, and the order - the view and order remembered in this browser
let homeSel = '';
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
const tagNow = new Map(); // project -> { tags, at }
const tagsOf = (p) => { const x = tagNow.get(p.name); return x && Date.now() - x.at < 60000 ? x.tags : p.tags || []; };
let homeList = []; // (every project from the server, for the tags dialog's suggestions)
const RECENT = 24; // Home: the last projects edited

// "2 hr ago", "Yesterday", "3 days ago", then the date
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 172800) return 'Yesterday';
  if (s < 604800) return `${Math.floor(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
const BOARD_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>';
const LIST_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="2" y="3" width="3" height="2" rx=".5"/><rect x="2" y="7" width="3" height="2" rx=".5"/><rect x="2" y="11" width="3" height="2" rx=".5"/><path d="M7.5 4h6.5M7.5 8h6.5M7.5 12h6.5"/></svg>';
const bg = (p) => (p.thumb ? `background-image:url('${p.thumb}')` : '');

export async function renderHome(el, openProject) {
  el.innerHTML = `<div class="hm">
    <aside class="hm-side">
      <div class="hm-brand home-brand" aria-label="limelight - Elevate &amp; Illuminate"><img class="hb-logo" src="/img/limelight-logo-white.png" alt="limelight - Elevate &amp; Illuminate"></div>
      <button class="primary hm-new" data-a="new">+ New project</button>
      <nav class="hm-nav" id="hmNav" aria-label="Folders"></nav>
    </aside>
    <div class="hm-main">
      <header class="hm-top home-head">
        <nav class="hm-tabs" id="hmTabs"><button data-pf="recent">Home</button><button data-pf="folders">Folders</button><button data-pf="shared">Shared</button></nav>
        <div class="hm-acts home-actions"><button class="small" data-a="dash" hidden title="Dashboard: every PC of the editor right now - CPU, RAM, GPU, video memory, heat, power, storage">${ic('chart')} Dashboard</button><button class="small" data-a="team" hidden title="Admin: people who can sign in from other computers - names, passwords, roles (Owner / Editor / Viewer), shared folders, render farm">${ic('team')} Team</button><button class="small" data-a="sessions" hidden title="Who worked in the editor, when and for how long - the last 30 days">${ic('clock')} Sessions</button><button class="small" data-a="deleted" hidden title="Recycle Bin: deleted projects - restore or delete for good">${icon('trash')} Bin</button><button class="small icon-only home-refresh" data-a="refresh" title="Refresh: load the editor again (newest version) - always here" aria-label="Refresh">${icon('refresh')}</button><span class="home-me" id="homeMe" hidden></span></div>
      </header>
      <div class="hm-find"><label class="hm-search">${ic('search')}<input type="search" id="homeQ" placeholder="Search projects, folders or #tag" aria-label="Search projects" autocomplete="off"><kbd>Ctrl K</kbd></label></div>
      <div class="hm-bar">
        <div class="hm-title"><h2 id="homeCrumb">Projects</h2><span class="hm-count" id="hmCount"></span><span id="projRoot" hidden></span></div>
        <div class="chips hm-tags" id="homeTags"></div>
        <div class="hm-tools" id="hmTools"><select id="hmSort" aria-label="Order"><option value="edited">Last edited</option><option value="name">Name</option><option value="length">Length</option></select>
          <div class="hm-seg" role="group" aria-label="View"><button data-hview="board" title="Board: thumbnails" aria-label="Board">${BOARD_SVG}</button><button data-hview="list" title="List: one row each" aria-label="List">${LIST_SVG}</button></div></div>
      </div>
      <div class="hm-body"><div class="hm-content" id="projGrid"><div class="muted">Loading…</div></div><aside class="hm-detail" id="hmDetail" hidden></aside></div>
    </div>
  </div>`;
  let newOpen = openProject; // (inside a folder: the new project goes in it - set once the folders are loaded)
  let draw = () => {}, pick = () => {};
  el.onclick = async (e) => {
    if (e.target.closest('[data-a="refresh"]')) return location.reload(); // (🔄 always on Home - also when the projects could not load)
    if (e.target.closest('[data-a="signin"]')) { location.href = '/team/logout'; return; } // (back to the sign-in page)
    if (e.target.closest('[data-a="new"]')) return newProjectDialog(newOpen);
    if (e.target.closest('[data-a="deleted"]')) return deletedDialog(() => renderHome(el, openProject));
    if (e.target.closest('[data-a="team"]')) return openTeam(); // 👥 admin: users, passwords, roles
    if (e.target.closest('[data-a="sessions"]')) return openSessions(); // 📊 who worked how long
    if (e.target.closest('[data-a="dash"]')) return import('./safety.js').then((x) => x.openSafety('perf')); // 📊 the Dashboard (everyone)
    const me = e.target.closest('[data-a="me"]');
    if (me) return popMenu(me, [['who', `<span class="muted">Signed in as</span> <b>${esc(me.dataset.name)}</b> · ${esc(me.dataset.role)}`], ['-'], ['out', 'Logout']], (k) => { if (k === 'out') location.href = '/team/logout'; });
    const ed = e.target.closest('[data-pfedit]');
    if (ed) { e.stopPropagation(); return folderMenu(ed, ed.dataset.pfedit, () => renderHome(el, openProject)); }
    if (e.target.closest('[data-pfnew]')) { const name = prompt('New folder name (e.g. Client, 2026, Reels)')?.trim(); if (!name) return; const id = newId(); return savePF({ folders: [...pf.folders, { id, name }], map: pf.map }, () => { store('ve-home-at', id); renderHome(el, openProject); }); }
    const f = e.target.closest('[data-pf]');
    if (f) { homeQ = ''; homeTag = ''; homeSel = ''; store('ve-home-at', f.dataset.pf); return renderHome(el, openProject); }
    const hv = e.target.closest('[data-hview]');
    if (hv) { store('ve-home-view', hv.dataset.hview); return draw(); }
    const hs = e.target.closest('[data-hsort]');
    if (hs) { store('ve-home-sort', hs.dataset.hsort); $('#hmSort', el).value = hs.dataset.hsort; return draw(); }
    const ht = e.target.closest('[data-htag]');
    if (ht) { homeTag = homeTag === ht.dataset.htag ? '' : ht.dataset.htag; return draw(); }
    if (e.target.closest('[data-hclose]')) return pick('');
    const pt = e.target.closest('[data-ptag]');
    if (pt) { e.stopPropagation(); return tagProject(pt.dataset.ptag, () => renderHome(el, openProject)); }
    const sh = e.target.closest('[data-share]');
    if (sh) { e.stopPropagation(); return shareProject(sh.dataset.share, () => renderHome(el, openProject)); }
    const ren = e.target.closest('[data-ren]');
    if (ren) { e.stopPropagation(); return renameProject(ren.dataset.ren, () => { homeSel = ''; renderHome(el, openProject); }); }
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); return deleteProject(del.dataset.del, () => { homeSel = ''; renderHome(el, openProject); }); }
    const mv = e.target.closest('[data-move]');
    if (mv) { e.stopPropagation(); return moveMenu(mv, mv.dataset.move, () => renderHome(el, openProject)); }
    if (e.target.closest('[data-folder]')) { e.stopPropagation(); const r = await api('POST', `/api/open-folder?p=${enc(e.target.closest('[data-folder]').dataset.folder)}`); toast(r.folder); return; }
    const op = e.target.closest('[data-openp]');
    if (op) return openProject(op.dataset.openp);
    const card = e.target.closest('[data-open]');
    if (card) pick(card.dataset.open); // (one click: its details at the right)
  };
  el.ondblclick = (e) => { const card = e.target.closest('[data-open]'); if (card && !e.target.closest('button')) openProject(card.dataset.open); };
  try {
    const [list0, health, me, pf0] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/health'), api('GET', '/api/me').catch(() => ({})), api('GET', '/api/project-folders').catch(() => null)]);
    pf = pf0 || { folders: [], map: {}, old: true };
    homeList = list0;
    // deleting / bringing back projects: the owner, on this computer
    const owner = me.role === 'owner', member = !!pf.mine;
    // 📁 the view (remembered in this browser): 'recent' = Home, 'all', 'shared', 'none', 'folders' (the folder tiles) or a folder's id
    let cur = store('ve-home-at') || 'recent';
    if (cur === 'root') cur = 'recent'; // (the old page's folders-only start)
    if (!['recent', 'all', 'shared', 'none', 'folders'].includes(cur) && !pf.folders.some((f) => f.id === cur)) cur = 'recent';
    // 📁 a team member given one folder: Home is that folder, nothing else (pf.mine: the folders that are theirs)
    const oneFolder = pf.mine?.length === 1 ? pf.mine[0] : null;
    if (oneFolder) cur = oneFolder;
    else if (member && cur === 'all') cur = 'recent';
    el.classList.toggle('hm-one', !!oneFolder);
    const inF = (p) => pf.map[p.name] || null, fname = (id) => pf.folders.find((f) => f.id === id)?.name || '';
    // 🔐 whose a project is: the owner may share any, a team member the ones they made
    const meName = String(me.local ? '' : me.name || '').toLowerCase(), mine = (p) => owner || me.local || String(p.by || '').toLowerCase() === meName;
    const isShared = (p) => (owner || me.local ? !!p.shared?.length : !!p.by && !mine(p) || !!p.shared?.length);
    const count = (id) => list0.filter((p) => (id === 'none' ? !inF(p) : inF(p) === id)).length;
    const inView = (p) => cur === 'recent' || cur === 'all' || (cur === 'shared' ? isShared(p) : cur === 'none' ? !inF(p) : inF(p) === cur);
    const title = { recent: 'Recent', all: 'All projects', shared: 'Shared', none: 'Not in a folder', folders: 'Folders' }[cur] || fname(cur);

    // ---- left: Recent / All / Shared, then the folders (drop a project on one to move it there) ----
    const navRow = (id, label, n, ico, extra = '') => `<button class="hm-nrow${cur === id ? ' on' : ''}" data-pf="${id}"${!['recent', 'all', 'shared', 'folders'].includes(id) ? ' data-drop' : ''} title="${esc(label)}">${ico}<span class="hm-nlabel">${esc(label)}</span>${extra}<span class="hm-n">${n}</span></button>`;
    const who = (f) => (owner && f.users?.length ? `<small class="pf-who" title="${f.auto ? 'Given to them by its name - ⋯ > Assign to people to change' : 'Assigned'}">${ic('team')} ${esc(f.users.join(', '))}</small>` : '');
    $('#hmNav', el).innerHTML = (oneFolder ? '' : navRow('recent', 'Recent', Math.min(RECENT, list0.length), ic('clock'))
        + (owner ? navRow('all', 'All projects', list0.length, icon('folder')) : '')
        + navRow('shared', owner || me.local ? 'Shared' : 'Shared with me', list0.filter(isShared).length, ic('team')))
      + `<div class="hm-nsec">Folders${owner ? '<button class="hm-nadd" data-pfnew title="New folder">+</button>' : ''}</div>`
      + pf.folders.map((f) => navRow(f.id, f.name, count(f.id), '<span class="hm-fi"></span>', `${who(f)}${owner ? `<span class="hm-nmore" data-pfedit="${f.id}" title="Rename / assign / delete">${ic('more')}</span>` : ''}`)).join('')
      + (pf.folders.length && (owner || count('none')) && !oneFolder ? navRow('none', 'Not in a folder', count('none'), '<span class="hm-fi none"></span>') : '')
      + (owner ? '<button class="hm-nrow hm-nnew" data-pfnew><span class="hm-plus">+</span><span class="hm-nlabel">New folder</span></button>' : '');
    $$('#hmTabs [data-pf]', el).forEach((b) => b.classList.toggle('on', b.dataset.pf === cur || (b.dataset.pf === 'recent' && cur === 'all')));
    $('#hmTabs', el).hidden = !!oneFolder;
    const dropOn = (root) => { for (const c of $$('[data-drop]', root)) {
      c.ondragover = (e) => { if (e.dataTransfer.types.includes('text/ve-project')) { e.preventDefault(); c.classList.add('drop'); } };
      c.ondragleave = () => c.classList.remove('drop');
      c.ondrop = (e) => { e.preventDefault(); c.classList.remove('drop'); const p = e.dataTransfer.getData('text/ve-project'); if (p) moveTo(p, c.dataset.pf === 'none' ? null : c.dataset.pf, () => renderHome(el, openProject)); };
    } };
    dropOn($('#hmNav', el));

    // a new project made inside a folder goes in this folder
    const openHere = ['recent', 'all', 'none', 'shared', 'folders'].includes(cur) || pf.old ? openProject
      : async (name) => { try { pf = await api('POST', '/api/project-folders', { folders: pf.folders, map: { ...pf.map, [name]: cur } }); } catch {} openProject(name); };
    newOpen = openHere;
    for (const a of ['team', 'sessions']) { const tb = $(`[data-a="${a}"]`, el); if (tb) tb.hidden = !owner; } // (the team's admin: owners only)
    { const db = $('[data-a="dash"]', el); if (db) db.hidden = false; } // (📊 the Dashboard: everyone)
    // 🚪 who is signed in (its first letter; click: name, role, Logout) - none on the editing PC itself
    { const hm = $('#homeMe', el); if (hm) { hm.hidden = !!me.local; hm.innerHTML = me.local ? '' : `<button class="hm-av" data-a="me" data-name="${esc(me.name)}" data-role="${esc(me.role)}" title="Signed in as ${esc(me.name)} (${esc(me.role)}) - click to log out">${esc(String(me.name || '?')[0].toUpperCase())}</button>`; } }
    S.health = health;
    $('#projRoot', el).textContent = health.projectsFolder;
    mountHomeStart(el, list0.length, () => newProjectDialog(openProject)); // 🚩 first-edit steps for someone new
    if (owner) api('GET', '/api/projects/deleted').then((d) => { const b = $('[data-a="deleted"]', el); if (b) { b.hidden = false; b.innerHTML = `${icon('trash')} Bin${d.length ? ` <i class="hm-badge">${d.length}</i>` : ''}`; } }).catch(() => {});
    const grid = $('#projGrid', el), detail = $('#hmDetail', el), sortSel = $('#hmSort', el);
    sortSel.value = store('ve-home-sort') || 'edited';
    sortSel.onchange = () => { store('ve-home-sort', sortSel.value); draw(); };

    // ---- the project picked: everything about it, Open, and what can be done with it ----
    const btns = (p) => `${mine(p) ? `<button data-share="${esc(p.name)}" title="Share with team members (they see it and can edit it with you)">${ic('team')} Share</button>` : ''}<button data-ptag="${esc(p.name)}" title="Tags (labels to find it by - client, kind of work, status…)">${ic('tag')} Tags</button>${me.role !== 'viewer' ? `<button data-ren="${esc(p.name)}" title="Rename project">${ic('edit')} Rename</button>` : ''}<button data-move="${esc(p.name)}" title="Move to a folder (or drag the card onto a folder at the left)">${icon('folderMove')} Move</button><button data-folder="${esc(p.name)}" title="Open project folder">${icon('folder')} Folder</button>${owner ? `<button class="hm-danger" data-del="${esc(p.name)}" title="Delete project (to the Recycle Bin, or for good)">${icon('trash')} Delete</button>` : ''}`;
    const byLine = (p) => (p.by && !mine(p) ? `shared by ${esc(p.by)}` : p.by ? esc(p.by) : '');
    pick = (name) => {
      homeSel = name;
      $$('[data-open]', grid).forEach((c) => c.classList.toggle('sel', c.dataset.open === name));
      const p = list0.find((x) => x.name === name);
      el.classList.toggle('hm-picked', !!p);
      if (!p) { detail.hidden = true; detail.innerHTML = ''; return; }
      const tg = tagsOf(p);
      detail.hidden = false;
      detail.innerHTML = `<button class="hm-x" data-hclose title="Close" aria-label="Close">×</button>
        <div class="hm-d-th" style="${bg(p)}">${p.aspect ? `<span class="hm-asp">${esc(p.aspect)}</span>` : ''}</div>
        <h3 class="hm-d-name">${esc(p.name)}</h3>
        <div class="hm-d-tags">${tg.length ? tagChips(tg) : ''}<button class="chip hm-addtag" data-ptag="${esc(p.name)}">+ tag</button></div>
        <div class="hm-stats"><div><b>${p.duration ? fmt(p.duration) : '-'}</b><small>Length</small></div><div><b>${p.clips ?? 0}</b><small>Clips</small></div><div><b>${p.media ?? 0}</b><small>Media</small></div></div>
        <dl class="hm-kv"><dt>Format</dt><dd>${esc(p.aspect || '-')}</dd>
          <dt>Folder</dt><dd>${inF(p) ? esc(fname(inF(p))) : '<span class="muted">Not in a folder</span>'}</dd>
          ${p.place ? `<dt>Saved in</dt><dd class="mono" title="${esc(p.place)}">${esc(p.place)}</dd>` : ''}
          ${p.by ? `<dt>Made by</dt><dd>${byLine(p)}</dd>` : ''}
          ${p.shared?.length ? `<dt>Shared with</dt><dd>${esc(p.shared.join(', '))}</dd>` : ''}
          <dt>Edited</dt><dd title="${esc(new Date(p.modified).toLocaleString())}">${ago(p.modified)} · ${esc(new Date(p.modified).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</dd></dl>
        <button class="primary hm-open" data-openp="${esc(p.name)}">Open project</button>
        <div class="hm-d-acts">${btns(p)}</div>`;
    };

    // ---- the projects: board (thumbnails) or list (rows) ----
    draw = () => {
      const q = homeQ.trim().toLowerCase(), byTag = q[0] === '#' ? q.slice(1).trim() : '';
      const view = store('ve-home-view') === 'list' ? 'list' : 'board', sort = sortSel.value;
      $$('[data-hview]', el).forEach((b) => b.classList.toggle('on', b.dataset.hview === view));
      // a search looks in every folder; the folders' page and the views show their own projects
      const found = (p) => { const tags = tagsOf(p).map((t) => t.toLowerCase()); return byTag ? tags.includes(byTag) : p.name.toLowerCase().includes(q) || tags.some((t) => t.includes(q)) || fname(inF(p)).toLowerCase().includes(q); };
      let list = q ? list0.filter(found) : list0.filter(inView);
      const bySort = { edited: (a, b) => b.modified - a.modified, name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }), length: (a, b) => (b.duration || 0) - (a.duration || 0) }[sort] || ((a, b) => b.modified - a.modified);
      if (cur === 'recent' && !q) list = [...list].sort((a, b) => b.modified - a.modified).slice(0, RECENT);
      list = [...list].sort(bySort);
      // 🏷 every tag on the projects here, most used first, in its colour; click one to see only those projects
      const counts = new Map();
      for (const p of list) for (const t of tagsOf(p)) { const k = t.toLowerCase(), x = counts.get(k); counts.set(k, [x?.[0] || t, (x?.[1] || 0) + 1]); }
      if (homeTag && !counts.has(homeTag)) homeTag = '';
      const folders = cur === 'folders' && !q;
      $('#homeTags', el).innerHTML = folders ? '' : [...counts.entries()].sort((a, b) => b[1][1] - a[1][1] || a[1][0].localeCompare(b[1][0])).map(([k, [t, n]]) => `<button class="chip utag${k === homeTag ? ' on' : ''}" data-htag="${esc(k)}" style="--tc:${tagColor(t)}">${esc(t)} ${n}</button>`).join('');
      if (homeTag) list = list.filter((p) => tagsOf(p).some((t) => t.toLowerCase() === homeTag));
      $('#homeCrumb', el).textContent = q ? `Search: ${homeQ.trim()}` : title;
      $('#hmCount', el).textContent = folders ? `${pf.folders.length} folder${pf.folders.length === 1 ? '' : 's'}` : `${list.length} project${list.length === 1 ? '' : 's'}${cur === 'recent' && !q ? ' · last edited' : ''}`;
      $('#hmTools', el).hidden = folders;
      grid.className = `hm-content ${folders ? 'hm-folders' : view === 'list' ? 'hm-list' : 'hm-board'}`;
      const where = (p) => (inF(p) && (q || ['recent', 'all', 'shared'].includes(cur)) ? `<span class="hm-where">${esc(fname(inF(p)))}</span>` : '');
      const qa = (p) => `<div class="hm-qa">${mine(p) ? `<button data-share="${esc(p.name)}" title="Share" aria-label="Share ${esc(p.name)}">${ic('team')}</button>` : ''}<button data-ptag="${esc(p.name)}" title="Tags" aria-label="Tags of ${esc(p.name)}">${ic('tag')}</button>${me.role !== 'viewer' ? `<button data-ren="${esc(p.name)}" title="Rename" aria-label="Rename ${esc(p.name)}">${ic('edit')}</button>` : ''}<button data-move="${esc(p.name)}" title="Move to a folder" aria-label="Move ${esc(p.name)} to a folder">${icon('folderMove')}</button></div>`;
      const attrs = (p) => `data-open="${esc(p.name)}" data-tags="${esc(JSON.stringify(tagsOf(p)))}" draggable="true" tabindex="0" role="button" aria-label="${esc(p.name)} - Enter opens it"`;
      if (folders) {
        // the folder tiles (a folder picture, its name, how many projects); drop a project on one to move it there
        const chip = (id, label, n, kind = 'folder', extra = '') => `<button class="pf-chip pf-${kind}" data-pf="${id}"${id !== 'all' ? ' data-drop' : ''} title="${label}">${FOLDER_SVG}<b>${label}</b><i>${n} project${n === 1 ? '' : 's'}</i>${extra}</button>`;
        grid.innerHTML = (owner ? chip('all', 'All projects', list0.length, 'all') : '') + pf.folders.map((f) => chip(f.id, esc(f.name), count(f.id), 'folder', `${who(f)}${owner ? `<span class="pf-x" data-pfedit="${f.id}" title="Rename / assign / delete">${ic('more')}</span>` : ''}`)).join('')
          + (pf.folders.length && (owner || count('none')) ? chip('none', 'Not in a folder', count('none'), 'none') : '') + (owner ? '<button class="pf-chip add" data-pfnew><span class="pf-plus">+</span><b>New folder</b></button>' : '');
        dropOn(grid);
      } else if (view === 'list') {
        const th = (k, l) => `<th${k ? ` class="hm-sortable${sort === k ? ' on' : ''}" data-hsort="${k}"` : ''}>${l}${sort === k ? ' ▾' : ''}</th>`;
        grid.innerHTML = list.length ? `<table class="hm-table"><thead><tr><th></th>${th('name', 'Name')}<th>Folder</th><th>Format</th>${th('length', 'Length')}<th>Clips</th>${th('edited', 'Edited')}<th>By</th><th></th></tr></thead><tbody>${list.map((p) => `<tr class="hm-row" ${attrs(p)}>
          <td><div class="hm-tn" style="${bg(p)}"></div></td><td class="hm-tname"><b>${esc(p.name)}</b>${tagsOf(p).length ? `<span class="proj-tags">${tagChips(tagsOf(p))}</span>` : ''}</td>
          <td class="muted">${inF(p) ? esc(fname(inF(p))) : '-'}</td><td class="mono">${esc(p.aspect || '')}</td><td class="mono">${p.duration ? fmt(p.duration) : '-'}</td><td>${p.clips}</td>
          <td class="muted" title="${esc(new Date(p.modified).toLocaleString())}">${ago(p.modified)}</td><td class="muted">${byLine(p)}</td><td>${qa(p)}</td></tr>`).join('')}</tbody></table>` : '';
      } else {
        grid.innerHTML = list.map((p) => `<div class="hm-card" ${attrs(p)}>
          <div class="hm-th" style="${bg(p)}">${p.aspect ? `<span class="hm-asp">${esc(p.aspect)}</span>` : ''}${p.duration ? `<span class="hm-dur">${fmt(p.duration)}</span>` : ''}${qa(p)}</div>
          <b class="hm-name">${esc(p.name)}</b>
          <div class="hm-meta"><span>${p.clips} clips${where(p) ? ' · ' : ''}${where(p)}</span><span title="${esc(new Date(p.modified).toLocaleString())}">${ago(p.modified)}</span></div>
          ${p.by && !mine(p) ? `<small class="hm-by">${ic('team')} shared by ${esc(p.by)}</small>` : p.shared?.length ? `<small class="hm-by">${ic('team')} ${esc(p.shared.join(', '))}</small>` : ''}</div>`).join('');
      }
      if (!folders && !list.length) grid.innerHTML = `<div class="hm-empty muted">${q || homeTag ? 'No project matches - clear the search or the tag.' : cur === 'shared' ? 'No shared projects yet - Share on a project gives it to team members.' : !['recent', 'all'].includes(cur) ? 'No projects in this folder yet - drag a project onto this folder at the left, or use Move on it.' : 'No projects yet - + New project makes the first one.'}</div>`;
      $$('[data-open]', grid).forEach((c) => {
        c.addEventListener('keydown', (e) => { if (e.key === 'Enter') openProject(c.dataset.open); else if (e.key === ' ') { e.preventDefault(); pick(c.dataset.open); } });
        c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/ve-project', c.dataset.open); e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('pf-dragging'); });
        c.addEventListener('dragend', () => document.body.classList.remove('pf-dragging'));
      });
      pick(list.some((p) => p.name === homeSel) ? homeSel : '');
    };
    const qi = $('#homeQ', el); qi.value = homeQ;
    qi.oninput = () => { homeQ = qi.value; draw(); };
    qi.onkeydown = (e) => { if (e.key === 'Escape') { homeQ = qi.value = ''; draw(); } else if (e.key === 'Enter') { const c = $('[data-open]', grid); if (c) openProject(c.dataset.open); } };
    draw();
  } catch (e) {
    // signed out (the session ended): straight to the sign-in page from here, instead of a dead end
    const out = /sign in/i.test(e.message);
    $('#projGrid', el).innerHTML = `<div class="err">Could not load projects: ${esc(e.message)}</div><p>${out ? '<button class="primary" data-a="signin">Sign in</button> ' : ''}<button data-a="refresh">Refresh</button></p>`;
  }
}
// Ctrl+K: the search on Home (only while Home is on screen)
addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return;
  const q = document.getElementById('homeQ'); if (!q || !q.offsetParent) return;
  e.preventDefault(); q.focus(); q.select();
});

// 🏷 a project's tags: saved in its project.json (an open timeline gets them at once)
async function tagProject(name, refresh) {
  const p = homeList.find((x) => x.name === name), cur = p ? tagsOf(p) : [];
  const all = homeList.flatMap((x) => tagsOf(x));
  const next = await editTags(cur, { title: `Tags of ${name}`, suggest: all }); if (!next) return;
  try { const r = await api('POST', `/api/project/tags?p=${enc(name)}`, { tags: next }); tagNow.set(name, { tags: r.tags, at: Date.now() }); refresh(); }
  catch (e) { toast(e.message, 'err'); }
}

// ---------------- 📁 folders on Home ----------------
let pf = { folders: [], map: {} };
async function savePF(next, refresh) {
  if (pf.old) return toast('Restart the editor once to use folders (Start Video Editor)', 'err');
  try { pf = await api('POST', '/api/project-folders', { folders: next.folders, map: next.map }); refresh(); } catch (e) { toast(e.message, 'err'); }
}
const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
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
  popMenu(anchor, [...pf.folders.map((f) => [f.id, `${f.id === now ? ic('check') + ' ' : ''}${esc(f.name)}`]), ...(pf.mine ? [] : [['-'], ['__new', 'New folder…'], ...(now ? [['__out', 'Take out of the folder']] : [])])] /* (a team member: only between their own folders) */, (k) => {
    if (k === '__out') return moveTo(project, null, refresh);
    if (k === '__new') { const name = prompt('New folder name')?.trim(); if (!name) return; const id = newId(); return savePF({ folders: [...pf.folders, { id, name }], map: { ...pf.map, [project]: id } }, refresh); }
    moveTo(project, k, refresh);
  });
}
function folderMenu(anchor, id, refresh) {
  const f = pf.folders.find((x) => x.id === id); if (!f) return;
  popMenu(anchor, [['rename', 'Rename'], ['assign', 'Assign to people…'], ['delete', 'Delete folder (projects stay)']], (k) => {
    if (k === 'assign') return assignFolder(f, refresh);
    if (k === 'rename') { const name = prompt('Folder name', f.name)?.trim(); if (name) savePF({ folders: pf.folders.map((x) => (x.id === id ? { ...x, name } : x)), map: pf.map }, refresh); }
    if (k === 'delete' && confirm(`Delete the folder "${f.name}"? Its projects are not deleted - they go back to All projects.`)) {
      const map = Object.fromEntries(Object.entries(pf.map).filter(([, v]) => v !== id));
      try { localStorage.setItem('ve-home-at', 'root'); } catch {}
      savePF({ folders: pf.folders.filter((x) => x.id !== id), map }, refresh);
    }
  });
}

// 👤 a folder given to team members: they see this folder and its projects only (until it is given to nobody)
function assignFolder(f, refresh) {
  const people = pf.people || [], on = new Set(f.users || []);
  const body = h(`<div><p class="muted small">Ticked people see <b>${esc(f.name)}</b> and every project in it - and, with one folder, nothing else on their Projects page. The owner always sees everything.</p>
    <div class="pf-assign">${people.map((n) => `<label class="chk"><input type="checkbox" value="${esc(n)}"${on.has(n) ? ' checked' : ''}> ${esc(n)}</label>`).join('') || '<span class="muted">No team members yet (Team &amp; users)</span>'}</div>
    <div class="row-in" style="margin-top:12px"><button class="primary" data-ok>Save</button></div></div>`);
  const dlg = modal(`Assign "${esc(f.name)}"`, body, { width: 420 });
  $('[data-ok]', body).onclick = () => {
    const users = [...body.querySelectorAll('input:checked')].map((i) => i.value);
    dlg.close();
    savePF({ folders: pf.folders.map((x) => (x.id === f.id ? { id: x.id, name: x.name, users } : x)), map: pf.map }, refresh);
    toast(users.length ? `${f.name}: ${users.join(', ')}` : `${f.name}: given to nobody`);
  };
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
    <label class="fld"><span>Brand pack <button type="button" class="link small" data-packs title="Make or change a client's brand pack">Manage…</button></span><select name="pack"><option value="">None</option></select></label>
    <label class="fld"><span>Frame rate</span><select name="fps"><option>24</option><option>25</option><option selected>30</option><option>50</option><option>60</option></select></label>
    <div class="fld wide"><span>Save project in</span>
      <div class="row-in"><input name="place" readonly><button type="button" data-browse>Browse…</button><button type="button" data-def title="Back to your own folder">My folder</button></div>
      <small>A folder on the NAS (Z:\\) - your own folder unless you pick another. The project gets its own folder inside it. Add footage once it opens (+ Folder).</small></div>
    <div class="np-foot"><button type="button" data-close>Cancel</button><button class="primary" type="submit">Create project</button></div>
  </form>`);
  const dlg = modal('New project', body, { width: 620 });
  api('GET', '/api/library').then((l) => { body.template.insertAdjacentHTML('beforeend', (l.templates || []).map((t) => `<option value="${esc(t.name)}">${esc(t.name)}${t.aspect ? ` (${esc(t.aspect)})` : ''}</option>`).join('')); }).catch(() => {});
  // 🏷 a client's brand pack: logo, intro / outro, colours, font, caption and lower-third style from the start
  const loadPacks = () => api('GET', '/api/library/brandpacks').then((l) => { const v = body.pack.value; body.pack.innerHTML = `<option value="">None</option>${l.map((p) => `<option value="${esc(p.id)}"${p.id === v ? ' selected' : ''}>${esc(p.name)}${p.client ? ` - ${esc(p.client)}` : ''}</option>`).join('')}`; }).catch(() => {});
  loadPacks();
  $('[data-packs]', body).onclick = () => import('./library.js').then((m) => m.openBrandKit(null, { onClose: loadPacks }));
  const showPlace = () => { body.place.value = place; };
  showPlace();
  myFolder().then((f) => { home = f; if (!touched) { place = f; showPlace(); } });
  $('[data-browse]', body).onclick = async () => { const f = await pickFolder('Save project in', '', { only: NAS, start: place }); if (f) { place = f; touched = true; showPlace(); } };
  $('[data-def]', body).onclick = () => { place = home; touched = true; showPlace(); };
  body.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('[type=submit]', body); btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const r = await api('POST', '/api/projects', { name: body.name.value.trim(), aspect: body.aspect.value, fps: +body.fps.value, place, template: body.template.value, pack: body.pack.value });
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
// ✏ a new name for a project (POST /api/projects/rename): its folder is renamed where it is; refused while it is open
// 🔐 share a project: tick the team members who should see it too (they open and edit it with you, live)
async function shareProject(name, refresh) {
  let a;
  try { a = await api('GET', `/api/projects/share?p=${enc(name)}`); } catch (e) { return toast(e.message, 'err'); }
  const on = new Set(a.shared);
  const dlg = modal('Share project', `<p class="muted small"><b>${esc(name)}</b> is ${esc(a.owner)}'s. Only they, the owner and the people ticked here see it in their projects.</p>
    <div class="share-list">${a.people.map((n) => `<label class="chk"><input type="checkbox" value="${esc(n)}" ${on.has(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('') || '<p class="muted">No one else in the team yet.</p>'}</div>
    <div class="dv-actions"><button class="primary" data-action="go">Save</button><button data-close>Cancel</button></div>`, { width: 420, onAction: async (k) => {
    if (k !== 'go') return;
    const shared = $$('.share-list input:checked', dlg.el).map((x) => x.value);
    try { await api('POST', `/api/projects/share?p=${enc(name)}`, { shared }); dlg.close(); toast(shared.length ? `Shared with ${shared.join(', ')}` : 'Not shared - only its maker and the owner see it'); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  } });
}

async function renameProject(name, refresh) {
  const dlg = modal('Rename project', `<label class="fld"><span>New name</span><input data-name value="${esc(name)}" maxlength="120" style="width:100%"></label>
    <p class="muted small">The project's folder gets the new name too, where it is. Everyone has to close the project first.</p>
    <div class="dv-actions"><button class="primary" data-action="go">Rename</button><button data-close>Cancel</button></div>`, { width: 460, onAction: async (a) => {
    if (a !== 'go') return;
    const to = $('[data-name]', dlg.el).value.trim();
    if (!to || to === name) return dlg.close();
    try { const r = await api('POST', `/api/projects/rename?p=${enc(name)}`, { name: to }); dlg.close(); toast(`Renamed to ${r.name}`); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  } });
  const inp = $('[data-name]', dlg.el); inp.focus(); inp.select();
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('[data-action="go"]', dlg.el).click(); } });
}
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
        <button class="small" data-restore="${esc(x.folder)}">Restore</button><button class="small danger" data-purge="${esc(x.folder)}" data-name="${esc(x.name)}">Delete forever</button></div>`).join('') || '<div class="muted pad">The Recycle Bin is empty.</div>'}</div>
      <div class="dv-actions">${list.length ? `<button class="danger" data-empty>Empty Recycle Bin (${list.length} · ${size(total)})</button>` : ''}<span class="grow"></span><button data-close>Close</button></div>`;
  };
  draw();
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.restore) {
        b.disabled = true;
        const r = await api('POST', `/api/projects/restore?folder=${enc(b.dataset.restore)}`); toast(`Restored as "${r.name}"`);
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
