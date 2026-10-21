#!/usr/bin/env node
// worker.mjs - 🖥 render farm worker (Phase 16). Runs on another office computer and renders shots for the editor.
// Usage: node worker.mjs http://<editor computer>:3200 <token> [--slots 2] [--name "Edit PC 2"]
// Needs Node.js and FFmpeg (on PATH, or --ffmpeg <path>). Nothing is installed: it asks the editor for a shot, reads
// that shot's footage from the editor over the network, renders it with FFmpeg here and sends the piece back.
// Close the window (or Ctrl+C) to stop; a shot it was rendering is then rendered on the editor instead.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const [BASE, TOKEN] = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!BASE || !TOKEN) {
  console.log('Usage: node worker.mjs http://<editor computer>:3200 <token> [--slots 2] [--name "Edit PC 2"]\nThe link and token are in the editor: 👥 Team > 🖥 Render farm.');
  process.exit(1);
}
const FFMPEG = opt('ffmpeg', 'ffmpeg');
const SLOTS = Math.max(1, Math.min(8, +opt('slots', Math.max(1, Math.floor(os.cpus().length / 6))) || 1));
const NAME = opt('name', os.hostname());
const ID_FILE = path.join(os.tmpdir(), 'vedit-worker-id.txt');
let ID = null; try { ID = fs.readFileSync(ID_FILE, 'utf8').trim() || null; } catch {}
const H = { 'x-farm-token': TOKEN };
const url = (p) => new URL(p, BASE).href;
const src = (p) => `${url(p)}?t=${encodeURIComponent(TOKEN)}`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const log = (m) => console.log(`${new Date().toLocaleTimeString()}  ${m}`);

if (spawnSync(FFMPEG, ['-hide_banner', '-version'], { windowsHide: true }).status !== 0) {
  console.log(`FFmpeg not found (${FFMPEG}). Install it (https://www.gyan.dev/ffmpeg/builds/) or pass --ffmpeg C:\\path\\to\\ffmpeg.exe`);
  process.exit(1);
}

async function hello() {
  const r = await fetch(url('/farm/hello'), { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ID, name: NAME, slots: SLOTS }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  ID = j.id; try { fs.writeFileSync(ID_FILE, ID); } catch {}
}

function ff(args, cwd) {
  return new Promise((ok, bad) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-y', '-loglevel', 'error', ...args], { cwd, windowsHide: true });
    let err = ''; p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', bad);
    p.on('close', (c) => (c === 0 ? ok() : bad(new Error(err.trim().split('\n').pop() || `ffmpeg exit ${c}`))));
  });
}

async function doTask(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfarm-')), out = path.join(dir, 'shot.mp4');
  const t0 = Date.now();
  try {
    if (t.graph) fs.writeFileSync(path.join(dir, 'graph.txt'), t.graph, 'utf8');
    const args = t.args.map((a) => (a === '{{GRAPH}}' ? 'graph.txt' : a.replace(/^\{\{IN(\d+)\}\}$/, (_, n) => src(t.inputs[+n]))));
    await ff([...args, out], dir);
    const size = fs.statSync(out).size;
    const r = await fetch(url(`/farm/result/${t.id}`), { method: 'PUT', headers: { ...H, 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: fs.createReadStream(out), duplex: 'half' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `upload HTTP ${r.status}`);
    log(`✓ ${t.label} (${((Date.now() - t0) / 1000).toFixed(1)}s, ${(size / 1048576).toFixed(1)} MB)`);
  } catch (e) {
    log(`✗ ${t.label}: ${e.message}`);
    await fetch(url(`/farm/fail/${t.id}`), { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `${NAME}: ${e.message}` }) }).catch(() => {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// one slot: ask for a shot (the editor holds the request up to 25s), render it, ask again
async function slot() {
  for (;;) {
    try {
      const r = await fetch(`${url('/farm/next')}?w=${encodeURIComponent(ID)}`, { headers: H });
      if (r.status === 204) continue;
      if (r.status === 409) { await hello(); continue; }      // the editor restarted: introduce ourselves again
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await doTask(await r.json());
    } catch (e) { log(`editor not reachable (${e.message}) - trying again in 5s`); await sleep(5000); }
  }
}

for (;;) {
  try { await hello(); break; } catch (e) { log(`cannot reach the editor at ${BASE}: ${e.message} - trying again in 5s`); await sleep(5000); }
}
log(`🖥 ${NAME} is helping the editor at ${BASE} with ${SLOTS} shot${SLOTS > 1 ? 's' : ''} at a time. Keep this window open.`);
// stay known to the editor even while idle (each wait for a shot counts too)
setInterval(() => hello().catch(() => {}), 20000);
await Promise.all(Array.from({ length: SLOTS }, slot));
