// 🖥 a helper PC switched off half way (Phase 25, only with `node tests/run.mjs --server`): a test editor with its farm on
// and two helpers (worker.mjs) on this PC. A 20 s run goes out; the helper that took it is killed. The run must finish on
// the other helper; with no helper left, the answer must come back (null: the caller then does it here) instead of
// hanging - and the slot is freed. The running editor and its farm are never touched (own ports, own data folder).
import { test, eq as same, assert } from './harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
// (the farm port: the first free one from 3932 - another program on this PC once held 3932 and the test could not start)
const freePort = (p) => new Promise((ok) => { const s = net.createServer(); s.once('error', () => ok(freePort(p + 1))); s.listen(p, '0.0.0.0', () => s.close(() => ok(p))); });
const PORT = 3931, FARM = ON ? await freePort(3932) : 3932, B = `http://127.0.0.1:${PORT}`;
let srv = null, tmp = null, token = null;
const helpers = new Map(); // name -> process
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(m, u, b) {
  const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${m} ${u} -> ${r.status} ${String(t).slice(0, 200)}`);
  return j;
}
const kill = (p) => { try { spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch {} try { p.kill('SIGKILL'); } catch {} };
function startHelper(name, lockPort) {
  const t = path.join(tmp, `tmp-${name}`); fs.mkdirSync(t, { recursive: true }); // (its own id file)
  const p = spawn(process.execPath, [path.join(ROOT, 'engine', 'worker.mjs'), `http://127.0.0.1:${FARM}`, token, '--name', name, '--no-pause', '--slots', '1', '--lock-port', String(lockPort), '--code', path.join(tmp, `code-${name}`)],
    { env: { ...process.env, TEMP: t, TMP: t }, stdio: 'ignore', windowsHide: true });
  helpers.set(name, p);
}
const workers = async () => (await api('GET', '/api/farm')).workers;
// a 20 s run (real time) through the helper door, as a project worker sends it
const slowRun = () => fetch(`${B}/api/helper/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ proj: 'Failover', tool: 'ffmpeg', args: ['-hide_banner', '-re', '-f', 'lavfi', '-i', 'testsrc=s=64x64:r=10:d=20', '-f', 'null', '-'], inputs: [], outs: [], lane: 'heavy', tag: 'failover', spread: true, waitSec: 10, limitSec: 120 }) })
  .then(async (r) => { const lines = (await r.text()).trim().split('\n'); return JSON.parse(lines.at(-1)).result; });
async function killTaker() {
  for (let i = 0; i < 100; i++) { const w = (await workers()).find((x) => x.busy > 0); if (w) { await sleep(3000); kill(helpers.get(w.name)); helpers.delete(w.name); return w.name; } await sleep(200); }
  throw new Error('no helper took the run');
}

test('failover: start a test editor with its farm and two helpers', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-failover-'));
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FARM_PORT: String(FARM), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '0' }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) { try { await api('GET', '/api/version'); break; } catch { if (i > 60) throw new Error('test editor did not start'); await sleep(500); } }
  token = (await api('PUT', '/api/farm', { on: true })).token;
  startHelper('HelperA', 3941); startHelper('HelperB', 3942);
  for (let i = 0; i < 120; i++) { if ((await workers()).filter((w) => w.specs).length === 2) return; await sleep(500); }
  throw new Error('the two helpers did not join');
});

test('failover: the helper doing a run is switched off - the run finishes on the other one', async () => {
  if (!ON) return 'skip';
  const t0 = Date.now(), run = slowRun();
  const gone = await killTaker();
  const r = await run;
  assert(r && r.code === 0, `finished on the other helper (got ${JSON.stringify(r)?.slice(0, 120)})`);
  const left = (await workers()).map((w) => w.name);
  assert(!left.includes(gone), `${gone} is no longer listed`);
  assert(Date.now() - t0 < 90000, 'not stuck');
});

test('failover: the last helper goes off half way - the answer comes back (done here instead), nothing hangs', async () => {
  if (!ON) return 'skip';
  const t0 = Date.now(), run = slowRun();
  await killTaker();
  const r = await run;
  same(r, null, 'no helper left: the caller does it here');
  const s = Date.now() - t0;
  assert(s < 50000, `answered in ${Math.round(s / 1000)} s (30 s of silence = gone)`);
  const f = await api('GET', '/api/farm');
  same(f.running, 0, 'its slot is free'); same(f.waiting, 0);
});

test('failover: stop the test editor', async () => {
  if (!ON) return 'skip';
  for (const p of helpers.values()) kill(p);
  if (srv) kill(srv);
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
