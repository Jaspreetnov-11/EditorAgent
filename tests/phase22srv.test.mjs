// Phase 22 end to end, on a second editor (own port, own throwaway data folder - like server.test.mjs; only with
// `node tests/run.mjs --server`): 🧪 QC of the edit, ▱ planar tracking, 📦 archive scan + search, 🧬 voice set-up state.
import { test, assert } from './harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ON = process.env.VEDIT_TEST_SERVER === '1';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3918, B = `http://127.0.0.1:${PORT}`, NAME = 'Phase 22 Test', P = encodeURIComponent(NAME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body) {
  const r = await fetch(B + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `${r.status}`);
  return j;
}
async function job(j, ms = 240000) {
  for (let t = 0; t < ms; t += 500) { const x = await api('GET', `/api/job?id=${j.id}`); if (x.status !== 'running') { if (x.status !== 'done') throw new Error(x.log.slice(-1)[0] || x.status); return x.result; } await sleep(500); }
  throw new Error('job did not finish');
}
const ff = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status !== 0) throw new Error(String(r.stderr)); };
let srv, tmp, media = [];

test('phase 22: start a test editor with a moving surface and a flashing clip', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-p22-'));
  const shoot = path.join(tmp, 'shoot');
  fs.mkdirSync(shoot, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720', '-frames:v', '1', path.join(tmp, 'tex.png')]);
  // a textured card moving in perspective over a noisy background (the planar tracker's test)
  ff(['-f', 'lavfi', '-i', 'cellauto=s=1280x720:r=25:rule=110,format=gray,format=yuv420p', '-loop', '1', '-framerate', '25', '-i', path.join(tmp, 'tex.png'), '-f', 'lavfi', '-i', 'sine=f=440:d=3',
    '-filter_complex', "[1:v]format=yuva444p,scale=1276:716,pad=1280:720:2:2:color=black@0,perspective=sense=destination:eval=frame:x0='300+in*3':y0='150+in*1':x1='800+in*2':y1='180':x2='320+in*3':y2='560-in*0.5':x3='820+in*2.5':y3='520'[p];[0:v][p]overlay=format=auto:shortest=1,format=yuv420p[o]",
    '-map', '[o]', '-map', '2:a', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', path.join(shoot, 'Surface.mp4')]);
  ff(['-f', 'lavfi', '-i', "color=black:s=640x360:r=25:d=2", '-f', 'lavfi', '-i', 'color=white:s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'sine=f=660:d=2',
    '-filter_complex', "[0][1]blend=all_expr='if(lt(mod(T,0.2),0.1),A,B)',format=yuv420p[v]", '-map', '[v]', '-map', '2:a', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', path.join(shoot, 'Flash.mp4')]);
  srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 60; i++) { try { await api('GET', '/api/version'); break; } catch { await sleep(500); } if (i === 59) throw new Error(`test editor did not start:\n${log.slice(-800)}`); }
  await api('POST', '/api/projects', { name: NAME, folder: shoot });
  for (let i = 0; i < 120; i++) { media = (await api("GET", `/api/media?p=${P}`)).items; if (media.length === 2 && media.every((m) => m.status === 'ready')) return; await sleep(500); }
  throw new Error('media not ready');
});

test('phase 22: 🧪 QC of the edit finds the flashing and the loudness for TV', async () => {
  if (!ON) return 'skip';
  const F = media.find((m) => m.name === 'Flash.mp4'), S = media.find((m) => m.name === 'Surface.mp4');
  const pj = await api('GET', `/api/project?p=${P}`);
  pj.tracks.V1 = [{ id: 'a', type: 'video', mediaId: S.id, in: 0, out: 3 }, { id: 'b', type: 'video', mediaId: F.id, in: 0, out: 2 }];
  pj.tracks.V2 = [{ id: 't', type: 'title', start: 0.5, dur: 2, text: 'Chattisgarh mein swagat' }];
  const rep = await job(await api('POST', `/api/qc?p=${P}`, { project: pj, target: 'broadcast', spell: false }));
  assert(rep.items.some((i) => i.kind === 'flash' && i.level === 'fail' && i.t >= 2.5), `flashing in the 2nd shot: ${JSON.stringify(rep.items.map((i) => i.text))}`);
  assert(rep.items.some((i) => i.kind === 'loud'), 'loudness checked');
  assert(rep.preview && rep.dur > 4, 'checked on a preview of the whole edit');
});

test('phase 22: ▱ planar tracking follows the moving card (both ways from the drawn frame)', async () => {
  if (!ON) return 'skip';
  const S = media.find((m) => m.name === 'Surface.mp4'), i = 25, W = 1280, H = 720;
  const gt = (i) => [300 + i * 3, 150 + i, 800 + i * 2, 180, 320 + i * 3, 560 - i * 0.5, 820 + i * 2.5, 520];
  const quad = gt(i).map((v, k) => v / (k % 2 ? H : W));
  const r = await job(await api('POST', `/api/planar?p=${P}`, { mediaId: S.id, ts: 0, t0: i / 25, te: 3, quad }));
  assert(r.points.length > 20 && r.points[0].t < 0.2 && r.points.at(-1).t > 2.7, 'tracked from the start to the end');
  let worst = 0;
  for (const p of r.points) { const g = gt(Math.round(p.t * 25)); worst = Math.max(worst, ...p.q.map((v, k) => Math.abs(v * (k % 2 ? H : W) - g[k]))); }
  assert(worst < 15, `corners within 15 px (worst ${worst.toFixed(1)})`); // (read from the preview copy - a smaller picture)
});

test('phase 22: 📦 archive - folders, scan, search by what the picture shows', async () => {
  if (!ON) return 'skip';
  const h = await api('GET', '/api/health').catch(() => ({}));
  if (!h.clip) return 'skip'; // (the picture model is not installed)
  await api('POST', '/api/archive/roots', { roots: [path.join(tmp, 'shoot')] });
  const s = await job(await api('POST', '/api/archive/scan', {}), 600000);
  assert(s.total === 2, `both files looked at (${JSON.stringify(s)})`);
  const r = await api('POST', '/api/archive/search', { q: 'colour bars test pattern', top: 5 });
  assert(r.results.length && r.results[0].path.endsWith('.mp4') && r.results[0].thumb, 'found with a thumbnail');
  const again = await job(await api('POST', '/api/archive/scan', {}), 120000);
  assert(again.looked === 0, 'nothing is looked at twice');
});

test('phase 22: 🧬 same-voice state answers', async () => {
  if (!ON) return 'skip';
  const v = await api('GET', '/api/aivoice');
  assert(typeof v.ready === 'boolean');
  if (!v.ready) return 'skip';
  // the dub in "the speaker's own voice": two Hindi lines fitted into their times, a new audio clip in the pool
  const S = media.find((m) => m.name === 'Surface.mp4');
  const r = await job(await api('POST', `/api/dub?p=${P}`, { provider: 'clone', lang: 'hi', mediaId: S.id, lines: [{ start: 0, end: 1.4, text: 'नमस्ते दोस्तों' }, { start: 1.5, end: 2.9, text: 'आपका स्वागत है' }] }), 600000);
  assert(r.lines === 2 && r.mediaId, JSON.stringify(r));
  const all = (await api('GET', `/api/media?p=${P}`)).items;
  assert(all.some((m) => m.id === r.mediaId && m.kind === 'audio'), 'the dub is in the media pool');
});

test('phase 22: stop the test editor and remove its folder', async () => {
  if (!ON) return 'skip';
  srv?.kill(); await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
