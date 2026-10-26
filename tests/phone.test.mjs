// 📱 Phone / tablet: which layout a screen gets, the phone's timeline strip, the texts a clip has to type, pinch zoom.
import { test, eq as same, assert } from './harness.mjs';
import { deviceMode, stripRows, textFieldsOf, setText, pinchZoom, cuesAround } from '../public/js/phonecore.js';

test('a mouse always gets the desktop editor, however narrow the window', () => {
  same(deviceMode({ w: 1920, h: 1080, coarse: false }), 'desktop');
  same(deviceMode({ w: 380, h: 800, coarse: false }), 'desktop');
  same(deviceMode({ w: 1280, h: 400, coarse: false }), 'desktop');
});

test('a touch screen: phones (either way round) get the phone layout, tablets the full editor', () => {
  same(deviceMode({ w: 390, h: 844, coarse: true }), 'phone');
  same(deviceMode({ w: 844, h: 390, coarse: true }), 'phone', 'a phone held sideways');
  same(deviceMode({ w: 360, h: 640, coarse: true }), 'phone');
  same(deviceMode({ w: 768, h: 1024, coarse: true }), 'tablet');
  same(deviceMode({ w: 1024, h: 768, coarse: true }), 'tablet');
  same(deviceMode({ w: 1366, h: 1024, coarse: true }), 'tablet');
  same(deviceMode({ w: 744, h: 1133, coarse: true }), 'tablet', 'iPad mini');
});

test('the user\'s own pick wins (Desktop view on a phone, ?ui=tablet)', () => {
  same(deviceMode({ w: 390, h: 844, coarse: true, pick: 'desktop' }), 'desktop');
  same(deviceMode({ w: 1920, h: 1080, coarse: false, pick: 'phone' }), 'phone');
  same(deviceMode({ w: 390, h: 844, coarse: true, pick: 'nonsense' }), 'phone');
});

const lay = {
  V1: [{ clip: { id: 'a', type: 'video', mediaId: 'm' }, start: 0, end: 5 }, { clip: { id: 'g', gap: true }, start: 5, end: 6 }, { clip: { id: 'b', type: 'image' }, start: 6, end: 9 }],
  V2: [{ clip: { id: 't', type: 'title', text: 'Viksit Bharat' }, start: 1, end: 4 }],
  V3: [],
  V4: [{ clip: { id: 'x', type: 'graphic', gfx: { tpl: 'counter', title: 'Houses built' } }, start: 2, end: 6 }],
  A1: [{ clip: { id: 'm1', type: 'audio' }, start: 0, end: 9 }],
  A2: [],
};

test('strip rows: only tracks with clips, picture on top (highest first), V1 marked, sound below', () => {
  const r = stripRows(lay, 10);
  same(r.map((x) => x.track), ['V4', 'V2', 'V1', 'A1']);
  assert(r.find((x) => x.track === 'V1').main && r.find((x) => x.track === 'A1').sound);
  same(r.find((x) => x.track === 'V1').blocks.map((b) => b.id), ['a', 'b'], 'gaps are left out');
});

test('strip blocks: placed by seconds x zoom, never thinner than a finger can see, with what they are', () => {
  const v1 = stripRows(lay, 10).find((x) => x.track === 'V1').blocks;
  same([v1[0].left, v1[0].width, v1[1].left, v1[1].width], [0, 50, 60, 30]);
  same(stripRows({ V1: [{ clip: { id: 'z', type: 'video' }, start: 0, end: 0.01 }] }, 10)[0].blocks[0].width, 4);
  const r = stripRows(lay, 10);
  same(r.find((x) => x.track === 'V2').blocks[0].kind, 'text');
  same(r.find((x) => x.track === 'V2').blocks[0].label, 'Viksit Bharat');
  same(r.find((x) => x.track === 'V4').blocks[0].kind, 'graphic');
  same(r.find((x) => x.track === 'V4').blocks[0].label, 'Houses built');
  same(r.find((x) => x.track === 'A1').blocks[0].kind, 'audio');
  same(stripRows(null, 10), []);
});

