// ⏱ Limelight speed test: how fast previews, renders, the Agent, Re-edit, transcripts and the same-voice AI are on THIS
// editor server - each project alone, then all of them at once - and how quickly the editor still answers meanwhile.
// It never touches the real projects: each one is copied first (Z:/Limelight Bench/BENCH <name>; footage is read from
// where it is, renders / old shot caches are not copied) and the tests run on the copies. The copies are on the NAS
// like real projects, so helper PCs take part as they do in real work.
//
//   node tools/bench/bench.mjs [--n 8] [--projects "A|B|C"] [--skip agent,voice,...] [--force] [--cleanup]
//   (on the editor server itself, at night: it needs the editor on 127.0.0.1:3000 and stops if anything is running)
//
// Writes Z:/Limelight Bench/report-<date>.html (+ .json) and copies them to Z:/Limelight Bench Reports.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
const BASE = process.env.VEDIT_URL || 'http://127.0.0.1:3000';
const DIR = arg('dir', 'Z:/Limelight Bench'), SHARE = arg('share', 'Z:/Limelight Bench Reports');
const N = +arg('n', 8), SKIP = new Set(String(arg('skip', '')).split(',').filter(Boolean));
const STAMP = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const enc = encodeURIComponent;
const PROJECTS = process.env.VEDIT_PROJECTS || 'D:/Video Editor Agent/Projects'; // (the server's own folder - also when run from the NAS release)

