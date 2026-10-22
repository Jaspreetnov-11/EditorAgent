// 🔗 Client review links (Frame.io style): one secret link per render a client should watch, opened from anywhere through
// the team door (https://<domain>/review/<token>) without a team sign-in. The link shows only its own render(s) - never
// project data or other files. Here: the pieces server.mjs uses (store, token / password checks, cleaning what a
// client sends, rate limits), kept apart so the tests can check them.
// A link: { id, token, project, title, client, pw: { salt, hash } | null, expires, created, by, off,
//   versions: [{ n, render, at, status: 'waiting' | 'changes' | 'approved', decidedBy, decidedAt }],
//   comments: [{ id, v, t, text, by, at, parent, draw, team }] }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TOKEN_BYTES = 32; // 256 bits -> 43 characters
export const MAX_COMMENTS = 1500, MAX_TEXT = 2000, MAX_NAME = 60, MAX_BODY = 16384;
export const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url');
export const newId = () => crypto.randomBytes(5).toString('hex');
const digest = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
// 🔒 constant time: both sides hashed to 32 bytes first, so neither the length nor the first wrong letter shows in the timing
export const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && crypto.timingSafeEqual(digest(a), digest(b));
export const tokenShape = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(t);
// every link is compared (no early stop), so how long it takes says nothing about which tokens exist
export function findLink(links, token) {
  if (!tokenShape(token)) return null;
  let hit = null;
  for (const l of links) if (sameSecret(l.token, token) && !hit) hit = l;
  return hit;
}

export const hashPw = (pw, salt = crypto.randomBytes(12).toString('hex')) => ({ salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') });
export const pwOk = (pw, rec) => !rec || (typeof pw === 'string' && sameSecret(hashPw(pw, rec.salt).hash, rec.hash));
// the cookie a client gets after typing the password: bound to the link and its password (a new password signs them out)
export const pwCookie = (secret, link) => crypto.createHmac('sha256', secret).update(`${link.id}:${link.pw?.hash || ''}`).digest('base64url');

// 🧹 what a client sends: plain text only (no control characters), trimmed and cut to size; the page and the editor
// escape it again when they show it
export const cleanText = (s, max = MAX_TEXT) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g, '').trim().slice(0, max);
export const cleanName = (s) => cleanText(s, MAX_NAME).replace(/\s+/g, ' ');
// a drawing on the frame: up to 30 strokes, 1200 points in all, each point 0…1 across / down
export function cleanDraw(d) {
  if (!Array.isArray(d)) return null;
  const out = []; let pts = 0;
  for (const s of d.slice(0, 30)) {
    if (!Array.isArray(s)) continue;
    const st = [];
    for (let i = 0; i + 1 < s.length && pts < 1200; i += 2) {
      const x = +s[i], y = +s[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      st.push(Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000, Math.round(Math.min(1, Math.max(0, y)) * 1000) / 1000); pts++;
    }
    if (st.length >= 4) out.push(st);
  }
  return out.length ? out : null;
}

// 🎬 a render is kept by its file name only: no folders, no "..", a video file. The file is served from the project's
// renders folder by that name - nothing else can be reached through a link.
export function renderName(n) {
  const s = String(n ?? '');
  if (!s || s !== path.basename(s) || /[\\/:\0]/.test(s) || s.startsWith('.') || s.includes('..')) return null;
  return /\.(mp4|m4v|webm|mov)$/i.test(s) && s !== '_preview.mp4' ? s : null;
}
export function renderPath(rendersDir, n) {
  const f = renderName(n); if (!f) return null;
  const full = path.resolve(rendersDir, f), dir = path.resolve(rendersDir);
  return path.dirname(full) === dir ? full : null;
}

export const expired = (l, now = Date.now()) => !!l.off || (!!l.expires && now > l.expires);
export const latest = (l) => l.versions[l.versions.length - 1] || null;
// what the client's page sees: no project name, no file paths, no password hash, no other links
export function clientView(l) {
  return { title: l.title, client: l.client || '', expires: l.expires || null,
    versions: l.versions.map(({ n, at, status, decidedBy, decidedAt }) => ({ n, at, status, decidedBy: decidedBy || '', decidedAt: decidedAt || null })),
    comments: l.comments.map(({ id, v, t, text, by, at, parent, draw, team }) => ({ id, v, t, text, by, at, parent: parent || null, draw: draw || null, team: !!team })) };
}
// what the editor sees (the owner / team): everything but the password hash
export function ownerView(l, url) {
  const { pw, token, ...rest } = l;
  return { ...rest, url, hasPw: !!pw, expired: expired(l) };
}

// 🚦 a simple sliding-window limit: hit(key, max, ms) is false once key was used max times in the last ms
export class Limiter {
  constructor() { this.m = new Map(); }
  hit(key, max, ms, now = Date.now()) {
    const a = (this.m.get(key) || []).filter((t) => now - t < ms);
    if (a.length >= max) { this.m.set(key, a); return false; }
    a.push(now); this.m.set(key, a);
    if (this.m.size > 5000) for (const [k, v] of this.m) if (!v.length || now - v[v.length - 1] > 3600e3) this.m.delete(k);
    return true;
  }
}

// a request body of at most max bytes (a bigger one is stopped while it arrives: 413)
export const readLimited = (req, max = MAX_BODY) => new Promise((ok, bad) => {
  if (+req.headers['content-length'] > max) { req.resume(); return bad(Object.assign(new Error('Too long'), { code: 413 })); }
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > max) { req.destroy(); bad(Object.assign(new Error('Too long'), { code: 413 })); } else chunks.push(c); });
  req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
  req.on('error', bad);
});

// 📁 the links of every project, in one file next to the projects (only the main process writes it)
export class ReviewStore {
  constructor(file) { this.file = file; this.load(); }
  load() {
    let x = null; try { x = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.secret = x?.secret || crypto.randomBytes(24).toString('hex');
    this.links = Array.isArray(x?.links) ? x.links : [];
    if (!x?.secret) this.save();
  }
  save() { const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ secret: this.secret, links: this.links }, null, 1)); fs.renameSync(tmp, this.file); }
  byId(id) { return this.links.find((l) => l.id === id) || null; }
  ofProject(p) { return this.links.filter((l) => l.project === p); }
  create({ project, render, title, client, password, days, by }) {
    const r = renderName(render); if (!r) throw Object.assign(new Error('Pick a finished video'), { code: 400 });
    const l = { id: newId(), token: newToken(), project, title: cleanText(title, 120) || r.replace(/\.[^.]+$/, ''), client: cleanName(client),
      pw: password ? hashPw(password) : null, expires: +days > 0 ? Date.now() + Math.min(365, +days) * 864e5 : null, created: Date.now(), by: cleanName(by),
      off: false, versions: [{ n: 1, render: r, at: Date.now(), status: 'waiting' }], comments: [] };
    this.links.push(l); this.save(); return l;
  }
  addVersion(l, render) {
    const r = renderName(render); if (!r) throw Object.assign(new Error('Pick a finished video'), { code: 400 });
    const v = { n: (latest(l)?.n || 0) + 1, render: r, at: Date.now(), status: 'waiting' };
    l.versions.push(v); l.off = false; this.save(); return v;
  }
}
