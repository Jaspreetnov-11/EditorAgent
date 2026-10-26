// ⚡ Limelight Flow (flow/): the engine's expressions, steps, schedules and WhatsApp matching, the ready flows - and
// (with --server) the app itself on a spare port with a throwaway data folder, talking to a stand-in editor.
import { test, eq, assert } from './harness.mjs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, runFlow, dueAt, whatsappMatches, telegramMatches } from '../flow/engine.mjs';
import { toTelegramHtml } from '../flow/telegram.mjs';
import { TEMPLATES } from '../flow/templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';

test('flow: {{ }} in settings - text, a whole value as it is, nested settings', () => {
  const ctx = { trigger: { text: 'hi', n: 2 }, steps: { a: { list: [1, 2] } }, vars: { p: '91' } };
  eq(render('to {{vars.p}}: {{trigger.text.toUpperCase()}}', ctx), 'to 91: HI');
  eq(render('{{steps.a.list}}', ctx), [1, 2]);
  eq(render({ x: ['{{trigger.n * 2}}'], y: 'plain' }, ctx), { x: [4], y: 'plain' });
  eq(render('{{steps.a}} and {{trigger.n}}', ctx), '{"list":[1,2]} and 2');
  let bad = null; try { render('{{nothing.here}}', ctx); } catch (e) { bad = e.message; }
  assert(/nothing/.test(bad), 'a broken expression says which one');
});

test('flow: steps run in order, "only if" skips, stop ends, a failure stops the run unless "carry on"', async () => {
  const sent = [];
  const io = { whatsapp: async (to, t) => sent.push([to, t]), editor: async () => { throw new Error('editor away'); } };
  const r = await runFlow({ steps: [
    { id: 'a', type: 'code', params: { code: 'return trigger.n + 1' } },
    { id: 'b', type: 'text', if: 'steps.a > 100', params: { text: 'no' } },
    { id: 'c', type: 'whatsapp.send', params: { to: '91 98, 9177', text: 'n is {{steps.a}}' } },
    { id: 'd', type: 'limelight.online', goOn: true, params: {} },
    { id: 'e', type: 'stop', if: 'true', params: {} },
    { id: 'f', type: 'text', params: { text: 'never' } },
  ] }, { n: 1 }, io);
  eq(r.steps.map((s) => [s.id, s.ok, !!s.skipped]), [['a', true, false], ['b', true, true], ['c', true, false], ['d', false, false], ['e', true, false]]);
  eq(sent, [['91 98', 'n is 2'], ['9177', 'n is 2']]);
  assert(!r.ok && /editor away/.test(r.error), 'the failure is the run\'s error');
  const r2 = await runFlow({ steps: [{ id: 'x', type: 'limelight.online', params: {} }, { id: 'y', type: 'text', params: { text: 'after' } }] }, {}, io);
  eq(r2.steps.length, 1, 'without "carry on" the run stops at the failing step');
});

test('flow: schedules - at a time, on some days, every N minutes', () => {
  const d = new Date('2026-10-24T22:00:30'); // a Saturday
  assert(dueAt({ at: '22:00' }, d) && dueAt({ at: '09:00, 22:00' }, d) && !dueAt({ at: '21:59' }, d));
  assert(dueAt({ at: '22:00', days: '6' }, d) && !dueAt({ at: '22:00', days: '1,2,3,4,5' }, d));
  assert(dueAt({ every: 15 }, d) && !dueAt({ every: 7 }, new Date('2026-10-24T22:01:00')));
});

test('flow: a WhatsApp message starts a flow only from the numbers given, matching, and in groups only when asked', () => {
  const m = { from: '919812345678', text: 'Report please', group: false };
  assert(whatsappMatches({}, m) && whatsappMatches({ from: '+91 98123 45678, 9100' }, m));
  assert(!whatsappMatches({ from: '9100' }, m));
  assert(whatsappMatches({ match: '^report' }, m) && !whatsappMatches({ match: '^online' }, m));
  assert(!whatsappMatches({}, { ...m, group: true }) && whatsappMatches({ groups: 'yes' }, { ...m, group: true }));
});

