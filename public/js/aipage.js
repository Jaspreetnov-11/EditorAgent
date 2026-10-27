// ✨ Labs page (Phase 22; in the page bar where Audio was - the Audio page is in Window > Audio): every AI tool in one
// place. 🌐 AI dubbing like ElevenLabs (any language, the speaker's own voice, fitted to the timing), 🎬 motion templates
// like Higgsfield (one-click camera moves on the selected shot), and the AI edit tools: script se first cut, live
// same-day edit, archive search, QC, planar tracking, the agent, voice-over, auto reels.
import { S, on, commit, emit, findClip, layout } from './store.js';
import { api, enc, watchJob, upload } from './api.js';
import { uid, fmt, clipDur } from './model.js';
import { esc, toast, modal } from './ui.js';
import { refreshMedia, uploadFiles } from './mediapool.js';
import { TEMPLATES, templateById, applyTemplate, clearTemplate } from './aitemplates.js';
import { labsWorkHTML, mountLabsWork, draw as drawLabs, labOpen, labTemplate, labClear, stopLabs } from './labsedit.js';

let root = null;
// languages a dub can go to: the same-voice model speaks the ones marked ★ (others use a Microsoft Edge voice)
const LANGS = [['hi', 'Hindi', true], ['en', 'English', true], ['mr', 'Marathi'], ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'], ['gu', 'Gujarati'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['pa', 'Punjabi'], ['ur', 'Urdu'],
  ['ar', 'Arabic', true], ['fr', 'French', true], ['de', 'German', true], ['es', 'Spanish', true], ['ru', 'Russian', true], ['ja', 'Japanese', true], ['zh', 'Chinese', true]];
const langName = (c) => LANGS.find((l) => l[0] === c)?.[1] || c;

const TOOLS = [
  ['script', 'Script to first cut', 'A/V script in, finished timeline out - shots from this project and the archive'],
  ['live', 'Live same-day edit', 'Cards copied during the event; the highlight reel keeps re-making itself'],
  ['archive', 'Archive search', 'Find any old shot on the NAS by what it shows'],
  ['qc', 'Auto QC', 'Black frames, flashing, broadcast-safe colour, loudness, title spelling'],
  ['planar', 'Planar tracking', 'Stick a logo or picture onto a wall, banner or screen that moves'],
  ['agent', 'Agent edit', 'Song edits, teasers, reels, highlights and VO films from your footage'],
  ['vo', 'Voice-over', 'Type the script and a voice speaks it, with captions'],
  ['reels', 'Auto reels', 'The best moments of a long talk, as 9:16 reels'],
];

// thin line glyphs in the editor's own icon style (16 × 16, stroke = currentColor)
const G = {
  clone: '<rect x="2" y="1.5" width="4.5" height="7.5" rx="2.25"/><path d="M.8 6.5a3.5 3.5 0 0 0 6.9 0M4.25 10.5v2"/><path d="M9.5 5.5c.9.7.9 2.3 0 3M11.5 4c1.9 1.6 1.9 4.4 0 6M13.5 2.5c2.8 2.5 2.8 6.5 0 9"/>',
  dub: '<path d="M2.5 5.5h5M5 4v1.5M3.3 5.5c.4 2 1.7 3.4 3.4 4M6.7 5.5c-.4 2-1.7 3.4-3.4 4"/><path d="M8.5 13l2.5-6 2.5 6M9.3 11h3.4"/>',
  crashin: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="5" y="5.5" width="6" height="5" rx="1"/><path d="M2.5 3.5l2.5 2M13.5 3.5l-2.5 2M2.5 12.5l2.5-2M13.5 12.5l-2.5-2"/>',
  crashout: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="5" y="5.5" width="6" height="5" rx="1"/><path d="M5 5.5L2.8 3.6M11 5.5l2.2-1.9M5 10.5l-2.2 1.9M11 10.5l2.2 1.9"/>',
  dolly: '<rect x="1.5" y="5" width="9" height="6.5" rx="1.2"/><path d="M10.5 7.2l4-2v6.6l-4-2"/><path d="M4 14h4"/>',
  drone: '<circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><path d="M5.5 5.5l1.5 1.5h2l1.5-1.5"/><rect x="6.3" y="7" width="3.4" height="2.6" rx=".6"/><path d="M8 11.5v3M6.5 13l1.5 1.5 1.5-1.5"/>',
  arc: '<path d="M2.5 11a6 6 0 0 1 11 0"/><path d="M11.5 9.5l2 1.5.5-2.4"/><circle cx="8" cy="12" r="1.3"/>',
  roll: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M12.2 1.8v2.6H9.6"/><path d="M6 8h4"/>',
  bullet: '<circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5M6.5 1.5h3"/>',
  hero: '<path d="M2 4.5l3.5 3.5L2 11.5M6.5 4.5L10 8l-3.5 3.5"/><path d="M12.5 4v8"/>',
  quake: '<path d="M1.5 8h2l1.5-4 2 8 2-6 1.5 3.5 1-1.5h3"/>',
  glitch: '<path d="M2 3.5h7M5 6h9M2 8.5h5M8 11h6M3 13.5h7"/>',
  burn: '<rect x="2.5" y="1.5" width="11" height="13" rx="1.2"/><path d="M5 1.5v13M11 1.5v13"/><path d="M8 5.5c1.4 1.3 1.4 3.2 0 4.5-1-1-1.2-2.3-.2-3.3"/>',
  flashpop: '<path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2 2M10.6 10.6l2 2M3.4 12.6l2-2M10.6 5.4l2-2"/>',
  trails: '<circle cx="11" cy="8" r="3"/><path d="M6.5 5.5a3 3 0 0 0 0 5M3.5 6a2.5 2.5 0 0 0 0 4"/>',
  strobe: '<path d="M9.5 1.5L4 9h4l-1.5 5.5L12 7H8z"/>',
  script: '<path d="M4 1.5h5.5L12.5 4.5v10h-8.5z"/><path d="M9.5 1.5v3h3M6.5 8h4M6.5 10.5h4"/>',
  live: '<circle cx="8" cy="8" r="2.2"/><path d="M4.2 4.2a5.4 5.4 0 0 0 0 7.6M11.8 4.2a5.4 5.4 0 0 1 0 7.6"/>',
  archive: '<rect x="1.5" y="2.5" width="13" height="3.5" rx=".8"/><path d="M2.5 6v6.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6M6.5 8.5h3"/>',
  qc: '<path d="M8 1.5l5.5 2v4.2c0 3.2-2.4 5.6-5.5 6.8-3.1-1.2-5.5-3.6-5.5-6.8V3.5z"/><path d="M5.5 8l1.8 1.8 3.2-3.3"/>',
  planar: '<path d="M3 4l9-1.5 1.5 10L2 12z"/><circle cx="3" cy="4" r=".9"/><circle cx="12" cy="2.5" r=".9"/><circle cx="13.5" cy="12.5" r=".9"/><circle cx="2" cy="12" r=".9"/>',
  agent: '<path d="M8 1.5l1.3 3.7L13 6.5 9.3 7.8 8 11.5 6.7 7.8 3 6.5l3.7-1.3z"/><path d="M12.5 11v3M11 12.5h3"/>',
  vo: '<rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/>',
  reels: '<rect x="4" y="1.5" width="8" height="13" rx="1.5"/><path d="M7 6l3 2-3 2z"/>',
  music: '<path d="M6 12.5V3.5l7.5-2v9"/><circle cx="4.2" cy="12.5" r="1.8"/><circle cx="11.7" cy="10.5" r="1.8"/>',
};
const glyph = (k) => `<svg class="lab-g" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${G[k] || ''}</svg>`;

