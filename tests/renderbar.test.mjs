// 🟥🟨🟩 Render bar sections (server: POST /api/render/section, GET /api/render/sections; editor: public/js/renderbar.js):
// with --server a throwaway editor renders one section of a test project - it is listed only once it is complete, under
// its key, and never shows in the renders list. (The editor picking red sections and the monitor playing them is checked
// in a browser by the release smoke test.)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, assert, eq as same } from './harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const hasFF = spawnSync('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true }).status === 0;
const PORT = 3969, B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (m, u, b) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };

test('render bar: a section renders under its key, is listed only when done and stays out of the renders list', async () => {
  if (!ON || !hasFF) return 'skip';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-rb-'));
  const srv = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), TEAM_PORT: '3968', TEAM_WEB_PORT: '3967', TEAM_TLS_PORT: '3966', SHARE_PORT: '3965', FARM_PORT: '3964', VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '0' } });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/version')).ok) break; } catch {} await sleep(500); }
    const vid = path.join(tmp, 'clip.mp4');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=4', '-f', 'lavfi', '-i', 'sine=d=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', vid], { windowsHide: true });
    same((await api('POST', '/api/projects', { name: 'RB' })).status, 200);
    same((await api('POST', '/api/import?p=RB', { files: [vid] })).status, 200);
    let m;
    for (let i = 0; i < 80; i++) { const r = (await api('GET', '/api/media?p=RB')).body; m = (r.items || r)[0]; if (m?.status === 'ready') break; await sleep(250); }
    const pj = (await api('GET', '/api/project?p=RB')).body;
    pj.tracks.V1 = [{ id: 'c1', type: 'video', mediaId: m.id, in: 0, out: 4, effects: [{ id: 'e1', type: 'twirl', on: true, p: {} }] }];
    same((await api('PUT', '/api/project?p=RB', pj)).status, 200);
    same((await api('POST', '/api/render/section?p=RB', { a: 1, b: 3, key: 'BAD KEY' })).status, 400, 'a bad key is refused');
    const st = await api('POST', '/api/render/section?p=RB', { a: 1, b: 3, key: 'testkey001' });
    same(st.status, 200);
    let j;
    for (let i = 0; i < 240; i++) { j = (await api('GET', `/api/job?id=${st.body.id}`)).body; if (j.status !== 'running') break; await sleep(250); }
    same(j.status, 'done', (j.log || []).slice(-3).join(' '));
    same(j.result.url, '/pf/RB/renders/_sec_testkey001.mp4');
    same((await api('GET', '/api/render/sections?p=RB')).body, ['testkey001']);
    const f = path.join(tmp, 'Projects', 'RB', 'renders', '_sec_testkey001.mp4');
    const d = +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout;
    assert(Math.abs(d - 2) < 0.2, `the section's length (${d})`);
    assert(!fs.readdirSync(path.dirname(f)).some((x) => x.startsWith('_secp_')), 'no half-made file left');
    assert(!JSON.stringify((await api('GET', '/api/renders?p=RB')).body).includes('_sec'), 'not in the renders list');
  } finally { srv.kill(); }
});
