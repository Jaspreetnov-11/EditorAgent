// 🧹 Limelight NAS Care (tools/nascare): scan, duplicates, unused, the bin (put back / empty), organiser, canaries, SNMP
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test, eq, assert } from './harness.mjs';
import * as C from '../tools/nascare/core.mjs';
import { request, parseResponse, encodeOid } from '../tools/nascare/snmp.mjs';

const OLD = Date.now() - 800 * 864e5, MID = Date.now() - 30 * 864e5;
async function makeShare() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nascare-'));
  const data = path.join(root, '..', path.basename(root) + '-data');
  const put = async (rel, body, t = MID) => { const p = path.join(root, rel); await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, body); await fsp.utimes(p, t / 1000, t / 1000); return p; };
  const big = Buffer.alloc(300 * 1024, 7); big.write('same', 1000);
  await put('Shoot A\\clip.mp4', big, OLD);
  await put('Copy\\clip.mp4', big, MID);
  const other = Buffer.from(big); other[150000] = 9;
  await put('Copy\\clip-other.mp4', other, MID); // same size, differs in the middle
  const sneaky = Buffer.from(big); sneaky[220000] = 9;
  await put('Copy\\clip-sneaky.mp4', sneaky, MID); // differs where the samples do not look: only the full hash sees it
  await put('Old Work\\old.mov', Buffer.alloc(5000, 1), OLD);
  const used = await put('Old Work\\used.mov', Buffer.alloc(5000, 2), OLD);
  await put('Old Work\\render.tmp', 'x', MID);
  await put('Old Work\\Media Cache Files\\a.cfa', 'x', MID);
  await put('Old Work\\nothing.txt', '', MID);
  await put('Limelight Kit\\setup.exe', 'x', OLD);
  await put('@Recycle\\gone.mp4', 'x', OLD);
  await put('Loose\\a.mp4', 'v', MID); await put('Loose\\b.wav', 'a', MID); await put('Loose\\c.psd', 'g', MID); await put('Loose\\notes.pdf', 'd', MID); await put('Loose\\Final_Export.mp4', 'e', MID);
  await fsp.mkdir(path.join(root, 'Empty One'), { recursive: true });
  const proj = path.join(data, 'proj', 'P1'); await fsp.mkdir(proj, { recursive: true });
  await fsp.writeFile(path.join(proj, 'media.json'), JSON.stringify({ items: [{ path: used }] }));
  return { root, data, share: { id: 'T', root }, used, proj: path.join(proj, 'media.json') };
}

test('scan skips NAS system folders, finds junk, empty folders and ransomware names', async () => {
  const t = await makeShare();
  await fsp.writeFile(path.join(t.root, 'Old Work', 'HOW_TO_DECRYPT.txt'), 'x');
  const sum = await C.scanShare(t.share, t.data, {}, { gentleMs: 0 });
  assert(sum.complete);
  const idx = []; for await (const r of C.readIndex(path.join(t.data, 'index-T.ndjson'))) idx.push(r[0]);
  assert(!idx.some((p) => p.startsWith('@Recycle')), 'skips @Recycle');
  eq(sum.emptyDirs, ['Empty One']);
  eq(sum.junk.temp[0], 1); eq(sum.junk.cache[0], 1); eq(sum.junk.empty[0], 1);
  eq(sum.suspicious, ['Old Work\\HOW_TO_DECRYPT.txt']);
  assert(C.suspicious('photo.jpg.deadbolt') && !C.suspicious('Deadline notes.txt'));
});

test('project references protect used media; unused report honours protected folders and age', async () => {
  const t = await makeShare();
  await C.scanShare(t.share, t.data, {}, { gentleMs: 0 });
  const refs = await C.projectRefs([t.proj]);
  assert(refs.has(C.norm(t.used)), 'media.json path found');
  const r = await C.findUnused(path.join(t.data, 'index-T.ndjson'), t.root, { days: 365, protect: ['Limelight Kit'], refs });
  const old = r.cats.old.map((x) => x[0]);
  assert(old.includes('Old Work\\old.mov') && old.includes('Shoot A\\clip.mp4'), 'old files listed');
  assert(!old.includes('Old Work\\used.mov'), 'used file kept');
  assert(!old.some((p) => p.startsWith('Limelight Kit')), 'protected folder kept');
  eq(r.usedSkipped, 1); eq(r.totals.temp[0], 1); eq(r.totals.cache[0], 1);
  eq(C.pathsIn('<ActualMediaFilePath>Z:\\2026\\A &amp; B\\x.mp4</ActualMediaFilePath>'), ['Z:\\2026\\A & B\\x.mp4']);
});

test('duplicates: same content grouped, same size but different content is not, the oldest copy is kept', async () => {
  const t = await makeShare();
  await C.scanShare(t.share, t.data, {}, { gentleMs: 0 });
  const d = await C.findDuplicates(path.join(t.data, 'index-T.ndjson'), t.root, { minBytes: 100000 });
  eq(d.groups.length, 1);
  eq(d.groups[0].members.map((m) => m.rel).sort(), ['Copy\\clip-sneaky.mp4', 'Copy\\clip.mp4', 'Shoot A\\clip.mp4']);
  eq(d.groups[0].keep, 'Shoot A\\clip.mp4');
  const a = await C.fullHash(path.join(t.root, 'Shoot A\\clip.mp4')), b = await C.fullHash(path.join(t.root, 'Copy\\clip-sneaky.mp4'));
  eq(await C.fullHash(path.join(t.root, 'Copy\\clip.mp4')), a);
  assert(a !== b, 'full hash tells them apart');
});

