// ☰ Menu bar, like Premiere's: File · Edit · Clip · Sequence · Markers · Graphics and Titles · View · Window · Help.
// Every item runs something the editor already does (a keyboard command, a top-bar button, a page); its key is shown
// from the chosen shortcut preset. Also holds what left Effect Controls: Logo / watermark and Backups.
import { S, commit, emit, saveNow } from './store.js';
import { CMD, keysFor } from './keys.js';
import { api, enc } from './api.js';
import { $, h, esc, modal, fieldsHTML, bindFields, toast } from './ui.js';

// item: [label, run] - run: 'k:<command>' (keys.js), 'a:<top-bar action>', 'p:<page>', or a name main.js handles
const MENUS = [
  ['File', [['Projects (home)', 'a:home'], ['Open… (Premiere / Resolve XML)', 'k:openXml'], ['Import files…', 'import'], '-', ['Save', 'k:save'], ['Sequences…', 'a:seq'], ['Versions…', 'a:versions'], ['Backups…', 'backups'], ['Mazbooti (nightly backup, health, standby PC)…', 'a:safety'], '-',
    ['Logo / watermark…', 'logo'], ['Brand packs…', 'a:brand'], ['Media manager…', 'a:mediamgr'], '-', ['Export media…', 'k:exportMedia'], ['Export Frame', 'k:exportFrame'], ['Export EDL (for colour / conform)…', 'k:exportEdl']]],
  ['Edit', [['Undo', 'k:undo'], ['Redo', 'k:redo'], ['AI undo…', 'a:aiundo'], '-', ['Cut', 'k:cut'], ['Copy', 'k:copy'], ['Paste', 'k:paste'], ['Paste insert', 'k:pasteInsert'], ['Duplicate', 'k:duplicate'], ['Paste attributes…', 'k:pasteAttr'], '-',
    ['Delete (leave a gap)', 'k:clear'], ['Ripple delete (close the gap)', 'k:rippleDelete'], '-', ['Select all', 'k:selectAll'], ['Deselect all', 'k:deselectAll'], '-', ['Keyboard shortcuts…', 'k:shortcuts']]],
  ['Clip', [['Speed / Duration…', 'k:speedDuration'], ['Split at playhead', 'k:addEdit'], ['Enable / disable', 'k:enable'], ['Link / unlink audio and video', 'k:link'], ['Nest…', 'k:nest'], ['Group', 'k:group'], ['Ungroup', 'k:ungroup'], ['Audio gain…', 'k:audioGain'], '-',
    ['Insert from Source', 'k:insert'], ['Overwrite from Source', 'k:overwrite'], ['Replace with clip from Source monitor', 'k:replaceEdit'], ['Match frame', 'k:matchFrame'], '-',
    ['Nudge 1 frame left', 'k:nudgeL'], ['Nudge 1 frame right', 'k:nudgeR'], '-', ['Stabilize with Gyroflow…', 'gyro'], ['Effect Controls', 'ec']]],
  ['Sequence', [['Sequence Settings…', 'k:seqSettings'], '-', ['Add default transition', 'k:transition'], ['Split all tracks at playhead', 'k:addEditAll'], ['Ripple trim previous edit', 'k:rippleTrimPrev'], ['Ripple trim next edit', 'k:rippleTrimNext'], ['Lift (In to Out, leave a gap)', 'k:lift'], ['Extract (In to Out, close the gap)', 'k:extract'], ['Trim mode (cut nearest the playhead)', 'k:trimMode'], ['Close gaps', 'k:closeGaps'], ['Go to next gap', 'k:nextGap'], ['Go to previous gap', 'k:prevGap'], ['Auto Reframe Sequence…', 'k:autoReframe'], ['Go to / move by timecode…', 'k:timecode'], '-',
    ['Snapping on / off', 'k:snap'], ['Duplicate frame markers on / off', 'k:dupFrames'], ['Select clip at playhead', 'k:selectAtPlayhead'], '-', ['Sequences…', 'a:seq'], ['Arrange layers (V2 looks · V3 comps · V4 text)', 'layers'], ['Render accurate preview', 'accurate']]],
  ['Markers', [['Add marker', 'k:marker'], ['Add clip marker', 'k:clipMarker'], ['Ripple sequence markers (on / off)', 'k:rippleMarkers'], ['Next marker', 'k:nextMarker'], ['Previous marker', 'k:prevMarker'], ['Markers list…', 'k:markersList'], '-', ['Add review note', 'k:note']]],
  ['Graphics and Titles', [['Type tool (write on the monitor)', 'k:typeTool'], ['New title card', 'title'], ['Title templates…', 'titles'], ['Presets page (intros, logo stings, lower thirds…)', 'p:presets'], ['Custom templates (MOGRT, logo animations)…', 'customtpl'], ['Captions', 'cc'], '-', ['Motion page', 'p:motion'], ['Nodes page', 'p:fusion'], ['VFX page (explosions, rain, sky, keying…)', 'p:vfx']]],
  ['View', [['Zoom in', 'k:zoomIn'], ['Zoom out', 'k:zoomOut'], ['Zoom to sequence', 'k:zoomFit'], '-', ['History', 'k:history'], ['Maximize panel', 'k:maximize'], ['Full screen', 'k:fullscreen'], '-', ['Workspaces…', 'a:workspace'], '-', ['Sound output (speakers / headphones)…', 'audioout']]],
  ['Window', [['Media', 'p:media'], ['Edit', 'p:edit'], ['Motion', 'p:motion'], ['Nodes', 'p:fusion'], ['VFX', 'p:vfx'], ['Color', 'p:color'], ['Audio', 'p:audio'], ['Labs', 'p:ai'], ['Presets', 'p:presets'], ['Deliver', 'p:deliver'], '-',
    ['Effects', 'fx'], ['Effect Controls', 'ec'], ['Activity', 'a:activity'], ['Zones', 'a:zones'], ['Team', 'a:team'], ['Project chat', 'a:chat'], '-', ['Agent', 'a:agent'], ['Re-edit', 'a:reedit'], ['Assistant (Claude)', 'a:assistant']]],
  ['Help', [['Bhaiya - ask anything about the editor (F1)', 'a:help'], '-', ['Keyboard shortcuts…', 'k:shortcuts'], ['Ask the Assistant', 'a:assistant'], ['Agent report', 'a:report']]],
];

