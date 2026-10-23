// 📝 Text page: edit the video by editing what is said. The main story's speech as a document - select words and press
// Delete (or ✂) to cut them out of the video; ✨ Presets clean up in one go (ums, verbal fillers, stutters, retakes,
// pauses in four styles, silent heads / tails) or build highlights (15 / 30 / 60 s, questions, a keyword) as a new
// sequence; ✎ Mark mode strikes words first and cuts them together; right-click a word (or F2) to correct it. Selecting
// works like any text: drag, double-click a word, triple-click a line, Shift+arrows (Ctrl: by word), Ctrl+A. The strip at
// the bottom is the edit as a timeline - every word, filler and pause on it; click to jump, drag to select words.
// Maths in textcut.js; transcripts from engine/transcribe.py (cached per clip).
import { S, on, emit, commit } from './store.js';
import { api, enc, watchJob } from './api.js';
import { fmt, fmtTC, layoutV1 } from './model.js';
import { $, $$, esc, toast, progressClock } from './ui.js';
import { wordsOf, cutsForSelection, cutSource, fillerCuts, pauseCuts, sentencesOf, roughCut, isFiller, verbalCuts, stutterCuts, retakeCuts, headTailCuts, PAUSE_PRESETS, pickHighlights } from './textcut.js';
import { newSequenceWith } from './sequences.js';

let root, trs = {}, words = [], visible = false, busy = false, markMode = false, tlZoom = 1, tlT = 0;
const tick = new Set(); // sentences chosen for a rough cut
const marks = new Set(); // ✎ struck words, by `${clipId}:${si}:${i}` (stable while other words are cut)
const wkey = (w) => `${w.clipId}:${w.si}:${w.i}`;

