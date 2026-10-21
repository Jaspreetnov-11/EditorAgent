export const enc = encodeURIComponent;

export async function api(method, url, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string') opts.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
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
