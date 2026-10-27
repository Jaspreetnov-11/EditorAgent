// 🔢 numbers in a Hindi script as spoken words, for the same-voice model (VoiceVerse): it reads "02 नवंबर 2026" or
// "11 बजे" badly or skips them, but says "दो नवंबर दो हज़ार छब्बीस" / "ग्यारह बजे" well. Only what the voice says changes;
// the subtitles keep the digits as written.
const UPTO99 = ('शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस '
  + 'छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चवालीस '
  + 'पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ '
  + 'छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी अस्सी इक्यासी बयासी तिरासी '
  + 'चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानबे बानबे तिरानबे चौरानबे पचानबे छियानबे सत्तानबे अट्ठानबे निन्यानबे').split(' ');

// a whole number (Indian grouping: हज़ार, लाख, करोड़) in words; null when too big to say well
export function hindiWords(n) {
  if (!Number.isInteger(n) || n < 0 || n >= 1e11) return null;
  if (n < 100) return UPTO99[n];
  const out = [];
  for (const [unit, w] of [[1e7, 'करोड़'], [1e5, 'लाख'], [1e3, 'हज़ार'], [100, 'सौ']]) {
    if (n >= unit) { out.push(`${hindiWords(Math.floor(n / unit))} ${w}`); n %= unit; }
  }
  if (n) out.push(UPTO99[n]);
  return out.join(' ');
}

// every number in the text as words: Devanagari digits too, 1,00,000 / 25,000 groupings, decimals (दशमलव), times (11:30)
export function speakHindiNumbers(text) {
  return String(text)
    .replace(/[०-९]/g, (d) => String('०१२३४५६७८९'.indexOf(d)))
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h, mm) => `${hindiWords(+h)} बजकर ${hindiWords(+mm)} मिनट`)
    .replace(/\d{1,3}(?:,\d{2,3})+(?!\d)|\d+(?:\.\d+)?/g, (m) => {
      const [whole, frac] = m.replace(/,/g, '').split('.');
      const w = hindiWords(+whole);
      if (w === null) return m;
      return frac ? `${w} दशमलव ${[...frac].map((d) => UPTO99[+d]).join(' ')}` : w;
    });
}