let bar, openI = -1;
export function mountMenuBar(host, run) {
  bar = h(`<nav class="menubar" aria-label="Menu">${MENUS.map(([name], i) => `<button class="mb-top" data-mi="${i}" aria-haspopup="true">${esc(name)}</button>`).join('')}<div class="mb-drop" hidden role="menu"></div></nav>`);
  host.prepend(bar);
  const drop = $('.mb-drop', bar);
  const show = (i) => {
    openI = i;
    bar.querySelectorAll('.mb-top').forEach((b, k) => b.classList.toggle('on', k === i));
    if (i < 0) { drop.hidden = true; return; }
    const top = bar.querySelector(`[data-mi="${i}"]`);
    drop.innerHTML = MENUS[i][1].map((it) => {
      if (it === '-') return '<hr>';
      const [label, r] = it, key = r.startsWith('k:') && CMD[r.slice(2)] ? keysFor(r.slice(2))[0] : '';
      return `<button role="menuitem" data-run="${esc(r)}"><span>${esc(label)}</span><kbd>${esc(key || '')}</kbd></button>`;
    }).join('');
    drop.style.left = `${top.offsetLeft}px`; drop.hidden = false;
  };
  bar.addEventListener('click', (e) => {
    const t = e.target.closest('.mb-top');
    if (t) return show(openI === +t.dataset.mi ? -1 : +t.dataset.mi);
    const it = e.target.closest('[data-run]');
    if (it) { show(-1); run(it.dataset.run); }
  });
  bar.addEventListener('pointerover', (e) => { const t = e.target.closest('.mb-top'); if (t && openI >= 0 && +t.dataset.mi !== openI) show(+t.dataset.mi); });
  document.addEventListener('pointerdown', (e) => { if (openI >= 0 && !bar.contains(e.target)) show(-1); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openI >= 0) { e.stopPropagation(); show(-1); } }, true);
}

// 🏷 Logo / watermark (was in Effect Controls with nothing selected)
export function openLogo() {
  const p = S.project, images = S.media.filter((m) => m.kind === 'image');
  const body = h(`<div><div class="fgrid">${fieldsHTML([
    { k: 'logo.mediaId', label: 'Logo image', type: 'select', options: [['', 'None'], ...images.map((m) => [m.id, m.name])] },
    { k: 'logo.pos', label: 'Position', type: 'select', options: [['tr', 'Top right'], ['tl', 'Top left'], ['br', 'Bottom right'], ['bl', 'Bottom left']] },
    { k: 'logo.scale', label: 'Size', type: 'range', min: 0.04, max: 0.4, step: 0.01, def: 0.12 },
    { k: 'logo.opacity', label: 'Opacity', type: 'range', min: 0.1, max: 1, step: 0.01, def: 0.9 },
  ], p)}</div><small class="hint">On every frame of the edit, over everything else. Right-click a picture in Media › Use as logo also sets it.</small></div>`);
  modal('Logo / watermark', body, { width: 460 });
  bindFields(body, () => S.project, { live: () => emit('live'), commit: (k) => commit(`Project ${k}`, k) });
}

// 🗄 Backups: the timeline as it was saved every few minutes
export async function openBackups() {
  const body = h('<div><p class="muted small">Saved automatically every few minutes while you work. Restoring one keeps the current version as a backup first.</p><div class="bk-list muted">Loading…</div></div>');
  const dlg = modal('Backups', body, { width: 460 });
  try {
    const b = await api('GET', `/api/backups?p=${enc(S.proj)}`);
    $('.bk-list', body).innerHTML = b.length ? b.slice(0, 30).map((x) => `<button class="link" data-restore="${esc(x.name)}">${new Date(x.mtime).toLocaleString()}</button>`).join('<br>') : 'No backups yet.';
  } catch (e) { $('.bk-list', body).textContent = e.message; }
  body.addEventListener('click', async (e) => {
    const rs = e.target.closest('[data-restore]')?.dataset.restore;
    if (!rs || !confirm(`Restore the timeline saved at ${e.target.textContent}?\n\nThe current version is backed up first.`)) return;
    await saveNow(true);
    S.project = await api('POST', `/api/restore?p=${enc(S.proj)}&file=${enc(rs)}`);
    commit('Restore backup'); toast('Backup restored'); dlg.close();
  });
}
