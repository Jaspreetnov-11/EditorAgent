// 💬 Office chat, like WhatsApp: one group the whole office is in (📢 Limelight Office), groups anyone makes with the
// people they pick, and one-to-one chats, and one chat per project (its people: whoever may open that project). Text, replies, photos / videos / files, deleting your own message, who has
// read up to where. Kept in <data>/chat/: rooms.json (the rooms and how far each person has read) and one
// <room>.jsonl per room (a line per message; a delete is a line of its own, so the file is only ever added to).
// Files sent in a chat are in chat/files/<room>/<id><ext>. The server (server.mjs) checks who asks; this knows nothing
// of sign-ins - people() says who is in the office now (a person removed from the team drops out of every room).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const OFFICE = 'office';
const MAX_TEXT = 8000;
const okId = (id) => typeof id === 'string' && /^[a-z0-9]{1,40}$/.test(id);
const err = (code, msg) => Object.assign(new Error(msg), { code });
export const projectId = (p) => 'p' + crypto.createHash('sha1').update(String(p).toLowerCase()).digest('hex').slice(0, 20);
export const dmId = (a, b) => 'd' + crypto.createHash('sha1').update([a, b].map((x) => x.toLowerCase()).sort().join('\n')).digest('hex').slice(0, 20);
export const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^\.+/, '').slice(-120) || 'file';