test('flow: the ready chatbot answers online / report / help itself and anything else through Claude', async () => {
  const calls = [], sent = [];
  const io = { whatsapp: async (to, t) => sent.push([to, t]), editor: async (m, p, b) => { calls.push(p); return p === '/report/online' ? { text: 'ONLINE' } : p.startsWith('/report/today') ? { text: 'REPORT' } : { answer: `CLAUDE: ${b.question}` }; } };
  const flow = TEMPLATES.chatbot.flow;
  for (const [text, want] of [['online', 'ONLINE'], ['Report', 'REPORT'], ['kaun online hai?', 'ONLINE'], ['is hafte kisne zyada kaam kiya?', 'CLAUDE: is hafte kisne zyada kaam kiya?']]) {
    sent.length = 0;
    const r = await runFlow(flow, { from: '91', text, chat: '91@s.whatsapp.net' }, io);
    assert(r.ok, r.error); eq(sent, [['91@s.whatsapp.net', want]]);
  }
  sent.length = 0; await runFlow(flow, { text: 'help', chat: 'c' }, io);
  assert(sent[0][1].includes('Limelight bot'), 'help');
  const rep = await runFlow(TEMPLATES.report.flow, {}, { ...io, whatsapp: async (to, t) => sent.push([to, t]) }, { ownerPhone: '9198' });
  assert(rep.ok); eq(sent.at(-1), ['9198', 'REPORT']);
});

test('flow: Telegram - from chat ids or @usernames, groups only when asked; *bold* becomes HTML, the rest is escaped', async () => {
  const m = { from: '555123', username: 'Jaspreet_L', text: 'online', group: false };
  assert(telegramMatches({}, m) && telegramMatches({ from: '555123' }, m) && telegramMatches({ from: '111, @jaspreet_l' }, m));
  assert(!telegramMatches({ from: '111, @someone' }, m) && !telegramMatches({}, { ...m, group: true }));
  eq(toTelegramHtml('📊 *Limelight - Shanivar*\nA <b> & *x*'), '📊 <b>Limelight - Shanivar</b>\nA &lt;b&gt; &amp; <b>x</b>');
  const sent = [];
  const io = { telegram: async (to, t) => sent.push([to, t]), editor: async (m2, p) => (p === '/report/online' ? { text: 'ONLINE' } : { text: 'REPORT' }) };
  const r = await runFlow(TEMPLATES.tgChatbot.flow, { from: '555123', text: '/start', chat: '555123' }, io);
  assert(r.ok, r.error); assert(sent[0][0] === '555123' && sent[0][1].includes('Limelight bot'), '/start gets the help');
  await runFlow(TEMPLATES.tgReport.flow, {}, io, { ownerTelegram: '555123' });
  eq(sent.at(-1), ['555123', 'REPORT']);
});

// ---- the app itself
let flowSrv = null, fakeEditor = null, tmp = null;
const PORT = 3961, EPORT = 3962, B = `http://127.0.0.1:${PORT}`, TOKEN = 'test-report-token-123';
let cookie = '';
async function call(m, u, b, headers = {}) {
  const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', 'x-flow': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: b === undefined ? undefined : JSON.stringify(b) });
  const c = /lf_sess=[^;]+/.exec(r.headers.get('set-cookie') || ''); if (c) cookie = c[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('flow app: a password made on the PC itself, then signed in; nothing without it', async () => {
  if (!ON) return 'skip';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'limelight-flow-'));
  // (a stand-in editor: the report door with its token)
  fakeEditor = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('{"error":"Wrong report token"}'); }
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const out = req.url.startsWith('/report/online') ? { people: ['Amit'], text: '🟢 Abhi online (1): Amit' } : req.url.startsWith('/report/today') ? { text: '📊 report' } : { answer: `answer to ${JSON.parse(b).question}` };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  }).listen(EPORT, '127.0.0.1');
  flowSrv = spawn(process.execPath, [path.join(ROOT, 'flow', 'server.mjs'), '--port', String(PORT), '--data', tmp], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; flowSrv.stdout.on('data', (d) => { log += d; }); flowSrv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; ; i++) { try { await fetch(`${B}/api/me`); break; } catch {} if (i > 40) throw new Error(`flow did not start:\n${log}`); await new Promise((r) => setTimeout(r, 250)); }
  eq((await call('GET', '/api/me')).body, { setUp: false, signedIn: false, local: true });
  eq((await call('GET', '/api/flows')).status, 401);
  eq((await call('POST', '/api/setup', { password: 'short' })).status, 400);
  eq((await call('POST', '/api/setup', { password: 'flow-pass-123' })).status, 200);
  eq((await call('POST', '/api/setup', { password: 'another-123' })).status, 400, 'made once');
  cookie = ''; eq((await call('POST', '/api/login', { password: 'wrong-pass' })).status, 401);
  eq((await call('POST', '/api/login', { password: 'flow-pass-123' })).status, 200);
  eq((await call('GET', '/api/flows')).body, []);
  eq((await call('POST', '/api/flows', { name: 'x' }, { 'x-flow': '' })).status, 403, 'a change without the page\'s own header is refused');
});

