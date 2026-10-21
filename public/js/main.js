// App shell: Home (projects) and the editor pages Media · Edit · Color · Audio · Deliver.
import { applyLook, icon, mountDock } from './ui2.js';
import { mountWorkspaces, openWorkspaceMenu, current as currentWorkspace } from './workspaces.js';
import { mountSourceMonitor } from './sourcemon.js';
import { copyClips, pasteClips, syncClipboard } from './clipboard.js';
import { S, on, emit, commit, undo, redo, canUndo, canRedo, resetHistory, saveNow, setMedia, RECOVER_KEY, CLIENT, connectLive, disconnectLive, sendPresence, restoreMySeq, findClip } from './store.js';
import { openTeam } from './team.js';
import { api, enc } from './api.js';
import { $, $$, h, esc, toast } from './ui.js';
import { renderHome } from './home.js';
import { mountPool, refreshMedia, uploadFiles } from './mediapool.js';
import { mountTimeline, splitAtPlayhead, trimAtPlayhead, deleteSelected, duplicateSelected, addTitle, setTool, setZoom, fitZoom, unlinkSelected } from './timeline.js';
import { mountViewer, toggle, shuttle, seek, isPlaying, isPlayingProgram, viewerMode, pause, setMode, sourceKey, toggleFullscreen } from './player.js';
import { mountInspector } from './inspector.js';
import { mountFxPanel } from './fxpanel.js';
import { mountCapsPanel, refreshCaps } from './capspanel.js';
import { openBrandKit } from './library.js';
import { mountDeliver, showDeliver, hideDeliver, pollQueue } from './deliver.js';
import { openAgent, showReport, resumeAgentJob } from './agent.js';
import { openReedit } from './reedit.js';
import { openAiUndo } from './aiundo.js';
import { openActivity } from './activity.js';
import { openZones } from './zones.js';
import { openMediaMgr } from './mediamgr.js';
import { mountAssistant, toggleAssistant } from './assistant.js';
import { mountColor, showColor, hideColor } from './colorpage.js';
import { mountAudio, showAudio, hideAudio } from './audiopage.js';
import { layout, duration } from './store.js';
import { openSequences, seqName, openSequence, nestSelected } from './sequences.js';
import { keyOf, commandFor, keyState, stepMany } from './keys.js';
import { openShortcuts } from './keysui.js';
import { linkedIds, uid, setTransition } from './model.js';
import { mountNotesPanel, addNote, watchPhoneNotes, openVersions, refreshNotes } from './review.js';
import { loadFootage } from './smart.js';
import { mountText, showText, hideText } from './textedit.js';
import { mountMotion, showMotion, hideMotion, openCompClip } from './motionpage.js';
import { mountFusion, showFusion, hideFusion, openFusionClip } from './fusionpage.js';
import { mountMenuBar, openLogo, openBackups } from './menubar.js';
import { openTemplates } from './titlesui.js';
import { openAudioGain } from './audiogain.js';
import './presence.js'; // 📊 session time (Team & users > Sessions)

applyLook(); // 🖥 Studio (Premiere-style) look unless this browser chose Classic (⚙ in the header)
window.addEventListener('focus', () => { if (S.proj) syncClipboard(); });
// in the Studio look the program monitor shows the timeline only (clips open in the Source monitor beside it)
document.addEventListener('ve-look', () => { if (document.documentElement.classList.contains('ui2') && viewerMode() === 'source') setMode('program'); });

const app = $('#app');
app.innerHTML = '<div id="home"></div><div id="editor" hidden></div>';
const homeEl = $('#home'), editorEl = $('#editor');
const PAGES = [['media', 'Media'], ['edit', 'Edit'], ['motion', 'Motion'], ['fusion', 'Fusion'], ['color', 'Color'], ['audio', 'Audio'], ['deliver', 'Deliver']];

