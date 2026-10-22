// 🗂 Media sambhaal (Phase 17): files that went offline found and linked again (🔗 Relink), the project and its footage
// copied into one folder that opens on any computer (📦 Pack), and what the project takes on the disk with a cleanup
// (💾 Disk). Server side: checkOffline / relinkScan / relinkApply / packProject / diskOf / diskClean in server.mjs.
import { S, saveNow } from './store.js';
import { api, enc, watchJob } from './api.js';
import { $, esc, toast, modal } from './ui.js';
import { pickFolder, refreshMedia } from './mediapool.js';

export const fmtBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`);
const short = (p, n = 70) => (p.length > n ? `…${p.slice(-n)}` : p);

export function openMediaMgr(tab = 'relink') {
  if (!S.proj) return;
  const dlg = modal('Media manager', `
    <div class="mm-tabs" role="tablist">
      <button class="chip" data-tab="relink" role="tab">Relink</button><button class="chip" data-tab="pack" role="tab">Pack</button><button class="chip" data-tab="disk" role="tab">Disk</button>
    </div><div data-mm class="mm-body"></div>`, { width: 760 });
  const box = $('[data-mm]', dlg.el);
  const show = (t) => {
    dlg.el.querySelectorAll('[data-tab]').forEach((b) => { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-selected', b.dataset.tab === t); });
    ({ relink, pack, disk })[t](box);
  };
  dlg.el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  show(tab);
}

// ---------------- 🔗 relink ----------------
async function relink(box) {
  box.innerHTML = '<div class="muted pad">Checking for offline files…</div>';
  let off;
  try { off = await api('GET', `/api/media/offline?p=${enc(S.proj)}`); } catch (e) { box.innerHTML = `<p class="warn">${esc(e.message)}</p>`; return; }
  if (!off.missing.length) {
    box.innerHTML = '<p class="good">✓ All files are in place - none offline.</p><p class="muted small">If a drive is unplugged or a folder is moved, it shows up here. The editor checks every 10 seconds.</p>';
    return;
  }
  const used = off.missing.filter((m) => m.used).length;
  box.innerHTML = `<p><b class="warn">${off.missing.length} file${off.missing.length > 1 ? 's' : ''} offline</b>${used ? ` - <b>${used}</b> of them on the timeline (rendering needs them)` : ''}.</p>
    <div class="dv-list mm-list">${off.missing.map((m) => `<div class="dv-item"><span class="grow"><b>${esc(m.name)}</b>${m.used ? ' <span class="tag">on timeline</span>' : ''}<br><span class="muted small mono">${esc(short(m.path))}</span></span></div>`).join('')}</div>
    <p class="muted small">The editor searches: what is left of the old folder, the team's shared folders, the folders of the project's other files, Desktop / Videos / Downloads / Documents. Somewhere else (another drive)? Choose the folder.</p>
    <div class="dv-actions"><button data-folder>Search a folder</button><button class="primary" data-auto>Search automatically</button></div>
    <div data-res></div>`;
  const res = $('[data-res]', box);
  const scan = async (dirs, auto = true) => {
    box.querySelectorAll('[data-auto],[data-folder]').forEach((b) => (b.disabled = true));
    res.innerHTML = '<div class="job"><span data-st>Searching…</span></div>';
    let j;
    try {
      const job = await api('POST', `/api/media/relink/scan?p=${enc(S.proj)}`, { dirs, auto });
      j = await watchJob(job.id, (x) => { const st = res.querySelector('[data-st]'); if (st && x.stage) st.textContent = short(x.stage, 90); });
    } catch (e) { res.innerHTML = `<p class="warn">${esc(e.job ? e.job.log.slice(-1).join(' ') : e.message)}</p>`; box.querySelectorAll('[data-auto],[data-folder]').forEach((b) => (b.disabled = false)); return; }
    box.querySelectorAll('[data-auto],[data-folder]').forEach((b) => (b.disabled = false));
    const r = j.result;
    res.innerHTML = `<h4>${r.found.length} found${r.notFound.length ? `, ${r.notFound.length} not found` : ''}</h4>
      ${r.found.length ? `<div class="dv-list mm-list">${r.found.map((f, i) => `<label class="dv-item"><input type="checkbox" data-pick="${i}"${f.sure ? ' checked' : ''}>
        <span class="grow"><b>${esc(f.name)}</b> <span class="${f.sure ? 'muted' : 'warn'} small">(${esc(f.how)})</span><br><span class="muted small mono">${esc(short(f.to))}</span></span></label>`).join('')}</div>
        <div class="dv-actions"><button class="primary" data-apply>Relink selected</button></div>` : ''}
      ${r.notFound.length ? `<p class="muted small">Not found: ${r.notFound.map((x) => esc(x.name)).slice(0, 12).join(', ')}${r.notFound.length > 12 ? ` and ${r.notFound.length - 12} more…` : ''}. On another drive / folder? Click "Search a folder".</p>` : ''}
      <p class="muted small">Searched:${r.searched.map((d) => esc(short(d, 40))).join(' · ') || '-'}</p>`;
    const apply = res.querySelector('[data-apply]');
    if (apply) apply.onclick = async () => {
      const pairs = [...res.querySelectorAll('[data-pick]:checked')].map((c) => r.found[+c.dataset.pick]).map((f) => ({ id: f.id, to: f.to }));
      if (!pairs.length) return toast('No file selected', 'err');
      apply.disabled = true;
      try {
        const out = await api('POST', `/api/media/relink/apply?p=${enc(S.proj)}`, { pairs });
        toast(`${out.relinked} file${out.relinked > 1 ? 's' : ''} relinked${out.offline ? ` - ${out.offline} still offline` : ''}`);
        await refreshMedia();
        relink(box);
      } catch (e) { toast(e.message, 'err'); apply.disabled = false; }
    };
  };
  $('[data-auto]', box).onclick = () => scan([], true);
  $('[data-folder]', box).onclick = async () => {
    const f = await pickFolder('Where are the offline files?', 'Choose the folder or drive where the footage is now - all subfolders are searched too.');
    if (f) scan([f], true);
  };
}

// ---------------- 📦 pack ----------------
function pack(box) {
  box.innerHTML = `<p>The project and its footage are copied into <b>one folder</b>. Put that folder in the editor's <span class="mono">Projects</span> folder on any computer - the project opens with its footage (no relink needed). Also good for archiving to a hard disk.</p>
    <label class="row-in"><input type="checkbox" data-all> Whole media pool (all files, not only those on the timeline)</label>
    <label class="row-in"><input type="checkbox" data-px> Include preview copies (plays right away, bigger folder)</label>
    <p class="muted small">The original footage stays where it is - this only makes a copy. Renders, old backups and the render cache are not copied.</p>
    <div class="dv-actions"><button class="primary" data-go>Choose folder and pack</button></div><div data-res></div>`;
  $('[data-go]', box).onclick = async () => {
    const dest = await pickFolder('Where to put the pack?', 'Choose a folder or drive (e.g. an archive hard disk). A new folder named after the project is made inside it.');
    if (!dest) return;
    const res = $('[data-res]', box), go = $('[data-go]', box);
    go.disabled = true;
    await saveNow(true);
    res.innerHTML = '<div class="job"><span data-st>Starting…</span><div class="bar"><i data-bar style="width:2%"></i></div></div>';
    try {
      const job = await api('POST', `/api/pack?p=${enc(S.proj)}`, { dest, all: $('[data-all]', box).checked, proxies: $('[data-px]', box).checked });
      const j = await watchJob(job.id, (x) => { res.querySelector('[data-bar]').style.width = `${Math.max(2, x.progress)}%`; res.querySelector('[data-st]').textContent = `${x.progress}% · ${short(x.stage || '', 80)}`; });
      const r = j.result;
      res.innerHTML = `<p class="good">✓ Packed: <b>${r.files} file${r.files > 1 ? 's' : ''}</b>, ${fmtBytes(r.bytes)}</p>
        <div class="sh-url"><span class="mono grow">${esc(r.folder)}</span><button class="small" data-copy>Copy</button></div>
        ${r.missing.length ? `<p class="warn small">These files were offline and were not packed: ${r.missing.map(esc).join(', ')}. Relink them first.</p>` : ''}
        <p class="muted small">On the other computer: copy this folder into the editor's <span class="mono">Projects</span> folder, then open it in the editor.</p>`;
      res.querySelector('[data-copy]').onclick = async () => { await navigator.clipboard.writeText(r.folder); toast('Path copied'); };
    } catch (e) { res.innerHTML = `<p class="warn">${esc(e.job ? e.job.log.slice(-1).join(' ') : e.message)}</p>`; }
    go.disabled = false;
  };
}