const selClip = () => { const id = [...S.sel][0]; const f = id && findClip(id); return f ? { id, ...f } : null; };

// the Studio cards' small pictures (stroke / fill = currentColor, drawn faint and brighter on hover)
const ART = {
  // track lanes with clips and the playhead
  work: `<svg viewBox="0 0 220 120" aria-hidden="true"><g fill="currentColor"><rect x="8" y="18" width="70" height="20" rx="4" opacity=".55"/><rect x="82" y="18" width="46" height="20" rx="4" opacity=".3"/><rect x="132" y="18" width="80" height="20" rx="4" opacity=".45"/>
    <rect x="30" y="46" width="96" height="20" rx="4" opacity=".35"/><rect x="130" y="46" width="52" height="20" rx="4" opacity=".6"/>
    <rect x="8" y="74" width="120" height="14" rx="4" opacity=".22"/><rect x="132" y="74" width="80" height="14" rx="4" opacity=".3"/>
    <rect x="8" y="94" width="204" height="14" rx="4" opacity=".14"/></g>
    <path d="M118 8v108" stroke="currentColor" stroke-width="2"/><path d="M112 4h12l-6 7z" fill="currentColor"/></svg>`,
  // a frame, the camera moving into a smaller one
  moves: `<svg viewBox="0 0 220 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <path d="M14 30V14h16M190 14h16v16M206 90v16h-16M30 106H14V90" opacity=".5"/>
    <rect x="96" y="40" width="64" height="40" rx="4" opacity=".9"/><path d="M104 48h8M104 48v6M152 72h-8M152 72v-6" opacity=".6"/>
    <path d="M40 92c18-30 40-44 54-48" stroke-dasharray="3 6" opacity=".55"/><path d="M86 40l9 4-6 8" opacity=".75"/>
    <circle cx="40" cy="92" r="5" fill="currentColor" stroke="none" opacity=".6"/></svg>`,
  voice: `<svg viewBox="0 0 220 120" aria-hidden="true"><g fill="currentColor">${[14, 26, 44, 30, 60, 78, 52, 90, 64, 40, 70, 96, 58, 34, 48, 72, 38, 22, 30, 16].map((h, i) => `<rect x="${10 + i * 10.5}" y="${60 - h / 2}" width="5" height="${h}" rx="2.5" opacity="${(0.25 + (h / 96) * 0.6).toFixed(2)}"/>`).join('')}</g></svg>`,
  music: `<svg viewBox="0 0 220 120" aria-hidden="true"><g fill="currentColor">${[40, 66, 52, 84, 70, 46, 92, 60, 34, 76, 56, 42].map((h, i) => `<rect x="${14 + i * 16.5}" y="${108 - h}" width="10" height="${h}" rx="3" opacity="${(0.2 + (h / 92) * 0.55).toFixed(2)}"/>`).join('')}</g></svg>`,
};

