// intent.mjs - the editor's own words (Hindi in Devanagari, Hinglish, English, mixed) -> Agent settings.
// parseRules(text, ctx) is a fast, deterministic word-rules pass; parseIntent(text, ctx) runs it and, when words are
// left that the rules could not place and the local LLM (llm.mjs) is installed, asks the LLM to map just those words to
// the same option names (validated strictly, merged under the rules' answers). Without the LLM they come back in notes.
//   ctx = { mode: 'new' | 'reedit', opts (the current agent options), media: [{ id, name, kind }], people: [names | { key, name }] }
//   -> { opts, changes: [{ key, from, to, label }], constraints, notes, understood, via: 'rules' | 'llm' }
// Option names and values are the ones of public/js/agent.js (TYPES, opts()) and public/js/reedit.js.
import { toRoman } from './translit.mjs';
import { mentioned } from './people.mjs';

// ---- the options the text can set (agent.js) ----
export const LOOKS = ['Teal & Orange', 'Warm Film', 'Golden Hour', 'Moody Dark', 'Travel Vivid', 'Indian Heritage', 'Bleach Bypass', 'Clean Natural'];
export const ALLOWED = {
  aspect: ['9:16', '16:9', '1:1', '4:5'],
  pace: ['fast', 'medium', 'slow'],
  editStyle: ['standard', 'teaser', 'montage', 'song'],
  clipSpeed: [0.5, 0.75, 1, 1.25, 1.5, 2],
  look: ['', ...LOOKS],
  style: ['cuts', 'cinematic'],
  voLang: ['hi', 'en', 'auto'],
  songPart: ['full', 'best'],
  bools: ['musicBest', 'keepSound', 'fx', 'sfx', 'cinematic', 'stabilize', 'autoColor', 'subtitles', 'lyricsOnScreen', 'detectLog'],
  strings: ['title', 'endText', 'names'],
};
const LENGTHS = [15, 20, 30, 45, 60, 90, 120, 180, 300];
// the wizard's kinds (agent.js TYPES): a "new" edit asked for as "a teaser" / "a reel" gets the kind's settings too
const TYPES = {
  song: { aspect: '16:9', pace: 'medium', target: 60, subtitles: false, editStyle: 'song', look: 'Warm Film' },
  teaser: { aspect: '16:9', pace: 'fast', target: 45, subtitles: false, editStyle: 'teaser', look: 'Teal & Orange', cinematic: true },
  reel: { aspect: '9:16', pace: 'fast', target: 30, subtitles: true, editStyle: 'montage' },
  highlights: { aspect: '16:9', pace: 'medium', target: 90, subtitles: false, editStyle: 'standard' },
  film: { aspect: '16:9', pace: 'slow', target: 120, subtitles: true, editStyle: 'standard' },
};
const TYPE_NAME = { song: 'Song / music video', teaser: 'Cinematic teaser', reel: 'Reel / Short', highlights: 'Event highlights', film: 'VO film / Documentary' };

// ---- normalising: Devanagari -> Roman, then spellings that sound alike folded (dheemaa / dhima, tez / tej, reel / ril) ----
const fold = (s) => s.replace(/aa/g, 'a').replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/w/g, 'v').replace(/z/g, 'j')
  .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/([a-z])\1+/g, '$1');
