// 🔴 Live same-day edit (Phase 22): while the event is still on, footage copied off the cards into a folder is picked up
// by the server's watch folder (every minute, bin "Watched/…", Smart-scanned), and this tab re-makes the highlight
// reel with everything that has come in so far - on its own sequence "Live highlights", every few minutes when new
// shots are ready. When the event ends, the reel is ready; render it from Deliver. Kept per project in this browser, so
// a refresh carries on (the tab has to stay open - the edit is put on the timeline here).
import { S, on } from './store.js';
import { api, enc } from './api.js';
import { seqList } from './model.js';
import { esc, toast, modal } from './ui.js';
import { refreshMedia, pickFolder } from './mediapool.js';
import { followAgentJob } from './agent.js';
import { openSequence, newEmptySequence } from './sequences.js';

const SEQ = 'Live highlights';
const key = () => `vedit.live.${S.proj}`;
const load = () => { try { return JSON.parse(localStorage.getItem(key())) || null; } catch { return null; } };
const save = (o) => { try { if (o) localStorage.setItem(key(), JSON.stringify(o)); else localStorage.removeItem(key()); } catch {} };
let live = null, timer = null, chip = null, busy = false;

const watched = () => S.media.filter((m) => (m.kind === 'video' || m.kind === 'image') && m.status === 'ready' && String(m.bin || '').startsWith('Watched') && !m.bad?.length);

export async function openLiveEdit() {
  const auto = await api('GET', `/api/automation?p=${enc(S.proj)}`).catch(() => ({ watch: {} }));
  const audio = S.media.filter((m) => m.kind === 'audio');
  const o = live || load() || { folder: auto.watch?.folder || '', music: '', target: 60, aspect: '9:16', every: 5, minNew: 3, title: '', endText: '' };
  const body = document.createElement('div');
  body.innerHTML = `<p class="muted">Copy the cards into a folder as the event goes on. New files there come into this project every minute, and the highlight reel is made again with everything so far - on its own sequence <b>${esc(SEQ)}</b>. Keep this tab open; edit in another tab meanwhile.</p>
    <div class="fgrid">
      <div class="fld wide"><span>Folder the cards are copied into</span><div class="row-in"><input name="folder" class="grow" value="${esc(o.folder)}" placeholder="Z:\\Event\\Cards"><button type="button" class="small" data-a="pick">Choose…</button></div></div>
      <label class="fld"><span>Song</span><select name="music"><option value="">No music (the shots' own sound)</option>${audio.map((m) => `<option value="${m.id}"${m.id === o.music ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
      <label class="fld"><span>Length</span><select name="target">${[30, 45, 60, 90, 120, 180].map((s) => `<option value="${s}"${+o.target === s ? ' selected' : ''}>${s < 60 ? `${s} s` : `${s / 60} min`}</option>`).join('')}</select></label>
      <label class="fld"><span>Format</span><select name="aspect">${[['9:16', '9:16 Reel'], ['16:9', '16:9 YouTube / screen'], ['1:1', '1:1 Square'], ['4:5', '4:5 Feed']].map(([v, l]) => `<option value="${v}"${o.aspect === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld"><span>Make it again every</span><select name="every">${[2, 5, 10, 15, 30].map((m) => `<option value="${m}"${+o.every === m ? ' selected' : ''}>${m} min (when new shots came)</option>`).join('')}</select></label>
      <label class="fld"><span>…or as soon as this many new shots</span><input name="minNew" type="number" min="1" max="100" value="${o.minNew}"></label>
      <label class="fld"><span>Title at the start (optional)</span><input name="title" value="${esc(o.title)}" placeholder="e.g. Rashtriya Yuva Utsav 2026"></label>
      <label class="fld"><span>End card (optional)</span><input name="endText" value="${esc(o.endText)}" placeholder="e.g. mybharat.gov.in"></label>
    </div>
    <div class="dv-actions">${live ? '<button class="danger" data-a="stop">Stop live edit</button>' : ''}<button class="primary" data-a="start">${live ? 'Save' : 'Start live edit'}</button></div>`;
  const dlg = modal('Live same-day edit', body, { width: 720 });
  const f = (n) => body.querySelector(`[name="${n}"]`);
  body.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'pick') { const d = await pickFolder('Folder the cards are copied into', 'New footage that appears here comes into this project every minute.'); if (d) f('folder').value = d; }
    if (a === 'stop') { stopLive(); dlg.close(); }
    if (a === 'start') {
      const n = { folder: f('folder').value.trim(), music: f('music').value, target: +f('target').value, aspect: f('aspect').value, every: +f('every').value, minNew: Math.max(1, +f('minNew').value || 3), title: f('title').value.trim(), endText: f('endText').value.trim() };
      if (!n.folder) return toast('Choose the folder the cards are copied into', 'err');
      try { await api('PUT', `/api/automation?p=${enc(S.proj)}`, { watch: { folder: n.folder, on: true, scan: true } }); }
      catch (x) { return toast(x.message, 'err'); }
      dlg.close(); startLive({ ...(live || {}), ...n, made: live?.made || 0, used: live?.used || 0, last: live?.last || 0 });
    }
  });
}

