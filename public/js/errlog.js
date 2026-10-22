// 🛡 Errors in the editor are written down on the editing computer (logs/client-errors.log, POST /api/clientlog) - who,
// which project, what, where - so a problem on any PC can be found and fixed without a screenshot. The same error is
// sent once a minute at most. No imports: everything else may use it.
const sent = new Map();
const projectOf = () => { try { const m = /^#\/p\/(.+)$/.exec(location.hash); return m ? decodeURIComponent(m[1]) : ''; } catch { return ''; } };
export function reportError(where, e) {
  try {
    const msg = String(e?.message || e || 'error').slice(0, 500), stack = String(e?.stack || '').slice(0, 3000);
    // (the browser's own harmless notes - a video play() cut short by a pause / seek, ResizeObserver - are not problems)
    if (/play\(\) request was interrupted|ResizeObserver loop|The operation was aborted|AbortError/i.test(msg)) return;
    const key = `${where}|${msg}`, now = Date.now();
    if (now - (sent.get(key) || 0) < 60000) return;
    sent.set(key, now);
    console.error(`[${where}]`, e);
    fetch('/api/clientlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ where: String(where).slice(0, 120), msg, stack, project: projectOf(), page: location.hash, ua: navigator.userAgent.slice(0, 160) }) }).catch(() => {});
  } catch {}
}
// anything not caught anywhere else
if (typeof window !== 'undefined') {
  window.addEventListener('error', (ev) => { if (ev.error || ev.message) reportError('window', ev.error || ev.message); });
  window.addEventListener('unhandledrejection', (ev) => reportError('promise', ev.reason));
}

// 🛡 a panel that cannot be drawn shows a short note and a Reload button instead of going blank (the rest keeps working)
export function guarded(el, label, fn) {
  try { return fn(); }
  catch (e) {
    reportError(label, e);
    if (el && el.isConnected !== false) {
      el.innerHTML = `<div class="panel-err"><b>${label} could not be shown</b><span>The problem was written to the editor's log. The rest of the editor works.</span><button class="small" data-panel-retry>↻ Reload panel</button></div>`;
      el.querySelector('[data-panel-retry]').onclick = () => guarded(el, label, fn);
    }
    return undefined;
  }
}
