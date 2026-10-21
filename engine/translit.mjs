// Roman <-> Devanagari matching for scripts. A Hinglish script ("Bastar... jahan jungle sirf jungle nahi") and the
// recording heard as Hindi ("बस्तर जहां जंगल सिर्फ जंगल नहीं") must be recognised as the same words: both are turned into
// one rough Roman sound-key (Devanagari transliterated, then spellings that sound alike folded together).
const CONS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'ळ': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h', 'क़': 'k', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'फ़': 'f', 'ड़': 'r', 'ढ़': 'rh', 'य़': 'y',
};
const VOW = { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e' };
const MATRA = { 'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e' };
const NUKTA = '़', HALANT = '्';

// Devanagari -> Roman (Hinglish-style). Other characters pass through.
export function toRoman(text) {
  const s = String(text || '').normalize('NFC');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (s[i + 1] === NUKTA && CONS[ch + NUKTA]) { ch += NUKTA; i++; }
    if (CONS[ch]) {
      out += CONS[ch];
      const nx = s[i + 1];
      if (nx === HALANT) { i++; continue; }
      if (MATRA[nx]) { out += MATRA[nx]; i++; continue; }
      // inherent "a" - dropped at the end of a word (बस्तर -> bastar, not bastara)
      if (!(nx === undefined || /[\s.,!?।॥"'“”‘’()\-–—…:;]/.test(nx))) out += 'a';
      continue;
    }
    if (VOW[ch]) { out += VOW[ch]; continue; }
    if (ch === 'ं' || ch === 'ँ') { out += 'n'; continue; }
    if (ch === 'ः') { out += 'h'; continue; }
    if (ch === NUKTA || ch === HALANT) continue;
    if (ch === '।' || ch === '॥') { out += '.'; continue; }
    out += ch;
  }
  return out;
}

// A sound-key: Roman, lower case, letters only; aspiration (h after a consonant), long vowels, doubled letters and
// common spelling swaps (w/v, z/j, f/ph, q/k, ee/i, oo/u, ai/e, au/o) are folded so "nahi" = "nahin" = "नहीं".
export function soundKey(text) {
  return toRoman(String(text || '').replace(/\*+|[_#`]/g, ''))
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]+/g, ' ')
    .replace(/ph/g, 'f').replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/c(?!h)/g, 'k')
    .replace(/([bcdfgjklmnprstvy])h/g, '$1')
    .replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/ai|ay/g, 'e').replace(/au|aw/g, 'o').replace(/aa/g, 'a')
    .replace(/n(?=[\s]|$)/g, '') // nasal endings: nahin = nahi, mein = mei
    .replace(/(.)\1+/g, '$1')
    .replace(/\s+/g, ' ').trim();
}
