#!/usr/bin/env node
// server.mjs - ⚡ Limelight Flow: the office's own n8n-like automation app. Flows start on a schedule, a WhatsApp message,
// a webhook or by hand, and run their steps one after another (engine.mjs): the editor's day report, who is online, a
// question for Claude, WhatsApp messages, HTTP calls, a bit of JavaScript. Made in the browser: http://<this PC>:5678.
// Meant for the bridge PC (always on): it talks to the editor over the office network with the editor's report token
// (👥 Team > Report token) and to WhatsApp through a spare SIM (whatsapp.mjs).
//
// Usage: node flow/server.mjs [--port 5678] [--data <folder>]      (data: flow/data - flows, runs, settings, sign-in)
// Only Node.js; WhatsApp needs `npm install` in flow/ once.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runFlow, dueAt, whatsappMatches, telegramMatches, render, STEP_TYPES, TRIGGER_TYPES } from './engine.mjs';
import { WhatsApp } from './whatsapp.mjs';
import { Telegram } from './telegram.mjs';
import { TEMPLATES } from './templates.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(opt('data', process.env.FLOW_DATA || path.join(HERE, 'data')));
const PORT = +opt('port', process.env.FLOW_PORT || 5678);
fs.mkdirSync(DATA, { recursive: true });
const F = (n) => path.join(DATA, n);
const log = (m) => console.log(`${new Date().toLocaleString('en-IN')}  ${m}`);

// ---- files (written whole, through a .tmp)
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => { fs.writeFileSync(`${f}.tmp`, JSON.stringify(o, null, 1)); fs.renameSync(`${f}.tmp`, f); };
let settings = readJSON(F('settings.json'), { editor: { url: 'http://192.168.0.200:3100', token: '' }, vars: { ownerPhone: '' } });
let flows = readJSON(F('flows.json'), []);
const saveSettings = () => writeJSON(F('settings.json'), settings);
const saveFlows = () => writeJSON(F('flows.json'), flows);
const runs = (() => { try { return fs.readFileSync(F('runs.jsonl'), 'utf8').trim().split('\n').slice(-300).map((l) => JSON.parse(l)); } catch { return []; } })();
function keepRun(r) {
  runs.push(r); if (runs.length > 300) runs.splice(0, runs.length - 300);
  try { fs.appendFileSync(F('runs.jsonl'), `${JSON.stringify(r)}\n`); if (fs.statSync(F('runs.jsonl')).size > 20e6) writeJSON(F('runs.jsonl.old'), runs); } catch {}
}
const newId = (n = 8) => crypto.randomBytes(n).toString('base64url');

