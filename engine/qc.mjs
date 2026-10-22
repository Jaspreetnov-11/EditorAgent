// qc.mjs - 🧪 Auto QC of a finished video before it goes out (Phase 22).
// One FFmpeg pass over the file measures every frame (brightness, darkest / brightest pixel, colour) and the sound
// (loudness, true peak, silences); then qcReport() turns that into a list a person can act on, each line with a time:
//   black frames in the middle · a picture that freezes · flashing that can trigger seizures (photosensitive, Harding-like
//   rule: more than 3 flashes in any one second) · colours outside broadcast-safe range · loudness and peak against the
//   channel's rule (DD / broadcast EBU R128 -23, YouTube / Instagram -14, WhatsApp -16) · long silences · wrong shape / length.
// The spelling of the titles is checked separately (server: Claude), the result is merged in with addSpelling().
import { spawn } from 'node:child_process';

export const TARGETS = {
  broadcast: { name: 'Doordarshan / TV (EBU R128)', lufs: -23, tol: 1, tp: -1, safe: true, aspect: '16:9' },
  youtube: { name: 'YouTube', lufs: -14, tol: 1.5, tp: -1 },
  instagram: { name: 'Instagram / Facebook reel', lufs: -14, tol: 1.5, tp: -1, aspect: '9:16', maxDur: 180 },
  whatsapp: { name: 'WhatsApp', lufs: -16, tol: 2, tp: -1 },
};

function sh(cmd, args) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => ok({ code, out, err })); p.on('error', (e) => ok({ code: -1, out, err: String(e) }));
  });
}

// what the file is (shape, length, frame rate, does it have sound)
export async function probe(file) {
  const r = await sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file]);
  let j = {}; try { j = JSON.parse(r.out); } catch {}
  const v = (j.streams || []).find((s) => s.codec_type === 'video'), a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const [n, d] = String(v?.r_frame_rate || '25/1').split('/').map(Number);
  return { dur: +j.format?.duration || 0, w: v?.width || 0, h: v?.height || 0, fps: d ? n / d : 25, video: !!v, audio: !!a };
}

