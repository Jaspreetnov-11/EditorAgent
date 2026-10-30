// 🥁 Beat maker (Audio page): an FL Studio-style step sequencer with a simple face - 8 sounds x 16 steps, BPM, swing,
// a key for the bass, ready patterns, play / stop. Every sound is made right here (Web Audio synthesis - no sample
// files). "Add to timeline" renders the loop (repeated to the bars asked for) to a WAV, puts it in the project's Media
// (bin Music) and on A3 at the playhead. The pattern is kept per project in this browser.
import { S, commit } from './store.js';
import { uploadFile } from './api.js';
import { uid } from './model.js';
import { refreshMedia } from './mediapool.js';
import { $, $$, esc, toast } from './ui.js';

const STEPS = 16;
const SOUNDS = [
  { id: 'kick', name: 'Kick', color: '#ff6369' },
  { id: 'snare', name: 'Snare', color: '#ffc21a' },
  { id: 'clap', name: 'Clap', color: '#ff8a3d' },
  { id: 'hat', name: 'Hi-hat', color: '#3ddc84' },
  { id: 'open', name: 'Open hat', color: '#2dd4bf' },
  { id: 'tom', name: 'Tom', color: '#5b8cff' },
  { id: 'perc', name: 'Perc', color: '#c084fc' },
  { id: 'bass', name: 'Bass', color: '#f472b6' },
];
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// ready patterns: one string per sound, x = hit (16 steps)
const PATTERNS = {
  'Four on the floor': { bpm: 124, kick: 'x...x...x...x...', clap: '....x.......x...', hat: '..x...x...x...x.', open: '......x.......x.', bass: 'x..x..x.x..x..x.' },
  'Hip-hop': { bpm: 90, kick: 'x......xx.x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', perc: '...x.......x....', bass: 'x......xx.......' },
  Trap: { bpm: 140, kick: 'x......x..x.....', snare: '........x.......', hat: 'xxxxx.xxxxxx.xxx', open: '.......x........', bass: 'x.........x.....' },
  'Desi dhol': { bpm: 100, kick: 'x..x..x...x.x...', tom: '..x..x..x..x..x.', clap: '....x.......x...', perc: 'x.x...x.x.x...x.', hat: '.x.x.x.x.x.x.x.x' },
  'Corporate pulse': { bpm: 110, kick: 'x.......x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', bass: 'x.x...x.x.x...x.' },
};
const blank = () => ({ bpm: 110, swing: 0, key: 'A', bars: 4, steps: Object.fromEntries(SOUNDS.map((s) => [s.id, Array(STEPS).fill(0)])),
  vol: Object.fromEntries(SOUNDS.map((s) => [s.id, 0.8])), mute: {} });
const keyOf = () => `ll-beat:${S.proj}`;
let B = blank(), root = null, ctx = null, playing = false, timer = 0, step = 0, nextAt = 0;

function load() { try { const j = JSON.parse(localStorage.getItem(keyOf()) || 'null'); if (j && j.steps) B = { ...blank(), ...j }; else B = blank(); } catch { B = blank(); } }
function save() { try { localStorage.setItem(keyOf(), JSON.stringify(B)); } catch { /* private window */ } }

