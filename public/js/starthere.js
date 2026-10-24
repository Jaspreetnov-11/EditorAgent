// 🚩 Start here: a new editor's first edit in four big steps - bring footage, pick what to make, let the Agent edit,
// check and export. Each step opens the dialog that already does it. On Home it sits above the projects (only for
// someone with few projects); in a project it shows while the sequence is still empty (Media page help, and over the
// empty timeline). "Hide" puts it away in this browser; Tools › Start here brings it back.
import { S, on, emit } from './store.js';
import { $, $$, h, esc, toast, modal } from './ui.js';
import { JOBS, TYPES, openAgent } from './agent.js';
import { openPromptGuide } from './promptguide.js';

const HIDE = 've-start-hide', JOBKEY = 've-start-job', FEW = 6; // (Home: the big card only with fewer projects than this)
export const startHidden = () => { try { return localStorage.getItem(HIDE) === '1'; } catch { return false; } };
const setHidden = (v) => { try { if (v) localStorage.setItem(HIDE, '1'); else localStorage.removeItem(HIDE); } catch {} };
// the job picked on Home before its project existed: the new project's steps start from it (this tab, for an hour)
const pendingJob = () => { try { const x = JSON.parse(sessionStorage.getItem(JOBKEY) || 'null'); return x && Date.now() - x.at < 3600e3 ? x.id : null; } catch { return null; } };
const setPending = (id) => { try { if (id) sessionStorage.setItem(JOBKEY, JSON.stringify({ id, at: Date.now() })); else sessionStorage.removeItem(JOBKEY); } catch {} };

// step 2: the ready-made jobs, and the Agent's other kinds that a new editor asks for most
const KINDS = [...JOBS.map((j) => ({ job: j.id, label: j.label, sub: j.sub })), { type: 'reference', label: 'Copy a reference', sub: 'cut like a video you like' }, { type: 'reel', label: 'Something else…', sub: 'every kind the Agent makes' }];
const kindChips = (chosen) => `<div class="sh-kinds">${KINDS.map((k) => `<button type="button" class="chip${k.job && k.job === chosen ? ' on' : ''}" ${k.job ? `data-shjob="${k.job}"` : `data-shtype="${k.type}"`} title="${esc(k.sub)}">${esc(k.label)}</button>`).join('')}</div>`;
const head = (title) => `<div class="sh-head"><div><span class="sh-kicker">Automation</span><h2>${title}</h2></div><span class="grow"></span>
  <button type="button" class="link small" data-shguide>Prompt guide</button><button type="button" class="link small" data-shhide title="Tools › Automation brings it back">Hide</button></div>`;
const step = (n, title, text, extra = '', done = false) => `<li class="sh-step${done ? ' done' : ''}"><i>${done ? '✓' : n}</i><div><b>${title}</b><small>${text}</small>${extra}</div></li>`;

// ---------------- 🏠 Home ----------------
// el: Home; count: projects shown; newProject(): the New project dialog (home.js)
export function mountHomeStart(el, count, newProject) {
  $('.sh-home', el)?.remove(); $('[data-shopen]', el)?.remove();
  const big = !startHidden() && count < FEW;
  if (!big) { // the steps one click away: a small button beside + New project
    $('.home-actions', el)?.insertAdjacentHTML('afterbegin', `<button class="small" data-shopen title="Automation: your first edit in 4 steps, ready-made jobs, prompt guide">Automation</button>`);
    $('[data-shopen]', el).onclick = () => { setHidden(false); mountHomeStart(el, 0, newProject); };
    return;
  }
  const card = h(`<section class="sh sh-home">${head('Your first edit in 4 steps')}<ol class="sh-steps">
    ${step(1, 'Bring footage', 'Make a project, then <b>+ Folder</b> picks the raw folder. Clips stay where they are.', '<button type="button" class="primary small" data-shnew>New project</button>')}
    ${step(2, 'Pick what to make', 'A ready-made job fills the Agent in for you.', kindChips(pendingJob()))}
    ${step(3, 'Let the Agent edit', 'It looks at the footage, follows the voice-over and cuts on the beat. Tell it more in your own words.')}
    ${step(4, 'Check & export', 'Watch it (Space), change things in the Assistant ("music dheema karo"), then <b>Export</b> at the top right.')}
  </ol></section>`);
  $('.home-head', el).after(card);
  card.onclick = (e) => {
    e.stopPropagation(); // (Home's own click handler opens projects)
    if (e.target.closest('[data-shhide]')) { setHidden(true); toast('Automation is hidden - the Automation button (and Tools › Automation) brings it back'); return mountHomeStart(el, count, newProject); }
    if (e.target.closest('[data-shguide]')) return openPromptGuide();
    if (e.target.closest('[data-shnew]')) return newProject();
    const k = e.target.closest('[data-shjob], [data-shtype]');
    if (k) { // a job before there is a project: the New project dialog in its format, and the project's steps start from it
      const j = JOBS.find((x) => x.id === k.dataset.shjob), aspect = TYPES.find((t) => t.id === (j?.type || k.dataset.shtype))?.aspect;
      setPending(j?.id || null);
      newProject();
      const r = document.querySelector(`form.np input[name="aspect"][value="${aspect}"]`); if (r) r.checked = true;
      if (j) toast(`${j.label}: make the project, bring the footage - the Agent opens with it filled in`);
    }
  };
}

