// 🖼 Thumbnail maker: the best frames of the video (sharp, a big clear face, colourful - engine/thumbpick.py), then a
// designer: headline (*word* = highlighted), small line, style, size, face zoom, colour pop and logo. Saved as PNG in
// <project>/output/thumbnails and offered to 🚀 Publish.
import { ic } from './lineicons.js';
import { S } from './store.js';
import { api, enc, watchJob } from './api.js';
import { $, $$, esc, toast, modal } from './ui.js';

export const THUMB_SIZES = { yt: ['YouTube 1280×720', 1280, 720], reel: ['Reel / Shorts cover 1080×1920', 1080, 1920], square: ['Square 1080×1080', 1080, 1080] };
const STYLES = {
  news: { label: 'News bold', text: '#ffffff', hi: '#ffe600', stroke: '#000000', band: '#d90429', bandText: '#ffffff' },
  mygov: { label: 'MyGov', text: '#ffffff', hi: '#ff9933', stroke: 'rgba(0,0,0,0)', panel: '#0b2545', band: '#138808', bandText: '#ffffff' },
  clean: { label: 'Clean', text: '#ffffff', hi: '#ffd166', stroke: 'rgba(0,0,0,0)', shade: true, band: null },
  bold: { label: 'Big words', text: '#111111', hi: '#111111', box: '#ffe600', stroke: 'rgba(0,0,0,0)', band: '#111111', bandText: '#ffffff' },
};
const FONT = (px, w = 900) => `${w} ${Math.round(px)}px "Nirmala UI", Impact, "Arial Black", sans-serif`;

// "*Vikas* ki nayi raah" -> words with a highlight flag; wrapped to fit `maxW` in at most `maxLines`, as big as fits
function layoutHeadline(ctx, text, maxW, maxH, maxLines) {
  const words = String(text || '').replace(/\n/g, ' \n ').split(/\s+/).filter(Boolean).map((w) => ({ w: w.replace(/\*/g, ''), hi: /\*/.test(w), nl: w === '\n' }));
  let px = maxH / Math.max(1, Math.min(maxLines, 2)) / 1.15;
  for (; px > 12; px *= 0.94) {
    ctx.font = FONT(px);
    const lines = [[]]; let lw = 0;
    for (const x of words) {
      if (x.nl) { lines.push([]); lw = 0; continue; }
      const ww = ctx.measureText(`${x.w} `).width;
      if (lw + ww > maxW && lines[lines.length - 1].length) { lines.push([]); lw = 0; }
      lines[lines.length - 1].push(x); lw += ww;
    }
    const L = lines.filter((l) => l.length);
    if (L.length <= maxLines && L.length * px * 1.12 <= maxH && L.every((l) => ctx.measureText(l.map((x) => x.w).join(' ')).width <= maxW)) return { px, lines: L };
  }
  return { px, lines: [words.filter((x) => !x.nl)] };
}