// ---- the sounds (each one: start at t on context c, into dest, at volume v) ----
function noise(c, len) { const b = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * len)), c.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const s = c.createBufferSource(); s.buffer = b; return s; }
function env(c, dest, t, v, a, d) { const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); g.connect(dest); return g; }
function hz(note, oct) { return 440 * 2 ** ((KEYS.indexOf(note) - 9) / 12 + (oct - 4)); }
const VOICE = {
  kick(c, d, t, v) { const o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12); o.connect(env(c, d, t, v * 1.1, 0.002, 0.42)); o.start(t); o.stop(t + 0.5); },
  snare(c, d, t, v) { const n = noise(c, 0.25), f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500; n.connect(f); f.connect(env(c, d, t, v * 0.7, 0.002, 0.18)); n.start(t);
    const o = c.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(160, t + 0.08); o.connect(env(c, d, t, v * 0.5, 0.002, 0.1)); o.start(t); o.stop(t + 0.2); },
  clap(c, d, t, v) { for (const k of [0, 0.012, 0.024]) { const n = noise(c, 0.2), f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1300; f.Q.value = 0.8; n.connect(f); f.connect(env(c, d, t + k, v * 0.6, 0.001, k === 0.024 ? 0.18 : 0.03)); n.start(t + k); } },
  hat(c, d, t, v) { const n = noise(c, 0.08), f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500; n.connect(f); f.connect(env(c, d, t, v * 0.35, 0.001, 0.045)); n.start(t); },
  open(c, d, t, v) { const n = noise(c, 0.4), f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6500; n.connect(f); f.connect(env(c, d, t, v * 0.3, 0.002, 0.3)); n.start(t); },
  tom(c, d, t, v) { const o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(95, t + 0.2); o.connect(env(c, d, t, v * 0.8, 0.002, 0.3)); o.start(t); o.stop(t + 0.4); },
  perc(c, d, t, v) { const o = c.createOscillator(); o.type = 'square'; o.frequency.setValueAtTime(820, t); const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900; o.connect(f); f.connect(env(c, d, t, v * 0.3, 0.001, 0.07)); o.start(t); o.stop(t + 0.12); },
  bass(c, d, t, v, len) { const o = c.createOscillator(), f = c.createBiquadFilter(); o.type = 'sawtooth'; o.frequency.value = hz(B.key, 2); f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(220, t + len); o.connect(f); f.connect(env(c, d, t, v * 0.55, 0.005, Math.max(0.08, len))); o.start(t); o.stop(t + len + 0.1); },
};
const stepLen = () => 60 / B.bpm / 4; // (a 16th note)
const swingAt = (i) => (i % 2 ? (B.swing / 100) * stepLen() * 0.5 : 0);
function hitStep(c, dest, i, t) {
  for (const s of SOUNDS) if (B.steps[s.id][i] && !B.mute[s.id]) VOICE[s.id](c, dest, t + swingAt(i), B.vol[s.id] ?? 0.8, stepLen() * 0.9);
}

// ---- play (live, in a loop) ----
function tick() {
  while (nextAt < ctx.currentTime + 0.12) { hitStep(ctx, ctx.destination, step, nextAt); const shown = step; setTimeout(() => light(shown), Math.max(0, (nextAt - ctx.currentTime) * 1000)); nextAt += stepLen(); step = (step + 1) % STEPS; }
}
function play() {
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume(); playing = true; step = 0; nextAt = ctx.currentTime + 0.05; timer = setInterval(tick, 25); draw();
}
function stop() { playing = false; clearInterval(timer); light(-1); draw(); }
export function stopBeat() { if (playing) stop(); }
function light(i) { if (!root) return; $$('.bm-step', root).forEach((b) => b.classList.toggle('now', +b.dataset.i === i)); }

// ---- render the loop to a WAV and put it on the timeline ----
function wav(buf) {
  const ch = buf.numberOfChannels, len = buf.length, out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch)].map((_, k) => buf.getChannelData(k));
  for (let i = 0, o = 44; i < len; i++) for (let k = 0; k < ch; k++, o += 2) out.setInt16(o, Math.max(-1, Math.min(1, data[k][i])) * 0x7fff, true);
  return new Blob([out], { type: 'audio/wav' });
}
async function addToTimeline(btn) {
  if (!SOUNDS.some((s) => B.steps[s.id].some(Boolean))) return toast('Put some beats on the grid first', 'err');
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'Making the beat…';
  try {
    const bars = Math.max(1, +B.bars || 4), secs = bars * STEPS * stepLen() + 1, sr = 44100;
    const oc = new OfflineAudioContext(2, Math.ceil(secs * sr), sr), bus = oc.createGain(), comp = oc.createDynamicsCompressor();
    bus.gain.value = 0.9; bus.connect(comp); comp.connect(oc.destination);
    for (let n = 0; n < bars * STEPS; n++) hitStep(oc, bus, n % STEPS, 0.02 + n * stepLen());
    const file = new File([wav(await oc.startRendering())], `Beat ${B.bpm} bpm ${new Date().toTimeString().slice(0, 5).replace(':', '')}.wav`, { type: 'audio/wav' });
    btn.textContent = 'Adding to Media…';
    const r = await uploadFile(S.proj, file, { bin: 'Music' });
    if (!r?.id) throw new Error(r?.error || 'The beat could not be added');
    await refreshMedia();
    S.project.tracks.A3 ||= [];
    S.project.tracks.A3.push({ id: uid(), type: 'audio', mediaId: r.id, start: +S.playhead.toFixed(3), in: 0, volume: 1 });
    commit('Beat maker: beat added');
    toast(`Beat (${bars} bars, ${B.bpm} BPM) is on A3 at the playhead - also in Media › Music`);
  } catch (e) { toast(e.message, 'err'); }
  btn.disabled = false; btn.textContent = old;
}

