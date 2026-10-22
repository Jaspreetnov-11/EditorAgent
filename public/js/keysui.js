// ⌨ Keyboard Shortcuts window (Ctrl+Alt+K, or ⚙ in the header) - like Premiere's: a keyboard showing what each key does
// (with Ctrl / Shift / Alt), the commands with their keys, click "+" and press keys to give a command a shortcut,
// "Save as" your own preset. Changing a built-in preset makes "My shortcuts" (a copy) - the built-ins never change.
import { COMMANDS, CMD, GROUPS, BUILTIN, keyState, setKeyState, presetMap, presetName, keyOf } from './keys.js';
import { esc, toast, modal } from './ui.js';

const ROWS = [
  ['Esc', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'],
  ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'Backspace'],
  ['Tab', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', '\\'],
  ['Caps', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'", 'Enter'],
  ['Shift', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'Shift '],
  ['Ctrl', 'Alt', 'Space', 'Alt ', 'Ctrl '],
];
const NAV = [['Delete', 'Home', 'PageUp'], ['', 'End', 'PageDown'], ['', 'Up', ''], ['Left', 'Down', 'Right']];
const MODS = ['', 'Ctrl', 'Shift', 'Alt', 'Ctrl+Shift', 'Ctrl+Alt'];
const WIDE = { Backspace: 2, Tab: 1.5, '\\': 1.5, Caps: 1.8, Enter: 2.2, Shift: 2.4, 'Shift ': 2.6, Space: 7, Ctrl: 1.4, 'Ctrl ': 1.4, Alt: 1.3, 'Alt ': 1.3 };
const DEAD = new Set(['Caps', 'Shift', 'Shift ', 'Ctrl', 'Ctrl ', 'Alt', 'Alt ', '']);

// ✎ a shortcut typed as text ("ctrl+shift+d", "alt + f5", "shift+del") -> the form keyOf() gives ("Ctrl+Shift+D"); null if not a key
const NAMED = { esc: 'Esc', escape: 'Esc', del: 'Delete', delete: 'Delete', space: 'Space', spacebar: 'Space', enter: 'Enter', return: 'Enter', backspace: 'Backspace', tab: 'Tab',
  home: 'Home', end: 'End', pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown', insert: 'Insert', ins: 'Insert',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', plus: '=', minus: '-' };
const PUNCT = new Set(['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/']);
export function parseCombo(text) {
  const parts = String(text || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (String(text).trim().endsWith('++')) parts.push('='); // "Ctrl++" = Ctrl and the + / = key
  let ctrl = false, alt = false, shift = false, key = '';
  for (const p of parts) {
    const l = p.toLowerCase().replace(/\s+/g, '');
    if (['ctrl', 'control', 'cmd', 'command', 'meta'].includes(l)) ctrl = true;
    else if (['alt', 'option', 'opt'].includes(l)) alt = true;
    else if (l === 'shift') shift = true;
    else if (key) return null; // two keys
    else {
      key = NAMED[l] || (/^f([1-9]|1[0-2])$/.test(l) ? l.toUpperCase() : /^[a-z0-9]$/.test(l) ? l.toUpperCase() : PUNCT.has(p) ? p : '');
      if (!key) return null;
    }
  }
  return key ? [ctrl && 'Ctrl', alt && 'Alt', shift && 'Shift', key].filter(Boolean).join('+') : null;
}

export function openShortcuts() {
  const dlg = modal('Keyboard Shortcuts', '<div class="ks" data-ks></div>', { width: 1180 });
  const box = dlg.el.querySelector('[data-ks]');
  let st = keyState(), mod = '', q = '', capture = null, typing = null; // capture = command id waiting for keys; typing = one whose shortcut is being typed
  const map = () => presetMap(st.preset, st);
  const owner = (combo) => COMMANDS.find((c) => (map()[c.id] || []).includes(combo));
  // a built-in can't change: the first change makes (or reuses) "My shortcuts", a copy of it
  const editable = () => {
    if (!BUILTIN[st.preset]) return map();
    const id = 'mine', copy = JSON.parse(JSON.stringify(map()));
    st.custom[id] = { name: 'My shortcuts', map: copy }; st.preset = id;
    toast('Changes go into your own preset "My shortcuts" - the Premiere default stays as it is');
    return copy;
  };
  const save = () => { setKeyState(st); draw(); };
  const short = (s) => (s.length > 22 ? `${s.slice(0, 21)}…` : s);
  const keyCap = (k) => {
    if (!k) return '<i class="ks-k ks-gap"></i>';
    const combo = [mod, k.trim()].filter(Boolean).join('+'), c = DEAD.has(k) ? null : owner(combo);
    const style = WIDE[k] ? ` style="flex:${WIDE[k]}"` : '';
    return `<button class="ks-k${c ? ' on' : ''}${DEAD.has(k) ? ' dead' : ''}"${style} data-key="${esc(combo)}" title="${esc(combo)}${c ? ` - ${esc(c.label)}` : ''}">${c ? `<b>${esc(short(c.label))}</b>` : ''}<span>${esc(k.trim())}</span></button>`;
  };
  function draw() {
    const presets = [...Object.entries(BUILTIN).map(([id, p]) => [id, p.name]), ...Object.entries(st.custom).map(([id, p]) => [id, p.name])];
    const m = map(), qq = q.toLowerCase();
    const rows = GROUPS.map((g) => {
      const cmds = COMMANDS.filter((c) => c.group === g && (!qq || c.label.toLowerCase().includes(qq) || (m[c.id] || []).some((k) => k.toLowerCase().includes(qq))));
      if (!cmds.length) return '';
      return `<div class="ks-g">${esc(g)}</div>${cmds.map((c) => `<div class="ks-row${capture === c.id ? ' cap' : ''}" data-cmd="${c.id}"><span class="ks-l">${esc(c.label)}</span><span class="ks-ks">
        ${(m[c.id] || []).map((k) => `<span class="ks-chip">${esc(k)}<button class="link" data-rm="${c.id}" data-k="${esc(k)}" aria-label="Remove ${esc(k)}">✕</button></span>`).join('')}
        ${capture === c.id ? '<span class="ks-wait">Press the keys… <span class="muted">(Esc = cancel)</span></span>'
          : typing === c.id ? `<input class="ks-type" data-typed="${c.id}" placeholder="e.g. Ctrl+Shift+D" size="16"><button class="small primary" data-typeok="${c.id}">Set</button><button class="small" data-typeno>✕</button>`
          : `<button class="small ks-add" data-add="${c.id}" title="Give it a shortcut: press the keys">+</button><button class="small ks-add" data-type="${c.id}" title="Type the shortcut yourself, e.g. Ctrl+Shift+D">✎</button>`}</span></div>`).join('')}`;
    }).join('');
    box.innerHTML = `
      <div class="ks-top">
        <label>Preset <select data-preset>${presets.map(([id, n]) => `<option value="${esc(id)}"${id === st.preset ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <button class="small" data-saveas>Save As…</button><button class="small" data-del ${BUILTIN[st.preset] ? 'disabled' : ''}>Delete</button>
        <button class="small" data-reset ${BUILTIN[st.preset] ? 'disabled' : ''} title="Make this preset the same as the Premiere Pro default again">Reset to Premiere default</button>
        <span class="grow"></span><span class="muted small">Keyboard: ${MODS.map((x) => `<button class="chip${x === mod ? ' on' : ''}" data-mod="${x}">${x || 'No modifier'}</button>`).join('')}</span>
      </div>
      <div class="ks-kb"><div class="ks-main">${ROWS.map((r) => `<div class="ks-r">${r.map(keyCap).join('')}</div>`).join('')}</div>
        <div class="ks-nav">${NAV.map((r) => `<div class="ks-r">${r.map(keyCap).join('')}</div>`).join('')}</div></div>
      <p class="muted small">Purple keys have a command (with the modifier chosen above). Click a key to find its command. Click <b>+</b> next to a command and press the keys to give it a shortcut, or <b>✎</b> to type it (e.g. Ctrl+Shift+D); ✕ removes one.</p>
      <div class="ks-list-head"><input data-q placeholder="Search commands or keys (e.g. split, Ctrl+K)" value="${esc(q)}"><span class="muted small">Preset: <b>${esc(presetName(st.preset, st))}</b></span></div>
      <div class="ks-list">${rows || '<div class="muted pad">No command matches.</div>'}</div>
      <div class="ks-foot"><span class="muted small">Shortcuts are kept in this browser. Text boxes keep their own keys while you type.</span><span class="grow"></span><button class="primary" data-close>Done</button></div>`;
    const qi = box.querySelector('[data-q]');
    qi.oninput = () => { q = qi.value; const pos = qi.selectionStart; draw(); const n = box.querySelector('[data-q]'); n.focus(); n.setSelectionRange(pos, pos); };
    const ti = box.querySelector('[data-typed]');
    if (ti) { ti.focus(); ti.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); setTyped(); } if (e.key === 'Escape') { e.preventDefault(); typing = null; draw(); } }; }
  }
  // gives a command a shortcut (one that another command had moves here, after asking)
  function assign(id, combo) {
    const other = owner(combo);
    if (other && other.id !== id && !confirm(`${combo} is used by "${other.label}". Give it to "${CMD[id].label}" instead?`)) return draw();
    const m = editable();
    if (other && other.id !== id) m[other.id] = (m[other.id] || []).filter((x) => x !== combo);
    m[id] = [...new Set([...(m[id] || []), combo])];
    save(); toast(`${combo} → ${CMD[id].label}`);
  }
  function setTyped() {
    const ti = box.querySelector('[data-typed]'); if (!ti) return;
    const combo = parseCombo(ti.value);
    if (!combo) { toast(`"${ti.value}" is not a shortcut - write it like Ctrl+Shift+D, Alt+F5, Shift+Delete or Space`, 'err'); return ti.focus(); }
    const id = typing; typing = null; assign(id, combo);
  }
  box.addEventListener('change', (e) => {
    if (e.target.matches('[data-preset]')) { st.preset = e.target.value; save(); toast(`Shortcuts: ${presetName(st.preset, st)}`); }
  });
  box.addEventListener('click', (e) => {
    const t = e.target;
    const md = t.closest('[data-mod]'); if (md) { mod = md.dataset.mod; return draw(); }
    const k = t.closest('[data-key]'); if (k && !k.classList.contains('dead')) { const c = owner(k.dataset.key); q = c ? c.label : k.dataset.key; return draw(); }
    const add = t.closest('[data-add]'); if (add) { capture = add.dataset.add; typing = null; return draw(); }
    const ty = t.closest('[data-type]'); if (ty) { typing = ty.dataset.type; capture = null; return draw(); }
    if (t.closest('[data-typeok]')) return setTyped();
    if (t.closest('[data-typeno]')) { typing = null; return draw(); }
    const rm = t.closest('[data-rm]'); if (rm) { const m = editable(); m[rm.dataset.rm] = (m[rm.dataset.rm] || []).filter((x) => x !== rm.dataset.k); return save(); }
    if (t.closest('[data-saveas]')) {
      const n = prompt('Name of your shortcuts preset', BUILTIN[st.preset] ? 'My shortcuts' : `${presetName(st.preset, st)} copy`)?.trim(); if (!n) return;
      const id = `c_${Date.now().toString(36)}`; st.custom[id] = { name: n, map: JSON.parse(JSON.stringify(map())) }; st.preset = id; save(); toast(`Saved as "${n}"`); return;
    }
    if (t.closest('[data-del]') && !BUILTIN[st.preset]) { if (!confirm(`Delete the preset "${presetName(st.preset, st)}"?`)) return; delete st.custom[st.preset]; st.preset = 'premiere'; save(); return; }
    if (t.closest('[data-reset]') && !BUILTIN[st.preset]) { if (!confirm('Make this preset the same as the Premiere Pro default again?')) return; st.custom[st.preset].map = JSON.parse(JSON.stringify(BUILTIN.premiere.map)); save(); }
  });
  // Esc while waiting for keys cancels the wait, not the window
  dlg.el.addEventListener('cancel', (e) => { if (capture) e.preventDefault(); });
  // the keys pressed while a command waits for its shortcut
  dlg.el.addEventListener('keydown', (e) => {
    if (!capture) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { capture = null; return draw(); }
    const combo = keyOf(e); if (!combo) return; // (a modifier alone: wait for the key)
    const id = capture; capture = null; assign(id, combo);
  }, true);
  draw();
}
