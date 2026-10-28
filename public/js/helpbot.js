// ❓ Help chat: ask anything about the editor (Hinglish, Hindi or English). A built-in guide answers at once, offline
// (KB below); "Ask AI" sends the question to the editor PC's Claude, which reads engine/help-guide.md and the editor's
// own code (read only) and explains - nothing in the project is changed. F1 / Help menu / the ? in the top bar.
import { esc } from './ui.js';

// the guide: { q: the question as people ask it, k: words it is found by, a: the answer (a little markdown) }
const KB = [
  { q: 'Video kaise import karein?', k: 'import add file folder upload media daal footage laana', a: '**Media** page → **+ Folder** (poora folder) ya **Upload** (files), ya files ko Media panel par drag karo. Edit page ke Media tab mein bhi same buttons hain.' },
  { q: 'Clip timeline par kaise daalein?', k: 'timeline clip daalna insert overwrite drag add', a: '1. Media mein clip ko timeline par **drag** karo, ya\n2. Double-click → Source monitor mein khulega → **I** (in) **O** (out) → **,** = Insert, **.** = Overwrite (V2 par overlay ke liye Source monitor ka **Overlay** button).' },
  { q: 'Clip kaise kaatein (cut / split)?', k: 'cut kaat split razor blade todna', a: 'Playhead rakho → **Ctrl+K** ya **S** (selected clip ko kaatta hai). Ya **C** (Razor tool) se clip par click karo. Wapas selection tool: **V**.' },
  { q: 'Clip delete aur gap band kaise karein?', k: 'delete hatana remove gap ripple khali jagah', a: '**Delete** = clip hat jaati hai, gap rehta hai. **Shift+Delete** = ripple delete, baad ki clips aage aa jaati hain. Saare gaps: Sequence menu → **Close gaps**.' },
  { q: 'Undo / Redo', k: 'undo redo wapas galti peeche', a: '**Ctrl+Z** = undo, **Ctrl+Shift+Z** ya **Ctrl+Y** = redo. Edit menu → **History** panel mein poori list hai, kisi bhi step par wapas ja sakte ho.' },
  { q: 'Scale, position, rotation kaise badlein?', k: 'scale size bada chota position move rotation ghumana zoom motion', a: 'Clip select karo → right mein **Effect Controls → Motion**: Scale / Position / Rotation par number ko **left-right drag** karo ya click karke likho. Program monitor par clip ko seedha drag bhi kar sakte ho; **Alt + mouse wheel** = scale.' },
  { q: 'Keyframe animation kaise karein?', k: 'keyframe animate animation stopwatch zoom in pan move', a: 'Effect Controls → property ke aage **⏱ stopwatch** dabao (pehla keyframe) → playhead aage le jao → value badlo (naya keyframe apne aap). Ready moves: Motion section ke **Zoom in / Zoom out / Pan** buttons.' },
  { q: 'Transition kaise lagayein?', k: 'transition dissolve fade cross wipe', a: 'Left mein **Effects** tab → Transitions → do clips ke beech ke cut par **drag** karo. Default dissolve: cut select karke **Ctrl+D**. Uski length Effect Controls mein.' },
  { q: 'Effect kaise lagayein (blur, glow, film look)?', k: 'effect blur glow lagana effects filter look', a: '**Effects** tab → effect ko clip par drag karo, ya clip select karke **Effect Controls → Video effects → + Add effect**. Adjustment layer par lagao to neeche ki saari clips par lagta hai.' },
  { q: 'Adjustment layer kya hai, kaise banayein?', k: 'adjustment layer sab par grade upar', a: 'Media panel → **New ▾ → Adjustment layer** → timeline par sabse upar track par rakho. Uske effects aur colour neeche ki har clip par lagte hain. Effect Controls mein **Strength** se kitna lage.' },
  { q: 'Limelight Film look kaise lagayein?', k: 'film look cinematic limelight grain halation vignette', a: 'Effects → Stylize → **Limelight Film** ko adjustment layer par lagao (pure edit par). Look (Classic Cinema, Golden Hour…), Strength, Grain, Halation, Vignette Effect Controls mein.' },
  { q: 'Colour grading kahan hai?', k: 'color colour grade lut correction warm cool exposure', a: '**Color** page: wheels, curves, LUTs, looks, scopes. Kisi doosri clip se match: **Colour match**. Pure edit ka look: adjustment layer.' },
  { q: 'Text / title kaise likhein?', k: 'text title likhna lower third heading font type', a: 'Tools mein **Type tool (T)** → Program monitor par click karke likho. Ready designs: **Graphics and Titles** menu → Title templates, ya **Presets** page (lower thirds, intros).' },
  { q: 'Subtitles / captions kaise banayein?', k: 'subtitle caption srt transcribe hindi english', a: '**Text** page (ya Captions panel) → **Transcribe** → captions ka style chuno → timeline par aa jaate hain. Hindi / English / Hinglish chalta hai.' },
  { q: 'Music aur sound kaise theek karein?', k: 'music audio sound volume awaaz dheema tez fade', a: 'Clip select → Effect Controls → **Audio**: volume, fade in/out. Track ka volume: **Audio** page ka mixer. Voice saaf: Audio → clean-up. Music library: Labs → **Music library**.' },
  { q: 'Speed / slow motion kaise karein?', k: 'speed slow motion fast ramp tez dheere', a: 'Clip right-click → **Speed / Duration**, ya Effect Controls → **Speed ramp** (bullet time, hero slow-mo, custom). Labs page → **Vibe** → Camera moves mein bhi ready ramps hain.' },
  { q: 'Masking kaise karein?', k: 'mask masking shape pen gradient object cut', a: 'Clip select → Effect Controls → **Opacity mask** (ya kisi effect ka mask): Rectangle, Ellipse, **Pen** (khud shape banao), **Gradient** (dheere se fade), **Object (AI)** (insaan / cheez apne aap). Feather, Expansion, Invert wahin.' },
  { q: 'Motion page kya hai?', k: 'motion after effects comp composition layer animation', a: '**Motion** = After Effects jaisa: Composition ▾ se naya comp, Layer ▾ se text / shape / map / video layers, timeline mein keyframes, Effects & Presets (right) se presets. **Add to timeline** se edit par.' },
  { q: 'Map (GeoLayer) kaise banayein?', k: 'map geolayer india chhattisgarh state district route pin satellite', a: 'Motion → Layer ▾ → **Map (GeoLayer)**, ya Effects & Presets → Compositions → **Map: India → Chhattisgarh**. Effect Controls mein: 1 Map of (India / Chhattisgarh / World) · 2 Look (Outline / Satellite) · 3 states tick karo (ya map par double-click) · 4 **Fly in / Draw outline / Animate route** · 5 Pins (city ka naam likho).' },
  { q: 'Motion viewer mein zoom kaise karein?', k: 'motion viewer zoom composition chota bada', a: 'Composition viewer par **mouse wheel** = zoom (mouse ki jagah par), neeche ke **− / +** buttons ya dropdown (10%–400%, Fit). Middle mouse drag = idhar-udhar. Keys: **=** / **-**, **/** = Fit.' },
  { q: 'Program monitor zoom', k: 'program monitor zoom fit chota bada', a: 'Program monitor par **mouse wheel** = zoom in / out (Fit se chhota bhi). Neeche dropdown: Fit, 10%…400%. Middle-drag = move.' },
  { q: 'Track bada / chhota kaise karein?', k: 'track height bada chota layer tall', a: 'Track header par **double-click** = track bada (phir double-click = normal). Header par **Shift + wheel** = sirf us track ki height. Sab tracks: **Alt + wheel** headers par.' },
  { q: 'Nested sequence kya hai?', k: 'nest nested sequence group', a: 'Clips select → right-click → **Nest…** → ek clip ban jaati hai. Double-click se andar khulta hai. Andar badlo to Sequences ▾ → **Update nested**.' },
  { q: 'Export / render kaise karein?', k: 'export render deliver mp4 youtube reel download output', a: '**Deliver** page (ya ⇪ Export): preset chuno (YouTube 16:9, Instagram Reel 9:16, Master, ProRes) → **Render**. Render queue mein progress; render farm baaki PCs se madad leta hai.' },
  { q: 'Reel (9:16) kaise banayein?', k: 'reel 9:16 vertical shorts instagram reframe', a: 'Sequence menu → **Auto Reframe Sequence…** (9:16) ya Deliver mein **Instagram Reel** preset (apne aap reframe). Naya 9:16 sequence: Sequences ▾ → New.' },
  { q: 'Agent se edit kaise banwayein?', k: 'agent ai auto edit script brief claude banwana', a: 'Tools → **Agent**: script / brief do, footage chuno → agent edit bana deta hai. Baad mein **Re-edit** se badlav. Chhote badlav: **Assistant** mein likho ("music dheema karo").' },
  { q: 'Labs camera moves', k: 'labs camera move crash zoom dolly drone shake', a: '**Labs** page → **Vibe** → Camera moves (selected clips par), ya clip right-click → **Edit in Labs** → Vibe ke Labs timeline ki **Camera** row mein button dabao (playhead se move shuru).' },
  { q: 'Preview kaala / atak raha hai', k: 'preview black kaala slow atak lag stuck play nahi', a: '1. Playback **1/2** ya **1/4** karo (monitor ke neeche).\n2. "Preparing a preview copy" ho to thoda ruko.\n3. Top bar **Reload**.\n4. Bahut saare effects ho to **Preview** (accurate) render karo.' },
  { q: 'Backup / purana version kahan hai?', k: 'backup restore purana version recover lost', a: 'File menu → **Backups**: har kuch minute ka save. History panel (Edit menu) se aaj ke steps. AI ka badlav: **AI undo**.' },
  { q: 'Keyboard shortcuts', k: 'shortcut keyboard keys hotkey', a: 'Help → **Keyboard shortcuts…**: poori list, apne keys bhi set kar sakte ho (Premiere / Classic sets). Main: Space, J K L, I O, Ctrl+K, V, C, T, M, N, = -.' },
  { q: 'Client ko review kaise bhejein?', k: 'review client link comment feedback share', a: 'Top bar **Review** → render chuno → link bano → client comments karta hai, yahin dikhte hain aur timeline par markers.' },
  { q: 'Logo / watermark', k: 'logo watermark brand', a: 'Edit (nothing selected) → **Logo / watermark**, ya Media mein image right-click → **Use as logo**. Brand kit: rang aur fonts.' },
  { q: 'Voice over / voice clone', k: 'voice over vo clone dub record voiceverse', a: 'Audio tab mein **record** (track header ka mic), ya Labs → **VoiceVerse**: script likho, saved voice chuno → VO ban jaata hai. Dub: clip right-click → Dub.' },
  { q: 'Nodes page', k: 'nodes fusion compositing node preset', a: '**Nodes** page: clip ya graphic par nodes (blur, glow, key, merge, transform…) jodo. Presets dropdown se ready setups; **+ Node** se apne nodes.' },
  { q: 'Project chat', k: 'chat message team baat', a: 'Top bar **💬** = project chat (team ke saath). Office chat = 📢 Limelight Office.' },
];
const POPULAR = [0, 2, 6, 16, 18, 23, 27];

