// App shell: Home (projects) and the editor pages Media · Edit · Color · Audio · Deliver.
import { ic } from './lineicons.js';
import { reportError } from './errlog.js';
import { applyLook, icon, mountDock, mountMonDock } from './ui2.js';
import { mountWorkspaces, openWorkspaceMenu, current as currentWorkspace } from './workspaces.js';
import { mountSourceMonitor } from './sourcemon.js';
import { copyClips, pasteClips, syncClipboard } from './clipboard.js';
import { S, on, emit, commit, undo, redo, canUndo, canRedo, resetHistory, saveNow, setMedia, RECOVER_KEY, CLIENT, connectLive, disconnectLive, sendPresence, restoreMySeq, findClip } from './store.js';
import { openTeam } from './team.js';
import { mountChatDock } from './chatdock.js';
import { api, enc } from './api.js';
import { $, $$, h, esc, toast } from './ui.js';
import { renderHome, openXmlFile } from './home.js';
import { mountPool, refreshMedia, uploadFiles } from './mediapool.js';
import { mountTimeline, centerTracks, splitAtPlayhead, trimAtPlayhead, deleteSelected, duplicateSelected, addTitle, setTool, setZoom, fitZoom, setTrackZoom, trackZoom, resetTrackView, unlinkSelected, markRange, clearRange, rangeMark, liftExtract } from './timeline.js';
import { mountViewer, toggle, shuttle, seek, isPlaying, isPlayingProgram, viewerMode, pause, setMode, sourceKey, toggleFullscreen, editTextClip } from './player.js';
import { mountInspector, deleteSelectedKeys } from './inspector.js';
import { mountFxPanel } from './fxpanel.js';
import { mountCapsPanel, refreshCaps } from './capspanel.js';
import { openBrandKit } from './library.js';
import { mountDeliver, showDeliver, hideDeliver, pollQueue } from './deliver.js';
import { openAgent, showReport, resumeAgentJob } from './agent.js';
import { openReedit } from './reedit.js';
import { mountProjectStart, refreshProjectStart, openStartHere } from './starthere.js';
import { openPromptGuide } from './promptguide.js';
import { openAiUndo } from './aiundo.js';
import { openActivity } from './activity.js';
import { openZones } from './zones.js';
import { openMediaMgr } from './mediamgr.js';
import { mountAssistant, toggleAssistant } from './assistant.js';
import { mountColor, showColor, hideColor } from './colorpage.js';
import { mountAudio, showAudio, hideAudio } from './audiopage.js';
import { mountAI, showAI, hideAI } from './aipage.js';
import { openLabsClip } from './labsedit.js';
import './liveedit.js'; // (🔴 a live same-day edit carries on after a refresh)
import { layout, duration } from './store.js';
import { openSequences, seqName, openSequence, nestSelected } from './sequences.js';
import { keyOf, commandFor, keyState, stepMany } from './keys.js';
import { openShortcuts } from './keysui.js';
import { linkedIds, uid, setTransition, arrangeLayers } from './model.js';
import { mountNotesPanel, addNote, watchPhoneNotes, openVersions, refreshNotes, openReviewHub } from './review.js';
import { loadFootage } from './smart.js';
import { mountText, showText, hideText } from './textedit.js';
import { mountMotion, showMotion, hideMotion, openCompClip } from './motionpage.js';
import { mountFusion, showFusion, hideFusion, openFusionClip } from './fusionpage.js';
import { mountVfx, showVfx, hideVfx, openVfxClip } from './vfxpage.js'; // 💥 VFX: presets, manual keyframes, AI
import { mountPresets, showPresets, hidePresets, openPresetClip } from './presetspage.js';
import { mountMenuBar, openLogo, openBackups } from './menubar.js';
import { openTemplates } from './titlesui.js';
import { openCustomTemplates } from './customtpl.js';
import { openAudioGain } from './audiogain.js';
import { nudgeSelected, moveSelectedTrack, groupSelected, ungroupSelected, replaceEdit, typeTimecode, closeAllGaps, goGap, addClipMarker, exportFrame } from './editing.js';
import { toggleTrimMode } from './trimmode.js';
import './presence.js'; // 📊 session time (Team & users > Sessions)
import { mountPhone, phoneOpened } from './phone.js'; // 📱 phone / tablet layouts (a touch screen only)
import { tabClaim } from './tabclient.js'; // 🗂 this editor as one of the window's project tabs (tabs.js)
import './touch.js'; // 👆 touch: drag on the timeline, pinch, long-press
import { toggleHelp } from './helpbot.js'; // ❓ Help chat (F1)

applyLook(); // 🖥 Studio (Premiere-style) look unless this browser chose Classic (⚙ in the header)
window.addEventListener('focus', () => { if (S.proj) syncClipboard(); });
// in the Studio look the program monitor shows the timeline only (clips open in the Source monitor beside it)
document.addEventListener('ve-look', () => { if (document.documentElement.classList.contains('ui2') && viewerMode() === 'source') setMode('program'); });

