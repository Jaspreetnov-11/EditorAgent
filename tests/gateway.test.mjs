// 🚪 engine/gateway.mjs (only with `node tests/run.mjs --server`): two pretend editors (main, standby) on spare ports and
// the gateway in plain-HTTP mode in front. Everyone goes to the main editor; while the standby runs the editor, to the
// standby; when it stops, back to the main one. A live stream passes straight through; with neither answering, a page
// that tries again by itself.
import { test, eq as same, assert } from './harness.mjs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const MAIN = 3951, STANDBY = 3952, GW = 3953;
let gw = null, main = null, standby = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pretend(port, who) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/team/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    if (req.url === '/stream') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${who}-1\n\n`); setTimeout(() => res.end(`data: ${who}-2\n\n`), 200); return; }
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ who, url: req.url, body, fwd: req.headers['x-forwarded-for'] || '' })); });
  });
  return new Promise((ok) => srv.listen(port, '127.0.0.1', () => ok(srv)));
}
const ask = async (u, o) => { const r = await fetch(`http://127.0.0.1:${GW}${u}`, o); return { status: r.status, text: await r.text() }; };
const who = async () => { try { return JSON.parse((await ask('/api/x')).text).who; } catch { return null; } };
const until = async (want) => { for (let i = 0; i < 40; i++) { if ((await who()) === want) return true; await sleep(150); } return false; };

test('gateway: everyone goes to the main editor; a POST and its body pass through', async () => {
  if (!ON) return 'skip';
  main = await pretend(MAIN, 'main');
  gw = spawn(process.execPath, [path.join(ROOT, 'engine', 'gateway.mjs'), '--main', `http://127.0.0.1:${MAIN}`, '--standby', `http://127.0.0.1:${STANDBY}`, '--http', String(GW), '--every', '300'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; gw.stdout.on('data', (d) => { log += d; }); gw.stderr.on('data', (d) => { log += d; });
  assert(await until('main'), `the gateway sends to the main editor:\n${log}`);
  const r = JSON.parse((await ask('/api/live/ops?p=x', { method: 'POST', body: '{"ops":[1]}' })).text);
  same(r.who, 'main'); same(r.body, '{"ops":[1]}'); same(r.url, '/api/live/ops?p=x'); assert(r.fwd, 'says who asked');
});

test('gateway: while the standby runs the editor everyone goes there, then back', async () => {
  if (!ON) return 'skip';
  standby = await pretend(STANDBY, 'standby');
  assert(await until('standby'), 'to the standby while it runs');
  const s = await ask('/stream');
  assert(s.text.includes('standby-1') && s.text.includes('standby-2'), 'a live stream passes through');
  await new Promise((ok) => standby.close(ok)); standby.closeAllConnections?.();
  assert(await until('main'), 'back to the main editor once the standby stops');
});

test('gateway: neither answering - a page that tries again by itself', async () => {
  if (!ON) return 'skip';
  await new Promise((ok) => main.close(ok)); main.closeAllConnections?.();
  await sleep(800);
  const r = await ask('/');
  same(r.status, 503); assert(/tries again by itself/.test(r.text), 'says it tries again');
});

test('gateway: stop', async () => {
  if (!ON) return 'skip';
  gw?.kill(); await sleep(300);
});