export function mountText(el) {
  root = el;
  el.innerHTML = `<div class="tx">
    <div class="tx-bar">
      <span class="tx-st" data-st></span><span class="grow"></span>
      <select data-model title="Accuracy"><option value="small">Fast draft</option><option value="medium" selected>Good</option><option value="large-v3">Best (slow)</option></select>
      <select data-lang title="Spoken language"><option value="auto">Auto language</option><option value="hi">Hindi</option><option value="en">English</option></select>
      <button class="accent small" data-go-tr>Transcribe</button>
      <span class="sep"></span>
      <button class="small" data-presets title="One-click clean-ups and highlights">Presets ▾</button>
      <button class="small" data-fill title="Cut every um / aa / hmm">Remove fillers</button>
      <span class="sep"></span>
      <button class="small tog" data-mark title="Mark mode: Delete strikes words through instead of cutting; cut them all together with Apply">Mark mode</button>
      <button class="small" data-apply hidden>Apply marks</button><button class="small" data-clearm hidden>Clear marks</button>
      <button class="small danger" data-del title="Cut the selected words out of the video (Delete)">Cut selection</button>
    </div>
    <div class="tx-main">
      <div class="tx-doc" data-doc tabindex="0" aria-label="Transcript of the edit"></div>
      <div class="tx-side">
        <video data-pv playsinline controls></video>
        <div class="muted small" data-pvinfo>Click a word to hear it. Select words and press Delete to cut them. Double-click a word to correct it.</div>
        <h4>Highlights <span class="muted small">(a new sequence - the edit stays)</span></h4>
        <div class="tx-hl"><button class="small" data-hl="15">15 s</button><button class="small" data-hl="30">30 s</button><button class="small" data-hl="60">60 s</button><button class="small" data-hl="q" title="Only the questions">Questions</button><button class="small" data-hl="k" title="Sentences with the word typed below">Keyword</button></div>
        <h4>Rough cut from sentences</h4>
        <input type="search" data-q placeholder="Find sentences with…" aria-label="Find sentences">
        <div class="tx-sents" data-sents></div>
        <button class="primary wide" data-rough disabled>Build rough cut</button>
      </div>
    </div>
    <div class="tx-tl"><div class="tx-tlhead"><b>Timeline</b><span class="muted small">every word of the edit · <i class="sw f"></i> filler <i class="sw m"></i> marked <i class="sw p"></i> long pause · click = jump, drag = select words, Ctrl + wheel = zoom</span><span class="grow"></span><span class="tc" data-tltc></span></div>
      <div class="tx-tlwrap" data-tlwrap><canvas data-tl></canvas></div></div>
  </div>`;
  const doc = $('[data-doc]', el), pv = $('[data-pv]', el);
  $('[data-go-tr]', el).onclick = transcribeAll;
  $('[data-fill]', el).onclick = () => apply(fillerCuts(words), 'Remove fillers', (n) => `${n} filler${n === 1 ? '' : 's'}`);
  $('[data-presets]', el).onclick = (e) => presetMenu(e.currentTarget);
  $('[data-del]', el).onclick = () => cutSelection(false);
  $('[data-mark]', el).onclick = (e) => { markMode = !markMode; e.currentTarget.classList.toggle('on', markMode); toast(markMode ? 'Mark mode: select words and press Delete to strike them; Apply cuts them all' : 'Mark mode off: Delete cuts right away'); };
  $('[data-apply]', el).onclick = applyMarks;
  $('[data-clearm]', el).onclick = () => { marks.clear(); draw(); };
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); cutSelection(markMode); return; }
    // selecting text with the keyboard - before the editor's own shortcuts (Ctrl+A = all clips, Shift+arrows = 5 frames)
    const sel = window.getSelection(), ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); const r = document.createRange(); r.selectNodeContents(doc); sel.removeAllRanges(); sel.addRange(r); return; }
    if (ctrl && e.key.toLowerCase() === 'c') { e.stopPropagation(); return; } // (copy the text, not the clips)
    const dir = { ArrowLeft: ['backward', 'character'], ArrowRight: ['forward', 'character'], ArrowUp: ['backward', 'line'], ArrowDown: ['forward', 'line'], Home: ['backward', 'lineboundary'], End: ['forward', 'lineboundary'] }[e.key];
    if (dir && e.shiftKey && sel.rangeCount && doc.contains(sel.anchorNode)) {
      e.preventDefault(); e.stopPropagation();
      sel.modify('extend', dir[0], ctrl && dir[1] === 'character' ? 'word' : ctrl && dir[1] === 'lineboundary' ? 'documentboundary' : dir[1]);
      return;
    }
    if (e.key === 'F2') { const w = (sel.anchorNode?.parentElement || sel.anchorNode)?.closest?.('[data-wi]'); if (w) { e.preventDefault(); e.stopPropagation(); fixWord(+w.dataset.wi); } }
  });
  // (a click puts the caret where it was clicked, so Shift+arrows / Shift+click have a place to start from)
  doc.addEventListener('click', (e) => { const w = e.target.closest('[data-wi]'); if (!w || !window.getSelection().isCollapsed) return; hear(+w.dataset.wi); });
  // ✏ correct a word the transcript got wrong (kept in the project: project.wordFix) - right-click it, or F2
  // (double-click selects the word, like any text editor)
  const fixWord = (i) => {
    const w = words[i]; if (!w) return;
    const t = prompt('Correct this word (empty = back to what was heard)', w.w); if (t === null) return;
    const fix = ((S.project.wordFix ||= {})[w.mediaId] ||= {});
    if (t.trim()) fix[`${w.si}:${w.i}`] = t.trim(); else delete fix[`${w.si}:${w.i}`];
    if (!Object.keys(fix).length) delete S.project.wordFix[w.mediaId];
    commit('Correct word'); window.getSelection().removeAllRanges();
  };
  doc.addEventListener('contextmenu', (e) => {
    const el2 = e.target.closest('[data-wi]'); if (!el2) return;
    e.preventDefault();
    document.querySelector('.ui-menu')?.remove();
    const m = document.createElement('div'); m.className = 'ui-menu tx-menu';
    const has = !window.getSelection().isCollapsed;
    m.innerHTML = `<button data-k="fix">Correct this word… (F2)</button>${has ? '<button data-k="cut">Cut the selected words (Delete)</button><button data-k="copy">Copy the text</button>' : ''}`;
    document.body.append(m);
    m.style.top = `${Math.min(e.clientY, innerHeight - m.offsetHeight - 8)}px`; m.style.left = `${Math.min(e.clientX, innerWidth - m.offsetWidth - 8)}px`;
    const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
    m.onclick = (ev) => {
      const k = ev.target.closest('[data-k]')?.dataset.k; if (!k) return;
      m.remove(); document.removeEventListener('pointerdown', close, true);
      if (k === 'fix') fixWord(+el2.dataset.wi);
      if (k === 'cut') cutSelection(markMode);
      if (k === 'copy') navigator.clipboard?.writeText(window.getSelection().toString()).then(() => toast('Copied'));
    };
  });
  // the word being heard lights up; playback stops at the clip's Out
  pv.addEventListener('timeupdate', () => {
    const t = pv.currentTime, c = S.project?.tracks.V1.find((k) => k.id === pv.dataset.clip);
    if (c && c.out !== undefined && t > c.out) pv.pause();
    $$('.tx-w.now', doc).forEach((s) => s.classList.remove('now'));
    const i = words.findIndex((w) => w.clipId === pv.dataset.clip && t >= w.s && t < w.e + 0.05);
    if (i >= 0) { doc.querySelector(`[data-wi="${i}"]`)?.classList.add('now'); }
    const x = c && layoutV1(S.project, S.mediaById).find((y) => y.clip.id === c.id);
    if (x) { tlT = x.start + (t - (c.in || 0)) / (c.speed || 1); drawTl(); }
  });
  $('[data-q]', el).oninput = drawSentences;
  $('[data-sents]', el).addEventListener('change', (e) => { const k = e.target.dataset.sk; if (!k) return; e.target.checked ? tick.add(k) : tick.delete(k); syncRough(); });
  $('[data-rough]', el).onclick = buildRough;
  $$('[data-hl]', el).forEach((b) => (b.onclick = () => highlight(b.dataset.hl)));
  document.addEventListener('selectionchange', () => { if (visible) drawTl(); });
  wireTl();
  new ResizeObserver(() => drawTl()).observe($('[data-tlwrap]', el));
  on('change', () => { if (visible) draw(); });
  on('playhead', () => { if (visible) { tlT = S.playhead || 0; drawTl(); } });
}

