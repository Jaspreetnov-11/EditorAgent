#!/usr/bin/env node
// worker.mjs - 🖥 render farm worker (Phase 16) and helper PC (Phase 23). Runs on another office computer: renders shots
// for the editor, and does the heavy work of the projects the editor gives it (reading new footage: probe, thumbnail,
// filmstrip, waveform; making preview copies) - editing itself stays on the editor.
// Usage: node worker.mjs http://<editor computer>:3200 <token> [--slots 2] [--name "Edit PC 2"]
// Needs Node.js and FFmpeg + FFprobe (on PATH, or --ffmpeg <path>). Nothing is installed: it asks the editor for work.
// Footage the editor's NAS has (Z:\...) is read straight from the NAS when this PC sees the same file there, and the
// result written straight next to it; anything else goes over the network. Its FFmpeg runs at low priority, so a
// person working on this PC is not slowed down.
// Close the window (or Ctrl+C) to stop; whatever it was doing is then done on the editor instead.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// (this file is fetched on its own by each PC - /farm/worker.mjs - so it imports nothing of the editor's)
// the editor's {{INn}} / {{OUTn}} (engine/helpers.mjs toTaskArgs) swapped for where this PC reads / writes each file
const fromTaskArgs = (args, ins, outs) => args.map((a) => String(a).replace(/^\{\{(IN|OUT)(\d+)\}\}$/, (_, k, n) => (k === 'IN' ? ins : outs)[+n]));
// ⚡ a preview copy on a PC with an NVIDIA card: decoded, scaled and encoded on the card (engine/helpers.mjs
// gpuProxyArgs - 5x faster for 4K HEVC camera files, as sharp); a file the card cannot decode is made the usual way
function nvencArgs(args) {
  const i = args.indexOf('-i'), v = args.indexOf('-vf'), c = args.indexOf('libx264');
  if (i < 0 || v < 0 || c < 1 || args[c - 1] !== '-c:v') return null;
  const m = /^scale=-2:(.+),format=yuv420p$/.exec(args[v + 1]);
  if (!m) return null;
  const out = [...args];
  out[v + 1] = `scale_cuda=-2:${m[1]}:format=yuv420p`;
  out[c] = 'h264_nvenc';
  const p = out.indexOf('-preset'); if (p >= 0) out[p + 1] = 'p4';
  // (a capped bitrate: "-cq 19 -b:v 0" made 31-35 Mbit/s 1080p copies - 6x the CPU ones - and every editor streams them from
  // the NAS while scrubbing; no B-frames, so a jump lands on its frame at once)
  const q = out.indexOf('-crf'), lite = q >= 0 && +out[q + 1] >= 24;
  if (q >= 0) out.splice(q, 2, '-rc', 'vbr', '-cq', lite ? '28' : '23', '-b:v', lite ? '2M' : '6M', '-maxrate', lite ? '3M' : '9M', '-bufsize', lite ? '4M' : '12M', '-bf', '0');
  out.splice(i, 0, '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  return out;
}

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const [BASE, TOKEN] = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!BASE || !TOKEN) {
  console.log('Usage: node worker.mjs http://<editor computer>:3200 <token> [--slots 2] [--name "Edit PC 2"]\nThe link and token are in the editor: 👥 Team > 🖥 Render farm.');
  process.exit(1);
}
// one helper per PC: a second one (an old launcher's window and the hidden one, or a double-click) stops at once with
// exit code 4 - the launcher then waits and tries again later, in case the first one is closed meanwhile
await new Promise((ok) => {
  const l = net.createServer();
  l.once('error', () => { console.log(`${new Date().toLocaleTimeString()}  🖥 this PC is already helping the editor (another helper runs here) - this one stops`); process.exit(4); });
  l.listen(+opt('lock-port', 3299), '127.0.0.1', () => { l.unref(); ok(); });
});
const FFMPEG = opt('ffmpeg', 'ffmpeg');
const FFPROBE = opt('ffprobe', FFMPEG === 'ffmpeg' ? 'ffprobe' : path.join(path.dirname(FFMPEG), `ffprobe${path.extname(FFMPEG)}`));
const NAME = opt('name', os.hostname());
const ID_FILE = path.join(os.tmpdir(), 'vedit-worker-id.txt');
let ID = null; try { ID = fs.readFileSync(ID_FILE, 'utf8').trim() || null; } catch {}
const H = { 'x-farm-token': TOKEN };
const url = (p) => new URL(p, BASE).href;
const src = (p) => `${url(p)}?t=${encodeURIComponent(TOKEN)}`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const log = (m) => console.log(`${new Date().toLocaleTimeString()}  ${m}`);
// (every request gives up after a while - an editor that went off or a network that hangs never leaves a slot stuck)
const post = (p, body) => fetch(url(p), { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
// an upload: 2 minutes, plus a second for every 2 MB (about 16 Mbit/s at the least)
const upTime = (bytes) => AbortSignal.timeout(120000 + Math.round(bytes / 2e6) * 1000);

const works = (exe, args) => spawnSync(exe, args, { windowsHide: true, timeout: 20000 }).status === 0;
if (!works(FFMPEG, ['-hide_banner', '-version'])) {
  console.log(`FFmpeg not found (${FFMPEG}). Install it (https://www.gyan.dev/ffmpeg/builds/) or pass --ffmpeg C:\\path\\to\\ffmpeg.exe`);
  process.exit(1);
}
// what this PC is: the editor gives bigger projects to stronger PCs
const NVENC = works(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-']);
const gpu = (() => { const r = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }); return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : ''; })();
// 🎙 Whisper on an NVIDIA card (Python with faster-whisper and CUDA - 'Setup AI on this PC.bat'): this PC transcribes too
// (and PyTorch on the GPU / OpenCV: cutting out the subject, tracking - engine/*.py from the editor's code copy)
const PY = opt('python', ['python', 'py'].find((b) => works(b, ['--version'])) || '');
const PROBE = [
  'import importlib.util as u, json',
  "r = {m: bool(u.find_spec(m)) for m in ('cv2', 'torch', 'torchvision', 'faster_whisper', 'ctranslate2')}",
  "if r['torch']:",
  '    import torch',
  "    r['cuda'] = torch.cuda.is_available()",
  "if r['ctranslate2']:",
  '    import ctranslate2',
  "    r['ct2cuda'] = ctranslate2.get_cuda_device_count() > 0",
  'print(json.dumps(r))',
].join('\n');
const pyHas = (() => { if (!PY) return {}; const r = spawnSync(PY, ['-c', PROBE], { encoding: 'utf8', windowsHide: true, timeout: 120000 }); try { return r.status === 0 ? JSON.parse(r.stdout.trim().split(/\r?\n/).pop()) : {}; } catch { return {}; } })();
const whisper = !!(pyHas.faster_whisper && pyHas.ct2cuda);
const SPECS = { cores: os.cpus().length, cpu: os.cpus()[0]?.model.trim() || '', ramGB: Math.round(os.totalmem() / 2 ** 30), gpu, nvenc: NVENC, ffprobe: works(FFPROBE, ['-hide_banner', '-version']), render: false, whisper,
  torch: !!(pyHas.torch && pyHas.torchvision && pyHas.cuda && pyHas.cv2), cv2: !!pyHas.cv2 };
const AI = whisper || SPECS.torch;

// 🖥 when this PC's own user is busy on it (the CPU above 80% while it runs nothing for the editor), it stops taking work
// until the PC is quiet again; the editor gives its projects to other PCs meanwhile. --no-pause: a PC only for helping.
const NOPAUSE = argv.includes('--no-pause');
let mine = 0, load = 0, paused = false, hot = 0, cool = 0;
const cpuNow = () => { let idle = 0, total = 0; for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; } return { idle, total }; };
let cpuPrev = cpuNow();
setInterval(() => {
  const n = cpuNow(), d = n.total - cpuPrev.total;
  load = d > 0 ? Math.round(100 * (1 - (n.idle - cpuPrev.idle) / d)) : 0; cpuPrev = n;
  if (NOPAUSE) return;
  if (load > 80 && !mine) { cool = 0; if (++hot >= 2 && !paused) { paused = true; log('⏸ this PC is busy with its own work - helping again when it is quiet'); hello().catch(() => {}); } }
  else if (load < 50) { hot = 0; if (paused && ++cool >= 3) { paused = false; log('▶ quiet again - helping'); hello().catch(() => {}); } }
  else hot = 0;
}, 5000).unref();
// 🔄 the editor runs a newer worker.mjs: once nothing is running, stop - the launcher fetches the new one and starts it
const MYV = crypto.createHash('sha1').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 12);
let stale = false;
const quitIfStale = () => { if (stale && !mine) { log('a newer helper is out - restarting to fetch it'); process.exit(3); } };
const SLOTS = Math.max(1, Math.min(8, +opt('slots', Math.max(1, Math.floor(SPECS.cores / 6)) + (NVENC ? 1 : 0)) || 1));
const LIGHT = 2; // reading new footage: short runs, kept apart from the long ones so a new file's thumbnail never waits on a preview copy