function api(method, url, body, timeout = 120000) {
  return new Promise((ok) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null, t0 = Date.now();
    const req = http.request(BASE + url, { method, agent: false, timeout, headers: { Connection: 'close', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => { const t = Buffer.concat(ch).toString('utf8'); let j; try { j = JSON.parse(t); } catch { j = t; } ok({ code: res.statusCode, body: j, ms: Date.now() - t0 }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => ok({ code: 0, body: { error: String(e.message) }, ms: Date.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });
}
const must = async (method, url, body) => { const r = await api(method, url, body); if (r.code >= 400 || r.code === 0) throw new Error(`${method} ${url.split('?')[0]}: ${r.body?.error || r.body}`.slice(0, 300)); return r.body; };

// a job (render / preview / agent / transcript / voice): started, then followed until it ends -> { ok, sec, error }
async function timed(label, start) {
  const t0 = Date.now();
  try {
    const job = await start();
    if (!job?.id) throw new Error(job?.error || 'no job id');
    let last = 0;
    for (;;) {
      await sleep(1500);
      const r = await api('GET', `/api/job?id=${enc(job.id)}`);
      const j = r.body || {};
      if (r.code === 404) throw new Error('the job was lost (editor restarted?)');
      if (j.status && j.status !== 'running') {
        const sec = (Date.now() - t0) / 1000;
        if (j.status !== 'done') return { ok: false, sec, error: (j.log || []).slice(-2).join(' | ').slice(0, 300) || j.status };
        return { ok: true, sec, result: j.result, skipped: j.result?.skipped };
      }
      if (Date.now() - last > 30000) { last = Date.now(); log(`   ${label}: ${j.progress || 0}% ${j.stage || ''}`); }
    }
  } catch (e) { return { ok: false, sec: (Date.now() - t0) / 1000, error: String(e.message || e) }; }
}

// ---------- 0. nothing else may be running ----------
async function idle() {
  const j = await api('GET', '/api/jobs'), q = await api('GET', '/api/queue');
  if (j.code !== 200) throw new Error(`The editor does not answer on ${BASE} - run this on the editor server itself`);
  const busy = (j.body || []).filter((x) => x.status === 'running').length + (q.body?.items || []).filter((x) => ['waiting', 'rendering'].includes(x.state)).length;
  return busy;
}

// ---------- 1. projects: a varied set, copied ----------
const readJ = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
async function pick() {
  const all = (await must('GET', '/api/projects')).filter((p) => !/^BENCH /.test(p.name));
  const want = arg('projects', '') ? String(arg('projects')).split('|').map((s) => s.trim()) : null;
  const rows = [];
  for (const p of all) {
    if (want && !want.includes(p.name)) continue;
    const dir = p.place || path.join(PROJECTS, p.name); // (no place: the editor's own Projects folder)
    const pj = dir && readJ(path.join(dir, 'project.json'));
    if (!pj?.tracks?.V1?.length) continue;
    const clips = Object.values(pj.tracks).flat().length;
    rows.push({ name: p.name, dir, aspect: pj.settings?.aspect || '16:9', clips, agent: !!pj.agentOpts, modified: p.modified || 0 });
  }
  if (want) return rows;
  // a mix: different frame shapes first, then agent-made edits, then the biggest timelines, newest first within those
  rows.sort((a, b) => b.modified - a.modified);
  const out = [], seenAsp = new Set();
  for (const r of rows) if (!seenAsp.has(r.aspect) && out.length < N) { out.push(r); seenAsp.add(r.aspect); }
  for (const r of rows.filter((x) => x.agent)) if (out.length < Math.ceil(N * 0.7) && !out.includes(r)) out.push(r);
  for (const r of [...rows].sort((a, b) => b.clips - a.clips)) if (out.length < N && !out.includes(r)) out.push(r);
  return out;
}
// the copy: project, media list, baked motion graphics, preview copies (proxies), footage analysis and transcripts -
// not renders, backups or the shot cache (cache/segments: a render would only reuse old shots)
const KEEP_CACHE = ['graphics', 'proxies', 'analysis', 'transcripts', 'thumbs', 'agent', 'faces', 'people'];
function copyDir(a, b) { if (!fs.existsSync(a)) return; fs.cpSync(a, b, { recursive: true, force: true, errorOnExist: false }); }
async function copyProject(p) {
  const name = `BENCH ${p.name}`.slice(0, 120), dst = path.join(DIR, name);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(p.dir)) {
    const s = path.join(p.dir, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dst, f));
  }
  for (const c of KEEP_CACHE) copyDir(path.join(p.dir, 'cache', c), path.join(dst, 'cache', c));
  for (const d of ['luts', 'subs', 'imports', 'output']) fs.mkdirSync(path.join(dst, d), { recursive: true });
  // (imports: pictures / voice-overs made in the editor live there - the media list points at the original files, so
  // nothing needs copying; luts and subs are small)
  copyDir(path.join(p.dir, 'luts'), path.join(dst, 'luts')); copyDir(path.join(p.dir, 'subs'), path.join(dst, 'subs'));
  const r = await must('POST', '/api/projects/open-folder', { dir: dst });
  return { ...p, bench: r.name, benchDir: dst };
}
const freshShots = (p) => fs.rmSync(path.join(p.benchDir, 'cache', 'segments'), { recursive: true, force: true });

// ---------- 2. the tests ----------
// the edit's length: In to Out, else the end of its last clip (V1 back to back, other tracks by their start) - near enough
const cLen = (c) => +c.dur || (c.out != null ? Math.max(0, (c.out - (c.in || 0)) / (c.speed || 1)) : 0);
const editLen = (pj) => {
  const r = pj.settings?.range; if (r && r.out > r.in) return r.out - r.in;
  const v1 = (pj.tracks?.V1 || []).reduce((n, c) => n + cLen(c), 0);
  const rest = Object.entries(pj.tracks || {}).filter(([k]) => k !== 'V1' && k[0] === 'V').flatMap(([, l]) => l).map((c) => (+c.start || 0) + cLen(c));
  return Math.max(v1, ...rest) || null;
};
function tests(p) {
  const pj = readJ(path.join(p.benchDir, 'project.json'), {}), media = readJ(path.join(p.benchDir, 'media.json'), { items: [] });
  const items = media.items || media, byId = Object.fromEntries(items.map((m) => [m.id, m]));
  const used = [...new Set(Object.values(pj.tracks || {}).flat().map((c) => c.mediaId).filter(Boolean))].map((id) => byId[id]).filter(Boolean);
  const talk = used.filter((m) => m.hasAudio && (m.kind === 'video' || m.kind === 'audio') && m.duration > 20).sort((a, b) => b.duration - a.duration)[0];
  const t = {
    preview: () => { freshShots(p); return api('POST', `/api/render?p=${enc(p.bench)}`, { preview: true, whole: true }).then((r) => r.body); },
    render: () => { freshShots(p); return api('POST', `/api/render?p=${enc(p.bench)}`, { whole: true, filename: 'bench' }).then((r) => r.body); },
  };
  if (pj.agentOpts) {
    t.agent = () => api('POST', `/api/agent?p=${enc(p.bench)}`, { ...pj.agentOpts }).then((r) => r.body);
    if (pj.agentReport?.slots?.length) t.reedit = () => api('POST', `/api/agent?p=${enc(p.bench)}`, { ...pj.agentOpts, reedit: true, mode: 'reedit', intent: 'thoda fast kar, end mein logo' }).then((r) => r.body);
  }
  if (talk) {
    t.transcript = () => { fs.rmSync(path.join(p.benchDir, 'cache', 'transcripts', `${talk.id}.json`), { force: true }); return api('POST', `/api/transcript?p=${enc(p.bench)}`, { mediaId: talk.id, lang: 'auto', model: 'large-v3-turbo' }).then((r) => r.body); };
    t.voice = () => api('POST', `/api/tts?p=${enc(p.bench)}`, { provider: 'clone', refMediaId: talk.id, refIn: 0, text: 'नमस्कार, यह आवाज़ की गति जाँचने के लिए एक छोटा सा वाक्य है। दूसरा वाक्य भी यहाँ है।' }).then((r) => r.body);
  }
  for (const k of SKIP) delete t[k];
  return { t, len: editLen(pj), talk: talk ? { name: talk.name, sec: talk.duration } : null };
}

// ---------- 3. while it runs: how fast the editor answers, how busy the PC is ----------
function sampler() {
  const s = { lat: [], perf: [], stop: false };
  (async () => {
    while (!s.stop) {
      const r = await api('GET', '/api/jobs', null, 30000);
      s.lat.push({ t: Date.now(), ms: r.code === 200 ? r.ms : 30000 });
      if (s.lat.length % 4 === 1) { const p = await api('GET', '/api/team/perf', null, 15000); if (p.code === 200) s.perf.push({ t: Date.now(), p: p.body }); }
      await sleep(3000);
    }
  })();
  return s;
}
const pct = (a, q) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };

// ---------- main ----------
const R = { started: Date.now(), host: os.hostname(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGB: Math.round(os.totalmem() / 2 ** 30), version: null, projects: [], solo: [], together: [], latency: {}, perf: [], notes: [] };
async function main() {
  R.version = (await api('GET', '/api/version')).body;
  const busy = await idle();
  if (busy && !arg('force')) { log(`${busy} job(s) / render(s) are running on the editor - run again when it is free (or --force)`); process.exit(2); }
  fs.mkdirSync(DIR, { recursive: true });
  const chosen = await pick();
  if (!chosen.length) throw new Error('No projects to test');
  log(`Copying ${chosen.length} projects to ${DIR} ...`);
  const ps = [];
  for (const p of chosen) { try { ps.push(await copyProject(p)); log(`  ✓ ${p.name} (${p.aspect}, ${p.clips} clips)`); } catch (e) { R.notes.push(`${p.name}: not copied - ${e.message}`); log(`  ✗ ${p.name}: ${e.message}`); } }
  const T = Object.fromEntries(ps.map((p) => [p.bench, tests(p)]));
  R.projects = ps.map((p) => ({ name: p.name, aspect: p.aspect, clips: p.clips, len: T[p.bench].len, talk: T[p.bench].talk, tests: Object.keys(T[p.bench].t) }));

  // A. each project alone, one test at a time
  const s1 = sampler();
  for (const p of ps) for (const [k, fn] of Object.entries(T[p.bench].t)) {
    log(`solo · ${p.name} · ${k}`);
    const r = await timed(`${p.name} ${k}`, fn);
    R.solo.push({ project: p.name, test: k, ...r, result: undefined, on: r.result?.on });
    log(`   ${r.ok ? '✓' : '✗'} ${r.sec.toFixed(1)} s${r.ok ? '' : ` - ${r.error}`}`);
  }
  s1.stop = true; R.latency.solo = s1.lat.map((x) => x.ms); R.perf.push(...s1.perf.map((x) => ({ phase: 'solo', ...x })));

  // B. all projects at once, one kind of test at a time (previews together, then renders together, ...)
  for (const k of ['preview', 'render', 'agent', 'reedit', 'transcript', 'voice']) {
    const run = ps.filter((p) => T[p.bench].t[k]);
    if (run.length < 2) continue;
    log(`together · ${k} × ${run.length}`);
    const s = sampler(), t0 = Date.now();
    const rs = await Promise.all(run.map((p) => timed(`${p.name} ${k}`, T[p.bench].t[k]).then((r) => ({ project: p.name, test: k, ...r, result: undefined }))));
    s.stop = true;
    R.together.push({ test: k, n: run.length, wallSec: (Date.now() - t0) / 1000, items: rs });
    R.latency[k] = s.lat.map((x) => x.ms); R.perf.push(...s.perf.map((x) => ({ phase: k, ...x })));
    log(`   ${k} × ${run.length}: ${((Date.now() - t0) / 1000).toFixed(1)} s for all, ${rs.filter((x) => !x.ok).length} failed`);
  }
  R.ended = Date.now();
  if (arg('cleanup')) for (const p of ps) { await api('POST', `/api/projects/delete?p=${enc(p.bench)}`); }
  write();
}

// ---------- 4. the report ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (s) => (s == null ? '–' : s >= 90 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`);
const NAMES = { preview: 'Preview', render: 'Render', agent: 'Agent edit', reedit: 'Re-edit', transcript: 'Transcript (Whisper)', voice: 'Same-voice AI' };
function write() {
  const out = path.join(DIR, `report-${STAMP}`);
  fs.writeFileSync(`${out}.json`, JSON.stringify(R, null, 1));
  const lenOf = (n) => R.projects.find((p) => p.name === n)?.len;
  const speed = (r) => { const L = lenOf(r.project); return r.ok && L && (r.test === 'render' || r.test === 'preview') ? `${(L / r.sec).toFixed(2)}×` : ''; };
  const kinds = Object.keys(NAMES).filter((k) => R.solo.some((r) => r.test === k));
  const avg = (k, list) => { const a = list.filter((r) => r.test === k && r.ok).map((r) => r.sec); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
  const lat = Object.entries(R.latency).map(([k, a]) => `<tr><td>${esc(k === 'solo' ? 'One test at a time' : `${NAMES[k]} - all projects at once`)}</td><td>${pct(a, 0.5)} ms</td><td>${pct(a, 0.95)} ms</td><td>${Math.max(0, ...a)} ms</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Editor Speed Report</title>
<style>:root{--bg:#141414;--fg:#eee;--mut:#9a9a9a;--card:#1e1e1e;--line:#2c2c2c;--acc:#f5c518;--bad:#ff6b6b;--ok:#6bd88a}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,sans-serif}main{max-width:1000px;margin:0 auto;padding:24px 16px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 10px;color:var(--acc)}.mut{color:var(--mut)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.card b{display:block;font-size:22px}table{width:100%;border-collapse:collapse;background:var(--card);border-radius:10px;overflow:hidden;font-size:14px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--mut);font-weight:600}.bad{color:var(--bad)}.ok{color:var(--ok)}
.wrap{overflow-x:auto}</style></head><body><main>
<h1>Editor Speed Report</h1><div class="mut">${esc(R.host)} · ${esc(R.cpu)} · ${R.cores} cores · ${R.ramGB} GB · ${new Date(R.started).toLocaleString()} → ${new Date(R.ended).toLocaleTimeString()} · ${R.projects.length} projects (tested on copies)</div>
<h2>Average, one at a time</h2><div class="cards">${kinds.map((k) => `<div class="card"><span class="mut">${NAMES[k]}</span><b>${fmt(avg(k, R.solo))}</b><span class="mut">${R.solo.filter((r) => r.test === k).length} runs, ${R.solo.filter((r) => r.test === k && !r.ok).length} failed</span></div>`).join('')}</div>
<h2>All projects at once</h2><div class="wrap"><table><tr><th>What</th><th>How many</th><th>All done in</th><th>Same jobs one by one</th><th>Failed</th></tr>
${R.together.map((g) => { const seq = R.solo.filter((r) => r.test === g.test && r.ok).reduce((n, r) => n + r.sec, 0); return `<tr><td>${NAMES[g.test]}</td><td>${g.n}</td><td><b>${fmt(g.wallSec)}</b></td><td>${fmt(seq)}${seq ? ` <span class="mut">(${(seq / g.wallSec).toFixed(1)}× faster together)</span>` : ''}</td><td class="${g.items.some((x) => !x.ok) ? 'bad' : 'ok'}">${g.items.filter((x) => !x.ok).length}</td></tr>`; }).join('')}</table></div>
<h2>Each project</h2><div class="wrap"><table><tr><th>Project</th><th>Shape</th><th>Length</th>${kinds.map((k) => `<th>${NAMES[k]}</th>`).join('')}</tr>
${R.projects.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.aspect)}</td><td>${fmt(p.len)}</td>${kinds.map((k) => { const r = R.solo.find((x) => x.project === p.name && x.test === k); return `<td>${!r ? '<span class="mut">–</span>' : r.ok ? `${fmt(r.sec)} <span class="mut">${speed(r)}</span>${r.skipped?.length ? ' <span class="bad">⚠</span>' : ''}` : `<span class="bad" title="${esc(r.error)}">failed</span>`}</td>`; }).join('')}</tr>`).join('')}</table></div>
<p class="mut">Render / preview speed: edit length ÷ time taken (1× = as long as the video, 2× = twice as fast). "Same-voice AI" includes loading the voice model the first time.</p>
<h2>Is the editor still responsive?</h2><div class="mut">How long the editor took to answer a simple request (every 3 s) while the tests ran - what a person feels as lag.</div>
<div class="wrap"><table><tr><th>While</th><th>Usual</th><th>Slowest 5%</th><th>Worst</th></tr>${lat}</table></div>
${R.notes.length || [...R.solo, ...R.together.flatMap((g) => g.items)].some((r) => !r.ok) ? `<h2>Problems seen</h2><ul>${R.notes.map((n) => `<li>${esc(n)}</li>`).join('')}${[...R.solo.map((r) => ({ ...r, w: 'alone' })), ...R.together.flatMap((g) => g.items.map((r) => ({ ...r, w: 'together' })))].filter((r) => !r.ok).map((r) => `<li><b>${esc(r.project)}</b> · ${NAMES[r.test]} (${r.w}): ${esc(r.error)}</li>`).join('')}</ul>` : ''}
</main></body></html>`;
  fs.writeFileSync(`${out}.html`, html);
  try { fs.mkdirSync(SHARE, { recursive: true }); fs.copyFileSync(`${out}.html`, path.join(SHARE, path.basename(`${out}.html`))); fs.copyFileSync(`${out}.json`, path.join(SHARE, path.basename(`${out}.json`))); } catch (e) { log(`(not copied to ${SHARE}: ${e.message})`); }
  log(`Report: ${out}.html${fs.existsSync(SHARE) ? `  (also in ${SHARE})` : ''}`);
}

main().catch((e) => { log(`✗ ${e.message}`); if (R.solo.length) { R.ended = Date.now(); R.notes.push(`Stopped early: ${e.message}`); write(); } process.exit(1); });