export async function showText() { visible = true; await loadTranscripts(); draw(); }
export function hideText() { visible = false; $('[data-pv]', root)?.pause(); }

const speechMedia = () => [...new Set(S.project.tracks.V1.filter((c) => c.type === 'video' && S.mediaById[c.mediaId]?.hasAudio).map((c) => c.mediaId))];
async function loadTranscripts() {
  for (const id of speechMedia()) if (!trs[id]) { try { trs[id] = await api('GET', `/api/transcript?p=${enc(S.proj)}&id=${id}`); } catch {} }
}
function hear(i) {
  const x = words[i], m = S.mediaById[x?.mediaId], pv = $('[data-pv]', root);
  if (!x) return;
  if (!m?.playable) return toast('This clip\'s preview copy is still being made', 'err');
  if (pv.dataset.src !== m.urls.play) { pv.src = m.urls.play; pv.dataset.src = m.urls.play; }
  pv.dataset.clip = x.clipId; pv.currentTime = Math.max(0, x.s - 0.05); pv.play().catch(() => {});
  $('[data-pvinfo]', root).textContent = `${m.name} · ${fmt(x.s)} · in the edit at ${fmtTC(x.ts, S.project.settings.fps)}`;
  S.playhead = x.ts; tlT = x.ts; emit('playhead');
}