// ---- the face ----
export const BEAT_HTML = '<div class="panel bm" id="bmRoot"></div>';
export function mountBeat(el) {
  root = el; load();
  el.addEventListener('click', (e) => {
    const s = e.target.closest('.bm-step');
    if (s) { const a = B.steps[s.dataset.s]; a[+s.dataset.i] = a[+s.dataset.i] ? 0 : 1; s.classList.toggle('on', !!a[+s.dataset.i]); save(); return; }
    const m = e.target.closest('[data-mute]'); if (m) { B.mute[m.dataset.mute] = !B.mute[m.dataset.mute]; save(); return draw(); }
    const b = e.target.closest('[data-bm]'); if (!b) return;
    const k = b.dataset.bm;
    if (k === 'play') return playing ? stop() : play();
    if (k === 'clear') { B.steps = blank().steps; save(); return draw(); }
    if (k === 'add') return addToTimeline(b);
  });
  el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.vol) { B.vol[t.dataset.vol] = +t.value; save(); return; }
    if (t.id === 'bmBpm') B.bpm = Math.max(50, Math.min(220, +t.value || 110));
    if (t.id === 'bmSwing') B.swing = +t.value;
    if (t.id === 'bmKey') B.key = t.value;
    if (t.id === 'bmBars') B.bars = +t.value;
    save();
  });
  el.addEventListener('change', (e) => {
    if (e.target.id !== 'bmPattern' || !e.target.value) return;
    const p = PATTERNS[e.target.value]; B.bpm = p.bpm;
    for (const s of SOUNDS) B.steps[s.id] = [...(p[s.id] || '.'.repeat(STEPS))].map((ch) => (ch === 'x' ? 1 : 0));
    save(); draw();
  });
  draw();
}
export function showBeat() { if (root && keyOf() !== root.dataset.k) { load(); draw(); } }
function draw() {
  if (!root) return;
  root.dataset.k = keyOf();
  root.innerHTML = `<div class="bm-head"><b>🥁 Beat maker</b><small>tap the squares to make a beat · every sound is made right here</small><span class="grow"></span>
      <button class="${playing ? 'accent' : ''}" data-bm="play">${playing ? '■ Stop' : '▶ Play'}</button>
      <label class="fld inline"><span>BPM</span><input id="bmBpm" type="number" min="50" max="220" value="${B.bpm}" style="width:62px"></label>
      <label class="fld inline"><span>Swing</span><input id="bmSwing" type="range" min="0" max="60" value="${B.swing}" style="width:80px"></label>
      <label class="fld inline"><span>Bass key</span><select id="bmKey">${KEYS.map((k) => `<option${k === B.key ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
      <label class="fld inline"><span>Ready beat</span><select id="bmPattern"><option value="">Pick…</option>${Object.keys(PATTERNS).map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>
      <button data-bm="clear">Clear</button>
      <label class="fld inline"><span>Length</span><select id="bmBars">${[1, 2, 4, 8, 16].map((n) => `<option value="${n}"${n === +B.bars ? ' selected' : ''}>${n} bar${n > 1 ? 's' : ''}</option>`).join('')}</select></label>
      <button class="accent" data-bm="add">Add to timeline</button></div>
    <div class="bm-grid">${SOUNDS.map((s) => `<div class="bm-row${B.mute[s.id] ? ' muted' : ''}" style="--c:${s.color}">
      <button class="bm-name" data-mute="${s.id}" title="Mute / unmute">${esc(s.name)}</button>
      <input class="bm-vol" type="range" min="0" max="1" step="0.05" value="${B.vol[s.id] ?? 0.8}" data-vol="${s.id}" title="Volume">
      <div class="bm-steps">${B.steps[s.id].map((on, i) => `<button class="bm-step${on ? ' on' : ''}${i % 4 === 0 ? ' beat' : ''}" data-s="${s.id}" data-i="${i}"></button>`).join('')}</div></div>`).join('')}</div>`;
}
