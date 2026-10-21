// searchwords.mjs - footage search typed in Hindi / Hinglish ("jharna dikhao", "पहाड़ पर बादल") -> English words for
// the picture model (CLIP only knows English). Devanagari is first written in Roman letters (translit.mjs), then each
// word is looked up; command words ("dikhao", "wala") are dropped and English words pass through unchanged.
import { toRoman } from './translit.mjs';

const WORDS = {
  jharna: 'waterfall', jharne: 'waterfall', jharno: 'waterfalls', prapat: 'waterfall', nadi: 'river', nadiya: 'rivers', nala: 'stream', jheel: 'lake', talab: 'pond',
  samundar: 'sea', samudra: 'sea', sagar: 'sea', paani: 'water', pani: 'water', baarish: 'rain', barish: 'rain', baadal: 'clouds', badal: 'clouds', aasman: 'sky', asman: 'sky', akash: 'sky',
  suraj: 'sun', sooraj: 'sun', surya: 'sun', chand: 'moon', chaand: 'moon', taare: 'stars', tare: 'stars', suryoday: 'sunrise', suryast: 'sunset', subah: 'morning', shaam: 'evening', sham: 'evening', raat: 'night', rat: 'night', din: 'day',
  pahad: 'mountain', pahar: 'mountain', parvat: 'mountain', pahadi: 'hills', ghati: 'valley', jungle: 'forest', jangal: 'forest', van: 'forest', ped: 'tree', pedh: 'tree', perd: 'tree', patte: 'leaves', phool: 'flowers', phul: 'flowers', ghaas: 'grass', ghas: 'grass',
  khet: 'farm field', kheti: 'farming', fasal: 'crops', dhaan: 'rice field', gehu: 'wheat', kisan: 'farmer', kisaan: 'farmer', gaay: 'cow', gay: 'cow', bail: 'bullock', bakri: 'goat', haathi: 'elephant', hathi: 'elephant', sher: 'tiger', bagh: 'tiger', chidiya: 'bird', pakshi: 'bird', machhli: 'fish', kutta: 'dog', ghoda: 'horse',
  gaon: 'village', gaanv: 'village', gav: 'village', shehar: 'city', sheher: 'city', sadak: 'road', sarak: 'road', khelte: 'playing', khelate: 'playing', khelna: 'playing', nachte: 'dancing', nachate: 'dancing', chalte: 'walking', chalate: 'walking', daudte: 'running', daudate: 'running', rasta: 'road', gali: 'street', pul: 'bridge', ghar: 'house', makaan: 'house', mandir: 'temple', masjid: 'mosque', gurudwara: 'gurudwara', girja: 'church', kila: 'fort', mahal: 'palace',
  bazaar: 'market', bazar: 'market', dukaan: 'shop', school: 'school', vidyalaya: 'school', aspatal: 'hospital', daftar: 'office', kaksha: 'classroom', maidan: 'ground', stadium: 'stadium', manch: 'stage', sabha: 'meeting', railgadi: 'train', rail: 'train', gaadi: 'car', gadi: 'car', bus: 'bus', cycle: 'bicycle', naav: 'boat', nav: 'boat', jahaz: 'ship', hawai: 'airplane',
  log: 'people', bheed: 'crowd', bhid: 'crowd', aadmi: 'man', admi: 'man', aurat: 'woman', mahila: 'woman', mahilayen: 'women', ladka: 'boy', ladki: 'girl', bachche: 'children', bacche: 'children', bachcha: 'child', baccha: 'child', buzurg: 'old man', yuva: 'young people', naujawan: 'youth', chhatra: 'students', vidyarthi: 'students', neta: 'politician', mantri: 'minister', police: 'police', sena: 'army', jawan: 'soldier', khiladi: 'player',
  chehra: 'face', haath: 'hands', hath: 'hands', aankh: 'eyes', muskaan: 'smile', hasna: 'laughing', rona: 'crying', naach: 'dance', nach: 'dance', nritya: 'dance', gaana: 'singing', khel: 'sports', daud: 'running', daudna: 'running', chalna: 'walking', khana: 'food', bhojan: 'food', chai: 'tea', yoga: 'yoga', puja: 'prayer ritual', aarti: 'aarti fire ritual', diya: 'oil lamp', jhanda: 'flag', tiranga: 'indian flag',
  aag: 'fire', dhuan: 'smoke', dhool: 'dust', baraf: 'snow', barf: 'snow', registan: 'desert', ret: 'sand', pathar: 'rocks', patthar: 'rocks', gufa: 'cave', kinara: 'shore', tat: 'beach',
  upar: 'aerial view from above', drone: 'aerial drone shot', hawa: 'wind', tez: 'fast', dheere: 'slow', andhera: 'dark', roshni: 'lights', lal: 'red', hara: 'green', neela: 'blue', peela: 'yellow', safed: 'white', kala: 'black', bada: 'big', chhota: 'small', sundar: 'beautiful', purana: 'old',
};
// command / filler words to drop
const DROP = new Set('dikhao dikha dikhaao dikhaye dikhana dhoondo dhundo dhoondho khojo search find show me please wala wali wale ka ki ke ko se me mein men hue hua hui rahe raha rahi par pe aur ya hai hain tha the ek koi sab saare jahan jisme jis vala vali shot shots clip clips video'.split(' '));

// spellings that sound alike fold together (pahaar / pahar / pahad, nadee / nadi, vaala / wala)
const fold = (w) => w.replace(/aa/g, 'a').replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/w/g, 'v').replace(/r$/, 'd').replace(/([bcdfghjklmnpqrstvxyz])\1/g, '$1');
const FOLDED = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [fold(k), v]));
const DROPF = new Set([...DROP].map(fold));

export function toEnglishQuery(text) {
  const rom = toRoman(String(text || '')).toLowerCase().replace(/[^a-z\s-]/g, ' ');
  const out = [];
  for (const w of rom.split(/\s+/).filter(Boolean)) {
    if (DROP.has(w) || DROPF.has(fold(w))) continue;
    // Hindi plural / oblique endings: pahadon -> pahad, nadiyon -> nadi
    // Devanagari read letter by letter keeps the silent middle "a" (झरना -> jharanaa): try without it too
    const noSchwa = w.replace(/(?<=[aeiou][^aeiou\s]+)a(?=[^aeiou\s][aeiou])/g, '');
    const hit = [w, noSchwa, w.replace(/(iyon|iyan|on|en|o|e)$/, ''), w.replace(/(yon|yan)$/, '')].map((x) => WORDS[x] || FOLDED[fold(x)]).find(Boolean);
    out.push(hit || w);
  }
  return [...new Set(out)].join(' ').trim() || String(text || '').trim();
}
