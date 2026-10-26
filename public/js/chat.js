// 💬 Office chat (/chat.html), like WhatsApp: the chat list on the left (📢 Limelight Office first, then groups and
// one-to-ones by their last message), the open chat on the right. Text, replies, photos / videos / files (button, paste
// or drop), delete your own, ✓ sent / ✓✓ read by everyone, "typing…", who is online. Live over /api/chat/stream.
// In the editor it runs in a side panel (?embed=1, tabs.js / main.js): it tells the page around it how many are unread
// (postMessage { chat: 'unread', n }) and keeps running while the panel is closed, so the badge and the sound still come.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const EMBED = new URLSearchParams(location.search).has('embed');
const root = $('#chat');
if (EMBED) document.documentElement.classList.add('ch-embed');

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401) { location.href = '/team/logout'; throw new Error('Sign in again'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}
function toast(msg) {
  const t = document.createElement('div'); t.className = 'ch-toast'; t.textContent = msg; document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

// ---- state ----
let me = '', people = [], online = new Set(), rooms = [], cur = null; // cur: the open room's id
const msgs = new Map(); // room -> { list, more }
const typing = new Map(); // room -> Map(name -> until)
let replyTo = null, search = '';
let projRoom = null; // the room of the project the editor around this panel has open (EMBED)

const initials = (n) => String(n).replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const hue = (n) => [...String(n)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
const avatar = (r, size = '') => {
  if (r.kind === 'office') return `<span class="ch-av ch-av-office ${size}">📢</span>`;
  if (r.kind === 'project') return `<span class="ch-av ch-av-office ${size}">📁</span>`;
  if (r.kind === 'group') return `<span class="ch-av ${size}" style="--h:${hue(r.name)}">${esc(initials(r.name))}</span>`;
  return `<span class="ch-av ${size}" style="--h:${hue(r.name)}">${esc(initials(r.name))}${online.has(r.other) ? '<i class="on"></i>' : ''}</span>`;
};
const personAv = (n) => `<span class="ch-av" style="--h:${hue(n)}">${esc(initials(n))}${online.has(n) ? '<i class="on"></i>' : ''}</span>`;
const roleOf = (n) => people.find((p) => p.name === n)?.role || '';
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function when(t) {
  const d = new Date(t), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return hm(t);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function dayLabel(t) {
  const d = new Date(t), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const size = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
// text: links clickable, @Name in yellow, *bold*, newlines kept
function richText(t) {
  let h = esc(t);
  h = h.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  h = h.replace(/(^|[\s(])\*([^*\n]{1,200})\*(?=[\s).,!?]|$)/g, '$1<b>$2</b>');
  for (const p of people) {
    const n = esc(p.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    h = h.replace(new RegExp(`(^|\\s)@(${n})\\b`, 'gi'), (m, a, b) => `${a}<span class="ch-at${p.name === me ? ' me' : ''}">@${b}</span>`);
  }
  return h.replace(/\n/g, '<br>');
}
const fileUrl = (room, f, dl = false) => `/api/chat/file?room=${enc(room)}&id=${enc(f.id)}${dl ? '&dl=1' : ''}`;
const isImg = (f) => /^image\/(jpeg|png|gif|webp)$/.test(f.type) || /\.(jpe?g|png|gif|webp)$/i.test(f.ext);
const isVid = (f) => /^video\/(mp4|webm|quicktime)$/.test(f.type) || /\.(mp4|webm|m4v|mov)$/i.test(f.ext);
const isAud = (f) => /^audio\//.test(f.type) || /\.(mp3|wav|m4a|aac|ogg)$/i.test(f.ext);
const fileIcon = (f) => (/pdf/.test(f.type) || /\.pdf$/i.test(f.ext) ? '📕' : /\.(psd|ai|svg|eps)$/i.test(f.ext) ? '🎨' : /\.(zip|rar|7z)$/i.test(f.ext) ? '🗜' : /\.(docx?|txt|rtf)$/i.test(f.ext) ? '📝' : /\.(xlsx?|csv)$/i.test(f.ext) ? '📊' : /\.(pptx?|key)$/i.test(f.ext) ? '📽' : '📄');

// ---- the layout ----
root.innerHTML = `
  <aside class="ch-side">
    <header class="ch-sh"><div class="ch-me" data-me></div><div class="ch-acts">
      <button class="ch-ib" data-newdm title="New chat" aria-label="New chat"><svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z"/><path d="M12 8v5M9.5 10.5h5"/></svg></button>
      <button class="ch-ib" data-newgroup title="New group" aria-label="New group"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><path d="M18 8v6M15 11h6"/></svg></button>
      ${EMBED ? '<button class="ch-ib" data-close title="Close chat" aria-label="Close chat"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' : ''}
    </div></header>
    <div class="ch-search"><input data-search type="search" placeholder="Search or start a new chat" aria-label="Search chats"></div>
    <div class="ch-list" data-list role="list"></div>
  </aside>
  <main class="ch-main" data-main>
    <div class="ch-empty"><div class="ch-empty-in"><span class="ch-logo">💬</span><h2>Limelight Chat</h2><p>Message anyone in the office - editors, designers, managers.<br>Pick a chat on the left, or start a new one.</p></div></div>
  </main>`;
const listEl = $('[data-list]'), mainEl = $('[data-main]');

function drawMe() {
  $('[data-me]').innerHTML = `${personAv(me)}<div><b>${esc(me)}</b><small>${online.size} online</small></div>`;
}
function typingText(id) {
  const t = typing.get(id); if (!t) return '';
  const who = [...t.entries()].filter(([, u]) => u > Date.now()).map(([n]) => n);
  if (!who.length) return '';
  const r = rooms.find((x) => x.id === id);
  return r?.kind === 'dm' ? 'typing…' : `${who.slice(0, 2).join(', ')} typing…`;
}
function drawList() {
  const s = search.trim().toLowerCase();
  const shown = rooms.filter((r) => !s || r.name.toLowerCase().includes(s));
  // people with no chat yet, found by the search: start one
  const starters = s ? people.filter((p) => p.name !== me && p.name.toLowerCase().includes(s) && !rooms.some((r) => r.kind === 'dm' && r.other === p.name)) : [];
  listEl.innerHTML = shown.map((r) => {
    const l = r.last, ty = typingText(r.id);
    const prev = ty ? `<span class="ch-ty">${esc(ty)}</span>` : !l ? '<span class="muted">No messages yet</span>'
      : `${l.from === me ? `${tick(r, l.id)} ` : r.kind !== 'dm' ? `${esc(l.from)}: ` : ''}${l.deleted ? '<i>🚫 This message was deleted</i>' : l.file && !l.text ? `${isImg(l.file) ? '📷 Photo' : isVid(l.file) ? '🎬 Video' : `📎 ${esc(l.file.name)}`}` : esc(l.text)}`;
    return `<button class="ch-item${r.id === cur ? ' on' : ''}" data-room="${esc(r.id)}" role="listitem">${avatar(r)}
      <div class="ch-it-body"><div class="ch-it-top"><b>${esc(r.name)}</b><small class="${r.unread ? 'ch-new' : ''}">${l ? when(l.at) : ''}</small></div>
      <div class="ch-it-bot"><span class="ch-prev">${prev}</span>${r.unread ? `<span class="ch-badge">${r.unread > 99 ? '99+' : r.unread}</span>` : ''}</div></div></button>`;
  }).join('') + (starters.length ? `<div class="ch-sec">People</div>${starters.map((p) => `<button class="ch-item" data-person="${esc(p.name)}">${personAv(p.name)}<div class="ch-it-body"><div class="ch-it-top"><b>${esc(p.name)}</b></div><div class="ch-it-bot"><span class="ch-prev muted">${esc(p.role)}${online.has(p.name) ? ' · online' : ''}</span></div></div></button>`).join('')}` : '')
    + (!shown.length && !starters.length ? '<div class="ch-none">No chats found</div>' : '');
  tellUnread();
}
// ✓ sent, ✓✓ read by everyone else in the chat (yellow)
function tick(r, id) {
  const others = Object.values(r.reads || {});
  const all = others.length && others.every((n) => n >= id);
  return `<span class="ch-tick${all ? ' read' : ''}" title="${all ? 'Read' : 'Sent'}">${all ? '✓✓' : '✓'}</span>`;
}
// (in a project's panel: the count of that project's chat)
function tellUnread() {
  const pr = projRoom && rooms.find((r) => r.id === projRoom);
  const n = projRoom ? pr?.unread || 0 : rooms.reduce((a, r) => a + r.unread, 0);
  document.title = n ? `(${n}) Limelight Chat` : 'Limelight Chat';
  if (window.parent !== window) window.parent.postMessage({ chat: 'unread', n }, location.origin);
}

// ---- the open chat ----
function openRoom(id) {
  cur = id; replyTo = null;
  const r = rooms.find((x) => x.id === id);
  if (!r) return;
  root.classList.add('ch-open');
  const sub = r.kind === 'dm' ? (online.has(r.other) ? 'online' : roleOf(r.other)) : `${r.members.length} people`;
  mainEl.innerHTML = `
    <header class="ch-head"><button class="ch-ib ch-back" data-back aria-label="Back to chats"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <button class="ch-head-who" data-info>${avatar(r)}<div><b>${esc(r.name)}</b><small data-sub>${esc(sub)}</small></div></button>
      <button class="ch-ib" data-info title="Chat info" aria-label="Chat info"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg></button>
      ${EMBED ? '<button class="ch-ib" data-close title="Close chat" aria-label="Close chat"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' : ''}</header>
    <div class="ch-msgs" data-msgs tabindex="0" aria-live="polite"></div>
    <div class="ch-drop" data-drop hidden><div>Drop to send</div></div>
    <footer class="ch-foot">
      <div class="ch-reply" data-reply hidden></div>
      <div class="ch-bar">
        <button class="ch-ib" data-emoji title="Emoji" aria-label="Emoji"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1.8 2 5.2 2 7 0"/><path d="M9 9.5v.5M15 9.5v.5"/></svg></button>
        <button class="ch-ib" data-attach title="Send a photo, video or file" aria-label="Attach a file"><svg viewBox="0 0 24 24"><path d="M20 11.5l-8 8a5 5 0 01-7-7l8.5-8.5a3.3 3.3 0 014.7 4.7L9.7 17.2a1.7 1.7 0 01-2.4-2.4L15 7"/></svg></button>
        <input type="file" data-file multiple hidden>
        <textarea data-input rows="1" placeholder="Type a message" aria-label="Message"></textarea>
        <button class="ch-send" data-send title="Send (Enter)" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg></button>
      </div>
      <div class="ch-emojis" data-emojis hidden>${'😀 😂 🤣 😊 😍 😘 😎 🤔 😅 😢 😭 😡 👍 👎 👌 🙏 👏 💪 🔥 ❤️ 🎉 ✅ ❌ ⚠️ 🎬 🎥 📸 🎨 🎵 ⏰ 🚀 💯 👀 🤝 😴 🍵'.split(' ').map((e) => `<button>${e}</button>`).join('')}</div>
    </footer>`;
  drawList();
  const box = $('[data-msgs]'), input = $('[data-input]');
  if (!msgs.has(id)) { box.innerHTML = '<div class="ch-loading">Loading…</div>'; loadHistory(id).then(() => { if (cur === id) { drawMsgs(true); markRead(); } }); }
  else { drawMsgs(true); markRead(); }
  box.addEventListener('scroll', () => { if (box.scrollTop < 80) loadOlder(); });
  input.addEventListener('input', () => { grow(input); sendTyping(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); } if (e.key === 'Escape') setReply(null); });
  input.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); sendFiles(fs); } });
  $('[data-send]').onclick = sendText;
  $('[data-attach]').onclick = () => $('[data-file]').click();
  $('[data-file]').onchange = (e) => { sendFiles([...e.target.files]); e.target.value = ''; };
  $('[data-emoji]').onclick = () => { $('[data-emojis]').hidden = !$('[data-emojis]').hidden; };
  $('[data-emojis]').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; insertAt(input, b.textContent); };
  for (const b of mainEl.querySelectorAll('[data-info]')) b.onclick = () => roomInfo(id);
  $('[data-back]').onclick = () => { cur = null; root.classList.remove('ch-open'); drawList(); };
  const drop = $('[data-drop]');
  mainEl.ondragover = (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.hidden = false; } };
  drop.ondragleave = () => { drop.hidden = true; };
  mainEl.ondrop = (e) => { e.preventDefault(); drop.hidden = true; sendFiles([...e.dataTransfer.files]); };
  if (matchMedia('(pointer: fine)').matches) input.focus();
}
function grow(t) { t.style.height = 'auto'; t.style.height = `${Math.min(140, t.scrollHeight)}px`; }
function insertAt(t, s) { const a = t.selectionStart ?? t.value.length; t.value = t.value.slice(0, a) + s + t.value.slice(t.selectionEnd ?? a); t.selectionStart = t.selectionEnd = a + s.length; t.focus(); grow(t); }

