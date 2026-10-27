// ⏱ Head-to-head speed test: the same standard tasks, on the same generated media, timed in Limelight Editor here
// (automatically, on a throwaway test editor - no real project is touched) and in Premiere Pro / Final Cut Pro /
// DaVinci Resolve by hand with a stopwatch (tools/bench/HEAD-TO-HEAD.md says how). Writes
// tools/bench/results/head-to-head-<date>.md (+ .json): Limelight's column filled, the others to fill in.
//   node tools/bench/headtohead.mjs            (on any office PC with the editor's code, FFmpeg and Node)
//   node tools/bench/headtohead.mjs --keep     (keep the generated test media in tools/bench/kit for the hand timings)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KIT = path.join(ROOT, 'tools', 'bench', 'kit'), OUT = path.join(ROOT, 'tools', 'bench', 'results');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-h2h-'));
const PORT = 3959, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const ff = (args) => spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { windowsHide: true });
const secs = (ms) => +(ms / 1000).toFixed(1);

// 1. the standard kit (same files for every editor): a 20 s 4K HEVC 10-bit camera-like clip, six 10 s 1080p clips
fs.mkdirSync(KIT, { recursive: true });
const k4 = path.join(KIT, 'A001_4K_HEVC_20s.mp4');
if (!fs.existsSync(k4)) {
  say('making the 4K HEVC test clip (20 s)…');
  const src = ['-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=30:d=20', '-f', 'lavfi', '-i', 'sine=f=440:d=20'];
  let r = ff([...src, '-c:v', 'hevc_nvenc', '-pix_fmt', 'p010le', '-b:v', '60M', '-c:a', 'aac', '-shortest', k4]);
  if (r.status !== 0) r = ff([...src, '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-b:v', '60M', '-c:a', 'aac', '-shortest', k4]);
  if (r.status !== 0) throw new Error(`could not make the 4K clip: ${String(r.stderr).slice(0, 300)}`);
}
const hd = [];
for (let i = 1; i <= 6; i++) {
  const f = path.join(KIT, `B00${i}_1080p_10s.mp4`); hd.push(f);
  if (!fs.existsSync(f)) ff(['-f', 'lavfi', '-i', `${['testsrc2', 'smptehdbars', 'mandelbrot', 'testsrc', 'rgbtestsrc', 'cellauto'][i - 1]}=s=1920x1080:r=25:d=10`, '-f', 'lavfi', '-i', `sine=f=${200 + i * 60}:d=10`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
}

// 2. a throwaway editor (own ports, own data folder)
const srv = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), TEAM_PORT: '3958', TEAM_WEB_PORT: '3957', TEAM_TLS_PORT: '3956', SHARE_PORT: '3955', FARM_PORT: '3954', VEDIT_DATA: path.join(WORK, 'data'), VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '0' } });
let srvLog = ''; srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
const api = async (m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const job = async (id) => { for (;;) { const j = await api('GET', `/api/job?id=${id}`); if (j.status === 'done') return j; if (j.status !== 'running') throw new Error((j.log || []).slice(-3).join(" ") || j.error || 'job failed'); await sleep(250); } };
const items = async (p) => { const m = await api('GET', `/api/media?p=${encodeURIComponent(p)}`); return m.items || m; };
const results = [];
const rec = (task, ms, note = '') => { results.push({ task, seconds: secs(ms), note }); say(`${task}: ${secs(ms)} s ${note}`); };
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/version')).ok) break; } catch {} await sleep(500); }

  // T1 4K HEVC camera clip -> ready to edit (imported, analysed, light preview copy made)
  await api('POST', '/api/projects', { name: 'H2H 4K' });
  let t0 = Date.now();
  await api('POST', `/api/import?p=${encodeURIComponent('H2H 4K')}`, { files: [k4] });
  for (;;) { const it = (await items('H2H 4K'))[0]; if (it?.status === 'ready' && (it.lite === 'ready' || it.proxy === 'none' || it.proxy === 'ready' || Date.now() - t0 > 600000)) break; await sleep(250); }
  rec('Import a 20 s 4K HEVC 10-bit clip until it plays smoothly', Date.now() - t0);

  // the 1080p project: six clips, one after another (60 s)
  await api('POST', '/api/projects', { name: 'H2H HD' });
  t0 = Date.now();
  await api('POST', `/api/import?p=${encodeURIComponent('H2H HD')}`, { files: hd });
  for (;;) { const m = await items('H2H HD'); if (m.length === 6 && m.every((x) => x.status === 'ready')) break; await sleep(250); }
  rec('Import six 10 s 1080p clips until all are ready', Date.now() - t0);
  const media = (await items('H2H HD')).sort((a, b) => a.name.localeCompare(b.name));
  const pj = await api('GET', `/api/project?p=${encodeURIComponent('H2H HD')}`);
  pj.tracks.V1 = media.map((m, i) => ({ id: `c${i}`, type: 'video', mediaId: m.id, in: 0, out: 10 }));
  await api('PUT', `/api/project?p=${encodeURIComponent('H2H HD')}`, pj);

  // T2 export 60 s 1080p H.264 (YouTube preset), plain cuts
  t0 = Date.now();
  let st = await api('POST', `/api/render?p=${encodeURIComponent('H2H HD')}`, { preset: 'youtube', filename: 'h2h-plain' });
  await job(st.id); rec('Export 60 s 1080p H.264, six plain cuts', Date.now() - t0);

  // T3 the same with colour + blur + film look on every shot and cross-dissolves
  pj.tracks.V1 = media.map((m, i) => ({ id: `c${i}`, type: 'video', mediaId: m.id, in: 0, out: 10, color: { exposure: 0.2, saturation: 1.15, contrast: 1.1 },
    effects: [{ id: `b${i}`, type: 'blur', on: true, p: { amount: 6 } }, { id: `f${i}`, type: 'film', on: true, p: {} }], ...(i ? { transitionIn: { type: 'fade', dur: 1 } } : {}) }));
  await api('PUT', `/api/project?p=${encodeURIComponent('H2H HD')}`, pj);
  t0 = Date.now();
  st = await api('POST', `/api/render?p=${encodeURIComponent('H2H HD')}`, { preset: 'youtube', filename: 'h2h-graded' });
  await job(st.id); rec('Export 60 s 1080p with grade, blur, film look and dissolves on every shot', Date.now() - t0);

  // T4 render-bar section: 10 s with a render-only effect (Twirl) rendered for exact playback
  pj.tracks.V1[2].effects = [{ id: 'tw', type: 'twirl', on: true, p: {} }];
  await api('PUT', `/api/project?p=${encodeURIComponent('H2H HD')}`, pj);
  t0 = Date.now();
  st = await api('POST', `/api/render/section?p=${encodeURIComponent('H2H HD')}`, { a: 18, b: 28, key: 'h2hsection01', fast: true });
  await job(st.id); rec('Render a 10 s section with a render-only effect for exact playback', Date.now() - t0);
} catch (e) {
  say('FAILED:', e.message); say(srvLog.slice(-1500));
} finally { srv.kill(); }

