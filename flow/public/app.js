// app.js - ⚡ Limelight Flow's page: flows (a trigger, then steps), their runs, WhatsApp and the settings.
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const main = $('[data-main]');
let META = null, tab = 'flows', editing = null, waTimer = null;

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'x-flow': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.startsWith('/api/login')) { showLogin(); throw new Error('Sign in'); }
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}
function toast(m, bad) { const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = `<span class="${bad ? 'bad' : ''}">${esc(m)}</span>`; document.body.append(t); setTimeout(() => t.remove(), 3500); }
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleString(); };

// ---- sign-in / first password
async function boot() {
  const me = await (await fetch('/api/me')).json();
  if (!me.signedIn) return showLogin(me);
  $('[data-nav]').hidden = false;
  META = await api('GET', '/api/meta');
  show(tab);
}
function showLogin(me = {}) {
  $('[data-nav]').hidden = true;
  const setup = me.setUp === false;
  main.innerHTML = `<div class="card login"><h2>${setup ? 'Make the password' : 'Sign in'}</h2>
    ${setup ? `<p class="muted small">${me.local ? 'Choose the password for Limelight Flow (at least 8 characters). Everyone who opens it needs it.' : 'Make the password on the PC Limelight Flow runs on (open http://localhost:5678 there).'}</p>` : ''}
    <form data-f><label>Password</label><input type="password" name="pw" autocomplete="${setup ? 'new-password' : 'current-password'}" autofocus>
    <div class="row" style="margin-top:12px"><button class="primary">${setup ? 'Save' : 'Sign in'}</button><span class="bad small" data-e></span></div></form></div>`;
  $('[data-f]').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', setup ? '/api/setup' : '/api/login', { password: e.target.pw.value }); boot(); } catch (x) { $('[data-e]').textContent = x.message; }
  };
}
$('[data-logout]').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); showLogin({ setUp: true }); };
$$('[data-tab]').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
function show(t) {
  tab = t; editing = null; clearInterval(waTimer);
  $$('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  ({ flows: flowsPage, runs: runsPage, telegram: tgPage, whatsapp: waPage, settings: settingsPage })[t]().catch((e) => { main.innerHTML = `<p class="bad">${esc(e.message)}</p>`; });
}

// ---- Flows
const trigSummary = (tr = {}) => tr.type === 'schedule' ? (+tr.every > 0 ? `every ${tr.every} min` : `daily at ${tr.at || '?'}${tr.days ? ` (days ${tr.days})` : ''}`)
  : tr.type === 'whatsapp' ? `WhatsApp message${tr.from ? ` from ${tr.from}` : ''}${tr.match ? ` matching /${tr.match}/` : ''}`
  : tr.type === 'telegram' ? `Telegram message${tr.from ? ` from ${tr.from}` : ''}${tr.match ? ` matching /${tr.match}/` : ''}`
  : tr.type === 'webhook' ? 'webhook' : 'by hand';
async function flowsPage() {
  const [flows, runs] = await Promise.all([api('GET', '/api/flows'), api('GET', '/api/runs')]);
  const last = (id) => runs.find((r) => r.flow === id);
  main.innerHTML = `<div class="row"><h2 class="grow">Flows</h2>
      <select data-tpl style="width:auto"><option value="">+ From a template…</option>${META.templates.map((t) => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join('')}</select>
      <button class="primary" data-new>+ New flow</button></div>
    ${flows.map((f) => { const r = last(f.id); return `<div class="card flowitem" data-open="${esc(f.id)}">
      <span class="pill ${f.on ? 'on' : ''}">${f.on ? 'on' : 'off'}</span>
      <div class="grow"><b>${esc(f.name)}</b><div class="muted small">${esc(trigSummary(f.trigger))} · ${f.steps.length} step${f.steps.length === 1 ? '' : 's'}</div></div>
      <div class="small">${r ? `<span class="${r.ok ? 'good' : 'bad'}">${r.ok ? '✓' : '✗'}</span> ${esc(ago(r.at))}` : '<span class="muted">not run yet</span>'}</div></div>`; }).join('')
      || '<div class="card muted">No flows yet - start from a template (the 10 PM report, the WhatsApp chatbot, the alerts) or make a new one.</div>'}`;
  $('[data-new]').onclick = async () => openFlow(await api('POST', '/api/flows', { name: 'New flow', trigger: { type: 'manual' }, steps: [] }));
  $('[data-tpl]').onchange = async (e) => { if (!e.target.value) return; try { const f = await api('POST', '/api/templates', { key: e.target.value }); toast('Added - set it up and switch it on'); openFlow(f); } catch (x) { toast(x.message, true); } };
  $$('[data-open]').forEach((el) => (el.onclick = async () => openFlow(await api('GET', `/api/flows/${el.dataset.open}`))));
}

function fieldsHtml(fields, vals, prefix) {
  return fields.map(([k, label, kind]) => `<label>${esc(label)}</label>${kind === 'area' || kind === 'code'
    ? `<textarea class="${kind === 'code' ? 'code' : ''}" data-${prefix}="${esc(k)}" spellcheck="false">${esc(vals?.[k] ?? '')}</textarea>`
    : `<input data-${prefix}="${esc(k)}" value="${esc(vals?.[k] ?? '')}">`}`).join('');
}
function openFlow(f) {
  editing = structuredClone(f);
  drawFlow();
}
function readFlow() {
  const f = editing;
  f.name = $('[data-name]').value; f.note = $('[data-note]').value; f.on = $('[data-on]').checked;
  f.trigger = { type: $('[data-ttype]').value };
  $$('[data-tf]').forEach((el) => { f.trigger[el.dataset.tf] = el.value; });
  if (editing._key && f.trigger.type === 'webhook' && !f.trigger.key) f.trigger.key = editing._key;
  f.steps = $$('[data-step]').map((card) => {
    const s = { id: $('[data-sid]', card).value.trim(), type: $('[data-stype]', card).value, name: $('[data-sname]', card).value, if: $('[data-sif]', card).value, goOn: $('[data-sgo]', card).checked, params: {} };
    $$('[data-sp]', card).forEach((el) => { s.params[el.dataset.sp] = el.value; });
    return s;
  });
  return f;
}
function drawFlow(result) {
  const f = editing, tt = META.triggers[f.trigger?.type] || META.triggers.manual;
  const hook = f.trigger?.type === 'webhook' && f.trigger.key ? `${location.origin}/hook/${f.trigger.key}` : '';
  main.innerHTML = `<div class="row"><button class="ghost" data-back>← Flows</button><h2 class="grow" style="margin:0">${esc(f.name)}</h2>
      <label class="row" style="margin:0;color:var(--text)"><input type="checkbox" data-on ${f.on ? 'checked' : ''} style="width:auto"> On</label>
      <button data-run>▶ Run now</button><button class="primary" data-save>Save</button></div>
    <div class="card"><div class="grid2"><div><label>Name</label><input data-name value="${esc(f.name)}"></div><div><label>Note</label><input data-note value="${esc(f.note || '')}"></div></div></div>
    <div class="card trigger"><b>When</b>
      <label>Trigger</label><select data-ttype>${Object.entries(META.triggers).map(([k, t]) => `<option value="${k}" ${k === f.trigger?.type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
      ${fieldsHtml(tt.fields, f.trigger, 'tf')}
      ${hook ? `<label>Its address (GET or POST, e.g. ?text=…)</label><div class="mono">${esc(hook)}</div>` : f.trigger?.type === 'webhook' ? '<p class="muted small">Save to get its address.</p>' : ''}</div>
    <div data-steps>${(f.steps || []).map((s, i) => stepHtml(s, i, result?.steps?.find((x) => x.id === s.id))).join('')}</div>
    <div class="row"><select data-addtype style="width:auto">${Object.entries(META.steps).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('')}</select><button data-add>+ Add step</button>
      <span class="grow"></span><button class="ghost danger" data-del>Delete flow</button></div>
    ${result ? `<div class="card"><b class="${result.ok ? 'good' : 'bad'}">${result.ok ? '✓ Ran' : '✗ Stopped'}</b> <span class="muted small">in ${result.ms} ms</span>${result.error ? `<div class="bad small">${esc(result.error)}</div>` : ''}${result.log?.length ? `<pre>${esc(result.log.join('\n'))}</pre>` : ''}</div>` : ''}
    <p class="muted small">In any setting: <span class="mono">{{ … }}</span> is JavaScript over <span class="mono">trigger</span> (what started it - a WhatsApp message: from, name, text, chat), <span class="mono">steps.&lt;id&gt;</span> (an earlier step's answer), <span class="mono">vars</span> (Settings) and <span class="mono">now</span>. "Only if" skips the step when false.</p>`;
  $('[data-back]').onclick = () => show('flows');
  $('[data-ttype]').onchange = () => { readFlow(); drawFlow(); };
  $('[data-save]').onclick = save;
  $('[data-run]').onclick = async () => { try { await save(true); const r = await api('POST', `/api/flows/${editing.id}/run`, {}); drawFlow(r); } catch (x) { toast(x.message, true); } };
  $('[data-add]').onclick = () => { readFlow(); const type = $('[data-addtype]').value, base = type.split('.').pop(); let id = base, n = 2; while (editing.steps.some((s) => s.id === id)) id = `${base}${n++}`; editing.steps.push({ id, type, name: '', if: '', params: {} }); drawFlow(); };
  $('[data-del]').onclick = async () => { if (!confirm(`Delete the flow "${editing.name}"?`)) return; await api('DELETE', `/api/flows/${editing.id}`); show('flows'); };
  $$('[data-step]').forEach((card, i) => {
    $('[data-stype]', card).onchange = () => { readFlow(); editing.steps[i].params = {}; drawFlow(); };
    $('[data-up]', card).onclick = () => { readFlow(); if (i > 0) [editing.steps[i - 1], editing.steps[i]] = [editing.steps[i], editing.steps[i - 1]]; drawFlow(); };
    $('[data-down]', card).onclick = () => { readFlow(); if (i < editing.steps.length - 1) [editing.steps[i + 1], editing.steps[i]] = [editing.steps[i], editing.steps[i + 1]]; drawFlow(); };
    $('[data-rm]', card).onclick = () => { readFlow(); editing.steps.splice(i, 1); drawFlow(); };
  });
}
function stepHtml(s, i, res) {
  const t = META.steps[s.type] || { label: s.type, fields: [] };
  return `<div class="card step" data-step>
    <div class="row"><b>${i + 1}.</b><select data-stype style="width:auto">${Object.entries(META.steps).map(([k, x]) => `<option value="${k}" ${k === s.type ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
      <span class="grow"></span><button class="small" data-up title="Up">↑</button><button class="small" data-down title="Down">↓</button><button class="small danger" data-rm title="Remove">✕</button></div>
    <div class="grid2"><div><label>Id (steps.${esc(s.id)})</label><input data-sid value="${esc(s.id)}"></div><div><label>Name</label><input data-sname value="${esc(s.name || '')}" placeholder="${esc(t.label)}"></div></div>
    ${fieldsHtml(t.fields, s.params, 'sp')}
    <div class="grid2"><div><label>Only if (JavaScript, empty = always)</label><input data-sif value="${esc(s.if || '')}" placeholder="steps.route === 'ask'"></div>
      <div><label>&nbsp;</label><label class="row" style="margin:6px 0;color:var(--text)"><input type="checkbox" data-sgo ${s.goOn ? 'checked' : ''} style="width:auto"> Carry on if this step fails</label></div></div>
    ${res ? `<details ${res.ok ? '' : 'open'}><summary class="${res.skipped ? 'muted' : res.ok ? 'good' : 'bad'}">${res.skipped ? '— skipped' : res.ok ? `✓ answer (${res.ms} ms)` : `✗ ${esc(res.error)}`}</summary>${res.out !== undefined ? `<pre>${esc(typeof res.out === 'string' ? res.out : JSON.stringify(res.out, null, 2))}</pre>` : ''}</details>` : ''}</div>`;
}
async function save(quiet) {
  const f = readFlow();
  try { editing = { ...(await api('PUT', `/api/flows/${f.id}`, f)) }; if (quiet !== true) { toast('Saved'); drawFlow(); } } catch (x) { toast(x.message, true); throw x; }
}

// ---- Runs
async function runsPage() {
  const runs = await api('GET', '/api/runs');
  main.innerHTML = `<h2>Runs <span class="muted small">(the last 100)</span></h2>${runs.map((r) => `<div class="card"><details><summary><span class="${r.ok ? 'good' : 'bad'}">${r.ok ? '✓' : '✗'}</span> <b style="color:var(--text)">${esc(r.name)}</b> · ${esc(r.how)} · ${esc(new Date(r.at).toLocaleString())} · ${r.ms} ms${r.error ? ` · <span class="bad">${esc(r.error)}</span>` : ''}</summary>
    ${r.steps.map((s) => `<div class="small" style="margin-top:6px"><span class="${s.skipped ? 'muted' : s.ok ? 'good' : 'bad'}">${s.skipped ? '—' : s.ok ? '✓' : '✗'}</span> ${esc(s.name)}${s.error ? ` <span class="bad">${esc(s.error)}</span>` : ''}</div>${s.out !== undefined ? `<pre>${esc(typeof s.out === 'string' ? s.out : JSON.stringify(s.out, null, 2))}</pre>` : ''}`).join('')}
    <div class="small muted" style="margin-top:6px">Trigger</div><pre>${esc(JSON.stringify(r.trigger, null, 2))}</pre></details></div>`).join('') || '<p class="muted">Nothing has run yet.</p>'}`;
}

// ---- Telegram
async function tgPage() {
  const t = await api('GET', '/api/telegram');
  main.innerHTML = `<h2>Telegram</h2>
    <div class="card"><div class="row"><div class="grow">Bot: <b class="${t.state === 'connected' ? 'good' : ''}">${esc(t.state)}</b>${t.me ? ` - <a href="https://t.me/${esc(t.me)}" target="_blank" rel="noopener" style="color:var(--accent)">@${esc(t.me)}</a>` : ''}${t.error ? `<div class="bad small">${esc(t.error)}</div>` : ''}</div>
      ${t.tokenSet ? (t.state === 'connected' ? '<button data-tg="stop">Switch off</button>' : '<button class="primary" data-tg="start">Switch on</button>') : ''}</div>
      <details ${t.tokenSet ? '' : 'open'}><summary>${t.tokenSet ? 'Use another bot' : 'Make your bot (2 minutes)'}</summary>
        <ol class="small"><li>In Telegram open <b>@BotFather</b> (the one with the blue tick) and send <span class="mono">/newbot</span>.</li><li>Give it a name (Limelight Bot) and a username ending in <span class="mono">bot</span> (limelight_office_bot).</li><li>It sends a token like <span class="mono">123456789:AA…</span> - paste it here. Keep it secret: whoever has it controls the bot.</li></ol>
        <label>Bot token</label><input type="password" data-tgtok autocomplete="off"><div class="row" style="margin-top:8px"><button class="primary" data-tgsave>Save and switch on</button></div></details></div>
    <div class="card"><b>Who wrote to the bot</b> <span class="muted small">(open the bot, press Start or write anything - the chat id shows here; make yours ownerTelegram)</span>
      ${t.recent?.length ? t.recent.map((r) => `<div class="row small" style="margin-top:6px"><span class="grow">${esc(r.name)}${r.username ? ` <span class="muted">@${esc(r.username)}</span>` : ''}${r.group ? ' <span class="pill">group</span>' : ''}</span><span class="mono">${esc(r.chat)}</span><button class="small" data-own="${esc(r.chat)}">Make this ownerTelegram</button></div>`).join('') : '<p class="muted small">Nobody yet (since Limelight Flow started).</p>'}</div>
    <div class="card"><b>Send a test message</b><div class="grid2"><div><label>To (chat id)</label><input data-to value="${esc(t.recent?.[0]?.chat || '')}"></div><div><label>Text</label><input data-tx value="✅ Limelight Flow: Telegram works"></div></div>
      <div class="row" style="margin-top:10px"><button data-test>Send</button></div></div>
    <div class="card"><b>Try a message without a phone</b> <span class="muted small">(the flows with a Telegram trigger answer; the answer shows here, nothing is sent)</span>
      <div class="grid2"><div><label>From (empty = ownerTelegram)</label><input data-sfrom></div><div><label>Text</label><input data-stext value="online"></div></div>
      <div class="row" style="margin-top:10px"><button data-sim>Try</button></div><div data-simout></div></div>`;
  $$('[data-tg]').forEach((b) => (b.onclick = async () => { try { await api('POST', '/api/telegram', { action: b.dataset.tg }); show('telegram'); } catch (x) { toast(x.message, true); } }));
  $('[data-tgsave]').onclick = async () => { try { await api('POST', '/api/telegram', { action: 'token', token: $('[data-tgtok]').value }); toast('The bot is on'); show('telegram'); } catch (x) { toast(x.message, true); } };
  $$('[data-own]').forEach((b) => (b.onclick = async () => { const s = await api('GET', '/api/settings'); await api('PUT', '/api/settings', { vars: { ...s.vars, ownerTelegram: b.dataset.own } }); toast('Saved as ownerTelegram'); }));
  $('[data-test]').onclick = async () => { try { await api('POST', '/api/telegram', { action: 'test', to: $('[data-to]').value, text: $('[data-tx]').value }); toast('Sent'); } catch (x) { toast(x.message, true); } };
  $('[data-sim]').onclick = () => simTry('telegram');
  if (t.state === 'connected') waTimer = setInterval(async () => { const n = await api('GET', '/api/telegram').catch(() => null); if (n && n.recent?.[0]?.at !== t.recent?.[0]?.at) show('telegram'); }, 5000);
}
async function simTry(kind) {
  $('[data-simout]').innerHTML = '<p class="muted small">Working…</p>';
  try {
    const r = await api('POST', `/api/${kind}`, { action: 'simulate', from: $('[data-sfrom]').value, text: $('[data-stext]').value });
    $('[data-simout]').innerHTML = r.matched.length ? `<p class="small muted">Flows: ${esc(r.matched.join(', '))}</p>${r.replies.map((t) => `<pre>${esc(t)}</pre>`).join('')}${r.runs.filter((x) => !x.ok).map((x) => `<p class="bad small">${esc(x.name)}: ${esc(x.error)}</p>`).join('')}` : '<p class="muted small">No flow that is on answers this (check its "Only from" and switch it on).</p>';
  } catch (x) { $('[data-simout]').innerHTML = `<p class="bad small">${esc(x.message)}</p>`; }
}

// ---- WhatsApp
async function waPage() {
  const w = await api('GET', '/api/whatsapp');
  main.innerHTML = `<h2>WhatsApp</h2>
    <div class="card"><div class="row"><div class="grow">State: <b class="${w.state === 'connected' ? 'good' : ''}">${esc(w.state)}</b>${w.me ? ` as <span class="mono">${esc(w.me)}</span>` : ''}${w.error ? `<div class="bad small">${esc(w.error)}</div>` : ''}</div>
      ${w.state === 'off' || w.state === 'logged out' || w.state === 'not installed' || w.state === 'error' ? '<button class="primary" data-wa="start">Connect</button>' : '<button data-wa="stop">Disconnect</button><button class="danger" data-wa="logout">Log out</button>'}</div>
      ${w.installed === false ? '<p class="small">The WhatsApp library is not installed yet. On this PC, in the flow folder: <span class="mono">npm install</span> - then Connect.</p>' : ''}
      ${w.qr ? '<p>On the spare phone: WhatsApp › Settings › Linked devices › Link a device - scan this:</p><div class="qr" data-qr></div>' : ''}
      <p class="muted small">Use a spare SIM's WhatsApp, not your own number: this is not WhatsApp's official API, and a number that sends like a bot can be blocked. Messages go only to your own people and as replies.</p></div>
    <div class="card"><b>Send a test message</b><div class="grid2"><div><label>To (number with country code, or a group's name)</label><input data-to></div><div><label>Text</label><input data-tx value="✅ Limelight Flow: WhatsApp works"></div></div>
      <div class="row" style="margin-top:10px"><button data-test>Send</button></div></div>
    <div class="card"><b>Try a message without a phone</b> <span class="muted small">(as if it came in - the flows with a WhatsApp trigger answer; the answer shows here, nothing is sent)</span>
      <div class="grid2"><div><label>From (empty = ownerPhone)</label><input data-sfrom></div><div><label>Text</label><input data-stext value="online"></div></div>
      <div class="row" style="margin-top:10px"><button data-sim>Try</button></div><div data-simout></div></div>
    ${w.groups?.length ? `<div class="card"><b>Groups</b>${w.groups.map((g) => `<div class="small">${esc(g.name)} <span class="muted">(${g.size}) </span><span class="mono muted">${esc(g.id)}</span></div>`).join('')}</div>` : ''}`;
  if (w.qr && window.QRCode) new window.QRCode($('[data-qr]'), { text: w.qr, width: 240, height: 240 });
  $$('[data-wa]').forEach((b) => (b.onclick = async () => { try { await api('POST', '/api/whatsapp', { action: b.dataset.wa }); setTimeout(() => show('whatsapp'), 800); } catch (x) { toast(x.message, true); } }));
  $('[data-test]').onclick = async () => { try { await api('POST', '/api/whatsapp', { action: 'test', to: $('[data-to]').value, text: $('[data-tx]').value }); toast('Sent'); } catch (x) { toast(x.message, true); } };
  $('[data-sim]').onclick = () => simTry('whatsapp');
  if (['starting', 'scan the QR', 'reconnecting'].includes(w.state)) waTimer = setInterval(async () => { const n = await api('GET', '/api/whatsapp').catch(() => null); if (n && (n.state !== w.state || n.qr !== w.qr)) show('whatsapp'); }, 3000);
}

// ---- Settings
async function settingsPage() {
  const s = await api('GET', '/api/settings');
  const vars = Object.entries(s.vars || {}); for (const k of ['ownerPhone', 'ownerTelegram']) if (!vars.some(([x]) => x === k)) vars.unshift([k, '']);
  main.innerHTML = `<h2>Settings</h2>
    <div class="card"><b>The editor</b><p class="muted small">Its team address on the office network, and its report token (in the editor: 👥 Team › Report token).</p>
      <div class="grid2"><div><label>Address</label><input data-eurl value="${esc(s.editor.url)}" placeholder="http://192.168.0.200:3100"></div>
      <div><label>Report token ${s.editor.tokenSet ? '<span class="good">(set - leave empty to keep it)</span>' : ''}</label><input type="password" data-etok autocomplete="off"></div></div>
      <div class="row" style="margin-top:10px"><button data-esave class="primary">Save</button><button data-etest>Test</button><span class="small" data-eout></span></div></div>
    <div class="card"><b>Variables</b> <span class="muted small">(vars.&lt;name&gt; in the flows - ownerTelegram: your Telegram chat id (Telegram page); ownerPhone: your WhatsApp number with country code, e.g. 9198XXXXXXXX)</span>
      <div data-vars>${vars.map(([k, v]) => varRow(k, v)).join('')}</div>
      <div class="row" style="margin-top:10px"><button data-vadd>+ Variable</button><button class="primary" data-vsave>Save</button></div></div>
    <p class="muted small">Limelight Flow on ${esc(s.host)}, port ${s.port} · data in <span class="mono">${esc(s.dataDir)}</span></p>`;
  $('[data-esave]').onclick = async () => { try { await api('PUT', '/api/settings', { editor: { url: $('[data-eurl]').value, token: $('[data-etok]').value } }); toast('Saved'); settingsPage(); } catch (x) { toast(x.message, true); } };
  $('[data-etest]').onclick = async () => { $('[data-eout]').textContent = '…'; try { const r = await api('POST', '/api/settings/test-editor'); $('[data-eout]').innerHTML = `<span class="good">✓ ${esc(r.online.text)}</span>`; } catch (x) { $('[data-eout]').innerHTML = `<span class="bad">${esc(x.message)}</span>`; } };
  $('[data-vadd]').onclick = () => $('[data-vars]').insertAdjacentHTML('beforeend', varRow('', ''));
  $('[data-vsave]').onclick = async () => { const o = {}; $$('[data-var]').forEach((r) => { const k = $('[data-vk]', r).value.trim(); if (k) o[k] = $('[data-vv]', r).value; }); try { await api('PUT', '/api/settings', { vars: o }); toast('Saved'); } catch (x) { toast(x.message, true); } };
}
const varRow = (k, v) => `<div class="grid2" data-var><div><label>Name</label><input data-vk value="${esc(k)}"></div><div><label>Value</label><input data-vv value="${esc(v)}"></div></div>`;

boot().catch((e) => { main.innerHTML = `<p class="bad">${esc(e.message)}</p>`; });
