// Media pool: import a whole raw-footage folder (files stay where they are), upload extras,
// search/filter/bins, hover-scrub thumbnails, drag clips onto the timeline.
import { S, on, emit, commit, setMedia, saveNow } from './store.js';
import { api, enc, upload } from './api.js';
import { fmt, seqList } from './model.js';
import { $, $$, h, esc, toast, modal, fmtSize } from './ui.js';
import { placeMedia } from './timeline.js';
import { openSmart, TAGS, dupIds } from './smart.js';
import { openBatch } from './batch.js';

const pools = [];
let poolSel = new Set(), filter = 'all', query = '', bin = '', pollTimer = null, tag = '';

// 🔗 the editor relinked moved files by itself: show it and read the media list again
on('notice', (m) => { if (m.media) refreshMedia(); if (m.text) toast(m.text); });

export function mountPool(el, { big = false } = {}) {
  const p = { el, big };
  pools.push(p);
  el.innerHTML = `
  <div class="pool-bar">
    <button class="accent small" data-a="folder" title="Import every clip in a folder (files are not copied)">+ Folder</button>
    <button class="small" data-a="upload" title="Upload files (music, logo, VO...)">Upload</button>
    <button class="small" data-a="newitem" title="New item: Sequence, Adjustment Layer, Color Matte, Black Video, Title">＋ New ▾</button>
    <button class="small" data-a="batch" title="Batch: subtitles, transcripts, scans or renders for many clips at once - now or overnight; watch a folder for new footage">⚙ Batch</button>
    <button class="small" data-a="smart" title="Smart footage: shot tags, find a shot by what it shows (jharna dikhao), near-copies and bad clips, match cameras">🧠 Smart</button>
    <input type="file" multiple hidden data-file accept="video/*,audio/*,image/*,.mxf,.mts,.m2ts,.mpeg,.cube,.srt">
    <span class="grow"></span>
    <span class="pool-q" data-q></span>
  </div>
  <div class="pool-filters">
    <div class="row-in"><input type="search" placeholder="Search names / tags - Enter: by picture" data-search aria-label="Search media"><button class="icon-btn small" data-a="find" title="Find by what the picture shows (jharna dikhao, crowd at night…)" aria-label="Find by picture">🔎</button></div>
    <div class="bin-row"><select data-bin aria-label="Folder"><option value="">All folders</option></select><button class="icon-btn small" data-a="delbin" title="Remove this whole folder from the project" aria-label="Remove folder" hidden>🗑</button></div>
    <div class="chips tagchips" data-tags hidden></div>
    <div class="chips">${['all', 'video', 'audio', 'image'].map((f) => `<button class="chip" data-f="${f}">${{ all: 'All', video: 'Video', audio: 'Audio', image: 'Photos' }[f]}</button>`).join('')}</div>
  </div>
  <div class="pool-grid${big ? ' big' : ''}" data-grid tabindex="0" aria-label="Media"></div>
  <div class="pool-foot" data-foot hidden>
    <span data-selinfo></span><span class="grow"></span>
    <button class="small accent" data-a="append">Add to timeline</button>
    <button class="small danger" data-a="remove">Remove</button>
  </div>`;
  const fileIn = $('[data-file]', el);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-more]')) { p.show = (p.show || POOL_STEP) + POOL_STEP; render(p); return; }
    if (e.target.closest('[data-relink]')) { import('./mediamgr.js').then((x) => x.openMediaMgr('relink')); return; }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'folder') importFolder();
    if (a === 'upload') fileIn.click();
    if (a === 'newitem') import('./newitem.js').then((m) => m.openNewItem(e.target.closest('[data-a]')));
    if (a === 'append') appendSelected();
    if (a === 'remove') removeSelected();
    if (a === 'delbin' && bin) removeFolder(bin);
    if (a === 'smart') openSmart();
    if (a === 'batch') openBatch([...poolSel]);
    if (a === 'find') openSmart('find', $('[data-search]', el).value.trim());
    const tg = e.target.closest('[data-tag]')?.dataset.tag;
    if (tg !== undefined) { tag = tag === tg ? '' : tg; renderAll(); }
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (f) { filter = f; renderAll(); }
  });
  fileIn.onchange = () => { if (fileIn.files.length) uploadFiles([...fileIn.files]); fileIn.value = ''; };
  $('[data-search]', el).oninput = (e) => { query = e.target.value.toLowerCase(); renderAll(); };
  // Enter: nothing by that name -> look for it in the pictures
  $('[data-search]', el).addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim() && (!visible().length || e.ctrlKey)) openSmart('find', e.target.value.trim()); });
  $('[data-bin]', el).onchange = (e) => { bin = e.target.value; renderAll(); };
  const grid = $('[data-grid]', el);
  grid.addEventListener('click', (e) => {
    const it = e.target.closest('.mi'); if (!it) { poolSel.clear(); renderAll(); return; }
    const id = it.dataset.id;
    if (e.shiftKey && poolSel.size) {
      const ids = visible().map((m) => m.id), a = ids.indexOf([...poolSel].pop()), b = ids.indexOf(id);
      ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => poolSel.add(x));
    } else if (e.ctrlKey || e.metaKey) poolSel.has(id) ? poolSel.delete(id) : poolSel.add(id);
    else poolSel = new Set([id]);
    renderAll();
  });
  grid.addEventListener('dblclick', (e) => { const it = e.target.closest('.mi'); if (it) emit('openSource', it.dataset.id); });
  grid.addEventListener('dragstart', (e) => {
    const it = e.target.closest('.mi'); if (!it) return;
    if (!poolSel.has(it.dataset.id)) { poolSel = new Set([it.dataset.id]); renderAll(); }
    e.dataTransfer.setData('text/x-media-id', [...poolSel].join(','));
    e.dataTransfer.effectAllowed = 'copy';
  });
  // hover-scrub: move the mouse across a thumbnail to flip through the clip
  grid.addEventListener('pointermove', (e) => {
    const th = e.target.closest('.mi-th[data-strip]'); if (!th) return;
    const b = th.getBoundingClientRect(), k = Math.min(11, Math.max(0, Math.floor(((e.clientX - b.left) / b.width) * 12)));
    th.style.backgroundImage = `url('${th.dataset.strip}')`; th.style.backgroundSize = '1200% 100%'; th.style.backgroundPosition = `${(k / 11) * 100}% 0`;
  });
  grid.addEventListener('pointerout', (e) => {
    const th = e.target.closest('.mi-th[data-strip]'); if (!th || th.contains(e.relatedTarget)) return;
    th.style.backgroundImage = `url('${th.dataset.thumb}')`; th.style.backgroundSize = 'cover'; th.style.backgroundPosition = 'center';
  });
  grid.addEventListener('contextmenu', (e) => {
    const it = e.target.closest('.mi'); if (!it) return;
    e.preventDefault();
    if (!poolSel.has(it.dataset.id)) { poolSel = new Set([it.dataset.id]); renderAll(); }
    const m = S.mediaById[it.dataset.id];
    const menu = h(`<div class="ctx" role="menu">
      <button data-c="src">Open in source viewer</button><button data-c="append">Add to end of timeline</button>
      <button data-c="logo"${m.kind !== 'image' ? ' hidden' : ''}>Use as logo</button><hr>
      <button data-c="path">Show file location</button><button data-c="redo">Re-read file</button><hr>
      <button data-c="remove">Remove from project</button></div>`);
    document.body.append(menu);
    menu.style.left = `${Math.min(e.clientX, innerWidth - 220)}px`; menu.style.top = `${Math.min(e.clientY, innerHeight - 240)}px`;
    const close = () => { menu.remove(); window.removeEventListener('pointerdown', out, true); };
    const out = (ev) => { if (!menu.contains(ev.target)) close(); };
    setTimeout(() => window.addEventListener('pointerdown', out, true));
    menu.onclick = async (ev) => {
      const c = ev.target.closest('[data-c]')?.dataset.c; if (!c) return; close();
      if (c === 'src') emit('openSource', m.id);
      if (c === 'append') appendSelected();
      if (c === 'logo') { S.project.logo = { ...S.project.logo, mediaId: m.id }; commit('Logo'); toast('Logo set'); }
      if (c === 'path') modal('File location', `<p class="mono">${esc(m.path)}</p>`);
      if (c === 'redo') { await api('POST', `/api/media/reprocess?p=${enc(S.proj)}&id=${m.id}`); refreshMedia(); }
      if (c === 'remove') removeSelected();
    };
  });
  render(p);
}

