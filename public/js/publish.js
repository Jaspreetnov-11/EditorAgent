// 🚀 Publish: a finished render to YouTube, a Facebook Page and Instagram (Reels) - now or at a set time - with your own
// accounts (engine/publish.mjs). Accounts are connected once (YouTube: your Google OAuth client + sign-in; Facebook /
// Instagram: a token you paste). Nothing is posted until you press Publish and confirm.
import { S } from './store.js';
import { api, enc } from './api.js';
import { $, $$, esc, toast, modal } from './ui.js';
import { openThumbs } from './thumbs.js';

let timer = null;
const STATE = { waiting: 'waiting', scheduled: 'scheduled', uploading: 'uploading', done: '✓ done', failed: 'failed', cancelled: 'cancelled' };
const ICON = { youtube: 'YouTube', facebook: 'f Facebook', instagram: '◎ Instagram' };

export async function openPublish() {
  const dlg = modal('Publish', '<div data-pub><div class="muted pad">Loading…</div></div>', { width: 820, onClose: () => clearTimeout(timer) });
  const body = $('[data-pub]', dlg.el);
  const [acc, renders, thumbs] = await Promise.all([api('GET', '/api/publish/accounts'), api('GET', `/api/renders?p=${enc(S.proj)}`), api('GET', `/api/thumb/list?p=${enc(S.proj)}`).catch(() => [])]);
  const vertical = S.project.settings.aspect === '9:16';
  const pages = acc.meta.pages, igPages = pages.filter((p) => p.ig);
  body.innerHTML = `
    <details class="pub-acc"${acc.youtube.connected || acc.meta.connected ? '' : ' open'}><summary>Accounts: ${acc.youtube.connected ? `${esc(acc.youtube.channel || 'YouTube')}` : 'YouTube not connected'} · ${acc.meta.connected ? `f ${pages.length} Page${pages.length > 1 ? 's' : ''}${igPages.length ? ` · ◎ ${igPages.map((p) => `@${esc(p.ig.username)}`).join(', ')}` : ''}` : 'f / ◎ not connected'}</summary>
      <div class="pub-grid">
        <div><h4>YouTube</h4>${acc.youtube.connected ? `<p class="good">Connected: ${esc(acc.youtube.channel || 'channel')}</p><button class="small" data-disc="youtube">Disconnect</button>` : `
          <ol class="muted small"><li>console.cloud.google.com → new project → enable <b>YouTube Data API v3</b>.</li><li>OAuth consent screen (External, add yourself as test user), then Credentials → <b>OAuth client ID</b> → type <b>Desktop app</b>.</li><li>Paste its Client ID and secret here, press Connect and sign in.</li></ol>
          <label class="fld"><span>Client ID</span><input data-ycid placeholder="…apps.googleusercontent.com"></label><label class="fld"><span>Client secret</span><input data-ycs type="password"></label>
          <button class="small primary" data-ycon>Connect YouTube</button>`}</div>
        <div><h4>f Facebook · ◎ Instagram</h4>${acc.meta.connected ? `<p class="good">Pages: ${pages.map((p) => `${esc(p.name)}${p.ig ? ` (◎ @${esc(p.ig.username)})` : ''}`).join(', ')}</p><button class="small" data-disc="meta">Disconnect</button>` : ''}
          <p class="muted small">Paste a long-lived token (Meta Business Suite → System users, or Graph API Explorer) with <b>pages_show_list, pages_manage_posts, pages_read_engagement</b> and, for Instagram, <b>instagram_basic, instagram_content_publish</b>. It stays only on this computer.</p>
          <label class="fld"><span>Access token</span><input data-mtok type="password" placeholder="EAAB…"></label><button class="small primary" data-mcon>${acc.meta.connected ? 'Replace token' : 'Connect Facebook / Instagram'}</button></div>
      </div></details>
    <div class="pub-grid">
      <div>
        <label class="fld"><span>Video</span><select data-ren>${renders.filter((r) => /\.mp4$/i.test(r.name)).map((r) => `<option>${esc(r.name)}</option>`).join('') || '<option value="">Render the video first (Export)</option>'}</select></label>
        <label class="fld"><span>Title</span><input data-title maxlength="100" value="${esc(S.project.name)}"></label>
        <label class="fld"><span>Description / caption</span><textarea data-desc rows="5" placeholder="What is it about, links, credits…"></textarea></label>
        <label class="fld"><span>Hashtags</span><input data-tags placeholder="#ViksitBharat #MyBharat"></label>
        <div class="row-in"><label class="fld grow"><span>Thumbnail (YouTube, Facebook)</span><select data-thumb><option value="">None</option>${thumbs.map((t) => `<option>${esc(t.name)}</option>`).join('')}</select></label><button class="small" data-mkthumb>Make</button></div>
        <label class="fld"><span>Instagram cover frame at (seconds)</span><input data-cover type="number" min="0" step="0.5" placeholder="0"></label>
      </div>
      <div>
        <h4>Where</h4>
        <label class="chk"><input type="checkbox" data-t="youtube"${acc.youtube.connected ? ' checked' : ' disabled'}> YouTube${vertical ? ' (as a Short)' : ''}</label>
        <label class="fld"><span>YouTube visibility</span><select data-priv><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select></label>
        <label class="chk"><input type="checkbox" data-t="facebook"${pages.length ? '' : ' disabled'}> f Facebook Page</label>
        <select data-fbpage>${pages.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <label class="chk"><input type="checkbox" data-t="instagram"${igPages.length ? '' : ' disabled'}> ◎ Instagram Reel</label>
        <select data-igpage>${igPages.map((p) => `<option value="${p.id}">@${esc(p.ig.username)}</option>`).join('')}</select>
        <h4>When</h4>
        <label class="chk"><input type="radio" name="when" value="now" checked> Now</label>
        <label class="chk"><input type="radio" name="when" value="later"> Later: <input type="datetime-local" data-at></label>
        <p class="muted small">YouTube and Facebook upload now and go live at that time on their own. Instagram is posted by this editor at that time - keep it running.</p>
        <button class="primary big wide" data-go>Publish</button>
      </div>
    </div>
    <h4>Uploads</h4><div class="dv-list" data-hist></div>`;
  const draw = async () => {
    const list = await api('GET', `/api/publish/list?p=${enc(S.proj)}`).catch(() => []);
    $('[data-hist]', body).innerHTML = list.map((x) => `<div class="dv-q-item ${x.state === 'done' ? 'done' : x.state === 'failed' ? 'failed' : x.state === 'uploading' ? 'rendering' : ''}">
      <div class="dv-q-top"><span class="grow"><b>${ICON[x.platform]}</b> · ${esc(x.title)} <span class="muted small">${esc(x.render)}</span></span><span class="muted small">${STATE[x.state]}${x.publishAt ? ` · goes live ${new Date(x.publishAt).toLocaleString()}` : ''}</span>
      ${x.state === 'done' && x.result?.url ? `<a href="${esc(x.result.url)}" target="_blank" rel="noopener">Open </a>` : ''}${['waiting', 'scheduled'].includes(x.state) ? `<button class="link small" data-pc="${x.id}">✕</button>` : ''}${x.state === 'failed' ? `<button class="link small" data-pr="${x.id}" title="Try again">⟳</button>` : ''}</div>
      ${x.state === 'uploading' ? `<div class="bar"><div style="width:${Math.max(3, x.progress)}%"></div></div>` : ''}${x.error ? `<div class="warn small">${esc(x.error)}</div>` : ''}${x.result?.note ? `<div class="muted small">${esc(x.result.note)}</div>` : ''}</div>`).join('') || '<div class="muted">Nothing published from this project yet.</div>';
    clearTimeout(timer);
    if (list.some((x) => ['waiting', 'uploading', 'scheduled'].includes(x.state)) && dlg.el.isConnected) timer = setTimeout(draw, 2000);
  };
  draw();
  body.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    try {
      if (t.dataset.disc) { if (!confirm('Disconnect this account from the editor?')) return; await api('POST', `/api/publish/disconnect?what=${t.dataset.disc}`); dlg.close(); openPublish(); }
      if (t.dataset.ycon !== undefined) {
        const r = await api('PUT', '/api/publish/youtube', { clientId: $('[data-ycid]', body).value, clientSecret: $('[data-ycs]', body).value });
        window.open(r.authUrl, '_blank');
        toast('Sign in to Google in the new tab, then come back here');
        const poll = async () => { const a = await api('GET', '/api/publish/accounts'); if (a.youtube.connected) { toast(`YouTube connected: ${a.youtube.channel || ''}`); dlg.close(); openPublish(); } else if (dlg.el.isConnected) setTimeout(poll, 2500); };
        setTimeout(poll, 4000);
      }
      if (t.dataset.mcon !== undefined) { t.disabled = true; const r = await api('PUT', '/api/publish/meta', { token: $('[data-mtok]', body).value }); toast(`Connected ${r.pages.length} Page${r.pages.length > 1 ? 's' : ''}`); dlg.close(); openPublish(); }
      if (t.dataset.mkthumb !== undefined) openThumbs((r) => { const s = $('[data-thumb]', body); s.append(new Option(r.name, r.name)); s.value = r.name; });
      if (t.dataset.pc) { await api('POST', `/api/publish/cancel?id=${t.dataset.pc}`); draw(); }
      if (t.dataset.pr) { await api('POST', `/api/publish/retry?id=${t.dataset.pr}`); draw(); }
      if (t.dataset.go !== undefined) {
        const later = $('input[name="when"]:checked', body).value === 'later', at = $('[data-at]', body).value;
        if (later && !at) return toast('Pick the date and time', 'err');
        const targets = $$('[data-t]', body).filter((c) => c.checked).map((c) => ({ platform: c.dataset.t, pageId: c.dataset.t === 'facebook' ? $('[data-fbpage]', body).value : c.dataset.t === 'instagram' ? $('[data-igpage]', body).value : undefined, privacy: $('[data-priv]', body).value, publishAt: later ? new Date(at).toISOString() : undefined }));
        if (!targets.length) return toast('Tick where to publish (connect an account first if none can be ticked)', 'err');
        const tags = $('[data-tags]', body).value.split(/[\s,]+/).map((x) => x.replace(/^#/, '')).filter(Boolean);
        const desc = [$('[data-desc]', body).value.trim(), tags.map((x) => `#${x}`).join(' ')].filter(Boolean).join('\n\n');
        const where = targets.map((x) => ICON[x.platform]).join(', ');
        if (!confirm(`Publish "${$('[data-title]', body).value}" to ${where} ${later ? `at ${new Date(at).toLocaleString()}` : 'now'}?\n\nThis posts publicly on your accounts${$('[data-priv]', body).value !== 'public' && targets.some((x) => x.platform === 'youtube') ? ' (YouTube: ' + $('[data-priv]', body).value + ')' : ''}.`)) return;
        await api('POST', `/api/publish?p=${enc(S.proj)}`, { render: $('[data-ren]', body).value, title: $('[data-title]', body).value, description: desc, tags, thumbnail: $('[data-thumb]', body).value || null, coverAt: +$('[data-cover]', body).value || 0, shorts: vertical, targets });
        toast(later ? 'Scheduled - see Uploads below' : 'Uploading - see Uploads below');
        draw();
      }
    } catch (err) { toast(err.message, 'err'); t.disabled = false; }
  });
}