async function loadHistory(id) {
  const h = await api('GET', `/api/chat/history?room=${enc(id)}`);
  msgs.set(id, { list: h.messages, more: h.more });
}
let loadingOlder = false;
async function loadOlder() {
  const id = cur, m = msgs.get(id);
  if (!m?.more || loadingOlder || !m.list.length) return;
  loadingOlder = true;
  try {
    const h = await api('GET', `/api/chat/history?room=${enc(id)}&before=${m.list[0].id}`);
    m.list = [...h.messages, ...m.list]; m.more = h.more;
    if (cur === id) { const box = $('[data-msgs]'), from = box.scrollHeight - box.scrollTop; drawMsgs(); box.scrollTop = box.scrollHeight - from; }
  } catch {} finally { loadingOlder = false; }
}
function msgHTML(r, m, prev) {
  const mine = m.from === me, first = !prev || prev.from !== m.from || m.at - prev.at > 5 * 60e3 || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
  let body = '';
  if (m.deleted) body = `<div class="ch-txt ch-del">🚫 ${mine ? 'You deleted this message' : 'This message was deleted'}</div>`;
  else {
    if (m.reply) body += `<button class="ch-quote" data-jump="${m.reply.id}" style="--h:${hue(m.reply.from)}"><b>${m.reply.from === me ? 'You' : esc(m.reply.from)}</b><span>${esc(m.reply.text) || '<i>deleted</i>'}</span></button>`;
    if (m.file) {
      const f = m.file, u = fileUrl(r.id, f);
      if (isImg(f)) body += `<a class="ch-img" href="${u}" target="_blank" rel="noopener" data-view="${esc(u)}"><img src="${u}" alt="${esc(f.name)}" loading="lazy"></a>`;
      else if (isVid(f)) body += `<video class="ch-vid" src="${u}" controls preload="metadata"></video>`;
      else if (isAud(f)) body += `<audio class="ch-aud" src="${u}" controls preload="none"></audio>`;
      if (!isImg(f) || !m.text) body += `<a class="ch-filecard" href="${fileUrl(r.id, f, true)}" download="${esc(f.name)}"><span class="ch-fi">${fileIcon(f)}</span><span class="ch-fn"><b>${esc(f.name)}</b><small>${size(f.size)} · Download</small></span></a>`;
    }
    if (m.text) body += `<div class="ch-txt">${richText(m.text)}</div>`;
  }
  const name = !mine && r.kind !== 'dm' && first ? `<div class="ch-from" style="--h:${hue(m.from)}">${esc(m.from)}</div>` : '';
  const pinged = !mine && m.text && new RegExp(`(^|\\s)@${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(m.text);
  return `<div class="ch-row${mine ? ' mine' : ''}${first ? ' first' : ''}${pinged ? ' pinged' : ''}" data-id="${m.id}">
    ${!mine && r.kind !== 'dm' ? (first ? personAv(m.from) : '<span class="ch-av-gap"></span>') : ''}
    <div class="ch-bub">${name}${body}<span class="ch-meta">${hm(m.at)}${mine && !m.deleted ? ` ${tick(r, m.id)}` : ''}</span>
      ${m.deleted ? '' : `<button class="ch-more" data-more="${m.id}" aria-label="Message options"><svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg></button>`}</div></div>`;
}
function drawMsgs(toEnd = false) {
  const box = $('[data-msgs]'), r = rooms.find((x) => x.id === cur), m = msgs.get(cur);
  if (!box || !r || !m) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let h = m.more ? '<div class="ch-loading">Scroll up for older messages</div>' : `<div class="ch-start">${r.kind === 'office' ? '📢 Everyone in the office is in this group.' : r.kind === 'group' ? `Group made by ${esc(r.by === me ? 'you' : r.by)}` : r.kind === 'project' ? `📁 Chat of the project ${esc(r.name)} - everyone who can open this project is in it.` : `This is the start of your chat with ${esc(r.name)}`}</div>`;
  let prev = null;
  for (const x of m.list) {
    if (!prev || new Date(prev.at).toDateString() !== new Date(x.at).toDateString()) h += `<div class="ch-day"><span>${dayLabel(x.at)}</span></div>`;
    h += msgHTML(r, x, prev); prev = x;
  }
  box.innerHTML = h;
  if (toEnd || near) box.scrollTop = box.scrollHeight;
  drawSub();
}
// one new message at the end (a full redraw would stop a video someone is watching)
function addMsg(r, m) {
  const box = $('[data-msgs]'), list = msgs.get(r.id)?.list || [], prev = list[list.indexOf(m) - 1];
  if (!box) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let h = '';
  if (!prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString()) h += `<div class="ch-day"><span>${dayLabel(m.at)}</span></div>`;
  box.insertAdjacentHTML('beforeend', h + msgHTML(r, m, prev));
  if (near || m.from === me) box.scrollTop = box.scrollHeight;
}
// the line under the chat's name: typing… / online / how many people
function drawSub() {
  const r = rooms.find((x) => x.id === cur), sub = $('[data-sub]');
  if (!r || !sub) return;
  const ty = typingText(cur);
  sub.textContent = ty || (r.kind === 'dm' ? (online.has(r.other) ? 'online' : roleOf(r.other)) : `${r.members.length} people`);
  sub.classList.toggle('ch-ty', !!ty);
}
// ✓ / ✓✓ of my messages in the open chat, after someone read
function drawTicks() {
  const r = rooms.find((x) => x.id === cur);
  if (!r) return;
  for (const el of mainEl.querySelectorAll('.ch-row.mine .ch-tick')) el.outerHTML = tick(r, +el.closest('.ch-row').dataset.id);
}
// a message's menu: reply, copy, delete
mainEl.addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  const jump = e.target.closest('[data-jump]');
  const view = e.target.closest('[data-view]');
  if (view && !e.ctrlKey && !e.metaKey) { e.preventDefault(); return viewer(view.dataset.view); }
  if (jump) { const el = mainEl.querySelector(`.ch-row[data-id="${jump.dataset.jump}"]`); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); } return; }
  document.querySelector('.ch-menu')?.remove();
  if (!more) return;
  const id = +more.dataset.more, m = msgs.get(cur)?.list.find((x) => x.id === id);
  if (!m) return;
  const mayDel = m.from === me || roleOf(me) === 'owner';
  const menu = document.createElement('div'); menu.className = 'ch-menu';
  menu.innerHTML = `<button data-a="reply">↩ Reply</button>${m.text ? '<button data-a="copy">⧉ Copy</button>' : ''}${m.file ? `<a href="${fileUrl(cur, m.file, true)}" download>⬇ Download</a>` : ''}${mayDel ? '<button data-a="del" class="danger">🗑 Delete</button>' : ''}`;
  document.body.append(menu);
  const b = more.getBoundingClientRect();
  menu.style.top = `${Math.min(innerHeight - menu.offsetHeight - 8, b.bottom + 4)}px`;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, b.right - menu.offsetWidth))}px`;
  menu.onclick = async (ev) => {
    const a = ev.target.closest('[data-a]')?.dataset.a; menu.remove();
    if (a === 'reply') setReply(m);
    if (a === 'copy') navigator.clipboard?.writeText(m.text).then(() => toast('Copied'), () => {});
    if (a === 'del' && confirm('Delete this message for everyone?')) api('POST', `/api/chat/delete?room=${enc(cur)}`, { id }).catch((x) => toast(x.message));
  };
  e.stopPropagation();
});
document.addEventListener('click', (e) => { if (!e.target.closest('.ch-menu, [data-more]')) document.querySelector('.ch-menu')?.remove(); if (!e.target.closest('[data-emojis], [data-emoji]')) { const em = $('[data-emojis]'); if (em) em.hidden = true; } });
function setReply(m) {
  replyTo = m; const el = $('[data-reply]'); if (!el) return;
  el.hidden = !m;
  if (m) { el.innerHTML = `<div class="ch-quote" style="--h:${hue(m.from)}"><b>${m.from === me ? 'You' : esc(m.from)}</b><span>${esc(m.text || m.file?.name || '')}</span></div><button class="ch-ib" data-noreply aria-label="Cancel reply"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`; $('[data-noreply]').onclick = () => setReply(null); $('[data-input]')?.focus(); }
}
function viewer(u) {
  const v = document.createElement('div'); v.className = 'ch-viewer';
  v.innerHTML = `<img src="${esc(u)}" alt=""><a class="ch-ib" href="${esc(u)}&dl=1" download aria-label="Download"><svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></a>`;
  v.onclick = (e) => { if (!e.target.closest('a')) v.remove(); };
  document.body.append(v);
}

