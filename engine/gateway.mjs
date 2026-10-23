#!/usr/bin/env node
// gateway.mjs - 🚪 the office gateway: a small always-on box (on the UPS) that answers https://editor.limelightcorp.in
// for everyone and hands each request to whichever editor is the one to use - the main editor PC, or the standby PC
// while it runs the editor (engine/standby.mjs). The link never changes, and only one editor is ever the one people
// work on: the standby's editor runs only while it has taken over, so "the standby answers" means "go there"; it hands
// back (and stops answering) once the main editor has been up for 2 minutes. Streams (live edits) and uploads pass
// straight through.
//
// Usage: node engine/gateway.mjs --main http://<main PC>:3100 --standby http://<standby PC>:3100
//          [--domain editor.limelightcorp.in] [--cert <file.crt> --key <file.key>] [--https 443] [--http 80]
//   Without --cert / --key it answers plain HTTP on --http only (for a trial, or behind another HTTPS front).
//   The certificate is the editor's own (ssl/<domain>.crt / .key on the main PC - copy it over after each renewal;
//   a newer file is picked up within the hour).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const MAIN = opt('main'), STANDBY = opt('standby');
const DOMAIN = opt('domain', 'editor.limelightcorp.in'), CERT = opt('cert'), KEY = opt('key');
const HTTPS_PORT = +opt('https', 443), HTTP_PORT = +opt('http', 80), EVERY = +opt('every', 5000);
if (!MAIN) { console.log('Usage: node engine/gateway.mjs --main http://<main PC>:3100 --standby http://<standby PC>:3100 [--cert x.crt --key x.key]'); process.exit(1); }
const log = (m) => console.log(`${new Date().toLocaleTimeString()}  ${m}`);

// ---- which editor: the standby while it runs the editor, else the main one ----
const alive = async (base) => { try { const r = await fetch(new URL('/team/ping', base), { signal: AbortSignal.timeout(3000) }); return r.ok && (await r.json()).ok === true; } catch { return false; } };
let target = MAIN, mainUp = true;
async function look() {
  const [m, s] = await Promise.all([alive(MAIN), STANDBY ? alive(STANDBY) : false]);
  const next = s ? STANDBY : MAIN;
  if (next !== target) log(next === STANDBY ? `➡ the standby PC runs the editor - everyone goes to ${STANDBY}` : `➡ back to the main editor ${MAIN}`);
  if (m !== mainUp) log(m ? 'the main editor answers' : '⚠ the main editor does not answer');
  target = next; mainUp = m;
}
await look();
setInterval(() => look().catch(() => {}), EVERY);

// ---- passing requests on ----
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
function pass(req, res) {
  const to = new URL(req.url, target);
  const up = http.request({ host: to.hostname, port: to.port || 80, method: req.method, path: req.url, agent,
    headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress || '', 'x-forwarded-proto': req.socket.encrypted ? 'https' : 'http' } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '10' });
    res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="10"><body style="font:16px Segoe UI,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh"><div><h2>The editor is starting again…</h2><p>This page tries again by itself. Changes you made are kept in your editor tab.</p></div>');
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); }); // (a closed live stream closes the editor's side too)
  req.pipe(up);
}

if (CERT && KEY) {
  let cert = fs.readFileSync(CERT), key = fs.readFileSync(KEY), mt = fs.statSync(CERT).mtimeMs;
  const srv = https.createServer({ cert, key }, pass);
  setInterval(() => { try { const m = fs.statSync(CERT).mtimeMs; if (m !== mt) { mt = m; cert = fs.readFileSync(CERT); key = fs.readFileSync(KEY); srv.setSecureContext({ cert, key }); log('🔒 renewed certificate in use'); } } catch {} }, 3600e3).unref();
  srv.listen(HTTPS_PORT, () => log(`🚪 https://${DOMAIN} (port ${HTTPS_PORT}) -> ${target}`));
  // plain http: to https
  http.createServer((req, res) => { res.writeHead(301, { Location: `https://${DOMAIN}${req.url}` }); res.end(); }).listen(HTTP_PORT, () => log(`   http port ${HTTP_PORT} sends people to https`));
} else {
  http.createServer(pass).listen(HTTP_PORT, () => log(`🚪 http (port ${HTTP_PORT}) -> ${target}  (no certificate given: plain HTTP)`));
}
