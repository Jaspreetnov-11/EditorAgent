// soak.mjs - 🕰 the week-long test run: for --days days (7) it keeps checking the editor while it is used for real -
//   every minute   the live editor (PC A, --main) answers? how fast (its sign-in door, no sign-in needed)
//   every hour     the auto-tests (tests/run.mjs, no server tests - nothing on the office's ports) and a real render on a
//                  throwaway editor (own ports 3990s, own data folder: a 20 s timeline with effects, exported)
// Each result is a line in logs/soak-<start>.jsonl; logs/soak-<start>.html is the summary, written after every round.
//   node tools/soak/soak.mjs [--days 7] [--main http://192.168.0.200:3100] [--every 60]   ("Start soak test.bat")
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const DAYS = +arg('days', 7), MAIN = arg('main', 'http://192.168.0.200:3100'), EVERY = +arg('every', 60);
const STAMP = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const LOG = path.join(ROOT, 'logs', `soak-${STAMP}.jsonl`), HTML = path.join(ROOT, 'logs', `soak-${STAMP}.html`);
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const rec = (o) => { const r = { t: Date.now(), ...o }; rows.push(r); fs.appendFileSync(LOG, `${JSON.stringify(r)}\n`); };
const until = Date.now() + DAYS * 864e5;

async function probe() {
  const t0 = performance.now();
  try { const r = await fetch(`${MAIN}/team/ping`, { signal: AbortSignal.timeout(10000) }); rec({ k: 'ping', ok: r.ok, ms: Math.round(performance.now() - t0) }); }
  catch (e) { rec({ k: 'ping', ok: false, ms: Math.round(performance.now() - t0), err: e.cause?.code || e.message }); }
}
function tests() {
  const t0 = Date.now(), r = spawnSync(process.execPath, ['tests/run.mjs'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 20 * 60000 });
  const last = (r.stdout || '').trim().split('\n').pop() || '', failed = (r.stdout || '').split('\n').filter((l) => /^\s+✗/.test(l)).map((l) => l.trim()).slice(0, 10);
  rec({ k: 'tests', ok: r.status === 0, s: Math.round((Date.now() - t0) / 1000), summary: last, failed });
}
async function render() {
  const t0 = Date.now(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-soak-')), P = 3999, B = `http://127.0.0.1:${P}`;
  const srv = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PORT: String(P), TEAM_PORT: '3998', TEAM_WEB_PORT: '3997', TEAM_TLS_PORT: '3996', SHARE_PORT: '3995', FARM_PORT: '3994', VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '0' } });
  const api = async (m, u, b) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(B + '/api/version')).ok) break; } catch {} await sleep(500); }
    const vid = path.join(tmp, 'clip.mp4');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=20', '-f', 'lavfi', '-i', 'sine=d=20', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', vid], { windowsHide: true });
    await api('POST', '/api/projects', { name: 'Soak' });
    await api('POST', '/api/import?p=Soak', { files: [vid] });
    let m; for (let i = 0; i < 120; i++) { const r = await api('GET', '/api/media?p=Soak'); m = (r.items || r)[0]; if (m?.status === 'ready') break; await sleep(250); }
    const pj = await api('GET', '/api/project?p=Soak');
    pj.tracks.V1 = [0, 1].map((i) => ({ id: `c${i}`, type: 'video', mediaId: m.id, in: i * 10, out: i * 10 + 10, color: { saturation: 1.2 }, effects: [{ id: `f${i}`, type: 'film', on: true, p: {} }], ...(i ? { transitionIn: { type: 'fade', dur: 1 } } : {}) }));
    await api('PUT', '/api/project?p=Soak', pj);
    const st = await api('POST', '/api/render?p=Soak', { preset: 'youtube', filename: 'soak' });
    let j; for (let i = 0; i < 2400; i++) { j = await api('GET', `/api/job?id=${st.id}`); if (j.status !== 'running') break; await sleep(500); }
    rec({ k: 'render', ok: j?.status === 'done', s: Math.round((Date.now() - t0) / 1000), err: j?.status === 'done' ? undefined : (j?.log || []).slice(-2).join(' ') });
  } catch (e) { rec({ k: 'render', ok: false, s: Math.round((Date.now() - t0) / 1000), err: e.message }); }
  finally { srv.kill(); await sleep(1500); fs.rmSync(tmp, { recursive: true, force: true }); }
}
function summary() {
  const by = (k) => rows.filter((r) => r.k === k), pct = (l) => (l.length ? Math.round((l.filter((r) => r.ok).length / l.length) * 1000) / 10 : 0);
  const ping = by('ping'), okp = ping.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b), p95 = okp[Math.floor(okp.length * 0.95)] ?? '-';
  const fails = rows.filter((r) => !r.ok).slice(-40).reverse();
  const html = `<!doctype html><meta charset="utf-8"><title>Soak test ${STAMP}</title><style>body{font:14px system-ui;background:#0b0f17;color:#e8f0fa;padding:24px}td,th{padding:4px 10px;text-align:left;border-bottom:1px solid #223}h1{font-size:20px}.bad{color:#ff8a8d}</style>
<h1>Week-long test run - started ${new Date(rows[0]?.t || Date.now()).toLocaleString('en-IN')} on ${os.hostname()}</h1>
<p>Running for ${DAYS} days until ${new Date(until).toLocaleString('en-IN')}. Updated ${new Date().toLocaleString('en-IN')}.</p>
<table><tr><th>Check</th><th>Runs</th><th>Passed</th><th>Note</th></tr>
<tr><td>Live editor answers (every minute)</td><td>${ping.length}</td><td>${pct(ping)} %</td><td>95% answered within ${p95} ms</td></tr>
<tr><td>Auto-tests (every ${EVERY} min)</td><td>${by('tests').length}</td><td>${pct(by('tests'))} %</td><td>${by('tests').at(-1)?.summary || ''}</td></tr>
<tr><td>Real render (every ${EVERY} min)</td><td>${by('render').length}</td><td>${pct(by('render'))} %</td><td>last ${by('render').at(-1)?.s ?? '-'} s</td></tr></table>
<h2>Latest problems</h2>${fails.length ? `<table>${fails.map((r) => `<tr><td>${new Date(r.t).toLocaleString('en-IN')}</td><td class="bad">${r.k}</td><td>${String(r.err || (r.failed || []).join(' | ') || '').replace(/</g, '&lt;')}</td></tr>`).join('')}</table>` : '<p>None.</p>'}`;
  fs.writeFileSync(HTML, html);
}

console.log(`soak test until ${new Date(until).toLocaleString()} - log ${LOG}`);
let nextRound = 0;
while (Date.now() < until) {
  await probe();
  if (Date.now() >= nextRound) { nextRound = Date.now() + EVERY * 60000; tests(); await render(); summary(); }
  await sleep(60000);
}
summary();
console.log(`done - ${HTML}`);