export function mountAI(el) {
  root = el;
  // a Studio card: big ones carry a picture and their count / state pill
  const feat = (win, ic, title, sub, size, pill = '') => `<button class="lab-feat ${size}" data-win-open="${win}">
      <span class="lab-feat-top"><span class="lab-feat-ic">${glyph(ic)}</span>${pill}</span>
      <span class="lab-feat-t"><b>${esc(title)}</b><small>${esc(sub)}</small><span class="lab-feat-go">Open <span aria-hidden="true">→</span></span></span>
      <span class="lab-feat-art">${ART[win] || ''}</span></button>`;
  const win = (id, title, body, wide = false) => `<section class="lab-win${wide ? ' wide' : ''}" data-win="${id}" hidden role="dialog" aria-label="${esc(title)}"><div class="lab-win-h"><b>${esc(title)}</b><span class="grow"></span><button class="icon-btn" data-win-close aria-label="Close" title="Close (Esc)">✕</button></div><div class="lab-win-b">${body}</div></section>`;
  el.innerHTML = `<div class="lab">
    <header class="lab-head"><span class="lab-kicker">Limelight Labs</span><h1>Make more with less editing</h1><p>AI tools, libraries and one-click moves. Click one to open it.</p></header>
    <section class="lab-sec">
      <div class="lab-sec-t"><h2>Studio</h2><span class="lab-rule"></span></div>
      <div class="lab-studio">
        ${feat('work', 'reels', 'Labs timeline', 'Edit a Labs clip on its own timeline: templates, effects and AI, then put it back on the edit', 'big', '<span class="lab-pill" data-lcount></span>')}
        ${feat('moves', 'dolly', 'Camera moves', 'Crash zoom, dolly, drone, arc, roll, bullet time and more: one click on the selected shots', 'big', `<span class="lab-pill">${TEMPLATES.length} moves</span>`)}
        ${feat('voice', 'clone', 'VoiceVerse', 'Clone a voice once, then any script spoken in it', 'mid', '<span class="lab-pill" data-vvst></span>')}
        ${feat('music', 'music', 'Music library', 'Ready music for every edit, from all projects', 'mid', '<span class="lab-pill" data-mcount></span>')}
      </div>
    </section>
    <section class="lab-sec">
      <div class="lab-sec-t"><h2>AI tools</h2><span class="lab-rule"></span></div>
      <div class="lab-cards">
        ${TOOLS.map(([id, l, sub]) => `<button class="lab-card" data-tool="${id}" title="${esc(sub)}"><span class="lab-card-ic">${glyph(id)}</span><span class="lab-card-t"><b>${esc(l)}</b><small>${esc(sub)}</small></span></button>`).join('')}
      </div>
    </section>
    <div class="lab-scrim" data-win-close hidden></div>
    ${win('moves', 'Camera moves', `<div class="lab-sec-h"><p class="lab-note" data-tplsel></p><button class="lab-link" data-a="untpl">Remove from selected</button></div>
      <div class="lab-grid" data-tpls>${TEMPLATES.map((t) => `<button class="lab-tile" data-tpl="${t.id}"><span class="lab-tile-ic">${glyph(t.id)}</span><span class="lab-tile-t"><b>${esc(t.label)}</b><small>${esc(t.sub)}</small></span>${t.video ? '<i class="lab-tag">video</i>' : ''}</button>`).join('')}</div>`)}
    ${win('work', 'Labs timeline', labsWorkHTML(), true)}
    ${win('voice', 'VoiceVerse', vvHTML())}
    ${win('music', 'Music library', `<div class="lab-sec-h"><input type="search" class="lab-find" data-mfind placeholder="Find music…" aria-label="Find music"><button class="lab-link" data-a="mcollect" title="Copy the music used in every project (A2, Music bins) into the library">From all projects</button><button class="lab-link" data-a="madd">Add music…</button><input type="file" accept="audio/*" multiple hidden data-mfile></div>
      <div class="lab-music" data-music><p class="lab-note">Loading…</p></div>`)}
  </div>`;
  mountLabsWork(el.querySelector('[data-work]'));
  el.querySelector('[data-mfind]').oninput = drawMusic;
  el.querySelector('[data-mfile]').onchange = (e) => { addMusic([...e.target.files]); e.target.value = ''; };
  el.addEventListener('click', (e) => {
    const w = e.target.closest('[data-win-open]')?.dataset.winOpen; if (w) return openWin(w);
    if (e.target.closest('[data-win-close]')) return closeWin();
    const a = e.target.closest('[data-a]')?.dataset.a, tpl = e.target.closest('[data-tpl]')?.dataset.tpl, tool = e.target.closest('[data-tool]')?.dataset.tool;
    if (a === 'setup') setupVoice();
    if (a === 'madd') el.querySelector('[data-mfile]').click();
    if (a === 'mcollect') collectMusic();
    const mp = e.target.closest('[data-mplay]')?.dataset.mplay, mu = e.target.closest('[data-muse]')?.dataset.muse;
    if (mp) playMusic(mp);
    if (mu) useMusic(mu);
    // (with a Labs clip open, the templates go on it - Update on timeline puts them on the edit)
    if (a === 'untpl') { if (!labClear()) removeTemplates(); }
    if (tpl) { if (!labTemplate(templateById(tpl))) putTemplate(templateById(tpl)); }
    if (tool) runTool(tool);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.page === 'ai' && openWinId && !document.querySelector('dialog[open]')) closeWin(); });
}
// 🪟 each Labs tool opens in its own window over the page (one at a time; Esc / ✕ / outside closes it)
let openWinId = null;
export function openWin(id) {
  if (!root) return;
  closeWin();
  const w = root.querySelector(`[data-win="${id}"]`); if (!w) return;
  w.hidden = false; root.querySelector('.lab-scrim').hidden = false; openWinId = id;
  if (id === 'music') loadMusic();
  if (id === 'voice') vvWindow();
  if (id === 'work') drawLabs();
}
function closeWin() {
  if (!root || !openWinId) return;
  root.querySelector(`[data-win="${openWinId}"]`).hidden = true; root.querySelector('.lab-scrim').hidden = true;
  if (openWinId === 'work') stopLabs();
  if (openWinId === 'music') { mAudio.pause(); mPlaying = ''; }
  openWinId = null;
}
on('labsWork', () => { if (root) openWin('work'); }); // (a Labs clip opened from the timeline)
export function showAI() { if (!root) return; drawSel(); voiceState(); vvState(); drawLabs(); loadMusic(); const n = Object.keys(S.project?.labs || {}).length; root.querySelector('[data-lcount]').textContent = n ? `${n} clip${n > 1 ? 's' : ''}` : ''; }
export function hideAI() { closeWin(); stopLabs(); mAudio.pause(); }
on('select', () => { if (S.page === 'ai') drawSel(); });
on('change', () => { if (S.page === 'ai') drawLabs(); }); // (undo / redo of a Labs edit)

