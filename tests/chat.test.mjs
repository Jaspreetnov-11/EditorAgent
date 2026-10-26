// 💬 Office chat (engine/chat.mjs): the office group, groups, one-to-ones, replies, deletes, reads, files - and, with
// `node tests/run.mjs --server`, the same through a test editor's team door (a viewer chats too, a stranger to a group
// sees nothing of it, messages arrive live on the stream).
import { test, eq, assert } from './harness.mjs';
import { Chat, OFFICE, dmId, projectId } from '../engine/chat.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const team = [{ name: 'Jaspreet', role: 'owner' }, { name: 'Ravi', role: 'editor' }, { name: 'Sita', role: 'editor' }, { name: 'Manager', role: 'viewer' }];
const fresh = (people = team) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-chat-')); let t = 1000; return { dir, c: new Chat(dir, { people: () => people, now: () => (t += 1000) }) }; };
const throws = (fn, code) => { try { fn(); } catch (e) { eq(e.code, code); return e; } throw new Error('did not throw'); };

test('chat: everyone is in the office group; messages, unread and reading', () => {
  const { c } = fresh();
  eq(c.list('Manager').map((r) => r.id), [OFFICE]);
  const { msg } = c.send(OFFICE, 'Ravi', { text: '  render ho gaya  ' });
  eq([msg.id, msg.from, msg.text], [1, 'Ravi', 'render ho gaya']);
  c.send(OFFICE, 'Sita', { text: 'Thanks @Ravi' });
  eq(c.list('Manager')[0].unread, 2);
  eq(c.list('Ravi')[0].unread, 1, 'your own messages are never unread');
  c.markRead(OFFICE, 'Manager', 1);
  eq(c.unread('Manager'), 1);
  eq(c.list('Ravi')[0].reads, { Jaspreet: 0, Sita: 2, Manager: 1 }, 'how far each of the others has read');
  throws(() => c.send(OFFICE, 'Ravi', { text: '   ' }), 400);
});

test('chat: a group - only its people see it; who made it (or an owner) changes it; anyone may leave', () => {
  const { c } = fresh();
  const g = c.group('Ravi', 'MP Tourism shoot', ['sita']);
  eq(g.members, ['Ravi', 'Sita']);
  c.send(g.id, 'Sita', { text: 'Footage aa gaya' });
  assert(!c.list('Manager').some((r) => r.id === g.id), 'not in the group: not in the list');
  throws(() => c.history(g.id, 'Manager'), 404);
  throws(() => c.send(g.id, 'Manager', { text: 'hi' }), 404);
  throws(() => c.edit(g.id, 'Sita', { title: 'x' }), 403);
  throws(() => c.edit(g.id, 'Jaspreet', { members: ['Manager'] }, true), 404); // (an owner not in it sees nothing of it either)
  c.edit(g.id, 'Ravi', { members: ['Ravi', 'Sita', 'Manager', 'Jaspreet'] });
  c.edit(g.id, 'Jaspreet', { members: ['Ravi', 'Sita', 'Manager'] }, true); // (an owner in it changes it, though not its maker)
  eq(c.history(g.id, 'Manager').messages.map((m) => m.text), ['Footage aa gaya']);
  c.edit(g.id, 'Ravi', { title: 'MP Tourism' });
  eq(c.list('Sita').find((r) => r.id === g.id).name, 'MP Tourism');
  c.edit(g.id, 'Manager', { leave: true });
  throws(() => c.history(g.id, 'Manager'), 404);
  throws(() => c.edit(OFFICE, 'Ravi', { leave: true }), 400);
});

test('chat: a one-to-one is the same room from both sides, named after the other person', () => {
  const { c } = fresh();
  const r = c.direct('Ravi', 'sita');
  eq(r.id, dmId('Sita', 'Ravi'));
  eq(c.direct('Sita', 'Ravi').id, r.id);
  assert(!c.list('Sita').some((x) => x.id === r.id), 'nothing written yet: only the one who opened it sees it');
  c.send(r.id, 'Ravi', { text: 'Color check kar lo' });
  eq(c.list('Sita').find((x) => x.id === r.id).name, 'Ravi');
  eq(c.list('Ravi').find((x) => x.id === r.id).name, 'Sita');
  throws(() => c.history(r.id, 'Manager'), 404);
  throws(() => c.direct('Ravi', 'Ravi'), 400);
  throws(() => c.direct('Ravi', 'Nobody'), 404);
});