// 3. the report
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const pc = `${os.hostname()} · ${os.cpus()[0]?.model?.trim()} · ${Math.round(os.totalmem() / 2 ** 30)} GB RAM`;
fs.writeFileSync(path.join(OUT, `head-to-head-${stamp}.json`), JSON.stringify({ at: new Date().toISOString(), pc, results }, null, 2));
const md = [`# Head-to-head speed test - ${new Date().toLocaleString('en-IN')}`, '', `PC: ${pc}`, '',
  'Limelight Editor: timed automatically (tools/bench/headtohead.mjs). The other columns: timed by hand on the same PC with the',
  'same files (tools/bench/kit), following tools/bench/HEAD-TO-HEAD.md. Seconds; lower is faster.', '',
  '| Task | Limelight Editor | Premiere Pro | Final Cut Pro | DaVinci Resolve |', '|---|---|---|---|---|',
  ...results.map((r) => `| ${r.task} | **${r.seconds} s** |  |  |  |`), ''].join('\n');
fs.writeFileSync(path.join(OUT, `head-to-head-${stamp}.md`), md);
say(`report: ${path.join(OUT, `head-to-head-${stamp}.md`)}`);
if (!process.argv.includes('--keep')) { /* the kit stays for the hand timings; only the work folder goes */ }
fs.rmSync(WORK, { recursive: true, force: true });
process.exit(0);
