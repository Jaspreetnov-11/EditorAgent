// 🏷 Client brand packs: a pack cleaned and saved, its files kept in its own folder, duplicate / delete, the old brand
// kit migrated once - and a pack applied to a project: a second pack replaces the first one's pieces, never stacks.
import { test, eq as same, assert } from './harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanPack, applyPack, packColors, PACK_DEFAULTS } from '../public/js/brandpack.js';
import { listPacks, readPack, savePack, setPackFile, packFile, duplicatePack, deletePack, migrateBrandKit } from '../engine/brandpacks.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-packs-'));
let n = 0;
const uid = () => `id${++n}`;
const project = () => ({ tracks: {
  V1: [{ id: 'a', type: 'video', mediaId: 'mA', in: 0, out: 4 }, { id: 'b', type: 'video', mediaId: 'mB', in: 0, out: 3 }],
  V2: [{ id: 'lt', type: 'title', text: 'Rahul Sharma\nCollector', template: 'lt-saffron', textStyle: 'lower', box: '#e8740c', textColor: '#ffffff', anim: 'slide' },
    { id: 'big', type: 'title', text: 'Bastar', template: 'title-big', textStyle: 'center', box: 'none', textColor: '#ffffff' },
    { id: 'g', type: 'graphic', start: 1, dur: 5, gfx: { tpl: 'lower3', theme: 'brand', brand: { primary: '#000000' }, style: 'bar', logo: '' } },
    { id: 'g2', type: 'graphic', start: 1, dur: 5, gfx: { tpl: 'counter', theme: 'mygov', value: 5 } }] },
  logo: { mediaId: '', pos: 'tr', scale: 0.12, opacity: 0.9 } });
const MYB = { id: 'myb001', name: 'MY Bharat', primary: '#1A3C8F', accent: '#ff6f00', text: '#ffffff', font: 'Nirmala UI', capPreset: 'box', logoPos: 'tl', logoScale: 0.2, logoOpacity: 1, ltTitle: 'lt-navy', ltMotion: 'pill', palette: ['#ffcc00', 'bad', '#FFCC00'] };
const KI = { id: 'khelo01', name: 'Khelo India', primary: '#b71c1c', accent: '#ffd400', text: '#fffff0', font: 'Arial Black', capPreset: 'reel', logoPos: 'br', ltTitle: 'lt-strip', ltMotion: 'split', endText: 'kheloindia.gov.in' };
const files = (p) => ({ logo: { id: `logo-${p}`, kind: 'image' }, intro: { id: `in-${p}`, kind: 'video', duration: 2 }, outro: { id: `out-${p}`, kind: 'image' } });

test('cleanPack: defaults, bad colours dropped, limits kept', () => {
  const p = cleanPack({ name: '  Khelo India ', primary: 'red', accent: '#ABCDEF', logoScale: 9, logoOpacity: -1, capPreset: 'nope', logoPos: 'middle', palette: ['#111111', '#111111', 'x', '#222222'], ltTitle: 'card-navy' });
  same([p.name, p.primary, p.accent, p.logoScale, p.logoOpacity, p.capPreset, p.logoPos, p.ltTitle], ['Khelo India', PACK_DEFAULTS.primary, '#abcdef', 0.5, 0.1, 'karaoke', 'tr', 'lt-navy']);
  same(p.palette, ['#111111', '#222222']);
  same(cleanPack({}).name, 'Untitled pack');
  same(packColors({ primary: '#0b2545', accent: '#ff9933', text: '#ffffff', palette: ['#FF9933', '#123456'] }), ['#0b2545', '#ff9933', '#ffffff', '#123456']);
});

test('applyPack: logo, intro / outro, captions, titles and graphics take the pack', () => {
  const P = project();
  applyPack(P, MYB, files('m'), { uid });
  same(P.logo, { mediaId: 'logo-m', pos: 'tl', scale: 0.2, opacity: 1, pack: 'myb001' });
  same(P.tracks.V1.map((c) => c.brandClip || c.id), ['intro', 'a', 'b', 'outro']);
  same([P.tracks.V1[0].mediaId, P.tracks.V1[0].out, P.tracks.V1[3].type, P.tracks.V1[3].dur], ['in-m', 2, 'image', 3]);
  const st = P.captions.style;
  same([st.preset, st.font, st.hl, st.box], ['brand', 'Nirmala UI', '#ff6f00', '#1a3c8f']);
  const lt = P.tracks.V2[0];
  same([lt.template, lt.text, lt.box, lt.accent, lt.textColor], ['lt-navy', 'Rahul Sharma\nCollector', '#1a3c8f', '#ff6f00', '#ffffff'], 'lower third restyled, words kept');
  same(P.tracks.V2[1].box, 'none', 'a title without a box keeps none');
  const g = P.tracks.V2[2].gfx;
  same([g.brand.primary, g.font, g.style, g.logo], ['#1a3c8f', 'Nirmala UI', 'pill', 'logo-m']);
  same(P.tracks.V2[3].gfx.theme, 'mygov', 'a graphic in another look is left alone');
  same(P.brand, { pack: { id: 'myb001', name: 'MY Bharat' }, primary: '#1a3c8f', accent: '#ff6f00', text: '#ffffff', palette: ['#ffcc00'], font: 'Nirmala UI', lt: 'lt-navy', ltMotion: 'pill' });
});

