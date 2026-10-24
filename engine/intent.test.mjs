// node engine/intent.test.mjs - self-test of the rules in intent.mjs (Hindi, Hinglish, English, mixed). No LLM.
import { parseRules } from './intent.mjs';

const OPTS = { aspect: '16:9', target: 60, pace: 'medium', editStyle: 'standard', look: 'Teal & Orange', subtitles: false, fx: true, sfx: true,
  cinematic: false, music: 'm1', vo: 'v1', clipSpeed: 1, style: 'cuts', musicBest: true, keepSound: false, stabilize: false, autoColor: true, voLang: 'hi', title: '', endText: '' };
const MEDIA = [{ id: 'm1', name: 'Sirpur Theme.mp3', kind: 'audio' }, { id: 'm2', name: 'Barish Song.mp3', kind: 'audio' }, { id: 'v1', name: 'VO final.wav', kind: 'audio' },
  { id: 'lg', name: 'MyBharat Logo.png', kind: 'image' }, { id: 'd12', name: 'DJI_0012.MP4', kind: 'video' }, { id: 'c7', name: 'Temple Aarti.mp4', kind: 'video' }];
const PEOPLE = [{ key: 'p1', name: 'CM Sahab' }, { key: 'p2', name: 'Vishnu Deo Sai' }, 'Collector Madam'];