// words of a question -> the best guide entries (a word in k counts most, then the question, then the answer)
const words = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9ऀ-ॿ ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1);
const STOP = new Set(['kaise', 'kya', 'hai', 'hain', 'karein', 'karna', 'kare', 'karo', 'ka', 'ki', 'ke', 'me', 'mein', 'se', 'ko', 'par', 'how', 'to', 'do', 'the', 'a', 'in', 'is', 'what', 'i', 'can', 'kahan', 'ho', 'na', 'nahi', 'de', 'kar']);
export function findAnswers(q, n = 3) {
  const ws = words(q).filter((w) => !STOP.has(w)); if (!ws.length) return [];
  return KB.map((e, i) => {
    const k = words(e.k), qq = words(e.q), a = words(e.a);
    let s = 0; for (const w of ws) { if (k.some((x) => x === w || (w.length > 3 && x.startsWith(w.slice(0, 4))))) s += 3; else if (qq.includes(w)) s += 2; else if (a.includes(w)) s += 0.5; }
    return { i, e, s: s / Math.sqrt(ws.length) };
  }).filter((x) => x.s >= 2).sort((a, b) => b.s - a.s).slice(0, n);
}

// a little markdown: **bold**, `code`, numbered lines
const md = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^#+ (.*)$/gm, '<b>$1</b>').replace(/\n/g, '<br>');