export function drawThumb(ctx, Wd, Hd, d, img, logo) {
  const st = STYLES[d.style] || STYLES.news, vert = Hd > Wd;
  ctx.clearRect(0, 0, Wd, Hd);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, Wd, Hd);
  // picture: covers the frame; zoomed on the face and the face put where the layout wants it
  if (img) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, f = d.face;
    let z = Math.max(Wd / iw, Hd / ih) * (d.zoom || 1);
    let fx = 0.5, fy = 0.5, tx = 0.5, ty = 0.45;
    if (f) { fx = f[0] + f[2] / 2; fy = f[1] + f[3] / 2; }
    const side = d.facePos || (vert ? 'center' : st.panel ? 'right' : 'right');
    tx = side === 'left' ? 0.3 : side === 'center' ? 0.5 : 0.7; if (vert) ty = 0.38;
    let x = Wd * tx - fx * iw * z, y = Hd * ty - fy * ih * z;
    x = Math.min(0, Math.max(Wd - iw * z, x)); y = Math.min(0, Math.max(Hd - ih * z, y));
    ctx.save();
    const pop = d.pop ?? 0.5;
    ctx.filter = `contrast(${1 + 0.25 * pop}) saturate(${1 + 0.45 * pop}) brightness(${1 + 0.06 * pop})`;
    ctx.drawImage(img, x, y, iw * z, ih * z);
    ctx.restore();
  }
  const pad = Math.min(Wd, Hd) * 0.05;
  // text area by style
  let area;
  if (st.panel && !vert) {
    const pw = Wd * 0.46, gr = ctx.createLinearGradient(0, 0, pw * 1.25, 0);
    gr.addColorStop(0, st.panel); gr.addColorStop(0.8, st.panel); gr.addColorStop(1, 'rgba(11,37,69,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, pw * 1.25, Hd);
    area = { x: pad, y: pad * 1.2, w: pw - pad * 1.5, h: Hd * 0.62 };
  } else if (vert) {
    const g2 = ctx.createLinearGradient(0, Hd * 0.45, 0, Hd); g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = g2; ctx.fillRect(0, Hd * 0.45, Wd, Hd * 0.55);
    area = { x: pad, y: Hd * 0.6, w: Wd - pad * 2, h: Hd * 0.24 };
  } else {
    if (st.shade) { const g2 = ctx.createLinearGradient(0, Hd * 0.3, 0, Hd); g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,0.8)'); ctx.fillStyle = g2; ctx.fillRect(0, 0, Wd, Hd); }
    area = st.shade ? { x: pad, y: Hd * 0.5, w: Wd * 0.75, h: Hd * 0.32 } : { x: pad, y: pad, w: Wd * 0.58, h: Hd * 0.62 };
  }
  // headline
  const H = layoutHeadline(ctx, d.headline || '', area.w, area.h, vert ? 4 : 3);
  ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
  H.lines.forEach((line, li) => {
    let x = area.x; const y = area.y + li * H.px * 1.1;
    ctx.font = FONT(H.px);
    for (const wd of line) {
      const ww = ctx.measureText(wd.w).width, sp = ctx.measureText(' ').width;
      if (st.box && wd.hi) { ctx.fillStyle = st.box; ctx.fillRect(x - H.px * 0.08, y - H.px * 0.02, ww + H.px * 0.16, H.px * 1.06); }
      else if (st.box) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x - H.px * 0.08, y - H.px * 0.02, ww + H.px * 0.16 + sp, H.px * 1.06); }
      if (st.stroke !== 'rgba(0,0,0,0)') { ctx.strokeStyle = st.stroke; ctx.lineWidth = H.px * 0.16; ctx.strokeText(wd.w, x, y); }
      if (st.shade || st.panel) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = H.px * 0.12; }
      ctx.fillStyle = wd.hi ? st.hi : st.text; ctx.fillText(wd.w, x, y);
      ctx.shadowBlur = 0;
      x += ww + sp;
    }
  });
  // small line: in a band at the bottom (or under the headline)
  if (d.sub) {
    const bh = Math.min(Wd, Hd) * 0.095, by = vert ? Hd * 0.86 : Hd - bh - pad * 0.6;
    ctx.font = FONT(bh * 0.55, 800);
    const tw = Math.min(ctx.measureText(d.sub).width, Wd - pad * 3);
    if (st.band) { ctx.fillStyle = st.band; ctx.fillRect(pad * 0.6, by, tw + pad * 1.2, bh); }
    ctx.fillStyle = st.band ? st.bandText : st.text; ctx.textBaseline = 'middle';
    ctx.fillText(d.sub, pad * 1.2, by + bh / 2, Wd - pad * 3);
  }
  if (d.style === 'mygov') { const s = Math.max(4, Hd * 0.012); ['#ff9933', '#ffffff', '#138808'].forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(0, Hd - s * (3 - i), Wd, s); }); }
  if (logo && d.logo !== false) {
    const lw = Math.min(Wd, Hd) * 0.16, lh = (lw * (logo.naturalHeight || 1)) / (logo.naturalWidth || 1);
    ctx.drawImage(logo, Wd - lw - pad * 0.6, pad * 0.6, lw, lh);
  }
}

const loadImg = (src) => new Promise((ok) => { if (!src) return ok(null); const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });

export async function openThumbs(onSaved) {
  const d = { size: S.project.settings.aspect === '9:16' ? 'reel' : 'yt', style: 'news', headline: S.project.name, sub: '', zoom: 1, pop: 0.5, facePos: '', logo: true, face: null };
  const dlg = modal('Thumbnail', `<div class="th-wrap">
    <div class="th-left"><div class="row-in"><b class="grow">Best frames</b><button class="small" data-th-find>Find</button></div><div class="th-frames" data-frames><div class="muted pad">Looking for the best frames…</div></div></div>
    <div class="th-mid"><canvas data-cv></canvas></div>
    <div class="th-right">
      <label class="fld"><span>Size</span><select data-k="size">${Object.entries(THUMB_SIZES).map(([k, x]) => `<option value="${k}">${x[0]}</option>`).join('')}</select></label>
      <label class="fld"><span>Style</span><select data-k="style">${Object.entries(STYLES).map(([k, x]) => `<option value="${k}">${x.label}</option>`).join('')}</select></label>
      <label class="fld"><span>Headline - put *stars* around words to highlight</span><textarea data-k="headline" rows="3"></textarea></label>
      <label class="fld"><span>Small line (band)</span><input data-k="sub" placeholder="e.g. EXCLUSIVE · पूरी बातचीत"></label>
      <label class="fld"><span>Face zoom</span><input type="range" min="1" max="2.5" step="0.05" data-k="zoom"></label>
      <label class="fld"><span>Face on the</span><select data-k="facePos"><option value="">Auto</option><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></label>
      <label class="fld"><span>Colour pop</span><input type="range" min="0" max="1" step="0.05" data-k="pop"></label>
      <label class="chk"><input type="checkbox" data-k="logo"> Project logo</label>
      <div class="dv-actions"><button class="primary" data-th-save>Save thumbnail</button></div>
      <div class="dv-list" data-saved></div></div></div>`, { width: 1180 });
  const cv = $('[data-cv]', dlg.el), ctx = cv.getContext('2d');
  let img = null, frames = [];
  const logoM = S.project.logo?.mediaId && S.mediaById[S.project.logo.mediaId];
  const logo = await loadImg(logoM ? logoM.urls.play : null);
  const draw = () => { const [, w, h] = THUMB_SIZES[d.size]; cv.width = w; cv.height = h; cv.style.aspectRatio = `${w}/${h}`; drawThumb(ctx, w, h, d, img, logo); };
  $$('[data-k]', dlg.el).forEach((el) => {
    const k = el.dataset.k;
    if (el.type === 'checkbox') el.checked = !!d[k]; else el.value = d[k] ?? '';
    el.addEventListener('input', () => { d[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value; draw(); });
  });
  const pick = async (i) => {
    const f = frames[i]; if (!f) return;
    $$('[data-fi]', dlg.el).forEach((b) => b.classList.toggle('on', +b.dataset.fi === i));
    img = await loadImg(f.url); d.face = f.face;
    d.zoom = f.face ? Math.min(2.2, Math.max(1, 0.38 / f.face[3])) : 1; $('[data-k="zoom"]', dlg.el).value = d.zoom;
    draw();
  };
  const find = async () => {
    $('[data-frames]', dlg.el).innerHTML = '<div class="muted pad">Looking for the best frames…</div>';
    try {
      const job = await api('POST', `/api/thumb/frames?p=${enc(S.proj)}`, {});
      const r = (await watchJob(job.id)).result;
      frames = r.frames;
      $('[data-frames]', dlg.el).innerHTML = frames.map((f, i) => `<button class="th-f" data-fi="${i}" title="${esc(f.src)} at ${f.t}s${f.face ? ' · face' : ''}"><img src="${f.url}" alt=""></button>`).join('') + `<div class="muted small">From: ${esc(r.from)}</div>`;
      pick(0);
    } catch (e) { $('[data-frames]', dlg.el).innerHTML = `<div class="warn pad">${esc(e.job ? e.job.log.slice(-1).join(' ') : e.message)}</div>`; }
  };
  $('[data-frames]', dlg.el).addEventListener('click', (e) => { const b = e.target.closest('[data-fi]'); if (b) pick(+b.dataset.fi); });
  $('[data-th-find]', dlg.el).onclick = find;
  const listSaved = async () => {
    const l = await api('GET', `/api/thumb/list?p=${enc(S.proj)}`).catch(() => []);
    $('[data-saved]', dlg.el).innerHTML = l.slice(0, 6).map((x) => `<div class="dv-item"><a href="${x.url}" target="_blank" class="link">${esc(x.name)}</a><a href="${x.url}?download" download>${ic('download')}</a></div>`).join('');
  };
  $('[data-th-save]', dlg.el).onclick = async () => {
    draw();
    const blob = await new Promise((ok) => cv.toBlob(ok, 'image/png'));
    const r = await fetch(`/api/thumb/save?p=${enc(S.proj)}&name=${enc(`${S.project.name} ${d.size}`)}`, { method: 'POST', body: blob }).then((x) => x.json());
    toast(`Saved ${r.name}`); listSaved(); onSaved?.(r);
  };
  draw(); listSaved(); find();
}
