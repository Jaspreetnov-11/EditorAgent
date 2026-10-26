// 💬 A project's chat beside the editor - shown only while a project is open (setProject; none: no button, panel closed): a 💬 button with the unread count, and a side panel with /chat.html in it.
// The chat page is loaded at once (hidden), so the count, the sound and the notifications come while the panel is
// closed. tabs.js puts the button in the tab strip; main.js uses it when the editor runs without tabs (and an editor in
// a tab asks the strip to open it - postMessage { chat: 'open' }).
const CSS = `
.cd-btn { position: relative; align-self: center; margin: 0 8px; border: 1px solid #ffc21a66; background: #ffc21a1a; color: #ffc21a; height: 24px; padding: 0 10px 0 8px; border-radius: 12px;
  display: flex; align-items: center; gap: 6px; cursor: pointer; app-region: no-drag; flex: none; font: 600 12px/1 "Segoe UI", system-ui, sans-serif; }
.cd-btn:hover, .cd-btn.on { background: #ffc21a; color: #141000; }
.cd-btn svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linejoin: round; stroke-linecap: round; }
.cd-btn b { min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box; border-radius: 8px; background: #ff5a4f; color: #fff;
  font: 700 10px/16px "Segoe UI", system-ui, sans-serif; text-align: center; }
.cd-btn b[hidden], .cd-btn[hidden] { display: none; }
.cd-btn.cd-float { position: fixed; right: 16px; bottom: 16px; width: 52px; height: 52px; padding: 0; justify-content: center; border: 0; border-radius: 50%; background: #ffc21a; color: #141000; z-index: 9000; box-shadow: 0 6px 20px #000a; }
.cd-btn.cd-float span { display: none; }
.cd-btn.cd-float b { position: absolute; }
.cd-btn.cd-float:hover { background: #ffcd45; color: #141000; }
.cd-btn.cd-float svg { width: 24px; height: 24px; }
.cd-btn.cd-float b { background: #ff5a4f; color: #fff; top: 2px; right: 2px; }
@media (max-width: 760px) { .cd-btn.cd-float { bottom: calc(76px + env(safe-area-inset-bottom)); width: 46px; height: 46px; } }
@media print { .cd-btn, .cd-panel { display: none; } }
.cd-panel { position: fixed; top: var(--cd-top, 0px); right: 0; bottom: 0; width: min(440px, 100vw); z-index: 9001; background: #0b0b0c; border-left: 1px solid #26262b;
  box-shadow: -10px 0 40px #000a; transform: translateX(105%); transition: transform .18s ease-out; visibility: hidden; }
.cd-panel.on { transform: none; visibility: visible; }
.cd-panel iframe { width: 100%; height: 100%; border: 0; display: block; background: #0b0b0c; }
`;
const ICON = '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>';

// after: the element the button goes right after (none: a round button at the bottom right); top: the panel starts below
export function mountChatDock({ after = null, top = 0 } = {}) {
  document.head.append(Object.assign(document.createElement('style'), { textContent: CSS }));
  const btn = document.createElement('button');
  btn.className = `cd-btn${after ? '' : ' cd-float'}`; btn.title = 'Project chat'; btn.setAttribute('aria-label', 'Project chat'); btn.hidden = true;
  btn.innerHTML = `${ICON}<span>Chat</span><b hidden></b>`;
  if (after) after.after(btn); else document.body.append(btn);
  const panel = document.createElement('div'); panel.className = 'cd-panel'; panel.style.setProperty('--cd-top', `${top}px`);
  panel.innerHTML = '<iframe src="/chat.html?embed=1" title="Project chat" allow="clipboard-write; autoplay"></iframe>';
  document.body.append(panel);
  const frame = panel.querySelector('iframe'), badge = btn.querySelector('b');
  let project = null, ready = false;
  const tell = () => { if (ready) frame.contentWindow?.postMessage({ chat: 'project', project }, location.origin); };
  const show = (on) => {
    panel.classList.toggle('on', on); btn.classList.toggle('on', on);
    frame.contentWindow?.postMessage({ chat: 'shown', on }, location.origin);
    if (on) frame.focus();
  };
  btn.onclick = () => show(!panel.classList.contains('on'));
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data?.chat) return;
    if (e.data.chat === 'ready') { ready = true; tell(); }
    if (e.data.chat === 'unread') { const n = +e.data.n || 0; badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n); btn.title = n ? `Chat of ${project} - ${n} unread` : `Chat of ${project}`; }
    if (e.data.chat === 'close') show(false);
    if (e.data.chat === 'open' && project) show(true);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('on') && !panel.contains(document.activeElement)) show(false); });
  // the project now in front (null: the project list - no chat there)
  const setProject = (p) => {
    p = p || null;
    if (p === project) return;
    project = p; btn.hidden = !p; badge.hidden = true;
    if (!p) show(false);
    tell();
  };
  return { show, setProject };
}