on('media', renderAll);
on('seq', renderAll); // (a renamed sequence renames its nested clip here too)
function renderAll() { pools.forEach(render); }
// a nested sequence's clip shows its sequence's current name (the stored name is from when it was last rendered)
function mName(m) {
  if (!m.seqOf || !S.project) return m.name;
  const s = seqList(S.project).find((x) => x.id === m.seqOf);
  return s ? `🎞 ${s.name}` : m.name;
}

const tagOk = (m, dups) => !tag || (tag === '!bad' ? !!m.bad?.length : tag === '!dup' ? dups.has(m.id) : m.tags?.includes(tag));
const visible = () => { const dups = dupIds(); return S.media.filter((m) => (filter === 'all' || m.kind === filter) && (!bin || (m.bin || '') === bin || (m.bin || '').startsWith(`${bin}/`))
  && tagOk(m, dups) && (!query || m.name.toLowerCase().includes(query) || (m.bin || '').toLowerCase().includes(query) || m.tags?.some((t) => t.startsWith(query)))); };

const POOL_STEP = 400;
function render(p) {
  const el = p.el;
  if (!el.isConnected && !el.offsetParent && !p.big && !el.closest('body')) return;
  $$('[data-f]', el).forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
  const bins = [...new Set(S.media.map((m) => m.bin || '').filter(Boolean).map((b) => b.split('/')[0]))].sort();
  const bs = $('[data-bin]', el);
  if (bin && !bins.includes(bin)) bin = '';
  $('[data-a="delbin"]', el).hidden = !bin;
  bs.innerHTML = `<option value="">All folders</option>${bins.map((b) => `<option${b === bin ? ' selected' : ''}>${esc(b)}</option>`).join('')}`;
  const q = S.queue, busy = q.quick + q.proxy;
  $('[data-q]', el).textContent = busy ? `Preparing ${q.quick ? `${q.quick} file${q.quick > 1 ? 's' : ''}` : ''}${q.quick && q.proxy ? ' · ' : ''}${q.proxy ? `${q.proxy} preview cop${q.proxy > 1 ? 'ies' : 'y'}` : ''}…` : `${S.media.length} items`;
  // shot tags (after a 🧠 Smart scan): only the tags some clip has, with how many
  const dups = dupIds(), tagged = S.media.filter((m) => m.tags);
  const tc = $('[data-tags]', el);
  tc.hidden = !tagged.length;
  if (tagged.length) {
    const count = (t) => tagged.filter((m) => m.tags.includes(t)).length, nb = S.media.filter((m) => m.bad?.length).length, nd = S.media.filter((m) => dups.has(m.id)).length;
    tc.innerHTML = TAGS.filter(([t]) => count(t)).map(([t, l]) => `<button class="chip${tag === t ? ' on' : ''}" data-tag="${t}">${l} ${count(t)}</button>`).join('')
      + (nb ? `<button class="chip warnchip${tag === '!bad' ? ' on' : ''}" data-tag="!bad" title="Too dark, soft, shaky or very short">⚠ ${nb}</button>` : '')
      + (nd ? `<button class="chip${tag === '!dup' ? ' on' : ''}" data-tag="!dup" title="Near-identical clips">⧉ ${nd}</button>` : '');
  }
  // ⚡ Phase 18: a few hundred tiles at a time - 6000 files drawn in two pools made every timeline change ~95 ms slower
  // (the browser lays them all out again). Search / filters / folders still look through everything.
  const all = visible(), key = `${filter}|${bin}|${query}|${tag}`;
  if (p.showKey !== key) { p.showKey = key; p.show = POOL_STEP; }
  const list = all.slice(0, p.show || POOL_STEP);
  const grid = $('[data-grid]', el);
  if (!S.media.length) {
    grid.innerHTML = `<div class="pool-empty"><b>No media yet</b><span>Click <b>+ Folder</b> and pick your raw footage folder. Clips are read in place - nothing is copied.</span></div>`;
  } else {
    const usedSet = usedIds(); // ⚡ once per draw (it was built again for every tile: 6000 files × 2000 clips)
    grid.innerHTML = list.map((m) => {
      const used = usedSet.has(m.id);
      const st = m.status !== 'ready' ? `<span class="mi-st">${m.status === 'offline' ? 'Offline' : m.status === 'error' ? 'Error' : 'Reading…'}</span>`
        : m.kind === 'video' && m.proxy !== 'ready' && m.proxy !== 'none' ? `<span class="mi-st">${m.proxy === 'error' ? 'No preview' : `Preview ${m.proxyPct || 0}%`}</span>` : '';
      const res = m.width >= 3800 ? '4K' : m.width >= 2500 ? '2.7K' : m.height >= 1080 || m.width >= 1920 ? 'HD' : '';
      return `<div class="mi${poolSel.has(m.id) ? ' sel' : ''}${m.status === 'offline' ? ' off' : ''}" data-id="${m.id}" draggable="true" title="${esc(mName(m))}${m.bin ? `\n${esc(m.bin)}` : ''}${m.tags ? `\n${esc(m.tags.join(' · '))}` : ''}${m.bad ? `\n⚠ ${esc(m.bad.join(', '))}` : ''}">
        <div class="mi-th k-${m.kind}" ${m.urls.thumb ? `style="background-image:url('${m.urls.thumb}')" data-thumb="${m.urls.thumb}"` : m.urls.wave ? `style="background-image:url('${m.urls.wave}');background-size:100% 70%"` : ''} ${m.urls.strip ? `data-strip="${m.urls.strip}"` : ''}>
          ${!m.urls.thumb && !m.urls.wave ? `<span class="mi-ic">${m.kind === 'audio' ? '♪' : '▣'}</span>` : ''}
          ${m.duration && m.kind !== 'image' ? `<span class="mi-d">${fmt(m.duration)}</span>` : ''}${res ? `<span class="mi-r">${res}</span>` : ''}${used ? '<span class="mi-u" title="Used in the timeline">●</span>' : ''}${st}
        </div>
        <div class="mi-n">${m.bad ? '<b class="warn">⚠</b> ' : ''}${dups.has(m.id) ? '<b class="muted">⧉</b> ' : ''}${esc(mName(m))}</div></div>`;
    }).join('') || '<div class="pool-empty">Nothing matches</div>';
    if (all.length > list.length) grid.insertAdjacentHTML('beforeend', `<button class="pool-more" data-more>Show ${Math.min(POOL_STEP, all.length - list.length)} more <span class="muted">(${all.length - list.length} left - or search above)</span></button>`);
    // 🗂 files gone from their place (moved, drive unplugged): one click to find and link them again
    const off = S.media.filter((m) => m.status === 'offline'), offUsed = off.filter((m) => usedSet.has(m.id)).length;
    if (off.length) grid.insertAdjacentHTML('afterbegin', `<button class="pool-off" data-relink>⚠ ${off.length} file${off.length > 1 ? 's' : ''} offline${offUsed ? ` (${offUsed} on the timeline)` : ''} - 🔗 Relink</button>`);
  }
  const foot = $('[data-foot]', el);
  foot.hidden = !poolSel.size;
  $('[data-selinfo]', el).textContent = `${poolSel.size} selected`;
}
function usedIds() { return new Set(S.project ? Object.values(S.project.tracks).flat().map((c) => c.mediaId) : []); }

