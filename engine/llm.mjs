// llm.mjs - a small local language model for the Agent (understanding the editor's words, title / end-card wording).
// llama.cpp `llama-server` (CUDA build, tools/llama/bin) with Qwen2.5-7B-Instruct Q4_K_M (Models/llm), on 127.0.0.1:8085.
// Started on first use, stopped after 5 min idle and when this process exits. Only part of the model goes on the GPU so it
// fits beside the vision / whisper work (the rest runs on the CPU); without a usable GPU it runs on the CPU alone.
// Never required: available() is false when it is not installed, and json() / text() / titles() return null on any
// failure instead of throwing - every caller has its own way without it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// (a helper / standby PC has no tools or Models folder: "Setup AI on this PC.bat" copies them from the NAS to
// %LOCALAPPDATA%\Limelight\AI - looked at when the editor's own copy is not there)
const LOCAL_AI = path.join(process.env.LOCALAPPDATA || '', 'Limelight', 'AI');
const pick = (...c) => c.find((f) => fs.existsSync(f)) || c[0];
const BIN_DIR = process.env.LLAMA_DIR || pick(path.join(ROOT, 'tools', 'llama', 'bin'), path.join(LOCAL_AI, 'llama', 'bin'));
const MODEL = process.env.LLM_MODEL || pick(path.join(ROOT, 'Models', 'llm', 'Qwen2.5-7B-Instruct-Q4_K_M.gguf'), path.join(LOCAL_AI, 'llm', 'Qwen2.5-7B-Instruct-Q4_K_M.gguf'));
const HOST = '127.0.0.1', PORT = +process.env.LLM_PORT || 8085, BASE = `http://${HOST}:${PORT}`;
const RUN_DIR = path.dirname(BIN_DIR); // (tools/llama, or the helper's copy - the pid and log live beside the binaries)
const PID_FILE = path.join(RUN_DIR, 'llama-server.pid');
const LOG_FILE = path.join(RUN_DIR, 'llama-server.log');
const IDLE_MS = +process.env.LLM_IDLE_MS || 5 * 60 * 1000;
const CTX = 4096;
// GPU memory, measured on the RTX 4060 (b11846, -c 4096): CUDA context + compute buffers ~300 MB with no layers on the
// GPU, the output layer (offloaded first) ~450 MB, then ~141 MB per block incl. its KV cache; 28 blocks + output = 29.
// -ngl 20 = ~3.4 GB, which leaves ~3 GB beside the desktop for SigLIP / whisper / demucs. Fewer layers when less is free
// right now, so that GPU_KEEP_MB stays free for the work that comes next; 0 = CPU only.
const LAYERS = 29, NGL_MAX = process.env.LLM_NGL !== undefined ? +process.env.LLM_NGL : 20;
const GPU_KEEP_MB = +process.env.LLM_GPU_KEEP_MB || 2000;
const gpuNeedMB = (ngl) => 300 + (ngl > 0 ? 450 + 141 * (ngl - 1) : 0);

const exe = () => path.join(BIN_DIR, 'llama-server.exe');
let child = null, starting = null, idleTimer = null, mode = null, lastErr = '', adoptedPid = 0, ngl = 0;
// a key per start: llama-server allows any origin, so without it any web page open in a browser could use the model
let key = '';

export function available() {
  try { return fs.existsSync(exe()) && fs.statSync(MODEL).size > 1e9; } catch { return false; }
}
export const lastError = () => lastErr;
export const status = () => ({ installed: available(), running: !!(child || adoptedPid), mode, port: PORT, model: path.basename(MODEL) });

