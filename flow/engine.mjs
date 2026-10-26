// engine.mjs - ⚡ Limelight Flow's engine: runs a flow - its trigger's data, then its steps one after another, each one's
// answer kept for the next ones. A flow: { id, name, on, trigger: { type, ... }, steps: [{ id, type, name, if, params }] }.
//   Expressions: any text in a step's settings may hold {{ ... }} - a JavaScript expression over trigger (what started the
//   run), steps (each earlier step's answer, by id), vars (Settings > Variables) and now; a setting that is only one
//   {{ ... }} gets its value as it is (a list, a number), not as text.
//   if: an expression - false skips the step. A "stop" step ends the run there (with its if: only when it is true).
// Steps do their work through `io` (server.mjs): the editor, WhatsApp, the network - so this file runs on its own in
// the tests.
import vm from 'node:vm';

export const STEP_TYPES = {
  'limelight.report': { label: 'Editor: day report', fields: [['day', 'Day (YYYY-MM-DD, empty = today)']] },
  'limelight.online': { label: 'Editor: who is online', fields: [] },
  'limelight.ask': { label: 'Editor: ask Claude', fields: [['question', 'Question', 'area']] },
  'telegram.send': { label: 'Telegram: send', fields: [['to', 'To (chat ids, comma separated - shown on the Telegram page)'], ['text', 'Message', 'area']] },
  'whatsapp.send': { label: 'WhatsApp: send', fields: [['to', 'To (numbers with country code, or a group, comma separated)'], ['text', 'Message', 'area']] },
  text: { label: 'Text: write a message', fields: [['text', 'Text', 'area']] },
  code: { label: 'Code (JavaScript)', fields: [['code', 'Code - return what the next steps get', 'code']] },
  http: { label: 'HTTP request', fields: [['method', 'Method (GET, POST…)'], ['url', 'URL'], ['headers', 'Headers (JSON)', 'area'], ['body', 'Body', 'area']] },
  wait: { label: 'Wait', fields: [['seconds', 'Seconds']] },
  stop: { label: 'Stop here', fields: [] },
  log: { label: 'Note in the run', fields: [['message', 'Message']] },
};
export const TRIGGER_TYPES = {
  manual: { label: 'Only by hand (Run now)', fields: [] },
  schedule: { label: 'On a schedule', fields: [['at', 'Every day at (HH:MM, several: 09:00, 22:00)'], ['days', 'Days (0 = Sunday … 6, empty = every day)'], ['every', 'Or every … minutes']] },
  webhook: { label: 'Webhook (another program calls it)', fields: [['key', 'Secret key (made for you)']] },
  telegram: { label: 'A Telegram message comes (to your bot)', fields: [['from', 'Only from (chat ids or @usernames, comma separated; empty = anyone)'], ['match', 'Only messages matching (regular expression, empty = all)'], ['groups', 'Also in groups (yes / no)']] },
  whatsapp: { label: 'A WhatsApp message comes', fields: [['from', 'Only from (numbers, comma separated; empty = anyone)'], ['match', 'Only messages matching (regular expression, empty = all)'], ['groups', 'Also in groups (yes / no)']] },
};

// ---- {{ expressions }}
const EXPR = /\{\{([\s\S]+?)\}\}/g;
function evalExpr(src, ctx) {
  try { return vm.runInNewContext(`(${src})`, { ...ctx, JSON, Math, Date, String, Number, Array, Object }, { timeout: 500 }); }
  catch (e) { throw new Error(`{{${src.trim()}}}: ${e.message}`); }
}
export function render(v, ctx) {
  if (typeof v === 'string') {
    const whole = /^\s*\{\{([\s\S]+?)\}\}\s*$/.exec(v);
    if (whole && !whole[1].includes('}}')) return evalExpr(whole[1], ctx);
    return v.replace(EXPR, (_, e) => { const r = evalExpr(e, ctx); return r == null ? '' : typeof r === 'object' ? JSON.stringify(r) : String(r); });
  }
  if (Array.isArray(v)) return v.map((x) => render(x, ctx));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, render(x, ctx)]));
  return v;
}