// While files are being read, only the counts are asked for every 2 s; the whole list (≈3 MB and a redraw of every tile
// for a 5000-file project) comes at most every 15 s, and once when everything is read.
let lastFull = 0, lastReady = -1;
export async function refreshMedia() {
  if (!S.proj) return;
  const proj = S.proj;
  const r = await api('GET', `/api/media?p=${enc(proj)}`);
  if (proj !== S.proj) return;
  setMedia(r.items); S.queue = r.queue; lastFull = Date.now(); lastReady = r.items.filter((m) => m.status === 'ready').length;
  emit('media');
  clearTimeout(pollTimer);
  if (r.queue.quick + r.queue.proxy > 0 || r.items.some((m) => m.status !== 'ready' && m.status !== 'offline' && m.status !== 'error')) pollTimer = setTimeout(pollStatus, 2000);
}
async function pollStatus() {
  if (!S.proj) return;
  const proj = S.proj;
  let st;
  try { st = await api('GET', `/api/media/status?p=${enc(proj)}`); } catch { pollTimer = setTimeout(pollStatus, 4000); return; }
  if (proj !== S.proj) return;
  const done = !st.quick && !st.proxy, small = st.total < 400;
  if (done || st.total !== S.media.length || (st.ready !== lastReady && (small || Date.now() - lastFull > 15000))) return refreshMedia();
  S.queue = { quick: st.quick, proxy: st.proxy };
  $$('[data-q]').forEach((el) => (el.textContent = `Preparing ${st.quick ? `${st.quick} file${st.quick > 1 ? 's' : ''}` : ''}${st.quick && st.proxy ? ' · ' : ''}${st.proxy ? `${st.proxy} preview cop${st.proxy > 1 ? 'ies' : 'y'}` : ''}…`));
  pollTimer = setTimeout(pollStatus, 2000);
}

