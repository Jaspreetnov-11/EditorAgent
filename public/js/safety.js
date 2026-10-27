// 🩺 Mazbooti (Phase 21, owner only): how the editor is doing (speed, memory, disks, errors, restarts), the nightly
// backup (folder, time, nights kept, restore a project as a copy) and the standby PC (live mirror + how to start it).
// Server side: healthView / nightlyBackup / mirrorTick / standbyTick in server.mjs, engine/safety.mjs, engine/health.mjs.
import { emit } from './store.js';
import { api } from './api.js';
import { $, esc, toast, modal } from './ui.js';

const GB = (n) => `${(n / 1073741824).toFixed(n > 107374182400 ? 0 : 1)} GB`;
const MB = (n) => (n > 1073741824 ? GB(n) : `${Math.round(n / 1048576)} MB`);
const when = (t) => (t ? new Date(t).toLocaleString() : '-');
const ago = (t) => { if (!t) return 'never'; const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
const up = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);

// a small line chart of one value over the last 24 h (the editor's starts as ticks)
function spark(samples, key, starts, unit, limit) {
  const W = 320, H = 54, t1 = Date.now(), t0 = t1 - 864e5, x = (t) => ((t - t0) / 864e5) * W;
  const vals = samples.map((s) => s[key]), max = Math.max(limit * 1.2, ...vals, 1), y = (v) => H - 4 - (v / max) * (H - 10);
  const pts = samples.map((s) => `${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ');
  const peak = vals.length ? Math.max(...vals) : 0;
  return `<svg class="sf-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(key)} over 24 hours, highest ${peak} ${unit}">
    <line x1="0" x2="${W}" y1="${y(limit)}" y2="${y(limit)}" class="sf-lim"/>
    ${starts.filter((t) => t > t0).map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${H}" class="sf-start"/>`).join('')}
    ${pts ? `<polyline points="${pts}" class="sf-line"/>` : ''}</svg>
    <div class="sf-cap"><span>24 h ago</span><span>highest ${peak} ${unit}</span><span>now</span></div>`;
}

// 📊 Performance: one PC's last hour - CPU, busiest card, its video memory (all 0-100 %)
function perfSpark(hist) {
  const W = 300, H = 40, t1 = Date.now(), t0 = t1 - 3600e3, x = (t) => (((t - t0) / 3600e3) * W).toFixed(1), y = (v) => (H - 3 - (v / 100) * (H - 6)).toFixed(1);
  const line = (k, cls) => { const p = hist.filter((s) => s[k] != null && s.t > t0).map((s) => `${x(s.t)},${y(s[k])}`).join(' '); return p ? `<polyline points="${p}" class="${cls}"/>` : ''; };
  return `<svg class="perf-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Last hour: CPU, GPU, VRAM">${line('cpu', 'perf-l-cpu')}${line('gpu', 'perf-l-gpu')}${line('vram', 'perf-l-vram')}</svg>
    <div class="sf-cap"><span>1 h</span><span><i class="perf-k perf-l-cpu"></i>CPU <i class="perf-k perf-l-gpu"></i>GPU <i class="perf-k perf-l-vram"></i>VRAM</span><span>now</span></div>`;
}
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const GBm = (mb) => `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
const TB = (gb) => (gb >= 1000 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`);
const lvl = (p, hot) => (hot || p >= 90 ? 'bad' : p >= 70 ? 'warn' : '');
const meter = (label, p, txt, hot) => `<div class="perf-m"><span>${label}</span><div class="sf-bar"><i style="width:${Math.min(100, p)}%" class="${lvl(p, hot)}"></i></div><b>${txt}</b></div>`;
// a big number at the top: name, value, a bar
const kpi = (label, value, p, sub = '') => `<div class="perf-kpi"><small>${label}</small><b>${value}</b><div class="sf-bar"><i style="width:${Math.min(100, p)}%" class="${lvl(p)}"></i></div>${sub ? `<small class="muted">${sub}</small>` : ''}</div>`;
// ❤ health 0-100 as a ring (green / amber / red) and ⚡ load as a bar
const hcls = (v) => (v >= 80 ? 'good' : v >= 50 ? 'warn' : 'bad');
const ring = (v, size = 64) => { const r = 26, c = 2 * Math.PI * r; return `<svg class="perf-ring ${hcls(v)}" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="Health ${v} of 100"><circle cx="32" cy="32" r="${r}" class="bg"/><circle cx="32" cy="32" r="${r}" class="fg" stroke-dasharray="${(c * v) / 100} ${c}"/><text x="32" y="37">${v}</text></svg>`; };
const hl = (h, load) => `<span class="perf-hl"><span class="perf-hs ${hcls(h.score)}" title="${esc(h.why.join(' · ') || 'all good')}">❤ ${h.score}</span><span class="perf-ld" title="Load: how busy">⚡ ${load}%</span></span>`;
function nasCard(n) {
  const ms = n.ms.length ? [...n.ms].sort((a, b) => a - b)[Math.floor(n.ms.length / 2)] : null;
  const W = 300, H = 36, t0 = Date.now() - 3600e3, pts = (n.hist || []).filter((x) => x.ms != null).map((x) => `${(((x.t - t0) / 3600e3) * W).toFixed(1)},${(H - 3 - Math.min(1, x.ms / 1000) * (H - 6)).toFixed(1)}`).join(' ');
  return `<div class="perf-pc perf-nas"><header class="perf-h"><b>NAS</b><span class="perf-chip">${esc(n.root)}</span>${hl(n.health, n.load)}</header>
    <div class="perf-nasrow">${ring(n.health.score)}<div class="perf-nasm">
      ${n.total ? meter('Space', pct(n.total - n.free, n.total), `${TB(n.free)} free / ${TB(n.total)}`, n.free / n.total < 0.15) : ''}
      ${meter('Speed', ms == null ? 0 : Math.min(100, (ms / 500) * 100), ms == null ? 'checking…' : `${ms} ms for 1 MB`, ms > 300)}
      ${meter('Busy', pct(n.busy, n.max), `${n.busy} of ${n.max} heavy jobs`)}
    </div>
    <div class="perf-nasg"><p class="small ${n.health.why.length ? 'warn' : 'muted'}">${n.health.why.length ? esc(n.health.why.join(' · ')) : 'All good'}${n.pending ? ` · ${n.pending} saves waiting` : ''}</p>
    ${pts ? `<svg class="perf-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="NAS answer time, last hour"><polyline points="${pts}" class="perf-l-vram"/></svg><div class="sf-cap"><span>1 h</span><span>answer time (lower is better)</span><span>now</span></div>` : ''}</div></div>
  </div>`;
}
// 🎬 the Dashboard shows what the EDITOR takes - its own processes on each PC (FFmpeg, AI, workers), not the PCs' other
// programs; health and load are worked out from the same (engine/sysstats.mjs). A helper too old to measure it shows the
// PC's numbers, said so.
function editorMeters(p) {
  const L = p.live, a = L.app, g = L.gpus || [], vt = g.reduce((n, x) => n + (x.memTotal || 0), 0);
  if (!a) return `<p class="small warn">Older helper - these are the whole PC's numbers (it updates itself)</p>
    ${meter('CPU', L.cpu, `${L.cpu}%`)}${meter('RAM', pct(L.ramUsed, L.ramTotal), `${GBm(L.ramUsed)} / ${GBm(L.ramTotal)}`)}`;
  const d = (L.disks || []).find((x) => !x.net && x.total && x.root.toUpperCase().startsWith(a.disk || '?'));
  return `${meter('CPU', a.cpu, `${a.cpu}%`)}
    ${meter('RAM', pct(a.ram, L.ramTotal), `${GBm(a.ram)} / ${GBm(L.ramTotal)}`)}
    ${g.length ? `${meter('GPU', a.gpu, `${a.gpu}%`)}${meter('VRAM', pct(a.vram, vt), `${GBm(a.vram)} / ${GBm(vt)}`)}
      ${g.map((x) => meter('Heat', x.temp ?? 0, `${x.temp ?? '-'} °C · ${esc(x.name.replace(/^NVIDIA (GeForce )?/, ''))}`, (x.temp ?? 0) >= 83)).join('')}` : ''}
    ${d ? meter(`${esc(d.root)}`, pct(d.total - d.free, d.total), `${TB(d.free)} free`, d.free / d.total < 0.1) : ''}
    ${a.top.some((x) => x.ram >= 50 || x.cpu) ? `<p class="small muted perf-apptop">${a.top.filter((x) => x.ram >= 50 || x.cpu).map((x) => `${esc(x.name)}${x.n > 1 ? ` ×${x.n}` : ''} ${GBm(x.ram)}${x.cpu ? ` · ${x.cpu}%` : ''}`).join(' · ')}</p>` : ''}`;
}
function perfPage(d) {
  const T = d.totals, E = d.editor, A = T.app || { cpu: 0, ram: 0, gpu: 0, vram: 0, procs: 0, pcs: 0 };
  const title = (p) => `<header class="perf-h"><b>${esc(p.label || p.name)}</b><span class="perf-chip ${p.off ? 'off' : ''}">${p.off ? 'Not connected' : p.role === 'helper' ? 'Helper' : 'Server'}</span><small class="muted">${p.label ? esc(p.name) : ''}${p.host && !p.off ? ` · ${esc(p.host)}` : ''}</small>${p.health && !p.off ? hl(p.health, p.load) : ''}</header>`;
  const pcs = d.pcs.map((p) => {
    const L = p.live;
    if (p.off) return `<div class="perf-pc perf-off">${title(p)}<p class="small muted">Run <b>Start Render Worker</b> on it, or restart it.</p></div>`;
    if (!L) return `<div class="perf-pc">${title(p)}<p class="muted small">Waiting for numbers…</p></div>`;
    const w = p.work;
    const work = p.role === 'helper'
      ? `<span class="perf-tag">${w.busy}/${w.slots} running</span><span class="perf-tag">${w.done} done</span>${w.failed ? `<span class="perf-tag bad">${w.failed} failed</span>` : ''}${w.paused ? '<span class="perf-tag warn">paused</span>' : ''}`
      : `<span class="perf-tag">${w.jobs} agent jobs</span><span class="perf-tag">${w.renders} rendering</span>${w.waiting ? `<span class="perf-tag">${w.waiting} waiting</span>` : ''}`;
    return `<div class="perf-pc">${title(p)}${editorMeters(p)}
      ${p.health.why.length ? `<p class="small warn">${esc(p.health.why.join(' · '))}</p>` : ''}
      <div class="perf-tags">${work}</div>${perfSpark(p.hist || [])}</div>`;
  }).join('');
  const H = d.health || { score: 100 }, weak = H.weakest;
  return `<p class="small muted perf-note">🎬 Only the editor's own work on each PC - FFmpeg, AI, its workers - not the PCs' other programs. Health and load are worked out from the same.</p>
    <div class="perf-top">${ring(H.score, 84)}<div><small class="muted">HEALTH</small><b class="perf-top-v">${H.score}<span>/100</span></b>
      <small class="muted">${H.score >= 80 ? 'All good' : `Weakest: ${esc(weak?.label || weak?.name || '')} - ${esc((weak?.health?.why || []).join(' · '))}`}</small></div>
      <div class="perf-top-load"><small class="muted">LOAD</small><b class="perf-top-v">${d.load ?? 0}<span>%</span></b><div class="sf-bar"><i style="width:${d.load ?? 0}%" class="${lvl(d.load ?? 0)}"></i></div><small class="muted">all ${d.pcs.filter((p) => p.live).length} PCs together${d.busiest ? ` · busiest: ${esc(d.busiest.label)} ${d.busiest.load}%` : ''}</small></div></div>
    <div class="perf-kpis">
      ${kpi('CPU', `${A.cpu}%`, A.cpu, `of ${T.cores} cores`)}
      ${kpi('RAM', GBm(A.ram), pct(A.ram, T.ramTotal), `of ${GBm(T.ramTotal)}`)}
      ${kpi('GPU', `${A.gpu}%`, A.gpu, `busiest of ${T.gpus} cards`)}
      ${kpi('GPU memory', GBm(A.vram), pct(A.vram, T.vramTotal), `of ${GBm(T.vramTotal)}`)}
      ${T.nasTotal ? kpi('NAS free', TB(T.nasFree), pct(T.nasTotal - T.nasFree, T.nasTotal), `of ${TB(T.nasTotal)}`) : ''}
    </div>
    <div class="perf-tags perf-line"><span class="perf-tag">${T.pcs} PCs</span><span class="perf-tag">${A.procs} editor processes</span><span class="perf-tag">${E.people} editing</span><span class="perf-tag">${E.farmRunning} helper tasks running</span><span class="perf-tag">${E.farmWaiting} waiting</span></div>
    <div class="perf-grid">${d.nas ? nasCard(d.nas) : ''}${pcs}</div>`;
}
// 💥 Crashes: the last 7 days of errors in everyone's editor and in the server, grouped, most frequent first
function crashPage(d) {
  const max = Math.max(1, ...d.perDay, ...d.restarts), wd = (i) => new Date(Date.now() - (d.days - 1 - i) * 864e5).toLocaleDateString('en-IN', { weekday: 'short' });
  const bars = d.perDay.map((n, i) => `<div class="cr-day"><i style="height:${Math.round((n / max) * 60)}px" title="${n} errors"></i><i class="cr-rs" style="height:${Math.round((d.restarts[i] / max) * 60)}px" title="${d.restarts[i]} restarts"></i><small>${wd(i)}</small></div>`).join('');
  const rows = d.groups.map((g) => `<tr><td><b>${g.count}</b></td><td><span class="cr-k ${g.kind}">${g.kind === 'editor' ? 'Editor' : 'Server'}</span> ${esc(g.where)}<br><span class="cr-msg" title="${esc(g.stack || g.msg)}">${esc(g.msg)}</span></td>
    <td>${esc(g.who.join(', ') || '-')}</td><td>${ago(g.first)}</td><td>${ago(g.last)}</td></tr>`).join('');
  return `<div class="sf-cards"><div><b>${d.total}</b><small>errors in ${d.days} days</small></div><div><b>${d.groups.length}</b><small>different ones</small></div><div><b>${d.restarts.reduce((a, b) => a + b, 0)}</b><small>restarts (editor / workers)</small></div></div>
    <div class="cr-bars">${bars}</div><p class="muted small">Bars: errors per day (the thin bar: restarts). Hover a message for its first lines.</p>
    ${rows ? `<table class="cr-table"><tr><th>Times</th><th>Error</th><th>Who</th><th>First</th><th>Last</th></tr>${rows}</table>` : '<p class="sf-ok">No errors in the last 7 days.</p>'}`;
}
// tab 'perf' (📊 the Dashboard button): its own window, "Performance"; the others: Mazbooti with its tabs
export async function openSafety(tab = 'health') {
  const perfOnly = tab === 'perf';
  const dlg = modal(perfOnly ? 'Performance' : 'Mazbooti', `<div class="mm-tabs" role="tablist"${perfOnly ? ' hidden' : ''}>
      <button class="chip" data-tab="health" role="tab">Health</button><button class="chip" data-tab="backup" role="tab">Backup</button><button class="chip" data-tab="standby" role="tab">Standby PC</button><button class="chip" data-tab="crash" role="tab">Crashes</button>
    </div><div class="sf-body" data-sf>Loading…</div>`, { width: perfOnly ? 1240 : 820, onClose: () => clearTimeout(timer) });
  const box = $('[data-sf]', dlg.el);
  let cur = tab, data = null, timer = null, nightsList = null, perfData = null, crashData = null;
  const load = async () => {
    clearTimeout(timer);
    try {
      if (cur === 'perf') perfData = await api('GET', '/api/team/perf');
      else if (cur === 'crash') crashData = await api('GET', '/api/safety/crashes');
      else data = await api('GET', '/api/safety');
      show();
    } catch (e) { box.textContent = e.message; }
    if (dlg.el.open) timer = setTimeout(load, cur === 'perf' ? 5000 : data?.backup?.busy ? 3000 : 20000);
  };
  const show = () => {
    dlg.el.querySelectorAll('[data-tab]').forEach((b) => { b.classList.toggle('on', b.dataset.tab === cur); b.setAttribute('aria-selected', b.dataset.tab === cur); });
    if (cur === 'perf') { box.innerHTML = perfData ? perfPage(perfData) : 'Loading…'; return; }
    if (cur === 'crash') { box.innerHTML = crashData ? crashPage(crashData) : 'Loading…'; return; }
    if (!data) return;
    const keep = box.querySelector('input:focus, select:focus'); if (keep && cur !== 'health') return; // (not while typing a folder)
    box.innerHTML = ({ health, backup, standby })[cur](data);
  };
  dlg.el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { cur = b.dataset.tab; show(); if (cur === 'perf' || cur === 'crash' || !data) load(); if (cur === 'backup' && !nightsList) loadNights(); }));
  const loadNights = async () => { try { nightsList = await api('GET', '/api/safety/nights'); } catch { nightsList = []; } if (cur === 'backup') show(); };

  const warnHTML = (d) => (d.warn.length ? `<ul class="sf-warn">${d.warn.map((w) => `<li class="${w.level}">${esc(w.text)}</li>`).join('')}</ul>` : '<p class="sf-ok">All good</p>');
  function health(d) {
    const s = d.series, last = s.samples.at(-1) || {}, starts24 = s.starts.filter((t) => t > Date.now() - 864e5);
    return `${d.standby ? `<p class="sf-standby">This is the <b>standby editor</b> on ${esc(d.host)} - the main editor is down. Everything saved here goes back to it when it is up again.</p>` : ''}
      ${warnHTML(d)}
      <div class="sf-cards">
        <div><b>${up(s.now.up)}</b><small>running (since the last start)</small></div>
        <div><b>${(s.now.rss / 1024).toFixed(1)} GB</b><small>memory</small></div>
        <div><b>${last.cpu ?? '-'}%</b><small>CPU (last minute)</small></div>
        <div><b>${d.work.people}</b><small>editing now</small></div>
        <div><b>${d.work.jobs} · ${d.work.renders}</b><small>jobs · renders</small></div>
        <div><b>${d.work.farm}</b><small>render-farm PCs</small></div>
      </div>
      <div class="sf-charts">
        <div><h4>Stuck time (ms the editor could not answer)</h4>${spark(s.samples, 'lagMax', s.starts, 'ms', 250)}</div>
        <div><h4>Slowest actions (95% are faster, ms)</h4>${spark(s.samples, 'p95', s.starts, 'ms', 2000)}</div>
      </div>
      <p class="muted small">The dashed line is where it starts to feel slow. A tall bar = the editor started (${starts24.length} in the last 24 h${starts24.length ? `, last ${ago(starts24[0])}` : ''}).</p>
      <h4>Project workers</h4>
      <p class="muted small">Each project is kept by one worker process, so one project's heavy moment (a huge timeline, a slow NAS) only slows the projects of its own worker. Takes effect at the next start of the editor.</p>
      <label class="sf-row">Workers <select data-k="workers">${[0, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64].map((n) => `<option value="${n}" ${n === d.cluster.want ? 'selected' : ''}>${n ? n : 'Off (one process)'}</option>`).join('')}</select>
        ${d.cluster.want !== d.cluster.on ? '<span class="sf-busy">restart the editor to apply</span>' : ''}</label>
      ${d.cluster.workers.length ? `<table class="sf-disks">${d.cluster.workers.map((w) => w.down ? `<tr><td>Worker ${w.k}</td><td colspan="3" class="bad">not answering - starting again</td></tr>`
        : `<tr><td>Worker ${w.k}</td><td class="${w.lag > 250 ? 'bad' : ''}">stuck ${w.lag} ms</td><td>${(w.rss / 1024).toFixed(1)} GB · ${w.jobs.length} jobs · ${w.queue} files waiting${w.starts > 1 ? ` · restarted ${w.starts - 1}×` : ''}</td><td class="muted">${esc(w.projects.map((x) => `${x.name}${x.people ? ` (${x.people})` : ''}`).join(', ') || 'no project open')}</td></tr>`).join('')}</table>` : ''}
      <h4>Disks</h4>
      <table class="sf-disks">${d.disks.map((x) => x.error ? `<tr><td>${esc(x.root)}</td><td colspan="2" class="bad">does not answer (${esc(x.error)})</td><td class="muted">${esc(x.what.join(', '))}</td></tr>`
        : `<tr><td>${esc(x.root)}</td><td><div class="sf-bar"><i style="width:${Math.round((1 - x.free / x.total) * 100)}%" class="${x.free / x.total < 0.1 ? 'bad' : ''}"></i></div></td><td>${GB(x.free)} free of ${GB(x.total)}</td><td class="muted">${esc(x.what.join(', '))}</td></tr>`).join('')}</table>
      <h4>Errors (last 24 h): ${d.errors.count}</h4>
      ${d.errors.latest.length ? `<ul class="sf-errs">${d.errors.latest.map((e) => `<li><span class="muted">${new Date(e.t).toLocaleTimeString()}</span> <b>${esc(e.kind)}</b> ${esc(e.msg)}</li>`).join('')}</ul>` : '<p class="muted small">None.</p>'}`;
  }
  function backup(d) {
    const b = d.backup, L = b.last;
    return `${warnHTML({ warn: d.warn.filter((w) => /backup/i.test(w.text)) })}
      <div class="sf-form">
        <label class="sf-row"><input type="checkbox" data-k="on" ${b.on ? 'checked' : ''}> Every night, on its own</label>
        <label class="sf-row">Folder <input type="text" data-k="dest" value="${esc(b.dest || '')}" placeholder="Z:\\Limelight Backups" spellcheck="false"><button class="small" data-act="dest">Save folder</button></label>
        <label class="sf-row">At <select data-k="hour">${Array.from({ length: 24 }, (_, i) => `<option value="${i}" ${i === b.hour ? 'selected' : ''}>${String(i).padStart(2, '0')}:00</option>`).join('')}</select>
          Keep <select data-k="keep">${[7, 14, 30, 60].map((n) => `<option ${n === b.keep ? 'selected' : ''}>${n}</option>`).join('')}</select> nights</label>
        <p class="muted small">What goes: every project's timeline, media list, named versions, subtitles and LUTs (a folder per night), its uploaded files (VO, music, logos - one copy, only new ones are added), and the editor's settings. Footage is not copied - it stays where it is. If the editor is off at that hour, the backup runs when it starts.</p>
      </div>
      <div class="sf-now">
        ${b.busy ? `<span class="sf-busy">Backing up… ${esc(b.busy.step || '')}</span>` : `<button class="accent" data-act="now" ${b.dest ? '' : 'disabled'}>Back up now</button>`}
        <span>${L ? `Last: <b>${L.ok ? 'OK' : 'Failed'} - ${when(L.at)}</b> - ${L.projects ?? 0} projects, ${MB(L.bytes || 0)} copied${L.secs ? `, ${L.secs} s` : ''}${L.errors?.length ? `<br><span class="bad">${esc(L.errors.slice(0, 3).join(' · '))}</span>` : ''}` : 'No backup yet'}</span>
      </div>
      <h4>Bring a project back</h4>
      ${!nightsList ? '<p class="muted small">Loading the nights…</p>' : !nightsList.length ? '<p class="muted small">No nights yet.</p>'
        : `<div class="sf-restore"><select data-k="night">${nightsList.map((n) => `<option value="${n.night}">${n.night} (${n.projects.length} projects)</option>`).join('')}</select>
          <select data-k="rproj">${(nightsList[0]?.projects || []).sort().map((p) => `<option>${esc(p)}</option>`).join('')}</select>
          <button data-act="restore">Restore as a copy</button></div>
          <p class="muted small">It comes back as a new project "<i>name</i> (backup <i>night</i>)" - nothing that is there now is changed.</p>`}`;
  }
  function standby(d) {
    const b = d.backup, f = b.standbyFile;
    const live = b.dest ? `${b.dest.replace(/[\\/]+$/, '')}\\live` : '';
    return `${b.hold ? `<ul class="sf-warn"><li class="bad">${b.hold.pending ? `Edits from ${esc(b.hold.host)} are coming back${b.hold.error ? `: ${esc(b.hold.error)}` : ''}` : `${esc(b.hold.host)} is running the editor since ${when(b.hold.since)} - this editor only shows`}</li></ul>
        ${b.hold.pending || !f || f.state !== 'active' ? '<p><button data-act="pull">Bring the edits back now</button> <button data-act="dismiss">Leave them (keep this editor as it is)</button></p>' : ''}` : ''}
      <p>If this PC (or its editor) goes down, a second office PC carries on: it watches this editor, and after 2 minutes without an answer it starts the editor from a copy of the projects on the NAS. Everyone opens <b>that PC's link</b> and keeps working. When this editor is back, the second PC saves, stops and hands the edits back here.</p>
      <label class="sf-row"><input type="checkbox" data-k="mirror" ${b.mirror ? 'checked' : ''} ${b.dest ? '' : 'disabled'}> Keep a live copy for the standby PC (every 5 minutes, only what changed)</label>
      ${b.mirror ? `<p class="small">Live copy: ${b.mirrorAt ? `last ${ago(b.mirrorAt)}` : 'starting…'}${b.mirrorErr ? ` - <span class="bad">${esc(b.mirrorErr)}</span>` : ''} → <span class="mono">${esc(live)}</span></p>` : ''}
      <h4>On the second PC (once)</h4>
      <ol class="small">
        <li>Node.js and FFmpeg installed, the NAS mapped as <b>the same drive letters</b> as here, and a copy of this editor's folder.</li>
        <li>In that folder run (keep the window open; put it in Startup to make it start with Windows):</li>
      </ol>
      <pre class="sf-cmd" data-cmd>node engine/standby.mjs --main ${esc(b.mainLink || 'http://<this PC>:3100')} --mirror "${esc(live || 'Z:\\Limelight Backups\\live')}"</pre>
      <button class="small" data-act="copy">Copy the command</button>
      ${!b.mainLink ? '<p class="muted small">Team editing is off here - the second PC asks this editor through the team link, so turn Team on () first.</p>' : ''}
      ${b.pull ? `<p class="small">Last hand-back from ${esc(b.pull.host)}: ${when(b.pull.at)} - ${esc(b.pull.projects.join(', ') || 'no project changed')}${b.pull.added ? `, ${b.pull.added} new files` : ''}.</p>` : ''}
      <p class="muted small">The backup folder holds the team's sign-ins (passwords only as hashes). Keep it in a NAS folder only the office can open.</p>`;
  }

  const set = async (patch) => { try { data = await api('POST', '/api/safety', patch); toast('Saved'); show(); } catch (e) { toast(e.message, 'err'); show(); } };
  box.addEventListener('change', (e) => {
    const k = e.target.dataset.k; if (!k) return;
    if (k === 'on' || k === 'mirror') set({ [k]: e.target.checked });
    if (k === 'hour' || k === 'keep' || k === 'workers') set({ [k]: +e.target.value });
    if (k === 'night') { const n = nightsList.find((x) => x.night === e.target.value); const p = box.querySelector('[data-k="rproj"]'); p.innerHTML = (n?.projects || []).sort().map((x) => `<option>${esc(x)}</option>`).join(''); }
  });
  box.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act; if (!a) return;
    if (a === 'dest') return set({ dest: box.querySelector('[data-k="dest"]').value });
    if (a === 'now') { try { await api('POST', '/api/safety/backup'); toast('Backup started'); setTimeout(load, 800); } catch (err) { toast(err.message, 'err'); } }
    if (a === 'restore') {
      const night = box.querySelector('[data-k="night"]').value, project = box.querySelector('[data-k="rproj"]').value;
      if (!project || !confirm(`Bring back "${project}" as it was on ${night}?\n\nIt opens as a new project - the one there now stays as it is.`)) return;
      try { const r = await api('POST', '/api/safety/restore', { night, project }); toast(`"${r.name}" is back - it is in Projects (Home)`); } catch (err) { toast(err.message, 'err'); }
    }
    if (a === 'pull' || a === 'dismiss') {
      if (a === 'dismiss' && !confirm('Leave the edits made on the standby PC where they are (in the live copy) and go on with this editor as it is?')) return;
      try { data = await api('POST', '/api/safety/standby', { action: a }); show(); emit('safetyChanged'); } catch (err) { toast(err.message, 'err'); }
    }
    if (a === 'copy') { try { await navigator.clipboard.writeText(box.querySelector('[data-cmd]').textContent); toast('Copied'); } catch { toast('Select the command and copy it', 'err'); } }
  });
  load();
  if (tab === 'backup') loadNights();
}

// the 🩺 button in the header shows a dot when something needs a look (checked every 10 minutes, owner only)
export async function watchSafety(btn) {
  if (!btn) return;
  const check = async () => {
    try {
      const d = await api('GET', '/api/safety'), bad = d.warn.some((w) => w.level === 'bad');
      btn.dataset.state = bad ? 'bad' : d.warn.length ? 'warn' : '';
      btn.title = `Mazbooti: health, nightly backup, standby PC${d.warn.length ? `\n${d.warn.map((w) => `• ${w.text}`).join('\n')}` : ' - all good'}`;
    } catch {}
  };
  check(); setInterval(check, 10 * 60e3);
}
