// Audio page (Fairlight-style mixer): one strip per track with preset, EQ, noise reduction, de-esser, compressor,
// gain, limiter, live meter, fader, mute/solo; music ducking controls; master loudness target + EBU R128 measurement.
import { STUDIO_HTML, studio } from './audiostudio.js';
import { S, on, emit, commit, duration } from './store.js';
import { api, enc, watchJob } from './api.js';
import { fmtTC } from './model.js';
import { $, $$, h, esc, toast } from './ui.js';
import { FX_PRESETS, FX_DEFAULT, fxActive } from './audiofx.js';
import { levels, toggle, isPlayingProgram } from './player.js';

let root, raf = 0, holds = {};
const STRIPS = [
  { id: 'V1', name: 'Clip sound', sub: 'V1 - camera / interview audio' },
  { id: 'V2', name: 'Overlay sound', sub: 'V2 clips' },
  { id: 'A1', name: 'Voice-over', sub: 'A1' },
  { id: 'A2', name: 'Music', sub: 'A2' },
  { id: 'A3', name: 'Sound FX', sub: 'A3' },
];
const dbOf = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const fmtDb = (d) => (d === -Infinity ? '-∞' : `${d > 0 ? '+' : ''}${d.toFixed(1)}`);

export function mountAudio(el) {
  root = el;
  el.innerHTML = `<div class="ap">
    <div class="panel ap-top">
      <button class="icon-btn" data-au="start" title="Start (Home)">⏮</button>
      <button class="icon-btn play" data-au="play" title="Play / pause (Space)">▶</button>
      <span class="tc big" id="apTC">00:00:00:00</span>
      <span class="grow"></span>
      <span class="ap-live" id="apLive" title="Rough live level of the master output">Live ≈ -- LUFS</span>
      <label class="fld inline"><span>Loudness target</span><select id="apTarget">
        <option value="-14">Social -14 LUFS</option><option value="-16">YouTube / web -16</option><option value="-23">Broadcast -23</option><option value="off">Leave as is</option></select></label>
      <button class="accent" data-au="measure" title="Mix a quick preview and measure it (EBU R128)">Measure final loudness</button>
      <span class="ap-result" id="apResult"></span>
    </div>
    ${STUDIO_HTML}
    <div class="ap-mixer" id="apMixer"></div>
    <p class="muted ap-note">Live preview plays EQ, compressor, gain and limiter. Noise reduction, de-essing and music ducking are applied in renders and in <b>Measure final loudness</b>. Start playback once (Space) to light up the meters.</p>
  </div>`;
  el.addEventListener('click', onClick);
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-st]'); if (b) studio(b.dataset.st, b); });
  $('#apTarget', el).onchange = (e) => { S.project.settings.loudness = e.target.value === 'off' ? 'off' : +e.target.value; commit('Loudness target'); };
  on('change', () => { if (S.page === 'audio') renderMixer(); });
  on('playhead', () => { if (S.page === 'audio') $('#apTC', root).textContent = fmtTC(S.playhead, S.project.settings.fps); });
}

export function showAudio() { renderMixer(); startMeters(); }
export function hideAudio() { cancelAnimationFrame(raf); }

function st(id) { const ts = S.project.trackState; ts[id] = ts[id] || {}; return ts[id]; }

function renderMixer() {
  const t = S.project.settings.loudness;
  $('#apTarget', root).value = t === 'off' || t === false ? 'off' : String(t ?? -14);
  const used = new Set(Object.entries(S.project.tracks).filter(([, l]) => l.length).map(([k]) => k));
  $('#apMixer', root).innerHTML = STRIPS.map((s) => strip(s, used.has(s.id))).join('') + masterStrip();
  $$('[data-fx]', root).forEach((inp) => {
    const id = inp.closest('[data-strip]').dataset.strip, k = inp.dataset.fx;
    const read = () => (inp.type === 'checkbox' ? inp.checked : +inp.value);
    inp.addEventListener('input', () => { st(id).fx = { ...FX_DEFAULT, ...(st(id).fx || {}), [k]: read() }; showVal(inp); emit('mix'); });
    inp.addEventListener('change', () => { st(id).fx = { ...FX_DEFAULT, ...(st(id).fx || {}), [k]: read() }; tidy(id); commit(`${id} ${k}`, `${id}:fx:${k}`); });
  });
  $$('[data-fader]', root).forEach((f) => {
    const id = f.dataset.fader;
    f.addEventListener('input', () => { st(id).volume = +f.value; f.closest('.strip').querySelector('.fdb').textContent = `${fmtDb(dbOf(+f.value))} dB`; emit('mix'); });
    f.addEventListener('change', () => commit(`${id} volume`, `${id}:vol`));
  });
  $$('[data-duck]', root).forEach((inp) => {
    inp.addEventListener('input', () => { st('A2')[inp.dataset.duck] = +inp.value; showVal(inp); });
    inp.addEventListener('change', () => commit('Ducking', `duck:${inp.dataset.duck}`));
  });
  $$('[data-preset]', root).forEach((sel) => sel.addEventListener('change', () => {
    const id = sel.closest('[data-strip]').dataset.strip, p = FX_PRESETS[sel.value];
    if (!p) return;
    st(id).fx = { ...p.fx }; tidy(id); commit(`${id}: ${p.label}`);
    toast(`${STRIPS.find((x) => x.id === id).name}: ${p.label}`);
  }));
  $$('[data-fx], [data-duck]', root).forEach(showVal);
}