function appendSelected() {
  const ids = [...poolSel].filter((id) => S.mediaById[id]);
  if (!ids.length) return;
  let n = 0;
  for (const id of ids) { const m = S.mediaById[id]; if (placeMedia(id, m.kind === 'audio' ? 'A2' : 'V1', m.kind === 'audio' ? 0 : 1e9, S.sourceMarks?.[id] || {})) n++; }
  if (n) { commit(`Add ${n} clip${n > 1 ? 's' : ''}`); toast(`${n} added to the timeline`); }
}
// Remove a whole folder (bin, with its sub-folders) from the project. Files on the disk are never touched.
async function removeFolder(b) {
  const ids = new Set(S.media.filter((m) => (m.bin || '') === b || (m.bin || '').startsWith(`${b}/`)).map((m) => m.id));
  if (!ids.size) return;
  const onTl = Object.values(S.project.tracks).flat().filter((c) => ids.has(c.mediaId)).length;
  const d = modal('Remove folder', `<p>Remove the folder <b>${esc(b)}</b> (${ids.size} file${ids.size > 1 ? 's' : ''}) from this project?</p>
    <p class="muted small">Your original files stay on the disk - only the project forgets them. To get them back, import the folder again.</p>
    ${onTl ? `<p class="warn">${onTl} clip${onTl > 1 ? 's' : ''} on the timeline use${onTl > 1 ? '' : 's'} these files.</p>` : ''}
    <div class="dv-actions">${onTl ? '<button data-action="both" class="danger">Remove folder + its clips from the timeline</button><button data-action="keep">Remove folder only</button>' : '<button data-action="keep" class="danger">Remove folder</button>'}<button data-close>Cancel</button></div>`,
  { width: 520, onAction: async (a) => {
    d.close();
    if (a === 'both') {
      await saveNow('force'); // backup of the timeline as it was
      for (const t of Object.keys(S.project.tracks)) S.project.tracks[t] = S.project.tracks[t].filter((c) => !ids.has(c.mediaId));
      if (ids.has(S.project.logo?.mediaId)) S.project.logo.mediaId = '';
      commit(`Remove clips of ${b}`);
    }
    try {
      await api('DELETE', `/api/media?p=${enc(S.proj)}&id=${[...ids].join(',')}`);
      [...ids].forEach((id) => poolSel.delete(id)); bin = '';
      await refreshMedia();
      toast(`Folder "${b}" removed from the project${a === 'both' && onTl ? ` with its ${onTl} timeline clips` : ''}`);
    } catch (e) { toast(e.message, 'err'); }
  } });
}