test('chat: replies, deleting your own (an owner any), and all of it back after a restart', () => {
  const { c, dir } = fresh();
  c.send(OFFICE, 'Ravi', { text: 'Kal shoot 9 baje' });
  const { msg } = c.send(OFFICE, 'Sita', { text: 'Ok', reply: 1 });
  eq(msg.reply, { id: 1, from: 'Ravi', text: 'Kal shoot 9 baje' });
  throws(() => c.del(OFFICE, 'Sita', 1), 403);
  c.del(OFFICE, 'Ravi', 1);
  c.del(OFFICE, 'Jaspreet', 2, true);
  c.send(OFFICE, 'Manager', { text: 'Done' });
  c.markRead(OFFICE, 'Sita', 3); c.saveNow();
  const again = new Chat(dir, { people: () => team });
  const h = again.history(OFFICE, 'Sita').messages;
  eq(h.map((m) => [m.id, !!m.deleted, m.text || null]), [[1, true, null], [2, true, null], [3, false, 'Done']]);
  eq(again.unread('Sita'), 0);
  eq(again.list('Ravi')[0].last.text, 'Done');
});

test('chat: a file - kept with its room, only for the room\'s people, gone with its message', () => {
  const { c } = fresh();
  const g = c.group('Ravi', 'Design', ['Sita']);
  const f = c.newFile(g.id, 'Ravi', 'Poster final.PNG');
  eq(f.ext, '.png');
  throws(() => c.send(g.id, 'Ravi', { file: { id: f.id, ext: f.ext, name: 'x.png' } }), 400); // (not arrived yet)
  fs.writeFileSync(f.file, 'png');
  const { msg } = c.send(g.id, 'Ravi', { file: { id: f.id, ext: f.ext, name: '../../Poster final.PNG', size: 3, type: 'image/png' } });
  eq(msg.file.name, '.._.._Poster final.PNG'.replace(/^\.+/, ''));
  eq(c.fileOf(g.id, 'Sita', f.id).path, f.file);
  throws(() => c.fileOf(g.id, 'Manager', f.id), 404);
  throws(() => c.newFile(g.id, 'Manager', 'a.png'), 404);
  c.del(g.id, 'Ravi', msg.id);
  assert(!fs.existsSync(f.file), 'the file goes with its message');
  throws(() => c.fileOf(g.id, 'Sita', f.id), 404);
});

test('chat: a project chat is the people who may open that project', () => {
  const access = { 'MP Tourism': ['Ravi'] }; // (and owners, who see every project)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-chat-'));
  const c = new Chat(dir, { people: () => team, mayOpen: (n, p) => n === 'Jaspreet' || (access[p] || []).includes(n) });
  const r = c.project('Ravi', 'MP Tourism');
  eq([r.id, r.kind, r.name], [projectId('mp tourism'), 'project', 'MP Tourism']);
  eq(c.project('Jaspreet', 'MP Tourism').id, r.id, 'the same room for everyone in the project');
  throws(() => c.project('Sita', 'MP Tourism'), 404);
  c.send(r.id, 'Ravi', { text: 'Rough cut ready' });
  eq(c.list('Jaspreet').find((x) => x.id === r.id).members, ['Jaspreet', 'Ravi']);
  throws(() => c.history(r.id, 'Sita'), 404);
  access['MP Tourism'].push('Sita'); // (shared with her later: she is in its chat)
  eq(c.history(r.id, 'Sita').messages.map((m) => m.text), ['Rough cut ready']);
  throws(() => c.edit(r.id, 'Jaspreet', { title: 'x' }, true), 400);
});

test('chat: someone taken off the team drops out of every chat', () => {
  let ppl = team;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-chat-'));
  const c = new Chat(dir, { people: () => ppl });
  const g = c.group('Ravi', 'Reel', ['Sita', 'Manager']);
  ppl = team.filter((p) => p.name !== 'Manager');
  throws(() => c.history(OFFICE, 'Manager'), 404);
  eq(c.list('Ravi').find((r) => r.id === g.id).members, ['Ravi', 'Sita']);
});