test('bin: moves into the share bin with a check, puts back, and empties only after the keep days', async () => {
  const t = await makeShare();
  const items = [{ rel: 'Old Work\\old.mov' }, { rel: 'Old Work\\used.mov' }, { rel: '..\\outside.txt' }];
  const b = await C.moveBatch(t.share, items, { kind: 'bin', reason: 'test', dataDir: t.data, check: async (abs) => (abs.endsWith('used.mov') ? 'used by a project' : null) });
  eq(b.moved.length, 1); eq(b.skipped.length, 2);
  assert(fs.existsSync(path.join(t.root, C.BIN, b.id, 'Old Work', 'old.mov')) && !fs.existsSync(path.join(t.root, 'Old Work', 'old.mov')));
  let threw = false; try { await C.purgeBatch(b.id, t.data, { minAgeDays: 7 }); } catch { threw = true; }
  assert(threw, 'too young to empty');
  const r = await C.restoreBatch(b.id, t.data);
  eq(r.ok, 1); assert(fs.existsSync(path.join(t.root, 'Old Work', 'old.mov')) && !fs.existsSync(path.join(t.root, C.BIN, b.id)));
  const b2 = await C.moveBatch(t.share, [{ rel: 'Old Work\\old.mov' }], { kind: 'bin', reason: 'test', dataDir: t.data });
  const p = await C.purgeBatch(b2.id, t.data, { minAgeDays: 7, now: Date.now() + 8 * 864e5 });
  eq(p.purged, 1); assert(!fs.existsSync(path.join(t.root, C.BIN, b2.id)) && fs.existsSync(path.join(t.root, C.BIN)));
});

test('organiser: template plan, media kept next to project files, apply and undo', async () => {
  const t = await makeShare();
  const loose = path.join(t.root, 'Loose');
  const plan = await C.planOrganise(loose, t.root, 'template', { now: Date.now() });
  const to = Object.fromEntries(plan.moves.map((m) => [m.name, m.sub]));
  eq(to, { 'a.mp4': '01 Footage', 'b.wav': '02 Audio', 'c.psd': '03 Graphics', 'notes.pdf': '06 Documents', 'Final_Export.mp4': '05 Exports' });
  const b = await C.moveBatch(t.share, plan.moves, { kind: 'folder', toFolder: true, dataDir: t.data });
  eq(b.moved.length, 5); assert(fs.existsSync(path.join(loose, '01 Footage', 'a.mp4')));
  await C.restoreBatch(b.id, t.data);
  assert(fs.existsSync(path.join(loose, 'a.mp4')) && !fs.existsSync(path.join(loose, '01 Footage')), 'undo puts back and tidies folders');
  await fsp.writeFile(path.join(loose, 'edit.prproj'), 'p'); await fsp.utimes(path.join(loose, 'edit.prproj'), MID / 1000, MID / 1000);
  const p2 = await C.planOrganise(loose, t.root, 'type', { now: Date.now() });
  eq(p2.moves.map((m) => m.name).sort(), ['edit.prproj', 'notes.pdf']); assert(p2.warnings.length === 1);
  eq(C.targetFor('x.jpg', new Date(2026, 9, 5).getTime(), 'date'), '2026\\2026-10');
});

test('canaries notice a changed file; protected paths; growth per day', async () => {
  const t = await makeShare();
  eq((await C.canaries(t.root, t.data, 'T')).made, true);
  eq((await C.canaries(t.root, t.data, 'T')).ok, true);
  const dir = path.join(t.root, C.BIN, '!canary - do not open or change');
  await fsp.writeFile(path.join(dir, '! Client list.docx'), 'encrypted!!');
  const c = await C.canaries(t.root, t.data, 'T');
  assert(!c.ok && c.bad[0].includes('Client list'));
  assert(C.isProtected('Limelight Kit\\a\\b.exe', ['Limelight Kit']) && !C.isProtected('Limelight Kitchen\\x', ['Limelight Kit']));
  const now = Date.now(), pts = [0, 1, 2, 3].map((d) => ({ t: now - (3 - d) * 864e5, used: 1000 + d * 50 }));
  eq(Math.round(C.growth(pts, now)), 50);
});

test('SNMP: a GETBULK request and a response decode', () => {
  const req = request(0xa5, 'public', 7, ['1.3.6.1.4.1.24681.1.2'], 20);
  assert(req[0] === 0x30 && req.includes(Buffer.from('public')));
  eq([...encodeOid('1.3.6.1.4.1.24681')], [6, 8, 43, 6, 1, 4, 1, 129, 192, 105]);
  // hand-made response: id 7, one varbind 1.3.6.1.2.1.1.5.0 = "NAS"
  const oid = encodeOid('1.3.6.1.2.1.1.5.0'), val = Buffer.from([0x04, 3, 78, 65, 83]);
  const vb = Buffer.concat([Buffer.from([0x30, oid.length + val.length]), oid, val]);
  const vbs = Buffer.concat([Buffer.from([0x30, vb.length]), vb]);
  const pdu = Buffer.concat([Buffer.from([2, 1, 7, 2, 1, 0, 2, 1, 0]), vbs]);
  const pduT = Buffer.concat([Buffer.from([0xa2, pdu.length]), pdu]);
  const body = Buffer.concat([Buffer.from([2, 1, 1, 4, 6]), Buffer.from('public'), pduT]);
  const r = parseResponse(Buffer.concat([Buffer.from([0x30, body.length]), body]));
  eq(r, { id: 7, error: 0, binds: [{ oid: '1.3.6.1.2.1.1.5.0', value: 'NAS', end: false }] });
});
