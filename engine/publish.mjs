// publish.mjs - upload a finished video to YouTube, a Facebook Page and Instagram (Reels), with your own accounts.
//   YouTube:   OAuth ("installed app": your Google Cloud OAuth client), resumable upload, native schedule (publishAt),
//              custom thumbnail (needs a verified channel)
//   Facebook:  a Page access token (from the token you paste), /{page}/videos upload, native schedule
//   Instagram: the IG account linked to that Page, Reels by resumable upload from this computer (no public URL),
//              then publish. Instagram has no scheduling in its API: a later time is kept by the editor's own scheduler.
// Nothing here runs on its own: the server calls it when you press Publish (or at the time you set).
import fs from 'node:fs';
import path from 'node:path';

const GRAPH = process.env.GRAPH_BASE || 'https://graph.facebook.com/v23.0';
const GRAPH_VIDEO = process.env.GRAPH_VIDEO_BASE || 'https://graph-video.facebook.com/v23.0';
const G_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const G_TOKEN = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const YT = process.env.YOUTUBE_BASE || 'https://www.googleapis.com';
const YT_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

async function json(r, what) {
  const t = await r.text();
  let j = {}; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok || j.error) {
    const e = j.error?.error_user_msg || j.error?.message || j.error_description || (typeof j.error === 'string' ? j.error : '') || t.slice(0, 200) || r.statusText;
    throw new Error(`${what}: ${e}`);
  }
  return j;
}

// ---------------- YouTube ----------------
export const youtubeAuthUrl = ({ clientId, redirect }) => `${G_AUTH}?${new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: YT_SCOPES, access_type: 'offline', prompt: 'consent' })}`;
export async function youtubeExchange({ clientId, clientSecret, redirect, code }) {
  const j = await json(await fetch(G_TOKEN, { method: 'POST', body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }) }), 'Google sign-in');
  if (!j.refresh_token) throw new Error('Google did not give a refresh token - remove the app at myaccount.google.com/permissions and connect again');
  return j;
}
async function youtubeAccess(cfg) {
  const j = await json(await fetch(G_TOKEN, { method: 'POST', body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token' }) }), 'YouTube sign-in');
  return j.access_token;
}
export async function youtubeChannel(cfg) {
  const tok = await youtubeAccess(cfg);
  const j = await json(await fetch(`${YT}/youtube/v3/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${tok}` } }), 'YouTube channel');
  return j.items?.[0]?.snippet?.title || 'YouTube channel';
}
// opts: { title, description, tags[], privacy: public|unlisted|private, publishAt (ISO, makes it private until then), thumbnail (png path), shorts }
export async function youtubeUpload(cfg, file, opts, onProgress = () => {}) {
  const tok = await youtubeAccess(cfg), size = fs.statSync(file).size;
  const status = { privacyStatus: opts.publishAt ? 'private' : opts.privacy || 'public', selfDeclaredMadeForKids: false, ...(opts.publishAt ? { publishAt: new Date(opts.publishAt).toISOString() } : {}) };
  const title = (opts.shorts && !/#shorts/i.test(opts.title) ? `${opts.title} #Shorts` : opts.title).slice(0, 100);
  const start = await fetch(`${YT}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' },
    body: JSON.stringify({ snippet: { title, description: opts.description || '', tags: (opts.tags || []).slice(0, 30), categoryId: opts.categoryId || '22' }, status }),
  });
  if (!start.ok) await json(start, 'YouTube upload');
  const loc = start.headers.get('location');
  if (!loc) throw new Error('YouTube did not start the upload');
  // the file in 16 MB pieces, so progress shows and a big file never sits in memory
  const CH = 16 * 1024 * 1024, fd = fs.openSync(file, 'r');
  let off = 0, video = null;
  try {
    while (off < size) {
      const n = Math.min(CH, size - off), buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, off);
      const r = await fetch(loc, { method: 'PUT', headers: { 'Content-Length': String(n), 'Content-Range': `bytes ${off}-${off + n - 1}/${size}` }, body: buf });
      if (r.status === 308) { const rg = /bytes=0-(\d+)/.exec(r.headers.get('range') || ''); off = rg ? +rg[1] + 1 : off + n; }
      else { video = await json(r, 'YouTube upload'); off = size; }
      onProgress(Math.min(0.97, off / size));
    }
  } finally { fs.closeSync(fd); }
  if (!video?.id) throw new Error('YouTube upload did not finish');
  let note = '';
  if (opts.thumbnail && fs.existsSync(opts.thumbnail)) {
    const r = await fetch(`${YT}/upload/youtube/v3/thumbnails/set?videoId=${video.id}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'image/png' }, body: fs.readFileSync(opts.thumbnail) });
    if (!r.ok) note = 'thumbnail not set (YouTube allows custom thumbnails only on verified channels)';
  }
  return { id: video.id, url: `https://www.youtube.com/watch?v=${video.id}`, note };
}

