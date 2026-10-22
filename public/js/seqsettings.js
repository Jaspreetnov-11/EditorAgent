// ⚙ Sequence Settings (Sequence menu, like Premiere): the open sequence's name, timebase, frame size (a named shape or any
// W x H, with a proportions lock), pixel aspect, fields, how time is shown, audio sample rate, working colour, preview and
// export quality. Saved in the sequence's own settings (each sequence has its own); renders follow them.
import { S, emit, commit } from './store.js';
import { ASPECTS, shapeLabel, seqOf, seqList } from './model.js';
import { $, esc, toast, modal } from './ui.js';

const RATES = [[23.976, '23.976 fps (film, NTSC)'], [24, '24 fps (cinema)'], [25, '25 fps (India / PAL TV)'], [29.97, '29.97 fps (NTSC TV)'], [30, '30 fps (web, phones)'], [50, '50 fps (PAL sport / smooth)'], [59.94, '59.94 fps (NTSC smooth)'], [60, '60 fps (games, smooth)']];
const NAMED = ['16:9', '9:16', '1:1', '4:5', '4:3', '3:4', '21:9', '2.39:1', '17:9 DCI'];
const SIZES = [[3840, 2160, 'UHD 4K'], [4096, 2160, 'DCI 4K'], [2560, 1440, 'QHD'], [1920, 1080, 'Full HD'], [1280, 720, 'HD 720'], [1080, 1920, 'Vertical Full HD'], [2160, 3840, 'Vertical 4K'], [1080, 1080, 'Square'], [1080, 1350, 'Feed 4:5']];