function draw() {
  if (!root || !S.project) return;
  const missing = speechMedia().filter((id) => !trs[id]);
  words = wordsOf(S.project, S.mediaById, trs);
  const live = new Set(words.map(wkey)); for (const k of [...marks]) if (!live.has(k)) marks.delete(k);
  $('[data-st]', root).innerHTML = missing.length ? `<b>${missing.length}</b> clip${missing.length > 1 ? 's' : ''} with speech not transcribed yet` : words.length ? `${words.length} words · ${fmt(layoutV1(S.project, S.mediaById).at(-1)?.end || 0)} edit` : 'Put shots with speech on V1 (the main story)';
  $('[data-go-tr]', root).hidden = !missing.length;
  const nf = words.filter((w) => isFiller(w.w)).length;
  $('[data-fill]', root).textContent = `Remove fillers${nf ? ` (${nf})` : ''}`;
  $('[data-fill]', root).disabled = !nf;
  $('[data-apply]', root).hidden = $('[data-clearm]', root).hidden = !marks.size;
  $('[data-apply]', root).textContent = `Apply marks (${marks.size})`;
  // paragraphs: one per V1 clip (its name + time), sentences inside
  const L = layoutV1(S.project, S.mediaById);
  let html = '', i = 0;
  for (const x of L) {
    const c = x.clip, m = S.mediaById[c.mediaId], here = [];
    while (i < words.length && words[i].clipId === c.id) here.push(i++);
    const label = `<div class="tx-clip"><span class="mono">${fmtTC(x.start, S.project.settings.fps).replace(/^00:/, '')}</span> ${esc(m?.name || c.type)}</div>`;
    if (!here.length) { html += `<div class="tx-p empty">${label}<span class="muted small">${c.type === 'video' && m?.hasAudio && !trs[c.mediaId] ? 'not transcribed yet' : 'no speech (B-roll / title)'} · ${fmt(x.end - x.start)}</span></div>`; continue; }
    let last = null;
    html += `<div class="tx-p">${label}<p>${here.map((k) => { const w = words[k], gap = last && w.s - last.e > 0.7 ? `<span class="tx-gap" title="${(w.s - last.e).toFixed(1)} s pause">·${(w.s - last.e).toFixed(1)}s·</span> ` : ''; last = w; return `${gap}<span class="tx-w${isFiller(w.w) ? ' filler' : ''}${marks.has(wkey(w)) ? ' struck' : ''}${w.fixed ? ' fixed' : ''}" data-wi="${k}"${w.fixed ? ' title="Corrected"' : ''}>${esc(w.w)}</span> `; }).join('')}</p></div>`;
  }
  $('[data-doc]', root).innerHTML = html || '<div class="muted pad">Nothing on the main story (V1) yet.</div>';
  drawSentences();
  drawTl();
}

function drawSentences() {
  const q = ($('[data-q]', root).value || '').toLowerCase(), list = sentencesOf(words);
  for (const k of [...tick]) if (!list.some((x) => x.key === k)) tick.delete(k);
  $('[data-sents]', root).innerHTML = list.filter((x) => !q || x.text.toLowerCase().includes(q)).map((x) => `<label class="tx-sent"><input type="checkbox" data-sk="${esc(x.key)}"${tick.has(x.key) ? ' checked' : ''}>
    <span><span class="muted small">${fmt(x.e - x.s)}</span> ${esc(x.text)}</span></label>`).join('') || '<div class="muted small">No sentences yet.</div>';
  syncRough();
}
function syncRough() {
  const list = sentencesOf(words).filter((x) => tick.has(x.key)), d = list.reduce((s, x) => s + x.e - x.s + 0.32, 0);
  const b = $('[data-rough]', root); b.disabled = !list.length;
  b.textContent = list.length ? `Build rough cut · ${list.length} sentence${list.length > 1 ? 's' : ''} · ${fmt(d)}` : 'Build rough cut';
}

async function transcribeAll() {
  if (busy) return;
  busy = true;
  const ids = speechMedia().filter((id) => !trs[id]);
  try {
    for (const [k, id] of ids.entries()) {
      const m = S.mediaById[id], clock = progressClock();
      const job = await api('POST', `/api/transcript?p=${enc(S.proj)}`, { mediaId: id, model: $('[data-model]', root).value, lang: $('[data-lang]', root).value });
      await watchJob(job.id, (j) => { $('[data-st]', root).textContent = `Listening to ${m.name} (${k + 1}/${ids.length}) · ${clock.tick(j.progress).elapsed}`; emit('job', { running: true, label: `Transcribing ${k + 1}/${ids.length}` }); });
      trs[id] = await api('GET', `/api/transcript?p=${enc(S.proj)}&id=${id}`);
      draw();
    }
    toast('Transcribed - select words and press Delete to cut them');
  } catch (e) { toast(e.job ? `Transcription failed: ${e.job.log.slice(-1).join(' ')}` : e.message, 'err'); }
  finally { busy = false; emit('job', { running: false }); draw(); }
}