const app = $('#app');
app.innerHTML = '<div id="home"></div><div id="editor" hidden></div>';
const homeEl = $('#home'), editorEl = $('#editor');
// (Labs took Audio's place in the page bar - the Audio page opens from Window > Audio)
const PAGES = [['media', 'Media'], ['edit', 'Edit'], ['motion', 'Motion'], ['fusion', 'Nodes'], ['vfx', 'VFX'], ['color', 'Color'], ['audio', 'Audio'], ['ai', 'Labs'], ['presets', 'Presets'], ['deliver', 'Deliver']];

// 🧰 Tools tab (before Media): what used to crowd the top bar, as big labelled tiles in a few groups. Every tile keeps
// its data-a, so the click handler below, the menus (runMenu 'a:') and whoAmI (Team / Mazbooti) find it as before.
// 💬 the office chat: an editor in a tab asks the tab strip to open its panel; without tabs (a phone, ?notabs=1) this
// page has its own round button and panel
const chatDock = window.top === window ? mountChatDock() : null;
const openChat = () => (chatDock ? chatDock.show(true) : window.top.postMessage({ chat: 'open' }, location.origin));
if (chatDock) { // (the chat is the open project's: #/p/<project>; none on the project list)
  const fromHash = () => { const m = /^#\/p\/([^/?]+)/.exec(location.hash); let p = null; try { p = m ? decodeURIComponent(m[1]) : null; } catch {} chatDock.setProject(p); };
  addEventListener('hashchange', fromHash); fromHash();
}
const TOOLS = [
  ['AI se edit', [['agent', 'agent', 'Agent', 'Whole edit from footage, VO, music', 'Let the agent make the whole edit from your footage, voice-over and music', 'accent'],
    ['reedit', 'reedit', 'Re-edit', 'New VO, music, pace or format', 'Change the voice-over, music, pace or format and let the agent rebuild this edit'],
    ['assistant', 'assistant', 'Assistant', 'Type what to change', 'Type what to change, e.g. "music dheema karo", "make the colour warm", "remove the 3rd shot"…'],
    ['report', 'report', 'Agent report', 'Which shot for which line', 'Report: which shot the agent chose for which line, and why']]],
  ['Help', [['starthere', 'start', 'Automation', 'Your first edit in 4 steps', 'Automation: bring footage, pick what to make (ready-made jobs), let the Agent edit, export'],
    ['promptguide', 'idea', 'Prompt guide', 'What to type to the AI', 'Example prompts in Hinglish and English, tips for a good brief, what each Agent option does']]],
  ['History', [['undo', 'undo', 'Undo', 'Ctrl+Z', 'Undo (Ctrl+Z)'], ['redo', 'redo', 'Redo', 'Ctrl+Shift+Z', 'Redo (Ctrl+Shift+Z)'],
    ['aiundo', 'aiundo', 'AI Undo', 'Before an Agent / Limelight AI edit', 'Bring back the edit as it was before an Agent edit, Re-edit or Limelight AI change (works after a refresh too)'],
    ['versions', 'versions', 'Versions', 'Go back, or save with a name', 'Versions: go back to an earlier edit, or save this one with a name']]],
  ['Project', [['brand', 'brand', 'Brand packs', 'Client logo, colours, intro / outro', 'Brand packs - one per client: logo, colours, font, captions, lower thirds, intro / outro - and project templates'],
    ['mediamgr', 'media', 'Media manager', 'Relink, pack, clean up', 'Media manager: relink offline files, pack the project, clean up disk'],
    ['activity', 'activity', 'Activity', 'Who changed what', 'Activity: who changed what on this project - take back one person\'s one change'],
    ['zones', 'zones', 'Zones', 'Who owns which part', 'Zones: who owns which part of the timeline - warns before you change someone else\'s part'],
    ['chat', 'team', 'Project chat', 'Talk about this project', 'Project chat: everyone who can open this project - messages, photos and files'],
    ['team', 'team', 'Team', 'Logins, roles, folders', 'Team: other computers in the office edit too (logins, roles, shared folders)', '', true],
    ['safety', 'health', 'Mazbooti', 'Health, backup, standby PC', 'Mazbooti: health, nightly backup, standby PC', 'sf-btn', true],
    ['dash', 'activity', 'Dashboard', 'CPU, GPU, RAM, storage of every PC', 'Dashboard: every PC of the editor right now - CPU, RAM, GPU, video memory, heat, power, storage', '', true]]],
  ['Layout', [['workspace', 'zones', 'Workspace', '', 'Workspaces: Premiere Pro, DaVinci Resolve, Limelight or your own - resize, swap and save panel layouts', 'ws-btn'],
    ['shortcuts', 'keyboard', 'Shortcuts', 'See and set every key', 'Keyboard shortcuts: see every key and set your own (Ctrl+Alt+K)']]],
];
const toolsHTML = () => `<div class="tools">${TOOLS.map(([group, list]) => `<section class="tl-group"><h4>${esc(group)}</h4><div class="tl-grid">${list.map(([a, ic, label, sub, title, cls = '', hide]) =>
  `<button class="tl-tile ${cls}" data-a="${a}" title="${esc(title)}"${hide ? ' hidden' : ''}>${icon(ic)}<span class="tl-txt"><b>${esc(label)}</b><small${a === 'workspace' ? ' class="ws-name"' : ''}>${esc(a === 'workspace' ? currentWorkspace().name : sub)}</small></span></button>`).join('')}</div></section>`).join('')}</div>`;

function shell() {
  editorEl.innerHTML = `
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
        <div class="panel pool pool-tabs"><div class="ptabs" role="tablist"><button role="tab" data-ptab="tools" aria-selected="false" title="Agent, Assistant, undo, versions, team, brand packs, workspaces…">Tools</button><button role="tab" data-ptab="media" aria-selected="true">Media</button><button role="tab" data-ptab="fx" aria-selected="false">Effects</button><button role="tab" data-ptab="cc" aria-selected="false" title="Captions">CC</button><button role="tab" data-ptab="notes" aria-selected="false" title="Notes at moments of the edit (Shift+M), versions and phone review">${ic('note')}</button></div>
          <div class="ptab-body" id="toolsPanel" hidden>${toolsHTML()}</div><div class="ptab-body" id="pool"></div><div class="ptab-body" id="fxPanel" hidden></div><div class="ptab-body" id="ccPanel" hidden></div><div class="ptab-body" id="notesPanel" hidden></div></div>
        <div class="mon-dock" role="tablist" aria-label="Source / Program"><button role="tab" data-mon="src">Source</button><button role="tab" data-mon="prog">Program</button></div>
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
    <section class="page" data-page="vfx" id="vfxPage" hidden></section>
    <section class="page" data-page="color" id="colorPage" hidden></section>
    <section class="page" data-page="audio" id="audioPage" hidden></section>
    <section class="page" data-page="ai" id="aiPage" hidden></section>
    <section class="page" data-page="presets" id="presetsPage" hidden></section>
    <section class="page" data-page="deliver" id="deliverPage" hidden></section>
  </main>
  <nav class="pagebar" aria-label="Pages">${PAGES.map(([k, l]) => `<button data-page-btn="${k}">${l}</button>`).join('')}
    <button class="brand pb-brand" data-a="home" title="All projects"><img class="brand-logo" src="/img/limelight-wordmark-white.png" alt="limelight"></button></nav>`; // (🏠 the logo sits at the right end of the page bar - the top bar had no room for it)
  mountMenuBar(editorEl, runMenu); // ☰ File · Edit · Clip · Sequence · Markers · Graphics and Titles · View · Window · Help
  // the top bar is gone: its buttons went to the 🧰 Tools tab, and the project's name, sequence, save state, jobs, who is
  // signed in, Reload and ⇪ Export sit in the menu bar's one line (same ids, so the code filling them is unchanged)
  editorEl.querySelector('.menubar').insertAdjacentHTML('beforeend', `<span class="mb-proj"><span class="pname" id="pName"></span><button class="seqbtn" data-a="seq" title="Sequences: several timelines in this project (film, teaser, reel…), nesting, versions"><span id="seqName"></span> ▾</button><span class="save" id="saveState"></span></span>
    <span class="mb-sp"></span><button class="mb-help" data-a="help" title="Bhaiya: editor ke baare mein kuch bhi poochho (F1)" aria-label="Bhaiya - help">?</button><span class="jobchip" id="jobChip" hidden></span><button class="jobchip qchip" id="queueChip" data-a="deliver" title="Render queue - open Export" hidden></button><span class="people" id="peopleChip" hidden></span><span class="me" id="meChip" hidden></span><button class="mb-reload" data-a="refresh" title="Reload: save, then load the editor again (newest version, panels fresh)">${icon('refresh')}Reload</button><button class="mb-reload mb-review" data-a="review" title="Review: send a finished render to the client as a link (no sign-in, phone or computer) - they comment at moments of the video and approve; their comments come back here">${icon('review')}Review<span class="mb-badge" id="reviewBadge" hidden></span></button><button class="mb-reload mb-nle" data-a="nlePremiere" title="Open this edit in Adobe Premiere Pro on this PC - one click (also in the project folder: Open in Premiere.cmd, works when the editor is down)">Pr</button><button class="mb-reload mb-nle" data-a="nleResolve" title="Open this edit in DaVinci Resolve on this PC - one click (also in the project folder: Open in DaVinci.cmd)">Dv</button><button class="primary mb-export" data-a="deliver" title="Export: render the video, XML for Premiere / Resolve, publish">${icon('export')}Export</button>`);
  mountWorkspaces(editorEl.querySelector('.edit-grid')); // 🪟 workspaces: Premiere / Resolve / Limelight / your own layouts
  mountSourceMonitor($('#srcMon')); mountDock(editorEl.querySelector('.edit-grid')); mountMonDock(editorEl.querySelector('.edit-grid')); // 🎬 Premiere's two monitors (Studio look)
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
    if (a === 'help') toggleHelp();
    if (a === 'brand') openBrandKit(setBusy);
    if (a === 'deliver') showPage('deliver');
    if (a === 'nlePremiere' || a === 'nleResolve') import('./nleopen.js').then((x) => x.openInNle(S.proj, a === 'nleResolve' ? 'resolve' : 'premiere', { save: () => saveNow(true) })); // 🎬 one click to Premiere / Resolve
    if (a === 'review') openReviewHub(); // 💬 client review links: send a render, read and answer the comments
    if (a === 'seq') openSequences();
    if (a === 'versions') openVersions();
    if (a === 'refresh') { toast('Saving and refreshing…'); saveNow(true).catch(() => {}).finally(() => location.reload()); } // (🔄 nothing unsaved is lost)
    if (a === 'aiundo') openAiUndo();
    if (a === 'activity') openActivity();
    if (a === 'zones') openZones();
    if (a === 'mediamgr') openMediaMgr();
    if (a === 'safety') import('./safety.js').then((x) => x.openSafety('health'));
    if (a === 'dash') import('./safety.js').then((x) => x.openSafety('perf')); // 📊 the Dashboard (everyone)
    if (a === 'team') openTeam();
    if (a === 'chat') openChat();
    if (a === 'starthere') openStartHere();
    if (a === 'promptguide') openPromptGuide();
    const p = e.target.closest('[data-page-btn]')?.dataset.pageBtn;
    if (p) showPage(p);
  });
  // 🛡 each panel is built on its own - one that fails (odd data in a project) never leaves the others unbuilt
  safely('Media panel', () => mountPool($('#pool')));
  safely('Effects panel', () => mountFxPanel($('#fxPanel')));
  safely('Captions panel', () => mountCapsPanel($('#ccPanel')));
  safely('Notes panel', () => mountNotesPanel($('#notesPanel')));
  editorEl.querySelector('.ptabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-ptab]')?.dataset.ptab; if (t) selectTab(t);
  });
  safely('Media page', () => mountPool($('#poolBig'), { big: true }));
  safely('Viewer', () => mountViewer($('#viewer')));
  safely('Effect Controls', () => mountInspector($('#inspector')));
  safely('Timeline', () => mountTimeline($('#timeline')));
  safely('Deliver page', () => mountDeliver($('#deliverPage')));
  safely('Text page', () => mountText($('#textPage')));
  safely('Motion page', () => mountMotion($('#motionPage'))); // 🎬 After Effects-style compositions
  safely('Fusion page', () => mountFusion($('#fusionPage'))); // ✨ Resolve Fusion-style node effects
  safely('VFX page', () => mountVfx($('#vfxPage'))); // 💥 muzzle flashes to sky replacement (vfxpage.js)
  safely('Color page', () => mountColor($('#colorPage')));
  safely('Audio page', () => mountAudio($('#audioPage')));
  safely('AI page', () => mountAI($('#aiPage')));
  safely('Presets page', () => mountPresets($('#presetsPage'))); // 🅿 motion templates, edited live
  safely('Assistant', () => mountAssistant(setBusy));
  safely('Automation', () => mountProjectStart(setBusy)); // 🚩 the first-edit steps while the sequence is empty
  safely('Phone', () => mountPhone(editorEl, { showPage, selectTab })); // 📱 (shown only on a phone)
}

