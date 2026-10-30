// 🎬 Open in Premiere / Open in DaVinci: one click. The server writes the project folder's hand-off now
// (engine/nlfolder.mjs: "Premiere - DaVinci\<name>.xml", the footage linked where it is on the NAS) and a
// limelight://nle/<app>?f=<xml> link lets Limelight Editor.exe on THIS PC start Premiere Pro / DaVinci Resolve with it -
// in the app's own window and in a normal browser alike (Windows asks the browser once). The same folder also has
// Open in Premiere.cmd / Open in DaVinci.cmd, for when the editor is down.
import { api, enc } from './api.js';
import { esc, toast, modal } from './ui.js';

const APPS = { premiere: 'Premiere Pro', resolve: 'DaVinci Resolve' };
// Limelight Editor.exe's version from its User-Agent ("LimelightEditor/1.4.0") - 0 in a normal browser
const exeVersion = () => { const m = /LimelightEditor\/(\d+)\.(\d+)/.exec(navigator.userAgent); return m ? +m[1] * 100 + +m[2] : 0; };

export async function openInNle(proj, app, { save } = {}) {
  if (!APPS[app] || !proj) return;
  toast(`Opening in ${APPS[app]}…`);
  let r;
  try { if (save) await save(); r = await api('POST', `/api/nle/open?p=${enc(proj)}`); } catch (e) { return toast(e.message, 'err'); }
  const v = exeVersion(), old = v && v < 104;
  if (!old) { const a = document.createElement('a'); a.href = `limelight://nle/${app}?f=${encodeURIComponent(r.xml)}`; a.click(); }
  const copy = () => navigator.clipboard?.writeText(r.xml).then(() => toast('Path copied'), () => {});
  modal(`${esc(APPS[app])}`, `${old ? `<p><b>This Limelight Editor app is too old for one-click opening</b> (needs 1.4) - get the new one from the Limelight Kit, or open the file below by hand.</p>`
    : `<p><b>${esc(APPS[app])} is opening on this PC</b> with the timeline (${r.clips} clips).</p>
      <p class="muted">${v && v < 105 ? 'Footage from the NAS - the new Limelight Editor app (1.5) copies it onto this PC first, so nothing is offline.'
        : 'The Limelight Editor app (1.5 or newer) copies the footage onto this PC first - a window shows how far it is. A big project takes a while the first time; after that only new or changed files are copied.'}</p>`}
    ${app === 'resolve' ? `<ol class="dv-steps"><li>In Resolve open any project (Untitled is fine).</li><li><b>Workspace → Scripts → Limelight Timeline</b> - the timeline comes in as a new project.</li></ol>
      <p class="muted">Or File → Import → Timeline and pick the XML below.</p>` : ''}
    <p class="muted">Not opening? The Limelight Editor app must be on this PC (it handles the link). The same files are always in the project folder - double-click <b>Open in ${app === 'resolve' ? 'DaVinci' : 'Premiere'}.cmd</b> there, even when the editor is down:</p>
    <p class="mono small">${esc(r.xml)}</p>
    ${r.notes?.length ? `<details><summary class="muted">Redo by hand (${r.notes.length})</summary><ul class="warns">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
    <div class="dv-actions"><button data-action="copy">Copy path</button><button class="primary" data-close>OK</button></div>`,
  { width: 560, onAction: (a) => { if (a === 'copy') copy(); } });
}