let el = null, sid = null, busy = false;
const CSS = `
.hb { position: fixed; right: 14px; bottom: 60px; width: min(420px, calc(100vw - 28px)); height: min(620px, calc(100vh - 120px)); z-index: 9000;
  display: flex; flex-direction: column; background: var(--panel, #141311); border: 1px solid var(--line-2, #34302a); border-radius: 12px; box-shadow: 0 20px 60px -10px #000c; font-size: 13px; color: var(--text, #eee); }
.hb[hidden] { display: none; }
.hb-h { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line, #25221d); }
.hb-h b { flex: 1; } .hb-h small { color: var(--muted, #999); display: block; font-weight: 400; }
.hb-h button { background: none; border: 0; color: var(--muted, #999); font-size: 16px; padding: 2px 6px; }
.hb-msgs { flex: 1; overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.hb-m { max-width: 92%; padding: 8px 10px; border-radius: 10px; line-height: 1.5; }
.hb-m.me { align-self: flex-end; background: var(--accent, #ffc21a); color: #141000; }
.hb-m.bot { align-self: flex-start; background: var(--panel-2, #1c1a17); border: 1px solid var(--line, #25221d); }
.hb-m.bot .hb-src { display: block; margin-top: 6px; font-size: 11px; color: var(--muted, #999); }
.hb-m code { background: #0006; padding: 0 4px; border-radius: 3px; }
.hb-sug { display: flex; flex-wrap: wrap; gap: 5px; }
.hb-sug button { font-size: 11.5px; padding: 4px 9px; border-radius: 12px; background: var(--panel-2, #1c1a17); border: 1px solid var(--line-2, #34302a); color: #ddd; }
.hb-sug button:hover { border-color: var(--accent, #ffc21a); }
.hb-ai { margin-top: 6px; font-size: 11.5px; padding: 3px 9px; border-radius: 10px; background: transparent; border: 1px solid var(--accent, #ffc21a); color: var(--accent, #ffc21a); }
.hb-f { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--line, #25221d); }
.hb-f textarea { flex: 1; resize: none; height: 38px; font: inherit; padding: 8px 10px; border-radius: 8px; }
.hb-f button { padding: 0 14px; border-radius: 8px; background: var(--accent, #ffc21a); color: #141000; border: 0; font-weight: 600; }
.hb-dots::after { content: '…'; animation: hbd 1s steps(3) infinite; } @keyframes hbd { 0% { content: '.'; } 50% { content: '..'; } }`;