export function openSequenceSettings() {
  if (!S.project) return;
  const st = S.project.settings, seq = seqOf(S.project), [w0, h0] = ASPECTS[st.aspect] || [1920, 1080];
  let pq = 'hq'; try { pq = localStorage.getItem('ve-preview-q') || 'hq'; } catch {}
  const opt = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const d = modal('⚙ Sequence Settings', `<div class="ss">
    <label class="fld"><span>Sequence name</span><input data-s="name" value="${esc(seq.name || '')}"></label>
    <h4>Video</h4>
    <div class="ss-grid">
      <label class="fld"><span>Timebase</span><select data-s="fps">${opt(RATES, st.fps)}</select></label>
      <label class="fld"><span>Frame shape</span><select data-s="shape"><option value="">Custom (W × H below)</option>${NAMED.map((k) => `<option value="${k}"${k === st.aspect ? ' selected' : ''}>${k} · ${ASPECTS[k].join(' × ')}</option>`).join('')}</select></label>
      <div class="fld ss-size"><span>Frame size</span><div class="row-in"><input type="number" data-s="w" min="16" max="8192" step="2" value="${w0}" aria-label="Width"><button class="icon-btn small" data-ss="lock" aria-pressed="true" title="Keep the proportions">🔗</button><input type="number" data-s="h" min="16" max="8192" step="2" value="${h0}" aria-label="Height"><button class="icon-btn small" data-ss="swap" title="Swap width and height (landscape / portrait)">⇄</button></div><small class="muted" data-s="ratio"></small></div>
      <label class="fld"><span>Common sizes</span><select data-s="size"><option value="">Pick…</option>${SIZES.map(([w, h, l]) => `<option value="${w}x${h}">${l} · ${w} × ${h}</option>`).join('')}</select></label>
      <label class="fld"><span>Pixel aspect ratio</span><select disabled><option>Square pixels (1.0)</option></select></label>
      <label class="fld"><span>Fields</span><select disabled><option>No fields (progressive)</option></select></label>
      <label class="fld"><span>Display format</span><select data-s="tcmode">${opt([['tc', 'Timecode (00:00:00:00)'], ['frames', 'Frames'], ['secs', 'Seconds (0:00.0)']], st.tcMode || 'tc')}</select></label>
      <label class="fld"><span>Working colour space</span><select data-s="color">${opt([['709', 'Rec. 709 (SDR)'], ['hlg', 'Rec. 2100 HLG (HDR)'], ['pq', 'Rec. 2100 PQ (HDR10)']], st.colorSpace || '709')}</select></label>
    </div>
    <h4>Audio</h4>
    <div class="ss-grid">
      <label class="fld"><span>Sample rate</span><select disabled><option>48000 Hz (the mix and every export)</option></select></label>
      <label class="fld"><span>Loudness</span><select data-s="loud">${opt([[-14, 'Social -14 LUFS'], [-16, 'YouTube / web -16'], [-23, 'Broadcast -23'], ['off', 'Leave as is']], st.loudness ?? -14)}</select></label>
    </div>
    <h4>Previews and export</h4>
    <div class="ss-grid">
      <label class="fld"><span>Accurate preview</span><select data-s="pq">${opt([['hq', '1080p from the camera files'], ['fast', 'Fast 720p from the preview copies']], pq)}</select></label>
      <label class="fld"><span>Export quality</span><select data-s="crf">${opt([[16, 'Master (big)'], [18, 'High'], [20, 'Standard'], [24, 'Small (WhatsApp)'], [28, 'Very small']], st.crf ?? 20)}</select></label>
    </div>
    <p class="muted small">Every sequence has its own settings. Changing the frame size keeps the clips; framing (fit / fill) follows the new shape. HDR colour spaces render 10-bit HEVC with HDR tags.</p>
    <div class="dlg-actions"><button class="primary" data-action="ok">OK</button><button data-close>Cancel</button></div></div>`, {
    width: 640,
    onAction: (a) => {
      if (a !== 'ok') return;
      const v = (k) => d.el.querySelector(`[data-s="${k}"]`).value;
      const w = Math.max(16, Math.min(8192, +v('w') || w0)) & ~1, h = Math.max(16, Math.min(8192, +v('h') || h0)) & ~1;
      const named = v('shape') && ASPECTS[v('shape')].join('x') === `${w}x${h}` ? v('shape') : NAMED.find((k) => ASPECTS[k].join('x') === `${w}x${h}`);
      const aspect = named || `${w}x${h}`, nm = v('name').trim();
      if (nm && nm !== seq.name && seqList(S.project).some((x) => x.id !== seq.id && x.name === nm)) return toast(`There is already a sequence called "${nm}"`, 'err');
      const was = st.aspect;
      Object.assign(st, { aspect, fps: +v('fps'), loudness: v('loud') === 'off' ? 'off' : +v('loud'), crf: +v('crf') });
      if (v('tcmode') === 'tc') delete st.tcMode; else st.tcMode = v('tcmode');
      if (v('color') === '709') delete st.colorSpace; else st.colorSpace = v('color');
      if (nm && nm !== seq.name) S.project.seq = { ...(S.project.seq || {}), id: seq.id, name: nm };
      try { localStorage.setItem('ve-preview-q', v('pq')); } catch {}
      commit('Sequence settings');
      if (was !== aspect) emit('aspect');
      emit('seq'); emit('change', {});
      d.close();
      toast(`⚙ ${nm || seq.name}: ${shapeLabel(aspect)} · ${+v('fps')} fps${st.colorSpace ? ` · HDR ${st.colorSpace.toUpperCase()}` : ''}`);
    },
  });
  // the size boxes, the lock, the shape and size pickers keep each other in step
  const W = $('[data-s="w"]', d.el), H = $('[data-s="h"]', d.el), lock = $('[data-ss="lock"]', d.el), shape = $('[data-s="shape"]', d.el);
  let ratio = w0 / h0;
  const show = () => {
    const w = +W.value, h = +H.value, g = (a, b) => (b ? g(b, a % b) : a), k = g(w, h) || 1;
    $('[data-s="ratio"]', d.el).textContent = w && h ? `${w / k}:${h / k} · ${(w / h).toFixed(3)}` : '';
    shape.value = NAMED.find((n) => ASPECTS[n].join('x') === `${w}x${h}`) || '';
  };
  W.oninput = () => { if (lock.getAttribute('aria-pressed') === 'true') H.value = Math.round(+W.value / ratio / 2) * 2; show(); };
  H.oninput = () => { if (lock.getAttribute('aria-pressed') === 'true') W.value = Math.round((+H.value * ratio) / 2) * 2; show(); };
  lock.onclick = () => { const on = lock.getAttribute('aria-pressed') !== 'true'; lock.setAttribute('aria-pressed', String(on)); ratio = +W.value / +H.value; };
  $('[data-ss="swap"]', d.el).onclick = () => { [W.value, H.value] = [H.value, W.value]; ratio = +W.value / +H.value; show(); };
  shape.onchange = () => { if (!shape.value) return; [W.value, H.value] = ASPECTS[shape.value]; ratio = +W.value / +H.value; show(); };
  $('[data-s="size"]', d.el).onchange = (e) => { if (!e.target.value) return; [W.value, H.value] = e.target.value.split('x'); ratio = +W.value / +H.value; show(); e.target.value = ''; };
  show();
}
