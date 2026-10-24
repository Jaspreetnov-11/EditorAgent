// 👥 Team sign-in from another PC (Phase 25, only with `node tests/run.mjs --server`): a second editor on spare ports
// with a throwaway data folder (VEDIT_DATA) - the running editor, its team and its config are never touched. The owner
// adds an editor and a viewer on the editor's own port, then the team door (TEAM_PORT) is used as another computer:
// wrong password, signed in, what each role may do, signing out, and a removed person losing access at once.
import { test, eq as same, assert } from './harness.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const PORT = 3919, TEAM = 3918, L = `http://127.0.0.1:${PORT}`, T = `http://127.0.0.1:${TEAM}`;
let srv = null, tmp = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// (the team door answers with a cookie; each "PC" here is just the cookie it holds)
async function call(base, m, u, b, cookie) {
  const r = await fetch(base + u, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, cookie: (/ve_sess=([^;]*)/.exec(r.headers.get('set-cookie') || '') || [])[0] };
}
const login = (name, password) => call(T, 'POST', '/team/login', { name, password });

test('team: start a test editor with its own team door', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-team-'));
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TEAM_PORT: String(TEAM), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 60; i++) { try { if ((await call(L, 'GET', '/api/version')).status === 200) break; } catch {} await sleep(500); if (i === 59) throw new Error(`test editor did not start:\n${log.slice(-800)}`); }
  for (const u of [{ name: 'Ravi', password: 'ravi-pass-1', role: 'editor' }, { name: 'Client', password: 'client-pass-1', role: 'viewer' }, { name: 'Sita', password: 'sita-pass-1', role: 'editor' }]) {
    const r = await call(L, 'PUT', '/api/team', { addUser: u });
    same(r.status, 200);
  }
  const on = await call(L, 'PUT', '/api/team', { on: true });
  same(on.status, 200); assert(on.body.on, 'team door is open');
  same(on.body.users.map((x) => x.name).sort(), ['Client', 'Ravi', 'Sita']);
  assert(!JSON.stringify(on.body).includes('hash'), 'no password hashes in the answer');
});

test('team: not signed in - the sign-in page, and the API says "Sign in again"', async () => {
  if (!ON) return 'skip';
  const page = await call(T, 'GET', '/');
  same(page.status, 200); assert(/<form|password/i.test(page.body), 'the sign-in page');
  const api = await call(T, 'GET', '/api/projects');
  same(api.status, 401); same(api.body.error, 'Sign in again');
});

test('team: a wrong password is refused, the right one signs in (name in any case)', async () => {
  if (!ON) return 'skip';
  const bad = await login('Ravi', 'nope');
  same(bad.status, 401); assert(!bad.cookie, 'no cookie for a wrong password');
  const nobody = await login('Nobody', 'ravi-pass-1');
  same(nobody.status, 401);
  const ok = await login('  ravi ', 'ravi-pass-1');
  same(ok.status, 200); same(ok.body.name, 'Ravi'); same(ok.body.role, 'editor'); assert(ok.cookie, 'a session cookie');
  const me = await call(T, 'GET', '/api/me', undefined, ok.cookie);
  same(me.status, 200); same(me.body.name, 'Ravi'); same(me.body.local, false);
});

test('team: an editor may edit but not run the team; a viewer only watches', async () => {
  if (!ON) return 'skip';
  const ed = (await login('Ravi', 'ravi-pass-1')).cookie, vw = (await login('Client', 'client-pass-1')).cookie;
  same((await call(T, 'GET', '/api/projects', undefined, ed)).status, 200);
  const mk = await call(T, 'POST', '/api/projects', { name: 'Team Test' }, ed);
  assert(mk.status === 200, `editor makes a project: ${mk.status} ${JSON.stringify(mk.body).slice(0, 200)}`);
  const team = await call(T, 'PUT', '/api/team', { addUser: { name: 'Sneaky', password: 'sneaky-pass', role: 'owner' } }, ed);
  same(team.status, 403);
  same((await call(T, 'GET', '/api/projects', undefined, vw)).status, 200);
  const vmk = await call(T, 'POST', '/api/projects', { name: 'Viewer Project' }, vw);
  same(vmk.status, 403); assert(/viewer/i.test(vmk.body.error), 'says why');
});

