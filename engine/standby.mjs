#!/usr/bin/env node
// standby.mjs - 🖥 standby editor (Phase 21). Runs on a second office PC and watches the main editor. When the main
// one has not answered for 2 minutes, this PC starts the editor itself from the live mirror on the NAS (kept fresh by
// the main editor every few minutes - 🩺 Mazbooti > Standby): everyone opens this PC's team link and carries on. When the
// main editor answers again (steadily, for 2 minutes), everything is saved, this editor stops, and the main one brings
// the edits made here back into its projects (it waits for that before anyone can edit there).
// Usage: node engine/standby.mjs --main http://<main computer>:3100 --mirror "Z:\Limelight Backups\live" [--after 120]
// Needs Node.js, FFmpeg and this editor's folder (a copy of it) on this PC, and the NAS drive mapped as on the main PC.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareStandby, readJsonFile } from './safety.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const MAIN = opt('main'), LIVE = opt('mirror');
const AFTER = Math.max(30, +opt('after', 120) || 120) * 1000, EVERY = 15000;
const PORT = +opt('port', 3000);
if (!MAIN || !LIVE) {
  console.log('Usage: node engine/standby.mjs --main http://<main computer>:3100 --mirror "Z:\\Limelight Backups\\live" [--after 120]\nBoth are shown in the editor: 🩺 Mazbooti > Standby.');
  process.exit(1);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SB = path.join(LIVE, 'standby.json'), HOST = os.hostname();
const log = (m) => console.log(`${new Date().toLocaleTimeString()}  ${m}`);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const writeSb = (o) => { try { fs.writeFileSync(`${SB}.tmp`, JSON.stringify(o, null, 1)); fs.renameSync(`${SB}.tmp`, SB); } catch (e) { log(`⚠ could not write ${SB}: ${e.message}`); } };

async function mainUp() {
  try { const r = await fetch(new URL('/team/ping', MAIN), { signal: AbortSignal.timeout(5000) }); return r.ok && (await r.json()).ok === true; } catch { return false; }
}

let child = null, since = 0, beat = null;
async function takeOver() {
  if (!fs.existsSync(path.join(LIVE, 'mirror.json'))) { log(`⚠ no live mirror in ${LIVE} - turn it on in the main editor (🩺 Mazbooti > Standby). Not taking over.`); return false; }
  const sb = readJsonFile(SB, null);
  if (sb?.state === 'active' && sb.host !== HOST && Date.now() - (sb.beat || 0) < 90000) { log(`⚠ ${sb.host} is already running as the standby - not taking over.`); return false; }
  const m = readJsonFile(path.join(LIVE, 'mirror.json'), {});
  log(`⚠ the main editor has not answered for ${Math.round(AFTER / 1000)} s - taking over (mirror from ${m.host || '?'}, ${new Date(m.at || 0).toLocaleString()})`);
  since = Date.now();
  writeSb({ state: 'active', host: HOST, since, beat: since });
  const n = prepareStandby(LIVE);
  log(`  ${n} uploaded file${n === 1 ? '' : 's'} pointed at the mirror; thumbnails and previews are made again here`);
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  const out = fs.openSync(path.join(ROOT, 'logs', 'standby-server.log'), 'a');
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, stdio: ['ignore', out, out], windowsHide: true,
    env: { ...process.env, VEDIT_DATA: LIVE, VEDIT_STANDBY: HOST, PORT: String(PORT), UV_THREADPOOL_SIZE: '32' } });
  child.on('exit', (c) => { if (child) { log(`⚠ the standby editor stopped (code ${c}) - starting it again`); child = null; if (since) setTimeout(() => restartChild(), 3000); } });
  beat = setInterval(() => writeSb({ state: 'active', host: HOST, since, beat: Date.now() }), EVERY);
  log(`✅ standby editor running - everyone opens http://${HOST} (or http://${HOST}:3100) and signs in as usual`);
  return true;
}
function restartChild() {
  if (!since || child) return;
  const out = fs.openSync(path.join(ROOT, 'logs', 'standby-server.log'), 'a');
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, stdio: ['ignore', out, out], windowsHide: true,
    env: { ...process.env, VEDIT_DATA: LIVE, VEDIT_STANDBY: HOST, PORT: String(PORT), UV_THREADPOOL_SIZE: '32' } });
  child.on('exit', () => { child = null; if (since) setTimeout(restartChild, 3000); });
}
async function handBack(why) {
  if (!since) return;
  log(`${why} - saving every project and handing back…`);
  for (const f of fs.existsSync(path.join(LIVE, 'Projects')) ? fs.readdirSync(path.join(LIVE, 'Projects')) : []) {
    try { await fetch(`http://127.0.0.1:${PORT}/api/live/save?p=${encodeURIComponent(f)}`, { method: 'POST', signal: AbortSignal.timeout(8000) }); } catch {}
  }
  clearInterval(beat); beat = null;
  const until = Date.now(), from = since; since = 0;
  if (child) { const pid = child.pid; child = null; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); else process.kill(pid); }
  writeSb({ state: 'done', host: HOST, since: from, until });
  log('✅ handed back - the main editor now brings the edits made here into its projects. Watching again.');
}

process.on('SIGINT', async () => { await handBack('Stopping'); process.exit(0); });
process.on('SIGTERM', async () => { await handBack('Stopping'); process.exit(0); });

log(`🖥 Standby for ${MAIN} - mirror ${LIVE}. Takes over after ${Math.round(AFTER / 1000)} s without an answer. Keep this window open.`);
let downSince = 0, upSince = 0;
for (;;) {
  const up = await mainUp();
  if (!since) {
    if (up) { if (downSince) log('main editor answers again'); downSince = 0; }
    else { if (!downSince) { downSince = Date.now(); log('⚠ the main editor does not answer…'); } if (Date.now() - downSince >= AFTER && !(await takeOver())) downSince = Date.now(); }
  } else if (up) {
    if (!upSince) { upSince = Date.now(); log('the main editor answers again - handing back once it has stayed up 2 minutes'); }
    if (Date.now() - upSince >= AFTER) { upSince = 0; await handBack('The main editor is back'); }
  } else upSince = 0;
  await sleep(EVERY);
}