test('texts to type: a title, a Type tool text, a graphic\'s text fields (not its numbers / looks)', () => {
  same(textFieldsOf({ type: 'title', text: 'Hello' }), [{ k: 'text', label: 'Text', value: 'Hello', multi: true }]);
  const tt = textFieldsOf({ type: 'graphic', gfx: { tpl: 'text', text: 'Phone se edit' } });
  same(tt.map((f) => [f.k, f.value]), [['text', 'Phone se edit']]);
  const fields = [{ k: 'value', type: 'num' }, { k: 'sub', label: 'Small line', type: 'text' }, { k: 'data', label: 'Points', type: 'area' }, { k: 'title', label: 'Heading', type: 'text' }, { k: 'theme', type: 'select' }];
  const g = textFieldsOf({ type: 'graphic', gfx: { tpl: 'list', title: 'What you get', data: 'a\nb' } }, fields);
  same(g.map((f) => [f.k, f.value, f.multi]), [['sub', '', false], ['data', 'a\nb', true], ['title', 'What you get', false]]);
  same(textFieldsOf({ type: 'video' }), []);
  same(textFieldsOf(null), []);
});

test('typing a text back: on the title itself, in a graphic\'s gfx; nothing changed = false', () => {
  const t = { type: 'title', text: 'A' };
  assert(setText(t, 'text', 'B') && t.text === 'B');
  assert(!setText(t, 'text', 'B'), 'same text: no change');
  const g = { type: 'graphic', gfx: { tpl: 'text', text: 'x' } };
  assert(setText(g, 'text', 'Naya') && g.gfx.text === 'Naya');
  assert(!setText({ type: 'graphic' }, 'text', 'y'), 'a graphic without gfx is left alone');
});

test('pinch: the zoom follows the fingers, within its limits', () => {
  same(pinchZoom(40, 100, 200, 4, 400), 80);
  same(pinchZoom(40, 100, 50, 4, 400), 20);
  same(pinchZoom(40, 100, 10000, 4, 400), 400);
  same(pinchZoom(40, 100, 1, 4, 400), 4);
  same(pinchZoom(40, 0, 50, 4, 400), 40, 'no distance yet: unchanged');
});

test('captions near the playhead: from just before what is heard now, at most n', () => {
  const cues = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, start: i, end: i + 1, text: `line ${i}` }));
  const a = cuesAround(cues, 50.5, 10);
  same(a.length, 10);
  same(a[0].id, 'c48');
  same(cuesAround(cues, 0, 5)[0].id, 'c0');
  same(cuesAround(cues, 99.5, 5).at(-1).id, 'c99', 'the end: the last ones');
  same(cuesAround(cues, 500, 5).length, 5);
  same(cuesAround([{ start: 0, end: 1 }, null], 0), [], 'only real cues');
  same(cuesAround(undefined, 3), []);
});

// 🖥 the desktop never changes: every rule of mobile.css is for a touch layout (html.phone / .tablet / .touch) or for
// the phone's own parts (.ph-…), which a desktop never shows
test('mobile.css touches nothing on a desktop', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../public/css/mobile.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const bad = [];
  // (commas at the top level only - not the ones inside :is( … ))
  const splitTop = (sel) => { const out = ['']; let d = 0; for (const ch of sel) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && !d) out.push(''); else out[out.length - 1] += ch; } return out.map((x) => x.trim()); };
  const walk = (s) => {
    let i = 0;
    while (i < s.length) {
      const o = s.indexOf('{', i); if (o < 0) break;
      const sel = s.slice(i, o).trim();
      let d = 1, j = o + 1; while (j < s.length && d) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; }
      const body = s.slice(o + 1, j - 1);
      if (/^@media/.test(sel)) walk(body);
      else if (!/^@keyframes/.test(sel)) for (const part of splitTop(sel)) if (!/^(html\.(phone|tablet|touch|picked-desktop)\b|\.ph-)/.test(part)) bad.push(part);
      i = j;
    }
  };
  walk(css);
  same(bad, []);
});