// 🖥 a copy of the editor's code (its render engine, transcriber and LUTs), kept in step with the editor: only files
// that changed are fetched. A whole render or a transcription runs from here.
const CODE = opt('code', path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'LimelightWorker', 'code'));
let codeSync = null;
function syncCode() {
  codeSync ||= (async () => {
    try {
      const r = await fetch(url('/farm/code'), { headers: H, signal: AbortSignal.timeout(30000) });
      if (!r.ok) return false;
      const { files } = await r.json(), mf = path.join(CODE, '.manifest.json');
      let had = {}; try { had = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch {}
      fs.mkdirSync(CODE, { recursive: true });
      fs.writeFileSync(path.join(CODE, 'package.json'), '{ "type": "module" }\n'); // (public/js are ES modules, as in the editor)
      let n = 0;
      for (const x of files) {
        const to = path.join(CODE, ...x.rel.split('/'));
        if (had[x.rel] === `${x.size}:${x.mtime}` && fs.existsSync(to)) continue;
        const g = await fetch(url(`/farm/code/${x.rel.split('/').map(encodeURIComponent).join('/')}`), { headers: H, signal: AbortSignal.timeout(120000) });
        if (!g.ok) throw new Error(`${x.rel}: HTTP ${g.status}`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(`${to}.part`, Buffer.from(await g.arrayBuffer())); fs.renameSync(`${to}.part`, to);
        had[x.rel] = `${x.size}:${x.mtime}`; n++;
      }
      fs.writeFileSync(mf, JSON.stringify(had));
      if (n) log(`editor's code: ${n} file${n > 1 ? 's' : ''} updated`);
      return true;
    } catch (e) { log(`could not copy the editor's code (${e.message}) - whole renders and transcribing stay on the editor`); return false; }
    finally { setTimeout(() => { codeSync = null; }, 30000); } // (asked again at most every 30 s)
  })();
  return codeSync;
}
// lines of a long run sent to the editor once a second; its answer says when to stop (stopped there, or done there meanwhile)
function reporter(id, kill) {
  let buf = [], timer = null;
  const flush = async () => {
    timer = null; const lines = buf; buf = [];
    try { const r = await post(`/farm/progress/${id}`, { lines }); if ((await r.json().catch(() => ({}))).stop) kill(); } catch {}
  };
  return { line: (l) => { if (!l.trim()) return; buf.push(l.slice(0, 500)); if (buf.length > 150) buf.splice(0, buf.length - 150); timer ||= setTimeout(flush, 1000); }, flush };
}

async function hello() {
  const r = await post('/farm/hello', { id: ID, name: NAME, slots: SLOTS, light: LIGHT, specs: SPECS, load, paused });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  if (j.v && j.v !== MYV) { stale = true; quitIfStale(); }
  ID = j.id; try { fs.writeFileSync(ID_FILE, ID); } catch {}
}

// a run at low priority (this PC's own user comes first); resolves { code, stdout, stderr }
// (o.both: stderr lines to onLine too; o.started(p): the process, to stop it)
function exec(exe, args, cwd, onLine, o = {}) {
  return new Promise((ok) => {
    const p = spawn(exe, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} // (what it starts runs at that priority too)
    o.started?.(p);
    mine++; p.on('close', () => { mine--; quitIfStale(); });
    let out = '', err = '', part = '', epart = '';
    if (o.both && onLine) p.stderr.on('data', (d) => { const ls = (epart + d).split(/\r\n|\r|\n/); epart = ls.pop(); ls.forEach(onLine); });
    p.stdout.on('data', (d) => {
      if (out.length < 2e6) out += d;
      if (onLine) { const ls = (part + d).split(/\r?\n/); part = ls.pop(); ls.forEach(onLine); }
    });
    // (o.fullErr: all of it, up to 8 MB - the Agent's clip analysis reads every line FFmpeg prints)
    p.stderr.on('data', (d) => { err = o.fullErr ? (err.length < 8e6 ? err + d : err) : (err + d).slice(-4000); });
    p.on('error', (e) => ok({ code: -1, stdout: out, stderr: String(e) }));
    p.on('close', (code) => ok({ code, stdout: out, stderr: err }));
  });
}

async function doTask(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfarm-')), out = path.join(dir, 'shot.mp4');
  const t0 = Date.now();
  try {
    if (t.graph) fs.writeFileSync(path.join(dir, 'graph.txt'), t.graph, 'utf8');
    const args = t.args.map((a) => (a === '{{GRAPH}}' ? 'graph.txt' : a.replace(/^\{\{IN(\d+)\}\}$/, (_, n) => src(t.inputs[+n]))));
    const r = await exec(FFMPEG, ['-hide_banner', '-y', '-loglevel', 'error', ...args, out], dir);
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `ffmpeg exit ${r.code}`);
    const size = fs.statSync(out).size;
    const up = await fetch(url(`/farm/result/${t.id}`), { method: 'PUT', headers: { ...H, 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: fs.createReadStream(out), duplex: 'half', signal: upTime(size) });
    if (!up.ok) throw new Error((await up.json().catch(() => ({}))).error || `upload HTTP ${up.status}`);
    log(`✓ ${t.label} (${((Date.now() - t0) / 1000).toFixed(1)}s, ${(size / 1048576).toFixed(1)} MB)`);
  } catch (e) {
    log(`✗ ${t.label}: ${e.message}`);
    await post(`/farm/fail/${t.id}`, { error: `${NAME}: ${e.message}` }).catch(() => {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// 🖥 a project's FFmpeg / FFprobe run. An input this PC sees at the same place with the same size (the NAS) is read from
// there, else from the editor; when every input was local and the output's folder is here too, the output is written
// next to where it belongs (the editor renames it into place), else it is sent back.
const REMOTE = argv.includes('--remote'); // (everything over the network - to try a PC without the NAS)
const VERBOSE = argv.includes('--verbose'); // (every run in the window, not only the preview copies)
const same = (f) => { if (REMOTE) return false; try { return fs.statSync(f.path).size === f.size; } catch { return false; } };
async function doTool(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhelp-')), t0 = Date.now();
  let outs = [];
  try {
    const local = t.ins.map(same), allLocal = local.every(Boolean);
    const ins = t.ins.map((f, n) => (local[n] ? f.path : src(f.url)));
    const suffix = `.h${crypto.randomBytes(3).toString('hex')}`;
    outs = t.outs.map((o, n) => {
      const ext = path.extname(o.path);
      const direct = allLocal && fs.existsSync(path.dirname(o.path));
      return { ...o, direct, file: direct ? `${o.path}${suffix}${ext}` : path.join(dir, `out${n}${ext}`) };
    });
    let args = fromTaskArgs(t.args, ins, outs.map((o) => o.file));
    // 🎙 transcribing: the editor's transcriber from this PC's copy of its code, its lines shown in the editor's job
    const ai = t.tool === 'transcribe' || t.tool === 'py';
    const script = t.tool === 'py' ? String(t.args[0] || '') : null;
    if (script !== null && !/^[a-z0-9_]+\.py$/.test(script)) throw new Error(`not one of the editor's tools: ${script}`);
    if (script) args = args.slice(1);
    if (ai && !(await syncCode())) throw new Error('no copy of the editor\'s code');
    let proc = null, last = 0;
    const rep = ai ? reporter(t.id, () => proc?.kill()) : null;
    const onLine = ai ? rep.line : t.tag === 'proxy' ? (l) => { if (/^out_time_ms=/.test(l) && Date.now() - last > 2000) { last = Date.now(); post(`/farm/progress/${t.id}`, { line: l }).catch(() => {}); } } : null;
    const exe = ai ? PY : t.tool === 'ffprobe' ? FFPROBE : FFMPEG;
    if (ai) args = [path.join(CODE, 'engine', script || 'transcribe.py'), ...args];
    const o = { both: ai, fullErr: !!t.fullErr, started: (p) => { proc = p; } };
    let r = null;
    const hw = t.tag === 'proxy' && NVENC ? nvencArgs(args) : null;
    if (hw) { r = await exec(exe, hw, dir, onLine, o); if (r.code !== 0) for (const x of outs) fs.rmSync(x.file, { force: true }); }
    if (!r || r.code !== 0) r = await exec(exe, args, dir, onLine, o);
    await rep?.flush();
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `${t.tool} exit ${r.code}`);
    for (const [n, o] of outs.entries()) {
      if (o.direct || !fs.existsSync(o.file)) continue;
      const size = fs.statSync(o.file).size;
      const up = await fetch(url(o.url), { method: 'PUT', headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }, body: fs.createReadStream(o.file), duplex: 'half', signal: upTime(size) });
      if (!up.ok) throw new Error((await up.json().catch(() => ({}))).error || `upload ${n} HTTP ${up.status}`);
    }
    const direct = Object.fromEntries(outs.map((o, n) => [n, o.direct && fs.existsSync(o.file) ? `${suffix}${path.extname(o.path)}` : null]));
    const d = await post(`/farm/done/${t.id}`, { stdout: r.stdout, stderr: t.fullErr ? r.stderr : r.stderr.slice(-2000), direct });
    if (!d.ok) throw new Error((await d.json().catch(() => ({}))).error || `HTTP ${d.status}`);
    if (t.tag === 'proxy' || ai || VERBOSE) log(`✓ ${t.label}${hw ? ' (NVIDIA)' : ''}${allLocal ? ' (read directly)' : ' (over the network)'} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    log(`✗ ${t.label}: ${e.message}`);
    for (const o of outs) if (o.direct) fs.rmSync(o.file, { force: true }); // (nothing half-made left next to the project's files)
    await post(`/farm/fail/${t.id}`, { error: `${NAME}: ${e.message}` }).catch(() => {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// 🖥 a whole render from the editor's render queue: only when this PC sees every file it needs where the editor has it
// (the footage on the NAS, the project's folder); the render engine from this PC's copy of the editor's code writes the
// finished file straight into the project's renders folder. Its lines go to the editor's queue as it renders.
async function doRender(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrender-')), t0 = Date.now();
  try {
    if (!(await syncCode())) throw new Error('no copy of the editor\'s code');
    if (REMOTE) throw new Error('this PC reads everything over the network (--remote)');
    for (const f of t.need) { let size = null; try { size = fs.statSync(f.path).size; } catch { throw new Error(`cannot see ${f.path}`); } if (f.size != null && size !== f.size) throw new Error(`${f.path} is not the same file here`); }
    for (const d of t.dirs) if (!fs.existsSync(d)) throw new Error(`cannot see ${d}`);
    const job = { ...t.job, luts: Object.fromEntries(Object.entries(t.job.luts || {}).map(([n, f]) => [n, f.startsWith('@code/') ? path.join(CODE, ...f.slice(6).split('/')) : f])) };
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
    log(`▶ render ${t.label}`);
    let proc = null;
    const rep = reporter(t.id, () => { if (proc) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }); });
    const r = await exec(process.execPath, [path.join(CODE, 'engine', 'render2.mjs'), path.join(dir, 'job.json')], CODE, rep.line, { both: true, started: (p) => { proc = p; } });
    await rep.flush();
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').filter((l) => /render:|error|failed/i.test(l)).pop() || `render exit ${r.code}`);
    const d = await post(`/farm/done/${t.id}`, {});
    if (!d.ok) throw new Error((await d.json().catch(() => ({}))).error || `HTTP ${d.status}`);
    log(`✓ render ${t.label} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  } catch (e) {
    log(`✗ render ${t.label}: ${e.message}`);
    await post(`/farm/fail/${t.id}`, { error: `${NAME}: ${e.message}` }).catch(() => {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// one slot: ask for work (the editor holds the request up to 25s), do it, ask again
async function slot(lane) {
  for (;;) {
    if (paused || stale) { await sleep(5000); continue; }
    try {
      const r = await fetch(`${url('/farm/next')}?w=${encodeURIComponent(ID)}&lane=${lane}`, { headers: H, signal: AbortSignal.timeout(45000) }); // (the editor holds it up to 25 s)
      if (r.status === 204) continue;
      if (r.status === 409) { await hello(); continue; }      // the editor restarted: introduce ourselves again
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const t = await r.json();
      await (t.kind === 'tool' ? doTool(t) : t.kind === 'render' ? doRender(t) : doTask(t));
    } catch (e) { log(`editor not reachable (${e.message}) - trying again in 5s`); await sleep(5000); }
  }
}

for (;;) {
  try { SPECS.render = await syncCode(); await hello(); break; } catch (e) { log(`cannot reach the editor at ${BASE}: ${e.message} - trying again in 5s`); await sleep(5000); }
}
log(`🖥 ${NAME} is helping the editor at ${BASE}: ${SPECS.cores} cores, ${SPECS.ramGB} GB${gpu ? `, ${gpu}${NVENC ? ' (NVIDIA encoder)' : ''}` : ''} - ${SLOTS} long job${SLOTS > 1 ? 's' : ''} + ${LIGHT} short ones at a time${SPECS.render ? ', whole renders' : ''}${whisper ? ', transcribing (Whisper on the GPU)' : ''}${SPECS.torch ? ', AI cut-outs (GPU)' : ''}${SPECS.cv2 ? ', tracking' : ''}. Keep this window open.`);
if (!SPECS.ffprobe) log(`⚠ FFprobe not found (${FFPROBE}) - new footage is read on the editor instead`);
// stay known to the editor even while idle (each wait for work counts too)
setInterval(() => hello().catch(() => {}), 10000);
await Promise.all([...Array.from({ length: SLOTS }, () => slot('heavy')), ...Array.from({ length: LIGHT }, () => slot('light')),
  ...(SPECS.render ? [slot('render')] : []), ...(AI ? [slot('ai')] : [])]);