export class Chat {
  // mayOpen(name, project): whether that person may open the project (its chat's people)
  constructor(dir, { people = () => [], mayOpen = () => true, now = Date.now } = {}) {
    this.dir = dir; this.people = people; this.mayOpen = mayOpen; this.now = now;
    fs.mkdirSync(dir, { recursive: true });
    let db = {}; try { db = JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8')); } catch {}
    this.rooms = db.rooms || {}; this.read = db.read || {}; this.msgs = new Map();
    if (!this.rooms[OFFICE]) this.rooms[OFFICE] = { id: OFFICE, kind: 'office', name: 'Limelight Office', at: this.now() };
  }
  save() {
    clearTimeout(this.t);
    this.t = setTimeout(() => this.saveNow(), 300); this.t.unref?.();
  }
  saveNow() {
    clearTimeout(this.t);
    const f = path.join(this.dir, 'rooms.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify({ rooms: this.rooms, read: this.read })); fs.renameSync(f + '.tmp', f);
  }
  names() { return this.people().map((p) => p.name); }
  // who is in a room now: the office is everyone; a group / one-to-one only its people still on the team
  members(r) {
    const all = this.names();
    if (r.kind === 'office') return all;
    if (r.kind === 'project') return all.filter((n) => this.mayOpen(n, r.project));
    const lc = new Set(r.members.map((m) => m.toLowerCase()));
    return all.filter((n) => lc.has(n.toLowerCase()));
  }
  isIn(name, r) { return !!r && this.members(r).some((m) => m.toLowerCase() === String(name).toLowerCase()); }
  room(id, name) {
    const r = okId(id) ? this.rooms[id] : null;
    if (!r || !this.isIn(name, r)) throw err(404, 'No such chat');
    return r;
  }
  // a room's messages (read from its file the first time)
  log(id) {
    let m = this.msgs.get(id);
    if (m) return m;
    m = [];
    let txt = ''; try { txt = fs.readFileSync(path.join(this.dir, `${id}.jsonl`), 'utf8'); } catch {}
    const byId = new Map();
    for (const l of txt.split('\n')) {
      if (!l.trim()) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.del) { const x = byId.get(o.del); if (x) { x.deleted = true; delete x.text; delete x.file; } continue; }
      byId.set(o.id, o); m.push(o);
    }
    this.msgs.set(id, m);
    return m;
  }
  append(id, o) { fs.appendFileSync(path.join(this.dir, `${id}.jsonl`), JSON.stringify(o) + '\n'); }
  // a room as one person sees it in their list: its name (the other person, for a one-to-one), the last message, unread
  view(r, name) {
    const log = this.log(r.id), last = log[log.length - 1] || null, seen = this.read[name]?.[r.id] || 0;
    const mem = this.members(r);
    const other = r.kind === 'dm' ? r.members.find((m) => m.toLowerCase() !== name.toLowerCase()) || name : null;
    return { id: r.id, kind: r.kind, name: other || r.name, members: mem, by: r.by || null, at: r.at, other,
      last: last && { id: last.id, from: last.from, at: last.at, text: last.deleted ? '' : (last.text || '').slice(0, 120), file: last.file ? { name: last.file.name, type: last.file.type } : null, deleted: !!last.deleted },
      unread: log.filter((x) => x.id > seen && x.from !== name && !x.deleted).length,
      // how far each of the others has read (✓✓)
      reads: Object.fromEntries(mem.filter((m) => m !== name).map((m) => [m, this.read[m]?.[r.id] || 0])) };
  }
  list(name) {
    // (a one-to-one nobody has written in yet shows only to whoever opened it)
    return Object.values(this.rooms).filter((r) => this.isIn(name, r) && ((r.kind !== 'dm' && r.kind !== 'project') || r.by === name || this.log(r.id).length)).map((r) => this.view(r, name))
      .sort((a, b) => (a.kind === 'office' ? -1 : b.kind === 'office' ? 1 : 0) || (b.last?.at || b.at || 0) - (a.last?.at || a.at || 0));
  }
  history(id, name, { before = Infinity, limit = 80 } = {}) {
    this.room(id, name);
    const log = this.log(id), end = log.findIndex((x) => x.id >= before);
    const upto = end < 0 ? log.length : end;
    return { messages: log.slice(Math.max(0, upto - Math.min(500, limit)), upto), more: upto > limit };
  }
  // a project's chat (made the first time someone who may open the project opens it)
  project(name, proj) {
    const p = String(proj || '').trim().slice(0, 200);
    if (!p || !this.mayOpen(name, p)) throw err(404, `No project "${p}"`);
    const id = projectId(p);
    if (!this.rooms[id]) { this.rooms[id] = { id, kind: 'project', name: p, project: p, by: name, at: this.now() }; this.save(); }
    return this.rooms[id];
  }
  // a one-to-one chat with someone on the team (made the first time)
  direct(name, other) {
    const o = this.names().find((n) => n.toLowerCase() === String(other).toLowerCase());
    if (!o) throw err(404, `${other} is not on the team`);
    if (o.toLowerCase() === name.toLowerCase()) throw err(400, 'Pick someone else');
    const id = dmId(name, o);
    if (!this.rooms[id]) { this.rooms[id] = { id, kind: 'dm', members: [name, o], by: name, at: this.now() }; this.save(); }
    return this.rooms[id];
  }
  group(name, title, members) {
    const t = String(title || '').trim().slice(0, 60);
    if (!t) throw err(400, 'Give the group a name');
    const all = this.names(), pick = new Set([name.toLowerCase(), ...(members || []).map((m) => String(m).toLowerCase())]);
    const mem = all.filter((n) => pick.has(n.toLowerCase()));
    if (!mem.some((m) => m.toLowerCase() === name.toLowerCase())) mem.unshift(name);
    const id = 'g' + crypto.randomBytes(8).toString('hex');
    this.rooms[id] = { id, kind: 'group', name: t, members: mem, by: name, at: this.now() }; this.save();
    return this.rooms[id];
  }
  // a group's name / people: by whoever made it or an owner; anyone may leave
  edit(id, name, { title, members, leave } = {}, isOwner = false) {
    const r = this.room(id, name);
    if (r.kind !== 'group') throw err(400, r.kind === 'office' ? 'Everyone is in the office group' : r.kind === 'project' ? 'A project chat is everyone who may open the project' : 'A one-to-one chat has no settings');
    if (leave) { r.members = r.members.filter((m) => m.toLowerCase() !== name.toLowerCase()); this.save(); return r; }
    if (!isOwner && r.by !== name) throw err(403, `Only ${r.by} (who made the group) or an owner can change it`);
    if (title !== undefined) { const t = String(title).trim().slice(0, 60); if (t) r.name = t; }
    if (Array.isArray(members)) {
      const pick = new Set(members.map((m) => String(m).toLowerCase())), all = this.names();
      r.members = all.filter((n) => pick.has(n.toLowerCase()));
      if (!r.members.length) r.members = [name];
    }
    this.save();
    return r;
  }
  send(id, name, { text, reply, file } = {}) {
    const r = this.room(id, name), log = this.log(id);
    const t = String(text ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
    let f = null;
    if (file) {
      if (!okId(file.id) || !fs.existsSync(this.filePath(id, file.id, file.ext))) throw err(400, 'That file did not arrive - send it again');
      f = { id: file.id, ext: String(file.ext || '').replace(/[^.a-z0-9]/gi, '').slice(0, 10).toLowerCase(), name: safeName(file.name), size: +file.size || 0, type: String(file.type || '').slice(0, 80) };
    }
    if (!t && !f) throw err(400, 'Nothing to send');
    const re = reply ? log.find((x) => x.id === +reply) : null;
    const m = { id: (log[log.length - 1]?.id || 0) + 1, at: this.now(), from: name, ...(t ? { text: t } : {}), ...(f ? { file: f } : {}),
      ...(re ? { reply: { id: re.id, from: re.from, text: re.deleted ? '' : (re.text || re.file?.name || '').slice(0, 140) } } : {}) };
    log.push(m); this.append(id, m);
    this.markRead(id, name, m.id);
    return { room: r, msg: m };
  }
  del(id, name, msgId, isOwner = false) {
    const r = this.room(id, name), m = this.log(id).find((x) => x.id === +msgId);
    if (!m || m.deleted) throw err(404, 'No such message');
    if (m.from !== name && !isOwner) throw err(403, 'You can delete only your own messages');
    if (m.file) fs.rmSync(this.filePath(id, m.file.id, m.file.ext), { force: true });
    m.deleted = true; delete m.text; delete m.file;
    this.append(id, { del: m.id, by: name, at: this.now() });
    return { room: r, msg: m };
  }
  markRead(id, name, upto) {
    const log = this.log(id), top = log[log.length - 1]?.id || 0, n = Math.min(top, Math.max(0, +upto || 0));
    const mine = (this.read[name] ||= {});
    if (n <= (mine[id] || 0)) return false;
    mine[id] = n; this.save();
    return true;
  }
  unread(name) { return this.list(name).reduce((a, r) => a + r.unread, 0); }
  filePath(id, fid, ext = '') { return path.join(this.dir, 'files', id, `${fid}${String(ext || '').replace(/[^.a-z0-9]/gi, '').toLowerCase()}`); }
  // a new file for a room: where to write it (the message that shows it is sent once it is all here)
  newFile(id, name, fileName) {
    this.room(id, name);
    const fid = crypto.randomBytes(10).toString('hex'), ext = (path.extname(safeName(fileName)).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || [''])[0];
    fs.mkdirSync(path.join(this.dir, 'files', id), { recursive: true });
    return { id: fid, ext, file: this.filePath(id, fid, ext) };
  }
  // a file someone in the room asks for (only one a message of that room still shows)
  fileOf(id, name, fid) {
    this.room(id, name);
    const m = this.log(id).find((x) => x.file?.id === fid);
    if (!m) throw err(404, 'This file was deleted');
    return { path: this.filePath(id, fid, m.file.ext), meta: m.file };
  }
}