async function removeSelected() {
  const ids = [...poolSel], used = usedIds(), inUse = ids.filter((i) => used.has(i)).length;
  if (!confirm(`Remove ${ids.length} item${ids.length > 1 ? 's' : ''} from this project?${inUse ? `\n\n${inUse} of them are on the timeline - those clips will show as missing.` : ''}\n\nYour original files are NOT deleted.`)) return;
  try { await api('DELETE', `/api/media?p=${enc(S.proj)}&id=${ids.join(',')}`); poolSel.clear(); await refreshMedia(); toast('Removed from project'); }
  catch (e) { toast(e.message, 'err'); }
}

export async function uploadFiles(files) {
  const bar = h('<div class="upbar"><span></span><div class="bar"><div></div></div></div>');
  document.body.append(bar);
  let done = 0, failed = 0;
  for (const f of files) {
    $('span', bar).textContent = `Uploading ${f.name} (${done + 1}/${files.length})`;
    try { const r = await upload(`/api/upload?p=${enc(S.proj)}&name=${enc(f.name)}`, f, (k) => ($('.bar div', bar).style.width = `${k * 100}%`)); if (r.kind === 'lut') emit('luts'); if (r.kind === 'subs') emit('subs'); done++; }
    catch (e) { failed++; toast(`${f.name}: ${e.message}`, 'err'); }
  }
  bar.remove();
  await refreshMedia();
  if (!failed) toast(`${done} file${done > 1 ? 's' : ''} added`);
}