test('applyPack again with another pack replaces, never stacks', () => {
  const P = project();
  applyPack(P, MYB, files('m'), { uid });
  applyPack(P, KI, { logo: { id: 'logo-k', kind: 'image' } }, { uid });
  same(P.tracks.V1.map((c) => c.brandClip || c.id), ['a', 'b', 'outro'], "MY Bharat's intro and outro are gone; Khelo India has an end card only");
  const end = P.tracks.V1[2];
  same([end.type, end.text, end.bg, end.textColor], ['title', 'kheloindia.gov.in', '#b71c1c', '#fffff0']);
  same([P.logo.mediaId, P.logo.pos, P.logo.pack], ['logo-k', 'br', 'khelo01']);
  same([P.tracks.V2[0].template, P.tracks.V2[0].strip], ['lt-strip', '#b71c1c']);
  same([P.tracks.V2[2].gfx.logo, P.tracks.V2[2].gfx.style], ['logo-k', 'split'], "the graphic's pack logo follows");
  same(P.brand.pack.name, 'Khelo India');
  // a pack without a logo takes the earlier pack's logo away, but never a logo the editor set by hand
  applyPack(P, { ...KI, id: 'nologo' }, {}, { uid });
  same([P.logo.mediaId, 'pack' in P.logo], ['', false]);
  P.logo.mediaId = 'mine';
  applyPack(P, { ...KI, id: 'nologo' }, {}, { uid });
  same(P.logo.mediaId, 'mine');
  // intro / outro switched off: the earlier ones still go
  applyPack(P, MYB, files('m'), { uid, intro: false, outro: false });
  same(P.tracks.V1.map((c) => c.id), ['a', 'b']);
});

test('packs on disk: save, files in the pack folder, duplicate, delete, one name each', () => {
  const root = tmpDir(), src = path.join(root, 'src.png');
  fs.writeFileSync(src, 'png');
  const a = savePack(root, { name: 'MY Bharat', primary: '#112233', logo: 'C:/elsewhere/evil.png' }, { by: 'Vishal' });
  same([a.primary, a.logo, a.by], ['#112233', '', 'Vishal'], 'a file cannot be set by save');
  let e = null; try { savePack(root, { name: 'my bharat' }); } catch (x) { e = x; }
  same(e?.code, 409);
  const b = setPackFile(root, a.id, 'logo', src, { origName: 'MyBharat Logo.PNG' });
  same(b.logo, 'logo.png');
  assert(fs.existsSync(src), 'a copy, the original stays');
  same(packFile(root, b, 'logo'), path.join(root, a.id, 'logo.png'));
  e = null; try { setPackFile(root, a.id, 'logo', src, { origName: 'x.mp4' }); } catch (x) { e = x; }
  same(e?.code, 400, 'a video is not a logo');
  const c = savePack(root, { id: a.id, name: 'MY Bharat', accent: '#abcdef', logo: 'logo.png' });
  same([c.accent, c.logo, c.primary], ['#abcdef', 'logo.png', '#112233'], 'an edit keeps the file and the other fields');
  const d = duplicatePack(root, a.id), d2 = duplicatePack(root, a.id);
  same([d.name, d2.name, d.logo], ['MY Bharat copy', 'MY Bharat copy 2', 'logo.png']);
  assert(fs.existsSync(path.join(root, d.id, 'logo.png')), 'the copy has its own logo file');
  savePack(root, { id: d.id, name: 'MY Bharat copy', logo: '' });
  assert(!fs.existsSync(path.join(root, d.id, 'logo.png')), 'clearing the logo deletes its file');
  assert(fs.existsSync(path.join(root, a.id, 'logo.png')), "the original pack's logo stays");
  same(listPacks(root).map((p) => p.name), ['MY Bharat', 'MY Bharat copy', 'MY Bharat copy 2']);
  deletePack(root, d2.id);
  same(listPacks(root).length, 2);
  e = null; try { readPack(root, d2.id); } catch (x) { e = x; }
  same(e?.code, 404);
  e = null; try { readPack(root, '../..'); } catch (x) { e = x; }
  same(e?.code, 400, 'no paths as ids');
});

test('the old brand kit becomes the first pack, once', () => {
  const root = path.join(tmpDir(), 'brandpacks'), bf = path.join(path.dirname(root), 'brand.json');
  fs.writeFileSync(bf, JSON.stringify({ primary: '#0b2545', accent: '#ff9933', logo: 'Z:\\Brand\\logo.png', endText: 'mybharat.gov.in', capPreset: 'news' }));
  const m = migrateBrandKit(root, bf);
  same([m.name, m.logo, m.endText, m.capPreset], ['Brand kit', 'Z:\\Brand\\logo.png', 'mybharat.gov.in', 'news']);
  same(listPacks(root).length, 1);
  same(packFile(root, m, 'logo'), null, 'a missing file is not offered');
  same(savePack(root, { id: m.id, name: 'Brand kit', logo: 'Z:\\Brand\\logo.png' }).logo, 'Z:\\Brand\\logo.png', 'the old path is kept on edit');
  deletePack(root, m.id);
  same(migrateBrandKit(root, bf), null, 'not again');
  same(listPacks(root).length, 0);
  const empty = path.join(tmpDir(), 'brandpacks');
  same(migrateBrandKit(empty, path.join(empty, 'none.json')), null, 'no old kit, no pack');
});