// o: opts subset, c: constraints subset, no: opts keys that must NOT be set, notes: number of notes (exact), new: mode 'new'
const CASES = [
  // length
  { t: '30 sec ki reel', o: { target: 30, aspect: '9:16' } },
  { t: '1 minute', o: {}, no: ['target'] }, // already 60
  { t: '2 minute ka video', o: { target: 120 } },
  { t: 'isko chhota karo, 15 second kar do', o: { target: 15 } },
  { t: 'isko chhota karo', o: { target: 45 } },
  { t: 'thoda lamba karo', o: { target: 90 } },
  { t: 'tees second', o: { target: 30 } },
  { t: 'ek minute ka', o: {}, no: ['target'] },
  { t: 'dedh minute ka bana do', o: { target: 90 } },
  { t: 'तीस सेकंड की रील बनाओ', o: { target: 30, aspect: '9:16' } },
  { t: 'पंद्रह सेकंड का बनाओ', o: { target: 15 } },
  { t: 'make it 2 minutes, slower, with dissolves', o: { target: 120, pace: 'slow', style: 'cinematic' } },
  { t: '1:30 ka edit', o: { target: 90 } },
  { t: 'forty five seconds', o: { target: 45 } },
  // pace / speed
  { t: 'tez cuts', o: { pace: 'fast' } },
  { t: 'slow', o: { pace: 'slow' } },
  { t: 'dheema karo', o: { pace: 'slow' } },
  { t: 'bahut slow hai', o: { pace: 'fast' } },
  { t: 'har 2 second mein cut', o: { pace: 'fast' } },
  { t: 'slow motion mein', o: { clipSpeed: 0.5 }, no: ['pace'] },
  { t: '2x speed', o: { clipSpeed: 2 } },
  { t: 'तेज़ कट्स चाहिए', o: { pace: 'fast' } },
  // music
  { t: 'music dheema karo', o: {}, c: { musicVolume: 0.5 }, no: ['pace'] },
  { t: 'म्यूजिक धीमा करो', c: { musicVolume: 0.5 }, no: ['pace'] },
  { t: 'music thoda kam', c: { musicVolume: 0.7 } },
  { t: 'music 30% kar do', c: { musicVolume: 0.3 } },
  { t: 'music hata do', o: { music: null } },
  { t: 'संगीत हटा दो', o: { music: null } },
  { t: 'music badlo Barish Song wala', o: { music: 'm2' } },
  { t: 'sab same rakho bas music badlo', c: { keep: 'all' }, notes: 1 },
  { t: 'poora gaana use karo', o: { songPart: 'full' } },
  // voice-over / subtitles
  { t: 'VO nahi', o: { vo: null } },
  { t: 'वीओ नहीं चाहिए', o: { vo: null } },
  { t: 'VO english mein hai', o: { voLang: 'en' } },
  { t: 'subtitles daal do', o: { subtitles: true } },
  { t: 'सबटाइटल डाल दो', o: { subtitles: true } },
  { t: 'no subtitles please', no: ['subtitles'] }, // already off
  // format
  { t: '9:16', o: { aspect: '9:16' } },
  { t: 'square bana do', o: { aspect: '1:1' } },
  { t: 'instagram reel', o: { aspect: '9:16' } },
  { t: 'instagram post ke liye', o: { aspect: '4:5' } },
  { t: 'youtube shorts', o: { aspect: '9:16' } },
  { t: 'youtube ke liye 16:9', no: ['aspect'] },
  // style
  { t: 'teaser jaisa', o: { editStyle: 'teaser' } },
  { t: 'teaser jaisa', new: true, o: { editStyle: 'teaser', pace: 'fast', cinematic: true, target: 45 } },
  { t: 'song ke hisaab se', o: { editStyle: 'song' }, no: ['music'] },
  { t: 'documentary', o: { pace: 'slow' } },
  { t: 'har beat pe cut, montage', o: { editStyle: 'montage' } },
  // look
  { t: 'colour warm', o: { look: 'Warm Film' } },
  { t: 'teal orange', no: ['look'] }, // already
  { t: 'black and white', o: { look: 'Bleach Bypass' }, notes: 1 },
  { t: 'रंग गर्म करो', o: { look: 'Warm Film' } },
  { t: 'golden hour look chahiye', o: { look: 'Golden Hour' } },
  { t: 'colour mat chhedo', no: ['look'] },
  { t: 'teal orange nahi chahiye', o: { look: '' } },
  // effects / finish
  { t: 'effects kam karo', o: { fx: false } },
  { t: 'effects zyada', no: ['fx'] }, // already on
  { t: 'इफेक्ट्स कम करो', o: { fx: false } },
  { t: 'sound effects hata do', o: { sfx: false }, no: ['fx'] },
  { t: 'cinematic bana do', o: { cinematic: true } },
  { t: 'shaky shots stabilize karo', o: { stabilize: true } },
  { t: 'natural sound rakho', o: { keepSound: true } },
  { t: 'dissolve transitions daalo', o: { style: 'cinematic' } },
  // first / last
  { t: 'pehle CM sahab ka shot', c: { first: { person: 'CM Sahab' } } },
  { t: 'पहले सीएम साहब का शॉट', c: { first: { person: 'CM Sahab' } } },
  { t: 'pehle 5 sec mein CM sahab ka shot', c: { first: { person: 'CM Sahab', within: 5 } }, no: ['target'] },
  { t: 'shuru mein drone shot', c: { first: { text: 'drone' } } },
  { t: 'drone shot se shuru karo', c: { first: { text: 'drone' } } },
  { t: 'start with Vishnu Deo Sai ji', c: { first: { person: 'Vishnu Deo Sai' } } },
  { t: 'end mein logo', c: { last: { logo: 'lg' } } },
  { t: 'अंत में लोगो', c: { last: { logo: 'lg' } } },
  { t: 'aakhir mein thank you', o: { endText: 'Thank You' }, c: { last: { text: 'Thank You' } } },
  { t: 'end mein logo aur thank you', c: { last: { logo: 'lg', text: 'Thank You' } } },
  { t: 'end card pe mygov.in likho', o: { endText: 'mygov.in' } },
  { t: "title 'Chhattisgarh ke Vyanjan' rakho", o: { title: 'Chhattisgarh ke Vyanjan' } },
  { t: 'DJI_0012 zaroor daalo', c: { must: ['d12'] } },
  { t: 'Temple Aarti wala clip mat use karo', c: { avoid: ['c7'] } },
  // keep
  { t: 'shots same rakho, sirf colour warm', o: { look: 'Warm Film' }, c: { keep: 'shots' } },
  { t: 'naya edit banao', c: { keep: 'none' } },
  { t: 'colour warm karo', c: { keep: 'all' } }, // finish-only change: every shot stays
  // mixed
  { t: 'मुझे 1 मिनट का यूट्यूब वीडियो चाहिए, संगीत धीमा और सबटाइटल के साथ', o: { subtitles: true }, c: { musicVolume: 0.5 }, notes: 0 },
  { t: 'fast cuts aur teal orange look, 45 second', o: { pace: 'fast', target: 45 } },
  { t: 'reel bana do 20 sec ki, captions ke saath, music thoda tez', o: { aspect: '9:16', target: 20, subtitles: true }, c: { musicVolume: 0.9 } },
  { t: 'Make it a 30 second vertical reel with warm colours and no effects', o: { aspect: '9:16', target: 30, look: 'Warm Film', fx: false } },
  // leftovers go to notes
  { t: 'logon ki khushi zyada dikhao', notes: 1 },
  { t: 'opening slow hai, pehle 10 sec tight karo', o: { pace: 'fast' }, c: { scope: { kind: 'range', from: 0, to: 10 } }, no: ['target'], notes: 1 },
  // re-edit scope (ADDENDUM 1): timecodes, Hinglish / Hindi ranges, shots by number, the selection; combined with changes
  { t: '0:10 se 0:25 tak tez karo', o: { pace: 'fast' }, c: { scope: { kind: 'range', from: 10, to: 25 } }, no: ['target'] },
  { t: '10 se 20 second slow karo', o: { pace: 'slow' }, c: { scope: { kind: 'range', from: 10, to: 20 } }, no: ['target'] },
  { t: '1:10 to 1:30 colour warm', o: { look: 'Warm Film' }, c: { scope: { kind: 'range', from: 70, to: 90 } } },
  { t: '0:10-0:25 music dheema', c: { scope: { kind: 'range', from: 10, to: 25 }, musicVolume: 0.5 } },
  { t: '1:05:10 se 1:05:20 tak', c: { scope: { kind: 'range', from: 3910, to: 3920 } } }, // h:mm:ss
  { t: '00:10:12 se 00:20:00 tak', c: { scope: { kind: 'range', from: 10.48, to: 20 } } }, // mm:ss:ff at 25 fps
  { t: '1 min 20 sec se 1 min 40 sec tak dissolve daalo', o: { style: 'cinematic' }, c: { scope: { kind: 'range', from: 80, to: 100 } } },
  { t: 'पहले 5 सेकंड तेज़ करो', o: { pace: 'fast' }, c: { scope: { kind: 'range', from: 0, to: 5 } }, no: ['target'] },
  { t: 'pehle 5 sec tight karo', o: { pace: 'fast' }, c: { scope: { kind: 'range', from: 0, to: 5 } } },
  { t: 'aakhri 10 second mein colour warm', o: { look: 'Warm Film' }, c: { scope: { kind: 'range', from: 50, to: 60, fromEnd: 10 } } },
  { t: 'last 10 sec slow motion', o: { clipSpeed: 0.5 }, c: { scope: { kind: 'range', from: 50, to: 60 } } },
  { t: 'beech wala hissa tez karo', o: { pace: 'fast' }, c: { scope: { kind: 'range', from: 20, to: 40 } } },
  { t: 'teesra shot badlo', c: { scope: { kind: 'slots', index: [2] } }, notes: 0 },
  { t: 'तीसरा शॉट बदलो', c: { scope: { kind: 'slots', index: [2] } }, notes: 0 },
  { t: 'shot 3 ko slow motion karo', o: { clipSpeed: 0.5 }, c: { scope: { kind: 'slots', index: [2] } } },
  { t: '3rd clip ka colour warm', o: { look: 'Warm Film' }, c: { scope: { kind: 'slots', index: [2] } } },
  { t: 'shot number 5 badlo', c: { scope: { kind: 'slots', index: [4] } } },
  { t: 'shots 2-4 dobara chuno', c: { scope: { kind: 'slots', index: [1, 2, 3] } } },
  { t: 'pehla shot badlo', c: { scope: { kind: 'slots', index: [0] } }, notes: 0 },
  { t: 'shot 3 hata do', c: { scope: { kind: 'slots', index: [2] } }, notes: 1 },
  { t: 'ye clip badlo', c: { scope: { kind: 'clips', ids: [] } }, notes: 0 },
  { t: 'selected clips ka colour warm karo', o: { look: 'Warm Film' }, c: { scope: { kind: 'clips', ids: [] } } },
  { t: 'is clip ko slow motion mein', o: { clipSpeed: 0.5 }, c: { scope: { kind: 'clips', ids: [] } } },
  { t: 'इस क्लिप को धीमा करो', o: { pace: 'slow' }, c: { scope: { kind: 'clips', ids: [] } } },
  { t: 'music dheema karo', c: { scope: { kind: 'all' } } }, // no scope said: the whole edit
  { t: '10 se 20 second', new: true, no: [] }, // a new edit has no scope
  { t: '1 min 20 sec ka video', o: { target: 80 } },
  // notes: a leftover clause in its own words, trimmed at the ends only; empty when everything was understood
  { t: '30 sec ka reel banao, tez cuts', new: true, o: { target: 30, aspect: '9:16', pace: 'fast' }, nt: [] },
  { t: 'ek 30 second ki reel banao please', new: true, o: { target: 30, aspect: '9:16' }, nt: [] },
  { t: 'music dheema karo aur subtitles daal do', c: { musicVolume: 0.5 }, o: { subtitles: true }, nt: [] },
  { t: 'तीस सेकंड की रील बनाओ और म्यूजिक धीमा करो', o: { target: 30 }, c: { musicVolume: 0.5 }, nt: [] },
  { t: 'please isko thoda tez kar do yaar', o: { pace: 'fast' }, nt: [] },
  { t: '30 sec ki reel, logon ki khushi dikhao', o: { target: 30 }, nt: ['logon ki khushi dikhao'] },
  { t: 'tez cuts aur gaon ka mela zyada dikhao', o: { pace: 'fast' }, nt: ['gaon ka mela zyada dikhao'] },
  { t: 'colour warm karo, opening mein suspense', o: { look: 'Warm Film' }, nt: ['opening mein suspense'] },
  { t: 'shuruat mein thoda suspense rakho', nt: ['shuruat mein thoda suspense rakho'] },
  { t: '30 sec ki reel mein logon ki khushi dikhao please', o: { target: 30 }, nt: ['logon ki khushi dikhao'] },
  { t: 'aur bacchon wale shots zyada dikhao kar do', nt: ['bacchon wale shots zyada dikhao'] },
  { t: 'बच्चों वाले शॉट्स ज़्यादा दिखाओ', nt: ['बच्चों वाले शॉट्स ज़्यादा दिखाओ'] },
  { t: 'kar do please', nt: [] },
  // praise / mood is never a first / last / must shot
  { t: '30 sec ka reel banao, tez cuts, end mein logo, ekdum mast lagna chahiye', new: true, o: { target: 30, aspect: '9:16', pace: 'fast' }, c: { last: { logo: 'lg' } }, nt: ['ekdum mast lagna chahiye'], noc: ['first', 'must'], nolast: ['text'] },
  { t: 'end mein ekdum mast lagna chahiye', noc: ['last'], notes: 1 },
  { t: 'shuru mein badhiya lagna chahiye', noc: ['first'], notes: 1 },
  { t: 'pehle jhakkas', noc: ['first'], notes: 1 },
  { t: 'aakhir mein zabardast banana', noc: ['last'], notes: 1 },
  { t: 'start mein accha lage', noc: ['first'], notes: 1 },
  { t: 'अंत में एकदम शानदार लगना चाहिए', noc: ['last'], notes: 1 },
  { t: 'zabardast banana, accha lage', noc: ['first', 'last', 'must'], notes: 2 },
  { t: 'end mein logo accha lage', c: { last: { logo: 'lg' } }, nolast: ['text'] },
  { t: 'pehle drone shot, ekdum mast', c: { first: { text: 'drone' } }, nt: ['ekdum mast'] },
  { t: 'jhakkas banao, end mein CM sahab', c: { last: { person: 'CM Sahab' } }, noc: ['first'] },
  { t: 'climax pe sab tez', no: ['pace'], notes: 1 },
  { t: 'pehle khet aur kisaan dikhao, beech mein mandi, aakhir mein khush parivaar', c: { first: { text: 'khet, kisaan' }, last: { text: 'khush parivaar' } }, notes: 1 },
  { t: 'shuruat mein thoda suspense rakho', notes: 1 }, // a mood, not a first shot
  { t: 'pehle se zyada tez', o: { pace: 'fast' }, notes: 0 },
];