// Upload one sound file from a file input, wait until the editor has read it (duration), then add it to `select`
// (a voice-over / music dropdown) and select it. Used by the Agent and Re-edit dialogs.
export async function uploadAudioInto(input, select) {
  const file = input.files[0]; if (!file) return null;
  input.value = '';
  const before = new Set(S.media.map((m) => m.id));
  await uploadFiles([file]);
  let m = null;
  // the server reads an uploaded file before anything else; ask about just that file (not the whole pool)
  m = S.media.find((x) => !before.has(x.id) && x.kind !== 'image');
  for (let i = 0; m && m.status !== 'ready' && m.status !== 'error' && i < 120; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    try { m = await api('GET', `/api/media/item?p=${enc(S.proj)}&id=${m.id}`); } catch { break; }
  }
  if (m?.status === 'ready' && !S.mediaById[m.id]?.duration) { S.mediaById[m.id] = m; S.media = S.media.map((x) => (x.id === m.id ? m : x)); if (!S.media.some((x) => x.id === m.id)) S.media.push(m); }
  if (!m || m.status !== 'ready') { toast('Could not read the uploaded sound file', 'err'); return null; }
  select.append(new Option(`${m.name} (${Math.floor(m.duration / 60)}:${String(Math.round(m.duration % 60)).padStart(2, '0')})`, m.id));
  select.value = m.id; select.dispatchEvent(new Event('change', { bubbles: true }));
  toast(`${m.name} ready`);
  return m;
}

export async function importFolder() {
  const folder = await pickFolder('Import a footage folder', 'Every video, photo and audio file inside (including sub-folders) is added. Files stay where they are.');
  if (!folder) return;
  try {
    const r = await api('POST', `/api/import?p=${enc(S.proj)}`, { folder });
    toast(r.added ? `${r.added} files imported${r.skipped ? ` (${r.skipped} already in the project)` : ''} - preparing previews…` : 'No new media files in that folder');
    refreshMedia();
  } catch (e) { toast(e.message, 'err'); }
}

// Folder picker backed by the server (browsers can't hand us real folder paths).
export function pickFolder(title = 'Choose a folder', note = '') {
  return new Promise((resolve) => {
    let cur = '', picked = null;
    const body = h(`<div class="fp">
      ${note ? `<p class="muted">${esc(note)}</p>` : ''}
      <div class="fp-path"><button class="small" data-up title="Up one level">↑</button><input data-path placeholder="Paste a folder path, e.g. Z:\\Shoots\\Chhattisgarh" aria-label="Folder path"><button class="small" data-go>Go</button></div>
      <div class="fp-list" data-list></div>
      <div class="fp-foot"><span data-info class="muted"></span><span class="grow"></span><button data-close>Cancel</button><button class="primary" data-use>Use this folder</button></div></div>`);
    const dlg = modal(title, body, { width: 640, onClose: () => resolve(picked) });
    const load = async (p) => {
      try {
        const r = await api('GET', `/api/fs?path=${enc(p || '')}`);
        cur = r.path; $('[data-path]', body).value = r.path;
        $('[data-list]', body).innerHTML = r.dirs.map((d) => `<button class="fp-dir" data-dir="${esc(d.path)}">📁 ${esc(d.name)}</button>`).join('') || '<div class="muted pad">No sub-folders</div>';
        $('[data-info]', body).textContent = r.path ? `${r.mediaCount} media file${r.mediaCount === 1 ? '' : 's'} here (sub-folders are included too)` : 'Pick a drive or folder';
        $('[data-use]', body).disabled = !r.path;
        $('[data-up]', body).disabled = !r.path;
        body.dataset.parent = r.parent ?? '';
      } catch (e) { toast(e.message, 'err'); }
    };
    body.addEventListener('click', (e) => {
      const d = e.target.closest('[data-dir]'); if (d) load(d.dataset.dir);
      if (e.target.closest('[data-up]')) load(body.dataset.parent || '');
      if (e.target.closest('[data-go]')) load($('[data-path]', body).value.trim());
      if (e.target.closest('[data-use]') && cur) { picked = cur; dlg.close(); }
    });
    $('[data-path]', body).addEventListener('keydown', (e) => { if (e.key === 'Enter') load(e.target.value.trim()); });
    load('');
  });
}