function drawSel() {
  const c = selClip(), n = S.sel.size;
  const m = c && S.mediaById[c.clip.mediaId];
  if (openWinId === 'voice') vvFill();
  if (labOpen()) { root.querySelector('[data-tplsel]').textContent = `Goes on the open Labs clip "${labOpen().name}" - then Update on timeline`; return; }
  root.querySelector('[data-tplsel]').textContent = n ? `${n} shot${n > 1 ? 's' : ''} selected${c?.clip.tpl ? ` · has "${templateById(c.clip.tpl.id)?.label}"` : ''}` : 'Select shots on the Edit timeline first (V1 or above).';
}

// ---------------- 🎬 templates ----------------
function putTemplate(t) {
  const ids = [...S.sel].filter((id) => ['video', 'image'].includes(findClip(id)?.clip.type));
  if (!ids.length) return toast('Select video or photo shots on the timeline first', 'err');
  let n = 0, skipped = 0;
  for (const id of ids) {
    const c = findClip(id).clip;
    if (t.video && c.type !== 'video') { skipped++; continue; }
    applyTemplate(c, t, clipDur(c, S.mediaById), S.mediaById); n++;
  }
  if (!n) return toast(`${t.label} needs video shots (it changes the speed)`, 'err');
  commit(`Template: ${t.label}`); emit('change', {}); drawSel();
  toast(`${t.label} on ${n} shot${n > 1 ? 's' : ''}${skipped ? ` (${skipped} photo${skipped > 1 ? 's' : ''} skipped)` : ''} - change any part in Effect Controls, Ctrl+Z takes it back`);
}
function removeTemplates() {
  let n = 0;
  for (const id of S.sel) { const c = findClip(id)?.clip; if (c && clearTemplate(c, clipDur(c, S.mediaById), S.mediaById)) n++; }
  if (!n) return toast('No template on the selected shots');
  commit('Remove template'); emit('change', {}); drawSel(); toast(`Template removed from ${n} shot${n > 1 ? 's' : ''}`);
}

// ---------------- 🧠 tools ----------------
async function runTool(id) {
  const busy = (on, label) => emit('job', { running: on, label });
  if (id === 'script') return import('./scriptedit.js').then((x) => x.openScriptEdit((on, l) => busy(on, l)));
  if (id === 'live') return import('./liveedit.js').then((x) => x.openLiveEdit());
  if (id === 'archive') return import('./archive.js').then((x) => x.openArchive());
  if (id === 'qc') return import('./qc.js').then((x) => x.openQC(null));
  if (id === 'agent') return import('./agent.js').then((x) => x.openAgent((on, l) => busy(on, l)));
  if (id === 'vo') return import('./voiceover.js').then((x) => x.openVoiceOver({ setBusy: (on, l) => busy(on, l) }));
  if (id === 'reels') return import('./reels.js').then((x) => x.openReels((on, l) => busy(on, l)));
  if (id === 'planar') {
    const c = selClip();
    if (!c || c.track === 'V1' || !['image', 'video'].includes(c.clip.type)) return modal('Planar tracking', `<ol class="dv-steps"><li>Put the logo / picture / video on <b>V2</b> (above the shot), over the part of the shot where it should stick.</li>
      <li>Select it, move the playhead to a frame where the surface (wall, banner, screen) is clearly visible.</li><li>Effect Controls › <b>Stick onto a surface…</b> and click the surface's four corners on the viewer.</li></ol>
      <p class="muted small">It is tracked through the whole shot (both ways); the picture bends with the camera.</p><div class="dv-actions"><button data-close>OK</button></div>`, { width: 560 });
    emit('gotoPage', 'edit');
    return import('./trackui.js').then((x) => x.addPin(c.id, () => emit('select')));
  }
}