const sub = (a, b) => (b && typeof b === 'object' && !Array.isArray(b) ? Object.entries(b).every(([k, v]) => a && sub(a[k], v)) : JSON.stringify(a) === JSON.stringify(b));
let pass = 0, fail = 0;
const t0 = performance.now();
for (const k of CASES) {
  const r = parseRules(k.t, { mode: k.new ? 'new' : 'reedit', opts: OPTS, media: MEDIA, people: PEOPLE });
  const bad = [];
  if (k.o && !sub(r.opts, k.o)) bad.push(`opts ${JSON.stringify(r.opts)} != ${JSON.stringify(k.o)}`);
  if (k.c && !sub(r.constraints, k.c)) bad.push(`constraints ${JSON.stringify(r.constraints)} != ${JSON.stringify(k.c)}`);
  for (const n of k.no || []) if (n in r.opts) bad.push(`${n} should not be set (${JSON.stringify(r.opts[n])})`);
  for (const n of k.noc || []) if (n in r.constraints) bad.push(`constraint ${n} should not be set (${JSON.stringify(r.constraints[n])})`);
  for (const n of k.nolast || []) if (r.constraints.last && n in r.constraints.last) bad.push(`last.${n} should not be set (${JSON.stringify(r.constraints.last[n])})`);
  if (k.nt !== undefined && JSON.stringify(r.notes) !== JSON.stringify(k.nt)) bad.push(`notes ${JSON.stringify(r.notes)} != ${JSON.stringify(k.nt)}`);
  if (k.notes !== undefined && r.notes.length !== k.notes) bad.push(`notes ${JSON.stringify(r.notes)} (want ${k.notes})`);
  if (bad.length) { fail++; console.log(`FAIL  ${k.t}\n      ${bad.join('\n      ')}\n      understood: ${r.understood.join(' | ')}`); } else pass++;
}
const ms = performance.now() - t0;
// speed: a long mixed brief, many times
const long = 'pehle 5 sec mein CM sahab ka shot, phir tez cuts, music dheema karo, colour warm, subtitles daal do, 45 second ki reel, end mein logo aur thank you';
const t1 = performance.now(); for (let i = 0; i < 200; i++) parseRules(long, { mode: 'reedit', opts: OPTS, media: MEDIA, people: PEOPLE });
const per = (performance.now() - t1) / 200;
console.log(`\n${pass} passed, ${fail} failed of ${CASES.length} (${(ms / CASES.length).toFixed(2)} ms per case; long brief ${per.toFixed(2)} ms)`);
if (per > 5) { console.log('TOO SLOW: over 5 ms'); fail++; }
process.exit(fail ? 1 : 0);
