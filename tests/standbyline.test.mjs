// ⛓ the line of standby PCs (only with `node tests/run.mjs --server`): the main editor does not answer -> rank 1 takes over
// (rank 2 only waits in the line); rank 1 stops -> rank 2 takes over once rank 1's beat is 20 s old. standby.json on "the
// NAS" says who runs it and where (Limelight Editor.exe goes there). About 1½ minutes: the line waits its turns.
import { test, eq as same, assert } from './harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const P1 = 3941, P2 = 3942;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (p) => { if (!p) return; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); else p.kill('SIGKILL'); };
const answers = async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };

test('standby line: rank 1 takes over first, rank 2 when rank 1 stops', async () => {
  if (!ON) return 'skip';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-line-'));
  const live = path.join(tmp, 'live'), pd = path.join(live, 'Projects', 'Line Test');
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(live, 'mirror.json'), JSON.stringify({ host: 'MAIN', at: Date.now(), projects: { 'Line Test': { name: 'Line Test', dir: 'Z:\\Editor Projects\\Line Test', at: Date.now() } } }));
  fs.writeFileSync(path.join(pd, 'project.json'), JSON.stringify({ name: 'Line Test', settings: { aspect: '16:9', fps: 25 }, tracks: { V1: [], A1: [] } }));
  fs.writeFileSync(path.join(pd, 'media.json'), JSON.stringify({ items: [] }));
  let log = '';
  const start = (name, rank, port) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'engine', 'standby.mjs'), '--main', 'http://127.0.0.1:9/', '--mirror', live, '--local', path.join(tmp, `local-${name}`),
      '--rank', String(rank), '--after', '15', '--port', String(port), '--name', name], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stdout.on('data', (d) => { log += `[${name}] ${d}`; }); p.stderr.on('data', (d) => { log += `[${name}] ${d}`; });
    return p;
  };
  const sbFile = () => { try { return JSON.parse(fs.readFileSync(path.join(live, 'standby.json'), 'utf8')); } catch { return null; } };
  const r1 = start('R1', 1, P1), r2 = start('R2', 2, P2);
  try {
    let s = null;
    for (let i = 0; i < 60 && s?.host !== 'R1'; i++) { await sleep(1000); s = sbFile(); }
    same([s?.state, s?.host, s?.rank], ['active', 'R1', 1], `rank 1 took over first:\n${log.slice(-1500)}`);
    assert(/^http:\/\/.+:3100\/$/.test(s.url), `its link is written for the app: ${s.url}`);
    for (let i = 0; i < 40 && !(await answers(P1)); i++) await sleep(1000);
    assert(await answers(P1), `rank 1's editor answers:\n${log.slice(-1500)}`);
    await sleep(20000); // (well past rank 2's own 30 s - it must still wait while rank 1 runs)
    same(sbFile()?.host, 'R1', 'rank 2 waits in the line while rank 1 runs');
    assert(!(await answers(P2)), 'rank 2 runs no editor of its own');
    killTree(r1); // (rank 1's PC goes off)
    for (let i = 0; i < 60 && sbFile()?.host !== 'R2'; i++) await sleep(1000);
    same([sbFile()?.state, sbFile()?.host], ['active', 'R2'], `rank 2 took over when rank 1 stopped:\n${log.slice(-1500)}`);
    for (let i = 0; i < 40 && !(await answers(P2)); i++) await sleep(1000);
    assert(await answers(P2), `rank 2's editor answers:\n${log.slice(-1500)}`);
  } finally {
    killTree(r1); killTree(r2); await sleep(800);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});