// ---------------- Facebook / Instagram ----------------
// the Pages (and their Instagram accounts) a pasted user / system-user token can post to
export async function metaPages(token) {
  const j = await json(await fetch(`${GRAPH}/me/accounts?${new URLSearchParams({ fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100', access_token: token })}`), 'Facebook');
  return (j.data || []).map((p) => ({ id: p.id, name: p.name, token: p.access_token, ig: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username } : null }));
}
// opts: { title, description, publishAt (ISO; 10 min - 75 days ahead), thumbnail }
export async function facebookUpload(page, file, opts, onProgress = () => {}) {
  const fd = new FormData();
  fd.append('access_token', page.token);
  fd.append('title', (opts.title || '').slice(0, 250));
  fd.append('description', opts.description || '');
  if (opts.publishAt) { fd.append('published', 'false'); fd.append('scheduled_publish_time', String(Math.floor(new Date(opts.publishAt).getTime() / 1000))); }
  fd.append('source', await fs.openAsBlob(file, { type: 'video/mp4' }), path.basename(file));
  if (opts.thumbnail && fs.existsSync(opts.thumbnail)) fd.append('thumb', await fs.openAsBlob(opts.thumbnail, { type: 'image/png' }), 'thumb.png');
  onProgress(0.1);
  const j = await json(await fetch(`${GRAPH_VIDEO}/${page.id}/videos`, { method: 'POST', body: fd }), 'Facebook upload');
  return { id: j.id, url: `https://www.facebook.com/${page.id}/videos/${j.id}` };
}
// opts: { caption, thumbOffsetMs, shareToFeed }
export async function instagramUpload(page, file, opts, onProgress = () => {}) {
  if (!page.ig) throw new Error(`The Page "${page.name}" has no Instagram business account linked`);
  const size = fs.statSync(file).size;
  const c = await json(await fetch(`${GRAPH}/${page.ig.id}/media`, { method: 'POST', body: new URLSearchParams({ media_type: 'REELS', upload_type: 'resumable', caption: (opts.caption || '').slice(0, 2200), share_to_feed: String(opts.shareToFeed !== false), ...(opts.thumbOffsetMs ? { thumb_offset: String(Math.round(opts.thumbOffsetMs)) } : {}), access_token: page.token }) }), 'Instagram');
  if (!c.uri) throw new Error('Instagram did not give an upload address');
  onProgress(0.1);
  await json(await fetch(c.uri, { method: 'POST', headers: { Authorization: `OAuth ${page.token}`, offset: '0', file_size: String(size) }, body: await fs.openAsBlob(file) }), 'Instagram upload');
  onProgress(0.6);
  // Instagram processes the video, then it can be published
  for (let i = 0; i < 120; i++) {
    const s = await json(await fetch(`${GRAPH}/${c.id}?${new URLSearchParams({ fields: 'status_code,status', access_token: page.token })}`), 'Instagram');
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram could not process the video: ${s.status || s.status_code}`);
    onProgress(0.6 + Math.min(0.3, i * 0.01));
    await new Promise((ok) => setTimeout(ok, process.env.GRAPH_BASE ? 50 : 5000));
  }
  const p = await json(await fetch(`${GRAPH}/${page.ig.id}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: c.id, access_token: page.token }) }), 'Instagram publish');
  let url = `https://www.instagram.com/${page.ig.username || ''}`;
  try { const m = await json(await fetch(`${GRAPH}/${p.id}?${new URLSearchParams({ fields: 'permalink', access_token: page.token })}`), 'Instagram'); if (m.permalink) url = m.permalink; } catch {}
  return { id: p.id, url };
}
