// 👥 Team (owner, on the editing computer): let other computers in the office use the editor - turn it on, make
// logins (name, password, role), share folders (shown first when importing), see who is online and who edits what.
import { api } from './api.js';
import { $, esc, toast, modal } from './ui.js';
import { pickFolder } from './mediapool.js';
import { openSessions } from './sessionsui.js';

const ROLES = [['editor', 'Editor - edits, renders, imports'], ['viewer', 'Viewer - watches only'], ['owner', 'Owner - also settings, accounts, team']];

export async function openTeam() {
  const dlg = modal('👥 Team - edit from other computers', '<div data-tm><div class="muted pad">Loading…</div></div><div data-farm></div>', { width: 720 });
  const box = $('[data-tm]', dlg.el);
  farmPanel($('[data-farm]', dlg.el), dlg);
  const draw = (t) => {
    box.innerHTML = `${t.on ? `<p>Team editing is <b class="good">on</b>. On another computer in this office (same network), open:</p>
        ${t.urls.map((u, i) => `<div class="sh-url"><span class="mono grow">${esc(u)}${i === 0 && t.short ? ' <span class="good small">← permanent link</span>' : ''}</span><button class="small" data-copy="${esc(u)}">Copy</button></div>`).join('') || '<p class="warn">This computer has no network address - connect it to the office network.</p>'}
        ${t.tls ? `<p class="small ${t.tls.daysLeft < 15 ? 'warn' : 'muted'}">🔒 HTTPS certificate for <b>${esc(t.tls.domain)}</b> valid until ${new Date(t.tls.validTo).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} (${t.tls.daysLeft} days left)${t.tls.daysLeft < 15 ? ' - <b>renew it now</b>: ask Claude "SSL renew kar de" (a new TXT record in GoDaddy)' : ''}</p>` : ''}
        <p class="small">🔗 <b>Same link on every PC:</b> open it once and bookmark it, or put the <a href="/api/team/shortcut" download>⬇ Desktop shortcut (Limelight Editor.url)</a> on each PC - it is also in the editor folder and on the sign-in page.</p>
        <p class="muted small">Windows may ask once whether Node.js can use the network: choose <b>Allow</b> for private networks. This computer must stay on with the editor running; the others use its footage, previews and renders.</p>`
      : '<p>Let editors on other office computers open projects from this computer: each signs in with a name and password you make here. Everyone with edit rights can work on the same timeline at the same time (🔴 live) - each person sees what the others select and where their playheads are, in their colour. Viewers only watch.</p>'}
      <h4 style="display:flex;align-items:center;gap:8px">People <button class="small" data-sessions style="margin-left:auto">📊 Sessions (30 days)</button></h4>
      <div class="dv-list">${t.users.map((x) => `<div class="dv-item"><b class="grow">${esc(x.name)}</b>${t.online.includes(x.name) ? '<span class="good small">● online</span>' : ''}
        <select data-role="${esc(x.name)}" style="width:auto">${ROLES.map(([v, l]) => `<option value="${v}"${x.role === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <button class="link small" data-reset="${esc(x.name)}">New password</button><button class="link small" data-rm="${esc(x.name)}">Remove</button></div>`).join('') || '<div class="muted">Nobody yet.</div>'}</div>
      <div class="row-in"><input data-un placeholder="Name"><input data-pw type="password" placeholder="Password (6+ characters)"><select data-ur style="width:auto">${ROLES.map(([v, l]) => `<option value="${v}">${l.split(' - ')[0]}</option>`).join('')}</select><button class="small primary" data-add>Add</button></div>
      <h4>Shared folders <span class="muted small">(shown first, with ⭐, when anyone imports)</span></h4>
      <div class="dv-list">${t.libraries.map((l) => `<div class="dv-item"><span class="mono grow">${esc(l)}</span><button class="link small" data-lrm="${esc(l)}">Remove</button></div>`).join('') || '<div class="muted">None.</div>'}</div>
      <button class="small" data-ladd>+ Add a folder</button>
      <label class="chk" style="margin-top:8px"><input type="checkbox" data-anyfolder ${t.editorsAnyFolder ? 'checked' : ''}> Editors may save renders / exported timelines to <b>any folder</b> on this computer (📁 Save to in Deliver). Off = only inside the Shared folders above.</label>
      ${t.locks.length ? `<h4>Open now</h4><div class="muted small">${t.locks.map((l) => `${esc(l.project)} - ${esc(l.name)}`).join('<br>')}</div>` : ''}
      <div class="dv-actions">${t.on ? '<button data-on="0">Turn off</button>' : '<button class="primary" data-on="1">Turn on team editing</button>'}<button data-close>Close</button></div>`;
  };
  let t = await api('GET', '/api/team'); draw(t);
  const put = async (b) => { t = await api('PUT', '/api/team', b); draw(t); };
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-sessions]')) return openSessions(); // 📊
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
  let f = null;
  const draw = () => {
    if (!f) return;
    const u = f.urls[0], cmd = u ? `curl.exe -o worker.mjs ${u}/farm/worker.mjs
node worker.mjs ${u} ${f.token}` : '';
    box.innerHTML = `<h4>🖥 Render farm <span class="muted small">(other office computers help with rendering)</span></h4>
      ${f.on ? `<p>Farm is <b class="good">on</b>. On the computer you want to add (needs Node.js and FFmpeg), run this in PowerShell:</p>
        ${u ? `<pre class="mono farm-cmd">${esc(cmd)}</pre><div class="row-in"><button class="small" data-fcopy>Copy command</button><span class="muted small grow">Keep the window open. With more cores, add <span class="mono">--slots 2</span> at the end.</span></div>`
          : '<p class="warn">No network address found for this computer - connect it to the office network.</p>'}
        <div class="dv-list">${f.workers.map((w) => `<div class="dv-item"><b class="grow">${esc(w.name)}</b><span class="muted small">${esc(w.host || '')} · ${w.slots} slot · ${w.busy ? `<span class="good">rendering ${w.busy} shot${w.busy > 1 ? 's' : ''}</span>` : 'idle'} · ✓ ${w.done || 0}${w.failed ? ` · ✗ ${w.failed}` : ''}</span></div>`).join('') || '<div class="muted">No computers connected yet.</div>'}</div>
        <p class="muted small">Final render shots (not previews) are also rendered on connected computers. Shots that can't be sent out (stabilise, LUT, text file) or that fail are rendered here - a render never waits for the farm. Footage is read from this computer over the network with the token.</p>
        <div class="dv-actions"><button data-ftok title="Workers using the old token will stop">New token</button><button data-fon="0">Turn off farm</button></div>`
      : `<p class="muted">Final render shots can also be rendered on other office computers - more computers, faster renders. Each computer runs a small worker that reads the footage from this computer over the network.</p>
        <div class="dv-actions"><button class="primary" data-fon="1">Turn on render farm</button></div>`}`;
  };
  const load = async (b) => { try { f = await api(b ? 'PUT' : 'GET', '/api/farm', b); draw(); } catch (e) { toast(e.message, 'err'); } };
  load();
  const timer = setInterval(() => { if (!document.body.contains(box)) return clearInterval(timer); if (f?.on) load(); }, 3000);
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.fon) { b.disabled = true; await load({ on: b.dataset.fon === '1' }); toast(b.dataset.fon === '1' ? 'Render farm on' : 'Render farm off'); }
    if (b.dataset.ftok !== undefined && confirm('Make a new token? Connected computers will have to run the new command.')) { await load({ newToken: true }); toast('New token created'); }
    if (b.dataset.fcopy !== undefined) { await navigator.clipboard.writeText(box.querySelector('.farm-cmd').textContent); toast('Command copied'); }
  });
}
