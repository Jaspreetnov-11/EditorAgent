export const enc = encodeURIComponent;

export async function api(method, url, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string') opts.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) signedOut();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
// 🔑 the sign-in ended (another computer's team link): a bar at the top with Sign in - instead of things just failing
function signedOut() {
  if (document.getElementById('signedOut')) return;
  const b = document.createElement('div');
  b.id = 'signedOut'; b.className = 'ro-banner'; b.setAttribute('role', 'alert');
  b.innerHTML = 'You are signed out (the editor was restarted or the sign-in ended). <button class="primary small">Sign in</button> <button class="small">Refresh</button>';
  const [inBtn, reBtn] = b.querySelectorAll('button');
  inBtn.onclick = () => { location.href = '/team/logout'; }; reBtn.onclick = () => location.reload();
  document.body.prepend(b);
}

// Upload with progress (fetch has no upload progress).
export function upload(url, file, onProgress) {
  return new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status === 200 ? ok(j) : bad(new Error(j.error || `Upload failed (${x.status})`)); };
    x.onerror = () => bad(new Error('Upload failed - is the editor still running?'));
    x.send(file);
  });
}

// ⬆ A file into a project in 8 MB pieces (POST /api/upload/part): a piece that fails is sent again - up to 6 tries,
// waiting longer each time - and after a break the upload goes on from what already arrived (the same file picked again
// carries on too). An editor not restarted since this came gets the file in one go, as before.
// onProgress({ done, total, rate (bytes/s) }), onRetry(try, seconds), cancelled() -> true stops between pieces.
const PIECE = 8 * 1024 * 1024;
export async function uploadFile(proj, file, { bin = '', onProgress, onRetry, cancelled = () => false } = {}) {
  const id = `${file.size}-${file.lastModified}-${file.name}`;
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(id)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const qs = `p=${enc(proj)}&key=${hash}`, more = `&total=${file.size}&name=${enc(file.name)}${bin ? `&bin=${enc(bin)}` : ''}`;
  let have;
  try { have = (await api('GET', `/api/upload/part?${qs}`)).have || 0; }
  catch { return upload(`/api/upload?p=${enc(proj)}&name=${enc(file.name)}${bin ? `&bin=${enc(bin)}` : ''}`, file, (k) => onProgress?.({ done: k * file.size, total: file.size, rate: 0 })); }
  const t0 = performance.now(), start = have;
  let tries = 0;
  for (;;) {
    if (cancelled()) throw Object.assign(new Error('Upload stopped - pick the same file again to carry on from where it stopped'), { cancelled: true });
    const piece = file.slice(have, Math.min(file.size, have + PIECE));
    try {
      const r = await sendPiece(`/api/upload/part?${qs}&off=${have}${more}`, piece, (k) => {
        const done = have + k * piece.size, secs = (performance.now() - t0) / 1000;
        onProgress?.({ done, total: file.size, rate: secs > 0.5 ? (done - start) / secs : 0 });
      });
      tries = 0;
      if (r.done) { onProgress?.({ done: file.size, total: file.size, rate: 0 }); return r; }
      if (r.have === have && !piece.size) throw new Error('The editor did not take the file');
      have = r.have;
    } catch (e) {
      if (e.fatal || ++tries > 6) throw e;
      const wait = Math.min(30, 2 ** tries);
      onRetry?.(tries, wait);
      await new Promise((ok) => setTimeout(ok, wait * 1000));
      try { have = (await api('GET', `/api/upload/part?${qs}`)).have || 0; } catch {}
    }
  }
}
function sendPiece(url, blob, onProgress) {
  return new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => {
      let j = {}; try { j = JSON.parse(x.responseText); } catch {}
      if (x.status === 200) ok(j);
      else bad(Object.assign(new Error(j.error || `Upload failed (${x.status})`), { fatal: x.status >= 400 && x.status < 500 && x.status !== 408 && x.status !== 429 }));
    };
    x.onerror = () => bad(new Error('The connection dropped'));
    x.ontimeout = () => bad(new Error('The editor took too long to answer'));
    x.timeout = 5 * 60 * 1000;
    x.send(blob);
  });
}

// Poll a background job until it ends. onTick(job) is called every second.
export function watchJob(id, onTick) {
  return new Promise((ok, bad) => {
    const t = setInterval(async () => {
      let j;
      try { j = await api('GET', `/api/job?id=${id}`); } catch (e) { clearInterval(t); return bad(e); }
      onTick?.(j);
      if (j.status === 'running') return;
      clearInterval(t);
      j.status === 'done' ? ok(j) : bad(Object.assign(new Error('Job failed'), { job: j }));
    }, 1000);
  });
}