// ---- end to end, through a test editor's team door ----
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ON = process.env.VEDIT_TEST_SERVER === '1';
const PORT = 3929, TEAM = 3928, L = `http://127.0.0.1:${PORT}`, T = `http://127.0.0.1:${TEAM}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(base, m, u, b, cookie, raw) {
  const r = await fetch(base + u, { method: m, redirect: 'manual', headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: raw ?? (b === undefined ? undefined : JSON.stringify(b)) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, cookie: (/ve_sess=([^;]*)/.exec(r.headers.get('set-cookie') || '') || [])[0] };
}
test('chat (server): editors and a viewer chat through the team door, live, with files', async () => {
  if (!ON) return 'skip';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-chatsrv-'));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), TEAM_PORT: String(TEAM), TEAM_WEB_PORT: String(TEAM), VEDIT_DATA: tmp, VEDIT_NO_RESUME: '1', VEDIT_CLUSTER: '0', VEDIT_KEY: 'chat-test' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  const es = new AbortController();
  try {
    for (let i = 0; i < 60; i++) { try { if ((await call(L, 'GET', '/api/version')).status === 200) break; } catch {} await sleep(500); if (i === 59) throw new Error(`test editor did not start:\n${log.slice(-800)}`); }
    for (const u of [{ name: 'Ravi', password: 'ravi-pass-1', role: 'editor' }, { name: 'Manager', password: 'mgr-pass-1', role: 'viewer' }, { name: 'Sita', password: 'sita-pass-1', role: 'editor' }]) eq((await call(L, 'PUT', '/api/team', { addUser: u })).status, 200);
    eq((await call(L, 'PUT', '/api/team', { on: true })).status, 200);
    const ravi = (await call(T, 'POST', '/team/login', { name: 'Ravi', password: 'ravi-pass-1' })).cookie;
    const mgr = (await call(T, 'POST', '/team/login', { name: 'Manager', password: 'mgr-pass-1' })).cookie;
    const sita = (await call(T, 'POST', '/team/login', { name: 'Sita', password: 'sita-pass-1' })).cookie;
    eq((await call(T, 'GET', '/api/chat')).status, 401, 'signed out: nothing');
    // the manager's chat window is open: what Ravi sends arrives on its stream
    const got = [];
    const stream = await fetch(`${T}/api/chat/stream?client=mgr1`, { headers: { Cookie: mgr }, signal: es.signal });
    (async () => { const rd = stream.body.getReader(), dec = new TextDecoder(); let buf = ''; try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); if (l.startsWith('data: ')) got.push(JSON.parse(l.slice(6))); } } } catch {} })();
    const me = await call(T, 'GET', '/api/chat', undefined, mgr);
    eq(me.body.me, 'Manager'); eq(me.body.rooms.map((r) => r.id), ['office']);
    eq((await call(T, 'POST', '/api/chat/send?room=office', { text: 'Final render 6 baje tak' }, ravi)).status, 200);
    for (let i = 0; i < 40 && !got.some((e) => e.type === 'msg'); i++) await sleep(50);
    eq(got.find((e) => e.type === 'msg')?.msg.text, 'Final render 6 baje tak', 'live on the stream');
    eq((await call(T, 'POST', '/api/chat/send?room=office', { text: 'Ok 👍', reply: 1 }, mgr)).status, 200, 'a viewer chats too');
    // a group of Ravi and Sita: the manager sees nothing of it - not its messages, not its files
    const g = (await call(T, 'POST', '/api/chat/group', { name: 'Edit team', members: ['Sita'] }, ravi)).body;
    const up = await call(T, 'POST', `/api/chat/upload?room=${g.id}&name=cut.txt`, undefined, ravi, 'first cut notes');
    eq(up.status, 200);
    eq((await call(T, 'POST', `/api/chat/send?room=${g.id}`, { text: 'Notes', file: { ...up.body, name: 'cut.txt', type: 'text/plain' } }, ravi)).status, 200);
    const f = await fetch(`${T}/api/chat/file?room=${g.id}&id=${up.body.id}&dl=1`, { headers: { Cookie: sita } });
    eq([f.status, await f.text()], [200, 'first cut notes']);
    assert(/attachment/.test(f.headers.get('content-disposition') || '') && /sandbox/.test(f.headers.get('content-security-policy') || ''), 'a download, never run as a page');
    eq((await call(T, 'GET', `/api/chat/file?room=${g.id}&id=${up.body.id}`, undefined, mgr)).status, 404);
    eq((await call(T, 'GET', `/api/chat/history?room=${g.id}`, undefined, mgr)).status, 404);
    assert(!got.some((e) => e.room === g.id && e.type === 'msg'), 'the group\'s messages never reach the manager');
    eq((await call(T, 'POST', '/api/chat/delete?room=office', { id: 1 }, mgr)).status, 403, 'only your own');
    // the owner on the editing PC is in the office chat too
    eq((await call(L, 'GET', '/api/chat/history?room=office')).body.messages.map((m) => m.from), ['Ravi', 'Manager']);
  } finally { es.abort(); srv.kill(); }
});
