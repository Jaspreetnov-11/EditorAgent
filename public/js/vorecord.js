// 🎙 Voice-over record (Premiere's mic button on an audio track): a 3-2-1 count-in, then the edit plays from the
// playhead while your voice is recorded; Stop (the 🎙 again, Esc or the bar's button) puts the take on that track at
// the point where it started. The take is saved as a WAV in the project (imports) - a normal audio clip after that.
import { S, emit, commit } from './store.js';
import { api, enc } from './api.js';
import { toast } from './ui.js';
import { uploadFiles } from './mediapool.js';
import { placeMedia } from './timeline.js';
import { play, pause } from './player.js';

let rec = null; // { mr, chunks, stream, track, start, t0, bar, timer }
export const recording = () => rec?.track || null;

export async function toggleRecord(track) {
  if (rec) return stop();
  if (S.readOnly) return toast('This project is read-only for you', 'err');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { return toast(`No microphone: ${e.message}. Allow the mic for this page (the in the address bar).`, 'err'); }
  const bar = document.createElement('div'); bar.className = 'vo-rec';
  document.body.append(bar);
  // count-in
  for (const n of [3, 2, 1]) { bar.innerHTML = `<b>${n}</b><span>Recording on ${track}… (headphones keep the edit's sound out of the mic)</span>`; await new Promise((ok) => setTimeout(ok, 700)); }
  const mr = new MediaRecorder(stream);
  rec = { mr, chunks: [], stream, track, start: S.playhead || 0, t0: performance.now(), bar };
  mr.ondataavailable = (e) => e.data.size && rec?.chunks.push(e.data);
  mr.start(250);
  play();
  bar.innerHTML = `<i class="dot"></i><b data-t>0:00</b><span>Recording a voice-over on ${track}</span><button class="small" data-stop>■ Stop</button>`;
  bar.querySelector('[data-stop]').onclick = stop;
  rec.timer = setInterval(() => { const s = (performance.now() - rec.t0) / 1000; bar.querySelector('[data-t]').textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }, 250);
  document.addEventListener('keydown', escStop, true);
  emit('recording');
}
function escStop(e) { if (e.key === 'Escape' && rec) { e.preventDefault(); e.stopImmediatePropagation(); stop(); } }

async function stop() {
  const r = rec; if (!r) return;
  rec = null;
  document.removeEventListener('keydown', escStop, true);
  clearInterval(r.timer); pause();
  await new Promise((ok) => { r.mr.onstop = ok; r.mr.stop(); });
  r.stream.getTracks().forEach((t) => t.stop());
  emit('recording');
  r.bar.innerHTML = '<span>Saving the take…</span>';
  try {
    const wav = await toWav(new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' }));
    const n = S.media.filter((m) => /^Voice-over \d+/.test(m.name)).length + 1;
    const file = new File([wav], `Voice-over ${n}.wav`, { type: 'audio/wav' });
    const before = new Set(S.media.map((m) => m.id));
    await uploadFiles([file]);
    let m = S.media.find((x) => !before.has(x.id));
    for (let i = 0; m && m.status !== 'ready' && m.status !== 'error' && i < 60; i++) {
      await new Promise((ok) => setTimeout(ok, 700));
      try { m = await api('GET', `/api/media/item?p=${enc(S.proj)}&id=${m.id}`); } catch { break; }
    }
    if (!m || m.status !== 'ready') throw new Error('the take could not be read');
    S.mediaById[m.id] = m; if (!S.media.some((x) => x.id === m.id)) S.media.push(m); else S.media = S.media.map((x) => (x.id === m.id ? m : x));
    const c = placeMedia(m.id, r.track, r.start);
    if (c) { S.sel = new Set([c.id]); commit(`Voice-over on ${r.track}`); emit('select'); }
    toast(`${m.name} placed on ${r.track} at the playhead - Ctrl+Z takes it off`);
  } catch (e) { toast(`Voice-over not saved: ${e.message}`, 'err'); }
  finally { r.bar.remove(); }
}

// the recording (webm / opus) as a 16-bit mono WAV
async function toWav(blob) {
  const ctx = new (window.OfflineAudioContext || window.AudioContext)(1, 48000, 48000);
  const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
  const ch = audio.numberOfChannels, len = audio.length, rate = audio.sampleRate, data = new Float32Array(len);
  for (let c = 0; c < ch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < len; i++) data[i] += d[i] / ch; }
  const buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf), w = (o, s) => [...s].forEach((x, i) => v.setUint8(o + i, x.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}