test('flow app: the chatbot template, set up and switched on, answers a message (simulated) from the editor', async () => {
  if (!ON) return 'skip';
  eq((await call('PUT', '/api/settings', { editor: { url: `http://127.0.0.1:${EPORT}`, token: TOKEN }, vars: { ownerPhone: '919812345678' } })).body.editor.tokenSet, true);
  assert(!JSON.stringify((await call('GET', '/api/settings')).body).includes(TOKEN), 'the token is never shown again');
  eq((await call('POST', '/api/settings/test-editor')).body.online.people, ['Amit']);
  const f = (await call('POST', '/api/templates', { key: 'chatbot' })).body;
  eq(f.on, false);
  eq((await call('PUT', `/api/flows/${f.id}`, { ...f, on: true })).body.on, true);
  const a = (await call('POST', '/api/whatsapp', { action: 'simulate', text: 'online' })).body;
  eq(a.replies, ['🟢 Abhi online (1): Amit']);
  const q = (await call('POST', '/api/whatsapp', { action: 'simulate', text: 'aaj kaun late aaya?' })).body;
  eq(q.replies, ['answer to aaj kaun late aaya?']);
  eq((await call('POST', '/api/whatsapp', { action: 'simulate', from: '910000000', text: 'online' })).body.matched, [], 'another number is not answered');
  const runs = (await call('GET', '/api/runs')).body;
  assert(runs.length >= 2 && runs.every((r) => r.ok), 'the runs are kept');
});

test('flow app: the Telegram chatbot (simulated - no bot needed) answers its owner only', async () => {
  if (!ON) return 'skip';
  await call('PUT', '/api/settings', { vars: { ownerPhone: '919812345678', ownerTelegram: '555123' } });
  const f = (await call('POST', '/api/templates', { key: 'tgChatbot' })).body;
  await call('PUT', `/api/flows/${f.id}`, { ...f, on: true });
  eq((await call('POST', '/api/telegram', { action: 'simulate', text: 'online' })).body.replies, ['🟢 Abhi online (1): Amit']);
  eq((await call('POST', '/api/telegram', { action: 'simulate', from: '999', text: 'online' })).body.matched, []);
  eq((await call('POST', '/api/telegram', { action: 'token', token: 'not-a-token' })).status, 400);
  eq((await call('GET', '/api/telegram')).body.tokenSet, false);
});

test('flow app: a webhook flow runs on its secret address only', async () => {
  if (!ON) return 'skip';
  const f = (await call('POST', '/api/flows', { name: 'hook', on: true, trigger: { type: 'webhook' }, steps: [{ id: 'echo', type: 'code', params: { code: 'return trigger.query.text' } }] })).body;
  assert(f.trigger.key.length >= 12, 'a secret key is made');
  const r = await (await fetch(`${B}/hook/${f.trigger.key}?text=hello`)).json();
  eq(r, { ok: true, runs: [{ name: 'hook', ok: true, error: null }] });
  eq((await fetch(`${B}/hook/not-the-right-key`)).status, 404);
});

test('flow app: stop', async () => {
  if (!ON) return 'skip';
  flowSrv?.kill(); fakeEditor?.close();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