// ---- sending ----
async function sendText() {
  const input = $('[data-input]'), text = input.value.trim();
  if (!text || !cur) return;
  const room = cur, reply = replyTo?.id;
  input.value = ''; grow(input); setReply(null);
  try { await api('POST', `/api/chat/send?room=${enc(room)}`, { text, reply }); }
  catch (e) { toast(e.message); if (!input.value) { input.value = text; grow(input); } }
}
function sendFiles(files) {
  const room = cur; if (!room) return;
  for (const f of files) {
    if (f.size > 1 << 30) { toast(`${f.name}: files up to 1 GB can be sent`); continue; }
    const caption = files.length === 1 ? $('[data-input]').value.trim() : '';
    if (caption) { $('[data-input]').value = ''; grow($('[data-input]')); }
    const bar = document.createElement('div'); bar.className = 'ch-up'; bar.innerHTML = `<span>📤 ${esc(f.name)}</span><i><b></b></i>`;
    $('[data-msgs]')?.after(bar);
    const x = new XMLHttpRequest();
    x.open('POST', `/api/chat/upload?room=${enc(room)}&name=${enc(f.name)}`);
    x.upload.onprogress = (e) => { if (e.lengthComputable) bar.querySelector('b').style.width = `${(100 * e.loaded) / e.total}%`; };
    x.onload = async () => {
      bar.remove();
      let j = {}; try { j = JSON.parse(x.responseText); } catch {}
      if (x.status !== 200) return toast(j.error || `${f.name} could not be sent`);
      try { await api('POST', `/api/chat/send?room=${enc(room)}`, { text: caption, reply: replyTo?.id, file: { ...j, name: f.name, type: f.type } }); setReply(null); } catch (e) { toast(e.message); }
    };
    x.onerror = () => { bar.remove(); toast(`${f.name} could not be sent - is the editor still running?`); };
    x.send(f);
  }
}
let typedAt = 0;
function sendTyping() {
  if (!cur || Date.now() - typedAt < 2500) return;
  typedAt = Date.now(); api('POST', `/api/chat/typing?room=${enc(cur)}`).catch(() => {});
}
function markRead() {
  const r = rooms.find((x) => x.id === cur), m = msgs.get(cur);
  if (!r || !m || document.hidden || (EMBED && !shown)) return;
  const top = m.list[m.list.length - 1]?.id || 0;
  if (r.unread || top > (r._readSent || 0)) { r.unread = 0; r._readSent = top; drawList(); api('POST', `/api/chat/read?room=${enc(r.id)}`, { upto: top }).catch(() => {}); }
}

