// 🔗 Client review links (engine/clientreview.mjs): tokens, constant-time lookup, passwords, render names (no way out of
// the renders folder), cleaning what a client sends, rate limits, and what the client's page may see.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test, assert, eq } from './harness.mjs';
import { newToken, tokenShape, sameSecret, findLink, hashPw, pwOk, pwCookie, renderName, renderPath, cleanText, cleanName, cleanDraw,
  Limiter, readLimited, ReviewStore, clientView, ownerView, expired, jobState, openChanges, cleanRating } from '../engine/clientreview.mjs';

test('tokens are long and random, and only a whole, exact token finds its link', () => {
  const a = newToken(), b = newToken();
  assert(a !== b && a.length >= 43 && tokenShape(a), a);
  const links = [{ id: 'x', token: a }, { id: 'y', token: b }];
  eq(findLink(links, a)?.id, 'x'); eq(findLink(links, b)?.id, 'y');
  eq(findLink(links, a.slice(0, -1)), null); eq(findLink(links, `${a}x`), null);
  eq(findLink(links, a.toUpperCase() === a ? a.toLowerCase() : a.toUpperCase()), null);
  for (const bad of ['', null, undefined, '../etc', 'short', 'a'.repeat(200), `${a.slice(0, 42)}/`]) eq(findLink(links, bad), null);
  assert(sameSecret('abc', 'abc') && !sameSecret('abc', 'abd') && !sameSecret('', '') && !sameSecret('abc', null), 'sameSecret');
});

test('passwords: scrypt with a salt; the unlock cookie changes with the password', () => {
  const rec = hashPw('kesari'), rec2 = hashPw('kesari');
  assert(rec.salt !== rec2.salt && rec.hash !== rec2.hash, 'salted');
  assert(pwOk('kesari', rec) && !pwOk('Kesari', rec) && !pwOk('', rec) && !pwOk(undefined, rec), 'check');
  assert(pwOk('anything', null), 'no password = open');
  const l = { id: 'a1', pw: rec };
  assert(pwCookie('s', l) === pwCookie('s', l) && pwCookie('s', l) !== pwCookie('s', { ...l, pw: rec2 }) && pwCookie('s', l) !== pwCookie('t', l), 'cookie');
});

test('a render is kept and served by its file name only - no folders, no way out of renders', () => {
  eq(renderName('Main edit 10-02.mp4'), 'Main edit 10-02.mp4');
  for (const bad of ['../project.json', '..\\config.json', 'sub/x.mp4', 'C:\\x.mp4', 'C:x.mp4', '.hidden.mp4', 'a..mp4', 'notes.json', 'x.mp4\0.txt', '_preview.mp4', '', null])
    eq(renderName(bad), null, String(bad));
  const dir = path.join(os.tmpdir(), 'renders');
  eq(renderPath(dir, 'a.mp4'), path.resolve(dir, 'a.mp4'));
  eq(renderPath(dir, '../a.mp4'), null);
});

test('what a client types is cleaned: control characters, direction tricks, length; drawings are bounded', () => {
  eq(cleanText('  hi\u0000 there\u202E \r\n'), 'hi there');
  eq(cleanText('x'.repeat(5000)).length, 2000);
  eq(cleanText('<script>alert(1)</script>'), '<script>alert(1)</script>'); // (kept as text - the page shows it with textContent)
  eq(cleanName(' Ravi \n  Kumar '), 'Ravi Kumar');
  eq(cleanName('n'.repeat(100)).length, 60);
  eq(cleanDraw('x'), null); eq(cleanDraw([[0.1, 0.1]]), null);
  eq(JSON.stringify(cleanDraw([[0.1, 0.2, 2, -1, 'a', 0.5]])), JSON.stringify([[0.1, 0.2, 1, 0]]));
  const big = cleanDraw(Array.from({ length: 50 }, () => Array.from({ length: 400 }, () => 0.5)));
  assert(big.length <= 30 && big.flat().length <= 2400, `${big.length} strokes`);
});

test('rate limit: a burst is stopped, a new window lets it through again', () => {
  const r = new Limiter();
  for (let i = 0; i < 5; i++) assert(r.hit('k', 5, 1000, 1000 + i), `hit ${i}`);
  assert(!r.hit('k', 5, 1000, 1500), 'sixth in the window');
  assert(r.hit('other', 5, 1000, 1500), 'other key');
  assert(r.hit('k', 5, 1000, 2600), 'next window');
});

