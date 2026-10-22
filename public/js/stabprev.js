// 🎥 Stabilised shots on the monitor, like Premiere's Warp Stabilizer: when a shot gets the Warp Stabilizer (or the
// simple Stabilize), the server makes a stabilised copy of the part of the file it uses in the background (POST
// /api/stab - the same vid.stab settings as the export, effects.js stabOf). Until it is there the monitor plays the
// shot as it is and says "Analysing in background"; then it plays the copy. Changing the settings or a bigger trim
// asks for a new copy; the old ones stay in the project's cache for undo.
import { S, emit } from './store.js';
import { api, enc, watchJob } from './api.js';
import { stabOf } from './effects.js';

const made = new Map(); // key -> { status: 'making' | 'ready' | 'error', progress, stage, url, a }

// the part of the file to stabilise: the shot's In..Out with a second either side (whole seconds, so a small trim
// keeps the same copy)
function span(c, m) {
  const end = c.out ?? m.duration ?? 0;
  return [Math.max(0, Math.floor(c.in || 0) - 1), Math.min(m.duration || end + 1, Math.ceil(end) + 1)];
}

// the shot's stabilised copy: null when it is not stabilised (or not a video); else its state - asked for the first
// time it is needed. ready: { url, a } (a = where the copy starts in the file)
export function stabState(c, m) {
  const so = m?.kind === 'video' && !S.readOnly ? stabOf(c) : null;
  if (!so) return null;
  const [a, b] = span(c, m), key = `${S.proj}|${m.id}|${a}|${b}|${so.key}`;
  let st = made.get(key);
  if (!st) { st = { status: 'making', progress: 0, stage: 'Analysing in background…', a }; made.set(key, st); make(st, c, m, a, b); }
  return st;
}

async function make(st, c, m, a, b) {
  try {
    const r = await api('POST', `/api/stab?p=${enc(S.proj)}`, { clip: { mediaId: m.id, effects: c.effects, stabilize: c.stabilize }, a, b });
    const res = r.ready ? r : (await watchJob(r.job, (j) => { st.progress = j.progress || 0; st.stage = j.stage || st.stage; emit('live'); })).result;
    Object.assign(st, { status: 'ready', url: `/api/stab/file?p=${enc(S.proj)}&f=${enc(res.file)}`, a: res.a });
  } catch (e) {
    st.status = 'error'; st.stage = e.job ? e.job.log.slice(-1).join(' ') : e.message; // (the export still stabilises)
  }
  emit('live'); // the monitor draws the shot again - now from the copy
}

// what the monitor's banner says for a shot being stabilised (null: nothing to say)
export function stabBanner(st) {
  if (!st || st.status === 'ready') return null;
  if (st.status === 'error') return `🎥 Stabilizer: ${st.stage || 'could not stabilise'} - Accurate preview and the export still stabilise it`;
  return `🎥 ${/1 of 2|shake/.test(st.stage) ? 'Analysing in background' : st.stage}${st.progress ? ` ${st.progress}%` : ''}`;
}
