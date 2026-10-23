// 🎯 the Program monitor's exact layer (only with `node tests/run.mjs --server`): a second editor on a spare port with a
// throwaway data folder. One clip's frame with an effect the live monitor cannot draw (Twirl, Echo) is made by
// POST /api/frame/layer - the render's own filters on that clip only - quickly enough to follow the playhead.
import { test, eq as same, assert } from './harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const PORT = 3925, B = `http://127.0.0.1:${PORT}`, NAME = 'Exact Test', P = encodeURIComponent(NAME);
let srv = null, tmp = null, clip = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(m, u, b) {
  const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${m} ${u} -> ${r.status} ${t.slice(0, 200)}`);
  return j;
}
async function layer(effects, more = {}) {
  const s = performance.now();
  const r = await fetch(`${B}/api/frame/layer?p=${P}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaId: clip.id, file: 'orig', srcT: 1.2, rel: 1.2, w: 640, h: 360, effects, ...more }) });
  return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()), ms: performance.now() - s };
}

test('exact: start a test editor with one clip', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-exact-'));
  fs.mkdirSync(path.join(tmp, 'shoot'));
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(tmp, 'shoot', 'A.mp4')]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) { try { await api('GET', '/api/version'); break; } catch {} if (i > 60) throw new Error(`test editor did not start:\n${log.slice(-800)}`); await sleep(500); }
  await api('POST', '/api/projects', { name: NAME, folder: path.join(tmp, 'shoot') });
  for (let i = 0; i < 80; i++) { clip = (await api('GET', `/api/media?p=${P}`)).items[0]; if (clip?.status === 'ready') break; await sleep(400); }
  assert(clip?.status === 'ready', 'the clip was read');
});

test('exact: one clip\'s frame with an effect the monitor cannot draw, quickly, also one that looks back in time', async () => {
  if (!ON) return 'skip';
  const plain = await layer([]);
  same(plain.status, 200); same(plain.type, 'image/jpeg'); assert(plain.buf.length > 2000, 'a JPEG');
  const tw = await layer([{ type: 'twirl', p: { angle: 360, radius: 60 } }]);
  same(tw.status, 200); assert(!tw.buf.equals(plain.buf), 'the Twirl shows');
  assert(tw.ms < 2000, `made in ${tw.ms.toFixed(0)} ms`);
  console.log(`     (Twirl frame made in ${tw.ms.toFixed(0)} ms)`);
  const echo = await layer([{ type: 'echo', p: {} }]);
  same(echo.status, 200); assert(!echo.buf.equals(plain.buf), 'Echo (it looks at earlier frames) shows');
  const later = await layer([{ type: 'twirl', p: { angle: 360, radius: 60 }, from: 2, to: 3 }]);
  same(later.status, 200); assert(!later.buf.equals(tw.buf), 'an effect timed for later is not on this frame');
  same((await layer([{ type: 'twirl', p: {} }], { mediaId: 'nope' })).status, 404);
});

test('exact: every effect the monitor cannot draw makes a picture this way', async () => {
  if (!ON) return 'skip';
  const { VFX } = await import('../public/js/effects.js');
  const live = (t) => t === 'mirror' || t === 'chromakey' || VFX[t].css || VFX[t].pix;
  const types = Object.keys(VFX).filter((t) => !live(t) && VFX[t].ff && !VFX[t].key && !VFX[t].py);
  const bad = [], slow = [];
  for (const type of types) {
    const r = await layer([{ type, p: {} }]);
    if (r.status !== 200 || r.buf.length < 1000) bad.push(`${type} (${r.status} ${r.buf.toString().slice(0, 120)})`);
    else if (r.ms > 3000) slow.push(`${type} ${r.ms.toFixed(0)} ms`);
  }
  console.log(`     (${types.length - bad.length} of ${types.length} effects made${slow.length ? `; slow: ${slow.join(', ')}` : ''})`);
  same(bad, []);
});

test('exact: stop the test editor', async () => {
  if (!ON) return 'skip';
  srv?.kill(); await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