// ---- the steps
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const RUNNERS = {
  'limelight.report': (p, io) => io.editor('GET', `/report/today${p.day ? `?day=${encodeURIComponent(p.day)}` : ''}`),
  'limelight.online': (p, io) => io.editor('GET', '/report/online'),
  'limelight.ask': (p, io) => { if (!String(p.question || '').trim()) throw new Error('No question'); return io.editor('POST', '/report/ask', { question: String(p.question) }); },
  'whatsapp.send': async (p, io) => {
    const to = (Array.isArray(p.to) ? p.to : String(p.to || '').split(/[,;\n]/)).map((x) => String(x).trim()).filter(Boolean);
    if (!to.length) throw new Error('Nobody to send to');
    if (!String(p.text || '').trim()) throw new Error('No message');
    for (const t of to) await io.whatsapp(t, String(p.text));
    return { sent: to.length, to };
  },
  'telegram.send': async (p, io) => {
    const to = (Array.isArray(p.to) ? p.to : String(p.to || '').split(/[,;\n]/)).map((x) => String(x).trim()).filter(Boolean);
    if (!to.length) throw new Error('Nobody to send to');
    if (!String(p.text || '').trim()) throw new Error('No message');
    for (const t of to) await io.telegram(t, String(p.text));
    return { sent: to.length, to };
  },
  text: (p) => ({ text: String(p.text ?? '') }),
  code: (p, io, ctx) => {
    const fn = vm.runInNewContext(`(function () { ${p.code || ''}\n})`, { ...ctx, JSON, Math, Date, String, Number, Array, Object, RegExp, console: { log: (...a) => ctx.$log(a.map(String).join(' ')) } }, { timeout: 2000 });
    return fn();
  },
  http: async (p, io) => {
    const headers = typeof p.headers === 'string' && p.headers.trim() ? JSON.parse(p.headers) : p.headers && typeof p.headers === 'object' ? p.headers : {};
    const method = String(p.method || 'GET').toUpperCase(), body = p.body == null || p.body === '' || method === 'GET' ? undefined : typeof p.body === 'string' ? p.body : JSON.stringify(p.body);
    return io.http(String(p.url || ''), { method, headers, body });
  },
  wait: async (p) => { await sleep(Math.min(3600, Math.max(0, +p.seconds || 0)) * 1000); return { waited: +p.seconds || 0 }; },
  stop: () => ({ stopped: true }),
  log: (p, io, ctx) => { ctx.$log(String(p.message ?? '')); return { message: String(p.message ?? '') }; },
};

const short = (v) => { try { const s = JSON.stringify(v); return s && s.length > 4000 ? `${s.slice(0, 4000)}…` : v; } catch { return String(v); } };

// one run of a flow: { ok, error, ms, steps: [{ id, name, type, ok, skipped, ms, out, error }], log }
export async function runFlow(flow, trigger, io, vars = {}) {
  const t0 = Date.now(), steps = {}, out = [], log = [];
  const ctx = { trigger, steps, vars, now: new Date(), $log: (m) => log.push(m) };
  let error = null;
  for (const st of flow.steps || []) {
    const s0 = Date.now(), rec = { id: st.id, name: st.name || STEP_TYPES[st.type]?.label || st.type, type: st.type };
    out.push(rec);
    try {
      if (!RUNNERS[st.type]) throw new Error(`Unknown step "${st.type}"`);
      if (st.if && String(st.if).trim() && !evalExpr(String(st.if).replace(/^\s*\{\{([\s\S]*)\}\}\s*$/, '$1'), ctx)) { rec.skipped = true; rec.ok = true; continue; }
      const res = await RUNNERS[st.type](render(st.params || {}, ctx), io, ctx);
      steps[st.id] = res; rec.ok = true; rec.out = short(res); rec.ms = Date.now() - s0;
      if (st.type === 'stop') break;
    } catch (e) {
      rec.ok = false; rec.error = String(e.message || e).slice(0, 500); rec.ms = Date.now() - s0;
      error = `${rec.name}: ${rec.error}`;
      if (!st.goOn) break; // (a step marked "carry on if it fails" lets the run go on)
    }
  }
  return { ok: !error, error, ms: Date.now() - t0, steps: out, log };
}

// ---- schedules: is a schedule trigger due at minute `d` (local time)? every: N minutes counted from midnight
export function dueAt(tr, d) {
  const days = String(tr.days ?? '').split(/[,\s]+/).filter((x) => x !== '').map(Number);
  if (days.length && !days.includes(d.getDay())) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  if (+tr.every > 0) return mins % Math.round(+tr.every) === 0;
  return String(tr.at || '').split(/[,\s]+/).filter(Boolean).some((t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m && +m[1] * 60 + +m[2] === mins; });
}

// ---- WhatsApp: does a message start this flow? msg: { from (number), text, group }
export function whatsappMatches(tr, msg) {
  if (msg.group && !/^y/i.test(String(tr.groups || ''))) return false;
  const from = String(tr.from || '').split(/[,;\n]+/).map((x) => x.replace(/\D/g, '')).filter(Boolean);
  if (from.length && !from.includes(String(msg.from || '').replace(/\D/g, ''))) return false;
  if (String(tr.match || '').trim()) { try { if (!new RegExp(tr.match, 'i').test(msg.text || '')) return false; } catch { return false; } }
  return true;
}

// ---- Telegram: does a message start this flow? msg: { from (user id), username, text, group }
export function telegramMatches(tr, msg) {
  if (msg.group && !/^y/i.test(String(tr.groups || ''))) return false;
  const from = String(tr.from || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (from.length && !from.some((f) => f === String(msg.from) || (f.startsWith('@') && f.slice(1) === String(msg.username || '').toLowerCase()))) return false;
  if (String(tr.match || '').trim()) { try { if (!new RegExp(tr.match, 'i').test(msg.text || '')) return false; } catch { return false; } }
  return true;
}