// a menu item (menubar.js): a keyboard command, a top-bar button, a page, or one of these
function runMenu(r) {
  const [kind, x] = r.includes(':') ? r.split(':') : [r, ''];
  if (kind === 'k') { if (ACTIONS[x]?.() === false) toast('Select something first'); return; }
  if (kind === 'a') return editorEl.querySelector(`[data-a="${x}"]`)?.click(); // (🧰 the buttons are in the Tools tab now)
  if (kind === 'p') return showPage(x);
  const edit = () => { if (S.page !== 'edit') showPage('edit'); };
  if (r === 'audioout') return import('./audioout.js').then((x) => x.pickOutput());
  if (r === 'layers') { const n = arrangeLayers(S.project, S.mediaById); if (n) commit('Arrange layers'); toast(n ? `${n} clip${n > 1 ? 's' : ''} moved: V2 looks, V3 comps, V4 text - nothing covers anything (Ctrl+Z takes it back)` : 'The layers are in place already'); return; }
  if (r === 'import') { edit(); selectTab('media'); return $('#pool [data-file]')?.click(); }
  if (r === 'logo') return openLogo();
  if (r === 'backups') return openBackups();
  if (r === 'titles') return openTemplates();
  if (r === 'customtpl') return openCustomTemplates();
  if (r === 'title') return addTitle();
  if (r === 'accurate') return emit('accuratePreview');
  // 🟥🟩 render bar: red sections rendered by themselves while the editor is idle (renderbar.js)
  if (r === 'bgrender') return import('./renderbar.js').then((x) => { x.setBg(!x.bgOn()); toast(x.bgOn() ? 'Background render on: red sections of the render bar are rendered while you are idle, then play exactly' : 'Background render off'); });
  if (r === 'fx' || r === 'cc') { edit(); return selectTab(r); }
  if (r === 'ec') { edit(); return editorEl.querySelector('.ui-dock [data-dock="ec"]')?.click(); }
  if (r === 'gyro') { edit(); if (S.sel.size !== 1) return toast('Select one video clip first'); return emit('inspect', 'gyro'); }
}
function selectTab(t) {
  editorEl.querySelectorAll('[data-ptab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.ptab === t)));
  $('#toolsPanel').hidden = t !== 'tools'; $('#pool').hidden = t !== 'media'; $('#fxPanel').hidden = t !== 'fx'; $('#ccPanel').hidden = t !== 'cc'; $('#notesPanel').hidden = t !== 'notes';
  if (t === 'cc') refreshCaps();
  if (t === 'notes') refreshNotes();
}
on('notesTab', () => { if (S.page !== 'edit') showPage('edit'); selectTab('notes'); });
on('mediaTab', () => { if (S.page !== 'edit' && S.page !== 'media') showPage('edit'); if (S.page === 'edit') selectTab('media'); }); // 📁 Reveal in Project
on('reloadProject', () => openProject(S.proj));

// ---- 👥 who am I (viewers only watch; everyone else edits together - 🔴 live) ----
async function whoAmI() {
  try { S.me = await api('GET', '/api/me'); } catch { S.me = { role: 'owner', local: true }; }
  const chip = $('#meChip'); if (!chip) return;
  chip.hidden = !!S.me.local;
  // (who is signed in - Logout is on the Projects page, outside the projects)
  chip.innerHTML = S.me.local ? '' : `<span class="me-name" title="Signed in as ${esc(S.me.name)} (${esc(S.me.role)}) - Logout is on the Projects page">${esc(S.me.name)} · ${esc(S.me.role)}</span>`;
  $('[data-a="team"]').hidden = !(S.me.local && S.me.role === 'owner');
  // 🩺 Mazbooti: the owner on the editing computer (a dot when something needs a look)
  const sf = $('[data-a="safety"]');
  // (also the owner signed in from another PC - the server now runs on its own PC, the owner works elsewhere)
  { const db = $('[data-a="dash"]'); if (db) db.hidden = false; } // 📊 (everyone sees the Dashboard)
  if (sf && S.me.role === 'owner' && sf.hidden) { sf.hidden = false; import('./safety.js').then((x) => x.watchSafety(sf)); }
  // 🖥 this is a standby PC's editor (the main one is down): say so, once per page
  if (S.me.standby && !$('#sbBanner')) $('.menubar').after(h(`<div id="sbBanner" class="ro-banner sb" role="status">Standby editor on ${esc(S.me.standby)} - the main editor is down. Work as usual: everything saved here goes back to it when it is up again.</div>`));
}
on('readonly', (x) => {
  let b = $('#roBanner');
  if (!S.readOnly) { b?.remove(); return; }
  if (!b) { b = h('<div id="roBanner" class="ro-banner" role="status"></div>'); $('.menubar').after(b); }
  b.textContent = S.me?.hold ? `The standby PC ${S.me.hold.host} is running the editor (since ${new Date(S.me.hold.since).toLocaleTimeString()}) - edit there. This editor takes over again about 2 minutes after it is back; reload then.`
    : S.me?.role === 'viewer' ? 'View only - you can watch and play, not change this project.'
    : S.lockHolder && S.lockHolder === S.me?.name ? 'Read only - this project is open in another tab or computer of yours. Close it there (editing opens up here within a minute).'
    : `Read only - ${S.lockHolder || 'someone'} is editing this project. You can watch; editing opens up when they close it.`;
  if (x?.tried) toast(`Not changed - ${S.me?.role === 'viewer' ? 'you are a viewer' : `${S.lockHolder} is editing`}`, 'err');
});

// the header's job chip: one line - a live dot, the label (cut short; all of it on hover), the percent, a thin progress line
function setBusy(b, label) {
  const c = $('#jobChip'); c.hidden = !b;
  if (!b) return;
  const s = String(label || 'Working…'), m = /(\d{1,3})\s*%/.exec(s), pct = m ? Math.min(100, +m[1]) : null;
  const text = s.replace(/[·\s]*\d{1,3}\s*%.*$/, '').replace(/…$/, '').trim() || 'Working';
  c.title = s;
  c.innerHTML = `<i class="jc-dot"></i><span class="jc-t">${esc(text)}</span>${pct !== null ? `<span class="jc-p">${pct}%</span>` : ''}<b class="jc-bar${pct === null ? ' run' : ''}" style="--p:${pct ?? 30}%"></b>`;
}
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
  offlineBar(S.saveState === 'error');
});
// 🔌 the editor not answering (restarting, the server PC down, the network): after a few seconds a bar says so - the
// changes are kept in this tab and sent by themselves once it answers (store.js tries every few seconds), and a standby
// PC takes over within about 2 minutes. It goes away by itself as soon as a change gets through.
let offTimer = 0;
function offlineBar(down) {
  const bar = document.getElementById('offlineBar');
  if (!down) { clearTimeout(offTimer); offTimer = 0; bar?.remove(); return; }
  if (bar || offTimer) return;
  offTimer = setTimeout(() => {
    offTimer = 0;
    if (S.saveState !== 'error' || document.getElementById('offlineBar')) return;
    const b = document.createElement('div');
    b.id = 'offlineBar'; b.className = 'ro-banner'; b.setAttribute('role', 'status');
    b.textContent = 'The editor is not answering - your changes are kept in this tab and are sent by themselves as soon as it answers. If the main editor PC is down, the standby PC takes over within about 2 minutes: keep working, nothing is lost.';
    document.body.prepend(b);
  }, 5000);
}
on('change', () => { $('[data-a="undo"]').disabled = !canUndo(); $('[data-a="redo"]').disabled = !canRedo(); });
// ⚡ a slider / Motion value dragged: the monitor is drawn again once per screen frame, not on every mouse event (a
// full redraw per pointermove - a hundred a second on a fast mouse - made it trail behind the mouse)
let liveRaf = 0;
on('live', () => { if (!liveRaf) liveRaf = requestAnimationFrame(() => { liveRaf = 0; emit('mix'); }); });
on('deleteSelected', deleteSelected);
on('duplicateSelected', duplicateSelected);
on('splitAtPlayhead', splitAtPlayhead);
// double-click a clip on the timeline: like Premiere, its file opens in the Source monitor with the clip's own In / Out
// marked (titles, graphics and adjustment layers have no file - they are just selected)
function openComp(c) { openCompClip(c); showPage('motion'); }
on('openComp', openComp);
function openFusion(c) { openFusionClip(c); showPage('fusion'); }
on('openFusion', openFusion);
// 🅿 a graphic into the Presets page (P on the timeline / right-click); nothing graphic selected = just the page
function openPreset(c) { if (c) openPresetClip(c); showPage('presets'); }
on('openPreset', openPreset);
on('openClip', (id) => {
  S.sel = new Set([id]); emit('select');
  const f = findClip(id), c = f?.clip, m = c?.mediaId && S.mediaById[c.mediaId];
  if (c?.type === 'graphic' && c.gfx?.tpl === 'comp') return openComp(c); // 🎬 a Motion comp: open it on the Motion page
  if (c?.type === 'graphic' && c.gfx?.tpl === 'fusion') return openFusion(c); // ✨ a Fusion: open it on the Fusion page
  if (c?.type === 'graphic' && c.gfx?.tpl === 'vfx') return openVfxClip(c); // 💥 a VFX element: open it on the VFX page
  if (c?.labsId) return openLabsClip(c); // 🧪 a Labs clip (yellow): open it on the Labs page
  if (c?.type === 'graphic' && c.gfx?.tpl === 'text') { // T a Type tool text: type in it on the monitor (the playhead goes onto it)
    const x = layout()[f.track]?.find((p) => p.clip.id === id);
    if (x && (S.playhead < x.start || S.playhead >= x.end)) emit('seek', x.start + Math.min(0.5, (x.end - x.start) / 2));
    return setTimeout(() => editTextClip(id), 60);
  }
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

// remember: false when the page is not the editor's own pick (a project with no media yet opens on Media)
export function showPage(p, { remember = true } = {}) {
  S.page = p;
  $$('[data-page]').forEach((s) => (s.hidden = s.dataset.page !== p));
  $$('[data-page-btn]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.pageBtn === p)));
  // (🛡 each page on its own: one that fails to show is logged, the page bar keeps working)
  if (p !== 'vfx') safely('VFX page', hideVfx); // (💥 gives the Program monitor and the timeline back first)
  safely('Deliver page', () => (p === 'deliver' ? showDeliver() : hideDeliver()));
  safely('Color page', () => (p === 'color' ? showColor() : hideColor()));
  safely('Audio page', () => (p === 'audio' ? showAudio() : hideAudio()));
  safely('AI page', () => (p === 'ai' ? showAI() : hideAI()));
  safely('Presets page', () => (p === 'presets' ? showPresets() : hidePresets()));
  safely('Text page', () => (p === 'text' ? showText() : hideText()));
  safely('Motion page', () => (p === 'motion' ? showMotion() : hideMotion()));
  safely('Fusion page', () => (p === 'fusion' ? showFusion() : hideFusion()));
  if (p === 'vfx') safely('VFX page', showVfx);
  if (p !== 'edit' && p !== 'audio') pause();
  emit('change', {});
  // 📄 the page comes back after a reload - each project its own (the project tabs share this browser's storage)
  if (remember) try { localStorage.setItem('ve-page', p); if (S.proj) localStorage.setItem(`ve-page:${S.proj}`, p); } catch {}
}

async function loadLuts() { try { S.luts = await api('GET', `/api/luts?p=${enc(S.proj)}`); } catch { S.luts = []; } emit('select'); }

// 🛡 a step of opening a project that goes wrong is logged and skipped - the project stays open (only a project that
// cannot be read at all goes back to Home)
const safely = (label, fn) => { try { const r = fn(); return r?.catch ? r.catch((e) => reportError(label, e)) : r; } catch (e) { reportError(label, e); } };
async function openProject(name) {
  if (!tabClaim(name)) return; // (🗂 open in another tab already: that tab is shown)
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
    document.title = matchMedia('(display-mode: standalone)').matches ? name : `${name} - Limelight`; // (the installed app's window already starts with "Limelight")
    history.replaceState(null, '', `#/p/${enc(name)}`);
    // recovered changes go to the server like any other change (only what differs from the saved project)
    if (recovered) { delete recovered._rev; S.project = recovered; commit('Recovered changes'); }
    safely('Live editing', connectLive);
    safely('My sequence', restoreMySeq); // 🎞 the sequence this browser had open (only here - nobody else's timeline changes)
    safely('Clipboard', syncClipboard); // 📋 what was copied in another tab / browser / link
    await Promise.all([safely('Media', refreshMedia), safely('LUTs', loadLuts), safely('Footage search', loadFootage), api('GET', '/api/health').then((hh) => (S.health = hh)).catch(() => {})]);
    let pg = 'edit'; try { pg = localStorage.getItem(`ve-page:${name}`) || localStorage.getItem('ve-page') || 'edit'; } catch {}
    if (!PAGES.some(([k]) => k === pg)) pg = 'edit'; // (a page no longer in the bar, e.g. the old Text page)
    safely('Page', () => (S.media.length ? showPage(pg === 'deliver' ? 'edit' : pg) : showPage('media', { remember: false })));
    safely('Viewer', () => setMode('program')); // also refreshes the viewer title when switching projects
    safely('Phone', phoneOpened);
    // everyone with edit rights edits together (🔴 live); only viewers watch
    await safely('Who am I', whoAmI); S.readOnly = S.me?.role === 'viewer' || !!S.me?.hold; S.lockHolder = null; emit('readonly', {}); safely('Presence', sendPresence);
    safely('Agent job', () => resumeAgentJob(setBusy)); // an agent edit still running on the server (page refreshed / reopened)
    safely('Render queue', pollQueue); // renders still running / waiting in the background queue
    safely('Phone notes', watchPhoneNotes); // notes sent from a phone (📱 review)
    emit('change', {}); emit('save');
    safely('Automation', refreshProjectStart);
    // 📐 every project opens the same way: default track heights, the whole edit in view, V1 / A1 in the middle
    setTimeout(() => { resetTrackView(); fitZoom(); centerTracks(); }, 50);
  } catch (e) { console.error('openProject: a step failed - the project stays open', e); toast(`Something in this project could not be shown (${e.message}) - the rest works`, 'err'); }
}

async function goHome() {
  if (S.proj) await saveNow(true);
  disconnectLive(); S.readOnly = false; $('#roBanner')?.remove();
  pause?.();
  S.proj = null; S.project = null;
  history.replaceState(null, '', '#/');
  document.title = 'Limelight';
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
  // (📍 clip markers count too, where their clip is now)
  const ts = [...(S.project.markers || []).map((m) => m.t), ...Object.values(layout()).flat().flatMap((x) => (x.clip.markers || []).map((m) => x.start + m.t))].sort((a, b) => a - b);
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
  // I / O: the Source monitor's marks when it has the keys, else the timeline's In / Out (what Export and the preview make)
  markIn: () => { if (!sourceKey('i')) markRange('in'); }, markOut: () => { if (!sourceKey('o')) markRange('out'); },
  goIn: () => { if (!sourceKey('i', true)) { const t = rangeMark('in'); if (t === undefined) toast('No In on the timeline (I sets it)'); else emit('seek', t); } },
  goOut: () => { if (!sourceKey('o', true)) { const t = rangeMark('out'); if (t === undefined) toast('No Out on the timeline (O sets it)'); else emit('seek', t); } },
  // Ctrl+R is Speed / Duration, never the browser's reload (F5 reloads): with nothing selected it only says so
  speedDuration: () => { if (S.page !== 'edit' || !S.sel.size) { toast('Select a clip on the timeline, then Ctrl+R for Speed / Duration (F5 reloads the page)'); return; } import('./speeddlg.js').then((x) => x.openSpeedDuration()); },
  clearInOut: () => clearRange(), lift: () => liftExtract(false), extract: () => liftExtract(true), openXml: () => { openXmlFile().then((n) => n && emit('openProject', n)); }, insert: () => src(','), overwrite: () => src('.'),
  selectTool: () => setTool('select'), razorTool: () => setTool('blade'), typeTool: () => { setTool('type'); toast('T Type tool: click on the picture and type (Esc when done; V = back to selection)'); },
  rippleTool: () => setTool('ripple'), rollingTool: () => setTool('rolling'), rateTool: () => setTool('rate'), penTool: () => setTool('pen'), remixTool: () => setTool('remix'),
  slipTool: () => setTool('slip'), slideTool: () => setTool('slide'), rectTool: () => setTool('rect'), ellipseTool: () => setTool('ellipse'), extendTool: () => setTool('extend'), zoomTool: () => setTool('zoom'),
  trackFwdTool: () => setTool('trackfwd'), trackBackTool: () => setTool('trackback'),
  trackUp: () => moveSelectedTrack(1), trackDown: () => moveSelectedTrack(-1),
  nudgeL: () => nudgeSelected(-1), nudgeR: () => nudgeSelected(1), nudgeL5: () => nudgeSelected(-5), nudgeR5: () => nudgeSelected(5),
  pasteInsert: () => { if (S.page !== 'edit') return false; pasteClips({ insert: true }).catch((err) => toast(err.message, 'err')); },
  group: () => groupSelected(), ungroup: () => ungroupSelected(), trimMode: () => toggleTrimMode(), replaceEdit: () => replaceEdit(),
  timecode: () => { if (S.page !== 'edit') showPage('edit'); const tc = $('#tlTC'); if (tc) typeTimecode(tc); },
  exportFrame: () => exportFrame(), closeGaps: () => closeAllGaps(), nextGap: () => goGap(1), prevGap: () => goGap(-1), clipMarker: () => addClipMarker(),
  rippleMarkers: () => { const s = S.project.settings; s.rippleMarkers = !s.rippleMarkers || undefined; commit(s.rippleMarkers ? 'Ripple markers on' : 'Ripple markers off'); toast(s.rippleMarkers ? 'Ripple Sequence Markers on: markers move with the story when it ripples' : 'Ripple Sequence Markers off: markers stay where they are'); },
  history: () => import('./history.js').then((x) => x.openHistory()), autoReframe: () => import('./aiui.js').then((x) => x.autoReframeSequence()), seqSettings: () => import('./seqsettings.js').then((x) => x.openSequenceSettings()),
  addEdit: () => splitAtPlayhead(), addEditAll: () => { S.sel = new Set(); splitAtPlayhead(); },
  rippleTrimPrev: () => trimAtPlayhead('start'), rippleTrimNext: () => trimAtPlayhead('end'),
  clear: () => { if (!deleteSelectedKeys()) deleteSelected(false); }, rippleDelete: () => deleteSelected(true), duplicate: () => duplicateSelected(), pasteAttr: () => import('./attrs.js').then((x) => x.pasteAttributes()),
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
  marker: () => {
    const t = +S.playhead.toFixed(3), on = (S.project.markers || []).find((m) => Math.abs(m.t - t) < 0.02);
    if (on) return import('./markers.js').then((x) => x.editMarker(on)); // (M on a marker: edit it, like Premiere)
    (S.project.markers ||= []).push({ t }); commit('Marker');
  }, markersList: () => import('./markers.js').then((x) => x.openMarkersList()), exportEdl: () => import('./edl.js').then((x) => x.exportEDL()), dupFrames: () => import('./timeline.js').then((x) => x.toggleDupFrames()),
  makeSubclip: () => Promise.all([import('./player.js'), import('./mediapool.js')]).then(([p, mp]) => mp.makeSubclip(p.sourceMediaId())),
  nextMarker: () => goMarker(1), prevMarker: () => goMarker(-1), note: () => addNote(),
  tracksTaller: () => setTrackZoom(trackZoom() * 1.25), tracksShorter: () => setTrackZoom(trackZoom() * 0.8), tracksMin: () => setTrackZoom(0.4), tracksMax: () => setTrackZoom(2.5),
  zoomIn: () => setZoom(S.zoom * 1.25, true), zoomOut: () => setZoom(S.zoom / 1.25, true), zoomFit: () => fitZoom(),
  maximize: () => { // the panel under the mouse fills the window (again = back), like Premiere's ` key
    const cur = document.querySelector('.panel-max');
    if (cur) { cur.classList.remove('panel-max', 'panel-full'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); window.dispatchEvent(new Event('resize')); return; }
    const p = document.elementFromPoint(...mouseAt)?.closest('.panel');
    if (!p) return toast('Point the mouse at a panel, then press the ` key');
    p.classList.add('panel-max'); window.dispatchEvent(new Event('resize'));
  },
  // 📏 rulers on the monitor you last clicked (the Source monitor when it is the active one, else the Program monitor)
  rulers: () => import('./sourcemon.js').then((sm) => (sm.srcMonActive() ? sm.toggleRulers() : import('./player.js').then((p) => p.toggleRulers()))),
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
// a monitor button runs the same command as its key (Mark In / Out, Lift, Extract, Add marker… - player.js)
on('command', (id) => { if (ACTIONS[id]?.() === false) toast('Select something first'); });
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
  if (typing && id === 'speedDuration') { e.preventDefault(); return; } // (Ctrl+R in a text box: no reload either)
  // ⇅ Alt+↑ / ↓ right after using a dropdown, tick box or slider in Effect Controls (Blend Mode…): the clips move -
  // the focus there used to keep the keys (Alt+↓ opened the dropdown); only a text being typed keeps them
  if (typing && (id === 'trackUp' || id === 'trackDown') && !(typing.isContentEditable || typing.tagName === 'TEXTAREA' || (typing.tagName === 'INPUT' && /^(text|search|number|email|url|password|)$/.test(typing.type || '')))) { typing.blur(); e.preventDefault(); ACTIONS[id](e); return; }
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
