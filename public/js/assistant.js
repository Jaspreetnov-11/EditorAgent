// 💬 Assistant: type what you want changed - Hinglish, Hindi or English - and it changes the edit.
// Works offline: each sentence is split into parts ("music dheema karo aur color warm kar do") and every part is matched
// against the commands below. All changes from one message are a single undo step ("undo" / Ctrl+Z).
import { S, on, emit, commit, undo, redo, duration, layout } from './store.js';
import { api, enc, watchJob, upload } from './api.js';
import { uid, RAMPS } from './model.js';
import { FX_PRESETS } from './audiofx.js';
import { $, $$, h, esc, toast } from './ui.js';
import { openReedit, currentEditOpts } from './reedit.js';
import { runAgentWith } from './agent.js';
import { applyCinematic, removeCinematic, stabilizeClips } from './looks.js';
import { templateById } from './templates.js';
import { CUTFX } from './fx.js';
import { openVoiceOver, openDub } from './voiceover.js';
import { autoSoundDesign, removeSoundDesign } from './sfxui.js';

let root, setBusy, busy = false;
const log = []; // { who: 'me' | 'ai' | 'tool' | 'err', text }
// 🧠 Claude mode: messages go to Claude Code on this computer (server /api/claude/*), which edits through engine/edtool.mjs
const cl = { status: null, mode: (() => { try { return localStorage.getItem('ve-as-mode') || 'claude'; } catch { return 'claude'; } })(), job: null };

const EXAMPLES = [
  'music dheema karo', 'color warm kar do', 'voice over badlo', '3rd shot hata do', 'video 30 sec ki karo',
  'sab cuts par dissolve lagao', 'title "Viksit Bharat" lagao', 'awaaz saaf karo', 'pace tez karke dobara edit karo', 'undo',
];
const QUICK = [['🎥 Stabilize', 'stabilize karo'], ['🎬 Cinematic', 'cinematic banao'], ['🔊 Sound design', 'sound design karo'], ['✨ Light leaks', 'light leak lagao'], ['🎙 Change VO', 'voice over badlo'], ['🎵 Change music', 'music badlo'], ['🎨 Redo colour', 'auto color karo'], ['🔁 Re-edit all', 'dobara edit karo'], ['⚡ Faster pace', 'pace tez karke dobara edit karo'], ['↶ Undo', 'undo']];

export function mountAssistant(busyFn) {
  setBusy = busyFn;
  root = h(`<aside class="as" hidden aria-label="Assistant">
    <div class="as-head"><b>💬 Assistant</b>
      <span class="as-modes" role="tablist"><button class="chip" data-mode="claude" title="Claude: looks at your footage, hears the song, plans and edits the timeline itself (slower, smartest)">🧠 Claude</button><button class="chip" data-mode="quick" title="Quick commands: instant, offline, fixed phrases">⚡ Quick</button></span>
      <span class="grow"></span><button class="link small" data-newchat title="Start a new conversation with Claude for this project">New chat</button><button class="icon-btn" data-x aria-label="Close">✕</button></div>
    <div class="as-cl muted small" data-clinfo hidden></div>
    <div class="as-quick">${QUICK.map(([l, c]) => `<button class="chip" data-cmd="${esc(c)}">${l}</button>`).join('')}</div>
    <div class="as-log" aria-live="polite"></div>
    <div class="as-refs" hidden></div>
    <form class="as-in"><label class="icon-btn as-att" title="📎 Attach a reference video or photo - Claude takes it apart and makes the same edit with your footage">📎<input type="file" hidden accept="video/*,image/*,.mxf,.mts"></label><textarea rows="2" placeholder="e.g. music dheema karo aur color thoda warm kar do"></textarea><button class="primary" type="submit">Send</button></form>
  </aside>`);
  document.body.append(root);
  const ta = $('textarea', root);
  $('[data-x]', root).onclick = () => toggleAssistant(false);
  $('.as-in', root).onsubmit = (e) => { e.preventDefault(); send(ta.value); ta.value = ''; };
  // 📎 reference files for Claude (uploaded to the project's cache/claude/refs - never into Media, so never onto the edit)
  $('.as-att input', root).addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length || !S.proj) return;
    if (cl.mode !== 'claude') { setMode('claude'); toast('References work with 🧠 Claude - switched to Claude'); }
    for (const file of files) {
      const r = { name: file.name, pct: 0 }; refs.push(r); drawRefs();
      try { Object.assign(r, await upload(`/api/claude/ref?p=${enc(S.proj)}&name=${enc(file.name)}`, file, (p) => { r.pct = Math.round(p * 100); drawRefs(); }), { ready: true }); }
      catch (err) { refs.splice(refs.indexOf(r), 1); toast(err.message, 'err'); }
      drawRefs();
    }
  });
  $('.as-refs', root).addEventListener('click', (e) => { const x = e.target.closest('[data-unref]'); if (x) { refs.splice(+x.dataset.unref, 1); drawRefs(); } });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ta.value); ta.value = ''; } e.stopPropagation(); });
  root.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cmd]'); if (c) send(c.dataset.cmd);
    const m = e.target.closest('[data-mode]'); if (m) setMode(m.dataset.mode);
    if (e.target.closest('[data-newchat]')) newChat();
    if (e.target.closest('[data-clstop]') && cl.job) api('POST', `/api/claude/stop?id=${cl.job}`).catch(() => {});
    if (e.target.closest('[data-clrecheck]')) checkClaude(true);
  });
  on('openProject', () => { log.length = 0; draw(); });
  setMode(cl.mode, false);
}
export function toggleAssistant(show = root.hidden) {
  root.hidden = !show;
  document.body.classList.toggle('as-open', show);
  if (show) {
    if (cl.mode === 'claude') checkClaude();
    if (!log.length && cl.mode === 'claude') say('🧠 Claude is here. Describe the edit you want in your own words - e.g.:\n• "make a 60 sec reel of this song from the chorus, with lyrics"\n• "change the third shot, use a happy face"\n• "the opening is slow, tighten the first 10 sec"\nClaude looks at the footage, plans and edits the timeline - the changes show up here live.');
    else if (!log.length) say(`Hello! I can change this edit. Type things like:\n${EXAMPLES.slice(0, 6).map((x) => `• ${x}`).join('\n')}\n\nType "help" to see all commands.`);
    $('textarea', root).focus();
  }
}