function strip(s, used) {
  const x = st(s.id), fx = { ...FX_DEFAULT, ...(x.fx || {}) }, vol = x.volume ?? 1;
  const slider = (k, label, min, max, step, unit, note = '') => `<label class="fxr"><span>${label}${note ? ` <i>${note}</i>` : ''}</span>
    <input type="range" data-fx="${k}" min="${min}" max="${max}" step="${step}" value="${fx[k]}" data-unit="${unit}"><output></output></label>`;
  return `<div class="strip panel${used ? '' : ' unused'}${x.mute ? ' muted' : ''}" data-strip="${s.id}">
    <div class="sh"><b>${s.name}</b><small>${s.sub}${used ? '' : ' · empty'}</small></div>
    <div class="strip-fx">
    <select data-preset aria-label="${s.name} preset"><option value="">Preset…</option>${Object.entries(FX_PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('')}</select>
    <div class="fx${fxActive(fx) ? ' on' : ''}">
      <label class="fxr"><span>High-pass</span><select data-fx="hpf">${[0, 40, 60, 80, 100, 120, 150, 200].map((f) => `<option value="${f}"${+fx.hpf === f ? ' selected' : ''}>${f ? `${f} Hz` : 'Off'}</option>`).join('')}</select></label>
      ${slider('low', 'Low', -12, 12, 0.5, 'dB')}${slider('mid', 'Presence', -12, 12, 0.5, 'dB')}${slider('high', 'Air', -12, 12, 0.5, 'dB')}
      ${slider('nr', 'Noise reduction', 0, 1, 0.05, '%', 'render')}${slider('deess', 'De-esser', 0, 1, 0.05, '%', 'render')}
      ${slider('comp', 'Compressor', 0, 1, 0.05, '%')}${slider('gain', 'Gain', -12, 12, 0.5, 'dB')}
      <label class="chk"><input type="checkbox" data-fx="limit"${fx.limit ? ' checked' : ''}> Limiter (-1 dB)</label>
    </div>
    ${s.id === 'A2' ? `<div class="duck"><b>Ducking</b> <small>music dips under speech</small>
      <label class="fxr"><span>Depth</span><input type="range" data-duck="duckDepth" min="4" max="30" step="1" value="${x.duckDepth ?? 14}" data-unit="dB"><output></output></label>
      <label class="fxr"><span>Sensitivity</span><input type="range" data-duck="duckThreshold" min="0.005" max="0.1" step="0.005" value="${x.duckThreshold ?? 0.02}" data-unit="thr"><output></output></label>
      <label class="fxr"><span>Recovery</span><input type="range" data-duck="duckRelease" min="100" max="1500" step="50" value="${x.duckRelease ?? 400}" data-unit="ms"><output></output></label>
      <button class="small wide" data-au="duckAll">Duck all music clips</button></div>` : ''}
    </div>
    <div class="fadersec">
      <canvas class="meter" width="26" height="150" data-meter="${s.id}"></canvas>
      <input type="range" class="fader" data-fader="${s.id}" min="0" max="2" step="0.01" value="${vol}" aria-label="${s.name} volume">
    </div>
    <div class="fdb">${fmtDb(dbOf(vol))} dB</div>
    <div class="ms"><button class="tbtn${x.mute ? ' on' : ''}" data-au="mute" title="Mute">M</button><button class="tbtn solo${x.solo ? ' on' : ''}" data-au="solo" title="Solo (listen to this track only)">S</button></div>
  </div>`;
}
function masterStrip() {
  return `<div class="strip panel master" data-strip="master">
    <div class="sh"><b>Master</b><small>final mix</small></div>
    <div class="mres" id="apMres"><span class="muted">Measure to see the final loudness</span></div>
    <div class="fadersec"><canvas class="meter big" width="40" height="300" data-meter="master"></canvas></div>
    <div class="fdb" id="apMdb">-∞ dB</div>
  </div>`;
}
function showVal(inp) {
  const o = inp.parentElement.querySelector('output'); if (!o) return;
  const v = +inp.value, u = inp.dataset.unit;
  o.textContent = u === '%' ? `${Math.round(v * 100)}%` : u === 'dB' ? `${v > 0 ? '+' : ''}${v}` : u === 'ms' ? `${v}` : u === 'thr' ? `${Math.round((1 - v / 0.1) * 100)}%` : v;
}
function tidy(id) { const x = st(id); if (x.fx && !fxActive(x.fx)) delete x.fx; }