// free MB on the GPU (nvidia-smi), or -1 when there is no NVIDIA GPU / driver
function gpuFreeMB() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    return parseInt(out.split('\n')[0], 10);
  } catch { return -1; }
}
// layers on the GPU: as many as fit while GPU_KEEP_MB stays free, at most NGL_MAX; 0 = CPU only
function pickLayers() {
  const free = gpuFreeMB();
  if (free < 0) return 0;
  let n = Math.min(NGL_MAX, LAYERS);
  while (n > 0 && gpuNeedMB(n) > free - GPU_KEEP_MB) n--;
  return n;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const auth = () => (key ? { authorization: `Bearer ${key}` } : {});
async function healthy(ms = 1500) {
  try { const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(ms) }); return r.ok; } catch { return false; }
}

function killPid(pid) {
  try { process.kill(pid); } catch {}
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); } catch {}
}
function isLlama(pid) {
  try { return /llama-server/i.test(execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })); } catch { return false; }
}

function launch(ngl) {
  const args = ['-m', MODEL, '--host', HOST, '--port', String(PORT), '-c', String(CTX), '-np', '1', '--no-webui',
    '-ngl', String(ngl), '-t', String(Math.max(2, Math.min(8, os.availableParallelism() - 2)))];
  if (!ngl) args.push('--device', 'none'); // CPU only: no CUDA context at all
  key = crypto.randomBytes(16).toString('hex');
  args.push('--api-key', key);
  let log = 'ignore';
  try { log = fs.openSync(LOG_FILE, 'a'); fs.writeSync(log, `\n--- ${new Date().toISOString()} start -ngl ${ngl}\n`); } catch {}
  const p = spawn(exe(), args, { cwd: BIN_DIR, windowsHide: true, stdio: ['ignore', log, log] });
  if (typeof log === 'number') fs.closeSync(log);
  try { fs.writeFileSync(PID_FILE, JSON.stringify({ pid: p.pid, key, ngl })); } catch {}
  p.exited = false;
  p.on('exit', () => { p.exited = true; if (child === p) { child = null; mode = null; } });
  p.on('error', (e) => { p.exited = true; lastErr = e.message; });
  return p;
}
async function waitReady(p, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (p.exited) return false;
    if (await healthy()) return true;
    await sleep(400);
  }
  return false;
}

// starts the server (or uses one already listening on the port), resolves true when it answers
async function ensure() {
  if (!available()) { lastErr = 'not installed'; return false; }
  if ((child && !child.exited) || adoptedPid) { if (await healthy(3000)) return true; }
  if (starting) return starting;
  starting = (async () => {
    // one left over from an earlier run of the editor (killed hard, so its exit hook never ran): use it
    if (await healthy()) {
      let was = {}; try { was = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch {}
      if (was.pid && isLlama(was.pid)) {
        key = was.key || ''; ngl = was.ngl || 0;
        const ok = await fetch(`${BASE}/v1/models`, { headers: auth(), signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
        if (ok) { adoptedPid = was.pid; mode = ngl ? `gpu ${ngl}/${LAYERS} layers` : 'cpu'; return true; }
        killPid(was.pid); await sleep(1500);
      } else { lastErr = `port ${PORT} is used by another program`; return false; }
    }
    ngl = pickLayers();
    child = launch(ngl); mode = ngl ? `gpu ${ngl}/${LAYERS} layers` : 'cpu';
    if (await waitReady(child, 180000)) return true;
    // the CUDA start failed (out of GPU memory, driver): once more on the CPU
    if (child) killPid(child.pid);
    if (ngl) {
      ngl = 0; child = launch(0); mode = 'cpu';
      if (await waitReady(child, 240000)) return true;
      if (child) killPid(child.pid);
    }
    child = null; mode = null; lastErr = 'llama-server did not start (see tools/llama/llama-server.log)';
    return false;
  })();
  try { return await starting; } finally { starting = null; }
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_MS);
  idleTimer.unref?.(); // an idle model never keeps node alive
}
export function stop() {
  clearTimeout(idleTimer); idleTimer = null;
  if (child && !child.exited) killPid(child.pid);
  if (adoptedPid) killPid(adoptedPid);
  child = null; adoptedPid = 0; mode = null;
  try { fs.unlinkSync(PID_FILE); } catch {}
}
process.on('exit', () => { if (child && !child.exited) killPid(child.pid); });

// one chat call (OpenAI-compatible). schema: a JSON schema the answer must follow (llama.cpp turns it into a grammar).
async function chat(messages, { maxTokens = 512, temperature = 0.2, schema = null, timeoutMs = 60000 } = {}) {
  if (!(await ensure())) return null;
  touch();
  const body = { messages, max_tokens: maxTokens, temperature, top_p: 0.9, cache_prompt: true };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } };
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) { lastErr = `llm ${r.status}: ${(await r.text()).slice(0, 200)}`; return null; }
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? null;
  } catch (e) { lastErr = e.message; return null; }
  finally { touch(); }
}