const normTok = (t) => fold(toRoman(t).toLowerCase().replace(/[’‘`']/g, '').replace(/[^a-z0-9:.%&]/g, '').replace(/^[.:]+|[.:]+$/g, ''));
const norm = (s) => String(s).split(/\s+/).map(normTok).filter(Boolean).join(' ');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// words / phrases (any spelling, any script) -> one regex part over normalised text; a plural "s" is allowed
const Wc = new Map(), Bc = new Map();
const W = (...alts) => { const key = alts.join('\u0001'); let v = Wc.get(key); if (v === undefined) { v = W0(...alts); Wc.set(key, v); } return v; };
const W0 = (...alts) => `(?:${[...new Set(alts.map(norm).filter(Boolean))].sort((a, b) => b.length - a.length).map((a) => esc(a).replace(/ /g, ' ')).join('|')})s?`;
const B = (src) => { let r = Bc.get(src); if (!r) { r = new RegExp(`(?<![a-z0-9])(?:${src})(?![a-z0-9])`); Bc.set(src, r); } return r; };

// ---- lexicon ----
const NEG = W('nahi', 'nahin', 'nai', 'mat', 'bina', 'without', 'no', 'not', 'dont', 'hata', 'hatao', 'hatado', 'hataiye', 'remove', 'band', 'off', 'nikal', 'nikalo', 'delete', 'disable', 'hatana', 'नहीं', 'नही', 'मत', 'बिना', 'हटा', 'हटाओ', 'हटाएं', 'बंद', 'निकाल', 'निकालो', 'skip');
const MUSIC = W('music', 'bgm', 'background music', 'gaana', 'gana', 'sangeet', 'song', 'track', 'beat music', 'म्यूजिक', 'म्यूज़िक', 'संगीत', 'गाना', 'गीत', 'बीजीएम', 'सॉन्ग');
const LESS = W('kam', 'dheema', 'dhima', 'dheemi', 'dheere', 'low', 'lower', 'halka', 'halki', 'neeche', 'quiet', 'quieter', 'soft', 'softer', 'down', 'dabake', 'less', 'reduce', 'kum', 'कम', 'धीमा', 'धीमी', 'धीरे', 'हल्का', 'हल्की', 'नीचे', 'घटाओ', 'ghatao', 'ghata');
const MORE = W('zyada', 'jyada', 'jada', 'tez', 'loud', 'louder', 'upar', 'badhao', 'badha', 'badhado', 'up', 'high', 'more', 'full', 'increase', 'ज़्यादा', 'ज्यादा', 'तेज़', 'तेज', 'बढ़ाओ', 'बढ़ा', 'ऊपर', 'heavy', 'dhamakedar');
const LITTLE = W('thoda', 'thodi', 'thode', 'zara', 'slightly', 'a bit', 'bit', 'little', 'a little', 'halka sa', 'थोड़ा', 'थोड़ी', 'ज़रा');
const VERY = W('bahut', 'bohot', 'bahot', 'very', 'much', 'ekdum', 'bilkul', 'too', 'बहुत', 'एकदम', 'kaafi', 'kafi', 'काफी');
const CHANGE = W('badlo', 'badal', 'badal do', 'badaldo', 'change', 'dusra', 'doosra', 'dusri', 'naya', 'nayi', 'new', 'replace', 'alag', 'other', 'another', 'बदलो', 'बदल', 'दूसरा', 'दूसरी', 'नया', 'नई');
const VO = W('vo', 'v.o', 'voice over', 'voiceover', 'voice-over', 'voice', 'narration', 'narrator', 'वीओ', 'वॉयस ओवर', 'वॉइस ओवर');
const SUBS = W('subtitle', 'subtitles', 'sub title', 'captions', 'caption', 'subs', 'सबटाइटल', 'सब टाइटल', 'कैप्शन', 'neeche text', 'neeche likha');
const SHOT = W('shot', 'shots', 'clip', 'clips', 'scene', 'visual', 'visuals', 'frame', 'footage', 'video', 'shot wala', 'शॉट', 'क्लिप', 'सीन', 'दृश्य', 'vala', 'wala', 'wali', 'वाला', 'वाली');
const FIRST = W('pehle', 'pahle', 'pehla', 'pehli', 'shuru', 'shuruat', 'shuruaat', 'suru', 'start', 'starting', 'opening', 'open', 'begin', 'beginning', 'first', 'intro', 'पहले', 'पहला', 'पहली', 'शुरू', 'शुरुआत', 'ओपनिंग');
const LAST = W('end', 'ending', 'aakhir', 'akhir', 'aakhri', 'akhri', 'last', 'antim', 'ant', 'closing', 'outro', 'अंत', 'आखिर', 'आख़िर', 'आखिरी', 'आख़िरी', 'एंड', 'लास्ट', 'अंतिम');
const UNIT_S = W('s', 'sec', 'secs', 'second', 'seconds', 'sekand', 'sekend', 'sekind', 'सेकंड', 'सेकेंड', 'सेकण्ड');
const UNIT_M = W('m', 'min', 'mins', 'minute', 'minutes', 'minat', 'mint', 'मिनट');

// numbers in words (only read before a time unit: "do" is also "kar do")
const NUM = {};
const addNum = (v, ...ws) => ws.forEach((w) => { NUM[norm(w)] = v; });
addNum(0.5, 'aadha', 'adha', 'half', 'आधा'); addNum(1.5, 'dedh', 'derh', 'डेढ़', 'डेढ'); addNum(2.5, 'dhai', 'ढाई'); addNum(1.25, 'sava', 'सवा');
[['ek', 'one', 'एक'], ['do', 'two', 'दो'], ['teen', 'three', 'तीन'], ['char', 'chaar', 'four', 'चार'], ['paanch', 'panch', 'five', 'पांच', 'पाँच'],
  ['chhe', 'chhah', 'six', 'छह', 'छः'], ['saat', 'seven', 'सात'], ['aath', 'eight', 'आठ'], ['nau', 'nine', 'नौ'], ['das', 'dus', 'ten', 'दस']].forEach((ws, i) => addNum(i + 1, ...ws));
addNum(12, 'barah', 'baarah', 'twelve', 'बारह'); addNum(15, 'pandrah', 'pandrah', 'fifteen', 'पंद्रह', 'पन्द्रह'); addNum(20, 'bees', 'twenty', 'बीस');
addNum(25, 'pachees', 'pachchis', 'twenty five', 'पच्चीस'); addNum(30, 'tees', 'thirty', 'तीस'); addNum(35, 'paintees', 'पैंतीस'); addNum(40, 'chalis', 'chaalis', 'forty', 'चालीस');
addNum(45, 'paintalis', 'paintaalis', 'forty five', 'पैंतालीस'); addNum(50, 'pachas', 'pachaas', 'fifty', 'पचास'); addNum(60, 'saath', 'sixty', 'साठ'); addNum(90, 'nabbe', 'ninety', 'नब्बे');
addNum(20, 'twenty'); addNum(5, 'five');

// filler: words that carry no setting ("isko", "kar do", "please", "the")
const FILLER = new Set(['karo', 'kar', 'kardo', 'karde', 'karna', 'karni', 'kariye', 'kijiye', 'kare', 'karein', 'karen', 'do', 'de', 'dena', 'dedo', 'dijiye', 'please', 'plz', 'pls', 'bhai', 'ji', 'yaar', 'yar', 'bas', 'sirf', 'only', 'just', 'bhi', 'aur', 'and', 'the', 'a', 'an', 'to', 'ko', 'ka', 'ki', 'ke', 'mein', 'me', 'main', 'mai', 'se', 'par', 'pe', 'per', 'hai', 'hain', 'ho', 'is', 'isko', 'ise', 'isme', 'iska', 'iski', 'yeh', 'ye', 'it', 'this', 'that', 'its', 'make', 'bana', 'banao', 'banana', 'banaye', 'banado', 'edit', 'video', 'vala', 'wala', 'wali', 'vali', 'jaisa', 'jaisi', 'jaise', 'like', 'type', 'style', 'with', 'of', 'in', 'on', 'at', 'for', 'be', 'should', 'let', 'lets', 'can', 'you', 'we', 'i', 'my', 'apna', 'apni', 'chahiye', 'chaiye', 'hona', 'hone', 'rakho', 'rakhna', 'rakh', 'lagao', 'laga', 'lagado', 'daalo', 'daal', 'dalo', 'daldo', 'use', 'karke', 'thoda', 'zara', 'ok', 'okay', 'acha', 'accha', 'achha', 'now', 'ab', 'abhi', 'fir', 'phir', 'then', 'also', 'so', 'very', 'bahut', 'wo', 'vo', 'voh', 'jo', 'bhai', 'sab', 'kuch', 'koi', 'hissa', 'part', 'set', 'kardena', 'dikhao', 'dikha', 'chalao', 'want', 'need', 'give', 'put', 'add', 'show', 'mujhe', 'hume', 'hamein', 'liye', 'lie', 'vaste', 'waste', 'liye hai', 'chahta', 'chahti', 'chahte', 'hoga', 'hogi', 'raha', 'rahi', 'rahe', 'gaya', 'gayi', 'saath', 'ke saath', 'chahie', 'vidiyo',
  'वीडियो', 'चाहिए', 'चाहिये', 'करो', 'कर', 'दो', 'दे', 'को', 'का', 'की', 'के', 'में', 'से', 'पर', 'पे', 'है', 'हैं', 'इसे', 'इसको', 'इसका', 'और', 'भी', 'बस', 'सिर्फ', 'थोड़ा', 'ज़रा', 'साथ', 'बनाओ', 'बना', 'दीजिए', 'करें', 'कीजिए', 'करना', 'वाला', 'वाली', 'मुझे', 'हमें', 'लिए', 'अब', 'फिर', 'यह', 'ये', 'वो', 'सब', 'कुछ', 'रखो', 'डालो', 'डाल', 'लगाओ', 'दिखाओ', 'हो', 'होना', 'एडिट', 'प्लीज़', 'प्लीज'].map(norm));

// ---- clauses and tokens ----
// clauses: split on punctuation and joining words; "black and white" / "teal and orange" stay together
const SPLIT = /[,;!?\n।|]+|\.(?=\s|$)|\s+(?:aur|and|also|phir|fir|then|plus|bas|but|lekin|और|फिर|बस|लेकिन|तथा)\s+/i;
function clauses(text) {
  const t = String(text || '').replace(/\b(black|teal|blue)\s+(and|&|n)\s+(white|orange)\b/gi, '$1 & $3').replace(/ब्लैक\s+(एंड|और)\s+व्हाइट/g, 'ब्लैक & व्हाइट')
    .replace(/(\d)\s*[-–]\s*(\d)/g, '$1 se $2'); // "0:10-0:25", "shots 3 - 5" read like "se"
  return t.split(SPLIT).map((s) => s && s.trim()).filter(Boolean).map((raw) => {
    const toks = []; let s = '';
    for (const m of raw.matchAll(/\S+/g)) {
      const n = normTok(m[0]); if (!n) continue;
      toks.push({ raw: m[0].replace(/^[("“'‘]+|[)"”'’,.:;!?]+$/g, ''), n, at: s.length ? s.length + 1 : 0 });
      s += (s.length ? ' ' : '') + n;
    }
    toks.forEach((k) => { k.end = k.at + k.n.length; });
    return { raw, toks, used: new Set() };
  });
}
// the clause's normalised text with the words other rules already took blanked out (offsets stay the same)
const live = (c) => c.toks.map((k, i) => (c.used.has(i) ? ' '.repeat(k.n.length) : k.n)).join(' ');
const full = (c) => c.toks.map((k) => k.n).join(' ');
const take = (c, a, b) => c.toks.forEach((k, i) => { if (k.at < b && k.end > a) c.used.add(i); });
// find a regex in the clause's unused words, mark them used
function hit(c, re, { keep = false } = {}) {
  const m = re.exec(live(c));
  if (m && !keep) take(c, m.index, m.index + m[0].length);
  return m;
}
const has = (c, re) => re.test(full(c));
// the words of the clause that no rule took and that are not filler (raw spelling kept)
const rest = (c, extra = null) => c.toks.filter((k, i) => !c.used.has(i) && !FILLER.has(k.n) && !(extra && extra.test(k.n))).map((k) => k.raw);
const takeAll = (c) => c.toks.forEach((_, i) => c.used.add(i));
const quoted = (s) => (s.match(/["“'‘]([^"”'’]{1,80})["”'’]/) || [])[1];

// ---- labels for the "what will change" list ----
const sec = (v) => (v < 60 ? `${Math.round(v)} s` : `${+(v / 60).toFixed(2)} min`);
const ASPECT_L = { '9:16': '9:16 Reel / Shorts', '16:9': '16:9 YouTube / Film', '1:1': '1:1 Square', '4:5': '4:5 Feed' };
const PACE_L = { fast: 'Fast cuts', medium: 'Medium', slow: 'Slow, cinematic' };
const STYLE_L = { standard: 'Standard', teaser: 'Cinematic teaser', montage: 'Fast montage', song: 'Song / music video' };
const KEY_L = { aspect: 'Format', target: 'Length', pace: 'Pace', editStyle: 'Edit style', clipSpeed: 'Clip speed', look: 'Film look', style: 'Transitions', vo: 'Voice-over', voLang: 'VO language', music: 'Music', musicBest: 'Best part of the music', songPart: 'Song', keepSound: "Clips' own sound", fx: 'Teaser effects', sfx: 'Sound design', cinematic: 'Cinematic finish', stabilize: 'Stabilize', autoColor: 'Auto colour', subtitles: 'Subtitles', lyricsOnScreen: 'Lyrics on screen', detectLog: 'Detect LOG', title: 'Title', endText: 'End card', names: 'Names & spellings' };
function show(k, v, media) {
  if (v === undefined || v === null || v === '') return { vo: 'No voice-over', music: 'No music', look: 'None', title: 'none', endText: 'none' }[k] || 'not set';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (k === 'target') return sec(v);
  if (k === 'aspect') return ASPECT_L[v] || v;
  if (k === 'pace') return PACE_L[v] || v;
  if (k === 'editStyle') return STYLE_L[v] || v;
  if (k === 'clipSpeed') return `${v}x`;
  if (k === 'style') return v === 'cinematic' ? 'Dissolves between ideas' : 'Clean cuts';
  if (k === 'voLang') return { hi: 'Hindi', en: 'English', auto: 'Auto-detect' }[v] || v;
  if (k === 'songPart') return v === 'full' ? 'The whole song' : 'Its best part';
  if (k === 'vo' || k === 'music') return `"${media.find((m) => m.id === v)?.name || v}"`;
  if (typeof v === 'string') return `"${v}"`;
  return String(v);
}

// ---- media / people lookups ----
const stem = (n) => norm(String(n || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_\-]+/g, ' '));
const GENERIC = new Set(['logo', 'music', 'song', 'audio', 'video', 'clip', 'image', 'photo', 'track', 'untitled', 'voice', 'final', 'drone', 'shot'].map(norm));
// a file of the project named in the clause ("Sirpur theme", "DJI_0012"): its words in a row, or the name written as one word
function findMedia(c, media, kinds) {
  const s = ` ${live(c)} `;
  let best = null;
  for (const m of media || []) {
    if (kinds && !kinds.includes(m.kind)) continue;
    const st = stem(m.name), one = st.replace(/ /g, '');
    if (one.length < 4 || GENERIC.has(st)) continue;
    const i = s.indexOf(` ${st} `), k = i < 0 && c.toks.find((t, j) => !c.used.has(j) && t.n === one);
    const at = i >= 0 ? i : k ? k.at : -1, end = i >= 0 ? i + st.length : k ? k.end : -1; // (s starts with a space: i is the offset in the clause)
    if (at >= 0 && (!best || one.length > best.len)) best = { m, at, end, len: one.length };
  }
  if (best) take(c, best.at, best.end);
  return best?.m || null;
}
// Devanagari short forms read as their Roman letters (सीएम -> CM), so "सीएम साहब" finds "CM Sahab"
const ABBR = [['सीएम', 'CM'], ['पीएम', 'PM'], ['डीएम', 'DM'], ['एसपी', 'SP'], ['एसडीएम', 'SDM'], ['डीसी', 'DC'], ['एमएलए', 'MLA'], ['एमपी', 'MP']];
const abbr = (s) => ABBR.reduce((t, [d, r]) => t.split(d).join(r), String(s));
const asPeople = (people) => (people || []).map((p) => (typeof p === 'string' ? { name: p } : p)).filter((p) => p && p.name);

// ---- the rules ----
function rules(c, ctx, R) {
  const { opts, media } = ctx;
  // re-edit scope first: "0:10 se 0:25 tak", "teesra shot", "ye clip" (its words are not lengths or shots to find)
  scope(c, ctx, R);
  const neg = has(c, B(NEG));
  const set = (k, v, why) => { if (!(k in R.set)) { R.set[k] = v; if (why) R.why[k] = why; } };

  // keep: "sab same rakho", "shots same rakho", "naya bana do / shuru se"
  if (hit(c, B(`${W('sab', 'baaki', 'baki', 'baki sab', 'everything', 'rest', 'all', 'सब', 'बाकी', 'बाकी सब')} ${W('same', 'waisa', 'vaisa', 'jaisa hai', 'waise', 'waisa hi', 'as it is', 'as is', 'unchanged', 'वैसा', 'वैसा ही', 'same hi', 'सेम')}`))
    || hit(c, B(`${W('kuch aur', 'baaki kuch', 'aur kuch', 'nothing else', 'kuch bhi aur')} ${W('mat', 'na', 'nahi')}`))
    || hit(c, B(`${W('keep', 'rakho')} ${W('everything', 'sab', 'all', 'the rest')}`))) { R.keep = 'all'; R.say.push('Everything else stays as it is.'); }
  else if (hit(c, B(`${SHOT} ${W('same', 'waise hi', 'vahi', 'wahi', 'mat badlo', 'mat badalna', 'rakho', 'वही', 'सेम')}`)) || hit(c, B(`${W('same', 'wahi', 'vahi')} ${SHOT}`))) { R.keep = 'shots'; R.say.push('The same shots are kept.'); }
  else if (hit(c, B(`${W('naya', 'nayi', 'fresh', 'scratch', 'dobara', 'dubara', 'fir se', 'phir se', 'shuru se', 'start se', 'naye sire se', 'नया', 'दोबारा', 'फिर से', 'शुरू से')} ${W('edit', 'bana', 'banao', 'bana do', 'banado', 'karo', 'se', 'start', 'version')}`)) || hit(c, B(W('from scratch', 'brand new', 'completely new', 'sab badal do', 'sab naya', 'start over')))) { R.keep = 'none'; R.say.push('A fresh edit: shots are chosen again.'); }

  // music: volume / off / another track / best part / whole song
  if (has(c, B(MUSIC)) && !has(c, B(`${MUSIC} ${W('ke hisaab', 'ke hisab', 'ke according', 'pe cut', 'par cut', 'ki beat', 'ke beat', 'video', 'edit')}`)) && !has(c, B(W('song video', 'music video', 'song edit')))) {
    const pct = /(\d{1,3})\s*(?:%|percent|pratishat)/.exec(full(c));
    const before = new Set(c.used);
    hit(c, B(MUSIC));
    let m;
    if (pct) { take(c, pct.index, pct.index + pct[0].length); R.musicVolume = Math.max(0, Math.min(1, +pct[1] / 100)); R.say.push(`Music at ${pct[1]}%.`); }
    else if ((m = hit(c, B(LESS)))) {
      const v = hit(c, B(VERY)) ? 0.3 : hit(c, B(LITTLE)) ? 0.7 : 0.5;
      R.musicVolume = v; R.say.push(`Music quieter (${Math.round(v * 100)}%).`);
    } else if (neg && hit(c, B(NEG))) { set('music', null); R.say.push('No music.'); }
    else if (hit(c, B(MORE))) { const v = hit(c, B(LITTLE)) ? 0.9 : 1; R.musicVolume = v; R.say.push(`Music louder (${Math.round(v * 100)}%).`); }
    else if (hit(c, B(CHANGE))) {
      const t = findMedia(c, media, ['audio']);
      if (t) { set('music', t.id); R.say.push(`Music: "${t.name}".`); }
      else { R.say.push('Change the music: choose the new track.'); R.notes.push('Change the music (choose the new track).'); R.handled.add(c); }
    } else if (hit(c, B(W('best part', 'best hissa', 'sabse acha hissa', 'sabse achha part', 'chorus', 'hook', 'drop', 'best portion', 'highlight')))) {
      if ((R.set.editStyle || opts.editStyle) === 'song') set('songPart', 'best'); else set('musicBest', true);
      R.say.push('Uses the best part of the music.');
    } else if (hit(c, B(W('poora', 'pura', 'puri', 'poori', 'full', 'whole', 'entire', 'complete', 'pura ka pura', 'पूरा', 'पूरी')))) { set('songPart', 'full'); set('musicBest', false); R.say.push('Uses the whole song.'); }
    else {
      const t = findMedia(c, media, ['audio']);
      if (t) { set('music', t.id); R.say.push(`Music: "${t.name}".`); } else c.used = before; // (just "music": left as words)
    }
  }

  // voice-over: off / language
  if (has(c, B(VO)) && !has(c, B(SUBS)) && !has(c, B(W('voice clone', 'ai voice')))) {
    const lang = hit(c, B(W('hindi', 'हिंदी', 'हिन्दी'))) ? 'hi' : hit(c, B(W('english', 'angrezi', 'angreji', 'अंग्रेज़ी', 'अंग्रेजी', 'इंग्लिश'))) ? 'en' : null;
    if (lang) { hit(c, B(VO)); set('voLang', lang); R.say.push(`The voice-over is in ${lang === 'hi' ? 'Hindi' : 'English'}.`); }
    else if (neg) { hit(c, B(VO)); hit(c, B(NEG)); set('vo', null); R.say.push('No voice-over.'); }
    else if (has(c, B(LESS)) || has(c, B(MORE))) { /* VO volume: not a setting - left for notes */ }
  }

  // subtitles
  if (hit(c, B(SUBS))) {
    const hin = has(c, B(W('english', 'angrezi', 'hindi', 'हिंदी')));
    if (neg) { hit(c, B(NEG)); set('subtitles', false); R.say.push('No subtitles.'); }
    else { set('subtitles', true); R.say.push('Subtitles from the voice-over.'); }
    if (hin) { hit(c, B(W('english', 'angrezi', 'hindi', 'हिंदी'))); R.notes.push(`Subtitles language: ${c.raw}`); R.handled.add(c); }
  }
  // lyrics on screen
  if (hit(c, B(`${W('lyrics', 'lyric', 'bol', 'gaane ke bol', 'lirics', 'लिरिक्स', 'बोल')} ${W('screen', 'on screen', 'dikhao', 'dikhe', 'likho', 'par', 'pe', 'show', 'स्क्रीन')}`))) { set('lyricsOnScreen', !neg); R.say.push(neg ? 'No lyrics on screen.' : 'The lyrics show on screen.'); }

  // format
  const asp = [
    ['9:16', W('9:16', '9x16', '9/16', 'vertical', 'portrait', 'khada', 'khadi', 'youtube shorts', 'shorts', 'reel', 'reels', 'insta reel', 'instagram reel', 'insta story', 'instagram story', 'whatsapp story', 'whatsapp status', 'status', 'instagram', 'insta', 'tiktok', 'रील', 'रील्स', 'शॉर्ट्स', 'वर्टिकल', 'इंस्टाग्राम', 'इंस्टा', 'खड़ा', 'स्टोरी')],
    ['16:9', W('16:9', '16x9', '16/9', 'landscape', 'horizontal', 'youtube', 'tv', 'widescreen', 'leta', 'aada', 'aadi', 'यूट्यूब', 'लैंडस्केप', 'हॉरिजॉन्टल')],
    ['1:1', W('1:1', '1x1', 'square', 'chaukor', 'chokor', 'चौकोर', 'स्क्वायर')],
    ['4:5', W('4:5', '4x5', 'feed', 'instagram post', 'insta post', 'post', 'फीड')],
  ];
  // "instagram post" before "instagram", "youtube shorts" before "youtube"
  const order = [asp[3], asp[0], asp[2], asp[1]];
  for (const [v, src] of order) {
    if (v === '4:5' && !has(c, B(W('instagram post', 'insta post', 'feed', '4:5', '4x5', 'फीड')))) continue;
    if (v === '9:16' && has(c, B(W('short film')))) continue;
    if (hit(c, B(src))) { set('aspect', v); R.say.push(`Format ${ASPECT_L[v]}.`); if (v === '9:16' && has(c, B(W('reel', 'reels', 'shorts', 'रील')))) R.kind ||= 'reel'; break; }
  }

  // clip speed: "slow motion", "2x"
  let m;
  if ((m = hit(c, B(W('slow motion', 'slowmotion', 'slow-mo', 'slowmo', 'slo mo', 'slomo', 'स्लो मोशन', 'स्लोमो'))))) {
    const v = hit(c, B(LITTLE)) || hit(c, B(W('gentle', 'halka', 'halki', 'light'))) ? 0.75 : 0.5; set('clipSpeed', neg ? 1 : v); if (neg) hit(c, B(NEG));
    R.say.push(neg ? 'Clips at normal speed.' : `Clips in slow motion (${v}x).`);
  } else if ((m = hit(c, /(?<![a-z0-9:.])(0\.5|0\.75|1\.25|1\.5|2|1)\s?x(?![a-z0-9])/))) { set('clipSpeed', +m[1]); hit(c, B(W('speed', 'speed mein', 'स्पीड'))); R.say.push(`Clips at ${m[1]}x speed.`); }
  else if (hit(c, B(W('double speed', 'fast forward', 'speed up', 'speed badhao', 'speed tez', 'tez chalao', 'fast speed')))) { set('clipSpeed', 2); R.say.push('Clips at 2x speed.'); }
  else if (hit(c, B(W('normal speed', 'real speed', 'asli speed', 'original speed')))) { set('clipSpeed', 1); R.say.push('Clips at normal speed.'); }

  // edit style / kind
  if (hit(c, B(W('teaser', 'trailer', 'टीज़र', 'टीजर', 'ट्रेलर', 'promo', 'cinematic teaser', 'movie trailer', 'film trailer')))) { set('editStyle', 'teaser'); R.kind = 'teaser'; R.say.push('Cut like a cinematic teaser.'); }
  else if (hit(c, B(W('montage', 'मोंटाज', 'मॉन्टेज', 'har beat pe cut', 'har beat par cut', 'every beat', 'beat pe cut', 'beat par cut', 'cut on every beat')))) { set('editStyle', 'montage'); R.say.push('Fast montage, a cut on every beat.'); }
  else if (hit(c, B(`${W('song', 'gaane', 'gane', 'gaana', 'music', 'beat', 'lyrics', 'गाने', 'गाना', 'सॉन्ग', 'म्यूजिक')} ${W('ke hisaab se', 'ke hisab se', 'ke hisaab', 'ke hisab', 'ke according', 'ke saath', 'pe', 'par', 'ke beat pe', 'ke beat par', 'ki beat pe', 'के हिसाब से', 'के हिसाब', 'पर')}`)) || hit(c, B(W('song video', 'music video', 'song edit', 'lyric video', 'gaane wala', 'beat sync')))) { set('editStyle', 'song'); R.kind = 'song'; R.say.push('A song edit: cuts on the beat, pictures follow the lyrics.'); }
  else if (hit(c, B(W('documentary', 'docu', 'doc', 'vo film', 'voice over film', 'short film', 'documentary film', 'डॉक्यूमेंट्री', 'डॉक्युमेंट्री', 'वृत्तचित्र')))) { set('editStyle', 'standard'); set('pace', 'slow'); R.kind = 'film'; R.say.push('A documentary: calm cuts that follow the voice-over.'); }
  else if (hit(c, B(W('highlights', 'highlight', 'event highlight', 'हाइलाइट', 'हाइलाइट्स', 'aftermovie', 'after movie')))) { set('editStyle', 'standard'); R.kind = 'highlights'; R.say.push('Event highlights, music-led.'); }
  else if (hit(c, B(W('standard', 'normal edit', 'simple edit', 'seedha edit', 'normal style')))) { set('editStyle', 'standard'); R.say.push('Standard edit style.'); }

  // transitions
  if (hit(c, B(W('dissolve', 'dissolves', 'crossfade', 'cross fade', 'fade', 'fades', 'smooth transition', 'smooth transitions', 'mix transition', 'डिजॉल्व', 'फेड')))) { set('style', neg ? 'cuts' : 'cinematic'); if (neg) hit(c, B(NEG)); hit(c, B(W('transition', 'transitions', 'ट्रांजिशन'))); hit(c, B(W('daalo', 'add', 'lagao', 'use'))); R.say.push(neg ? 'Clean cuts, no dissolves.' : 'Dissolves between ideas.'); }
  else if (hit(c, B(W('clean cut', 'clean cuts', 'hard cut', 'hard cuts', 'sirf cut', 'seedha cut', 'seedhe cut', 'simple cut', 'simple cuts', 'straight cuts', 'no transition', 'no transitions', 'bina transition')))
    || (has(c, B(W('transition', 'transitions', 'ट्रांजिशन'))) && neg && hit(c, B(W('transition', 'transitions', 'ट्रांजिशन'))) && hit(c, B(NEG)))) { set('style', 'cuts'); R.say.push('Clean cuts.'); }
  else if (has(c, B(W('transition', 'transitions', 'ट्रांजिशन'))) && (hit(c, B(MORE)) || hit(c, B(W('daalo', 'add', 'lagao', 'chahiye'))))) { hit(c, B(W('transition', 'transitions', 'ट्रांजिशन'))); set('style', 'cinematic'); R.say.push('Dissolves between ideas.'); }

  // length: "30 sec", "1 minute", "dedh minute", "tees second", "1:30", "2 min 30 sec"; "pehle 5 sec" is a window, not a length
  dur(c, R, ctx);

  // pace
  const fast = W('tez', 'fast', 'quick', 'quicker', 'faster', 'jaldi', 'jaldi jaldi', 'rapid', 'energetic', 'high energy', 'punchy', 'josh', 'snappy', 'tight', 'crisp', 'तेज़', 'तेज', 'जल्दी', 'फास्ट', 'ज़्यादा cuts', 'zyada cuts', 'more cuts');
  const slow = W('slow', 'slower', 'dheema', 'dhima', 'dheemi', 'dheere', 'dheere dheere', 'aaram se', 'calm', 'shant', 'relaxed', 'smooth', 'lambe shot', 'lambe shots', 'long shots', 'kam cuts', 'fewer cuts', 'स्लो', 'धीमा', 'धीमी', 'धीरे', 'आराम से', 'शांत');
  const complaint = B(W('hai', 'hain', 'lag raha', 'lagta', 'lag rahi', 'is', 'too', 'zyada hi', 'है', 'लग रहा'));
  // "climax pe tez", "opening slow hai", "pehle 10 sec tight": the pace of one part only - not a setting, left for notes
  const scoped = !R.cScope && (R.window !== undefined || has(c, B(W('climax', 'opening', 'shuruat', 'shuru', 'intro', 'beech', 'middle', 'ending', 'aakhir', 'build', 'buildup', 'build up', 'drop', 'chorus', 'verse', 'first half', 'second half', 'starting', 'end mein', 'शुरुआत', 'शुरू', 'बीच', 'आखिर', 'अंत'))));
  let p;
  if (scoped) { /* left as words */ }
  else if ((p = hit(c, B(fast)))) {
    const little = has(c, B(LITTLE));
    let v = little ? step(opts.pace, -1) : 'fast';
    if (has(c, complaint) && !has(c, B(W('karo', 'kar do', 'chahiye', 'banao', 'make', 'rakho')))) v = little ? step(opts.pace, 1) : 'slow'; // "bahut fast hai" = slow it down
    set('pace', v); hit(c, B(W('cut', 'cuts', 'cutting', 'editing', 'pace', 'kat', 'कट', 'कट्स'))); hit(c, B(W('pehle se', 'pahle se', 'than before', 'abhi se', 'than now', 'पहले से'))); hit(c, B(MORE)); hit(c, B(VERY)); hit(c, B(LITTLE)); R.say.push(`${PACE_L[v]} pace.`);
  } else if ((p = hit(c, B(slow)))) {
    const little = has(c, B(LITTLE));
    let v = little ? step(opts.pace, 1) : 'slow';
    if (has(c, complaint) && !has(c, B(W('karo', 'kar do', 'chahiye', 'banao', 'make', 'rakho')))) v = little ? step(opts.pace, -1) : 'fast'; // "slow hai" = speed it up
    set('pace', v); hit(c, B(W('cut', 'cuts', 'cutting', 'editing', 'pace', 'kat', 'कट', 'कट्स'))); hit(c, B(W('pehle se', 'pahle se', 'than before', 'abhi se', 'than now', 'पहले से'))); hit(c, B(MORE)); hit(c, B(VERY)); hit(c, B(LITTLE)); R.say.push(`${PACE_L[v]} pace.`);
  } else if (hit(c, B(W('medium pace', 'medium', 'normal pace', 'beech ka', 'moderate', 'मीडियम')))) { set('pace', 'medium'); R.say.push('Medium pace.'); }

  // colour / look
  look(c, R, neg);

  // finish switches
  const sw = (k, src, on, off, needCtx = null) => {
    if (needCtx && !has(c, B(needCtx))) return;
    if (!hit(c, B(src))) return;
    while (hit(c, B(src))); hit(c, B(SHOT));
    if (needCtx) hit(c, B(needCtx));
    const lessOrNeg = neg || hit(c, B(LESS));
    if (neg) hit(c, B(NEG)); else hit(c, B(MORE));
    set(k, !lessOrNeg); R.say.push(lessOrNeg ? off : on);
  };
  if (has(c, B(W('sound effect', 'sound effects', 'sfx', 'whoosh', 'whooshes', 'woosh', 'riser', 'sound design', 'साउंड इफेक्ट', 'साउंड इफेक्ट्स')))) sw('sfx', W('sound effect', 'sound effects', 'sfx', 'whoosh', 'whooshes', 'woosh', 'riser', 'sound design', 'साउंड इफेक्ट', 'साउंड इफेक्ट्स'), 'Sound design on (whooshes, hits).', 'No sound effects.');
  sw('fx', W('effect', 'effects', 'fx', 'vfx', 'light leak', 'light leaks', 'flash', 'glitch', 'shake effect', 'इफेक्ट', 'इफेक्ट्स', 'इफ़ेक्ट', 'इफ़ेक्ट्स'), 'More effects: teaser effects on the cuts.', 'Fewer effects: teaser effects off.');
  sw('cinematic', W('cinematic', 'cinematic finish', 'film look', 'filmy', 'black bars', 'bars', 'letterbox', 'grain', 'vignette', 'सिनेमैटिक', 'सिनेमेटिक'), 'Cinematic finish (bars, vignette, grain).', 'No cinematic finish.');
  sw('stabilize', W('stabilize', 'stabilise', 'stabilization', 'stable', 'steady', 'shaky', 'hilte', 'hilna', 'hil raha', 'jhatke', 'shake', 'स्टेबल', 'स्टेबलाइज़', 'हिलना'), 'Shaky shots get stabilized.', 'No stabilizing.');
  sw('autoColor', W('auto colour', 'auto color', 'colour correct', 'color correct', 'colour correction', 'color correction', 'colour theek', 'color theek', 'colour balance', 'color balance', 'auto grade'), 'Auto colour on every shot.', 'No auto colour.');
  sw('keepSound', W('original sound', 'natural sound', 'nat sound', 'ambience', 'ambient', 'ambient sound', 'live sound', 'clip ki awaaz', 'clips ki awaaz', 'asli awaaz', 'apni awaaz', 'real sound', 'background sound', 'असली आवाज़'), "Some of the clips' own sound is kept.", "No clip sound under the music.");
  sw('detectLog', W('log footage', 'log profile', 'lut', 'slog', 's-log', 'vlog', 'v-log', 'clog', 'c-log', 'dlog', 'd-log'), 'LOG footage gets a LUT.', 'No LUT for LOG footage.');

  // title / end card / names
  textFields(c, R, neg);
  // first / last shot
  ends(c, ctx, R, neg);
  // must / avoid: a file of the project named in the text
  const mm = findMedia(c, media, ['video', 'image']);
  if (mm) {
    if (neg || has(c, B(W('avoid', 'mat', 'nahi', 'hatao', 'remove', 'bina', 'skip')))) { R.avoid.add(mm.id); R.say.push(`"${mm.name}" is not used.`); hit(c, B(NEG)); }
    else { R.must.add(mm.id); R.say.push(`"${mm.name}" is used.`); hit(c, B(W('zaroor', 'jarur', 'must', 'definitely', 'use', 'daalo', 'lagao', 'include', 'ज़रूर', 'जरूर'))); }
  }
}
const step = (cur, d) => { const L = ['fast', 'medium', 'slow'], i = Math.max(0, L.indexOf(cur || 'medium')); return L[Math.max(0, Math.min(2, i + d))]; };

// ---- re-edit scope (ADDENDUM 1): only a time range / some shots / the selected clips change ----
// timecode -> seconds: m:ss, h:mm:ss, mm:ss:ff (a 2-digit first part and a last part below the frame rate), hh:mm:ss:ff
function tc(s, fps = 25) {
  const p = String(s).split(':'), n = p.map(Number);
  if (p.length === 1) return n[0];
  if (p.length === 2) return n[0] * 60 + n[1];
  if (p.length === 4) return n[0] * 3600 + n[1] * 60 + n[2] + n[3] / fps;
  const ff = p[0].length === 2 && n[2] < fps;
  return ff ? n[0] * 60 + n[1] + n[2] / fps : n[0] * 3600 + n[1] * 60 + n[2];
}
const mmss = (v) => { const r = Math.round(v * 10) / 10, h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), s = r - h * 3600 - m * 60; return `${h ? `${h}:${m < 10 ? '0' : ''}` : ''}${m}:${s < 10 ? '0' : ''}${+s.toFixed(1)}`; };
const ORD = {};
[['pehla', 'pahla', 'pehli', 'pahli', 'first', '1st', 'पहला', 'पहली'], ['dusra', 'doosra', 'dusri', 'doosri', 'second', '2nd', 'दूसरा', 'दूसरी'], ['teesra', 'tisra', 'teesri', 'tisri', 'third', '3rd', 'तीसरा', 'तीसरी'],
  ['chautha', 'chotha', 'chauthi', 'fourth', '4th', 'चौथा', 'चौथी'], ['paanchva', 'panchva', 'panchwa', 'paanchvan', 'fifth', '5th', 'पांचवा', 'पाँचवाँ', 'पांचवां'], ['chhatha', 'chhata', 'chhatva', 'sixth', '6th', 'छठा'],
  ['saatva', 'satva', 'satvan', 'seventh', '7th', 'सातवां', 'सातवाँ'], ['aathva', 'athva', 'eighth', '8th', 'आठवां', 'आठवाँ'], ['nauva', 'nauvan', 'ninth', '9th', 'नौवां', 'नौवाँ'], ['dasva', 'dasvan', 'tenth', '10th', 'दसवां', 'दसवाँ']]
  .forEach((ws, i) => ws.forEach((w) => { ORD[normTok(w)] = i + 1; }));
const ordOf = (n) => ORD[n] ?? (/^(\d{1,3})(st|nd|rd|th|va|van|vi|vin)$/.exec(n) ? +RegExp.$1 : undefined);
const SHOTS = W('shot', 'shots', 'clip', 'clips', 'scene', 'scenes', 'शॉट', 'क्लिप', 'सीन');
const SEL = W('ye clip', 'yeh clip', 'ye clips', 'ye shot', 'yeh shot', 'ye shots', 'is clip', 'iss clip', 'is shot', 'iss shot', 'in clips', 'inn clips', 'in shots', 'selected clip', 'selected clips', 'selected shot', 'selected shots', 'select kiya', 'select kiye', 'select ki', 'selection', 'this clip', 'this shot', 'these clips', 'these shots', 'chuni hui clip', 'chune hue clips', 'chuna hua shot', 'इस क्लिप', 'ये क्लिप', 'यह क्लिप', 'इस शॉट', 'ये शॉट', 'यह शॉट', 'सेलेक्टेड', 'सिलेक्टेड');
const editDur = (ctx) => +ctx.duration || +ctx.opts.duration || +ctx.opts.target || 60;
function addScope(R, sc, say) {
  const S = R.scope;
  if (!S) { R.scope = sc; }
  else if (S.kind === sc.kind && sc.kind === 'slots') S.index = [...new Set([...S.index, ...sc.index])].sort((a, b) => a - b);
  else if (S.kind === sc.kind && sc.kind === 'range') { S.from = Math.min(S.from, sc.from); S.to = Math.max(S.to, sc.to); delete S.fromEnd; }
  else if (S.kind !== sc.kind) { R.notes.push(`Also asked to limit the re-edit to: ${say}`); return; }
  R.cScope = true;
}
// the number words of a clause become digits before a unit ("tees second", "dedh minute", "forty five seconds")
function numWords(c) {
  const unitRe = B(`${UNIT_S}|${UNIT_M}`);
  for (let i = 0; i < c.toks.length; i++) {
    const k = c.toks[i], nx = c.toks[i + 1]?.n || '';
    const unit = unitRe.test(nx);
    if (NUM[k.n] !== undefined && (unit || (NUM[c.toks[i + 1]?.n] !== undefined && unitRe.test(c.toks[i + 2]?.n || '')))) {
      let v = NUM[k.n];
      if (!unit && v >= 20 && NUM[c.toks[i + 1].n] < 10) { v += NUM[c.toks[i + 1].n]; c.toks.splice(i + 1, 1); c.used = new Set([...c.used].filter((j) => j !== i + 1).map((j) => (j > i + 1 ? j - 1 : j))); } // "forty five"
      if (i > 0 && /^(sade|sadhe|sarhe)$/.test(c.toks[i - 1].n)) v += 0.5; // "saade teen" = 3.5
      k.n = String(v);
    }
  }
  const isM = new RegExp(`^(?:${UNIT_M})$`), isS = new RegExp(`^(?:${UNIT_S})$`);
  for (let i = 0; i + 3 < c.toks.length; i++) {
    const [a, u, b2, v] = c.toks.slice(i, i + 4).map((k) => k.n);
    if (/^\d+$/.test(a) && isM.test(u) && /^\d{1,2}$/.test(b2) && +b2 < 60 && isS.test(v)) {
      c.toks[i].n = `${a}:${b2.padStart(2, '0')}`; c.toks.splice(i + 1, 3);
      c.used = new Set([...c.used].filter((j) => j <= i || j > i + 3).map((j) => (j > i + 3 ? j - 3 : j)));
    }
  }
  c.toks.forEach((k, i) => { k.at = i ? c.toks[i - 1].end + 1 : 0; k.end = k.at + k.n.length; });
}
function scope(c, ctx, R) {
  if (ctx.mode !== 'reedit') return;
  const fps = +ctx.fps || 25;
  // the timeline selection: "ye clip", "selected clips", "is shot ko"
  if (hit(c, B(SEL))) { hit(c, B(SHOTS)); addScope(R, { kind: 'clips', ids: [] }, 'the selected clips'); R.say.push('Only the selected clips change.'); }
  // shots by number: "teesra shot", "shot 3", "3rd clip", "shot number 3", "3 number shot", "shot 2 se 4", "aakhri shot"
  const idx = [];
  const toks = c.toks;
  for (let i = 0; i < toks.length; i++) {
    if (c.used.has(i) || !B(SHOTS).test(toks[i].n)) continue;
    const p = toks[i - 1]?.n, pp = toks[i - 2]?.n;
    // "pehla shot" / "aakhri shot" only when the clause changes it ("pehla shot badlo"); else it says what that shot shows
    const changes = () => has(c, B(`${CHANGE}|${NEG}|${W('better', 'theek', 'fix', 'sudharo', 'tez', 'slow', 'dheema', 'colour', 'color', 'replace', 'hatao')}`));
    let got = null;
    const o = p !== undefined && !c.used.has(i - 1) ? ordOf(p) : undefined;
    if (o !== undefined && !/^\d+(\.\d+)?$/.test(pp || '')) { if (o > 1 || changes()) got = [o - 1, i - 1, i]; }
    else if (p && /^(number|nambar|no|nmbr)$/.test(p) && /^\d{1,3}$/.test(pp || '')) got = [+pp - 1, i - 2, i]; // "3 number shot"
    else if (p && !c.used.has(i - 1) && B(LAST).test(p)) { if (changes()) got = [-1, i - 1, i]; }
    else {
      let j = i + 1;
      if (/^(no|number|nambar|nmbr|#)$/.test(toks[j]?.n || '')) j++;
      if (/^\d{1,3}$/.test(toks[j]?.n || '')) {
        const a = +toks[j].n;
        if (/^(se|to|till)$/.test(toks[j + 1]?.n || '') && /^\d{1,3}$/.test(toks[j + 2]?.n || '')) { for (let x = a; x <= Math.min(+toks[j + 2].n, a + 50); x++) idx.push(x - 1); for (let y = i; y <= j + 2; y++) c.used.add(y); if (/^(tak|till)$/.test(toks[j + 3]?.n || '')) c.used.add(j + 3); continue; }
        got = [a - 1, i, j];
      }
    }
    if (got && got[0] >= -1) { idx.push(got[0]); for (let y = got[1]; y <= got[2]; y++) c.used.add(y); }
  }
  if (idx.length) {
    const slotN = +ctx.slots || 0, ix = [...new Set(idx.map((x) => (x === -1 && slotN ? slotN - 1 : x)))].filter((x) => x >= -1).sort((a, b) => a - b);
    addScope(R, { kind: 'slots', index: ix }, 'some shots');
    R.say.push(ix.length === 1 && ix[0] === -1 ? 'Only the last shot changes.' : `Only shot${ix.length > 1 ? 's' : ''} ${ix.map((x) => (x === -1 ? 'the last' : x + 1)).join(', ')} change${ix.length > 1 ? '' : 's'}.`);
  }
  // "teesra shot badlo" = another shot there; "shot 3 hata do" = take it out (the engine's job, said in a note)
  if (R.cScope && !has(c, B(MUSIC))) {
    if (hit(c, B(CHANGE))) { hit(c, B(W('karo', 'kar do', 'do'))); R.say.push('They get a different shot.'); }
    else if (has(c, B(W('hata do', 'hatao', 'hata', 'delete', 'remove', 'nikal do', 'nikalo', 'हटा दो', 'हटाओ')))) {
      hit(c, B(W('hata do', 'hatao', 'hata', 'delete', 'remove', 'nikal do', 'nikalo', 'हटा दो', 'हटाओ'))); R.say.push('They are taken out of the edit.'); R.notes.push('Remove these shots from the edit (the rest closes up).'); R.handled.add(c);
    }
  }
  // a time range: "0:10 se 0:25 tak", "10 se 20 second", "1:10 to 1:30", "00:10:12 - 00:20:00"
  numWords(c);
  const T = String.raw`(\d+(?::\d\d){1,3}|\d+(?:\.\d+)?)`, U = `(?:\\s?(${UNIT_S}|${UNIT_M}))?`;
  const re = new RegExp(String.raw`(?<![a-z0-9:.])(?:from |between )?${T}${U}\s(?:se|to|till|until|-)\s${T}${U}(?:\s(tak|till|tk))?(?![a-z0-9])`);
  const m = re.exec(live(c));
  if (m) {
    const isM = (u) => u && new RegExp(`^(?:${UNIT_M})$`).test(u);
    const unitB = m[4] || m[2], timey = /:/.test(m[1] + m[3]) || unitB || m[5];
    if (timey) {
      const val = (x, u) => (/:/.test(x) ? tc(x, fps) : +x * (isM(u || unitB) ? 60 : 1));
      const a = val(m[1], m[2]), b = val(m[3], m[4]);
      if (b > a) { take(c, m.index, m.index + m[0].length); addScope(R, { kind: 'range', from: +a.toFixed(2), to: +b.toFixed(2) }, `${mmss(a)} - ${mmss(b)}`); R.say.push(`Only ${mmss(a)} - ${mmss(b)} changes.`); }
    }
  }
  // "beech wala hissa", "middle part"
  if (hit(c, B(W('beech wala hissa', 'beech ka hissa', 'beech wala part', 'beech ka part', 'middle part', 'middle portion', 'बीच वाला हिस्सा', 'बीच का हिस्सा')))) {
    const d = editDur(ctx), a = Math.round(d / 3), b = Math.round((2 * d) / 3);
    addScope(R, { kind: 'range', from: a, to: b }, 'the middle'); R.say.push(`Only the middle (about ${mmss(a)} - ${mmss(b)}) changes.`);
  }
}
// "pehle 5 sec" / "aakhri 10 second" in a re-edit: that stretch of the edit
function windowScope(ctx, R, v, last) {
  if (ctx.mode !== 'reedit') return;
  const d = editDur(ctx), a = last ? Math.max(0, d - v) : 0, b = last ? d : Math.min(v, d);
  addScope(R, { kind: 'range', from: +a.toFixed(2), to: +b.toFixed(2), ...(last ? { fromEnd: v } : {}) }, last ? `the last ${sec(v)}` : `the first ${sec(v)}`);
  R.say.push(`Only the ${last ? 'last' : 'first'} ${sec(v)} change.`);
}

function dur(c, R, ctx) {
  numWords(c);
  const s = live(c);
  const re = new RegExp(`(?<![a-z0-9:.])(?:(\\d+(?::\\d\\d){1,3})(?:\\s*${UNIT_M})?|(\\d+(?:\\.\\d+)?)\\s?(${UNIT_S}|${UNIT_M})(?:\\s+(\\d+)\\s?${UNIT_S})?)(?![a-z0-9])`, 'g');
  const isMin = new RegExp(`^(?:${UNIT_M})$`), firstLast = B(`${FIRST}|${LAST}`), cutWord = /^(shot|shots|cut|cuts|clip|clips)$/;
  for (const m of s.matchAll(re)) {
    const v = m[1] ? tc(m[1], +ctx.fps || 25) : isMin.test(m[3]) ? +m[2] * 60 + (+m[4] || 0) : +m[2];
    take(c, m.index, m.index + m[0].length);
    const prev = c.toks.filter((k) => k.end <= m.index).map((k) => k.n).slice(-2);
    const next = c.toks.filter((k) => k.at >= m.index + m[0].length).map((k) => k.n);
    // "har 2 second", "2 sec ke shots", "3 second cuts" = shot length -> pace
    if (/^(har|every|each|per)$/.test(prev[prev.length - 1] || '') || cutWord.test(next[0] || '') || (/^(ke|ka|ki|of|ke liye)$/.test(next[0] || '') && cutWord.test(next[1] || ''))) {
      const v2 = v <= 2.2 ? 'fast' : v <= 3.5 ? 'medium' : 'slow';
      c.toks.forEach((k, i) => { if (/^(har|every|each|per|mein|me|ke|ka|ki|of|shot|shots|cut|cuts|clip|clips|ek|one)$/.test(k.n)) c.used.add(i); });
      if (!('pace' in R.set)) { R.set.pace = v2; R.say.push(`Shots of about ${sec(v)}: ${PACE_L[v2].toLowerCase()} pace.`); }
      continue;
    }
    // "pehle 5 sec mein ..." / "last 10 seconds" = a window for the first / last shot, not the length
    if (prev.some((w) => firstLast.test(w))) { R.window = v; windowScope(ctx, R, v, !prev.some((w) => B(FIRST).test(w))); continue; }
    if (v >= 3 && v <= 1800) { R.target = Math.round(v); R.say.push(`Length about ${sec(R.target)}.`); }
  }
  // "chhota karo", "lamba karo", "aadha karo"
  if (R.target === undefined) {
    if (hit(c, B(W('aadha', 'adha', 'half', 'आधा')))) R.rel = 0.5;
    else if (hit(c, B(W('chhota', 'chota', 'chhoti', 'choti', 'short', 'shorter', 'trim', 'kam lamba', 'chhota sa', 'छोटा', 'छोटी', 'ghatao lambai')))) R.rel = hit(c, B(VERY)) ? 0.5 : -1;
    else if (hit(c, B(W('lamba', 'lambi', 'long', 'longer', 'bada', 'badi', 'extend', 'लंबा', 'लम्बा', 'लंबी', 'बड़ा')))) R.rel = hit(c, B(VERY)) ? 2 : 1;
    if (R.rel !== undefined) hit(c, B(W('length', 'lambai', 'duration', 'video', 'edit', 'लंबाई')));
  }
}

function look(c, R, neg) {
  const ctxW = W('colour', 'color', 'colours', 'colors', 'rang', 'look', 'grade', 'grading', 'tone', 'tones', 'lut', 'filter', 'feel', 'mood', 'रंग', 'कलर', 'लुक', 'टोन');
  // [name, words that mean the look anywhere, words that mean it only next to "colour / look / rang"]
  const named = [
    ['Teal & Orange', W('teal & orange', 'teal orange', 'orange teal', 'teal', 'hollywood look', 'blockbuster look', 'टील', 'टील ऑरेंज'), null],
    ['Warm Film', W('warm', 'warm film', 'warmer', 'वार्म'), W('garam', 'garm', 'गर्म', 'गरम')],
    ['Golden Hour', W('golden hour', 'sunehra', 'sunehri', 'सुनहरा', 'सुनहरी', 'गोल्डन'), W('golden', 'sunset')],
    ['Moody Dark', W('moody', 'moody dark', 'gloomy', 'मूडी'), W('dark', 'andhera', 'serious', 'डार्क')],
    ['Travel Vivid', W('vivid', 'travel vivid', 'colourful', 'colorful', 'rangeen', 'rangin', 'vibrant', 'रंगीन', 'चटक'), W('chatak', 'bright', 'punchy')],
    ['Indian Heritage', W('heritage', 'indian heritage', 'हेरिटेज'), W('traditional', 'desi', 'indian', 'virasat', 'पारंपरिक', 'विरासत')],
    ['Bleach Bypass', W('bleach', 'bleach bypass', 'desaturated'), W('muted', 'faded', 'feeka', 'phika', 'फीका')],
    ['Clean Natural', W('clean natural', 'natural colour', 'natural color', 'natural look'), W('natural', 'clean', 'normal', 'asli', 'real', 'नेचुरल', 'असली')],
  ];
  const bw = B(W('black & white', 'black white', 'b&w', 'bw', 'monochrome', 'mono', 'grayscale', 'greyscale', 'ब्लैक & व्हाइट', 'श्वेत श्याम'));
  if (hit(c, bw)) {
    hit(c, B(ctxW)); R.set.look ??= 'Bleach Bypass';
    R.say.push('Black and white: there is no B&W look, so Bleach Bypass (the most muted) is used.');
    R.notes.push('Black and white wanted - make the grade fully black and white.'); R.handled.add(c);
    return;
  }
  const inCtx = has(c, B(ctxW));
  if (inCtx && has(c, B(W('chhedo', 'chhed', 'chhuo', 'touch', 'mat badlo', 'mat badalna', 'same', 'waisa hi', 'jaisa hai', 'छेड़ो', 'मत बदलो')))) { takeAll(c); R.say.push('The colour stays as it is.'); return; }
  for (const [name, strong, weak] of named) {
    const src = inCtx && weak ? `${W(name)}|${strong}|${weak}` : `${W(name)}|${strong}`;
    if (!hit(c, B(src))) continue;
    hit(c, B(ctxW)); hit(c, B(MORE)); hit(c, B(LITTLE));
    // "teal orange nahi" = take that look off
    if (neg) { hit(c, B(NEG)); R.set.look ??= ''; R.say.push(`No ${name} look (just balanced).`); return; }
    R.set.look ??= name; R.say.push(`Film look: ${name}.`); return;
  }
  if (inCtx && neg && hit(c, B(ctxW))) { hit(c, B(NEG)); R.set.look ??= ''; R.say.push('No film look (just balanced).'); }
}

function textFields(c, R, neg) {
  const q = quoted(c.raw);
  const after = (re) => { const i = c.toks.findIndex((k) => re.test(k.n)); return i < 0 ? '' : c.toks.slice(i + 1).filter((k) => !FILLER.has(k.n) && !/^(likho|likh|likhna|likhe|text|write|rakho|ho|hona|pe|par|card|screen|:|-)$/.test(k.n)).map((k) => k.raw).join(' '); };
  if (has(c, B(W('title', 'titles', 'heading', 'शीर्षक', 'टाइटल'))) && !has(c, B(W('end', 'subtitle', 'sub title', 'lower third')))) {
    hit(c, B(W('title', 'titles', 'heading', 'शीर्षक', 'टाइटल')));
    const t = neg ? '' : (q || after(B(W('title', 'heading', 'शीर्षक', 'टाइटल'))));
    if (neg || t) { hit(c, B(NEG)); R.set.title ??= t; R.say.push(t ? `Title: "${t}".` : 'No title.'); takeAll(c); }
  }
  if (hit(c, B(W('end card', 'endcard', 'end screen', 'end slate', 'last card', 'ending card', 'end text', 'closing card', 'एंड कार्ड')))) {
    const url = (c.raw.match(URL) || [])[0];
    const t = neg ? '' : (q || url || after(B(W('card', 'screen', 'slate', 'text', 'कार्ड'))));
    if (neg || t) { R.set.endText ??= t; R.say.push(t ? `End card: "${t}".` : 'No end card.'); takeAll(c); }
  }
  if (hit(c, B(W('names', 'naam', 'spelling', 'spellings', 'नाम')))) {
    const t = c.raw.split(/[:：]/).slice(1).join(':').trim() || after(B(W('names', 'naam', 'spelling', 'spellings', 'नाम')));
    if (t) { R.set.names ??= t; R.say.push(`Names: ${t}.`); takeAll(c); }
  }
}

// "pehle CM sahab ka shot", "shuru mein drone shot", "drone shot se shuru karo", "end mein logo", "aakhir mein thank you"
const ENDPH = B(W('thank you', 'thanks', 'thankyou', 'dhanyavaad', 'dhanyavad', 'shukriya', 'jai hind', 'jai bharat', 'vande mataram', 'bharat mata ki jai', 'the end', 'subscribe', 'follow us', 'धन्यवाद', 'शुक्रिया', 'जय हिंद', 'जय भारत', 'वंदे मातरम'));
const ABSTRACT = new Set(['suspense', 'tension', 'mystery', 'energy', 'josh', 'drama', 'emotion', 'emotional', 'build', 'buildup', 'slow', 'fast', 'tez', 'dheema', 'thriller', 'hook', 'silence', 'khamoshi', 'sannata', 'feel', 'mood', 'vibe', 'impact', 'dhamaka', 'excitement', 'curiosity', 'interest', 'thoda', 'zyada', 'kam', 'acha', 'achha', 'badhiya', 'mast', 'jaan', 'power', 'punch', 'tight', 'crisp', 'short', 'chhota', 'lamba', 'fast cut', 'slow cut'].map((w) => normTok(w)));
const URL = /\b[\w.-]+\.(?:gov\.in|nic\.in|org\.in|co\.in|in|com|org|net)\b\S*/i;
// force: 'first' | 'last' - a clause that goes on from the one before ("end mein logo aur thank you")
function ends(c, ctx, R, neg, force = null) {
  const lead = B(FIRST).test(c.toks[0]?.n || '') && !c.used.has(0) && c.toks.length > 1 && !/^(se|jaisa|jaise|wala|vala|vali|bhi|hi|ki|ka|ke)$/.test(c.toks[1].n);
  const isFirst = force ? force === 'first' : has(c, B(FIRST)) && (lead || has(c, B(SHOT)) || has(c, B(W('se shuru', 'se start', 'start with', 'open with', 'begin with', 'shuru karo', 'mein', 'me', 'में', 'से शुरू', 'dikhao', 'dikha', 'show'))));
  const isLast = force ? force === 'last' : !isFirst && has(c, B(LAST)) && has(c, B(W('mein', 'me', 'main', 'में', 'pe', 'par', 'with', 'on', 'at', 'shot', 'aaye', 'dikhe', 'dikhao', 'पर')));
  if (!isFirst && !isLast) return;
  const was = new Set(c.used);
  if (!force && !hit(c, B(isFirst ? FIRST : LAST))) return;
  const shotty = has(c, B(SHOT));
  const box = isFirst ? (R.first ||= {}) : (R.last ||= {});
  if (R.window && isFirst) box.within = R.window;
  const within = () => (box.within ? ` (in the first ${sec(box.within)})` : '');
  let did = false;
  // end-card words: "thank you", "धन्यवाद", "mygov.in", "'Jai Hind'"
  if (isLast && !shotty) {
    const q = quoted(c.raw), url = (c.raw.match(URL) || [])[0], m = !q && !url && ENDPH.exec(live(c));
    const t = q || url || (m && cap(c.toks.filter((k) => k.at < m.index + m[0].length && k.end > m.index).map((k) => k.raw).join(' ')));
    if (m) take(c, m.index, m.index + m[0].length);
    if (t) { box.text = t; R.set.endText ??= t; R.say.push(`Ends with the words "${t}".`); did = true; }
  }
  const who = mentioned(abbr(c.raw), asPeople(ctx.people));
  const words = rest(c, B(`${SHOT}|${CHANGE}|${W('shuru', 'start', 'mein', 'me', 'se', 'karo', 'ho', 'hona', 'chahiye', 'dikhao', 'dikhe', 'aaye', 'aana', 'aaega', 'rakho', 'lagao', 'daalo', 'pe', 'par', 'sabse', 'bilkul', 'ekdam', 'hi', 'second', 'sec', 'वाला', 'में', 'से', 'शुरू', 'हो', 'करो', 'दिखाओ', 'पर')}`));
  const text = words.join(' ').replace(/^[:\-–\s]+|[:\-–\s]+$/g, '');
  // "shuru mein thoda suspense" is a mood, not a shot: left for the LLM / notes
  if (!force && words.length && words.every((w) => ABSTRACT.has(normTok(w)))) { if (!Object.keys(box).some((k) => k !== 'within')) { if (isFirst) delete R.first; else delete R.last; } c.used = was; return; }
  if (who.length) {
    box.person = who[0].name; if (who[0].key) box.personKey = who[0].key;
    R.say.push(`${isFirst ? 'Starts' : 'Ends'} with a shot of ${who[0].name}${within()}.`); did = true;
  } else if (isLast && !shotty && /(^| )(logo|लोगो)( |$)/i.test(` ${text.toLowerCase()} `)) {
    const lg = (ctx.media || []).find((m) => /logo/i.test(m.name) && m.kind === 'image');
    box.logo = lg ? lg.id : true; R.say.push('Ends on the logo.'); did = true;
  } else if (text && !did) {
    const mm = findMedia(c, ctx.media, ['video', 'image']);
    if (mm) box.mediaId = mm.id;
    if (force && box.text) { box.text = `${box.text}, ${text}`; R.say.push(`The ${isFirst ? 'opening' : 'ending'} also shows ${text}.`); }
    else { box.text = text; R.say.push(`${isFirst ? 'Starts' : 'Ends'} with ${/shot|clip|scene/i.test(text) ? '' : 'a shot of '}${text}${within()}.`); }
    did = true;
  }
  if (!did) { if (!Object.keys(box).some((k) => k !== 'within')) { if (isFirst) delete R.first; else delete R.last; } return; }
  R.side = isFirst ? 'first' : 'last';
  takeAll(c);
}
const cap = (s) => s.replace(/(^|\s)([a-z])/g, (a, b, ch) => b + ch.toUpperCase());

// ---- the rules pass ----
export function parseRules(text, { mode = 'new', opts = {}, media = [], people = [], duration = 0, fps = 25, slots = 0 } = {}) {
  const ctx = { mode, opts: opts || {}, media: media || [], people: people || [], duration, fps, slots };
  const R = { set: {}, why: {}, say: [], notes: [], handled: new Set(), must: new Set(), avoid: new Set() };
  const cs = clauses(text);
  for (const c of cs) {
    const side = R.side; R.side = null; R.window = undefined; R.cScope = false;
    rules(c, ctx, R);
    // a short clause no rule took, right after a first / last one, says more about that shot ("end mein logo aur thank you")
    if (side && !c.used.size && !R.handled.has(c) && !has(c, B(W('beech', 'middle', 'phir', 'fir', 'baad', 'uske baad', 'then', 'next', 'बीच', 'बाद')))) { const w = rest(c); if (w.length && w.length <= 5) ends(c, ctx, R, false, side); }
  }
  const o = {};
  // length: an exact one wins over "chhota karo"
  const cur = +ctx.opts.target || 60;
  if (R.target !== undefined) o.target = R.target;
  else if (R.rel !== undefined) {
    if (R.rel === -1) o.target = [...LENGTHS].reverse().find((x) => x < cur) || 15;
    else if (R.rel === 1) o.target = LENGTHS.find((x) => x > cur) || cur * 1.5;
    else o.target = Math.max(10, Math.round(cur * R.rel));
    R.say.push(`${o.target < cur ? 'Shorter' : 'Longer'}: about ${sec(o.target)}.`);
  }
  Object.assign(o, R.set);
  // a new edit asked for as a kind ("teaser jaisa", "30 sec ki reel") gets that kind's settings where the text set none
  if (mode === 'new' && R.kind && TYPES[R.kind]) {
    const T = TYPES[R.kind], extra = [];
    for (const [k, v] of Object.entries(T)) if (!(k in o)) { o[k] = v; extra.push(k); }
    if (extra.length) R.say.push(`${TYPE_NAME[R.kind]} settings: ${extra.map((k) => `${KEY_L[k].toLowerCase()} ${show(k, T[k], ctx.media)}`).join(', ')}.`);
  }
  // only what changes
  const changes = [];
  for (const [k, v] of Object.entries(o)) {
    const from = ctx.opts[k];
    const same = k === 'target' ? Math.abs((+from || 0) - v) < 0.5 : (from ?? null) === (v ?? null) || (k === 'clipSpeed' && +from === +v);
    if (same && k in ctx.opts) { delete o[k]; continue; }
    changes.push({ key: k, from: from ?? null, to: v, label: `${KEY_L[k] || k}: ${from === undefined ? '' : `${show(k, from, ctx.media)} to `}${show(k, v, ctx.media)}` });
  }
  const constraints = {};
  if (R.first) constraints.first = R.first;
  if (R.last) constraints.last = R.last;
  if (R.must.size) constraints.must = [...R.must];
  if (R.avoid.size) constraints.avoid = [...R.avoid];
  if (R.musicVolume !== undefined) { constraints.musicVolume = R.musicVolume; changes.push({ key: 'musicVolume', from: ctx.opts.musicVolume ?? null, to: R.musicVolume, label: `Music volume: ${Math.round(R.musicVolume * 100)}%` }); }
  // re-edit: what can stay. Said in words wins; else finish-only changes keep every shot, other changes keep shots as a prior
  if (mode === 'reedit') constraints.scope = R.scope || { kind: 'all' };
  if (R.keep) constraints.keep = R.keep;
  else if (mode === 'reedit' && (changes.length || constraints.first || constraints.last)) {
    const FINISH = new Set(['look', 'fx', 'sfx', 'cinematic', 'title', 'endText', 'subtitles', 'autoColor', 'stabilize', 'musicVolume', 'lyricsOnScreen', 'names', 'detectLog', 'keepSound']);
    constraints.keep = changes.every((x) => FINISH.has(x.key)) && !constraints.first && !constraints.last && !constraints.must && !constraints.avoid ? 'all' : 'shots';
  }
  // words no rule could place: whole clauses (as written) with what they still say
  const left = [];
  for (const c of cs) {
    if (R.handled.has(c)) continue;
    const w = rest(c);
    const meaningful = w.length >= 2 || w.some((x) => normTok(x).length >= 4);
    if (meaningful) left.push(c.raw);
  }
  return { opts: o, changes, constraints, notes: [...new Set([...R.notes, ...left])], understood: [...new Set(R.say)], via: 'rules', left, keepSaid: !!R.keep };
}

// ---- the LLM pass: only the words the rules left ----
// The model answers with a short list of { phrase, key, value }: every setting must quote the words it comes from, so a
// setting the text never asked for (a 7B model likes to fill every field) is dropped when its phrase is not in the text.
const LLM_KEYS = ['aspect', 'pace', 'editStyle', 'target', 'clipSpeed', 'look', 'style', 'voLang', 'songPart', ...ALLOWED.bools, 'title', 'endText',
  'noMusic', 'noVoiceOver', 'first', 'last', 'endsOnLogo', 'musicVolume'];
const LLM_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['settings', 'notes'],
  properties: {
    settings: {
      type: 'array', maxItems: 6,
      items: { type: 'object', additionalProperties: false, required: ['phrase', 'key', 'value'],
        properties: { phrase: { type: 'string', maxLength: 60 }, key: { type: 'string', enum: LLM_KEYS }, value: { type: 'string', maxLength: 60 } } },
    },
    notes: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 160 } },
  },
};
// constant, so llama-server keeps it in its prompt cache and only the short question is read each time
const LLM_SYSTEM = `You turn a video editor's wishes (Hindi, Hinglish or English) into settings of an automatic video editing app.
Settings (key: allowed values):
- aspect: 9:16 | 16:9 | 1:1 | 4:5
- pace: fast | medium | slow   (how quickly the shots change)
- editStyle: standard | teaser | montage | song   (teaser = trailer: slow mysterious open, build-up, fast climax; montage = a cut on every beat; song = cut to a song and its lyrics)
- target: length in seconds, a number
- clipSpeed: 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2   (slow motion = 0.5)
- look: ${LOOKS.join(' | ')} | none   (the colour of the whole edit)
- style: cuts | cinematic   (cinematic = dissolves between ideas)
- voLang: hi | en | auto
- subtitles, fx (flashy teaser effects on cuts), sfx (whoosh / hit sound effects), cinematic (film bars, vignette, grain), stabilize, autoColor, keepSound (the clips' own sound), musicBest, lyricsOnScreen: true | false
- title, endText: the exact words to show on screen
- noMusic, noVoiceOver, endsOnLogo: true
- first, last: what the first / last shot should show, in a few English words (or the person's name)
- musicVolume: 0 to 1   (quieter music = 0.5)
Rules: set ONLY what the words clearly and directly ask for; "phrase" = the exact words of the text the setting comes from. Most wishes need 0 or 1 setting. A mood, a story wish or a wish about which people / things to show is NOT a setting: put it in notes. When unsure, use notes.
"notes" = every wish that the settings do not fully express, as short clear English instructions for the editor (one per wish). Never invent wishes.

Examples:
Text: intro mein thoda mystery, phir dhamakedar ending
{"settings":[{"phrase":"intro mein thoda mystery","key":"editStyle","value":"teaser"}],"notes":["Open with mystery and end with a big finish"]}
Text: VHS wala retro feel chahiye
{"settings":[{"phrase":"retro feel","key":"look","value":"Warm Film"}],"notes":["Give it a retro VHS feel"]}
Text: sirf ladkiyon wale shots lo
{"settings":[],"notes":["Use only shots of girls"]}
Text: sabko garv mehsoos ho, desh bhakti wala
{"settings":[],"notes":["Make it feel proud and patriotic"]}
Text: ekdum dhaasu banao, full energy
{"settings":[{"phrase":"full energy","key":"pace","value":"fast"},{"phrase":"ekdum dhaasu","key":"fx","value":"true"}],"notes":[]}
Text: background mein halka sa gaana
{"settings":[{"phrase":"halka sa gaana","key":"musicVolume","value":"0.4"}],"notes":[]}`;
function llmPrompt(left, full, ctx) {
  const people = asPeople(ctx.people).map((p) => p.name).slice(0, 30);
  return `${people.length ? `Known people: ${people.join(', ')}\n` : ''}${left.length > 1 || left[0] !== full ? `(Whole message, for context only: ${full})\n` : ''}Text: ${left.join(', ')}`;
}
// the quoted phrase must be in the text: most of its words (same spelling folding as the rules)
function grounded(phrase, text) {
  const pw = norm(phrase).split(' ').filter((w) => w && !FILLER.has(w));
  if (!pw.length) return false;
  const tw = new Set(norm(text).split(' '));
  return pw.filter((w) => tw.has(w)).length / pw.length >= 0.6;
}
const CUE = {
  clipSpeed: () => B(W('speed', 'slow motion', 'slowmo', 'slow-mo', 'fast forward', 'स्पीड', 'स्लो मोशन')),
  first: () => B(FIRST), last: () => B(LAST),
  keepSound: () => B(W('original', 'natural', 'ambience', 'ambient', 'clip ki', 'apni awaaz', 'asli', 'live sound')),
  musicVolume: () => B(MUSIC), noMusic: () => B(MUSIC), noVoiceOver: () => B(VO),
};
function llmValue(k, v) {
  const s = String(v ?? '').trim();
  if (ALLOWED.bools.includes(k) || ['noMusic', 'noVoiceOver', 'endsOnLogo'].includes(k)) return /^(true|yes|on|1)$/i.test(s) ? true : /^(false|no|off|0)$/i.test(s) ? false : undefined;
  if (k === 'target') { const n = Math.round(parseFloat(s)); return n >= 5 && n <= 900 ? n : undefined; }
  if (k === 'clipSpeed') { const n = parseFloat(s); return ALLOWED.clipSpeed.includes(n) ? n : undefined; }
  if (k === 'musicVolume') { let n = parseFloat(s); if (/%$/.test(s) || n > 1) n /= 100; return n >= 0 && n <= 1 ? Math.round(n * 100) / 100 : undefined; }
  if (k === 'look') { if (/^(none|no|off)$/i.test(s)) return ''; return LOOKS.find((x) => x.toLowerCase() === s.toLowerCase()); }
  if (k === 'keep') return ['all', 'shots', 'none'].includes(s) ? s : undefined;
  if (ALLOWED[k]) return ALLOWED[k].find((x) => String(x).toLowerCase() === s.toLowerCase());
  if (['title', 'endText', 'first', 'last'].includes(k)) return s && s.length <= 60 ? s : undefined;
  return undefined;
}
function mergeLLM(res, a, ctx, leftText) {
  if (!a || typeof a !== 'object') return false;
  let used = false;
  const C = res.constraints, people = asPeople(ctx.people);
  const put = (k, v) => {
    if (k in res.opts || res.changes.some((x) => x.key === k)) return; // the rules' answer stays
    const from = ctx.opts[k];
    if (k in ctx.opts && (from ?? null) === (v ?? null)) return;
    res.opts[k] = v; used = true;
    const label = `${KEY_L[k] || k}: ${from === undefined ? '' : `${show(k, from, ctx.media)} to `}${show(k, v, ctx.media)}`;
    res.changes.push({ key: k, from: from ?? null, to: v, label }); res.understood.push(`${label}.`);
  };
  for (const x of Array.isArray(a.settings) ? a.settings.slice(0, 6) : []) {
    if (!x || !LLM_KEYS.includes(x.key) || typeof x.phrase !== 'string' || !grounded(x.phrase, leftText)) continue;
    if (CUE[x.key] && !CUE[x.key]().test(norm(leftText))) continue;
    const k = x.key, v = llmValue(k, x.value);
    if (v === undefined) continue;
    if (k === 'noMusic') { if (v) put('music', null); continue; }
    if (k === 'noVoiceOver') { if (v) put('vo', null); continue; }
    if (k === 'first' || k === 'last') {
      if (C[k]) continue;
      const who = mentioned(abbr(`${v} ${x.phrase}`), people);
      C[k] = who.length ? { person: who[0].name, ...(who[0].key ? { personKey: who[0].key } : {}) } : { text: v };
      res.understood.push(`${k === 'first' ? 'Starts' : 'Ends'} with ${who.length ? `a shot of ${who[0].name}` : v}.`); used = true; continue;
    }
    if (k === 'endsOnLogo') { if (v && !C.last?.logo) { C.last = { ...(C.last || {}), logo: (ctx.media || []).find((m) => /logo/i.test(m.name) && m.kind === 'image')?.id || true }; res.understood.push('Ends on the logo.'); used = true; } continue; }
    if (k === 'musicVolume') {
      if (C.musicVolume !== undefined) continue;
      C.musicVolume = v; used = true; res.understood.push(`Music volume ${Math.round(v * 100)}%.`);
      res.changes.push({ key: 'musicVolume', from: ctx.opts.musicVolume ?? null, to: v, label: `Music volume: ${Math.round(v * 100)}%` }); continue;
    }
    if (k === 'keep') { if (!C.keep || (ctx.mode === 'reedit' && !res.keepSaid)) { C.keep = v; used = true; } continue; }
    put(k, v);
  }
  // the LLM's clearer wording of what no setting can do replaces the raw leftover clauses
  if (Array.isArray(a.notes)) {
    const n = a.notes.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 4);
    if (n.length) { res.notes = [...res.notes.filter((x) => !res.left.includes(x)), ...n]; used = true; }
  }
  return used;
}

// rules, then the LLM for what is left (when installed). ctx.llm: false = rules only; ctx.timeoutMs: the LLM's limit
// (20 s by default; the first call also loads the model, ~5-30 s). Any LLM failure or timeout = the rules' answer.
export async function parseIntent(text, ctx = {}) {
  const t0 = performance.now();
  const res = parseRules(text, ctx);
  res.ms = { rules: +(performance.now() - t0).toFixed(2) };
  const left = res.left;
  if (ctx.llm !== false && left.length) {
    let llm = null;
    try { llm = await import('./llm.mjs'); } catch {}
    if (llm?.available()) {
      const c = { mode: ctx.mode || 'new', opts: ctx.opts || {}, media: ctx.media || [], people: ctx.people || [] };
      const t1 = performance.now(), ms = ctx.timeoutMs || 20000;
      const job = llm.json(llmPrompt(left, String(text), c), LLM_SCHEMA, { system: LLM_SYSTEM, maxTokens: 300, timeoutMs: ms, temperature: 0 });
      const a = await Promise.race([job, new Promise((ok) => setTimeout(() => ok(null), ms + 500))]).catch(() => null);
      res.ms.llm = Math.round(performance.now() - t1);
      if (mergeLLM(res, a, c, left.join(' '))) res.via = 'llm';
      else if (!a) res.llmError = llm.lastError() || 'timeout';
    }
  }
  delete res.left; delete res.keepSaid;
  res.understood = [...new Set(res.understood)];
  return res;
}