// the one pass; onPct(0..100) while it reads
export async function analyze(file, onPct) {
  const info = await probe(file);
  if (!info.video) throw new Error('This file has no picture');
  const v = '[0:v]scale=320:-2:flags=neighbor,blackdetect=d=0.25:pix_th=0.08,freezedetect=n=-55dB:d=2.5,signalstats=stat=brng,metadata=print[v]';
  const a = info.audio ? ';[0:a]ebur128=peak=true:framelog=quiet,silencedetect=n=-50dB:d=2.5[a]' : '';
  const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', file, '-filter_complex', v + a, '-map', '[v]', ...(info.audio ? ['-map', '[a]'] : []), '-f', 'null', '-'];
  const p = spawn('ffmpeg', args, { windowsHide: true });
  const frames = [], black = [], freeze = [], silence = [];
  let cur = null, err = '', tail = '', open = {};
  const line = (l) => {
    let m;
    if ((m = /pts_time:([\d.]+)/.exec(l)) && /^\[Parsed_metadata/.test(l)) { cur = { t: +m[1] }; frames.push(cur); return; }
    if (cur && (m = /lavfi\.signalstats\.(YAVG|YMIN|YMAX|SATMAX|BRNG)=([\d.]+)/.exec(l))) { cur[m[1]] = +m[2]; return; }
    if ((m = /black_start:([\d.]+) black_end:([\d.]+)/.exec(l))) return void black.push({ s: +m[1], e: +m[2] });
    if ((m = /freeze_start: ([\d.]+)/.exec(l))) return void (open.freeze = +m[1]);
    if ((m = /freeze_end: ([\d.]+)/.exec(l))) { freeze.push({ s: open.freeze ?? 0, e: +m[1] }); open.freeze = null; return; }
    if ((m = /silence_start: (-?[\d.]+)/.exec(l))) return void (open.silence = Math.max(0, +m[1]));
    if ((m = /silence_end: ([\d.]+)/.exec(l))) { silence.push({ s: open.silence ?? 0, e: +m[1] }); open.silence = null; }
  };
  p.stderr.on('data', (d) => {
    const s = tail + d; const ls = s.split(/\r?\n/); tail = ls.pop();
    for (const l of ls) line(l);
    err = (err + d).slice(-20000);
  });
  p.stdout.on('data', (d) => { const m = /out_time_us=(\d+)/.exec(String(d)); if (m && info.dur) onPct?.(Math.min(99, Math.round((+m[1] / 1e6 / info.dur) * 100))); });
  const code = await new Promise((ok) => { p.on('close', ok); p.on('error', () => ok(-1)); });
  if (tail) line(tail);
  if (code !== 0 && !frames.length) throw new Error(`Could not read the file: ${err.trim().split(/\r?\n/).pop()}`);
  // still open at the end of the file
  if (open.freeze != null) freeze.push({ s: open.freeze, e: info.dur });
  if (open.silence != null) silence.push({ s: open.silence, e: info.dur });
  const sum = err.slice(err.lastIndexOf('Summary:'));
  const num = (re) => { const x = re.exec(sum); return x ? +x[1] : null; };
  const loud = info.audio ? { I: num(/I:\s*(-?[\d.]+) LUFS/), LRA: num(/LRA:\s*(-?[\d.]+) LU/), TP: num(/Peak:\s*(-?[\d.]+) dBFS/) } : null;
  return { info, frames, black, freeze, silence, loud };
}

// ⚡ photosensitive flashing: brightness turned into (roughly) light on the screen, then every swing of 10 % or more of
// full white (with the darker side below 80 %) is one transition; two transitions = one flash. More than 3 flashes in
// any one second fails (the ITU / Ofcom / Harding rule). Whole-frame average, so small flashing areas are missed.
export function flashes(frames) {
  const L = frames.map((f) => ({ t: f.t, l: Math.pow(Math.max(0, Math.min(1, ((f.YAVG ?? 0) - 16) / 219)), 2.2) }));
  const tr = []; // times of transitions
  let ext = L[0], dir = 0;
  for (const p of L.slice(1)) {
    if ((dir === 1 && p.l >= ext.l) || (dir === -1 && p.l <= ext.l)) { ext = p; continue; } // still going the same way
    const d = p.l - ext.l;
    if (Math.abs(d) >= 0.1 && Math.min(p.l, ext.l) < 0.8) { tr.push(p.t); dir = d > 0 ? 1 : -1; ext = p; }
  }
  const bad = [];
  for (let i = 0, j = 0; i < tr.length; i++) {
    while (tr[i] - tr[j] > 1) j++;
    if (i - j + 1 > 6) { const s = tr[j]; if (!bad.length || s > bad[bad.length - 1].e) bad.push({ s, e: tr[i] }); else bad[bad.length - 1].e = tr[i]; }
  }
  return bad;
}

// runs of frames that break a rule, joined into time ranges (gap = frames apart that still count as one run)
function runs(frames, test, gap = 0.5) {
  const out = [];
  for (const f of frames) if (test(f)) { const r = out[out.length - 1]; if (r && f.t - r.e <= gap) r.e = f.t; else out.push({ s: f.t, e: f.t }); }
  return out;
}
const tc = (t) => { const s = Math.max(0, t); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`; };
const span = (r) => (r.e - r.s >= 0.15 ? `${tc(r.s)}-${tc(r.e)}` : tc(r.s));
const list = (rs, n = 4) => rs.slice(0, n).map(span).join(', ') + (rs.length > n ? ` and ${rs.length - n} more` : '');

// a: analyze() result; o = { target: key of TARGETS, aspect: '16:9', maxDur, titles: [{ text, t }] }
// -> { items: [{ level: 'fail' | 'warn' | 'ok', kind, text, t }], counts, target }
export function qcReport(a, o = {}) {
  const T = TARGETS[o.target] || TARGETS.youtube, items = [], add = (level, kind, text, t) => items.push({ level, kind, text, ...(t != null ? { t: +t.toFixed(2) } : {}) });
  const { info } = a, D = info.dur;

  // shape and length
  const aspect = T.aspect || o.aspect, maxDur = T.maxDur || o.maxDur;
  if (aspect) {
    const [x, y] = aspect.split(':').map(Number), want = x / y, got = info.w / info.h;
    if (Math.abs(want - got) > 0.02) add('fail', 'shape', `The video is ${info.w}×${info.h}, but ${T.aspect ? 'this channel' : 'the project'} wants ${aspect}`);
  }
  if (maxDur && D > maxDur + 0.5) add('fail', 'length', `${tc(D)} long - this channel allows ${tc(maxDur)}`);

  // ⬛ black: a little at the very start / end is fine; anything else is a hole in the edit
  const mid = a.black.filter((b) => b.s > 0.3 && b.e < D - 0.3);
  const head = a.black.find((b) => b.s <= 0.3), foot = a.black.find((b) => b.e >= D - 0.3);
  if (mid.length) add('fail', 'black', `Black frames in the middle: ${list(mid)} - a gap or a missing clip?`, mid[0].s);
  if (head && head.e > 1) add('warn', 'black', `Starts with ${(head.e - head.s).toFixed(1)} s of black`, 0);
  if (foot && foot.e - foot.s > 2.5) add('warn', 'black', `Ends with ${(foot.e - foot.s).toFixed(1)} s of black`, foot.s);

  // 🧊 frozen picture (a still or a title card is fine - look at it)
  const fr = a.freeze.filter((f) => f.e - f.s >= 2.5 && !a.black.some((b) => b.s <= f.s + 0.1 && b.e >= f.e - 0.1));
  if (fr.length) add('warn', 'freeze', `Picture does not move for ${fr.length > 1 ? 'a while' : `${(fr[0].e - fr[0].s).toFixed(1)} s`}: ${list(fr)} (fine for a photo or title card; a stuck video otherwise)`, fr[0].s);

  // ⚡ flashing
  const fl = flashes(a.frames);
  if (fl.length) add(T.safe ? 'fail' : 'warn', 'flash', `Fast flashing (more than 3 flashes in a second) at ${list(fl)} - can trigger seizures; TV channels reject it`, fl[0].s);

  // 🎨 broadcast-safe: luma 16-235 and not over-saturated (only a rule for TV; on the web it is a note)
  const n = a.frames.length || 1;
  // (BRNG = the share of a frame's pixels outside the legal range; a few stray pixels do not count)
  const out = (f) => (f.BRNG ?? 0) > 0.01, lumaBad = runs(a.frames, out), satBad = runs(a.frames, (f) => f.SATMAX > 125);
  const pl = Math.round((a.frames.filter(out).length / n) * 100);
  if (lumaBad.length) add(T.safe ? (pl > 5 ? 'fail' : 'warn') : 'ok', 'safe', `Picture outside broadcast-safe range (more than 1% of the pixels) in ${pl}% of frames: ${list(lumaBad, 3)}${T.safe ? ' - use the Video Limiter / Broadcast-safe look' : ' (fine for the web)'}`, lumaBad[0].s);
  if (satBad.length) add(T.safe ? 'warn' : 'ok', 'safe', `Very strong colour (may bleed on TV): ${list(satBad, 3)}`, satBad[0].s);

  // 🔊 sound
  if (!a.loud) add(o.silentOk ? 'ok' : 'warn', 'audio', 'The video has no sound track');
  else {
    const { I, TP } = a.loud;
    if (I == null || I < -60) add('fail', 'audio', 'The sound is silent');
    else if (Math.abs(I - T.lufs) > T.tol) add(Math.abs(I - T.lufs) > T.tol * 3 ? 'fail' : 'warn', 'loud', `Loudness ${I.toFixed(1)} LUFS - ${T.name} wants ${T.lufs} LUFS (${I > T.lufs ? 'too loud' : 'too quiet'}; set Loudness in Deliver)`);
    else add('ok', 'loud', `Loudness ${I.toFixed(1)} LUFS - right for ${T.name}`);
    if (TP != null && TP > T.tp) add(TP > 0 ? 'fail' : 'warn', 'peak', `Peaks reach ${TP.toFixed(1)} dBTP (limit ${T.tp}) - it can crackle / distort`);
    const gaps = a.silence.filter((s) => s.s > 0.5 && s.e < D - 0.5);
    if (gaps.length) add('warn', 'silence', `No sound for a while: ${list(gaps)}`, gaps[0].s);
  }

  // what passed (so the report says what was looked at)
  const looked = { black: '⬛ No black holes', freeze: '🧊 No stuck picture', flash: '⚡ No dangerous flashing', safe: '🎨 Colours broadcast-safe', shape: '📐 Shape is right' };
  for (const [k, txt] of Object.entries(looked)) if (!items.some((i) => i.kind === k && i.level !== 'ok')) add('ok', k, txt);
  return finish(items, T);
}

function finish(items, T) {
  const order = { fail: 0, warn: 1, ok: 2 };
  items.sort((x, y) => order[x.level] - order[y.level] || (x.t ?? 1e9) - (y.t ?? 1e9));
  const counts = { fail: 0, warn: 0, ok: 0 }; items.forEach((i) => counts[i.level]++);
  return { items, counts, target: T.name };
}

// ✍ spelling: titles (with their times) -> a prompt; Claude answers JSON
export function spellPrompt(titles) {
  return `You check the on-screen text of a finished video from an Indian government-communication agency before it is published.
Text may be Hindi (Devanagari), English or Hinglish. Find real mistakes only: spelling, wrong matra / halant, wrong or missing
words, wrong official names (ministries, schemes, places, designations like "Hon'ble"), inconsistent spelling of the same name.
Do not report style choices, capitalisation of headlines or missing full stops.
Answer ONLY with JSON: {"mistakes":[{"i":<index>,"wrong":"...","right":"...","why":"short reason"}]} - empty list if all is fine.

${titles.map((t, i) => `[${i}] ${String(t.text).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}`;
}
export function addSpelling(report, titles, answer) {
  let j = null;
  try { j = JSON.parse(String(answer).slice(String(answer).indexOf('{'), String(answer).lastIndexOf('}') + 1)); } catch {}
  if (!j) report.items.push({ level: 'warn', kind: 'spell', text: '✍ Spelling could not be checked (Claude did not answer)' });
  else if (!j.mistakes?.length) report.items.push({ level: 'ok', kind: 'spell', text: `✍ Spelling of ${titles.length} title${titles.length > 1 ? 's' : ''} looks right` });
  else for (const m of j.mistakes) {
    const t = titles[m.i];
    report.items.push({ level: 'fail', kind: 'spell', text: `✍ "${m.wrong}" → "${m.right}"${m.why ? ` (${m.why})` : ''}${t ? ` in "${String(t.text).slice(0, 60)}"` : ''}`, ...(t?.t != null ? { t: t.t } : {}) });
  }
  return finish(report.items, { name: report.target });
}