// ---------------- 🎙 VoiceVerse (voice cloning, the editor's own) ----------------
// saved voices (Library/voices, for every project) + a new one from a sample (the selected clip from its In, any clip with
// sound, a file, or 15 s from the microphone) -> the script spoken in the chosen voice (server: POST /api/tts provider
// 'clone', the same-voice model on the editor PC) -> the "AI voice-over" bin, and A1 at the playhead
const withSound = () => S.media.filter((m) => m.kind === 'audio' || (m.kind === 'video' && m.hasAudio));
let vv = { ready: false, voices: [] }, vvPick = (() => { try { return localStorage.getItem('vv.voice') || ''; } catch { return ''; } })();
const vvAudio = new Audio();
async function vvState() {
  vv = await api('GET', '/api/voiceverse').catch(() => ({ ready: false, voices: [] }));
  const s = root.querySelector('[data-vvst]');
  s.textContent = vv.ready ? (vv.voices.length ? `${vv.voices.length} voice${vv.voices.length > 1 ? 's' : ''}` : 'Ready') : vv.setting ? 'Setting up' : 'Needs setup';
  s.classList.toggle('on', !!vv.ready);
  return vv;
}
function vvHTML() {
  return `<div class="vv">
    <div class="vv-setup" data-vvsetup hidden><b>VoiceVerse is not set up on the editor PC yet</b><span class="muted small" data-vst></span><button class="primary" data-a="setup">Set up VoiceVerse (one time, about 5 GB)</button></div>
    <div class="vv-cols">
      <div class="vv-side">
        <div class="vc-step"><b>1 · Voice</b><span class="muted small">saved for every project</span></div>
        <div class="vv-list" data-vvlist></div>
        <details class="vv-new" data-vvnew>
          <summary>+ New voice</summary>
          <p class="muted small">10-15 seconds of one person speaking clearly, close to the mic, no music.</p>
          <div class="vc-src">
            <select data-vvref aria-label="Voice sample"></select>
            <button type="button" class="small" data-vvhear title="Hear the 15 s that will be used">Play</button>
          </div>
          <div class="vc-src">
            <button type="button" class="small" data-vvup title="Use an audio or video file from this computer">Upload…</button>
            <button type="button" class="small" data-vvrec title="Record 15 seconds from the microphone">Record</button>
            <input type="file" accept="audio/*,video/*" hidden data-vvfile>
          </div>
          <div class="vc-src"><input type="text" data-vvname maxlength="60" placeholder="Name - e.g. Rohit (warm, male)"><button type="button" class="primary small" data-vvsave>Save voice</button></div>
          <p class="muted small" data-vvst2></p>
        </details>
      </div>
      <div class="vv-main">
        <div class="vc-step"><b>2 · What the voice says</b><span class="muted small">Hindi, English or Hinglish - a blank line = a short pause</span></div>
        <textarea data-vvtext rows="9" placeholder="नमस्कार, मैं आपका स्वागत करता हूँ…"></textarea>
        <div class="vv-opts">
          <label class="fld"><span>Style</span><select data-vvstyle><option value="calm">Calm - narration</option><option value="natural" selected>Natural</option><option value="lively">Lively - promo</option></select></label>
          <label class="fld"><span>Speed</span><select data-vvspeed><option value="0.9">Slower</option><option value="1" selected>Normal</option><option value="1.1">Faster</option></select></label>
        </div>
        <label class="chk"><input type="checkbox" data-vvsubs checked> Subtitles from it (exact words, timed to the voice)</label>
        <label class="chk"><input type="checkbox" data-vvplace checked> Put it on A1 (Voice-over) at the playhead</label>
        <div class="ag-foot"><span class="muted small" data-vvcount></span><span class="grow"></span><button type="button" class="primary" data-vvgo>Make voice-over</button></div>
        <div class="vv-res" data-vvres hidden></div>
      </div>
    </div>
  </div>`;
}
// the window: the voices, a new one from a sample, the script
let vvWired = false;
async function vvWindow() {
  const box = root.querySelector('[data-win="voice"]');
  if (!vvWired) { vvWire(box); vvWired = true; }
  await vvState();
  box.querySelector('[data-vvsetup]').hidden = !!vv.ready; voiceState();
  vvList(); vvFill();
}
function vvList() {
  const box = root.querySelector('[data-win="voice"]'), list = box.querySelector('[data-vvlist]');
  if (!vv.voices.some((v) => v.id === vvPick)) vvPick = vv.voices[0]?.id || '';
  list.innerHTML = vv.voices.length ? vv.voices.map((v) => `<div class="vv-voice${v.id === vvPick ? ' on' : ''}" data-vvid="${v.id}" role="button" tabindex="0" title="${esc(v.from || '')}">
      <span class="vv-dot"></span><span class="vv-vt"><b>${esc(v.name)}</b><small>${esc([v.by, v.dur ? `${v.dur} s sample` : ''].filter(Boolean).join(' · '))}</small></span>
      <button type="button" class="icon-btn" data-vvplay="${v.id}" title="Hear the sample" aria-label="Hear ${esc(v.name)}">▶</button>
      <button type="button" class="icon-btn" data-vvdel="${v.id}" title="Delete this voice" aria-label="Delete ${esc(v.name)}">✕</button></div>`).join('')
    : '<p class="muted small">No voice saved yet - make one below.</p>';
  box.querySelector('[data-vvnew]').open = !vv.voices.length;
}
// the samples: the selected clip first (from its In), then every file with sound
function vvFill(pick) {
  const sel = root.querySelector('[data-vvref]'), c = selClip(), cm = c && S.mediaById[c.clip.mediaId];
  const own = c && cm?.hasAudio ? [`<option value="clip">Selected clip: ${esc(cm.name)} (from its In)</option>`] : [];
  const was = pick || sel.value;
  sel.innerHTML = own.concat(withSound().map((m) => `<option value="${m.id}">${esc(m.name)}</option>`)).join('') || '<option value="">No clip with sound yet - upload or record one</option>';
  if (was && [...sel.options].some((o) => o.value === was)) sel.value = was;
}
function vvRef() {
  const v = root.querySelector('[data-vvref]').value, c = selClip();
  if (v === 'clip' && c) return { refMediaId: c.clip.mediaId, refIn: +(c.clip.in || 0) };
  return v && v !== 'clip' ? { refMediaId: v, refIn: 0 } : null;
}
function vvWire(box) {
  const q = (x) => box.querySelector(x), st = q('[data-vvst2]'), ta = q('[data-vvtext]');
  let stopAt = 0;
  vvAudio.ontimeupdate = () => { if (stopAt && vvAudio.currentTime >= stopAt) vvAudio.pause(); };
  const play = (src, from = 0, len = 0) => {
    if (!vvAudio.paused && vvAudio.dataset.src === src) return vvAudio.pause();
    if (vvAudio.dataset.src !== src) { vvAudio.src = src; vvAudio.dataset.src = src; }
    vvAudio.currentTime = from; stopAt = len ? from + len : 0; vvAudio.play().catch(() => {});
  };
  box.addEventListener('click', async (e) => {
    const pl = e.target.closest('[data-vvplay]')?.dataset.vvplay, del = e.target.closest('[data-vvdel]')?.dataset.vvdel;
    if (pl) return play(`/api/voiceverse/sample?id=${enc(pl)}`);
    if (del) {
      const v = vv.voices.find((x) => x.id === del);
      if (!confirm(`Delete the voice "${v?.name}"? Voice-overs already made stay.`)) return;
      try { vv.voices = (await api('POST', '/api/voiceverse/voices/delete', { id: del })).voices; vvList(); vvState(); } catch (er) { toast(er.message, 'err'); }
      return;
    }
    const id = e.target.closest('[data-vvid]')?.dataset.vvid;
    if (id) { vvPick = id; try { localStorage.setItem('vv.voice', id); } catch {} vvList(); }
  });
  q('[data-vvhear]').onclick = () => { const r = vvRef(), m = r && S.mediaById[r.refMediaId]; if (m) play(m.urls.play, r.refIn, 15); };
  // a file (or a recording) becomes a clip of the project, then the sample
  const addFile = async (file) => {
    st.textContent = `Adding ${file.name}…`;
    try {
      const added = await uploadFiles([file]), first = added.find((x) => x.kind === 'audio' || x.kind === 'video');
      if (!first) throw new Error('That file has no sound');
      for (let i = 0; i < 60 && S.mediaById[first.id]?.status !== 'ready'; i++) { await new Promise((r) => setTimeout(r, 1000)); await refreshMedia(); }
      vvFill(first.id); st.textContent = `Sample: ${first.name} - name it and press Save voice`;
      if (!q('[data-vvname]').value.trim()) q('[data-vvname]').focus();
    } catch (er) { st.textContent = ''; toast(er.message, 'err'); }
  };
  const fileIn = q('[data-vvfile]');
  q('[data-vvup]').onclick = () => fileIn.click();
  fileIn.onchange = () => { if (fileIn.files[0]) addFile(fileIn.files[0]); fileIn.value = ''; };
  // 🎙 15 s from the microphone (again = stop early)
  let rec = null;
  q('[data-vvrec]').onclick = async () => {
    if (rec) return rec.stop();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } }); }
    catch { return toast('The microphone could not be opened (allow it in the browser)', 'err'); }
    const chunks = [], mr = new MediaRecorder(stream), btn = q('[data-vvrec]'), t0 = Date.now();
    rec = mr; btn.textContent = 'Stop'; btn.classList.add('on');
    const tick = setInterval(() => { const n = Math.round((Date.now() - t0) / 1000); st.textContent = `Recording… ${n} s (read a few lines in a normal voice)`; if (n >= 15) mr.stop(); }, 250);
    mr.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
    mr.onstop = () => {
      clearInterval(tick); stream.getTracks().forEach((t) => t.stop()); rec = null; btn.textContent = 'Record'; btn.classList.remove('on');
      const d = new Date(), p = (x) => String(x).padStart(2, '0');
      addFile(new File(chunks, `Voice sample ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.webm`, { type: mr.mimeType || 'audio/webm' }));
    };
    mr.start(250);
  };
  q('[data-vvsave]').onclick = async () => {
    const r = vvRef(), name = q('[data-vvname]').value.trim();
    if (!r) return toast('Pick, upload or record the voice sample first', 'err');
    if (!name) { q('[data-vvname]').focus(); return toast('Give the voice a name', 'err'); }
    st.textContent = 'Cleaning the sample…';
    try {
      const out = await api('POST', `/api/voiceverse/voices?p=${enc(S.proj)}`, { name, ...r });
      vv.voices = out.voices; vvPick = out.id; try { localStorage.setItem('vv.voice', out.id); } catch {}
      q('[data-vvname]').value = ''; st.textContent = ''; vvList(); vvState();
      toast(`Voice "${name}" saved - every project can use it`);
    } catch (er) { st.textContent = ''; toast(er.message, 'err'); }
  };
  const cnt = () => { const n = ta.value.trim().length; q('[data-vvcount]').textContent = n ? `${n} characters · about ${fmt(n / 14.5)}` : ''; };
  ta.oninput = cnt;
  q('[data-vvgo]').onclick = async () => {
    if (!vv.ready) return toast('Set up VoiceVerse first', 'err');
    const v = vv.voices.find((x) => x.id === vvPick);
    if (!v) return toast('Save or pick a voice first', 'err');
    if (!ta.value.trim()) { ta.focus(); return toast('Write what the voice should say', 'err'); }
    const subs = q('[data-vvsubs]').checked, place = q('[data-vvplace]').checked, go = q('[data-vvgo]'), res0 = q('[data-vvres]');
    vvAudio.pause(); go.disabled = true; res0.hidden = true;
    emit('job', { running: true, label: `VoiceVerse · ${v.name}…` });
    try {
      const job = await api('POST', `/api/tts?p=${enc(S.proj)}`, { provider: 'clone', voiceId: v.id, text: ta.value, style: q('[data-vvstyle]').value, speed: +q('[data-vvspeed]').value, subtitles: subs });
      const res = (await watchJob(job.id, (x) => emit('job', { running: true, label: `VoiceVerse · ${x.stage || 'Speaking…'} ${x.progress || 0}%` }))).result;
      await refreshMedia();
      if (place && res.mediaId) {
        S.project.tracks.A1.push({ id: uid(), type: 'audio', mediaId: res.mediaId, start: +S.playhead.toFixed(3), in: 0, volume: 1 });
        if (res.subs) S.project.subtitles = { ...S.project.subtitles, file: res.subs };
        commit('VoiceVerse voice-over'); emit('subs');
      }
      const m = S.mediaById[res.mediaId];
      res0.innerHTML = `<b>${esc(m?.name || 'Voice-over')}</b><span class="muted small">${fmt(res.duration)} · ${res.sentences} sentence${res.sentences > 1 ? 's' : ''}${place ? ' · on A1 at the playhead' : ' · in the "AI voice-over" bin'}</span>${m ? `<audio controls src="${m.urls.play}"></audio>` : ''}`;
      res0.hidden = false;
      toast(`Voice-over in ${v.name}'s voice (${fmt(res.duration)})${res.subs ? ' with subtitles' : ''}`);
    } catch (er) { toast(er.job?.log?.slice(-1)[0] || er.message, 'err'); } // (a failed job: its own reason, not "Job failed")
    finally { go.disabled = false; emit('job', { running: false }); }
  };
}

