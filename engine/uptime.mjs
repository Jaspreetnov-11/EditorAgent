#!/usr/bin/env node
// uptime.mjs - 📟 the office watch: a small Uptime-Kuma-like watcher that only sends WhatsApp messages. It looks at the
// main editor, the standby, the gateway, the render farm, the NAS and the HTTPS certificate every 30 s and sends one
// WhatsApp message when something goes down (two misses in a row), a reminder every 30 min while it stays down, and one
// when it is back. Run it on the bridge PC (the always-on box on the UPS), not on the main editor PC - else nobody hears
// when that PC itself goes away. Nothing is installed: Node.js only; it imports nothing of the editor's.
//
// Usage: node engine/uptime.mjs [--config <file>] [--test] [--once]
//   --config  its settings (default: uptime.json next to this folder; made with the office's checks the first time)
//   --test    sends one test WhatsApp message and stops
//   --once    one round of checks, printed, then stops (nothing sent)
//
// WhatsApp through Limelight Flow (flow/ - the office's own automation app, best): its "Alerts" flow's webhook address in
// "flow" - the alert goes to its WhatsApp. Else through CallMeBot (free, for your own numbers): each person who should get the messages sends
// "I allow callmebot to send me messages" to +34 644 66 32 62 on WhatsApp once and gets an API key back. Put the number
// (with country code, no +) and that key under "whatsapp.to". Another WhatsApp gateway: set "whatsapp.url" with
// {phone} {apikey} {text} in it. The message text (check names, what failed) goes to that service.
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG_FILE = path.resolve(opt('config', path.join(HERE, '..', 'uptime.json')));
const log = (m) => console.log(`${new Date().toLocaleString('en-IN')}  ${m}`);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// the office as it is set up (main PC 192.168.0.200, NAS 192.168.0.99); "off": true for one that is not there yet
const DEFAULT = {
  flow: '', every: 30, downAfter: 2, remindMin: 30, quiet: { from: 23, to: 7, onlyReminders: true },
  whatsapp: { url: 'https://api.callmebot.com/whatsapp.php?phone={phone}&apikey={apikey}&text={text}', to: [{ name: 'Owner', phone: '91XXXXXXXXXX', apikey: '' }] },
  checks: [
    { name: 'Main editor', http: 'http://192.168.0.200:3100/team/ping', slowMs: 5000 },
    { name: 'Render farm door', tcp: '192.168.0.200:3200' },
    { name: 'NAS (Team Editing)', tcp: '192.168.0.99:445' },
    { name: 'Office link', http: 'https://editor.limelightcorp.in/team/ping', slowMs: 5000 },
    { name: 'HTTPS certificate', cert: 'editor.limelightcorp.in:443', warnDays: 14 },
    { name: 'Standby editor', http: 'http://127.0.0.1:3100/team/ping', standby: true, off: true },
    { name: 'Gateway (bridge PC)', http: 'http://127.0.0.1:80/team/ping', off: true },
  ],
};

function loadCfg() {
  if (!fs.existsSync(CFG_FILE)) {
    fs.writeFileSync(CFG_FILE, JSON.stringify(DEFAULT, null, 2));
    console.log(`Made ${CFG_FILE} - put the WhatsApp number(s) and CallMeBot key(s) in it, then start this again.`);
    process.exit(0);
  }
  const c = { ...DEFAULT, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) };
  c.whatsapp = { ...DEFAULT.whatsapp, ...(c.whatsapp || {}) };
  return c;
}

// ---- the checks: each resolves { ok, ms, why } and never throws
const withTimeout = (p, ms, why) => Promise.race([p, sleep(ms).then(() => ({ ok: false, why }))]);
async function checkHttp(url, timeout) {
  const t = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'manual' });
    return r.status < 500 ? { ok: true, ms: Date.now() - t } : { ok: false, ms: Date.now() - t, why: `answers ${r.status}` };
  } catch (e) { return { ok: false, ms: Date.now() - t, why: e.name === 'TimeoutError' ? `no answer in ${timeout / 1000} s` : (e.cause?.code || e.message) }; }
}
function checkTcp(hostPort, timeout) {
  const [host, port] = splitHost(hostPort), t = Date.now();
  return new Promise((ok) => {
    const s = net.connect({ host, port, timeout });
    s.once('connect', () => { s.destroy(); ok({ ok: true, ms: Date.now() - t }); });
    s.once('timeout', () => { s.destroy(); ok({ ok: false, why: `no answer on port ${port}` }); });
    s.once('error', (e) => ok({ ok: false, why: e.code || e.message }));
  });
}
function checkCert(hostPort, warnDays, timeout) {
  const [host, port] = splitHost(hostPort, 443);
  return new Promise((ok) => {
    const s = tls.connect({ host, port, servername: host, timeout, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate(); s.destroy();
      const days = Math.floor((new Date(c.valid_to) - Date.now()) / 864e5);
      ok(days >= warnDays ? { ok: true, info: `${days} days left` } : { ok: false, why: days < 0 ? 'has run out' : `runs out in ${days} days - renew it (node engine/ssl.mjs start)` });
    });
    s.once('timeout', () => { s.destroy(); ok({ ok: false, why: 'no answer' }); });
    s.once('error', (e) => ok({ ok: false, why: e.code || e.message }));
  });
}
const checkPath = (p, timeout) => withTimeout(fs.promises.access(p).then(() => ({ ok: true }), (e) => ({ ok: false, why: e.code })), timeout, `no answer in ${timeout / 1000} s`);
function splitHost(hp, dflt) { const m = /^(.*?)(?::(\d+))?$/.exec(String(hp)); return [m[1], +(m[2] || dflt)]; }

