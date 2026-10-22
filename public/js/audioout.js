// 🎧 Where the editor's sound plays: the output chosen here (speakers, headphones, an audio interface) - for the
// timeline mix (Web Audio, player.js) and every other player (Source monitor, previews). Remembered in this browser;
// '' = the system's default. Unplugged headphones: back to the default; plugged in again: back to them.
import { $, esc, toast, modal } from './ui.js';

const KEY = 've-audio-out';
export const outId = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
const setOut = (id) => { try { localStorage.setItem(KEY, id); } catch {} };
const ctxs = new Set();
let missing = false; // the chosen device is not plugged in right now (sound goes to the default meanwhile)

// a Web Audio context (the timeline mix) follows the chosen output too
export function useContext(ctx) { ctxs.add(ctx); apply(); }

async function outputs() {
  try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'); } catch { return []; }
}
async function apply() {
  let id = outId();
  if (id) { const there = (await outputs()).some((d) => d.deviceId === id); missing = !there; if (!there) id = ''; }
  for (const c of ctxs) if (c.setSinkId && c.sinkId !== id) await c.setSinkId(id).catch(() => {});
  for (const el of document.querySelectorAll('video, audio')) if (el.setSinkId && el.sinkId !== id) el.setSinkId(id).catch(() => {});
}
// players made later (Source monitor, previews) get it too
let soon = null;
new MutationObserver(() => { clearTimeout(soon); soon = setTimeout(apply, 200); }).observe(document.documentElement, { childList: true, subtree: true });
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  const was = missing;
  await apply();
  if (outId() && missing && !was) toast('Your chosen sound output is unplugged - playing on the default speakers until it is back');
  if (outId() && !missing && was) toast('Sound is back on your chosen output');
});
apply();

// the chooser (File menu › Audio output…)
export async function pickOutput() {
  const can = !!(HTMLMediaElement.prototype.setSinkId);
  const list = async () => {
    const ds = await outputs();
    const cur = outId();
    return `<label class="ao-row"><input type="radio" name="ao" value=""${cur ? '' : ' checked'}> <span><b>System default</b><br><span class="muted small">whatever Windows plays on (Sound settings)</span></span></label>`
      + ds.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => `<label class="ao-row"><input type="radio" name="ao" value="${esc(d.deviceId)}"${d.deviceId === cur ? ' checked' : ''}> <span>${esc(d.label || `Output ${i + 1}`)}</span></label>`).join('');
  };
  const dlg = modal('Sound output', `${can ? '' : '<p class="warn">This browser cannot choose the sound output - use Chrome or Edge, and open the editor on its https address.</p>'}
    <p class="muted small">Where the timeline, the Source monitor and previews play. Kept on this computer.</p>
    <div class="ao-list" data-list>Looking for speakers and headphones…</div>
    <p class="muted small" data-names>No names? <button class="link small" data-ask>Show the device names</button> (the browser asks once for the microphone - only to read the names; nothing is recorded).</p>
    <div class="dv-actions"><button data-test>Test sound</button><button class="primary" data-close>Done</button></div>`, { width: 480 });
  const box = $('[data-list]', dlg.el);
  const draw = async () => { box.innerHTML = await list(); $('[data-names]', dlg.el).hidden = (await outputs()).every((d) => d.label); };
  await draw();
  box.onchange = async (e) => { if (e.target.name !== 'ao') return; setOut(e.target.value); await apply(); toast(e.target.value ? `Sound now plays on: ${e.target.closest('label').textContent.trim()}` : 'Sound plays on the system default'); };
  $('[data-ask]', dlg.el).onclick = async () => {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch { toast('The browser did not allow it - the devices stay unnamed', 'err'); }
    draw();
  };
  // a short beep on the chosen output
  $('[data-test]', dlg.el).onclick = async () => {
    const ctx = new AudioContext();
    if (ctx.setSinkId && outId()) await ctx.setSinkId(outId()).catch(() => {});
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 660; g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.65); o.onended = () => ctx.close();
  };
}