// ---------------- 💾 disk ----------------
async function disk(box) {
  box.innerHTML = '<div class="muted pad">Calculating…</div>';
  let d;
  try { d = await api('GET', `/api/disk?p=${enc(S.proj)}`); } catch (e) { box.innerHTML = `<p class="warn">${esc(e.message)}</p>`; return; }
  const CLEAN = { segments: 'Clean up', undo: 'Keep last 3', backups: 'Keep last 5' };
  const max = Math.max(1, ...d.parts.map((x) => x.bytes));
  box.innerHTML = `<p>This project's folder: <b>${fmtBytes(d.total)}</b> <span class="muted small">(the original footage is outside it and not counted)</span></p>
    <div class="dv-list">${d.parts.filter((x) => x.bytes > 0).sort((a, b) => b.bytes - a.bytes).map((x) => `<div class="dv-item"><span class="grow">${esc(x.label)}<div class="mm-bar"><i style="width:${Math.max(1, (x.bytes / max) * 100)}%"></i></div></span>
      <b class="mm-size">${fmtBytes(x.bytes)}</b>${CLEAN[x.key] ? `<button class="small" data-clean="${x.key}">${CLEAN[x.key]}</button>` : '<span class="mm-noclean"></span>'}</div>`).join('')}
      ${d.orphans.files ? `<div class="dv-item"><span class="grow">Leftover cache of removed media <span class="muted small">(${d.orphans.files} files)</span></span><b class="mm-size">${fmtBytes(d.orphans.bytes)}</b><button class="small" data-clean="orphans">Clean up</button></div>` : ''}</div>
    ${d.renders.length ? `<h4>Renders <span class="muted small">(finished videos - select to delete)</span></h4>
      <div class="dv-list mm-list">${d.renders.map((r) => `<label class="dv-item"><input type="checkbox" data-r="${esc(r.file)}"><span class="grow mono small">${esc(r.file)}</span><span class="muted small">${new Date(r.mtime).toLocaleDateString()}</span><b class="mm-size">${fmtBytes(r.bytes)}</b></label>`).join('')}</div>
      <div class="dv-actions"><button data-delr>Delete selected renders</button></div>` : ''}
    <p class="muted small">Clearing the render cache makes the next render a bit slower (shots are rebuilt). No cleanup runs during a render.</p>
    <h4>All projects</h4><div data-all><button class="small" data-loadall>Show size of all projects</button></div>`;
  const clean = async (what, files) => {
    try { const r = await api('POST', `/api/disk/clean?p=${enc(S.proj)}`, { what, files }); toast(`${fmtBytes(r.freed)} freed`); disk(box); }
    catch (e) { toast(e.message, 'err'); }
  };
  box.querySelectorAll('[data-clean]').forEach((b) => (b.onclick = () => { b.disabled = true; clean(b.dataset.clean); }));
  const delr = box.querySelector('[data-delr]');
  if (delr) delr.onclick = () => {
    const files = [...box.querySelectorAll('[data-r]:checked')].map((c) => c.dataset.r);
    if (!files.length) return toast('No render selected', 'err');
    if (!confirm(`Permanently delete ${files.length} render${files.length > 1 ? 's' : ''}?\n\n${files.join('\n')}`)) return;
    clean('renders', files);
  };
  $('[data-loadall]', box).onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Counting…';
    try {
      const all = await api('GET', '/api/disk/all'), top = Math.max(1, ...all.map((x) => x.bytes));
      $('[data-all]', box).innerHTML = `<div class="dv-list mm-list">${all.map((x) => `<div class="dv-item"><span class="grow">${esc(x.project)}${x.project === S.proj ? ' <span class="tag">open</span>' : ''}<div class="mm-bar"><i style="width:${Math.max(1, (x.bytes / top) * 100)}%"></i></div></span><b class="mm-size">${fmtBytes(x.bytes)}</b></div>`).join('')}</div>
        <p class="muted small">Total: <b>${fmtBytes(all.reduce((n, x) => n + x.bytes, 0))}</b>. To clean up a project, open it and come back here.</p>`;
    } catch (err) { toast(err.message, 'err'); }
  };
}
