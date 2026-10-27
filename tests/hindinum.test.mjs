// 🔢 VoiceVerse: numbers in Hindi text become words the voice says well
import { test, eq as same } from './harness.mjs';
import { hindiWords, speakHindiNumbers } from '../engine/hindinum.mjs';

test('whole numbers: 0-99 by name, then सौ / हज़ार / लाख / करोड़', () => {
  same(hindiWords(0), 'शून्य');
  same(hindiWords(2), 'दो');
  same(hindiWords(26), 'छब्बीस');
  same(hindiWords(99), 'निन्यानबे');
  same(hindiWords(105), 'एक सौ पाँच');
  same(hindiWords(2026), 'दो हज़ार छब्बीस');
  same(hindiWords(150000), 'एक लाख पचास हज़ार');
  same(hindiWords(12500000), 'एक करोड़ पच्चीस लाख');
});

test('a voice-over line: dates, times, groupings, decimals, Devanagari digits; words stay', () => {
  same(speakHindiNumbers('दिनांक: 02 नवंबर 2026'), 'दिनांक: दो नवंबर दो हज़ार छब्बीस');
  same(speakHindiNumbers('सुबह 11 बजे से दोपहर 1 बजे तक'), 'सुबह ग्यारह बजे से दोपहर एक बजे तक');
  same(speakHindiNumbers('10:30 बजे'), 'दस बजकर तीस मिनट बजे');
  same(speakHindiNumbers('1,00,000 लोग'), 'एक लाख लोग');
  same(speakHindiNumbers('2.5 किलो'), 'दो दशमलव पाँच किलो');
  same(speakHindiNumbers('२०२६ में'), 'दो हज़ार छब्बीस में');
  same(speakHindiNumbers('सेंध लेक, नवा रायपुर'), 'सेंध लेक, नवा रायपुर');
});