function mount() {
  if (el) return el;
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  el = document.createElement('div'); el.className = 'hb'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Bhaiya - help');
  el.innerHTML = `<div class="hb-h"><span aria-hidden="true">❓</span><b>Bhaiya<small>Abhi batata hoon - Hinglish chalega</small></b><button data-hb="new" title="New conversation">↺</button><button data-hb="close" title="Close (Esc)" aria-label="Close">✕</button></div>
    <div class="hb-msgs" aria-live="polite"></div>
    <div class="hb-f"><textarea placeholder="Jaise: clip kaise kaatein? map kaise banayein?" aria-label="Your question"></textarea><button data-hb="send">Ask</button></div>`;
  document.body.append(el);
  const ta = el.querySelector('textarea');
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-hb], [data-hbq], [data-hbai]'); if (!b) return;
    if (b.dataset.hb === 'close') return toggleHelp(false);
    if (b.dataset.hb === 'new') { sid = null; welcome(); return; }
    if (b.dataset.hb === 'send') return send(ta.value);
    if (b.dataset.hbq !== undefined) return send(KB[+b.dataset.hbq].q);
    if (b.dataset.hbai !== undefined) return askAI(b.dataset.hbai);
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ta.value); } if (e.key === 'Escape') toggleHelp(false); });
  welcome();
  return el;
}
const box = () => el.querySelector('.hb-msgs');
function add(cls, html) { const m = document.createElement('div'); m.className = `hb-m ${cls}`; m.innerHTML = html; box().append(m); box().scrollTop = box().scrollHeight; return m; }
function welcome() {
  box().innerHTML = '';
  add('bot', `Namaste! Main Bhaiya hoon. Bolo, kya dikkat hai?<div class="hb-sug" style="margin-top:8px">${POPULAR.map((i) => `<button data-hbq="${i}">${esc(KB[i].q)}</button>`).join('')}</div>`);
}
function send(q) {
  q = String(q || '').trim(); if (!q || busy) return;
  el.querySelector('textarea').value = '';
  add('me', esc(q));
  const hits = findAnswers(q);
  if (!hits.length) return askAI(q);
  const [top, ...more] = hits;
  add('bot', `<b>${esc(top.e.q)}</b><br>${md(top.e.a)}${more.length ? `<div class="hb-sug" style="margin-top:8px">${more.map((x) => `<button data-hbq="${x.i}">${esc(x.e.q)}</button>`).join('')}</div>` : ''}<br><button class="hb-ai" data-hbai="${esc(q)}">Ye nahi? Bhaiya se poochho →</button>`);
}
async function askAI(q) {
  if (busy) return; busy = true;
  const m = add('bot', '<span class="hb-dots">Bhaiya dekh rahe hain</span>');
  try {
    const r = await fetch('/api/help/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, sid }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `The help could not answer (${r.status})`);
    sid = j.sid || sid;
    m.innerHTML = `${md(j.text || '')}<span class="hb-src">Bhaiya (AI) · editor ka guide aur code padh ke - kuch badalta nahi</span>`;
  } catch (e) { m.innerHTML = `${esc(e.message)}<span class="hb-src">The quick answers above still work offline.</span>`; }
  finally { busy = false; box().scrollTop = box().scrollHeight; }
}
export function toggleHelp(show) {
  mount();
  el.hidden = show === undefined ? !el.hidden : !show;
  if (!el.hidden) setTimeout(() => el.querySelector('textarea').focus(), 30);
}
// F1 anywhere opens / closes it
if (typeof document !== 'undefined') document.addEventListener('keydown', (e) => { if (e.key === 'F1') { e.preventDefault(); toggleHelp(); } });