function apply(cuts, label, what) {
  if (!cuts.length) return toast('Nothing to cut');
  const sec = cutSource(S.project, S.mediaById, cuts);
  commit(label);
  toast(`${what(cuts.length)} cut · ${sec.toFixed(1)} s shorter - Ctrl+Z brings it back`);
}
// the words under the text selection: [a, b] or null
function selectedWords() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0), doc = $('[data-doc]', root);
  if (!doc.contains(r.commonAncestorContainer)) return null;
  const at = (node, end) => { const el = (node.nodeType === 3 ? node.parentElement : node).closest('[data-wi]'); if (el) return +el.dataset.wi; const all = [...doc.querySelectorAll('[data-wi]')].filter((x) => sel.containsNode(x, true)).map((x) => +x.dataset.wi); return end ? Math.max(...all) : Math.min(...all); };
  let a = at(r.startContainer, false), b = at(r.endContainer, true);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a > b) [a, b] = [b, a];
  return [a, b];
}
function cutSelection(mark) {
  const ab = selectedWords();
  if (!ab) return toast('Select the words first (drag across them in the text, or on the timeline below)');
  const [a, b] = ab, text = words.slice(a, b + 1).map((w) => w.w).join(' ');
  window.getSelection().removeAllRanges();
  if (mark) { // ✎ strike through / un-strike
    const all = words.slice(a, b + 1).map(wkey), on2 = !all.every((k) => marks.has(k));
    all.forEach((k) => (on2 ? marks.add(k) : marks.delete(k)));
    return draw();
  }
  apply(cutsForSelection(words, a, b), 'Cut words', () => `"${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`);
}
function applyMarks() {
  const idx = words.map((w, i) => (marks.has(wkey(w)) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return;
  const cuts = []; let s = idx[0], p = idx[0];
  for (const i of [...idx.slice(1), Infinity]) { if (i === p + 1) { p = i; continue; } cuts.push(...cutsForSelection(words, s, p)); s = p = i; }
  marks.clear();
  apply(cuts, 'Cut marked words', (n) => `${idx.length} marked word${idx.length > 1 ? 's' : ''} (${n} cut${n > 1 ? 's' : ''})`);
}

// ---------------- ✨ presets ----------------
function presetMenu(anchor) {
  document.querySelector('.ui-menu')?.remove();
  const n = (cuts) => (words.length ? ` <i class="muted">(${cuts.length})</i>` : '');
  const items = [
    ['h', 'Clean up'],
    ['fill', `Ums & ahs${n(fillerCuts(words))}`], ['verbal', `Verbal fillers - basically, matlab, you know…${n(verbalCuts(words))}`],
    ['stutter', `Stutters - "main main", "the the"${n(stutterCuts(words))}`], ['retake', `Retakes - a line said again: keep the last take${n(retakeCuts(words))}`],
    ['headtail', `Silence at the start / end of each shot${n(headTailCuts(words))}`],
    ['all', 'All of the above (one step)'],
    ['h', 'Pauses'], ...Object.entries(PAUSE_PRESETS).map(([k, p]) => [`pause:${k}`, `${p.label}${n(pauseCuts(words, p.min, p.keep))}`]),
    ['h', 'Highlights (new sequence)'], ['hl:15', '15 s highlight'], ['hl:30', '30 s highlight'], ['hl:60', '60 s highlight'], ['hl:q', 'Only the questions'],
  ];
  const m = document.createElement('div'); m.className = 'ui-menu tx-menu';
  m.innerHTML = items.map(([k, l]) => (k === 'h' ? `<div class="muted">${l}</div>` : `<button data-k="${k}">${l}</button>`)).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect(); m.style.top = `${r.bottom + 4}px`; m.style.left = `${Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.left))}px`;
  const close = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', close, true); } };
  setTimeout(() => document.addEventListener('pointerdown', close, true));
  m.onclick = (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k; if (!k) return;
    m.remove(); document.removeEventListener('pointerdown', close, true);
    if (!words.length) return toast('Transcribe first', 'err');
    if (k === 'fill') apply(fillerCuts(words), 'Remove fillers', (x) => `${x} filler${x === 1 ? '' : 's'}`);
    if (k === 'verbal') apply(verbalCuts(words), 'Remove verbal fillers', (x) => `${x} verbal filler${x === 1 ? '' : 's'}`);
    if (k === 'stutter') apply(stutterCuts(words), 'Remove stutters', (x) => `${x} stutter${x === 1 ? '' : 's'}`);
    if (k === 'retake') apply(retakeCuts(words), 'Remove retakes', (x) => `${x} earlier take${x === 1 ? '' : 's'}`);
    if (k === 'headtail') apply(headTailCuts(words), 'Trim shot heads / tails', (x) => `${x} silent head${x === 1 ? '' : 's'} / tail${x === 1 ? '' : 's'}`);
    if (k === 'all') apply([...fillerCuts(words), ...verbalCuts(words), ...stutterCuts(words), ...retakeCuts(words), ...headTailCuts(words)], 'Clean up speech', (x) => `${x} bit${x === 1 ? '' : 's'}`);
    if (k.startsWith('pause:')) { const p = PAUSE_PRESETS[k.slice(6)]; apply(pauseCuts(words, p.min, p.keep), `Pauses: ${p.label}`, (x) => `${x} pause${x === 1 ? '' : 's'}`); }
    if (k.startsWith('hl:')) highlight(k.slice(3));
  };
}
function highlight(kind) {
  const all = sentencesOf(words);
  if (!all.length) return toast('Transcribe first', 'err');
  const q = ($('[data-q]', root).value || '').trim().toLowerCase();
  if (kind === 'k' && !q) return toast('Type the keyword in "Find sentences with…" first', 'err');
  const list = kind === 'q' ? all.filter((x) => /[?？]\s*$/.test(x.text) || /^(kya|kyun|kaise|kab|kahan|kaun|what|why|how|when|where|who)\b/i.test(x.text.trim()))
    : kind === 'k' ? all.filter((x) => x.text.toLowerCase().includes(q)) : pickHighlights(all, +kind);
  if (!list.length) return toast('No sentences found for that', 'err');
  const base = Object.fromEntries(S.project.tracks.V1.map((c) => [c.id, { fit: c.fit, color: c.color, cropX: c.cropX }]));
  const name = kind === 'q' ? 'Questions' : kind === 'k' ? `"${q}"` : `${kind} s highlight`;
  newSequenceWith(name, roughCut(list, base));
  toast(`"${name}" made with ${list.length} sentence${list.length > 1 ? 's' : ''} - a new sequence (), the edit is untouched`);
}

function buildRough() {
  const list = sentencesOf(words).filter((x) => tick.has(x.key));
  if (!list.length) return;
  const base = Object.fromEntries(S.project.tracks.V1.map((c) => [c.id, { fit: c.fit, color: c.color, cropX: c.cropX }]));
  newSequenceWith('Rough cut', roughCut(list, base));
  tick.clear();
  toast(`Rough cut made with ${list.length} sentences - it is a new sequence (), the original edit is untouched`);
}

// ---------------- the timeline strip ----------------
const TLH = 74;
function tlGeom() {
  const wrap = $('[data-tlwrap]', root), L = layoutV1(S.project, S.mediaById), end = Math.max(1, L.at(-1)?.end || 1);
  const W = Math.max(wrap.clientWidth, Math.round(wrap.clientWidth * tlZoom));
  return { wrap, L, end, W, x: (t) => 6 + (t / end) * (W - 12), t: (x) => ((x - 6) / (W - 12)) * end };
}
function drawTl() {
  if (!root || !S.project || !visible) return;
  const G = tlGeom(), cv = $('[data-tl]', root), dpr = Math.min(2, devicePixelRatio || 1);
  cv.style.width = `${G.W}px`; cv.style.height = `${TLH}px`; cv.width = Math.round(G.W * dpr); cv.height = Math.round(TLH * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, G.W, TLH);
  // shots
  for (const x of G.L) {
    const a = G.x(x.start), b = G.x(x.end), sp = words.some((w) => w.clipId === x.clip.id);
    g.fillStyle = sp ? '#1f3b66' : '#2a2d35'; g.fillRect(a, 16, Math.max(1, b - a - 1), TLH - 22);
    g.fillStyle = '#ffffff22'; g.fillRect(b - 1, 16, 1, TLH - 22);
    if (b - a > 60) { g.fillStyle = '#9fb3d1'; g.font = '10px "Segoe UI"'; g.fillText((S.mediaById[x.clip.mediaId]?.name || x.clip.type).slice(0, Math.floor((b - a) / 6)), a + 4, 27); }
  }
  // long pauses
  for (let i = 1; i < words.length; i++) { const p = words[i - 1], w = words[i]; if (p.clipId === w.clipId && w.ts - p.te > 0.7) { g.fillStyle = '#ffffff10'; g.fillRect(G.x(p.te), 34, G.x(w.ts) - G.x(p.te), TLH - 42); g.strokeStyle = '#ffffff30'; g.setLineDash([2, 3]); g.strokeRect(G.x(p.te) + 0.5, 34.5, G.x(w.ts) - G.x(p.te) - 1, TLH - 43); g.setLineDash([]); } }
  // words
  const sel = selectedWords();
  words.forEach((w, i) => {
    const a = G.x(w.ts), b = Math.max(a + 1.5, G.x(w.te) - 0.5);
    g.fillStyle = sel && i >= sel[0] && i <= sel[1] ? '#ffd400' : marks.has(wkey(w)) ? '#ff5d5d' : isFiller(w.w) ? '#ff9933' : '#cfd8e6';
    g.fillRect(a, 38, b - a, TLH - 50);
  });
  // ruler + playhead
  g.fillStyle = '#8a93a3'; g.font = '10px Consolas, monospace';
  const step = G.end / (G.W / 90); const nice = [1, 2, 5, 10, 15, 30, 60, 120].find((s) => s >= step) || 300;
  for (let t = 0; t <= G.end; t += nice) { const x = G.x(t); g.fillRect(x, 0, 1, 5); g.fillText(fmt(t), x + 2, 11); }
  const px = G.x(tlT); g.fillStyle = '#ff9933'; g.fillRect(px - 0.5, 0, 1.5, TLH);
  $('[data-tltc]', root).textContent = `${fmtTC(tlT, S.project.settings.fps)} / ${fmtTC(G.end, S.project.settings.fps)}`;
}
function wordAt(t) { let best = -1, d = Infinity; words.forEach((w, i) => { const dd = t < w.ts ? w.ts - t : t > w.te ? t - w.te : 0; if (dd < d) { d = dd; best = i; } }); return d < 0.6 ? best : -1; }
function selectDoc(a, b) {
  const doc = $('[data-doc]', root), A = doc.querySelector(`[data-wi="${Math.min(a, b)}"]`), B = doc.querySelector(`[data-wi="${Math.max(a, b)}"]`);
  if (!A || !B) return;
  const r = document.createRange(); r.setStartBefore(A); r.setEndAfter(B);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  A.scrollIntoView({ block: 'nearest' });
}
function wireTl() {
  const cv = $('[data-tl]', root), wrap = $('[data-tlwrap]', root);
  let drag = null;
  const tAt = (e) => tlGeom().t(e.clientX - cv.getBoundingClientRect().left);
  cv.addEventListener('pointerdown', (e) => {
    if (!words.length) return;
    cv.setPointerCapture(e.pointerId);
    const t = tAt(e), i = wordAt(t);
    drag = { i0: i, t0: t, moved: false };
    tlT = Math.max(0, t); S.playhead = tlT; emit('playhead'); drawTl();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag || drag.i0 < 0) return;
    const i = wordAt(tAt(e)); if (i < 0) return;
    if (i !== drag.i0 || drag.moved) { drag.moved = true; selectDoc(drag.i0, i); drawTl(); }
  });
  cv.addEventListener('pointerup', () => { const d = drag; drag = null; if (d && !d.moved && d.i0 >= 0) { $('[data-doc]', root).querySelector(`[data-wi="${d.i0}"]`)?.scrollIntoView({ block: 'center' }); hear(d.i0); } });
  wrap.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); const r = wrap.getBoundingClientRect(), fx = (e.clientX - r.left + wrap.scrollLeft) / Math.max(1, wrap.scrollWidth); tlZoom = Math.min(40, Math.max(1, tlZoom * (e.deltaY < 0 ? 1.25 : 0.8))); drawTl(); wrap.scrollLeft = fx * wrap.scrollWidth - (e.clientX - r.left); }, { passive: false });
}
