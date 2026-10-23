// ⏩ Clip Speed / Duration (Ctrl+R, like Premiere): speed in %, duration (chained to the speed or on its own), reverse,
// maintain audio pitch, ripple edit and time interpolation - for the selected clips. A clip's linked sound / picture
// gets the same speed, so the two stay in sync.
import { ic } from './lineicons.js';
import { S, commit, layout } from './store.js';
import { clipDur, fmtTC, linkedPartner, rampPts, rampAvg, keepLength } from './model.js';
import { $, esc, toast, modal } from './ui.js';

const isMedia = (c) => c.type === 'video' || (c.type === 'audio' && !c.loop);
// "4.5", "4.5s", "00:00:04:13" (hh:mm:ss:ff) or "04:13" (ss:ff) -> seconds
function parseDur(v, fps) {
  const s = String(v).trim();
  if (/^\d+(\.\d+)?s?$/.test(s)) return parseFloat(s);
  const p = s.split(/[:;.]/).map(Number);
  if (p.some((x) => !Number.isFinite(x))) return null;
  while (p.length < 4) p.unshift(0);
  const [h, m, sec, f] = p.slice(-4);
  return h * 3600 + m * 60 + sec + f / fps;
}

export function openSpeedDuration() {
  const clips = [...S.sel].map((id) => Object.values(S.project.tracks).flat().find((c) => c.id === id)).filter((c) => c && !c.gap);
  if (!clips.length) return toast('Select a clip first (then Ctrl+R)');
  const fps = S.project.settings.fps || 30, one = clips.length === 1 ? clips[0] : null, c0 = clips[0];
  const D0 = clipDur(c0, S.mediaById), media = clips.some(isMedia);
  const sp0 = Math.round((c0.speed || 1) * 1000) / 10;
  const dlg = modal('Clip Speed / Duration', `<form class="spd" autocomplete="off">
    <div class="spd-top">
      <div class="spd-fields">
        <label class="fld"><span>Speed</span><span class="row-in"><input data-speed type="number" min="1" max="10000" step="0.1" value="${sp0}"${media ? '' : ' disabled'}> %</span></label>
        <label class="fld"><span>Duration</span><input data-dur value="${one ? fmtTC(D0, fps) : ''}" placeholder="${one ? '' : 'each clip keeps its own'}"${one ? '' : ' disabled'} title="hh:mm:ss:ff, or seconds (4.5)"></label>
      </div>
      <button type="button" class="spd-link on" data-link title="Speed and duration chained: changing one changes the other (click to unchain)" ${media ? '' : 'disabled'}>${ic('link')}</button>
    </div>
    <label class="chk"><input type="checkbox" data-rev${c0.reverse ? ' checked' : ''}${clips.some((c) => c.type === 'video' || c.type === 'audio') ? '' : ' disabled'}> Reverse speed</label>
    <label class="chk"><input type="checkbox" data-pitch${c0.keepPitch === false ? '' : ' checked'}${media ? '' : ' disabled'}> Maintain audio pitch</label>
    <label class="chk"><input type="checkbox" data-ripple> Ripple edit (shift trailing clips)</label>
    <label class="fld"><span>Time interpolation</span><select data-interp${clips.some((c) => c.type === 'video') ? '' : ' disabled'}>
      <option value="">Frame sampling</option><option value="blend"${c0.smooth === 'blend' ? ' selected' : ''}>Frame blending</option><option value="flow"${c0.smooth === true ? ' selected' : ''}>Optical flow (smoothest, slower render)</option></select></label>
    ${clips.some((c) => rampPts(c)) ? '<p class="muted small">This clip has a speed ramp - the speed here scales the whole ramp.</p>' : ''}
    <p class="muted small">${clips.length > 1 ? `${clips.length} clips. ` : ''}${S.project.tracks.V1.some((c) => clips.includes(c)) ? 'Main story (V1): without Ripple edit a gap keeps the story after it in place.' : ''}</p>
    <div class="dv-actions"><button type="button" data-close>Cancel</button><button class="primary" type="submit">OK</button></div></form>`, { width: 420 });
  const f = $('form', dlg.el), sp = $('[data-speed]', f), du = $('[data-dur]', f), lk = $('[data-link]', f);
  let linked = true;
  const avg = (c) => { const p = rampPts(c); return p ? rampAvg(p) : 1; };
  const span = (c) => (c.out ?? S.mediaById[c.mediaId]?.duration ?? 0) - (c.in || 0);
  lk.onclick = () => { linked = !linked; lk.classList.toggle('on', linked); lk.innerHTML = ic(linked ? 'link' : 'unlink'); };
  // chained: the speed follows a new duration and the other way round (for the clip as it is now)
  sp.oninput = () => { if (linked && one && isMedia(one) && +sp.value > 0) du.value = fmtTC(span(one) / ((+sp.value / 100) * avg(one)), fps); };
  du.onchange = () => { const d = parseDur(du.value, fps); if (linked && one && isMedia(one) && d > 0) sp.value = Math.round(((span(one) / d / avg(one)) * 100) * 10) / 10; };
  setTimeout(() => { sp.focus(); sp.select(); }, 30);
  f.onsubmit = (e) => {
    e.preventDefault();
    const speed = +sp.value / 100, dur = one ? parseDur(du.value, fps) : null;
    if (media && !(speed > 0.009 && speed <= 100)) return toast('Speed between 1% and 10000%', 'err');
    if (one && !(dur > 0.04)) return toast('A duration like 00:00:04:13 or 4.5', 'err');
    const ripple = $('[data-ripple]', f).checked, rev = $('[data-rev]', f).checked, pitch = $('[data-pitch]', f).checked, interp = $('[data-interp]', f).value;
    const L = layout();
    let short = 0, cut = 0;
    for (const c of clips) {
      const track = Object.keys(S.project.tracks).find((t) => S.project.tracks[t].includes(c)), before = clipDur(c, S.mediaById);
      const x = L[track]?.find((p) => p.clip.id === c.id);
      if (isMedia(c)) {
        let s = speed;
        if (one && !linked) {
          // unchained: the speed is as typed and the duration decides how much of the file plays
          const max = S.mediaById[c.mediaId]?.duration ?? Infinity, want = (c.in || 0) + dur * s * avg(c);
          c.out = +Math.min(max, want).toFixed(3);
          if (want > max + 0.01) short++;
        } else if (one && Math.abs(dur - span(c) / (s * avg(c))) > 0.02) s = span(c) / dur / avg(c); // (the duration was typed last)
        if (Math.abs(s - 1) < 1e-4) delete c.speed; else c.speed = +s.toFixed(5);
      } else if (one) c.dur = +dur.toFixed(3);
      if (c.type === 'video' || c.type === 'audio') { if (rev) c.reverse = true; else delete c.reverse; }
      if (isMedia(c)) { if (pitch) delete c.keepPitch; else c.keepPitch = false; }
      if (c.type === 'video') { if (interp === 'blend') c.smooth = 'blend'; else if (interp === 'flow') c.smooth = true; else delete c.smooth; }
      // the linked sound (or picture) plays at the same speed over the same part of the file
      const lp = linkedPartner(S.project, c)?.clip;
      if (lp && isMedia(lp) && !clips.includes(lp)) for (const k of ['speed', 'out', 'reverse', 'keepPitch']) { if (c[k] === undefined) delete lp[k]; else lp[k] = c[k]; }
      let delta = clipDur(c, S.mediaById) - before;
      if (Math.abs(delta) < 0.001 || !x) continue;
      // ✂ without Ripple edit a clip made longer (slowed down) never covers the next one: it fills the empty space after
      // it and is cut where the next clip starts - that part of the file is simply not played (like Premiere)
      const fit = (room) => {
        if (delta <= room + 0.001) return;
        if (isMedia(c)) keepLength(S.project, c, before + room, S.mediaById); else c.dur = +(before + room).toFixed(3);
        if (lp && isMedia(lp) && !clips.includes(lp)) lp.out = c.out;
        delta = room; cut++;
      };
      if (track === 'V1') {
        // the main story always closes up; without Ripple edit a gap (or the gap after it) keeps the rest in place
        if (!ripple) {
          const i = S.project.tracks.V1.indexOf(c), nx = S.project.tracks.V1[i + 1];
          if (delta < 0) S.project.tracks.V1.splice(i + 1, 0, { id: `g${Date.now().toString(36)}${i}`, type: 'title', gap: true, text: '', bg: '#000000', dur: +(-delta).toFixed(3) });
          else if (nx) {
            fit(nx.gap ? clipDur(nx, S.mediaById) : 0);
            if (nx.gap && clipDur(nx, S.mediaById) > delta + 0.04) nx.dur = +(clipDur(nx, S.mediaById) - delta).toFixed(3);
            else if (nx.gap && delta > 0.001) S.project.tracks.V1.splice(i + 1, 1);
          }
        }
      } else if (ripple) {
        for (const o of S.project.tracks[track]) if (o !== c && o.start >= x.end - 0.01) o.start = +(o.start + delta).toFixed(3);
      } else if (delta > 0) {
        const next = Math.min(Infinity, ...S.project.tracks[track].filter((o) => o !== c && (o.start || 0) >= x.end - 0.01).map((o) => o.start || 0));
        if (Number.isFinite(next)) fit(Math.max(0, next - x.end));
      }
    }
    dlg.close();
    commit('Speed / Duration');
    if (cut) toast(`Slowed down - ${cut > 1 ? `${cut} clips end` : 'it ends'} where the next clip starts, so nothing after ${cut > 1 ? 'them' : 'it'} is covered or moved (tick Ripple edit to push the rest along instead)`);
    if (short) toast('The file ends before that duration - the clip stops where the file ends', 'err');
  };
}