// ---- what a flow's steps use
let waSent = [], tgSent = [], simReplies = [];
// a WhatsApp trigger's settings may use {{vars.…}} ("only from {{vars.ownerPhone}}")
const waTrigger = (tr) => { try { return render(tr, { vars: settings.vars || {} }); } catch { return tr; } };
const io = {
  async editor(method, p, body) {
    const e = settings.editor || {};
    if (!e.url || !e.token) throw new Error('Settings: the editor address and its report token are not set');
    const r = await fetch(new URL(p, e.url), { method, headers: { Authorization: `Bearer ${e.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(method === 'POST' ? 200e3 : 30e3) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `editor answered ${r.status}`);
    return j;
  },
  async http(url, o) {
    const r = await fetch(url, { ...o, signal: AbortSignal.timeout(60e3) });
    const t = await r.text();
    let body = t; try { body = JSON.parse(t); } catch {}
    if (!r.ok) throw new Error(`${r.status} ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
    return { status: r.status, body };
  },
  // (at most 20 messages a minute: a flow gone round in circles must not get the number blocked)
  async whatsapp(to, text) {
    const now = Date.now(); waSent = waSent.filter((t) => now - t < 60e3);
    if (waSent.length >= 20) throw new Error('More than 20 WhatsApp messages in a minute - held back');
    waSent.push(now);
    if (to === 'simulated') { log(`(simulated reply) ${text.slice(0, 200)}`); simReplies.push(text); return; }
    await wa.send(to, text);
  },
  async telegram(to, text) {
    const now = Date.now(); tgSent = tgSent.filter((t) => now - t < 60e3);
    if (tgSent.length >= 30) throw new Error('More than 30 Telegram messages in a minute - held back');
    tgSent.push(now);
    if (to === 'simulated') { log(`(simulated reply) ${text.slice(0, 200)}`); simReplies.push(text); return; }
    await tg.send(to, text);
  },
};

// ---- running flows
const running = new Map(); // flow id -> runs going on
async function start(flow, trigger, how) {
  if ((running.get(flow.id) || 0) >= 3) { log(`${flow.name}: 3 runs going on already - this one skipped`); return null; }
  running.set(flow.id, (running.get(flow.id) || 0) + 1);
  const at = Date.now();
  try {
    const r = await runFlow(flow, trigger, io, settings.vars || {});
    const rec = { id: newId(6), flow: flow.id, name: flow.name, how, at, trigger: shortTrigger(trigger), ...r };
    keepRun(rec);
    log(`${flow.name} (${how}): ${r.ok ? 'ok' : `failed - ${r.error}`} in ${r.ms} ms`);
    return rec;
  } finally { running.set(flow.id, running.get(flow.id) - 1); }
}
const shortTrigger = (t) => { try { const s = JSON.stringify(t); return s.length > 2000 ? { cut: s.slice(0, 2000) } : t; } catch { return {}; } };

// schedules: looked at every 15 s; each flow runs once per minute that is due
let lastMinute = '';
setInterval(() => {
  const d = new Date(), key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
  if (key === lastMinute) return;
  lastMinute = key;
  for (const f of flows) if (f.on && f.trigger?.type === 'schedule' && dueAt(f.trigger, d)) start(f, { at: d.toISOString() }, 'schedule').catch((e) => log(`${f.name}: ${e.message}`));
}, 15e3);

// WhatsApp messages coming in
const wa = new WhatsApp(DATA, (msg) => {
  log(`WhatsApp from ${msg.from}${msg.group ? ' (group)' : ''}: ${msg.text.slice(0, 60)}`);
  for (const f of flows) if (f.on && f.trigger?.type === 'whatsapp' && whatsappMatches(waTrigger(f.trigger), msg)) start(f, msg, 'whatsapp').catch((e) => log(`${f.name}: ${e.message}`));
}, log);
if (settings.whatsapp?.on) wa.start().catch((e) => log(`WhatsApp: ${e.message}`));
// Telegram messages coming in (to the office's own bot)
const tg = new Telegram(() => settings.telegram?.token, (msg) => {
  log(`Telegram from ${msg.username ? `@${msg.username}` : msg.from}${msg.group ? ' (group)' : ''}: ${msg.text.slice(0, 60)}`);
  for (const f of flows) if (f.on && f.trigger?.type === 'telegram' && telegramMatches(waTrigger(f.trigger), msg)) start(f, msg, 'telegram').catch((e) => log(`${f.name}: ${e.message}`));
}, log);
if (settings.telegram?.on) tg.start().catch((e) => log(`Telegram: ${e.message}`));
// a message as if it came in - to try a WhatsApp / Telegram flow without a phone; the answers come back, nothing is sent
async function simulate(type, msg) {
  const hit = flows.filter((f) => f.on && f.trigger?.type === type && (type === 'telegram' ? telegramMatches : whatsappMatches)(waTrigger(f.trigger), msg));
  simReplies = [];
  const done = await Promise.all(hit.map((f) => start(f, msg, 'simulated')));
  return { matched: hit.map((f) => f.name), replies: simReplies, runs: done.filter(Boolean) };
}

// ---- sign-in: one owner password (scrypt), sessions kept by a hash of the cookie
const AUTH = F('auth.json'), SESS = F('sessions.json');
const sessions = new Map(Object.entries(readJSON(SESS, {})).filter(([, s]) => Date.now() - s.at < 30 * 864e5));
const saveSess = () => { try { writeJSON(SESS, Object.fromEntries(sessions)); } catch {} };
const hashOf = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const scrypt = (pw, salt) => new Promise((ok, bad) => crypto.scrypt(String(pw), salt, 32, (e, k) => (e ? bad(e) : ok(k))));
const tries = new Map();
const cookieOf = (req) => (/(?:^|; )lf_sess=([^;]+)/.exec(req.headers.cookie || '') || [])[1];
const signedIn = (req) => { const s = sessions.get(hashOf(cookieOf(req) || '-')); return !!s && Date.now() - s.at < 30 * 864e5; };
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const ipOf = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

// ---- HTTP
const send = (res, code, body, type = 'application/json', more = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', ...more }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
const readBody = (req, max = 1e6) => new Promise((ok, bad) => { let n = 0; const c = []; req.on('data', (d) => { n += d.length; if (n > max) { bad(Object.assign(new Error('Too big'), { code: 413 })); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))); req.on('error', bad); });
const json = async (req) => { const t = await readBody(req); return t ? JSON.parse(t) : {}; };
const err = (code, m) => Object.assign(new Error(m), { code });
const PUB = path.join(HERE, 'public'), MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const flowView = (f) => f;
const settingsView = () => ({ editor: { url: settings.editor?.url || '', tokenSet: !!settings.editor?.token }, vars: settings.vars || {}, whatsappOn: !!settings.whatsapp?.on, host: os.hostname(), port: PORT, dataDir: DATA });
function cleanFlow(b, old = {}) {
  const tr = b.trigger && typeof b.trigger === 'object' ? b.trigger : old.trigger || { type: 'manual' };
  if (!TRIGGER_TYPES[tr.type]) throw err(400, `Unknown trigger "${tr.type}"`);
  if (tr.type === 'webhook' && !String(tr.key || '').trim()) tr.key = newId(12);
  const steps = (Array.isArray(b.steps) ? b.steps : old.steps || []).map((s) => {
    if (!STEP_TYPES[s.type]) throw err(400, `Unknown step "${s.type}"`);
    return { id: String(s.id || newId(4)).replace(/[^\w]/g, '_').slice(0, 40) || newId(4), type: s.type, name: String(s.name || '').slice(0, 80), if: String(s.if || '').slice(0, 1000), goOn: !!s.goOn, params: s.params && typeof s.params === 'object' ? s.params : {} };
  });
  const ids = new Set(); for (const s of steps) { if (ids.has(s.id)) throw err(400, `Two steps are called "${s.id}" - each needs its own id`); ids.add(s.id); }
  return { id: old.id || newId(6), name: String(b.name ?? old.name ?? 'New flow').slice(0, 100) || 'New flow', on: b.on === undefined ? !!old.on : !!b.on, trigger: tr, steps, note: String(b.note ?? old.note ?? '').slice(0, 2000), changed: Date.now() };
}

const API = {
  'GET /api/meta': () => ({ steps: STEP_TYPES, triggers: TRIGGER_TYPES, templates: Object.entries(TEMPLATES).map(([k, t]) => ({ key: k, name: t.name, note: t.note })) }),
  'GET /api/settings': () => settingsView(),
  'PUT /api/settings': async (req) => {
    const b = await json(req);
    if (b.editor) settings.editor = { url: String(b.editor.url ?? settings.editor?.url ?? '').trim(), token: String(b.editor.token || '').trim() || settings.editor?.token || '' };
    if (b.vars && typeof b.vars === 'object') settings.vars = Object.fromEntries(Object.entries(b.vars).filter(([k]) => /^\w{1,40}$/.test(k)).map(([k, v]) => [k, String(v).slice(0, 2000)]));
    saveSettings(); return settingsView();
  },
  'POST /api/settings/test-editor': async () => ({ online: await io.editor('GET', '/report/online') }),
  'GET /api/flows': () => flows.map(flowView),
  'POST /api/flows': async (req) => { const b = await json(req), f = cleanFlow(b); flows.push(f); saveFlows(); return f; },
  'POST /api/templates': async (req) => {
    const b = await json(req), t = TEMPLATES[b.key];
    if (!t) throw err(404, 'No such template');
    const f = cleanFlow({ ...structuredClone(t.flow), name: t.name, note: t.note, on: false }); flows.push(f); saveFlows(); return f;
  },
  'GET /api/runs': (req, u) => runs.filter((r) => !u.searchParams.get('flow') || r.flow === u.searchParams.get('flow')).slice(-100).reverse(),
  'GET /api/telegram': () => ({ ...tg.view(), tokenSet: !!settings.telegram?.token }),
  'POST /api/telegram': async (req) => {
    const b = await json(req);
    if (b.action === 'token') { const t = String(b.token || '').trim(); if (!/^\d+:[\w-]{30,}$/.test(t)) throw err(400, 'That does not look like a bot token (it looks like 123456789:AA…)'); await tg.stop(); settings.telegram = { token: t, on: true }; saveSettings(); await tg.start(); }
    else if (b.action === 'start') { settings.telegram = { ...(settings.telegram || {}), on: true }; saveSettings(); await tg.start(); }
    else if (b.action === 'stop') { settings.telegram = { ...(settings.telegram || {}), on: false }; saveSettings(); await tg.stop(); }
    else if (b.action === 'test') await io.telegram(String(b.to || ''), String(b.text || '✅ Limelight Flow: Telegram works'));
    else if (b.action === 'simulate') return simulate('telegram', { from: String(b.from || settings.vars?.ownerTelegram || ''), username: '', name: 'Test', text: String(b.text || ''), chat: 'simulated', group: false });
    return { ...tg.view(), tokenSet: !!settings.telegram?.token };
  },
  'GET /api/whatsapp': async () => ({ ...wa.view(), groups: await wa.groups().catch(() => []) }),
  'POST /api/whatsapp': async (req) => {
    const b = await json(req);
    if (b.action === 'start') { settings.whatsapp = { on: true }; saveSettings(); await wa.start(); }
    else if (b.action === 'stop' || b.action === 'logout') { settings.whatsapp = { on: false }; saveSettings(); await wa.stop(b.action === 'logout'); }
    else if (b.action === 'test') { await io.whatsapp(String(b.to || ''), String(b.text || '✅ Limelight Flow: WhatsApp works')); }
    else if (b.action === 'simulate') { // (a message as if it came in - to try a WhatsApp flow without a phone)
      return simulate('whatsapp', { from: String(b.from || settings.vars?.ownerPhone || '').replace(/\D/g, ''), name: 'Test', text: String(b.text || ''), chat: 'simulated', group: false });
    }
    return wa.view();
  },
};

async function route(req, res, u) {
  const m = /^\/api\/flows\/([\w-]+)(\/run)?$/.exec(u.pathname);
  if (m) {
    const i = flows.findIndex((f) => f.id === m[1]);
    if (i < 0) throw err(404, 'No such flow');
    if (m[2] && req.method === 'POST') { const b = await json(req); return start(flows[i], b.trigger || { manual: true, at: new Date().toISOString() }, 'by hand'); }
    if (req.method === 'PUT') { flows[i] = cleanFlow(await json(req), flows[i]); saveFlows(); return flows[i]; }
    if (req.method === 'DELETE') { flows.splice(i, 1); saveFlows(); return { ok: true }; }
    if (req.method === 'GET') return flows[i];
  }
  const h = API[`${req.method} ${u.pathname}`];
  if (!h) throw err(404, 'not found');
  return h(req, u);
}

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    // 🔗 webhooks: /hook/<key> (GET or POST) - the key is the secret; every flow with that key runs
    const hk = /^\/hook\/([\w-]{8,})$/.exec(u.pathname);
    if (hk) {
      const hit = flows.filter((f) => f.on && f.trigger?.type === 'webhook' && f.trigger.key === hk[1]);
      if (!hit.length) return send(res, 404, { error: 'No flow for this hook' });
      let body = ''; try { body = await readBody(req, 2e5); } catch {}
      let data = body; try { data = JSON.parse(body); } catch {}
      const trigger = { query: Object.fromEntries(u.searchParams), body: data, method: req.method, from: ipOf(req) };
      const done = await Promise.all(hit.map((f) => start(f, trigger, 'webhook')));
      return send(res, 200, { ok: done.every((r) => r?.ok), runs: done.map((r) => r && { name: r.name, ok: r.ok, error: r.error }) });
    }
    if (req.method === 'GET' && (u.pathname === '/' || /^\/[\w.-]+\.(js|css|svg)$/.test(u.pathname))) {
      const f = path.join(PUB, u.pathname === '/' ? 'index.html' : path.basename(u.pathname));
      if (!fs.existsSync(f)) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream', { 'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
    }
    // sign-in
    if (u.pathname === '/api/me') return send(res, 200, { setUp: fs.existsSync(AUTH), signedIn: signedIn(req), local: isLocal(req) });
    if (req.method === 'POST' && u.pathname === '/api/setup') {
      if (fs.existsSync(AUTH)) throw err(400, 'Already set up');
      if (!isLocal(req)) throw err(403, 'Make the password on this PC itself (http://localhost:' + PORT + ')');
      const b = await json(req); if (String(b.password || '').length < 8) throw err(400, 'At least 8 characters');
      const salt = newId(12); writeJSON(AUTH, { salt, hash: (await scrypt(b.password, salt)).toString('hex') });
    }
    if (req.method === 'POST' && (u.pathname === '/api/login' || u.pathname === '/api/setup')) {
      const ip = ipOf(req), t = (tries.get(ip) || []).filter((x) => Date.now() - x < 10 * 60e3);
      if (t.length >= 10) throw err(429, 'Too many tries - wait 10 minutes');
      const b = u.pathname === '/api/login' ? await json(req) : null, a = readJSON(AUTH, null);
      if (b) { const k = await scrypt(String(b.password || '').slice(0, 500), a?.salt || 'x'); if (!a || !crypto.timingSafeEqual(k, Buffer.from(a.hash, 'hex'))) { tries.set(ip, [...t, Date.now()]); await new Promise((r) => setTimeout(r, 600)); throw err(401, 'Wrong password'); } }
      const tok = newId(24); sessions.set(hashOf(tok), { at: Date.now(), ip }); saveSess();
      return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `lf_sess=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    }
    if (u.pathname === '/api/logout') { sessions.delete(hashOf(cookieOf(req) || '-')); saveSess(); return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': 'lf_sess=; Path=/; Max-Age=0' }); }
    if (!u.pathname.startsWith('/api/')) return send(res, 404, 'Not found', 'text/plain');
    if (!signedIn(req)) throw err(401, 'Sign in');
    // (every change comes from this app's own page: it sends this header, another site's page cannot)
    if (req.method !== 'GET' && req.headers['x-flow'] !== '1') throw err(403, 'Refused');
    return send(res, 200, (await route(req, res, u)) ?? { ok: true });
  } catch (e) {
    return send(res, e.code >= 400 && e.code < 600 ? e.code : e instanceof SyntaxError ? 400 : 500, { error: e.message });
  }
});
srv.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  log(`Limelight Flow on http://localhost:${PORT}  ${ips.map((ip) => `http://${ip}:${PORT}`).join('  ')}  (data: ${DATA})`);
});
process.on('uncaughtException', (e) => log(`error: ${e.stack || e}`));
process.on('unhandledRejection', (e) => log(`error: ${e?.stack || e}`));
