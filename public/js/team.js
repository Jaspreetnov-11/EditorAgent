// 👥 Team (owner, on the editing computer): let other computers in the office use the editor - turn it on, make
// logins (name, password, role), share folders (shown first when importing), see who is online and who edits what.
import { api } from './api.js';
import { $, esc, toast, modal } from './ui.js';
import { pickFolder } from './mediapool.js';
import { openSessions } from './sessionsui.js';

// 🌙 the night shift's hours (0-23) as <option>s
const hours = (sel) => Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === +sel ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
const ROLES = [['editor', 'Editor - edits, renders, imports'], ['viewer', 'Viewer - watches only'], ['owner', 'Owner - also settings, accounts, team']];

export async function openTeam() {
  const dlg = modal('Team', '<div class="tm"><div data-tm><div class="muted pad">Loading…</div></div><div data-farm hidden></div><div class="dv-actions"><button data-close>Close</button></div></div>', { width: 860 });
  const box = $('[data-tm]', dlg.el), farmBox = $('[data-farm]', dlg.el);
  farmPanel(farmBox, dlg);
  let tab = 'people';
  const initials = (n) => String(n).replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const hue = (n) => [...String(n)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
  const copyRow = (label, u, extra = '') => `<div class="sh-url"><span class="small muted tm-lbl">${label}</span><span class="mono grow">${esc(u)}${extra}</span><button class="small" data-copy="${esc(u)}">Copy</button></div>`;
  const draw = (t) => {
    const online = t.users.filter((x) => t.online.includes(x.name)).length;
    const top = `<div class="tm-top">
        <span class="tm-pill ${t.on ? 'on' : ''}">${t.on ? 'Team editing on' : 'Team editing off'}</span>
        ${t.on && t.urls[0] ? `<span class="mono tm-link" title="${esc(t.urls[0])}">${esc(t.urls[0])}</span><button class="small" data-copy="${esc(t.urls[0])}">Copy link</button>` : '<span class="grow"></span>'}
        <span class="muted small">${online} of ${t.users.length} online</span>
        ${t.on ? '<button class="small" data-on="0">Turn off</button>' : '<button class="small primary" data-on="1">Turn on</button>'}
      </div>
      <div class="mm-tabs tm-tabs" role="tablist">${[['people', `People (${t.users.length})`], ['links', 'Links & access'], ['folders', 'Shared folders'], ['farm', 'Helper PCs'], ['flow', 'Limelight Flow']]
        .map(([k, l]) => `<button class="chip${tab === k ? ' on' : ''}" data-tab="${k}" role="tab" aria-selected="${tab === k}">${l}</button>`).join('')}</div>`;
    const people = `<div class="tm-head"><h4>People</h4><button class="small" data-sessions>Sessions (30 days)</button></div>
      <div class="tm-list">${t.users.map((x) => { const on = t.online.includes(x.name); return `<div class="tm-row">
          <span class="tm-av" style="--h:${hue(x.name)}">${esc(initials(x.name))}<i class="${on ? 'on' : ''}"></i></span>
          <div class="tm-who"><b>${esc(x.name)}</b><small class="${on ? 'good' : 'muted'}">${on ? 'online now' : 'offline'}</small></div>
          <select data-role="${esc(x.name)}" aria-label="Role of ${esc(x.name)}">${ROLES.map(([v, l]) => `<option value="${v}"${x.role === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <div class="tm-acts"><button class="small" data-reset="${esc(x.name)}">New password</button><button class="small danger-link" data-rm="${esc(x.name)}" title="Remove ${esc(x.name)}">Remove</button></div>
        </div>`; }).join('') || '<div class="muted pad">Nobody yet - add the first person below.</div>'}</div>
      <div class="tm-add"><h4>Add a person</h4>
        <div class="tm-add-row"><label>Name<input data-un placeholder="e.g. Guna" autocomplete="off"></label><label>Password<input data-pw type="password" placeholder="6+ characters" autocomplete="new-password"></label>
          <label>Role<select data-ur>${ROLES.map(([v, l]) => `<option value="${v}">${l.split(' - ')[0]}</option>`).join('')}</select></label><button class="primary" data-add>Add</button></div>
        <p class="muted small">Tell them their name and password. Editors edit, render and import; viewers only watch; owners also see settings, accounts and this window.</p></div>
      ${t.locks.length ? `<h4>Open now</h4><div class="tm-list">${t.locks.map((l) => `<div class="tm-row tm-lock"><span class="tm-av" style="--h:${hue(l.name)}">${esc(initials(l.name))}</span><div class="tm-who"><b>${esc(l.project)}</b><small class="muted">${esc(l.name)}</small></div></div>`).join('')}</div>` : ''}`;
    const links = t.on ? `<h4>Open the editor on another office PC</h4>
        ${t.urls.map((u, i) => copyRow(i === 0 ? 'Main link' : 'Also', u, i === 0 && t.short ? ' <span class="good small">permanent</span>' : '')).join('') || '<p class="warn">This computer has no network address - connect it to the office network.</p>'}
        ${t.tls ? `<p class="small ${t.tls.daysLeft < 15 ? 'warn' : 'muted'}">🔒 HTTPS certificate for <b>${esc(t.tls.domain)}</b> valid until ${new Date(t.tls.validTo).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} (${t.tls.daysLeft} days left)${t.tls.daysLeft < 15 ? ' - <b>renew it now</b>: ask Claude "SSL renew kar de" (a new TXT record in GoDaddy)' : ''}</p>` : ''}
        ${t.mesh ? `<h4>🏠 From home (MeshLink)</h4>${t.mesh.connected && t.mesh.url ? copyRow('Mesh link', t.mesh.url) : `<p class="warn small">MeshLink is running here but not connected to its server${t.mesh.error ? ` (${esc(t.mesh.error)})` : ''}</p>`}
          ${t.mesh.peers?.length ? `<p class="muted small">On the mesh: ${t.mesh.peers.map((x) => `${esc(x.name)} ${x.online ? `<span class="good">online</span>${x.ms ? ` ${x.ms} ms` : ''}` : '<span class="muted">offline</span>'}`).join(' · ')}</p>` : ''}` : ''}
        <div class="tm-tip"><b>Same link on every PC:</b> open it and press <b>Install on this PC</b> on the sign-in page (Chrome / Edge) - the Limelight icon goes on that PC's Desktop and Start menu.<br>
          <span class="muted">Windows may ask once whether Node.js can use the network: choose <b>Allow</b>. This computer must stay on with the editor running; the others use its footage, previews and renders.</span></div>`
      : `<div class="tm-tip">Let editors on other office computers open projects from this computer: each signs in with a name and password you make in <b>People</b>. Everyone with edit rights can work on the same timeline at the same time (live) - each person sees what the others select and where their playheads are, in their colour. Viewers only watch.<br><br><button class="primary" data-on="1">Turn on team editing</button></div>`;
    const folders = `<h4>Shared folders</h4><p class="muted small">Shown first when anyone imports - a shared drive, the shoot archive.</p>
      <div class="tm-list">${t.libraries.map((l) => `<div class="tm-row tm-folder"><span class="tm-ic">📁</span><span class="mono grow">${esc(l)}</span><button class="small danger-link" data-lrm="${esc(l)}">Remove</button></div>`).join('') || '<div class="muted pad">None yet.</div>'}</div>
      <button class="small" data-ladd>+ Add a folder</button>
      <label class="tm-check"><input type="checkbox" data-anyfolder ${t.editorsAnyFolder ? 'checked' : ''}><span>Editors may save renders and exported timelines to <b>any folder</b> on this computer (Save to in Deliver). Off = only inside the shared folders above.</span></label>`;
    const flow = t.on ? `<h4>⚡ Limelight Flow</h4><p class="muted small">The office automation app on the bridge PC (day report, WhatsApp / Telegram bot). It reads the day's report and who is online with this token - nothing else.</p>
        <div data-rtok><button class="small" data-rtok-show>Show report token</button></div>` : '<p class="muted">Turn on team editing first - Limelight Flow reads the editor through the team link.</p>';
    box.innerHTML = top + (tab === 'farm' ? '' : `<div class="tm-body">${({ people, links, folders, flow })[tab]}</div>`);
    farmBox.hidden = tab !== 'farm'; // (🖥 the helper PCs keep their own panel, which updates itself every few seconds)
  };
  let t = await api('GET', '/api/team'); draw(t);
  const put = async (b) => { t = await api('PUT', '/api/team', b); draw(t); };
  box.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-tab]'); if (tb) { tab = tb.dataset.tab; draw(t); return; }
    if (e.target.closest('[data-sessions]')) return openSessions(); // 📊
    const rt = e.target.closest('[data-rtok-show], [data-rtok-new]');
    if (rt) { // ⚡ the report token for Limelight Flow (made the first time)
      if (rt.dataset.rtokNew !== undefined && !confirm('Make a new token? Limelight Flow stops working until it gets the new one.')) return;
      try {
        const r = await api('POST', '/api/team/report', { new: rt.dataset.rtokNew !== undefined });
        $('[data-rtok]', box).innerHTML = `<div class="sh-url"><span class="small grow">Editor address</span><span class="mono">${esc(r.url)}</span><button class="small" data-copy="${esc(r.url)}">Copy</button></div>
          <div class="sh-url"><span class="small grow">Report token</span><span class="mono">${esc(r.token)}</span><button class="small" data-copy="${esc(r.token)}">Copy</button></div><button class="small link" data-rtok-new>New token</button>`;
      } catch (x) { toast(x.message, 'err'); }
      return;
    }
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    try {
      if (d.add !== undefined) { await put({ addUser: { name: $('[data-un]', box).value, password: $('[data-pw]', box).value, role: $('[data-ur]', box).value } }); toast('Added - tell them their name and password'); }
      if (d.rm && confirm(`Remove ${d.rm}? They are signed out at once.`)) await put({ removeUser: d.rm });
      if (d.reset) { const pw = prompt(`New password for ${d.reset} (6+ characters)`); if (pw) { if (pw.length < 6) return toast('At least 6 characters', 'err'); await put({ resetPassword: { name: d.reset, password: pw } }); toast('Password changed - they sign in again'); } }
      if (d.lrm) await put({ libraries: t.libraries.filter((x) => x !== d.lrm) });
      if (d.ladd !== undefined) { const f = await pickFolder('Shared folder', 'Footage everyone in the team should find quickly (a shared drive, the shoot archive).'); if (f) await put({ libraries: [...new Set([...t.libraries, f])] }); }
      if (d.on) { b.disabled = true; await put({ on: d.on === '1' }); toast(d.on === '1' ? 'Team editing is on' : 'Team editing is off'); }
      if (d.copy) { await navigator.clipboard.writeText(d.copy); toast('Link copied'); }
    } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  });
  box.addEventListener('change', async (e) => { if (e.target.matches('[data-anyfolder]')) { try { await put({ editorsAnyFolder: e.target.checked }); toast(e.target.checked ? 'Editors can now save exports to any folder on this computer' : 'Editors save only inside the Shared folders'); } catch (err) { toast(err.message, 'err'); } return; } });
  box.addEventListener('change', async (e) => { const s = e.target.closest('[data-role]'); if (s) { try { await put({ setRole: { name: s.dataset.role, role: s.value } }); toast('Role changed'); } catch (err) { toast(err.message, 'err'); } } });
}

// 🖥 Render farm (Phase 16): other office computers render shots for this one (engine/worker.mjs)
function farmPanel(box, dlg) {
  let f = null, projects = [];
  api('GET', '/api/projects').then((l) => { projects = l.map((p) => p.name || p).sort((a, b) => a.localeCompare(b)); draw(); }).catch(() => {});
  const draw = () => {
    if (!f) return;
    if (box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return; // (not while a list is open)
    const u = f.urls[0], cmd = u ? `curl.exe -o worker.mjs ${u}/farm/worker.mjs
node worker.mjs ${u} ${f.token}` : '';
    box.innerHTML = `<h4>Render farm <span class="muted small">(other office computers help with rendering)</span></h4>
      ${f.on ? `<p>Farm is <b class="good">on</b>. On the computer you want to add (needs Node.js and FFmpeg), run this in PowerShell:</p>
        ${u ? `<pre class="mono farm-cmd">${esc(cmd)}</pre><div class="row-in"><button class="small" data-fcopy>Copy command</button><span class="muted small grow">Keep the window open. With more cores, add <span class="mono">--slots 2</span> at the end.</span></div>`
          : '<p class="warn">No network address found for this computer - connect it to the office network.</p>'}
        <div class="dv-list">${f.workers.map((w) => `<div class="dv-item farm-pc"><div class="grow"><b>${esc(w.name)}</b> <span class="muted small">${esc(w.host || '')}</span>
          ${w.specs ? `<div class="muted small">${w.specs.cores} cores · ${w.specs.ramGB} GB${w.specs.gpu ? ` · ${esc(w.specs.gpu)}${w.specs.nvenc ? ' (NVIDIA encoder)' : ''}` : ''}${w.specs.ffprobe ? '' : ' · <span class="warn">no FFprobe</span>'}${w.specs.render ? ' · whole renders' : ''}${w.specs.whisper ? ' · transcribing' : ''}${w.specs.torch ? ' · AI cut-outs' : ''}${w.specs.cv2 ? ' · tracking' : ''}</div>
            <div class="small">CPU ${w.load}%${w.paused ? ' · <span class="warn">in use by its own user - not helping right now</span>' : ''}</div>
            <div class="small">Projects: ${w.projects.length ? w.projects.map((p) => `${esc(p)}`).join(', ') : '<span class="muted">none yet</span>'}</div>`
          : '<div class="muted small">Renders shots only - run the new worker to help with projects too</div>'}</div>
          <span class="muted small">${w.slots} slot · ${w.busy ? `<span class="good">busy ${w.busy}</span>` : 'idle'} · ✓ ${w.done || 0}${w.failed ? ` · ${w.failed} failed` : ''}</span></div>`).join('') || '<div class="muted">No computers connected yet.</div>'}</div>
        ${f.workers.some((w) => w.specs) ? `<p class="muted small"><b>Helper PCs</b>: each project is given to one PC by its strength - that PC reads its new footage (thumbnails, filmstrips, sound), makes its preview copies, renders its queued exports (one at a time per PC, several PCs at once) and - on a PC with an NVIDIA card and Whisper - transcribes. It works straight from the NAS when it sees the same files. Editing stays here. Anything a PC can't do (or does not take soon) is done here.</p>
          <div class="row-in farm-pin"><span class="small">Keep</span><select data-pinp>${projects.map((p) => `<option>${esc(p)}</option>`).join('')}</select><span class="small">on</span>
            <select data-pinpc><option value="">Automatic (by strength)</option>${f.workers.filter((w) => w.specs).map((w) => `<option>${esc(w.name)}</option>`).join('')}</select><button class="small" data-pin>Set</button></div>
          ${Object.keys(f.pins).length ? `<p class="small">${Object.entries(f.pins).map(([p, pc]) => `${esc(p)} → ${esc(pc)}`).join(' · ')}</p>` : ''}
          <div class="row-in"><span class="small">NAS: at most</span><select data-nasmax>${[2, 4, 6, 8, 10, 12, 16, 24].map((n) => `<option ${n === f.nasMax ? 'selected' : ''}>${n}</option>`).join('')}</select>
            <span class="muted small grow">long runs (preview copies, renders, AI) read the NAS at once - more only slows every one of them down</span></div>` : ''}
        ${f.night ? `<div class="row-in"><label class="chk small"><input type="checkbox" data-night ${f.night.on ? 'checked' : ''}> 🌙 Night shift from</label>
            <select data-nfrom>${hours(f.night.from)}</select><span class="small">to</span><select data-nto>${hours(f.night.to)}</select>
            <span class="muted small grow">idle helper PCs get the recent projects' footage ready for the Agent (analysis + frames) - never on this PC${f.night.done || f.night.skipped ? ` · tonight: ${f.night.done} clips ready${f.night.skipped ? `, ${f.night.skipped} left for later` : ''}` : ''}${f.night.running ? ' · <span class="good">working</span>' : ''}</span></div>` : ''}
        <p class="muted small">Final render shots (not previews) are also rendered on connected computers. Shots that can't be sent out (stabilise, LUT, text file) or that fail are rendered here - a render never waits for the farm. Footage is read from this computer over the network with the token.</p>
        <div class="dv-actions"><button data-ftok title="Workers using the old token will stop">New token</button><button data-fon="0">Turn off farm</button></div>`
      : `<p class="muted">Final render shots can also be rendered on other office computers - more computers, faster renders. Each computer runs a small worker that reads the footage from this computer over the network.</p>
        <div class="dv-actions"><button class="primary" data-fon="1">Turn on render farm</button></div>`}`;
  };
  const load = async (b) => { try { f = await api(b ? 'PUT' : 'GET', '/api/farm', b); draw(); } catch (e) { toast(e.message, 'err'); } };
  load();
  const timer = setInterval(() => { if (!document.body.contains(box)) return clearInterval(timer); if (f?.on) load(); }, 3000);
  box.addEventListener('change', async (e) => {
    if (e.target.matches('[data-nasmax]')) { await load({ nasMax: +e.target.value }); toast(`NAS: ${e.target.value} at once`); }
    // 🌙 night shift on / off and its hours
    if (e.target.matches('[data-night], [data-nfrom], [data-nto]')) {
      await load({ night: { on: $('[data-night]', box).checked, from: +$('[data-nfrom]', box).value, to: +$('[data-nto]', box).value } });
      toast(f.night.on ? `🌙 Night shift ${f.night.from}:00 - ${f.night.to}:00` : '🌙 Night shift off');
    }
  });
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.fon) { b.disabled = true; await load({ on: b.dataset.fon === '1' }); toast(b.dataset.fon === '1' ? 'Render farm on' : 'Render farm off'); }
    if (b.dataset.ftok !== undefined && confirm('Make a new token? Connected computers will have to run the new command.')) { await load({ newToken: true }); toast('New token created'); }
    if (b.dataset.pin !== undefined) { const pc = box.querySelector('[data-pinpc]').value; await load({ pin: { project: box.querySelector('[data-pinp]').value, pc } }); toast(pc ? `Kept on ${pc}` : 'Back to automatic'); }
    if (b.dataset.fcopy !== undefined) { await navigator.clipboard.writeText(box.querySelector('.farm-cmd').textContent); toast('Command copied'); }
  });
}
