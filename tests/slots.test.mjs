// 🚦 turns for the whole editor (only with `node tests/run.mjs --server`): a test editor on a spare port with a throwaway
// data folder. Agent edits get 2 turns at once for the whole editor (not per project worker): a third waits in line and
// gets its turn when one is given back; a turn not renewed is taken back; the turns are for the editor itself only;
// and editors from another PC can no longer stop the editor or change its settings, nor see the farm's token.
import { test, eq as same, assert } from './harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const PORT = 3937, TEAM = 3938, B = `http://127.0.0.1:${PORT}`, T = `http://127.0.0.1:${TEAM}`;
let srv = null, tmp = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(base, m, u, b, headers = {}) {
  const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...headers }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, cookie: (/ve_sess=([^;]*)/.exec(r.headers.get('set-cookie') || '') || [])[0] };
}
const take = (key, wait = 0) => call(B, 'POST', `/api/slot/take?kind=agent&key=${key}&wait=${wait}`);

test('slots: a test editor', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-slots-'));
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TEAM_PORT: String(TEAM), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) { try { if ((await call(B, 'GET', '/api/version')).status === 200) break; } catch {} if (i > 60) throw new Error(`test editor did not start:\n${log.slice(-800)}`); await sleep(500); }
});

test('slots: two agent edits at once for the whole editor, the third waits for a turn given back', async () => {
  if (!ON) return 'skip';
  const a = (await take('w1-1')).body, b = (await take('w2-1')).body;
  assert(a.lease && b.lease, 'two turns');
  const c = (await take('w3-1')).body;
  assert(!c.lease, 'no third turn'); same(c.ahead, 0); same(c.running, 2);
  const d = (await take('w4-1')).body;
  same(d.ahead, 1); // (in line behind the third)
  same((await call(B, 'POST', `/api/slot/free?kind=agent&lease=${a.lease}`)).body.ok, true);
  const c2 = (await take('w3-1', 3000)).body;
  assert(c2.lease, 'the third gets the turn given back');
  same((await take('w4-1')).body.ahead, 0);
  const st = (await call(B, 'GET', '/api/slot')).body;
  same(st.agent.limit, 2); same(st.agent.running, 2);
  for (const l of [b.lease, c2.lease]) await call(B, 'POST', `/api/slot/free?kind=agent&lease=${l}`);
  assert((await take('w4-1')).body.lease, 'free again');
});

test('slots: turns are the editor\'s own; editors from another PC cannot stop it, change settings or see the farm token', async () => {
  if (!ON) return 'skip';
  same((await call(L(), 'PUT', '/api/team', { addUser: { name: 'Ravi', password: 'ravi-pass-1', role: 'editor' } })).status, 200);
  same((await call(B, 'PUT', '/api/team', { on: true })).status, 200);
  const ed = (await call(T, 'POST', '/team/login', { name: 'Ravi', password: 'ravi-pass-1' })).cookie;
  const asEd = (m, u, b) => call(T, m, u, b, { Cookie: ed });
  same((await asEd('POST', '/api/slot/take?kind=agent&key=x&wait=0')).status, 403);
  same((await asEd('POST', '/api/shutdown')).status, 403);
  same((await asEd('PUT', '/api/settings', { stock: {} })).status, 403);
  same((await asEd('PUT', '/api/settings/elevenlabs', { key: 'x' })).status, 403);
  same((await asEd('POST', '/api/archive/scan')).status, 403);
  same((await asEd('PUT', '/api/farm', { on: true })).status, 403);
  const farm = await asEd('GET', '/api/farm');
  same(farm.status, 200); same(farm.body.token, null);
  same((await asEd('GET', '/api/settings')).status, 200); // (looking stays open)
  assert((await call(B, 'GET', '/api/version')).status === 200, 'the editor is still up');
});
const L = () => B;

test('slots: stop the test editor', async () => {
  if (!ON) return 'skip';
  srv?.kill(); await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// with project workers: an agent run in a worker takes its turn from the main process and gives it back when it ends
const CPORT = 3939, C = `http://127.0.0.1:${CPORT}`;
let csrv = null, ctmp = null;
test('slots: with 2 project workers, agent runs take their turn from the main process and give it back', async () => {
  if (!ON) return 'skip';
  ctmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-slots2-'));
  csrv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(CPORT), VEDIT_DATA: ctmp, VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '2', WORKER_BASE: '3970' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; csrv.stdout.on('data', (d) => { log += d; }); csrv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) { if (/worker 2\/2 ready/.test(log) && /worker 1\/2 ready/.test(log)) break; if (i > 120) throw new Error(`workers did not start:\n${log.slice(-1200)}`); await sleep(500); }
  const names = ['Slot A', 'Slot B', 'Slot C', 'Slot D'];
  for (const n of names) same((await call(C, 'POST', '/api/projects', { name: n })).status, 200);
  const ids = [];
  for (const n of names) { const r = await call(C, 'POST', `/api/agent?p=${encodeURIComponent(n)}`, { clips: [] }); assert(r.body?.id, `agent job for ${n}: ${JSON.stringify(r.body).slice(0, 200)}`); ids.push(r.body.id); }
  for (let i = 0; i < 60; i++) { const st = await Promise.all(ids.map(async (id) => (await call(C, 'GET', `/api/job?id=${id}`)).body.status)); if (st.every((s) => s !== 'running')) break; await sleep(500); }
  const slot = (await call(C, 'GET', '/api/slot')).body;
  same(slot.agent.running, 0); // (every turn given back - nothing left holding one)
  const jobs = await Promise.all(ids.map(async (id) => (await call(C, 'GET', `/api/job?id=${id}`)).body));
  assert(ids.every((id) => /^w[12]-/.test(id)), `run in the project workers: ${ids.join(', ')}`);
  assert(new Set(ids.map((id) => id.split('-')[0])).size === 2, 'on both workers');
  assert(jobs.every((j) => j.status !== 'running'), `all ended: ${jobs.map((j) => `${j.status} ${String(j.log?.slice(-1)[0] || '').slice(0, 80)}`).join(' | ')}`);
  assert(jobs.every((j) => !/Stopped before it started/.test(j.log?.join(' '))), 'each got its turn');
  csrv.kill(); await sleep(800);
  try { fs.rmSync(ctmp, { recursive: true, force: true }); } catch {}
});