// ---- new chat / new group / chat info ----
function sheet(title, html) {
  const d = document.createElement('div'); d.className = 'ch-sheet';
  d.innerHTML = `<div class="ch-sheet-in" role="dialog" aria-label="${esc(title)}"><header><button class="ch-ib" data-x aria-label="Close"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button><b>${esc(title)}</b></header><div class="ch-sheet-body">${html}</div></div>`;
  d.onclick = (e) => { if (e.target === d || e.target.closest('[data-x]')) d.remove(); };
  root.append(d);
  return d;
}
const peopleRows = (list, check = null) => list.map((p) => `<label class="ch-item ch-pick">${personAv(p.name)}<div class="ch-it-body"><div class="ch-it-top"><b>${esc(p.name)}</b></div><div class="ch-it-bot"><span class="ch-prev muted">${esc(p.role)}${online.has(p.name) ? ' · online' : ''}</span></div></div>${check ? `<input type="checkbox" value="${esc(p.name)}" ${check(p) ? 'checked' : ''}>` : `<input type="radio" name="p" value="${esc(p.name)}" hidden>`}</label>`).join('');
function newDm() {
  const others = people.filter((p) => p.name !== me);
  const d = sheet('New chat', others.length ? `<div class="ch-list">${peopleRows(others)}</div>` : '<p class="ch-none">Nobody else on the team yet - the owner adds people in 👥 Team.</p>');
  d.onchange = (e) => { if (e.target.name === 'p') { d.remove(); startDm(e.target.value); } };
}
async function startDm(name) {
  try { const r = await api('POST', '/api/chat/direct', { name }); if (!rooms.some((x) => x.id === r.id)) rooms.unshift(r); search = ''; $('[data-search]').value = ''; openRoom(r.id); } catch (e) { toast(e.message); }
}
function newGroup() {
  const others = people.filter((p) => p.name !== me);
  const d = sheet('New group', `<label class="ch-field"><span>Group name</span><input data-gname maxlength="60" placeholder="e.g. MP Tourism shoot"></label><div class="ch-sec">Add people</div><div class="ch-list">${peopleRows(others, () => false)}</div><button class="ch-primary" data-make>Create group</button>`);
  $('[data-gname]', d).focus();
  $('[data-make]', d).onclick = async () => {
    const name = $('[data-gname]', d).value.trim(), members = [...d.querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value);
    if (!name) return toast('Give the group a name');
    try { const r = await api('POST', '/api/chat/group', { name, members }); d.remove(); if (!rooms.some((x) => x.id === r.id)) rooms.unshift(r); openRoom(r.id); } catch (e) { toast(e.message); }
  };
}
function roomInfo(id) {
  const r = rooms.find((x) => x.id === id); if (!r) return;
  const mayEdit = r.kind === 'group' && (r.by === me || roleOf(me) === 'owner');
  const mem = people.filter((p) => r.members.includes(p.name));
  const files = (msgs.get(id)?.list || []).filter((m) => m.file && !m.deleted).slice(-24).reverse();
  const d = sheet(r.kind === 'dm' ? 'Contact info' : 'Group info', `
    <div class="ch-info-top">${avatar(r, 'big')}<h3>${esc(r.name)}</h3><small>${r.kind === 'dm' ? esc(roleOf(r.other)) : `Group · ${r.members.length} people`}</small></div>
    ${mayEdit ? `<label class="ch-field"><span>Group name</span><input data-gname maxlength="60" value="${esc(r.name)}"></label>` : ''}
    ${files.length ? `<div class="ch-sec">Media and files</div><div class="ch-media">${files.map((m) => isImg(m.file) ? `<a href="${fileUrl(id, m.file)}" target="_blank" rel="noopener"><img src="${fileUrl(id, m.file)}" alt="" loading="lazy"></a>` : `<a href="${fileUrl(id, m.file, true)}" download title="${esc(m.file.name)}"><span>${isVid(m.file) ? '🎬' : fileIcon(m.file)}</span></a>`).join('')}</div>` : ''}
    ${r.kind !== 'dm' ? `<div class="ch-sec">${r.kind === 'office' ? 'Everyone in the office' : 'People'}</div><div class="ch-list">${mayEdit ? peopleRows(people.filter((p) => p.name !== me), (p) => r.members.includes(p.name)) : mem.map((p) => `<button class="ch-item" data-dm="${esc(p.name)}">${personAv(p.name)}<div class="ch-it-body"><div class="ch-it-top"><b>${p.name === me ? 'You' : esc(p.name)}</b>${p.name === r.by ? '<small>made the group</small>' : ''}</div><div class="ch-it-bot"><span class="ch-prev muted">${esc(p.role)}${online.has(p.name) ? ' · online' : ''}</span></div></div></button>`).join('')}</div>` : ''}
    ${mayEdit ? '<button class="ch-primary" data-save>Save changes</button>' : ''}
    ${r.kind === 'group' ? '<button class="ch-danger" data-leave>Leave group</button>' : ''}`);
  d.querySelector('[data-save]')?.addEventListener('click', async () => {
    const members = [me, ...[...d.querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value)];
    try { await api('POST', `/api/chat/edit?room=${enc(id)}`, { title: $('[data-gname]', d).value, members }); d.remove(); toast('Saved'); } catch (e) { toast(e.message); }
  });
  d.querySelector('[data-leave]')?.addEventListener('click', async () => {
    if (!confirm(`Leave ${r.name}?`)) return;
    try { await api('POST', `/api/chat/edit?room=${enc(id)}`, { leave: true }); d.remove(); } catch (e) { toast(e.message); }
  });
  d.addEventListener('click', (e) => { const p = e.target.closest('[data-dm]')?.dataset.dm; if (p && p !== me) { d.remove(); startDm(p); } });
}