test('projects: each editor sees only their own; the owner sees all; a share lets another one in', async () => {
  if (!ON) return 'skip';
  const ravi = (await login('Ravi', 'ravi-pass-1')).cookie, sita = (await login('Sita', 'sita-pass-1')).cookie, vw = (await login('Client', 'client-pass-1')).cookie;
  const p = encodeURIComponent('Team Test'), names = async (c) => (await call(T, 'GET', '/api/projects', undefined, c)).body.map((x) => x.name);
  assert((await names(ravi)).includes('Team Test'), 'its maker sees it');
  const mine = (await call(T, 'GET', '/api/projects', undefined, ravi)).body.find((x) => x.name === 'Team Test');
  same(mine.by, 'Ravi');
  assert(!(await names(sita)).includes('Team Test'), 'another editor does not');
  assert(!(await names(vw)).includes('Team Test'), 'nor a viewer');
  same((await call(T, 'GET', `/api/project?p=${p}`, undefined, sita)).status, 404, 'nor by its link');
  same((await call(T, 'GET', `/api/media?p=${p}`, undefined, sita)).status, 404);
  assert((await call(L, 'GET', '/api/projects')).body.some((x) => x.name === 'Team Test'), 'the owner (this computer) sees every project');
  // only its maker (or the owner) shares it
  same((await call(T, 'POST', `/api/projects/share?p=${p}`, { shared: ['Sita'] }, sita)).status, 404, 'Sita cannot even reach it');
  const sh = await call(T, 'POST', `/api/projects/share?p=${p}`, { shared: ['Sita', 'Nobody'] }, ravi);
  same(sh.status, 200); same(sh.body.shared, ['Sita'], 'unknown names are dropped');
  assert((await names(sita)).includes('Team Test'), 'shared: Sita sees it');
  same((await call(T, 'GET', `/api/project?p=${p}`, undefined, sita)).status, 200, 'and opens it');
  same((await call(T, 'POST', `/api/projects/share?p=${p}`, { shared: [] }, sita)).status, 403, 'but cannot change who it is shared with');
  same((await call(T, 'POST', `/api/projects/share?p=${p}`, { shared: [] }, ravi)).status, 200);
  assert(!(await names(sita)).includes('Team Test'), 'unshared: gone again');
  same((await call(T, 'GET', `/api/project?p=${p}`, undefined, sita)).status, 404);
});

test('publish: an account that is not connected is refused at once (not queued to fail later)', async () => {
  if (!ON) return 'skip';
  const ed = (await login('Ravi', 'ravi-pass-1')).cookie;
  const dir = path.join(tmp, 'Projects', 'Team Test', 'renders');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'final.mp4'), 'x');
  const p = encodeURIComponent('Team Test');
  for (const [platform, word] of [['youtube', 'YouTube'], ['facebook', 'Facebook'], ['instagram', 'Instagram']]) {
    const r = await call(T, 'POST', `/api/publish?p=${p}`, { render: 'final.mp4', title: 'Test', targets: [{ platform, pageId: 'nope' }] }, ed);
    same(r.status, 400); assert(r.body.error.includes(word) && /not connected/.test(r.body.error), r.body.error);
  }
  same((await call(T, 'GET', `/api/publish/list?p=${p}`, undefined, ed)).body, []);
  const acc = await call(T, 'GET', '/api/publish/accounts', undefined, ed);
  same(acc.body.youtube.connected, false); assert(!JSON.stringify(acc.body).includes('Secret'), 'no secrets');
});

test('team: signing out ends that PC\'s session only', async () => {
  if (!ON) return 'skip';
  const a = (await login('Ravi', 'ravi-pass-1')).cookie, b = (await login('Ravi', 'ravi-pass-1')).cookie;
  const out = await call(T, 'GET', '/team/logout', undefined, a);
  same(out.status, 302);
  same((await call(T, 'GET', '/api/me', undefined, a)).status, 401);
  same((await call(T, 'GET', '/api/me', undefined, b)).status, 200);
});

test('team: a person removed by the owner loses access at once', async () => {
  if (!ON) return 'skip';
  const c = (await login('Client', 'client-pass-1')).cookie;
  same((await call(T, 'GET', '/api/me', undefined, c)).status, 200);
  same((await call(L, 'PUT', '/api/team', { removeUser: 'Client' })).status, 200);
  same((await call(T, 'GET', '/api/me', undefined, c)).status, 401);
  same((await login('Client', 'client-pass-1')).status, 401);
});

test('team: stop the test editor', async () => {
  if (!ON) return 'skip';
  srv?.kill();
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