test('a big comment body is refused while it arrives (413)', async () => {
  const req = (s, len) => Object.assign(Readable.from([Buffer.from(s)]), { headers: len ? { 'content-length': String(len) } : {} });
  eq(await readLimited(req('{"a":1}'), 100), '{"a":1}');
  let code = 0; try { await readLimited(req('x'.repeat(500)), 100); } catch (e) { code = e.code; }
  eq(code, 413);
  code = 0; try { await readLimited(req('x', 99999), 100); } catch (e) { code = e.code; }
  eq(code, 413);
});

test('store: links, versions, expiry; the client sees no project, path, token or password', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-crv-'));
  try {
    const st = new ReviewStore(path.join(d, 'client-reviews.json'));
    let threw = false; try { st.create({ project: 'P', render: '../x.mp4' }); } catch { threw = true; }
    assert(threw, 'bad render refused');
    const l = st.create({ project: 'Secret Project', render: 'Cut A.mp4', client: 'MY Bharat', password: 'pw', days: 7, by: 'Owner' });
    eq(l.versions[0].render, 'Cut A.mp4'); eq(l.title, 'Cut A'); assert(l.expires > Date.now(), 'expires');
    eq(st.addVersion(l, 'Cut B.mp4').n, 2);
    const again = new ReviewStore(path.join(d, 'client-reviews.json'));
    eq(again.secret, st.secret); eq(findLink(again.links, l.token)?.versions.length, 2);
    const seen = JSON.stringify(clientView(l));
    for (const bad of ['Secret Project', 'Cut A.mp4', l.token, l.pw.hash, l.pw.salt, 'render']) assert(!seen.includes(bad), `client sees ${bad}`);
    const own = ownerView(l, 'u'); assert(!('pw' in own) && !('token' in own) && own.hasPw, 'owner view');
    assert(!expired(l) && expired({ ...l, expires: Date.now() - 1 }) && expired({ ...l, off: true }), 'expired');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('feedback loop: ticked changes go out as fixed in the next version; job state; rating', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-crv-'));
  try {
    const st = new ReviewStore(path.join(d, 'client-reviews.json'));
    const l = st.create({ project: 'Job', render: 'Cut A.mp4', client: 'MY Bharat' });
    eq(jobState([l]).state, 'waiting'); eq(jobState([]).state, 'none');
    const add = (text, extra = {}) => { const c = { id: `c${l.comments.length}`, v: 1, t: 3, text, by: 'Client', at: Date.now(), parent: null, ...extra }; l.comments.push(c); return c; };
    const a = add('Logo bigger'), b = add('Music softer'); add('ok', { parent: a.id }); add('noted', { team: true }); add('✏️ Changes requested: see notes');
    eq(openChanges(l).map((c) => c.id), [a.id, b.id], 'only the asks count');
    l.versions[0].status = 'changes';
    eq(jobState([l]), { state: 'changes', v: 1, open: 2, link: l.id, client: 'MY Bharat', stars: 0, at: l.versions[0].at });
    st.setDone(l, a.id, true, 'Asha');
    let threw = false; try { st.setDone(l, 'c3', true, 'x'); } catch (e) { threw = e.code === 404; }
    assert(threw, 'a team note is not a change');
    eq(st.addVersion(l, 'Cut B.mp4').n, 2);
    eq(a.fixedIn, 2); eq(b.fixedIn, undefined);
    eq(clientView(l).comments.find((c) => c.id === a.id).fixedIn, 2);
    assert(!JSON.stringify(clientView(l)).includes('Asha'), 'the client does not see who ticked it');
    st.setDone(l, a.id, false); eq(a.done.by, 'Asha', 'a change sent as fixed stays fixed');
    eq(jobState([l]).state, 'waiting', 'v2 with the client: the old open one was on v1');
    l.versions[1].status = 'approved'; l.rating = { ...cleanRating({ stars: 4.4, text: ' great ' }), by: 'C', at: 1 };
    eq(jobState([l]).state, 'approved'); eq(jobState([l]).stars, 4); eq(clientView(l).rating, { stars: 4, text: 'great', at: 1 });
    for (const bad of [0, 6, 'x', null, -1]) eq(cleanRating({ stars: bad }), null, String(bad));
    eq(jobState([{ ...l, off: true }]).state, 'none', 'a turned-off link is out of the loop');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