// ---- the list's buttons ----
listEl.addEventListener('click', (e) => {
  const r = e.target.closest('[data-room]')?.dataset.room, p = e.target.closest('[data-person]')?.dataset.person;
  if (r) openRoom(r); else if (p) startDm(p);
});
$('[data-search]').addEventListener('input', (e) => { search = e.target.value; drawList(); });
$('[data-newdm]').onclick = newDm;
$('[data-newgroup]').onclick = newGroup;
root.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) window.parent.postMessage({ chat: 'close' }, location.origin); });

// ---- 🔔 a new message: a soft sound, and a notification when this window is not looked at ----
let actx = null;
function ding() {
  try {
    actx ||= new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    o.type = 'sine'; o.frequency.setValueAtTime(880, t); o.frequency.setValueAtTime(1320, t + 0.09);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.34);
  } catch {}
}
function notify(r, m) {
  const looking = !document.hidden && (!EMBED || shown) && cur === r.id;
  if (looking) return;
  ding();
  if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || (EMBED && !shown))) {
    try {
      const n = new Notification(r.kind === 'dm' ? m.from : `${m.from} · ${r.name}`, { body: m.text || (m.file ? `📎 ${m.file.name}` : ''), icon: '/img/favicon.png?v=4', tag: `chat-${r.id}` });
      n.onclick = () => { window.focus(); if (EMBED) window.parent.postMessage({ chat: 'open' }, location.origin); openRoom(r.id); n.close(); };
    } catch {}
  }
}
const askNotify = () => { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); };
document.addEventListener('pointerdown', askNotify, { once: true });