// ---------------- 🌐 AI dubbing ----------------
async function voiceState() {
  const st = await api('GET', '/api/aivoice').catch(() => ({ ready: false }));
  const b = root.querySelector('[data-a="setup"]'), s = root.querySelector('[data-vst]');
  b.hidden = st.ready || !!st.setting;
  s.textContent = st.ready ? 'Same voice ready · offline' : st.setting ? `Setting up · ${st.setting.stage || '…'}` : 'Same voice needs setup · Edge voices ready';
  s.classList.toggle('on', !!st.ready);
  if (st.setting) watchSetup(st.setting.id);
}
async function setupVoice() {
  if (!confirm('Download and install the same-voice AI on this computer?\n\nAbout 5 GB (PyTorch for the GPU + the Chatterbox voice model, MIT licence). It runs offline afterwards; no voice or script is uploaded.')) return;
  try { const j = await api('POST', '/api/aivoice/setup', {}); watchSetup(j.id); } catch (e) { toast(e.message, 'err'); }
}
async function watchSetup(id) {
  const s = root.querySelector('[data-vst]');
  try { await watchJob(id, (x) => (s.textContent = `${x.stage || 'Setting up…'} ${x.progress || 0}%`)); toast('VoiceVerse is ready'); }
  catch (e) { toast(`Setup failed: ${e.job?.log?.slice(-1)[0] || e.message}`, 'err'); }
  voiceState(); if (openWinId === 'voice') vvWindow();
}

