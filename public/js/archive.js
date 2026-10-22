// 📦 Archive (Phase 22): search all the old footage on the NAS / drives from any project - "drone shot of a river",
// "jharna", "tribal dance" - and bring a shot in (linked from where it is, not copied). The server looks at the folders
// once (engine/archive.mjs, the same picture model as 🧠 Smart); after that a search takes a second.
// findInArchive() is also used by 📜 Script se edit to find footage for scenes the project has none for.
import { S } from './store.js';
import { api, enc, watchJob } from './api.js';
import { esc, toast, modal } from './ui.js';
import { refreshMedia } from './mediapool.js';

const tc = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const inProject = () => S.media.map((m) => m.path).filter(Boolean);

export const findInArchive = (q, top = 12) => api('POST', '/api/archive/search', { q, top, skip: inProject() });
// a file from the archive into this project's media (bin "Archive"); resolves the media item
export const addFromArchive = (file, bin = 'Archive') => api('POST', `/api/media/addpath?p=${enc(S.proj)}`, { path: file, bin });

export async function openArchive(q0 = '') {
  const st = await api('GET', '/api/archive').catch(() => ({ roots: [], count: 0 }));
  const body = document.createElement('div');
  body.className = 'arc';
  body.innerHTML = `<div class="row-in"><input name="q" class="grow" placeholder="What shot? e.g. drone shot of a river · jharna · tribal dance · CM ka bhashan" value="${esc(q0)}"><button class="primary" data-a="find">Search</button></div>
    <p class="muted small" data-st></p>
    <div class="arc-grid" data-res></div>
    <details class="arc-set"><summary>Archive folders and scan</summary>
      <p class="muted small">Every video and photo under these folders is looked at once (a few frames each). New files are added when you scan again; the editor's own caches and renders are skipped.</p>
      <textarea name="roots" rows="4" placeholder="Z:\\Shoots&#10;E:\\Archive 2024">${esc(st.roots.join('\n'))}</textarea>
      <div class="row-in"><button data-a="save">Save folders</button><button class="accent" data-a="scan">Scan archive</button><span class="muted small grow" data-scan></span></div>
      <div class="job" data-job hidden><div class="bar"><div data-bar></div></div></div>
    </details>`;
  const m = modal('Archive search', body, { width: 900 });
  const $ = (s) => body.querySelector(s);
  const status = (x) => ($('[data-st]').textContent = x.count ? `${x.count.toLocaleString()} files in the archive${x.at ? ` · last scanned ${new Date(x.at).toLocaleDateString()}` : ''}` : 'The archive is not scanned yet - open "Archive folders and scan" below.');
  status(st);
  let results = [];
  const draw = () => {
    $('[data-res]').innerHTML = results.map((r, i) => `<div class="arc-it"><img loading="lazy" src="${r.thumb}" alt=""><div class="arc-meta"><b title="${esc(r.path)}">${esc(r.name)}</b>
      <span class="muted small" title="${esc(r.folder)}">${esc(r.folder)}</span><span class="small">${r.kind === 'video' ? `at ${tc(r.t)} of ${tc(r.dur)}` : 'photo'} · ${(r.score * 100).toFixed(0)}% match</span></div>
      <button class="small" data-add="${i}">${r.added ? '✓ In project' : '+ Add to project'}</button></div>`).join('') || '';
  };
  const find = async () => {
    const q = $('[name=q]').value.trim();
    if (!q) return;
    $('[data-st]').textContent = 'Searching…';
    try { const r = await findInArchive(q, 60); results = r.results; $('[data-st]').textContent = `${results.length} shots for "${r.q}"`; draw(); }
    catch (e) { $('[data-st]').textContent = e.message; }
  };
  const watchScan = async (id) => {
    $('[data-job]').hidden = false;
    try {
      const j = await watchJob(id, (x) => { $('[data-scan]').textContent = x.stage || 'Scanning…'; $('[data-bar]').style.width = `${x.progress || 0}%`; });
      $('[data-scan]').textContent = `Done: ${j.result.looked} new files looked at, ${j.result.total.toLocaleString()} in the archive`;
      status(await api('GET', '/api/archive'));
    } catch (e) { $('[data-scan]').textContent = e.job?.log?.slice(-1)[0] || e.message; }
    finally { $('[data-job]').hidden = true; }
  };
  if (st.scanning) watchScan(st.scanning.id);
  body.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a, add = e.target.closest('[data-add]');
    if (a === 'find') find();
    if (a === 'save' || a === 'scan') {
      try { status(await api('POST', '/api/archive/roots', { roots: $('[name=roots]').value.split(/\n/) })); } catch (x) { return toast(x.message, 'err'); }
      if (a === 'scan') { const j = await api('POST', '/api/archive/scan', {}).catch((x) => toast(x.message, 'err')); if (j?.id) watchScan(j.id); } else toast('Archive folders saved');
    }
    if (add) {
      const r = results[+add.dataset.add];
      if (r.added) return;
      add.disabled = true; add.textContent = 'Adding…';
      try { await addFromArchive(r.path); r.added = true; await refreshMedia(); toast(`${r.name} is in the media pool (bin Archive)${r.kind === 'video' ? ` - the shot is at ${tc(r.t)}` : ''}`); }
      catch (x) { toast(x.message, 'err'); }
      draw();
    }
  });
  $('[name=q]').addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
  if (q0) find();
  return m;
}
