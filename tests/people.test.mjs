// 🧑 engine/people.mjs: a VO line naming someone (Hindi / Hinglish / English, with or without "ji" / "sahab") finds
// that person; words on a banner are found from a search typed in another script.
import { test, eq as same } from './harness.mjs';
import { mentioned, textHits, label } from '../engine/people.mjs';

const lib = [{ id: 'h1', name: 'CM Sahab', aliases: ['Vishnu Deo Sai', 'मुख्यमंत्री'] }];
const people = [{ key: 'h1', name: 'CM Sahab', libId: 'h1', media: {} }, { key: 'p2', name: 'Rahul', media: {} }, { key: 'p3', name: null, media: {} }];
const who = (t) => mentioned(t, people, lib).map((p) => p.key);

test('a line names a person by name, other name or Hindi title', () => {
  same(who('मुख्यमंत्री विष्णु देव साय जी ने कहा'), ['h1']);
  same(who('CM sahab ne kaha ki'), ['h1']);
  same(who('Mukhyamantree ne udghatan kiya'), ['h1']);
  same(who('Vishnu Deo Sai addressed the crowd'), ['h1']);
  same(who('Rahul ji aaye'), ['p2']);
});
test('no person for lines that only look alike', () => {
  same(who('rahulgandhi'), []);
  same(who('sahab'), []);
  same(who(''), []);
});
test('text on the footage: Hindi banner found from Roman words, English as typed', () => {
  const text = { a: [{ t: 3, text: 'लोक सेवा गारंटी' }], b: [{ t: 1, text: 'GOOD GOVERNANCE' }, { t: 5, text: 'DEPARTMENT OF' }] };
  same(textHits('lok seva dikhao', text).map((h) => h.id), ['a']);
  same(textHits('good governance', text).map((h) => [h.id, h.t]), [['b', 1]]);
  same(textHits('waterfall', text), []);
});
test('unnamed people are "Person N"', () => { same(label(people[2]), 'Person 3'); same(label(people[0]), 'CM Sahab'); });

// 🎬 the timeline's In / Out (public/js/model.js rangeOf)
import { rangeOf } from '../public/js/model.js';
test('In / Out: both, only In, only Out, none or the whole length', () => {
  const pr = (range) => ({ settings: { range } });
  same(rangeOf(pr({ in: 2, out: 5 }), 10), { in: 2, out: 5 });
  same(rangeOf(pr({ in: 4 }), 10), { in: 4, out: 10 });
  same(rangeOf(pr({ out: 3 }), 10), { in: 0, out: 3 });
  same(rangeOf(pr({ in: 0, out: 10 }), 10), null);
  same(rangeOf(pr(undefined), 10), null);
  same(rangeOf(pr({ in: 9, out: 30 }), 10), { in: 9, out: 10 });
});
