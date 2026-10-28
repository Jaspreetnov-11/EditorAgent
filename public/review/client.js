// 🔗 Client review page: watch a version, comment at moments (click the bar or press C), draw on the frame, reply,
// and Approve / Request changes. Everything the server sends is shown as text (textContent), never as HTML.
const base = location.pathname.replace(/\/+$/, ''); // /review/<token>
const $ = (id) => document.getElementById(id);
const vid = $('vid'), ink = $('ink');
let info = null, cur = 0, drawing = false, strokes = [], showing = null;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
const tc = (t) => { const s = Math.max(0, t || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`; };
const when = (ms) => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const store = { get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
async function call(method, sub, body) {
  const r = await fetch(base + sub, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { status: r.status, data: j });
  return j;
}
const say = (m, bad = false) => { $('msg').textContent = m; $('msg').className = `msg${bad ? ' bad' : ''}`; };

async function load(first) {
  const had = info?.versions.length || 0;
  try { info = await call('GET', '/api/info'); }
  catch (e) {
    if (e.status === 401 && e.data?.needPw) { $('title').textContent = e.data.title || 'Review'; $('gate').hidden = false; $('app').hidden = true; $('gatePw').focus(); return; }
    if (first || e.status === 410 || e.status === 404) { $('app').hidden = true; $('gone').hidden = false; $('goneMsg').textContent = e.message; }
    return;
  }
  $('gate').hidden = true; $('app').hidden = false;
  $('title').textContent = info.title; document.title = `${info.title} - Review`;
  if (first) { $('name').value = store.get('rv-name') || info.client || ''; pick(info.versions.length - 1); }
  else if (info.versions.length > had && cur === had - 1) { pick(info.versions.length - 1); say(`Version ${ver().n} is here`); } // (a new version came while watching the last one)
  else draw();
}
// a version: its video (kept at the same moment when only the comments changed)
function pick(i) {
  cur = Math.max(0, Math.min(info.versions.length - 1, i));
  vid.src = `${base}/v/${info.versions[cur].n}`;
  clearInk(); draw();
}
const ver = () => info.versions[cur];
function draw() {
  const v = ver();
  $('versions').replaceChildren(...(info.versions.length > 1 ? info.versions.map((x, i) => el('button', { class: i === cur ? 'cur' : '', type: 'button', onclick: () => pick(i) }, `Version ${x.n}${x.status === 'approved' ? ' ✓' : ''}`)) : []));
  const st = $('status'); st.hidden = false; st.className = `pill ${v.status}`;
  st.textContent = { approved: 'Approved', changes: 'Changes requested', waiting: 'Waiting for review' }[v.status] || '';
  $('decided').textContent = v.status === 'waiting' ? `Version ${v.n} - happy with it? Approve it, or ask for changes (add your comments first).` : `Version ${v.n}: ${v.status === 'approved' ? 'approved' : 'changes requested'} by ${v.decidedBy}, ${when(v.decidedAt)}. You can still change your mind.`;
  const mine = info.comments.filter((c) => c.v === v.n), tops = mine.filter((c) => !c.parent).sort((a, b) => a.t - b.t || a.at - b.at);
  $('count').textContent = tops.length ? `(${tops.length})` : '';
  $('list').replaceChildren(...tops.map((c) => {
    const replies = mine.filter((r) => r.parent === c.id).sort((a, b) => a.at - b.at);
    const inp = el('input', { maxlength: '2000', placeholder: 'Reply…', 'aria-label': 'Reply' });
    const send = () => reply(c, inp);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    return el('li', {},
      el('div', {}, el('button', { class: 'link tc', type: 'button', title: 'Go there', onclick: () => seek(c) }, tc(c.t)), ' ', el('span', { class: 'txt' }, String(c.text ?? '').replace(/^(✅|✏️) /u, '')), c.draw ? ' (drawing)' : null),
      el('div', { class: `who${c.team ? ' team' : ''}` }, `${c.by}${c.team ? ' (Limelight)' : ''} · ${when(c.at)}`, c.fixedIn ? el('span', { class: 'fix' }, ` · ✓ Fixed in Version ${c.fixedIn}`) : null),
      replies.length ? el('ul', {}, ...replies.map((r) => el('li', {}, el('span', { class: 'txt' }, r.text), el('div', { class: `who${r.team ? ' team' : ''}` }, `${r.by}${r.team ? ' (Limelight)' : ''} · ${when(r.at)}`)))) : null,
      el('div', { class: 'reply' }, inp, el('button', { class: 'ghost', type: 'button', onclick: send }, 'Reply')));
  }));
  // 🔁 what the team fixed for this version (asked on an earlier one)
  const fixed = info.comments.filter((c) => c.fixedIn === v.n).sort((a, b) => a.v - b.v || a.t - b.t);
  $('fixed').hidden = !fixed.length;
  $('fixedH').textContent = `What changed in Version ${v.n} (${fixed.length} fixed)`;
  $('fixedList').replaceChildren(...fixed.map((c) => el('li', {}, el('span', { class: 'ok-mark' }, '✓ '), el('span', { class: 'txt' }, c.text), el('div', { class: 'who' }, `${c.by} asked on Version ${c.v} at ${tc(c.t)}`))));
  drawRate();
  marks();
}
// ⭐ once the newest version is approved: how the job went (they can change it later)
let rateStars = 0;
function drawRate() {
  const last = info.versions[info.versions.length - 1], r = info.rating;
  $('rate').hidden = last.status !== 'approved' || cur !== info.versions.length - 1;
  if (!rateStars && r) { rateStars = r.stars; $('rtext').value = r.text || ''; }
  $('stars').replaceChildren(...[1, 2, 3, 4, 5].map((n) => el('button', { type: 'button', class: `star${n <= rateStars ? ' on' : ''}`, role: 'radio', 'aria-checked': String(n === rateStars), 'aria-label': `${n} star${n > 1 ? 's' : ''}`, onclick: () => { rateStars = n; drawRate(); } }, '★')));
  $('rdone').textContent = r ? `Thank you - you gave ${r.stars} of 5 (${when(r.at)}).` : '';
  $('rsend').textContent = r ? 'Update feedback' : 'Send feedback';
}
async function rate() {
  const by = $('name').value.trim();
  if (!rateStars) { $('rdone').textContent = 'Pick the stars first'; return; }
  $('rsend').disabled = true;
  try { info = await call('POST', '/api/rate', { stars: rateStars, text: $('rtext').value.trim(), by }); draw(); $('rdone').textContent = 'Thank you - the team sees your feedback ✓'; }
  catch (e) { $('rdone').textContent = e.message; } finally { $('rsend').disabled = false; }
}
$('rsend').onclick = rate;
function marks() {
  const d = vid.duration;
  $('bar').querySelectorAll('i').forEach((x) => x.remove());
  if (!(d > 0)) return;
  for (const c of info.comments.filter((x) => x.v === ver().n && !x.parent)) { const i = el('i', { class: /^(✅|✏️ Changes)/.test(c.text) ? 'dec' : '' }); i.style.left = `${Math.min(100, (c.t / d) * 100)}%`; $('bar').append(i); }
}
function seek(c) { vid.pause(); vid.currentTime = c.t; showInk(c.draw); showing = c.id; vid.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

// ✏️ drawing on the frame: strokes in 0…1 across / down
const pt = (e) => { const r = ink.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
function line(pts) { const p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); p.setAttribute('points', pts.reduce((s, x, i) => s + (i % 2 ? `,${x} ` : x), '')); return p; }
function showInk(d) { ink.replaceChildren(...(d || []).map(line)); }
function clearInk() { strokes = []; showing = null; ink.replaceChildren(); }
function setDrawing(on) {
  drawing = on; ink.classList.toggle('drawing', on); $('draw').classList.toggle('on', on);
  $('draw').textContent = on ? (strokes.length ? '✕ Clear drawing' : 'Drawing… (drag on the picture)') : 'Draw';
  if (on) { vid.pause(); if (showing) clearInk(); }
}
$('draw').onclick = () => { if (drawing && strokes.length) { clearInk(); setDrawing(false); } else setDrawing(!drawing); };
ink.addEventListener('pointerdown', (e) => {
  if (!drawing) return;
  e.preventDefault(); ink.setPointerCapture(e.pointerId);
  const s = [...pt(e)], p = line(s); strokes.push(s); ink.append(p);
  const move = (ev) => { if (s.length < 800) { s.push(...pt(ev)); p.setAttribute('points', line(s).getAttribute('points')); } };
  const up = () => { ink.removeEventListener('pointermove', move); ink.removeEventListener('pointerup', up); ink.removeEventListener('pointercancel', up); $('draw').textContent = '✕ Clear drawing'; };
  ink.addEventListener('pointermove', move); ink.addEventListener('pointerup', up); ink.addEventListener('pointercancel', up);
});

async function comment() {
  const text = $('text').value.trim(), by = $('name').value.trim();
  if (!text) { say('Write a comment first', true); $('text').focus(); return; }
  if (!by) { say('Write your name first', true); $('name').focus(); return; }
  store.set('rv-name', by);
  $('send').disabled = true;
  try {
    const c = await call('POST', '/api/comment', { v: ver().n, t: vid.currentTime, text, by, draw: strokes.filter((s) => s.length >= 4) });
    info.comments.push(c); $('text').value = ''; clearInk(); setDrawing(false); draw();
    say(`Sent at ${tc(c.t)} ✓`);
  } catch (e) { say(e.message, true); } finally { $('send').disabled = false; }
}
async function reply(c, inp) {
  const text = inp.value.trim(), by = $('name').value.trim();
  if (!text) return inp.focus();
  if (!by) { say('Write your name first (above the comment box)', true); $('name').focus(); return; }
  store.set('rv-name', by);
  try { info.comments.push(await call('POST', '/api/comment', { parent: c.id, text, by })); draw(); } catch (e) { say(e.message, true); }
}
async function decide(decision) {
  const by = $('name').value.trim();
  if (!by) { say('Write your name first', true); $('name').focus(); return; }
  if (decision === 'approve' && !confirm(`Approve Version ${ver().n}?`)) return;
  store.set('rv-name', by);
  try { info = await call('POST', '/api/decide', { v: ver().n, decision, by, text: $('dtext').value.trim() }); $('dtext').value = ''; draw(); say(decision === 'approve' ? 'Approved - thank you ✓' : 'Sent - the team will make the changes ✓'); }
  catch (e) { say(e.message, true); }
}
$('send').onclick = comment;
$('approve').onclick = () => decide('approve');
$('changes').onclick = () => decide('changes');
$('text').addEventListener('focus', () => vid.pause());
$('text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); comment(); } });
$('gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await call('POST', '/api/unlock', { password: $('gatePw').value }); $('gateMsg').textContent = ''; load(true); }
  catch (er) { $('gateMsg').textContent = er.message; }
});
$('bar').addEventListener('click', (e) => { const r = $('bar').getBoundingClientRect(); if (vid.duration > 0) { vid.currentTime = ((e.clientX - r.left) / r.width) * vid.duration; vid.pause(); setTimeout(() => $('text').focus(), 0); } });
const upd = () => { $('at').textContent = `at ${tc(vid.currentTime)}`; $('barFill').style.width = vid.duration > 0 ? `${(vid.currentTime / vid.duration) * 100}%` : '0'; };
vid.addEventListener('timeupdate', upd); vid.addEventListener('seeked', upd);
vid.addEventListener('loadedmetadata', () => { upd(); marks(); });
vid.addEventListener('play', () => { if (showing) clearInk(); if (drawing) setDrawing(false); });
document.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey || $('app').hidden) return;
  if (e.key === 'c' || e.key === 'C') { e.preventDefault(); vid.pause(); $('text').focus(); }
  else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); vid.paused ? vid.play() : vid.pause(); }
  else if (e.key === 'ArrowLeft' && e.target === document.body) vid.currentTime = Math.max(0, vid.currentTime - 1);
  else if (e.key === 'ArrowRight' && e.target === document.body) vid.currentTime += 1;
});
load(true);
setInterval(() => { if (!document.hidden && info) load(false); }, 20000); // (the team's replies, a new version)
