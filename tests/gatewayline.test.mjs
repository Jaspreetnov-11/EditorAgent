// 🚪 engine/gateway.mjs with a line of standby PCs (only with --server): --standby 1st,2nd - the link follows the first
// standby that runs the editor (JASPREET before PC B), else the main editor.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, eq as same } from './harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a pretend editor: /team/ping answers only while it is "up"; every other page says who it is
function fake(name, port) {
  const st = { up: false };
  const srv = http.createServer((req, res) => {
    if (req.url === '/team/ping') { if (!st.up) { res.writeHead(503); return res.end(); } res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    res.end(name);
  }).listen(port, '127.0.0.1');
  return { st, srv };
}

test('gateway: a line of standby PCs - the first one running the editor gets everyone', async () => {
  if (!ON) return 'skip';
  const main = fake('main', 3941), one = fake('jaspreet', 3942), two = fake('pc-b', 3943);
  main.st.up = true;
  const gw = spawn(process.execPath, [path.join(ROOT, 'engine', 'gateway.mjs'), '--main', 'http://127.0.0.1:3941', '--standby', 'http://127.0.0.1:3942,http://127.0.0.1:3943', '--http', '3944', '--every', '200'], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  const who = async () => { for (let i = 0; i < 20; i++) { try { return await (await fetch('http://127.0.0.1:3944/x')).text(); } catch { await sleep(150); } } return '?'; };
  try {
    await sleep(800);
    same(await who(), 'main', 'the main editor while no standby runs');
    two.st.up = true; await sleep(600);
    same(await who(), 'pc-b', 'only PC B runs the editor: everyone there');
    one.st.up = true; await sleep(600);
    same(await who(), 'jaspreet', 'the 1st in the line wins');
    one.st.up = false; two.st.up = false; await sleep(600);
    same(await who(), 'main', 'both stopped: back to the main editor');
  } finally { gw.kill(); for (const f of [main, one, two]) f.srv.close(); }
});