// any clip with speech -> its lines (transcribed) -> translated (Claude) -> checked -> spoken in the speaker's own voice
// (or an Edge / ElevenLabs voice), each line fitted into its time -> a new audio clip under the shot, the original quiet
export async function openAiDub(clipId = selClip()?.id) {
  const f0 = clipId && findClip(clipId), c = f0?.clip, m = c && S.mediaById[c.mediaId];
  if (!m?.hasAudio) return toast('Select a clip with speech on the timeline first', 'err');
  const { voicePicker, parseSrt } = await import('./voiceover.js');
  const vs = await api('GET', '/api/aivoice').catch(() => ({ ready: false }));
  const body = document.createElement('div');
  body.className = 'vo dub';
  body.innerHTML = `<div class="fgrid">
      <label class="fld"><span>The clip speaks</span><select name="from"><option value="auto">Auto-detect</option><option value="hi">Hindi</option><option value="en">English</option></select></label>
      <label class="fld"><span>Dub into</span><select name="to">${LANGS.map(([k, l, same]) => `<option value="${k}">${l}${same ? ' - own voice' : ''}</option>`).join('')}</select></label>
      <label class="fld wide"><span>Voice</span><select name="voiceKind"><option value="clone"${vs.ready ? '' : ' disabled'}>The speaker's own voice (languages marked own voice${vs.ready ? '' : ' - set it up on the Labs page first'})</option><option value="other">Another AI voice (Microsoft Edge / ElevenLabs)</option></select></label>
    </div>
    <div data-picker hidden></div>
    <div class="row-in"><button type="button" class="accent small" data-go1>Listen and translate</button><span class="muted small grow" data-st>${esc(m.name)}</span></div>
    <div class="dub-lines" data-lines><p class="muted small">Its lines appear here, translated and timed - fix any word before making the voice.</p></div>
    <label class="chk"><input type="checkbox" name="duck" checked> Keep the clip's own sound quietly underneath (ambience)</label>
    <div class="ag-foot"><span class="grow"></span><button type="button" data-close>Cancel</button><button type="button" class="primary" data-go2 disabled>Make the dub</button></div>`;
  const dlg = modal('AI dubbing', body, { width: 760 });
  const q = (s) => body.querySelector(s), f = (n) => q(`[name="${n}"]`);
  if (!vs.ready) f('voiceKind').value = 'other';
  const pick = voicePicker(q('[data-picker]'), { text: () => lines.map((l) => l.text).join(' ') });
  const showPick = () => { q('[data-picker]').hidden = f('voiceKind').value === 'clone'; };
  f('voiceKind').onchange = showPick; showPick();
  f('to').onchange = () => { const same = LANGS.find((l) => l[0] === f('to').value)?.[2]; if (!same && f('voiceKind').value === 'clone') { f('voiceKind').value = 'other'; showPick(); toast(`The speaker's own voice does not speak ${langName(f('to').value)} yet - an Edge voice will`); } };
  let lines = [];
  const tin = c.in || 0, tout = c.out ?? m.duration;
  const draw = () => {
    q('[data-lines]').innerHTML = `<table class="se-table"><tr><th>Time</th><th>Original</th><th>${esc(langName(f('to').value))}</th></tr>${lines.map((l, i) => `<tr><td class="muted">${fmt(l.start - tin)}</td><td class="muted small">${esc(l.orig)}</td><td><textarea data-i="${i}" rows="1">${esc(l.text)}</textarea></td></tr>`).join('')}</table>`;
    q('[data-go2]').disabled = !lines.length;
    pick.refit(); // (the translated words decide which voices can read them)
  };
  body.addEventListener('input', (e) => { const i = e.target.dataset.i; if (i !== undefined) lines[+i].text = e.target.value; });
  q('[data-go1]').onclick = async (e) => {
    const b = e.target; b.disabled = true;
    try {
      q('[data-st]').textContent = 'Listening…';
      const job = await api('POST', `/api/transcribe?p=${enc(S.proj)}`, { mediaId: m.id, task: 'transcribe', lang: f('from').value, model: 'large-v3-turbo' });
      const j = await watchJob(job.id, (x) => (q('[data-st]').textContent = `Listening… ${x.progress || 0}%`));
      const srt = await api('GET', `/api/subs/file?p=${enc(S.proj)}&name=${enc(j.result.subs)}`);
      lines = parseSrt(srt.text).filter((l) => l.end > tin && l.start < tout).map((l) => ({ ...l, orig: l.text }));
      if (!lines.length) throw new Error('No speech heard in this part of the clip');
      q('[data-st]').textContent = `Translating ${lines.length} lines into ${langName(f('to').value)}…`;
      const tj = await api('POST', `/api/dub/translate?p=${enc(S.proj)}`, { texts: lines.map((l) => l.orig), to: langName(f('to').value), from: f('from').value === 'auto' ? '' : langName(f('from').value) });
      const tr = (await watchJob(tj.id, () => {})).result.lines;
      lines.forEach((l, i) => (l.text = tr[i] ?? l.orig));
      q('[data-st]').textContent = `${lines.length} lines - check them, then make the dub`;
      draw();
    } catch (x) { q('[data-st]').textContent = x.job?.log?.slice(-1)[0] || x.message; }
    finally { b.disabled = false; b.textContent = 'Listen and translate again'; }
  };
  q('[data-go2]').onclick = async () => {
    const clone = f('voiceKind').value === 'clone', v = clone ? { provider: 'clone' } : pick();
    if (!clone && !v.voice) return toast('Choose a voice', 'err');
    const duck = f('duck').checked;
    dlg.close(); emit('job', { running: true, label: 'Making the dub…' });
    try {
      const job = await api('POST', `/api/dub?p=${enc(S.proj)}`, { ...v, lang: f('to').value, mediaId: m.id, lines: lines.map(({ start, end, text }) => ({ start, end, text })) });
      const r = (await watchJob(job.id, (x) => emit('job', { running: true, label: `Dub · ${x.stage || 'Making the dub…'} ${x.progress || 0}%` }))).result;
      await refreshMedia();
      const x = layout()[f0.track].find((p) => p.clip.id === clipId), cl = findClip(clipId)?.clip;
      S.project.tracks.A1.push({ id: uid(), type: 'audio', mediaId: r.mediaId, start: +x.start.toFixed(3), in: tin, out: tout, volume: 1, dubOf: clipId });
      cl.volume = duck ? 0.15 : 0;
      commit(`AI dub (${langName(f('to').value)})`);
      toast(`${langName(f('to').value)} dub ready${clone ? ' in the speaker\'s own voice' : ''}: ${r.lines} lines${r.fitted ? `, ${r.fitted} sped up a little to fit` : ''}`);
    } catch (x) { toast(x.job?.log?.slice(-1)[0] || x.message, 'err'); }
    finally { emit('job', { running: false }); }
  };
}