async function runCheck(c) {
  const timeout = (c.timeout || 10) * 1000;
  let r;
  if (c.http) r = await checkHttp(c.http, timeout);
  else if (c.tcp) r = await checkTcp(c.tcp, timeout);
  else if (c.cert) r = await checkCert(c.cert, c.warnDays ?? 14, timeout);
  else if (c.path) r = await checkPath(c.path, timeout);
  else r = { ok: false, why: 'no http / tcp / cert / path in this check' };
  // (answering, but slowly: the editor stuck - the NAS holding it - counts as a problem of its own)
  if (r.ok && c.slowMs && r.ms > c.slowMs) r = { ok: false, slow: true, ms: r.ms, why: `very slow (${(r.ms / 1000).toFixed(1)} s)` };
  return r;
}

// ---- WhatsApp
async function sendWhatsApp(cfg, text) {
  if (cfg.flow) { // (⚡ Limelight Flow's Alerts flow: one call, it sends)
    for (let k = 0; k < 3; k++) {
      try { const r = await fetch(cfg.flow, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(30000) }); if (r.ok) return true; log(`Limelight Flow: ${r.status} ${(await r.text()).slice(0, 120)}`); }
      catch (e) { log(`Limelight Flow: ${e.cause?.code || e.message}`); }
      await sleep(5000 * (k + 1));
    }
    return false;
  }
  const to = (cfg.whatsapp.to || []).filter((x) => x.phone && !/X/.test(x.phone));
  if (!to.length) { log(`(no WhatsApp number set in ${CFG_FILE}) ${text}`); return false; }
  let sent = 0;
  for (const x of to) {
    const url = cfg.whatsapp.url.replace('{phone}', encodeURIComponent(x.phone)).replace('{apikey}', encodeURIComponent(x.apikey || '')).replace('{text}', encodeURIComponent(text));
    for (let k = 0; k < 3; k++) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (r.ok) { sent++; break; } log(`WhatsApp to ${x.name || x.phone}: ${r.status}`); }
      catch (e) { log(`WhatsApp to ${x.name || x.phone}: ${e.cause?.code || e.message}`); }
      await sleep(5000 * (k + 1));
    }
    await sleep(1500); // (CallMeBot takes one message at a time per key)
  }
  return sent > 0;
}

const hhmm = (t) => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const mins = (ms) => (ms < 90e3 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)} min` : `${(ms / 3600e3).toFixed(1)} h`);
function inQuiet(q, d = new Date()) { if (!q) return false; const h = d.getHours(); return q.from > q.to ? h >= q.from || h < q.to : h >= q.from && h < q.to; }

async function main() {
  let cfg = loadCfg();
  if (argv.includes('--test')) { const ok = await sendWhatsApp(cfg, `✅ Limelight office watch on ${os.hostname()}: WhatsApp alerts work.`); process.exit(ok ? 0 : 1); }
  if (argv.includes('--once')) {
    for (const c of cfg.checks.filter((x) => !x.off)) { const r = await runCheck(c); console.log(`${r.ok ? '🟢' : '🔴'} ${c.name}: ${r.ok ? `ok${r.ms != null ? ` ${r.ms} ms` : ''}${r.info ? ` (${r.info})` : ''}` : r.why}`); }
    return;
  }
  const state = new Map(); // check name -> { fails, down, since, told, why }
  log(`Office watch on ${os.hostname()}: ${cfg.checks.filter((x) => !x.off).length} checks every ${cfg.every} s (${CFG_FILE})`);
  await sendWhatsApp(cfg, `📟 Limelight office watch started on ${os.hostname()} (${cfg.checks.filter((x) => !x.off).map((x) => x.name).join(', ')}).`);
  let cfgTime = fs.statSync(CFG_FILE).mtimeMs;
  for (;;) {
    try { const m = fs.statSync(CFG_FILE).mtimeMs; if (m !== cfgTime) { cfgTime = m; cfg = loadCfg(); log('settings read again'); } } catch {}
    const checks = cfg.checks.filter((x) => !x.off), now = Date.now(), lines = [];
    const results = await Promise.all(checks.map(runCheck));
    checks.forEach((c, i) => {
      const r = results[i], s = state.get(c.name) || { fails: 0, down: false };
      state.set(c.name, s);
      // (the standby answering means it has taken over: that is the news, the other way round)
      const bad = c.standby ? r.ok : !r.ok;
      if (bad) {
        s.fails++; s.why = c.standby ? 'has taken over - the main editor is away, everyone works on the standby' : r.why;
        if (!s.down && s.fails >= (c.downAfter || cfg.downAfter)) { s.down = true; s.since = now - (s.fails - 1) * cfg.every * 1000; s.told = now; lines.push(`🔴 ${c.name} ${c.standby ? '' : 'DOWN: '}${s.why} (since ${hhmm(s.since)})`); }
        else if (s.down && now - s.told >= cfg.remindMin * 60e3) { s.told = now; lines.push(`⏰ ${c.name} still ${c.standby ? 'running' : 'down'} for ${mins(now - s.since)}: ${s.why}`); }
      } else {
        if (s.down) lines.push(`🟢 ${c.name} ${c.standby ? 'has handed back to the main editor' : 'is back'} after ${mins(now - s.since)}`);
        s.fails = 0; s.down = false;
      }
    });
    if (lines.length) {
      log(lines.join(' | '));
      // (at night - quiet hours - only what is new is sent: going down, coming back; the reminders are skipped)
      const quiet = inQuiet(cfg.quiet) && cfg.quiet.onlyReminders && lines.every((l) => l.startsWith('⏰'));
      if (!quiet) await sendWhatsApp(cfg, `Limelight office watch\n${lines.join('\n')}`);
    }
    await sleep(Math.max(10, cfg.every) * 1000);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