function startLive(o) {
  live = o; save(o);
  clearInterval(timer); timer = setInterval(tick, 20000);
  drawChip(); tick();
  toast(`Live edit on - watching ${o.folder}`);
}
function stopLive() {
  if (live?.folder) api('PUT', `/api/automation?p=${enc(S.proj)}`, { watch: { on: false } }).catch(() => {});
  live = null; save(null); clearInterval(timer); timer = null; chip?.remove(); chip = null;
  toast('Live edit stopped - the reel stays on its sequence');
}

async function tick(force = false) {
  if (!live || busy || !S.project) return;
  await refreshMedia().catch(() => {});
  const shots = watched(), fresh = shots.length - (live.used || 0);
  const due = fresh > 0 && (force || fresh >= live.minNew || Date.now() - (live.last || 0) >= live.every * 60000);
  drawChip(shots.length, fresh);
  if (due && shots.length >= 2) await remake(shots);
}

async function remake(shots) {
  busy = true; drawChip(shots.length, 0, 'Making the reel…');
  try {
    // its own sequence (made once); whoever is on another sequence in this tab is moved to it for the edit
    let s = seqList(S.project).find((x) => x.name === SEQ);
    if (!s) { newEmptySequence(SEQ, live.aspect); s = seqList(S.project).find((x) => x.name === SEQ); }
    else if (!s.open) openSequence(s.id);
    const o = { clips: shots.map((m) => m.id), music: live.music || null, musicBest: true, songPart: 'best', keepSound: !live.music, aspect: live.aspect, pace: 'fast', target: live.target,
      editStyle: live.music ? 'song' : 'standard', autoColor: true, detectLog: true, subtitles: false, style: 'cuts', title: live.title, endText: live.endText, names: '', outline: 'Event highlights made live: open on the strongest wide shot, build to the crowd and key moments, end on the message.' };
    const job = await api('POST', `/api/agent?p=${enc(S.proj)}`, o);
    await followAgentJob(job.id, o);
    Object.assign(live, { used: shots.length, last: Date.now(), made: (live.made || 0) + 1 }); save(live);
    toast(`Live reel #${live.made} ready - ${shots.length} shots so far`);
  } catch (e) { toast(`Live edit: ${e.message}`, 'err'); live.last = Date.now(); save(live); }
  finally { busy = false; drawChip(watched().length, 0); }
}

function drawChip(total = 0, fresh = 0, msg = '') {
  if (!live) return;
  if (!chip) {
    chip = document.createElement('div'); chip.className = 'live-chip';
    document.body.append(chip);
    chip.addEventListener('click', (e) => { const a = e.target.closest('[data-l]')?.dataset.l; if (a === 'now') tick(true); else if (a === 'set') openLiveEdit(); });
  }
  const next = live.last ? Math.max(0, Math.round((live.last + live.every * 60000 - Date.now()) / 60000)) : 0;
  chip.innerHTML = `<b><i class="live-dot"></i>LIVE</b><span>${msg || `${total} shots${fresh > 0 ? ` · ${fresh} new` : ''}${live.made ? ` · reel #${live.made}` : ''}${fresh > 0 && !busy ? ` · next in ~${next} min` : ''}`}</span>
    <button class="small" data-l="now" ${busy ? 'disabled' : ''} title="Make the reel again now with everything so far">Make now</button><button class="small" data-l="set" title="Settings / stop">Settings</button>`;
}

// a refresh / reopened project carries on where it was (another project: its own live edit, or none) - 'readonly' is
// emitted once each time a project opens
on('readonly', () => { const o = S.proj && load(); if (o && !live) startLive(o); else if (!o && live) { live = null; clearInterval(timer); chip?.remove(); chip = null; } });