// ---------------- 🎵 music library ----------------
// Library/music on the editor PC, shared by every project and editor: listen, Use (into Media + A2 Music at the
// playhead), Add music (files from this computer go into the library for everyone)
let tracks = [], mPlaying = '';
const mAudio = new Audio();
mAudio.onended = () => { mPlaying = ''; drawMusic(); };
async function loadMusic() {
  try { tracks = await api('GET', '/api/library/music'); } catch { tracks = []; }
  root.querySelector('[data-mcount]').textContent = tracks.length ? `${tracks.length} tracks` : '';
  drawMusic();
}
function drawMusic() {
  const box = root.querySelector('[data-music]'), q = root.querySelector('[data-mfind]').value.trim().toLowerCase();
  const list = tracks.filter((t) => !q || t.title.toLowerCase().includes(q));
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  box.innerHTML = list.length ? `<div class="lab-list">${list.map((t) => `<div class="lab-row lab-mrow">
      <button class="icon-btn lab-mplay${mPlaying === t.name ? ' on' : ''}" data-mplay="${esc(t.name)}" title="${mPlaying === t.name ? 'Stop' : 'Listen'}">${mPlaying === t.name ? '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/></svg>' : '<svg viewBox="0 0 16 16"><path d="M5 3.5v9l7-4.5z" fill="currentColor"/></svg>'}</button>
      <span class="lab-tile-t"><b>${esc(t.title)}</b><small>${mb(t.size)}</small></span>
      <button class="small" data-muse="${esc(t.name)}" title="Into this project's Media and onto A2 (Music) at the playhead">Use</button></div>`).join('')}</div>`
    : `<p class="lab-note">${tracks.length ? 'No music matches.' : 'No music in the library yet - press Add music… to put mp3 / wav files in it for everyone.'}</p>`;
}
function playMusic(name) {
  if (mPlaying === name) { mAudio.pause(); mPlaying = ''; return drawMusic(); }
  mAudio.src = `/api/library/music/file?name=${enc(name)}`; mAudio.play().catch(() => {}); mPlaying = name; drawMusic();
}
async function useMusic(name) {
  try {
    toast('Adding the music…');
    const m = await api('POST', `/api/library/music/use?p=${enc(S.proj)}`, { name });
    await refreshMedia();
    S.project.tracks.A2 ||= [];
    S.project.tracks.A2.push({ id: uid(), type: 'audio', mediaId: m.id, start: +S.playhead.toFixed(3), in: 0, volume: 1 });
    commit(`Music: ${m.name}`);
    toast(`${m.name} is on A2 (Music) at ${fmt(S.playhead)} - also in Media › Music`);
  } catch (e) { toast(e.message, 'err'); }
}
async function addMusic(files) {
  let n = 0;
  for (const f of files) {
    try { toast(`Adding ${f.name} to the music library…`); await upload(`/api/library/music/add?name=${enc(f.name)}`, f); n++; }
    catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  if (n) { toast(`${n} track${n > 1 ? 's' : ''} added to the music library`); loadMusic(); }
}

// every project's music into the library (server: the music on A2 / in Music bins of all projects, copied once)
async function collectMusic() {
  if (!confirm('Copy the music of every project (A2 Music track, Music bins) into the music library for everyone?\n\nVoice-overs and sound effects are left out; a track already in the library is not copied again.')) return;
  emit('job', { running: true, label: 'Collecting music from all projects…' });
  try {
    const j = await api('POST', '/api/library/music/collect', {});
    const r = (await watchJob(j.id, (x) => emit('job', { running: true, label: `Music · ${x.stage || '…'} ${x.progress || 0}%` }))).result;
    toast(`${r.copied} new track${r.copied === 1 ? '' : 's'} in the music library (from ${r.projects} projects${r.same ? `, ${r.same} already there` : ''}${r.missing ? `, ${r.missing} file${r.missing === 1 ? '' : 's'} not found` : ''})`);
    loadMusic();
  } catch (e) { toast(e.message, 'err'); }
  finally { emit('job', { running: false }); }
}