function shell() {
  editorEl.innerHTML = `
  <header class="top">
    <div class="tb-left">
      <button class="brand" data-a="home" title="All projects"><img class="logo-mark" src="/img/limelight-icon.png" alt=""><span class="wordmark">LIME<em>LIGHT</em><small>EDITOR</small></span></button>
      <span class="pname" id="pName"></span><button class="seqbtn" data-a="seq" title="Sequences: several timelines in this project (film, teaser, reel…), nesting, versions">🎞 <span id="seqName"></span> ▾</button><span class="save" id="saveState"></span>
    </div>
    <div class="tb-right">
      <span class="jobchip" id="jobChip" hidden></span>
      <button class="jobchip qchip" id="queueChip" data-a="deliver" title="Render queue - open Export" hidden></button>
      <span class="people" id="peopleChip" hidden></span>
      <span class="me" id="meChip" hidden></span>
      <div class="tgroup" role="group" aria-label="History">
        <button class="icon-btn" data-a="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon('undo')}</button>
        <button class="icon-btn" data-a="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${icon('redo')}</button>
        <button class="icon-btn ai-undo-btn" data-a="aiundo" title="↶ AI Undo: bring back the edit as it was before an Agent edit, Re-edit or Claude change (works after a refresh too)" aria-label="AI undo">${icon('aiundo')}</button>
        <button class="icon-btn" data-a="versions" title="Versions: go back to an earlier edit, or save this one with a name" aria-label="Versions">${icon('versions')}</button>
      </div>
      <div class="tgroup" role="group" aria-label="Team and project">
        <button class="icon-btn" data-a="team" title="Team: other computers in the office edit too (logins, roles, shared folders)" aria-label="Team" hidden>${icon('team')}</button>
        <button class="icon-btn" data-a="activity" title="Activity: who changed what on this project - take back one person's one change" aria-label="Activity">${icon('activity')}</button>
        <button class="icon-btn" data-a="zones" title="Zones: who owns which part of the timeline - warns before you change someone else's part" aria-label="Zones">${icon('zones')}</button>
        <button class="icon-btn" data-a="mediamgr" title="Media manager: relink offline files, pack the project, clean up disk" aria-label="Media manager">${icon('media')}</button>
        <button class="icon-btn" data-a="brand" title="Brand kit (logo, colours, intro/outro) and project templates" aria-label="Brand kit">${icon('brand')}</button>
        <button class="icon-btn" data-a="report" title="Report: which shot the agent chose for which line, and why" aria-label="Report">${icon('report')}</button>
      </div>
      <div class="tgroup" role="group" aria-label="AI">
        <button class="accent" data-a="agent" title="Let the agent make the whole edit from your footage, voice-over and music">${icon('agent')}Agent</button>
        <button data-a="reedit" title="Change the voice-over, music, pace or format and let the agent rebuild this edit">${icon('reedit')}Re-edit</button>
        <button data-a="assistant" title="Type what to change, e.g. &quot;music dheema karo&quot;, &quot;make the colour warm&quot;, &quot;remove the 3rd shot&quot;…">${icon('assistant')}Assistant</button>
      </div>
      <button class="ws-btn" data-a="workspace" title="Workspaces: Premiere Pro, DaVinci Resolve, Limelight or your own - resize, swap and save panel layouts">${icon('zones')}<span class="ws-name">${esc(currentWorkspace().name)}</span> ▾</button>
      <button data-a="shortcuts" title="Keyboard shortcuts: see every key and set your own (Ctrl+Alt+K)">⌨ Shortcuts</button>
      <button class="primary" data-a="deliver">${icon('export')}Export</button>
    </div>
  </header>
  <main class="pages">
    <section class="page p-media" data-page="media" hidden>
      <div class="media-page"><div class="panel pool-big" id="poolBig"></div>
        <div class="panel media-help"><h2>Bring in footage</h2>
          <ol><li><b>+ Folder</b> - pick the raw folder (sub-folders included). Clips stay where they are.</li>
          <li>Camera files (MXF, 4K, 10-bit) get a small preview copy in the background - editing starts right away.</li>
          <li>Double-click a clip to open it in the Source viewer, mark In/Out, then Insert / Append / Overlay.</li>
          <li>Or drag clips straight onto the timeline.</li></ol>
          <h2>LUTs</h2><p class="muted">Upload <b>.cube</b> files with Upload (or copy them into the <span class="mono">LUTs</span> folder) to use them in Color.</p>
        </div></div>
    </section>
    <section class="page p-edit" data-page="edit">
      <div class="edit-grid">
        <div class="panel pool pool-tabs"><div class="ptabs" role="tablist"><button role="tab" data-ptab="media" aria-selected="true">Media</button><button role="tab" data-ptab="fx" aria-selected="false">✨ Effects</button><button role="tab" data-ptab="cc" aria-selected="false" title="Captions">CC</button><button role="tab" data-ptab="notes" aria-selected="false" title="Notes at moments of the edit (Shift+M), versions and phone review">📝</button></div>
          <div class="ptab-body" id="pool"></div><div class="ptab-body" id="fxPanel" hidden></div><div class="ptab-body" id="ccPanel" hidden></div><div class="ptab-body" id="notesPanel" hidden></div></div>
        <div class="panel viewer" id="viewer"></div>
        <div class="ui-dock" role="tablist" aria-label="Source / Effect Controls"><button role="tab" data-dock="src">Source</button><button role="tab" data-dock="ec">Effect Controls</button></div>
        <div class="panel srcmon" id="srcMon"></div>
        <div class="panel inspector" id="inspector"></div>
        <div class="panel timeline" id="timeline"></div>
      </div>
    </section>
    <section class="page" data-page="text" id="textPage" hidden></section>
    <section class="page" data-page="motion" id="motionPage" hidden></section>
    <section class="page" data-page="fusion" id="fusionPage" hidden></section>
    <section class="page" data-page="color" id="colorPage" hidden></section>
    <section class="page" data-page="audio" id="audioPage" hidden></section>
    <section class="page" data-page="deliver" id="deliverPage" hidden></section>
  </main>
  <nav class="pagebar" aria-label="Pages">${PAGES.map(([k, l]) => `<button data-page-btn="${k}">${l}</button>`).join('')}</nav>`;
  mountMenuBar(editorEl, runMenu); // ☰ File · Edit · Clip · Sequence · Markers · Graphics and Titles · View · Window · Help
  mountWorkspaces(editorEl.querySelector('.edit-grid')); // 🪟 workspaces: Premiere / Resolve / Limelight / your own layouts
  mountSourceMonitor($('#srcMon')); mountDock(editorEl.querySelector('.edit-grid')); // 🎬 Premiere's two monitors (Studio look)
  editorEl.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'home') goHome();
    if (a === 'workspace' || a === 'look') openWorkspaceMenu(e.target.closest('[data-a]'));
    if (a === 'shortcuts') openShortcuts();
    if (a === 'undo') doUndo();
    if (a === 'redo') doRedo();
    if (a === 'agent') openAgent(setBusy);
    if (a === 'report') showReport();
    if (a === 'reedit') openReedit(setBusy);
    if (a === 'assistant') toggleAssistant();
    if (a === 'brand') openBrandKit(setBusy);
    if (a === 'deliver') showPage('deliver');
    if (a === 'seq') openSequences();
    if (a === 'versions') openVersions();
    if (a === 'aiundo') openAiUndo();
    if (a === 'activity') openActivity();
    if (a === 'zones') openZones();
    if (a === 'mediamgr') openMediaMgr();
    if (a === 'team') openTeam();
    const p = e.target.closest('[data-page-btn]')?.dataset.pageBtn;
    if (p) showPage(p);
  });
  mountPool($('#pool'));
  mountFxPanel($('#fxPanel'));
  mountCapsPanel($('#ccPanel'));
  mountNotesPanel($('#notesPanel'));
  editorEl.querySelector('.ptabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-ptab]')?.dataset.ptab; if (t) selectTab(t);
  });
  mountPool($('#poolBig'), { big: true });
  mountViewer($('#viewer'));
  mountInspector($('#inspector'));
  mountTimeline($('#timeline'));
  mountDeliver($('#deliverPage'));
  mountText($('#textPage'));
  mountMotion($('#motionPage')); // 🎬 After Effects-style compositions
  mountFusion($('#fusionPage')); // ✨ Resolve Fusion-style node effects
  mountColor($('#colorPage'));
  mountAudio($('#audioPage'));
  mountAssistant(setBusy);
}