function say(text, who = 'ai') { log.push({ who, text }); draw(); }
function draw() {
  if (!root) return;
  const el = $('.as-log', root);
  el.innerHTML = log.map((m) => `<div class="as-msg ${m.who}">${esc(m.text).replace(/\n/g, '<br>')}</div>`).join('') + (cl.job ? '<div class="as-msg tool working">🧠 Claude is working… <button class="link small" data-clstop>■ Stop</button></div>' : '');
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------- 🧠 Claude ----------------
function setMode(m, save = true) {
  cl.mode = m === 'quick' ? 'quick' : 'claude';
  if (save) try { localStorage.setItem('ve-as-mode', cl.mode); } catch {}
  if (!root) return;
  $$('[data-mode]', root).forEach((b) => b.classList.toggle('on', b.dataset.mode === cl.mode));
  $('.as-quick', root).hidden = cl.mode === 'claude';
  $('[data-newchat]', root).hidden = cl.mode !== 'claude';
  $('textarea', root).placeholder = cl.mode === 'claude' ? 'e.g. make a 60 sec reel of this song from the chorus, with lyrics' : 'e.g. music dheema karo aur color thoda warm kar do';
  if (cl.mode === 'claude' && !root.hidden) checkClaude(); else $('[data-clinfo]', root).hidden = true;
}
async function checkClaude(force = false) {
  const info = $('[data-clinfo]', root);
  if (!force && cl.status?.available) { info.hidden = true; return cl.status; }
  info.hidden = false; info.textContent = 'Connecting to Claude…';
  try { cl.status = await api('GET', `/api/claude/status${force ? '?force=1' : ''}`); } catch (e) { cl.status = { available: false, reason: e.message }; }
  if (cl.status.available) { info.hidden = true; return cl.status; }
  const login = /auth|login|oauth|expired/i.test(cl.status.reason || '');
  info.innerHTML = login
    ? `Claude needs a one-time login. Run this in a terminal and type <b>/login</b>:<br><span class="mono">"${esc(cl.status.exe || 'claude')}"</span><br>Then <button class="link small" data-clrecheck>check again</button>. Until then, ⚡ Quick commands work.`
    : `Claude is not available right now: ${esc(cl.status.reason || '')} <button class="link small" data-clrecheck>Check again</button>`;
  return cl.status;
}
async function newChat() {
  if (!S.proj) return;
  await api('POST', `/api/claude/new?p=${enc(S.proj)}`).catch(() => {});
  log.length = 0; say('New chat started - Claude has forgotten the earlier conversation. What shall we make?');
}
// 📎 the references waiting to go with the next message
const refs = [];
function drawRefs() {
  const el = $('.as-refs', root); if (!el) return;
  el.hidden = !refs.length;
  el.innerHTML = refs.map((r, i) => `<span class="chip as-ref">${r.kind === 'image' ? '🖼' : '🎞'} ${esc(r.name)}${r.ready ? '' : ` <span class="muted">${r.pct}%</span>`} <button class="link" data-unref="${i}" aria-label="Remove ${esc(r.name)}">✕</button></span>`).join('') + (refs.length ? '<span class="muted small">Claude will copy this edit with your footage</span>' : '');
}
// what Claude is told about the attached references (it takes them apart with edtool ref, then rebuilds the edit)
const refNote = (list) => `

[Reference attached by the user - make the SAME edit as this: ${list.map((r) => `"${r.path}" (${r.kind})`).join(', ')}. First take it apart: node engine/edtool.mjs ref "<path>" and Read the sheet it prints (for a long one also look <path> --from/--to). Then rebuild it with this project's own footage: the same kinds of shots in the same order, the same shot lengths and cut rhythm (on the song's beats if there is one), the same kinds of transitions and effects, the same text style and position, the same look and frame shape. Never put the reference file on the timeline. When done, say in 2-4 lines how close it is and what differs.]`;
// the message to Claude, and its steps and answer as they come
export async function askClaude(text, { show = true, display = null } = {}) {
  if (show) toggleAssistant(true);
  setMode('claude');
  text = String(text || '').trim();
  if (!text || !S.proj) return;
  if (cl.job) return say('Claude is still on the previous task - let it finish or press ■ Stop.');
  log.push({ who: 'me', text: display || text }); draw();
  let st = await checkClaude();
  if (!st?.available) st = await checkClaude(true); // (a remembered failure can be a passing network blip: ask again before giving up)
  if (!st?.available) return say(`Claude cannot run right now${st?.reason ? `: ${st.reason}` : ' (see above for why)'}. Direct commands still work in ⚡ Quick mode.`, 'err');
  // 🎞 Claude works on the server's project, i.e. the team's shared sequence - not on one this browser opened for itself
  if (S.seqMap) say(`Note: Claude works on the 👥 team's main sequence "${S.project.sequences?.[S.seqMap.shared]?.name || 'Main edit'}", not on your open "${S.project.seq?.name || ''}". To have Claude work on your sequence, press its 👥 team button in 🎞 Sequences.`);
  let job;
  try { job = await api('POST', `/api/claude/chat?p=${enc(S.proj)}`, { message: text }); } catch (e) { return say(e.message, 'err'); }
  cl.job = job.id; draw();
  setBusy?.(true, '🧠 Claude working…');
  let from = 0, lastText = '', changed = false;
  try {
    for (;;) {
      const r = await api('GET', `/api/claude/events?id=${job.id}&from=${from}`);
      from = r.next;
      for (const e of r.events) {
        if (e.k === 'text') { lastText = e.text; say(e.text); }
        else if (e.k === 'tool') { if (/edtool\.mjs\s+(apply|ops|agent)\b/.test(e.text)) changed = true; const t = e.name === 'Bash' ? e.text.replace(/^node engine\/edtool\.mjs\s*/, '') : `${e.name} ${e.text}`; say(`🔧 ${t}`, 'tool'); setBusy?.(true, `🧠 ${t.slice(0, 40)}`); }
        else if (e.k === 'result' && e.error) say(`⚠ ${e.text.slice(0, 300)}`, 'tool');
        else if (e.k === 'done' && e.text && e.text.trim() !== lastText.trim()) say(e.text);
        else if (e.k === 'error') say(`Claude stopped: ${e.text}`, 'err');
      }
      if (r.status !== 'running') { if (r.status === 'error' && !r.events.some((e) => e.k === 'error') && r.error) say(`Claude stopped: ${r.error}`, 'err'); break; }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  } catch (e) { say(e.message, 'err'); }
  finally {
    cl.job = null; draw(); setBusy?.(false);
    // Claude changed the timeline: one click takes it back (the server kept the edit from before this message)
    if (changed) import('./aiundo.js').then((m) => m.offerAiUndo("Claude's change")).catch(() => {});
  }
}

async function send(text) {
  text = String(text || '').trim();
  const ready = refs.filter((r) => r.ready);
  if (refs.length && ready.length < refs.length) return toast('Wait - the reference is still uploading', 'err');
  if (!text && !ready.length) return;
  if (!S.project) return toast('Open a project first', 'err');
  if (ready.length) { // 📎 a message with references goes to Claude
    if (cl.job) return say('Claude is still on the previous task - let it finish or press ■ Stop.');
    const msg = text || 'Is reference jaisa same-to-same edit bana do, meri footage se.';
    refs.length = 0; drawRefs();
    return askClaude(msg + refNote(ready), { show: false, display: `${msg}
📎 ${ready.map((r) => r.name).join(', ')}` });
  }
  if (cl.mode === 'claude') return askClaude(text, { show: false });
  if (busy) return say('Something is already running - wait for it to finish.');
  log.push({ who: 'me', text }); draw();
  busy = true;
  try { say(await run(text)); } catch (e) { say(`Could not do that: ${e.message}`); } finally { busy = false; }
}

// ---------------------------------------------------------------- understanding ----------------
const low = (s) => s.toLowerCase().normalize('NFC');
const has = (s, re) => re.test(s);
const R = {
  undo: /\b(undo|wapas|vapas|pehle jaisa|pehle jaise|revert)\b|वापस|पहले जैसा/,
  redo: /\bredo\b/,
  help: /^(help|madad|commands?|kya kya|kya kar sakte)|मदद/,
  more: /(badha|badhao|zyada|jyada|tez|loud|upar|increase|more|high|बढ़ा|ज़्यादा|ज्यादा|तेज़)/,
  less: /(kam|dheem|dhim|halk|low|neeche|niche|decrease|less|soft|quiet|धीम|कम|हल्क)/,
  remove: /(hata|hatao|nikal|\bband\b|remove|delete|\boff\b|\bmat\b|hatado|हटा|बंद|निकाल)/,
  change: /(badl|badal|change|doosr|dusr|another|next|replace|naya|nayi|बदल|दूसर|नया|नई)/,
  add: /(laga|lagao|daal|dal do|add|chahiye|on\b|लगा|डाल|जोड़)/,
  again: /(dobara|dubara|phir se|fir se|re-?edit|redo edit|naya edit|again|दोबारा|फिर से)/,
  music: /(music|gaana|gana|song|bgm|background|संगीत|म्यूजिक|गाना)/,
  vo: /(voice ?over|voiceover|\bvo\b|narration|वॉइस|वोइस|आवाज़ ओवर)/,
  clipSound: /(clip|video|camera|original|asli|ambience|ambient|mahaul|natural sound|क्लिप|असली|माहौल)\s*(ki|ka|ke)?\s*(awaaz|aawaz|awaz|sound|audio|आवाज़|आवाज)/,
  sound: /(awaaz|aawaz|awaz|volume|sound|audio|आवाज़|आवाज)/,
  clean: /(saaf|saf|clear|clean|noise|shor|enhance|साफ|शोर)/,
  color: /(colou?r|rang|grade|look|tone|lut|रंग|कलर)/,
  warm: /(warm|garam|golden|sunehr|गरम|गर्म)/, cool: /(cool|thand|blue|neela|ठंड|नीला)/,
  bw: /(black ?(and|&|n) ?white|\bb ?& ?w\b|\bbw\b|monochrome|श्वेत|ब्लैक)/,
  vivid: /(vivid|colou?rful|rangeen|punchy|pop|चटक|रंगीन)/, cinematic: /(cinematic|film|movie|filmy|सिनेमैटिक)/,
  bright: /(bright|roshni|ujala|light|prakash|उजाल|रोशनी)/, dark: /(dark|andher|dim|अंधेर)/,
  contrast: /contrast/, sat: /(saturation|rang (ko )?(badha|kam)|रंग (बढ़ा|कम))/,
  auto: /(auto|theek|thik|sahi|correct|fix|ठीक|सही)/,
  reset: /(reset|normal|original|natural|hata do|हटा)/,
  shot: /(shot|clip|scene|frame|शॉट|क्लिप|सीन)/,
  trans: /(transition|dissolve|fade|crossfade|smooth|dip|wipe|slide|zoom ?in|ट्रांज़िशन|डिज़ॉल्व)/,
  title: /(title|heading|text|likh|naam|lower ?third|end ?card|टाइटल|शीर्षक|लिख)/,
  subs: /(subtitle|caption|सबटाइटल|कैप्शन)/,
  aspect: /(9:16|16:9|1:1|4:5|vertical|horizontal|landscape|portrait|square|reel format|youtube format|वर्टिकल)/,
  logo: /(logo|watermark|लोगो)/,
  length: /(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|सेकंड|min|minute|मिनट)\b/,
  pace: /(pace|speed|cuts?)\s*(tez|fast|jaldi|slow|dheem|dhim|medium)|(tez|fast|slow|dheem)\s*(pace|cuts?)|तेज़ कट|धीमे कट/,
  slowmo: /(slow ?mo|slow motion|dheema kar|धीमा कर)/, fastmo: /(speed up|fast forward|tez kar|2x|तेज़ कर)/,
  preview: /(preview|dikhao|dekhna|play|चला|दिखा)/, exportr: /(export|render|final|download|save video|एक्सपोर्ट)/,
};
const NUMW = { ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6, saat: 7, aath: 8, nau: 9, das: 10, 'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10 };
const ORD = { pehla: 1, pahla: 1, pehle: 1, first: 1, doosra: 2, dusra: 2, second: 2, teesra: 3, tisra: 3, third: 3, chautha: 4, fourth: 4, paanchva: 5, fifth: 5, 'पहला': 1, 'दूसरा': 2, 'तीसरा': 3, 'चौथा': 4 };

// split into parts: "x aur y", "x, phir y", "x and y" (but keep "black and white")
function parts(text) {
  // quoted text ("Bharat aur Yuva") is one title, never split: park it as a token while splitting
  const q = [];
  return low(text).replace(/["“”'‘’].+?["“”'‘’]/g, (x) => `qqq${q.push(x) - 1}qqq`).replace(/black\s+(and|&|n)\s+white/g, 'blackwhite')
    .split(/\s*(?:,|;|\.|\baur\b|\band\b|\bphir\b|\bthen\b|\balso\b|और|फिर|।)\s*/)
    .map((p) => p.replace(/blackwhite/g, 'black and white').replace(/qqq(\d+)qqq/g, (_, i) => q[i]).trim()).filter(Boolean);
}
const strength = (p) => (/(thoda|thodi|halka|bit|little|slight|थोड़ा)/.test(p) ? 0.5 : /(bahut|zyada|jyada|very|much|kaafi|bohot|बहुत)/.test(p) ? 1.8 : 1);
const quoted = (text) => (/["“”'‘’](.+?)["“”'‘’]/.exec(text) || [])[1];
function percent(p) { const m = /(\d+)\s*(%|percent|pratishat|प्रतिशत)/.exec(p); return m ? +m[1] / 100 : null; }

// which V1 shots a part talks about: "3rd shot", "shot 3", "teesra shot", "last shot", "ye shot" (selection)
function shots(p) {
  const V1 = S.project.tracks.V1;
  let m = /(?:shot|clip|scene|शॉट|क्लिप)\s*(?:no\.?|number|नंबर|#)?\s*(\d+)/.exec(p) || /(\d+)\s*(?:st|nd|rd|th|va|wa|वां|वाँ)?\s*(?:shot|clip|scene|शॉट|क्लिप)/.exec(p);
  if (m) return V1[+m[1] - 1] ? [V1[+m[1] - 1]] : 'none';
  for (const [w, k] of Object.entries(ORD)) if (new RegExp(`${w}\\s*(shot|clip|scene|शॉट|क्लिप)`).test(p)) return V1[k - 1] ? [V1[k - 1]] : 'none';
  if (/(last|aakhri|akhiri|antim|आखिरी|अंतिम)\s*(shot|clip|scene|शॉट)/.test(p)) return V1.length ? [V1[V1.length - 1]] : 'none';
  if (/(ye|yeh|is|this|selected|chun|इस|ये|यह)\s*(shot|clip|scene|शॉट|क्लिप)/.test(p) || /(selected|selection|chune hue)/.test(p)) {
    const sel = Object.values(S.project.tracks).flat().filter((c) => S.sel.has(c.id));
    return sel.length ? sel : 'nosel';
  }
  return null;
}
const pictureClips = () => Object.keys(S.project.tracks).filter((t) => t[0] === 'V').flatMap((t) => S.project.tracks[t]).filter((c) => c.type === 'video' || c.type === 'image');
// audio file named in the message ("music Chanakya wala lagao"), else the next one in the pool
function pickAudio(p, current, avoid = []) {
  const pool = S.media.filter((m) => m.kind === 'audio' && !avoid.includes(m.id));
  const words = p.split(/\s+/).filter((w) => w.length > 3);
  const named = pool.find((m) => words.some((w) => low(m.name).includes(w) && !R.music.test(w) && !R.vo.test(w)));
  if (named) return named;
  if (!pool.length) return null;
  const next = pool[(pool.findIndex((m) => m.id === current) + 1) % pool.length];
  return next.id === current ? null : next;
}

// ---------------------------------------------------------------- doing ----------------
async function run(text) {
  const P = S.project, done = [], later = [];
  const lp = low(text);
  if (R.help.test(lp)) return helpText();
  if (R.undo.test(lp) && lp.split(/\s+/).length <= 4) { const l = undo(); return l ? `Undone: ${l}` : 'Nothing to undo.'; }
  if (R.redo.test(lp)) { const l = redo(); return l ? `Redone: ${l}` : 'Nothing to redo.'; }

  // "... dobara edit karo": collect the changes and let the agent rebuild the edit
  if ((R.again.test(lp) && /(edit|bana|agent|एडिट)/.test(lp)) || /(teaser|trailer|montage) (bana|style|mein|kar)/.test(lp) && !R.color.test(lp)) return reEdit(lp);

  for (const p of parts(text)) {
    const before = done.length;
    const s = strength(p);
    // ---- AI voice-over / dubbing ----
    if (/(\bai\b.*(voice|\bvo\b|awaaz|आवाज)|\btts\b|text to speech|robot voice|awaaz bana|आवाज़ बना)/.test(p)) { openVoiceOver(); done.push('🎙 Opened the AI voice-over window - type the text and pick a voice'); continue; }
    if (/(\bdub(?!a?ra)|dubbing|डब|re-?voice|translate.*(voice|awaaz)|english mein bol)/.test(p)) {
      const id = [...S.sel][0] || S.project.tracks.V1.find((c) => c.type === 'video')?.id;
      if (!id) { done.push('Select the clip to dub first'); continue; }
      openDub(id); done.push('🌐 Opened the Dub window - press "Listen", check the lines, pick a voice'); continue;
    }
    // ---- voice-over ----
    if (R.vo.test(p)) {
      const A1 = P.tracks.A1, cur = A1[0];
      if (R.change.test(p) || (R.add.test(p) && !cur)) {
        const pick = R.change.test(p) ? pickAudioNamed(p, P.tracks.A2[0]?.mediaId) : null;
        if (!pick) { openReedit(setBusy, { focus: 'vo' }); done.push('Opened the voice-over window - pick or upload a new VO there, then press "Re-edit with AI". The agent will re-pick the shots to fit the new VO.'); continue; }
        later.push(() => reEditWith({ vo: pick.id, subtitles: currentEditOpts().subtitles || !!P.subtitles?.file }, `Re-making the whole edit with the new voice-over "${pick.name}"…`));
        done.push(`Voice-over → ${pick.name}`);
      } else if (R.remove.test(p)) { if (cur) { P.tracks.A1 = []; done.push('Removed the voice-over'); } else done.push('There is no voice-over'); }
      else if (R.clean.test(p)) { P.trackState.A1 = { ...P.trackState.A1, fx: { ...(R.clean.test(p) && /(noise|shor|शोर)/.test(p) ? FX_PRESETS.interview.fx : FX_PRESETS.voice.fx) } }; done.push('Cleaned up the voice-over sound (less noise, more clarity)'); }
      else if (R.more.test(p) || R.less.test(p) || percent(p) !== null) done.push(volume('A1', p, s, 'Voice-over'));
      if (done.length > before) continue;
    }
    // ---- music ----
    if (R.music.test(p)) {
      const A2 = P.tracks.A2, cur = A2[0];
      if (R.remove.test(p) && !R.change.test(p)) { P.tracks.A2 = []; done.push(cur ? 'Removed the music' : 'There is no music'); continue; }
      if (R.change.test(p) || (R.add.test(p) && !cur) || /(best|achha hissa|accha part|best part)/.test(p)) {
        let m = cur ? S.mediaById[cur.mediaId] : null;
        if (R.change.test(p) || !cur) {
          m = pickAudio(p, cur?.mediaId, P.tracks.A1.map((c) => c.mediaId));
          if (!m) { openReedit(setBusy, { focus: 'music' }); done.push('There is no other music file in the project - upload new music in the window.'); continue; }
          const len = Math.max(5, Math.ceil(duration()));
          const clip = { id: cur?.id || uid(), type: 'audio', mediaId: m.id, start: 0, in: 0, loop: true, dur: len, volume: cur?.volume ?? (P.tracks.A1.length ? 0.35 : 0.85), duck: cur?.duck ?? !!P.tracks.A1.length, fadeOut: 2 };
          P.tracks.A2 = [clip, ...A2.slice(1)];
          done.push(`Music → ${m.name}`);
        }
        const clip = P.tracks.A2[0];
        later.push(async () => {
          const len = Math.max(5, Math.ceil(duration() - (clip.start || 0)));
          const best = await api('GET', `/api/music/best?p=${enc(S.proj)}&id=${clip.mediaId}&dur=${len}`);
          Object.assign(clip, { in: best.in, out: best.out, loop: true, dur: len });
          commit('Assistant: best part of the music');
          return 'Used the best part of the music.';
        });
        continue;
      }
      if (/(duck|dab|neeche|under|ke time)/.test(p)) { if (cur) { P.tracks.A2.forEach((c) => (c.duck = !R.remove.test(p))); done.push(R.remove.test(p) ? 'Music will no longer duck under speech' : 'Music now ducks automatically under speech'); } continue; }
      if (R.more.test(p) || R.less.test(p) || percent(p) !== null) { done.push(volume('A2', p, s, 'Music')); continue; }
    }
    // ---- the clips' own sound ----
    if (R.clipSound.test(p)) {
      if (R.remove.test(p)) { P.trackState.V1 = { ...P.trackState.V1, mute: true }; done.push("Muted the clips' own sound"); }
      else { P.trackState.V1 = { ...P.trackState.V1, mute: false }; done.push(volume('V1', p, s, "Clips' sound")); }
      continue;
    }
    // ---- sound design (A3) ----
    if (/(sfx|sound design|sound effect|whoosh|woosh|riser|साउंड)/.test(p)) {
      if (R.remove.test(p)) { done.push(`Removed sound effects (${removeSoundDesign()})`); continue; }
      later.push(async () => { const n = await autoSoundDesign({ amount: /(kam|thoda|less|halka)/.test(p) ? 0.5 : 1 }); return n ? `🔊 Added ${n} sound effects on A3 (whoosh, hits, risers)` : 'Add transitions or cut effects first - sound effects go on them'; });
      continue;
    }
    // ---- cut effects (flash, glitch, light leak...) ----
    const fxKind = /glitch/.test(p) ? 'glitch' : /(light ?leak|leak)/.test(p) ? 'leak' : /(film ?burn|burn)/.test(p) ? 'burn' : /whip/.test(p) ? 'whip'
      : /(rgb|chromatic)/.test(p) ? 'rgb' : /strobe/.test(p) ? 'strobe' : /(punch|zoom ?hit)/.test(p) ? 'punch' : /flash/.test(p) ? 'flash'
      : /(focus|blur ?in)/.test(p) ? 'blur' : /shake/.test(p) && !/(stabili|steady|hil)/.test(p) ? 'shake' : /(effects?|ifekt|इफेक्ट)/.test(p) && R.remove.test(p) ? 'any' : null;
    if (fxKind) {
      const t = shots(p), list = (Array.isArray(t) ? t : P.tracks.V1).filter((c) => c.type === 'video' || c.type === 'image');
      if (R.remove.test(p)) { const hit = list.filter((c) => c.cutFx && (fxKind === 'any' || c.cutFx.type === fxKind)); hit.forEach((c) => delete c.cutFx); done.push(`Removed cut effect (${hit.length} shot${hit.length === 1 ? '' : 's'})`); continue; }
      // without a shot number: every 4th cut (an effect on every cut gets tiring fast)
      const pick = Array.isArray(t) ? list : list.filter((c, i) => i > 0 && i % 4 === 0);
      pick.forEach((c) => (c.cutFx = { type: fxKind, dur: CUTFX[fxKind].dur }));
      done.push(`"${CUTFX[fxKind].label}" on ${pick.length} shot cut${pick.length === 1 ? '' : 's'}. For sound too, type "sound design karo".`); continue;
    }
    // ---- speed ramps ----
    if (/(ramp|रैंप)/.test(p)) {
      const t = shots(p);
      if (t === 'none' || t === 'nosel') { done.push('Type the shot number ("3rd shot par speed ramp lagao") or select a shot first.'); continue; }
      const list = (Array.isArray(t) ? t : P.tracks.V1).filter((c) => c.type === 'video');
      if (R.remove.test(p)) { list.forEach((c) => delete c.ramp); done.push(`Removed speed ramp (${list.length} shot${list.length === 1 ? '' : 's'})`); continue; }
      const kind = /(whoosh|fast|tez)/.test(p) ? 'whoosh' : /(hero|end|aakhir|ending)/.test(p) ? 'hero' : /(punch|impact)/.test(p) ? 'punch' : /(slow mein|into slow|dheema hota)/.test(p) ? 'in' : 'hit';
      const pick = Array.isArray(t) ? list : list.filter((c, i) => i % 5 === 2); // without a shot number: every 5th shot
      pick.forEach((c) => (c.ramp = kind));
      done.push(`Speed ramp "${RAMPS[kind].label}" - ${pick.length} shot${pick.length === 1 ? '' : 's'}. Shot lengths may change; Accurate preview shows it exactly.`); continue;
    }
    // ---- stabilize / cinematic finish ----
    if (/(stabili[sz]|stable|steady|shak|hil rah|hilna|kaanp|स्थिर|हिल)/.test(p)) {
      const t = shots(p), list = Array.isArray(t) ? t : pictureClips();
      const level = R.remove.test(p) ? '' : /(strong|zyada|bahut|tez)/.test(p) ? 'strong' : /(light|thoda|halka)/.test(p) ? 'light' : 'medium';
      const n = stabilizeClips(list, level);
      done.push(level ? `${n} shot${n === 1 ? '' : 's'} will be stabilized (${level}) - visible in Accurate preview or the render` : `Stabilize off (${n} shots)`); continue;
    }
    if (/(cinematic|film look|filmy|movie look|सिनेमैटिक)/.test(p) && !/(sirf|only) colou?r/.test(p)) {
      if (R.remove.test(p)) { removeCinematic(P); done.push('Removed the cinematic look'); }
      else { applyCinematic(P, { strength: s }); done.push(`Cinematic look: film grade${P.settings.look.letterbox ? ', 2.39 black bars' : ''}, vignette, grain`); }
      continue;
    }
    if (/(letterbox|kaali patti|kali patti|black bars|\bbars\b|पट्टी)/.test(p)) {
      P.settings.look = { ...(P.settings.look || {}), letterbox: R.remove.test(p) ? '' : /1\.85/.test(p) ? '1.85' : '2.39' };
      done.push(P.settings.look.letterbox ? `Letterbox ${P.settings.look.letterbox}:1` : 'Removed the black bars'); continue;
    }
    if (/(grain|vignette|vinyet)/.test(p)) {
      const k = /grain/.test(p) ? 'grain' : 'vignette', lk = (P.settings.look ||= {});
      lk[k] = R.remove.test(p) ? 0 : +Math.min(1, Math.max(0, R.less.test(p) ? (lk[k] || 0.3) - 0.15 : (lk[k] || 0) + 0.3 * s)).toFixed(2);
      done.push(`${k === 'grain' ? 'Film grain' : 'Vignette'}: ${Math.round(lk[k] * 100)}%`); continue;
    }
    // ---- colour ----
    if (R.color.test(p) || R.warm.test(p) || R.cool.test(p) || R.bw.test(p) || R.vivid.test(p) || R.cinematic.test(p) || ((R.bright.test(p) || R.dark.test(p)) && !R.sound.test(p))) {
      const t = shots(p);
      if (t === 'none') { done.push('The timeline does not have that many shots.'); continue; }
      if (t === 'nosel') { done.push('Select a shot on the timeline first, or type the shot number ("3rd shot").'); continue; }
      const list = (t || pictureClips()).filter((c) => c.type === 'video' || c.type === 'image');
      const where = t ? `${list.length} shot${list.length === 1 ? '' : 's'}` : 'all shots';
      if (R.auto.test(p) || (R.again.test(p))) { later.push(() => autoColor(list)); done.push(`Auto colour (${where})…`); continue; }
      if (R.reset.test(p) && !R.warm.test(p) && !R.cool.test(p)) { list.forEach((c) => { c.color = c.color?.lut ? { lut: c.color.lut } : undefined; if (!c.color) delete c.color; }); done.push(`Removed colour (${where})`); continue; }
      const looks = [];
      const adj = (c, k, d, dflt = 0, lo = -2, hi = 3) => { c.color ||= {}; c.color[k] = +Math.max(lo, Math.min(hi, (+c.color[k] || dflt) + d)).toFixed(3); };
      const mul = (c, k, f, lo = 0, hi = 2.5) => { c.color ||= {}; c.color[k] = +Math.max(lo, Math.min(hi, (c.color[k] ?? 1) * f)).toFixed(3); };
      for (const c of list) {
        if (R.warm.test(p)) adj(c, 'temp', 0.4 * s, 0, -1, 1);
        if (R.cool.test(p)) adj(c, 'temp', -0.4 * s, 0, -1, 1);
        if (R.bw.test(p)) { c.color ||= {}; c.color.saturation = 0; }
        if (R.vivid.test(p)) { mul(c, 'saturation', 1 + 0.25 * s); mul(c, 'contrast', 1 + 0.06 * s); }
        if (R.cinematic.test(p)) { mul(c, 'contrast', 1 + 0.12 * s); mul(c, 'saturation', 1 - 0.1 * s); adj(c, 'temp', 0.15 * s, 0, -1, 1); }
        if (R.bright.test(p) && !R.less.test(p)) adj(c, 'exposure', 0.25 * s);
        if (R.dark.test(p) || (R.bright.test(p) && R.less.test(p))) adj(c, 'exposure', -0.25 * s);
        if (R.contrast.test(p)) mul(c, 'contrast', R.less.test(p) ? 1 - 0.12 * s : 1 + 0.12 * s);
        if (R.sat.test(p) || (/(rang|रंग)/.test(p) && (R.more.test(p) || R.less.test(p)))) mul(c, 'saturation', R.less.test(p) ? 1 - 0.2 * s : 1 + 0.2 * s);
      }
      if (R.warm.test(p)) looks.push('warm'); if (R.cool.test(p)) looks.push('cool'); if (R.bw.test(p)) looks.push('black & white');
      if (R.vivid.test(p)) looks.push('vivid'); if (R.cinematic.test(p)) looks.push('cinematic'); if (R.bright.test(p)) looks.push(R.less.test(p) ? 'less brightness' : 'more brightness');
      if (R.dark.test(p)) looks.push('dark'); if (R.contrast.test(p)) looks.push(R.less.test(p) ? 'less contrast' : 'more contrast');
      if (R.sat.test(p) || /(rang|रंग)/.test(p) && (R.more.test(p) || R.less.test(p))) looks.push(R.less.test(p) ? 'less saturation' : 'more saturation');
      if (looks.length) done.push(`Colour: ${looks.join(', ')} (${where})`);
      else { later.push(() => autoColor(list)); done.push(`Auto colour (${where})…`); }
      continue;
    }
    // ---- shots: delete / speed / length / move ----
    const t = shots(p);
    if (t === 'none') { done.push('The timeline does not have that many shots.'); continue; }
    if (t && t !== 'nosel') {
      const V1 = P.tracks.V1, idx = (c) => V1.indexOf(c) + 1;
      if (R.remove.test(p)) { const n = t.map(idx); P.tracks.V1 = V1.filter((c) => !t.includes(c)); P.tracks.V2 = P.tracks.V2.filter((c) => !t.includes(c)); S.sel.clear(); done.push(`Removed shot ${n.join(', ')}`); continue; }
      if (R.slowmo.test(p)) { t.forEach((c) => c.type === 'video' && (c.speed = 0.5)); done.push(`Shot ${t.map(idx).join(', ')} slow motion (0.5x)`); continue; }
      if (R.fastmo.test(p)) { t.forEach((c) => c.type === 'video' && (c.speed = 1.5)); done.push(`Shot ${t.map(idx).join(', ')} faster (1.5x)`); continue; }
      if (/(normal speed|speed normal|asli speed)/.test(p)) { t.forEach((c) => delete c.speed); done.push('Speed back to normal'); continue; }
      const len = R.length.exec(p);
      if (len) {
        const secs = +len[1] * (/(min|मिनट)/.test(len[2]) ? 60 : 1);
        for (const c of t) {
          if (c.type === 'video') { const m = S.mediaById[c.mediaId], sp = c.speed || 1; c.out = +Math.min(m?.duration ?? Infinity, (c.in || 0) + secs * sp).toFixed(3); }
          else c.dur = secs;
        }
        done.push(`Shot ${t.map(idx).join(', ')} is now ~${secs} sec`); continue;
      }
      if (/(shuru|start|beginning|pehle|first|शुरू)/.test(p) && /(le ja|move|rakh|kar do|karo)/.test(p)) { P.tracks.V1 = [...t, ...V1.filter((c) => !t.includes(c))]; done.push(`Moved shot ${t.map(idx).join(', ')} to the start`); continue; }
      if (/(end|aakhir|akhir|last|ant|आखिर)/.test(p) && /(le ja|move|rakh|kar do|karo)/.test(p)) { P.tracks.V1 = [...V1.filter((c) => !t.includes(c)), ...t]; done.push(`Moved shot ${t.map(idx).join(', ')} to the end`); continue; }
    }
    if (t === 'nosel' && R.remove.test(p)) { done.push('Select a shot on the timeline first, or type its number ("3rd shot hata do").'); continue; }
    // ---- total length ----
    const len = R.length.exec(p);
    if (len && /(video|edit|reel|film|poora|total|lambai|length|duration|ki karo|ka karo|ki kar|chhota|short|वीडियो)/.test(p)) {
      const secs = +len[1] * (/(min|मिनट)/.test(len[2]) ? 60 : 1);
      done.push(trimTo(secs)); continue;
    }
    // ---- transitions & fades ----
    if (R.trans.test(p) && !R.title.test(p)) {
      const V1 = P.tracks.V1;
      if (/(fade ?in|shuru mein fade)/.test(p)) { if (V1[0]) V1[0].fadeIn = 0.8; done.push('Fade-in at the start'); continue; }
      if (/(fade ?out|end mein fade|aakhir mein fade)/.test(p)) { if (V1.length) V1[V1.length - 1].fadeOut = 1.2; done.push('Fade-out at the end'); continue; }
      if (R.remove.test(p)) { V1.forEach((c) => delete c.transitionIn); done.push('Removed all transitions (straight cuts)'); continue; }
      const type = /(white|safed)/.test(p) ? 'fadewhite' : /(black|dip|kaala)/.test(p) ? 'fadeblack' : /wipe/.test(p) ? 'wipeleft' : /slide/.test(p) ? 'slideleft' : /zoom/.test(p) ? 'zoomin' : 'fade';
      const dur = /(lamba|slow|dheem)/.test(p) ? 0.9 : /(chhota|quick|fast|tez)/.test(p) ? 0.3 : 0.5;
      const t2 = shots(p), list = Array.isArray(t2) ? t2 : V1.slice(1);
      list.forEach((c) => { if (V1.indexOf(c) > 0) c.transitionIn = { type, dur }; });
      done.push(`${{ fade: 'Cross dissolve', fadeblack: 'Dip to black', fadewhite: 'Dip to white', wipeleft: 'Wipe', slideleft: 'Slide', zoomin: 'Zoom' }[type]} ${Array.isArray(t2) ? `on shot ${t2.map((c) => V1.indexOf(c) + 1).join(', ')}` : 'on all cuts'} (${dur}s)`);
      continue;
    }
    // ---- titles / end card ----
    if (R.title.test(p) && !R.subs.test(p)) {
      const q = quoted(text);
      if (/end ?card/.test(p)) {
        const V1 = P.tracks.V1, last = V1[V1.length - 1];
        if (R.remove.test(p)) { if (last?.type === 'title') { V1.pop(); done.push('Removed the end card'); } else done.push('There is no end card'); continue; }
        if (!q) { done.push('Type the end card text in quotes: end card "mybharat.gov.in" lagao'); continue; }
        if (last?.type === 'title') last.text = q; else V1.push({ id: uid(), type: 'title', text: q, dur: 2.5, bg: '#0b2545', fadeOut: 1 });
        done.push(`End card: ${q}`); continue;
      }
      const titles = P.tracks.V2.filter((c) => c.type === 'title');
      if (R.remove.test(p)) { P.tracks.V2 = P.tracks.V2.filter((c) => c.type !== 'title'); done.push(titles.length ? `Removed ${titles.length} title${titles.length === 1 ? '' : 's'}` : 'There is no title'); continue; }
      if (!q) { done.push('Type the title text in quotes, e.g.: title "Viksit Bharat" lagao'); continue; }
      if (R.change.test(p) && titles.length) { titles[0].text = q; done.push(`Title changed: ${q}`); continue; }
      const here = /(yahan|abhi|here|playhead|यहाँ)/.test(p);
      const style = /(lower|neeche|niche|naam|name)/.test(p) ? 'lower' : /(upar|top)/.test(p) ? 'top' : 'center';
      // lower thirds get the navy name-strip template (saffron with "saffron/kesariya", news strip with "strip/news")
      const tpl = style === 'lower' ? templateById(/(saffron|kesari|केसरि)/.test(p) ? 'lt-saffron' : /(strip|news|patti)/.test(p) ? 'lt-strip' : 'lt-navy') : style === 'top' ? templateById('tag-location') : null;
      const { text: _t, ...lookProps } = tpl?.props || {};
      P.tracks.V2.push({ id: uid(), type: 'title', start: +(here ? S.playhead : 0.3).toFixed(2), dur: tpl?.dur || 3, textStyle: style, ...lookProps, text: q, ...(tpl ? { template: tpl.id } : {}) });
      done.push(`Added title "${q}" ${here ? 'at the playhead' : 'at the start'}`); continue;
    }
    // ---- subtitles ----
    if (R.subs.test(p)) {
      if (R.remove.test(p)) { if (P.subtitles?.file) { P.subtitles = { ...P.subtitles, lastFile: P.subtitles.file, file: '' }; } done.push('Subtitles off (they will not be in the render)'); continue; }
      const subs = await api('GET', `/api/subs?p=${enc(S.proj)}`).catch(() => []);
      const f = P.subtitles?.lastFile && subs.some((x) => x.name === P.subtitles.lastFile) ? P.subtitles.lastFile : subs[0]?.name;
      if (/(bana|generate|nikal|likh)/.test(p) || !f) { emit('gotoPage', 'deliver'); done.push(f ? 'Opened the Deliver page - press "Generate subtitles" there.' : 'There is no subtitle file yet. Opened the Deliver page - press "Generate subtitles" there.'); continue; }
      P.subtitles = { ...P.subtitles, file: f }; done.push(`Subtitles on: ${f}`); continue;
    }
    // ---- format ----
    if (R.aspect.test(p) && !R.logo.test(p)) {
      const a = /9:16|vertical|portrait|reel/.test(p) ? '9:16' : /1:1|square/.test(p) ? '1:1' : /4:5/.test(p) ? '4:5' : '16:9';
      P.settings.aspect = a; emit('aspect'); done.push(`Format set to ${a} (shots fit automatically)`); continue;
    }
    // ---- logo ----
    if (R.logo.test(p)) {
      const L = P.logo ||= { mediaId: '', pos: 'tr', scale: 0.12, opacity: 0.9 };
      if (R.remove.test(p)) { L.mediaId = ''; done.push('Removed the logo'); continue; }
      if (!L.mediaId) {
        const img = S.media.filter((m) => m.kind === 'image').sort((a, b) => /logo/i.test(b.name) - /logo/i.test(a.name))[0];
        if (!img) { done.push('There is no logo image in the project - upload a logo (PNG) first.'); continue; }
        L.mediaId = img.id; done.push(`Added logo: ${img.name}`);
      }
      const top = /(upar|top|ऊपर)/.test(p), bottom = /(neeche|niche|bottom|नीचे)/.test(p), left = /(left|baay|baen|बाएं|बाये)/.test(p), right = /(right|daay|daen|दाएं|दाये)/.test(p);
      if (top || bottom || left || right) { L.pos = `${bottom ? 'b' : 't'}${left ? 'l' : 'r'}`; done.push(`Logo: ${{ tl: 'top left', tr: 'top right', bl: 'bottom left', br: 'bottom right' }[L.pos]}`); }
      if (/(bada|badha|bigger|large)/.test(p)) { L.scale = Math.min(0.4, +(L.scale + 0.04).toFixed(2)); done.push('Made the logo bigger'); }
      if (/(chhota|chota|smaller|small)/.test(p)) { L.scale = Math.max(0.04, +(L.scale - 0.03).toFixed(2)); done.push('Made the logo smaller'); }
      continue;
    }
    // ---- generic loudness: VO if there is one, else the clips ----
    if (R.sound.test(p) && (R.more.test(p) || R.less.test(p) || percent(p) !== null)) { done.push(volume(P.tracks.A1.length ? 'A1' : 'V1', p, s, P.tracks.A1.length ? 'Voice-over' : "Clips' sound")); continue; }
    if (R.sound.test(p) && R.clean.test(p)) { const id = P.tracks.A1.length ? 'A1' : 'V1'; P.trackState[id] = { ...P.trackState[id], fx: { ...FX_PRESETS.voice.fx } }; done.push(`Cleaned up the ${id === 'A1' ? 'voice-over' : "clips'"} sound`); continue; }
    // ---- preview / export ----
    if (R.exportr.test(p)) { emit('gotoPage', 'deliver'); done.push('Opened the Export page - pick a platform and press "Render video".'); continue; }
    if (R.preview.test(p)) { emit('accuratePreview'); done.push('Rendering the accurate preview…'); continue; }
    done.push(`Didn't understand "${p}".`);
  }

  const changed = done.filter((d) => !/Didn't understand|There is no|that many shots|[Ss]elect (a|the) (shot|clip)|in quotes|window|Opened the|Rendering the accurate preview|is already/.test(d));
  if (changed.length) commit(`Assistant: ${text.slice(0, 40)}`);
  const out = [...done];
  for (const job of later) {
    try { const r = await job(); if (r) out.push(r); } catch (e) { out.push(`Could not do that: ${e.job ? e.job.log.slice(-1)[0] : e.message}`); }
  }
  if (out.some((d) => /Didn't understand/.test(d)) && !changed.length) out.push(`Try typing: ${EXAMPLES.slice(0, 5).map((x) => `"${x}"`).join(', ')}. Or type "help".`);
  else if (changed.length) out.push('Not happy with it? Type "undo".');
  return out.join('\n');
}

const STOP = /^(voice|over|voiceover|music|badlo|badal|change|wala|wali|waala|lagao|karo|kardo|dobara|dubara|edit|naya|nayi|saath|audio|file)$/;
function pickAudioNamed(p, avoid) {
  const cur = S.project.tracks.A1[0]?.mediaId;
  const words = p.split(/\s+/).filter((w) => w.length > 3 && !STOP.test(w));
  return S.media.find((m) => m.kind === 'audio' && m.id !== avoid && m.id !== cur && words.some((w) => low(m.name).includes(w))) || null;
}

// volume of a track: "music 50%", "music dheema", "VO thoda tez"
function volume(track, p, s, label) {
  const ts = S.project.trackState, cur = ts[track]?.volume ?? 1, pc = percent(p);
  let v = pc !== null ? pc : R.less.test(p) ? cur * (1 - 0.35 * Math.min(s, 1.5)) : cur * (1 + 0.4 * s);
  v = +Math.max(0, Math.min(2, v)).toFixed(2);
  ts[track] = { ...ts[track], volume: v, mute: false };
  return `${label}: volume ${Math.round(cur * 100)}% → ${Math.round(v * 100)}%`;
}

// shorten the edit to `secs`: drop shots from the end, trim the last one, cut overlays / music to fit
function trimTo(secs) {
  const P = S.project, total = duration();
  if (secs >= total - 0.2) return `The edit is already ${Math.round(total)} sec long - to make it longer, type "dobara edit karo" or lengthen the shots.`;
  const V1 = P.tracks.V1;
  while (V1.length > 1 && layout().V1[V1.length - 2].end >= secs) V1.pop();
  const last = layout().V1[V1.length - 1];
  if (last && last.end > secs) {
    const c = last.clip, cut = last.end - secs;
    if (c.type === 'video') c.out = +((c.out ?? S.mediaById[c.mediaId]?.duration ?? 0) - cut * (c.speed || 1)).toFixed(3); else c.dur = +Math.max(0.5, (c.dur || 3) - cut).toFixed(2);
    c.fadeOut = Math.max(c.fadeOut || 0, 0.6);
  }
  for (const id of Object.keys(P.tracks).filter((k) => k !== 'V1')) {
    P.tracks[id] = P.tracks[id].filter((c) => (c.start || 0) < secs - 0.3);
    for (const c of P.tracks[id]) if (c.loop) c.dur = +Math.min(c.dur || secs, secs - (c.start || 0)).toFixed(2);
  }
  const vo = P.tracks.A1[0], voEnd = vo ? (vo.start || 0) + ((vo.out ?? S.mediaById[vo.mediaId]?.duration ?? 0) - (vo.in || 0)) : 0;
  return `The edit is now ~${Math.round(duration())} sec${voEnd > secs + 0.5 ? ' (the voice-over is longer, so its end will be cut - for a shorter VO, type "voice over badlo")' : ''}`;
}

async function autoColor(list) {
  if (!list.length) return 'There are no shots to colour.';
  emit('job', { running: true, label: 'Auto colour…' });
  try {
    const job = await api('POST', `/api/color/auto?p=${enc(S.proj)}`, { strength: 1, detectLog: true, clips: list.map((c) => ({ id: c.id, mediaId: c.mediaId, in: c.in, out: c.out, lut: c.color?.lut })) });
    const j = await watchJob(job.id, (x) => emit('job', { running: true, label: `Auto colour ${x.progress}%` }));
    let n = 0;
    for (const c of list) { const g = j.result.grades[c.id]; if (g) { delete g._log; c.color = g; n++; } }
    commit('Assistant: auto colour');
    return `Auto colour done (${n} shots). Now you can also ask for changes like "thoda warm" or "zyada contrast".`;
  } finally { emit('job', { running: false }); }
}

// "dobara edit karo", "pace tez karke dobara edit", "16:9 mein dobara", "music X ke saath dobara"
async function reEdit(p) {
  const ch = {};
  if (/(tez|fast|jaldi|quick|तेज़)/.test(p)) ch.pace = 'fast';
  if (/(slow|dheem|dhim|cinematic|aaram|धीम)/.test(p)) ch.pace = 'slow';
  if (/medium/.test(p)) ch.pace = 'medium';
  if (/9:16|vertical|reel/.test(p)) ch.aspect = '9:16'; else if (/16:9|horizontal|youtube|landscape/.test(p)) ch.aspect = '16:9'; else if (/1:1|square/.test(p)) ch.aspect = '1:1';
  if (/(dissolve|smooth|cinematic)/.test(p)) ch.style = 'cinematic';
  if (/(teaser|trailer|movie|film jaisa|ट्रेलर)/.test(p)) Object.assign(ch, { editStyle: 'teaser', cinematic: true, look: ch.look || 'Teal & Orange' });
  else if (/(montage|beat par|har beat)/.test(p)) ch.editStyle = 'montage';
  if (/(sab footage|saari footage|all footage|poori footage)/.test(p)) ch.clips = S.media.filter((m) => (m.kind === 'video' || m.kind === 'image') && m.status === 'ready').map((m) => m.id);
  if (R.vo.test(p)) { const m = pickAudioNamed(p, S.project.tracks.A2[0]?.mediaId); if (m) ch.vo = m.id; else { openReedit(setBusy, { focus: 'vo', changes: ch }); return 'Opened the voice-over window - pick or upload a new VO, then press "Re-edit with AI".'; } }
  if (R.music.test(p) && R.change.test(p)) { const m = pickAudio(p, S.project.tracks.A2[0]?.mediaId, S.project.tracks.A1.map((c) => c.mediaId)); if (m) ch.music = m.id; }
  if (/(window|settings|options|chun)/.test(p)) { openReedit(setBusy, { changes: ch }); return 'Opened the Re-edit window - change what you want and press "Re-edit with AI".'; }
  const what = Object.entries(ch).map(([k, v]) => ({ pace: `pace ${v}`, aspect: `format ${v}`, style: 'dissolves', clips: 'all footage', vo: `VO ${S.mediaById[v]?.name}`, music: `music ${S.mediaById[v]?.name}` }[k])).join(', ');
  return reEditWith(ch, `The agent is re-making the whole edit${what ? ` (${what})` : ' (same settings, new shot choices)'}…`);
}
async function reEditWith(changes, msg) {
  say(msg);
  const o = { ...currentEditOpts(), ...changes };
  if (!o.clips?.length) return 'Could not find the footage of this edit - make a new edit with ✨ Agent.';
  await runAgentWith(o, setBusy, { ask: false });
  return 'The new edit is on the timeline. Not happy with it? Type "undo" to get the old edit back.';
}

function helpText() {
  return [
    'I can do all of this (Hindi / Hinglish / English - join several things in one message with "aur"):',
    '🎙 Voice-over: "voice over badlo" (add a new VO, the agent re-edits by itself), "VO ki awaaz badhao", "awaaz saaf karo", "VO hata do"',
    '🎵 Music: "music badlo", "music Chanakya wala lagao", "music dheema karo / 30%", "music ka best part", "music hata do"',
    '🔊 Clip sound: "clip ki awaaz band karo / kam karo"',
    '🎙 AI voice: "ai voice over banao" (Edge free / ElevenLabs), "is clip ko english mein dub karo"',
    '🔊 Sound design: "sound design karo", "sfx kam karo", "sfx hatao" (whoosh, hits, risers on A3)',
    '✨ Cut effects: "3rd shot par glitch lagao", "light leak lagao", "whip lagao", "flash lagao", "film burn lagao", "effects hatao"',
    '🎥 Stabilize & 🎬 look: "stabilize karo", "3rd shot stabilize karo", "cinematic banao", "kaali patti hatao", "grain badhao"',
    '🎨 Colour: "auto color karo", "thoda warm", "cool", "black and white", "vivid", "cinematic", "zyada roshni", "contrast badhao", "3rd shot ka color theek karo", "color hata do"',
    '✂️ Shots: "3rd shot hata do", "last shot slow motion", "shot 2 ko 4 sec ka karo", "shot 5 ko shuru mein le jao"',
    '⏱ Length: "video 30 sec ki karo"',
    '🔀 Transitions: "sab cuts par dissolve lagao", "dip to black", "transitions hata do", "end mein fade out"',
    '🔤 Text: title "Viksit Bharat" lagao, "naam lower third mein \'Rahul Sharma\'", end card "mybharat.gov.in" lagao, "title hata do", "subtitles band / on"',
    '📐 Format & logo: "9:16 banao", "logo upar baayen", "logo chhota karo"',
    '🔁 Re-edit with AI: "dobara edit karo", "pace tez karke dobara edit karo", "16:9 mein dobara edit", "saari footage se dobara edit"',
    '▶ "preview dikhao", "export karo", "undo", "redo"',
  ].join('\n');
}