async function onClick(e) {
  const a = e.target.closest('[data-au]')?.dataset.au;
  if (!a) return;
  const id = e.target.closest('[data-strip]')?.dataset.strip;
  if (a === 'play') { toggle(); setTimeout(syncPlay, 50); }
  if (a === 'start') emit('seek', 0);
  if (a === 'mute' || a === 'solo') { st(id)[a] = !st(id)[a] || undefined; commit(`${id} ${a}`); emit('mix'); }
  if (a === 'duckAll') { const n = S.project.tracks.A2.length; S.project.tracks.A2.forEach((c) => (c.duck = true)); commit('Duck all music'); toast(n ? `Ducking on for ${n} music clip${n > 1 ? 's' : ''}` : 'No music on A2 yet'); }
  if (a === 'measure') measure(e.target.closest('button'));
}
function syncPlay() { const b = $('[data-au="play"]', root); if (b) b.textContent = isPlayingProgram() ? '❚❚' : '▶'; }

async function measure(btn) {
  if (!Object.values(S.project.tracks).flat().length) return toast('The timeline is empty', 'err');
  btn.disabled = true;
  const res = $('#apResult', root);
  try {
    const job = await api('POST', `/api/loudness?p=${enc(S.proj)}`, { project: S.project });
    const j = await watchJob(job.id, (x) => (res.textContent = `Measuring… ${x.progress}%`));
    const r = j.result, tgt = r.target === 'off' ? null : +r.target;
    const ok = tgt === null || Math.abs(r.integrated - tgt) <= 1;
    const pk = r.truePeak !== null && r.truePeak > -1;
    const html = `<b class="${ok ? 'good' : 'warn'}">${r.integrated?.toFixed(1)} LUFS</b> integrated${tgt !== null ? ` (target ${tgt})` : ''} · True peak <b class="${pk ? 'warn' : 'good'}">${r.truePeak?.toFixed(1)} dBTP</b> · LRA ${r.lra?.toFixed(1)} LU`;
    res.innerHTML = html; $('#apMres', root).innerHTML = html.replace(/ · /g, '<br>');
    toast(ok && !pk ? 'Loudness is on target' : 'Check the loudness numbers above', ok && !pk ? '' : 'err');
  } catch (err) { res.textContent = ''; toast(err.job ? `Measure failed: ${err.job.log.slice(-1)[0]}` : err.message, 'err'); }
  finally { btn.disabled = false; }
}

// ---------------- meters ----------------
function startMeters() {
  cancelAnimationFrame(raf);
  const loop = () => {
    if (S.page !== 'audio') return;
    const L = levels();
    syncPlay();
    $$('[data-meter]', root).forEach((cv) => drawMeter(cv, L?.[cv.dataset.meter]));
    if (L?.master) {
      const live = L.master.rms + 0.7; // rough: un-weighted RMS ~ momentary loudness for typical speech/music
      $('#apLive', root).textContent = `Live ≈ ${L.master.rms > -70 ? live.toFixed(0) : '--'} LUFS`;
      $('#apMdb', root).textContent = `${L.master.peak > -100 ? L.master.peak.toFixed(1) : '-∞'} dB peak`;
    }
    raf = requestAnimationFrame(loop);
  };
  loop();
}
function drawMeter(cv, lv) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, key = cv.dataset.meter;
  g.fillStyle = '#0a0c10'; g.fillRect(0, 0, W, H);
  const y = (db) => H - Math.max(0, Math.min(1, (db + 60) / 60)) * H;
  const grad = g.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, '#2fbf71'); grad.addColorStop(0.7, '#2fbf71'); grad.addColorStop(0.85, '#e8c547'); grad.addColorStop(1, '#ff4d4d');
  if (lv) {
    g.fillStyle = grad; g.globalAlpha = 0.45; g.fillRect(2, y(lv.peak), W - 4, H - y(lv.peak));
    g.globalAlpha = 1; g.fillRect(4, y(lv.rms), W - 8, H - y(lv.rms));
    const hd = holds[key] || { v: -120, t: 0 }, now = performance.now();
    if (lv.peak > hd.v || now - hd.t > 1500) holds[key] = { v: lv.peak, t: now };
    g.fillStyle = holds[key].v > -1 ? '#ff4d4d' : '#fff'; g.fillRect(2, y(holds[key].v) - 1, W - 4, 2);
  }
  g.fillStyle = '#ffffff55'; g.font = '9px Segoe UI';
  for (const d of [0, -6, -12, -18, -24, -36, -48]) { g.fillRect(0, y(d), 3, 1); if (W > 30) g.fillText(String(d), W - 16, y(d) + 3); }
}