// a menu item (menubar.js): a keyboard command, a top-bar button, a page, or one of these
function runMenu(r) {
  const [kind, x] = r.includes(':') ? r.split(':') : [r, ''];
  if (kind === 'k') { if (ACTIONS[x]?.() === false) toast('Select something first'); return; }
  if (kind === 'a') return editorEl.querySelector(`header [data-a="${x}"]`)?.click();
  if (kind === 'p') return showPage(x);
  const edit = () => { if (S.page !== 'edit') showPage('edit'); };
  if (r === 'import') { edit(); selectTab('media'); return $('#pool [data-file]')?.click(); }
  if (r === 'logo') return openLogo();
  if (r === 'backups') return openBackups();
  if (r === 'titles') return openTemplates();
  if (r === 'accurate') return emit('accuratePreview');
  if (r === 'fx' || r === 'cc') { edit(); return selectTab(r); }
  if (r === 'ec') { edit(); return editorEl.querySelector('.ui-dock [data-dock="ec"]')?.click(); }
  if (r === 'gyro') { edit(); if (S.sel.size !== 1) return toast('Select one video clip first'); return emit('inspect', 'gyro'); }
}
function selectTab(t) {
  editorEl.querySelectorAll('[data-ptab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.ptab === t)));
  $('#pool').hidden = t !== 'media'; $('#fxPanel').hidden = t !== 'fx'; $('#ccPanel').hidden = t !== 'cc'; $('#notesPanel').hidden = t !== 'notes';
  if (t === 'cc') refreshCaps();
  if (t === 'notes') refreshNotes();
}
on('notesTab', () => { if (S.page !== 'edit') showPage('edit'); selectTab('notes'); });
on('reloadProject', () => openProject(S.proj));

// ---- 👥 who am I (viewers only watch; everyone else edits together - 🔴 live) ----
async function whoAmI() {
  try { S.me = await api('GET', '/api/me'); } catch { S.me = { role: 'owner', local: true }; }
  const chip = $('#meChip'); if (!chip) return;
  chip.hidden = !!S.me.local;
  chip.innerHTML = S.me.local ? '' : `${esc(S.me.name)} · ${S.me.role} <a href="/team/logout" title="Sign out">⎋</a>`;
  $('[data-a="team"]').hidden = !(S.me.local && S.me.role === 'owner');
}
on('readonly', (x) => {
  let b = $('#roBanner');
  if (!S.readOnly) { b?.remove(); return; }
  if (!b) { b = h('<div id="roBanner" class="ro-banner" role="status"></div>'); $('.top').after(b); }
  b.textContent = S.me?.role === 'viewer' ? '👁 View only - you can watch and play, not change this project.'
    : S.lockHolder && S.lockHolder === S.me?.name ? '🔒 Read only - this project is open in another tab or computer of yours. Close it there (editing opens up here within a minute).'
    : `🔒 Read only - ${S.lockHolder || 'someone'} is editing this project. You can watch; editing opens up when they close it.`;
  if (x?.tried) toast(`Not changed - ${S.me?.role === 'viewer' ? 'you are a viewer' : `${S.lockHolder} is editing`}`, 'err');
});

function setBusy(b, label) { const c = $('#jobChip'); c.hidden = !b; c.textContent = label || ''; }
on('job', (j) => setBusy(j.running, j.label));
on('queue', (q) => { const c = $('#queueChip'); if (!c) return; c.hidden = !q.count; c.textContent = q.label; });
// 🔴 live: who else has this project open (their colour = their selection / playhead on the timeline)
on('presence', () => {
  const el = $('#peopleChip'); if (!el) return;
  const ppl = S.people || [];
  el.hidden = !ppl.length;
  el.innerHTML = ppl.slice(0, 8).map((x) => `<span class="pp" style="--pc:${x.color}" title="${esc(x.name)}${x.page ? ` · ${x.page} page` : ''}">${esc(initials(x.name))}</span>`).join('') +
    (ppl.length > 8 ? `<span class="pp more" title="${esc(ppl.slice(8).map((x) => x.name).join(', '))}">+${ppl.length - 8}</span>` : '') +
    `<span class="pp-n">${ppl.length + 1} editing</span>`;
});
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase();
let actTimer = null;
on('liveActivity', (a) => {
  const el = $('#saveState'); if (!el) return;
  el.textContent = `${a.name}: ${a.label}`; el.className = 'save live';
  clearTimeout(actTimer); actTimer = setTimeout(() => emit('save'), 2500);
});
on('select', sendPresence);
on('playhead', () => { if (!isPlayingProgram()) sendPresence(); });
on('save', () => {
  const el = $('#saveState'); if (!el) return;
  el.textContent = { saved: 'All changes saved', saving: 'Saving…', dirty: 'Saving…', error: 'Not saved - is the editor running?' }[S.saveState];
  el.className = `save ${S.saveState}`;
});
on('change', () => { $('[data-a="undo"]').disabled = !canUndo(); $('[data-a="redo"]').disabled = !canRedo(); });
on('live', () => emit('mix'));
on('deleteSelected', deleteSelected);
on('duplicateSelected', duplicateSelected);
on('splitAtPlayhead', splitAtPlayhead);
// double-click a clip on the timeline: like Premiere, its file opens in the Source monitor with the clip's own In / Out
// marked (titles, graphics and adjustment layers have no file - they are just selected)
function openComp(c) { openCompClip(c); showPage('motion'); }
on('openComp', openComp);
function openFusion(c) { openFusionClip(c); showPage('fusion'); }
on('openFusion', openFusion);
on('openClip', (id) => {
  S.sel = new Set([id]); emit('select');
  const f = findClip(id), c = f?.clip, m = c?.mediaId && S.mediaById[c.mediaId];
  if (c?.type === 'graphic' && c.gfx?.tpl === 'comp') return openComp(c); // 🎬 a Motion comp: open it on the Motion page
  if (c?.type === 'graphic' && c.gfx?.tpl === 'fusion') return openFusion(c); // ✨ a Fusion: open it on the Fusion page
  if (!m) return;
  // a nested sequence: open that sequence (its inside), like Premiere
  if (m.seqOf && S.project.sequences?.[m.seqOf]) return openSequence(m.seqOf);
  if (m.kind !== 'image') S.sourceMarks[m.id] = { in: +(c.in || 0), ...(c.out !== undefined ? { out: +c.out } : {}) };
  emit('openSource', { id: m.id, t: +(c.in || 0) });
});
on('openSource', () => { if (S.page !== 'edit') showPage('edit'); });
on('aspect', () => emit('change', {}));
const showSeq = () => { const el = $('#seqName'); if (el) el.textContent = seqName(); };
on('seq', showSeq);
on('change', showSeq);
on('luts', loadLuts);
on('fit', () => setTimeout(fitZoom, 60));
on('gotoPage', (p) => showPage(p));
on('openProject', async (name) => { await saveNow(true); openProject(name); });

function doUndo() { const l = undo(); toast(l ? `Undo: ${l}` : 'Nothing to undo'); }
function doRedo() { const l = redo(); toast(l ? `Redo: ${l}` : 'Nothing to redo'); }

export function showPage(p) {
  S.page = p;
  $$('[data-page]').forEach((s) => (s.hidden = s.dataset.page !== p));
  $$('[data-page-btn]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.pageBtn === p)));
  if (p === 'deliver') showDeliver(); else hideDeliver();
  if (p === 'color') showColor(); else hideColor();
  if (p === 'audio') showAudio(); else hideAudio();
  if (p === 'text') showText(); else hideText();
  if (p === 'motion') showMotion(); else hideMotion();
  if (p === 'fusion') showFusion(); else hideFusion();
  if (p !== 'edit' && p !== 'audio') pause();
  emit('change', {});
  try { localStorage.setItem('ve-page', p); } catch {}
}

async function loadLuts() { try { S.luts = await api('GET', `/api/luts?p=${enc(S.proj)}`); } catch { S.luts = []; } emit('select'); }

// 🛡 a step of opening a project that goes wrong is logged and skipped - the project stays open (only a project that
// cannot be read at all goes back to Home)
const safely = (label, fn) => { try { const r = fn(); return r?.catch ? r.catch((e) => console.error(`${label} failed`, e)) : r; } catch (e) { console.error(`${label} failed`, e); } };
async function openProject(name) {
  let project;
  try { project = await api('GET', `/api/project?p=${enc(name)}`); }
  catch (e) { toast(e.message, 'err'); goHome(); return; }
  try {
    S.liveRev = project._rev || 0; delete project._rev;
    let recovered = null;
    // changes this browser kept that never reached the server (tab crashed / editor closed while saving)
    let local = null;
    try { local = JSON.parse(localStorage.getItem(RECOVER_KEY(name)) || 'null'); } catch {}
    if (local?.project && local.at > (project.modified || 0) + 1500 && JSON.stringify(local.project.tracks) !== JSON.stringify(project.tracks)) {
      if (confirm(`"${name}" has changes from ${new Date(local.at).toLocaleString()} that were not saved (the editor or the browser closed too early).\n\nOK = bring them back · Cancel = keep the saved version`)) recovered = local.project;
    }
    try { localStorage.removeItem(RECOVER_KEY(name)); } catch {}
    S.proj = name; S.project = project; S.sel.clear(); S.playhead = 0;
    // the agreed copy is taken now, before any panel fills in a missing part (captions, defaults…) while the page is
    // built: such a part is then a change like any other and reaches the server with the next edit (it used to be
    // taken after, so the server never got it - and every later caption edit went to a path the server did not have)
    resetHistory();
    if (!editorEl.querySelector('.top')) safely('Building the editor', shell);
    homeEl.hidden = true; editorEl.hidden = false;
    $('#pName').textContent = name;
    document.title = `${name} - Limelight Editor`;
    history.replaceState(null, '', `#/p/${enc(name)}`);
    // recovered changes go to the server like any other change (only what differs from the saved project)
    if (recovered) { delete recovered._rev; S.project = recovered; commit('Recovered changes'); }
    safely('Live editing', connectLive);
    safely('My sequence', restoreMySeq); // 🎞 the sequence this browser had open (only here - nobody else's timeline changes)
    safely('Clipboard', syncClipboard); // 📋 what was copied in another tab / browser / link
    await Promise.all([safely('Media', refreshMedia), safely('LUTs', loadLuts), safely('Footage search', loadFootage), api('GET', '/api/health').then((hh) => (S.health = hh)).catch(() => {})]);
    let pg = 'edit'; try { pg = localStorage.getItem('ve-page') || 'edit'; } catch {}
    if (!PAGES.some(([k]) => k === pg)) pg = 'edit'; // (a page no longer in the bar, e.g. the old Text page)
    safely('Page', () => showPage(S.media.length ? (pg === 'deliver' ? 'edit' : pg) : 'media'));
    safely('Viewer', () => setMode('program')); // also refreshes the viewer title when switching projects
    // everyone with edit rights edits together (🔴 live); only viewers watch
    await safely('Who am I', whoAmI); S.readOnly = S.me?.role === 'viewer'; S.lockHolder = null; emit('readonly', {}); safely('Presence', sendPresence);
    safely('Agent job', () => resumeAgentJob(setBusy)); // an agent edit still running on the server (page refreshed / reopened)
    safely('Render queue', pollQueue); // renders still running / waiting in the background queue
    safely('Phone notes', watchPhoneNotes); // notes sent from a phone (📱 review)
    emit('change', {}); emit('save');
    setTimeout(fitZoom, 50);
  } catch (e) { console.error('openProject: a step failed - the project stays open', e); toast(`Something in this project could not be shown (${e.message}) - the rest works`, 'err'); }
}

async function goHome() {
  if (S.proj) await saveNow(true);
  disconnectLive(); S.readOnly = false; $('#roBanner')?.remove();
  pause?.();
  S.proj = null; S.project = null;
  history.replaceState(null, '', '#/');
  document.title = 'Limelight Editor';
  editorEl.hidden = true; homeEl.hidden = false;
  renderHome(homeEl, openProject);
}

// ---------------- keyboard ----------------
// ⌨ every key runs a command of the chosen preset (keys.js: Premiere Pro default, Limelight Classic or the user's own -
// Keyboard Shortcuts window, Ctrl+Alt+K). An action returning false lets the browser have the key.
const fpsNow = () => S.project.settings.fps;
const seekBy = (dt) => { if (viewerMode() === 'program') { pause(); emit('seek', S.playhead + dt); } };
const v1At = (t = S.playhead) => layout().V1.filter((x) => t >= x.start && t < x.end && !x.clip.gap).pop();
const goEdge = (dir) => {
  const edges = [...new Set(Object.values(layout()).flat().flatMap((x) => [x.start, x.end]))].sort((a, b) => a - b);
  const t = dir < 0 ? [...edges].reverse().find((x) => x < S.playhead - 0.01) : edges.find((x) => x > S.playhead + 0.01);
  if (t !== undefined) emit('seek', t);
};
const goMarker = (dir) => {
  const ts = (S.project.markers || []).map((m) => m.t).sort((a, b) => a - b);
  const t = dir < 0 ? [...ts].reverse().find((x) => x < S.playhead - 0.01) : ts.find((x) => x > S.playhead + 0.01);
  if (t !== undefined) emit('seek', t); else toast(dir < 0 ? 'No marker before the playhead' : 'No marker after the playhead');
};
const src = (k, shift = false) => { if (!sourceKey(k, shift)) toast('Open a clip in the Source monitor first (double-click it in Media or on the timeline)'); };
let mouseAt = [0, 0];
document.addEventListener('pointermove', (e) => { mouseAt = [e.clientX, e.clientY]; }, { passive: true });
const ACTIONS = {
  undo: doUndo, redo: doRedo, save: () => { saveNow(true).then(() => toast('Saved (backup kept)')); },
  copy: () => (S.page === 'edit' && S.sel.size && !window.getSelection()?.toString() && copyClips() ? undefined : false),
  cut: () => { if (S.page !== 'edit' || !S.sel.size) return false; if (copyClips()) deleteSelected(); },
  paste: () => { if (S.page !== 'edit') return false; pasteClips().catch((err) => toast(err.message, 'err')); },
  selectAll: () => { if (S.page !== 'edit') return false; S.sel = new Set(Object.entries(S.project.tracks).filter(([t]) => !S.project.trackState[t]?.lock).flatMap(([, l]) => l.map((c) => c.id))); emit('select'); toast(`${S.sel.size} clips selected`); },
  deselectAll: () => { S.sel.clear(); emit('select'); },
  exportMedia: () => showPage('deliver'), shortcuts: () => openShortcuts(),
  playStop: () => toggle(), shuttleL: () => shuttle('j'), shuttleStop: () => shuttle('k'), shuttleR: () => shuttle('l'),
  stepBack: () => { if (!sourceKey('left', false)) seekBy(-1 / fpsNow()); }, stepFwd: () => { if (!sourceKey('right', false)) seekBy(1 / fpsNow()); },
  stepBack5: () => { if (!sourceKey('left', true)) seekBy(-stepMany(keyState().preset, fpsNow()) / fpsNow()); },
  stepFwd5: () => { if (!sourceKey('right', true)) seekBy(stepMany(keyState().preset, fpsNow()) / fpsNow()); },
  prevEdit: () => goEdge(-1), nextEdit: () => goEdge(1), goStart: () => emit('seek', 0), goEnd: () => emit('seek', duration()),
  matchFrame: () => { // the shot under the playhead opens in the Source monitor at the same frame
    const x = v1At(), m = x && S.mediaById[x.clip.mediaId];
    if (!m || m.kind === 'image') return toast('No video shot under the playhead');
    emit('openSource', { id: m.id, t: +((x.clip.in || 0) + (S.playhead - x.start) * (x.clip.speed || 1)).toFixed(3) });
  },
  markIn: () => src('i'), markOut: () => src('o'), goIn: () => src('i', true), goOut: () => src('o', true), insert: () => src(','), overwrite: () => src('.'),
  selectTool: () => setTool('select'), razorTool: () => setTool('blade'), typeTool: () => addTitle(),
  rippleTool: () => setTool('ripple'), rollingTool: () => setTool('rolling'), rateTool: () => setTool('rate'), penTool: () => setTool('pen'), remixTool: () => setTool('remix'),
  addEdit: () => splitAtPlayhead(), addEditAll: () => { S.sel = new Set(); splitAtPlayhead(); },
  rippleTrimPrev: () => trimAtPlayhead('start'), rippleTrimNext: () => trimAtPlayhead('end'),
  clear: () => deleteSelected(false), rippleDelete: () => deleteSelected(true), duplicate: () => duplicateSelected(),
  transition: () => { // a cross dissolve on the selected main-story clips, or on the cut nearest the playhead
    const L = layout().V1; let xs = L.filter((x, i) => i > 0 && S.sel.has(x.clip.id));
    if (!xs.length) { const near = L.slice(1).sort((a, b) => Math.abs(a.start - S.playhead) - Math.abs(b.start - S.playhead))[0]; if (near) xs = [near]; }
    if (!xs.length) return toast('Put the playhead near a cut on the main story');
    for (const x of xs) setTransition(S.project, S.mediaById, S.project.tracks.V1.indexOf(x.clip), 'fade', 0.5); // (cuts stay put)
    commit(xs.length > 1 ? `Cross dissolve on ${xs.length} cuts` : 'Cross dissolve'); toast('Cross dissolve added (0.5 s)');
  },
  selectAtPlayhead: () => { const x = v1At(); if (!x) return toast('No clip under the playhead'); S.sel = linkedIds(S.project, [x.clip.id]); emit('select'); },
  link: () => {
    const sel = [...S.sel].map((id) => findClip(id)).filter(Boolean);
    if (sel.some((f) => f.clip.link)) return unlinkSelected();
    const v = sel.find((f) => f.clip.type === 'video'), a = sel.find((f) => f.clip.type === 'audio' && f.clip.mediaId === v?.clip.mediaId);
    if (!v || !a) return toast('Select a video clip and its audio clip (same file) to link them');
    const l = uid(); v.clip.link = l; a.clip.link = l; v.clip.mute = true; commit('Link'); toast('Linked: the picture and its sound move together');
  },
  enable: () => { const sel = [...S.sel].map((id) => findClip(id)?.clip).filter(Boolean); if (!sel.length) return toast('Select a clip first'); const off = !sel.every((c) => c.disabled); for (const c of sel) c.disabled = off || undefined; commit(off ? 'Disable' : 'Enable'); },
  snap: () => { S.snap = !S.snap; emit('change', {}); toast(`Snapping ${S.snap ? 'on' : 'off'}`); },
  nest: () => nestSelected(),
  audioGain: () => openAudioGain(),
  marker: () => { (S.project.markers ||= []).push({ t: +S.playhead.toFixed(3) }); commit('Marker'); },
  nextMarker: () => goMarker(1), prevMarker: () => goMarker(-1), note: () => addNote(),
  zoomIn: () => setZoom(S.zoom * 1.25, true), zoomOut: () => setZoom(S.zoom / 1.25, true), zoomFit: () => fitZoom(),
  maximize: () => { // the panel under the mouse fills the window (again = back), like Premiere's ` key
    const cur = document.querySelector('.panel-max');
    if (cur) { cur.classList.remove('panel-max', 'panel-full'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); window.dispatchEvent(new Event('resize')); return; }
    const p = document.elementFromPoint(...mouseAt)?.closest('.panel');
    if (!p) return toast('Point the mouse at a panel, then press the ` key');
    p.classList.add('panel-max'); window.dispatchEvent(new Event('resize'));
  },
  // Ctrl+`: like Premiere, the panel under the mouse goes full screen (timeline, media, effects…); the Program monitor
  // shows just the picture. Again or Esc = back. (The page goes full screen, so menus and dialogs still work in it.)
  fullscreen: () => {
    if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
    const full = document.querySelector('.panel-full'); // (filling the window when the browser refused full screen)
    if (full) { full.classList.remove('panel-max', 'panel-full'); window.dispatchEvent(new Event('resize')); return; }
    const p = document.elementFromPoint(...mouseAt)?.closest('.panel');
    if (!p || p.querySelector('#vwStage')) return toggleFullscreen();
    document.querySelector('.panel-max')?.classList.remove('panel-max', 'panel-full');
    p.classList.add('panel-max', 'panel-full');
    document.documentElement.requestFullscreen().then(() => toast('Full screen - Ctrl+` or Esc to come back'))
      .catch(() => toast('Full screen not allowed here - the panel fills the window instead (` or Ctrl+` to come back)'));
    window.dispatchEvent(new Event('resize'));
  },
};
// leaving full screen (Esc, Ctrl+` or the browser): the full-screen panel goes back to its place
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) return;
  const p = document.querySelector('.panel-full'); if (!p) return;
  p.classList.remove('panel-max', 'panel-full'); window.dispatchEvent(new Event('resize'));
});
document.addEventListener('keydown', (e) => {
  if (!S.project || document.querySelector('dialog[open]')) return;
  const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]');
  const combo = keyOf(e); if (!combo) return;
  const id = commandFor(combo); if (!id) return;
  if (typing && id !== 'save') return; // (typing a text: only Ctrl+S still saves)
  const r = ACTIONS[id]?.(e);
  if (r !== false) e.preventDefault();
});

// Files dropped anywhere on the editor are imported instead of the browser opening them.
document.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  if (S.proj && e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
});

// ---------------- start ----------------
const m = /^#\/p\/(.+)$/.exec(location.hash);
if (m) openProject(decodeURIComponent(m[1])); else goHome();