// ---------------- 🎞 in a project ----------------
let busyFn = null;
const hasFootage = () => S.media.some((m) => m.kind === 'video' || m.kind === 'image');
const hasEdit = () => Object.values(S.project?.tracks || {}).some((t) => t.length);
const projectSteps = () => { const fo = hasFootage(), ed = hasEdit(), job = JOBS.find((j) => j.id === pendingJob()); return `<ol class="sh-steps">
  ${step(1, 'Bring footage', fo ? `${S.media.filter((m) => m.kind === 'video' || m.kind === 'image').length} clips in Media. More? + Folder again.` : 'Pick the raw folder - sub-folders too. Clips stay where they are.', '<button type="button" class="small" data-shfolder>+ Folder</button>', fo)}
  ${step(2, 'Pick what to make', job ? `<b>${esc(job.label)}</b> (${esc(job.sub)}) - or another:` : 'A ready-made job fills the Agent in for you.', kindChips(job?.id))}
  ${step(3, 'Let the Agent edit', 'Footage, VO, music and your own words - it makes the whole edit on the timeline.', `<button type="button" class="${fo && !ed ? 'primary ' : ''}small" data-shagent>Open the Agent</button>`, ed)}
  ${step(4, 'Check & export', 'Watch (Space), change things in the Assistant, then Export.', `<button type="button" class="small" data-shexport${ed ? '' : ' disabled'}>Export</button>`)}
</ol>`; };
function onStepClick(e, after) {
  if (e.target.closest('[data-shhide]')) { setHidden(true); toast('Automation is hidden - Tools › Automation brings it back'); return refreshProjectStart(); }
  if (e.target.closest('[data-shguide]')) return openPromptGuide();
  if (e.target.closest('[data-shfolder]')) { after?.(); return document.querySelector('#poolBig [data-a="folder"], #pool [data-a="folder"]')?.click(); }
  if (e.target.closest('[data-shexport]')) { after?.(); return emit('gotoPage', 'deliver'); }
  const k = e.target.closest('[data-shjob], [data-shtype], [data-shagent]');
  if (!k) return;
  if (!hasFootage()) return toast('Bring the footage first (step 1: + Folder)', 'err');
  after?.();
  const job = k.dataset.shjob || (k.dataset.shagent !== undefined ? pendingJob() : null);
  setPending(null); // (used now - it must not follow the editor into the next project)
  openAgent(busyFn, job ? { job } : { type: k.dataset.shtype || null });
}
// the steps in the Media page's help and over the empty timeline, kept in step with the project
export function mountProjectStart(setBusy) {
  busyFn = setBusy;
  for (const ev of ['change', 'media', 'seq']) on(ev, () => refreshProjectStart());
}
let lastKey = '';
export function refreshProjectStart() {
  const show = !!S.project && !startHidden() && !hasEdit();
  const key = `${show}|${hasFootage()}|${pendingJob()}|${S.media.length}`;
  if (key === lastKey && (!show || $('.sh-over'))) return;
  lastKey = key;
  const help = $('.media-help'), tl = $('#timeline');
  help?.querySelector('.sh')?.remove(); tl?.querySelector('.sh-over')?.remove();
  help?.classList.toggle('sh-keep', show); tl?.classList.toggle('sh-has', show);
  if (!show) return;
  const mk = (cls) => { const c = h(`<section class="sh ${cls}">${head('Your first edit in 4 steps')}${projectSteps()}</section>`); c.onclick = (e) => onStepClick(e); return c; };
  help?.prepend(mk('sh-media'));
  tl?.append(mk('sh-over'));
}
// Tools › Start here: the steps in a window (and shown again where they were, if they had been hidden)
export function openStartHere() {
  setHidden(false); lastKey = ''; refreshProjectStart();
  const body = h(`<div class="sh sh-dlg">${projectSteps()}<div class="dv-actions"><button type="button" class="link small" data-shguide>Prompt guide</button><span class="grow"></span><button data-close>Close</button></div></div>`);
  const dlg = modal('Automation - your first edit in 4 steps', body, { width: 560 });
  body.onclick = (e) => onStepClick(e, () => dlg.close());
}
