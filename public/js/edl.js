// 📄 Export EDL (File menu): the open sequence as a CMX 3600 edit decision list - what colourists (Resolve, Baselight)
// and older systems conform from. One event per clip: the main story (V1) as video events, A1 / A2 sound as audio
// events (A, A2), a speed other than 1x as an M2 line, the full file name and path as comments. CMX 3600 has one video
// track, so overlays (V2 and up), titles and graphics are listed as comments only; gaps are left out (the record
// timecodes jump). Timecodes are non-drop at the sequence frame rate, sources counted from 00:00:00:00 of their file.
// (buildEDL needs no browser - the editor's store and toasts come in only for exportEDL)
export function buildEDL(project, media, L) {
  const fps = Math.round(project.settings.fps || 30);
  const tc = (sec) => { const f = Math.max(0, Math.round(sec * fps)); return [Math.floor(f / (fps * 3600)), Math.floor(f / (fps * 60)) % 60, Math.floor(f / fps) % 60, f % fps].map((x) => String(x).padStart(2, '0')).join(':'); };
  const reels = new Map();
  const reel = (m) => {
    if (!reels.has(m.id)) { let r = String(m.name || 'AX').replace(/\.[^.]+$/, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'AX'; while ([...reels.values()].includes(r)) r = `${r.slice(0, 6)}${String(reels.size).padStart(2, '0')}`; reels.set(m.id, r); }
    return reels.get(m.id);
  };
  const lines = [`TITLE: ${(project.seq?.name || project.name || 'SEQUENCE').toUpperCase().slice(0, 60)}`, 'FCM: NON-DROP FRAME', ''];
  let n = 0;
  const event = (x, ch) => {
    const c = x.clip, m = media[c.mediaId]; if (!m || c.gap) return;
    const sp = c.speed || 1, len = x.end - x.start - (ch === 'V' ? x.overlap || 0 : 0), rs = x.start + (ch === 'V' ? x.overlap || 0 : 0);
    const sIn = (c.in || 0) + (ch === 'V' ? (x.overlap || 0) * sp : 0), sOut = sIn + len * sp;
    n++;
    lines.push(`${String(n).padStart(3, '0')}  ${reel(m).padEnd(8)} ${ch.padEnd(5)} C        ${tc(sIn)} ${tc(sOut)} ${tc(rs)} ${tc(rs + len)}`);
    if (Math.abs(sp - 1) > 1e-3) lines.push(`M2   ${reel(m).padEnd(8)}       ${(fps * sp).toFixed(1).padStart(5, '0')}    ${tc(sIn)}`);
    if (c.transitionIn?.type && c.transitionIn.type !== 'cut') lines.push(`* TRANSITION: ${c.transitionIn.type} ${(+c.transitionIn.dur || 0).toFixed(2)} s INTO THIS CLIP`);
    lines.push(`* FROM CLIP NAME: ${m.name}`, `* SOURCE FILE: ${m.path || ''}`, '');
  };
  for (const x of L.V1 || []) if (x.clip.type === 'video' && !x.clip.disabled) event(x, 'V');
  for (const [t, ch] of [['A1', 'A'], ['A2', 'A2']]) for (const x of L[t] || []) if (x.clip.type === 'audio' && !x.clip.disabled) event(x, ch);
  const skipped = Object.entries(L).flatMap(([t, l]) => (t === 'V1' || t === 'A1' || t === 'A2' ? l.filter((x) => !['video', 'audio'].includes(x.clip.type) && !x.clip.gap) : t[0] === 'V' ? l : []).map((x) => [t, x]));
  if (skipped.length) lines.push('* NOT IN THIS EDL (CMX 3600 has one picture track):', ...skipped.map(([t, x]) => `*   ${t} ${tc(x.start)}-${tc(x.end)} ${x.clip.type}${x.clip.mediaId && media[x.clip.mediaId] ? ` ${media[x.clip.mediaId].name}` : ''}`));
  return { text: `${lines.join('\r\n')}\r\n`, events: n, skipped: skipped.length };
}

export async function exportEDL() {
  const [{ S, layout }, { toast }] = await Promise.all([import('./store.js'), import('./ui.js')]);
  if (!S.project) return;
  const r = buildEDL(S.project, S.mediaById, layout());
  if (!r.events) return toast('Nothing on V1 / A1 / A2 to put in an EDL', 'err');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([r.text], { type: 'text/plain' }));
  a.download = `${(S.project.seq?.name || S.project.name || 'sequence').replace(/[\\/:*?"<>|]+/g, '_')}.edl`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`EDL with ${r.events} events saved${r.skipped ? ` (${r.skipped} overlay / title clips listed as comments - CMX 3600 has one picture track)` : ''}`);
}