const SYS = 'You are the assistant of a video editing app used in India. Answer briefly and exactly as asked.';
const msgs = (prompt, system) => [{ role: 'system', content: system || SYS }, { role: 'user', content: prompt }];

// prompt -> parsed JSON following the schema, or null
export async function json(prompt, schema, { maxTokens = 512, system = null, timeoutMs = 60000, temperature = 0.1 } = {}) {
  const out = await chat(msgs(prompt, system), { maxTokens, schema, timeoutMs, temperature });
  if (!out) return null;
  try { return JSON.parse(out); } catch { lastErr = 'bad JSON from the model'; return null; }
}
// prompt -> plain text, or null
export async function text(prompt, { maxTokens = 512, system = null, timeoutMs = 60000, temperature = 0.4 } = {}) {
  const out = await chat(msgs(prompt, system), { maxTokens, timeoutMs, temperature });
  return out == null ? null : out.trim();
}

const DEV = /[ऀ-ॿ]/;
const LANG = {
  hi: 'Hindi in Devanagari script only (no English letters, except names like MY Bharat or a web address)',
  en: 'English',
  hinglish: 'Hinglish: Hindi written in Roman letters',
};
// title / end card / lower-third wording for an edit: { title: [..], endCard: [..], lowerThirds: [..] } or null
export async function titles({ topic = '', lines = [], lang = 'hi', count = 3 } = {}) {
  const L = LANG[lang] || LANG.en;
  const ctx = (Array.isArray(lines) ? lines : [lines]).filter(Boolean).map(String).slice(0, 30).join('\n').slice(0, 2500);
  const schema = {
    type: 'object', additionalProperties: false, required: ['title', 'endCard', 'lowerThirds'],
    properties: {
      title: { type: 'array', items: { type: 'string', maxLength: 60 }, minItems: 1, maxItems: count },
      endCard: { type: 'array', items: { type: 'string', maxLength: 70 }, minItems: 1, maxItems: count },
      lowerThirds: { type: 'array', items: { type: 'string', maxLength: 50 }, minItems: 0, maxItems: count },
    },
  };
  const prompt = `Write on-screen text for a short video.
Topic: ${topic || '(see the lines)'}
${ctx ? `What is said / shown in the video:\n${ctx}\n` : ''}
Give ${count} options each for:
- title: the opening title, 2 to 6 words, strong and simple
- endCard: the closing line (a message, a call to action or a thank you), at most 8 words
- lowerThirds: short name / place / scheme captions taken from the lines (empty when there are none)
Language: ${L}. No emojis, no hashtags, no quotes around the text.`;
  const out = await json(prompt, schema, { maxTokens: 400, temperature: 0.3 });
  if (!out) return null;
  const clean = (a) => [...new Set((a || []).map((s) => String(s).replace(/["“”#]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean))]
    .filter((s) => lang !== 'hi' || DEV.test(s));
  const r = { title: clean(out.title), endCard: clean(out.endCard), lowerThirds: clean(out.lowerThirds) };
  return r.title.length || r.endCard.length ? r : null;
}