// in the editor's side panel: whether it is shown (only then are messages read)
let shown = !EMBED;
// 📁 the editor's project in front: its chat is opened (made the first time)
async function toProject(p) {
  if (!p) { projRoom = null; tellUnread(); return; }
  try {
    const r = await api('POST', '/api/chat/project', { project: p });
    if (!rooms.some((x) => x.id === r.id)) rooms.push(r);
    projRoom = r.id; openRoom(r.id); tellUnread();
  } catch (e) { projRoom = null; tellUnread(); }
}
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data?.chat === 'project') return toProject(e.data.project);
  if (e.origin !== location.origin || e.data?.chat !== 'shown') return;
  shown = !!e.data.on;
  if (shown) wake(); else rest();
  if (shown) { markRead(); if (cur && matchMedia('(pointer: fine)').matches) $('[data-input]')?.focus(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) markRead(); });

// ---- 🔴 live ----
async function refresh() {
  const j = await api('GET', '/api/chat');
  me = j.me; people = j.people; online = new Set(j.online);
  const old = new Map(rooms.map((r) => [r.id, r]));
  rooms = j.rooms.map((r) => ({ ...r, _readSent: old.get(r.id)?._readSent }));
  if (projRoom && !rooms.some((r) => r.id === projRoom) && old.get(projRoom)) rooms.push(old.get(projRoom)); // (an empty project chat is not in the list yet)
  if (cur && !rooms.some((r) => r.id === cur)) { cur = null; root.classList.remove('ch-open'); mainEl.innerHTML = '<div class="ch-empty"><div class="ch-empty-in"><span class="ch-logo">💬</span><h2>Limelight Chat</h2><p>You are no longer in that chat.</p></div></div>'; }
  drawMe(); drawList();
}
// 🔌 the chat beside the editor keeps no connection open while its panel is closed: the server speaks HTTP/1.1 and the
// browser has only 6 connections to it for the whole window - the monitor's videos and each clip's sound need them, and
// an always-open chat stream made the preview stutter. Closed, it looks every 10 s (a short GET); open, the live stream.
let es = null, poll = 0;
function rest() {
  if (es) { es.close(); es = null; }
  if (!poll) poll = setInterval(() => check().catch(() => {}), 10000);
}
function wake() {
  if (es) return;
  clearInterval(poll); poll = 0;
  msgs.clear();
  refresh().then(() => { if (cur) openRoom(cur); tellUnread(); }).catch(() => {});
  live();
}
async function check() {
  const before = new Map(rooms.map((r) => [r.id, r.last?.id || 0]));
  await refresh();
  for (const r of rooms) if (r.unread && r.last && r.last.from !== me && (r.last.id || 0) > (before.get(r.id) || 0)) notify(r, r.last);
  tellUnread();
}
function live() {
  const client = Math.random().toString(36).slice(2, 12);
  es = new EventSource(`/api/chat/stream?client=${client}`);
  let wasDown = false;
  es.onopen = () => { if (wasDown) { wasDown = false; msgs.clear(); refresh().then(() => { if (cur) openRoom(cur); }).catch(() => {}); } };
  es.onerror = () => { wasDown = true; };
  es.onmessage = (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    const r = rooms.find((x) => x.id === e.room);
    if (e.type === 'online') { online = new Set(e.names); drawMe(); drawList(); drawSub(); return; }
    if (e.type === 'room') { refresh().catch(() => {}); return; }
    if (!r) { if (e.type === 'msg') refresh().catch(() => {}); return; } // (a chat new to this window: someone wrote to me first)
    if (e.type === 'msg') {
      const m = msgs.get(r.id), fresh = m && !m.list.some((x) => x.id === e.msg.id);
      if (fresh) m.list.push(e.msg);
      r.last = { ...e.msg, text: (e.msg.text || '').slice(0, 120) };
      typing.get(r.id)?.delete(e.msg.from);
      if (e.msg.from !== me) { r.unread++; notify(r, e.msg); }
      rooms.sort((a, b) => (a.kind === 'office' ? -1 : b.kind === 'office' ? 1 : 0) || (b.last?.at || b.at || 0) - (a.last?.at || a.at || 0));
      if (cur === r.id && fresh) { addMsg(r, e.msg); drawSub(); markRead(); }
      drawList();
    }
    if (e.type === 'del') {
      const x = msgs.get(r.id)?.list.find((y) => y.id === e.id);
      if (x) { x.deleted = true; delete x.text; delete x.file; }
      if (r.last?.id === e.id) r.last = { ...r.last, deleted: true, text: '', file: null };
      if (cur === r.id) drawMsgs();
      drawList();
    }
    if (e.type === 'read') {
      if (e.name === me) { if (e.upto >= (r.last?.id || 0)) r.unread = 0; }
      else r.reads = { ...r.reads, [e.name]: e.upto };
      if (cur === r.id) drawTicks();
      drawList();
    }
    if (e.type === 'typing' && e.name !== me) {
      if (!typing.has(r.id)) typing.set(r.id, new Map());
      typing.get(r.id).set(e.name, Date.now() + 4000);
      drawSub(); drawList();
      setTimeout(() => { drawSub(); drawList(); }, 4100);
    }
  };
}
refresh().then(() => {
  if (EMBED && !shown) rest(); else live();
  if (EMBED) return window.parent.postMessage({ chat: 'ready' }, location.origin); // (the page says which project's chat)
  const want = new URLSearchParams(location.search).get('room');
  if (want && rooms.some((r) => r.id === want)) openRoom(want);
  else if (matchMedia('(min-width: 760px)').matches && rooms[0]) openRoom(rooms[0].id);
}).catch((e) => { mainEl.innerHTML = `<div class="ch-empty"><div class="ch-empty-in"><h2>Chat could not open</h2><p>${esc(e.message)}</p></div></div>`; });
