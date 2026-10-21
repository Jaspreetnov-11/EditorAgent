// ⌨ Keyboard shortcuts: every editor action is a command; a preset says which keys run it. "Adobe Premiere Pro Default"
// is the default, "Limelight Classic" keeps the editor's old keys, and the owner of a browser can make their own
// (Keyboard Shortcuts window, keysui.js). Kept per browser (localStorage). main.js supplies what each command does.
export const GROUPS = ['Application', 'Playback', 'Source monitor', 'Tools', 'Timeline', 'Markers', 'View'];
// [id, label, group]
export const COMMANDS = [
  ['undo', 'Undo', 'Application'], ['redo', 'Redo', 'Application'], ['save', 'Save', 'Application'],
  ['cut', 'Cut', 'Application'], ['copy', 'Copy', 'Application'], ['paste', 'Paste', 'Application'],
  ['selectAll', 'Select all', 'Application'], ['deselectAll', 'Deselect all', 'Application'],
  ['exportMedia', 'Export media (Deliver)', 'Application'], ['shortcuts', 'Keyboard shortcuts…', 'Application'],
  ['playStop', 'Play / stop', 'Playback'], ['shuttleL', 'Shuttle left (J)', 'Playback'], ['shuttleStop', 'Shuttle stop', 'Playback'], ['shuttleR', 'Shuttle right', 'Playback'],
  ['stepBack', 'Step back 1 frame', 'Playback'], ['stepFwd', 'Step forward 1 frame', 'Playback'],
  ['stepBack5', 'Step back (many frames)', 'Playback'], ['stepFwd5', 'Step forward (many frames)', 'Playback'],
  ['prevEdit', 'Go to previous edit point', 'Playback'], ['nextEdit', 'Go to next edit point', 'Playback'],
  ['goStart', 'Go to sequence start', 'Playback'], ['goEnd', 'Go to sequence end', 'Playback'], ['matchFrame', 'Match frame (open the shot in Source)', 'Playback'],
  ['markIn', 'Mark In', 'Source monitor'], ['markOut', 'Mark Out', 'Source monitor'], ['goIn', 'Go to In', 'Source monitor'], ['goOut', 'Go to Out', 'Source monitor'],
  ['insert', 'Insert', 'Source monitor'], ['overwrite', 'Overwrite (overlay)', 'Source monitor'],
  ['selectTool', 'Selection tool', 'Tools'], ['razorTool', 'Razor tool', 'Tools'], ['typeTool', 'Type tool (write on the monitor)', 'Tools'],
  ['rippleTool', 'Ripple edit tool', 'Tools'], ['rollingTool', 'Rolling edit tool', 'Tools'], ['rateTool', 'Rate stretch tool', 'Tools'], ['penTool', 'Pen tool', 'Tools'], ['remixTool', 'Remix tool', 'Tools'],
  ['addEdit', 'Add edit (split selected / at playhead)', 'Timeline'], ['addEditAll', 'Add edit to all tracks', 'Timeline'],
  ['rippleTrimPrev', 'Ripple trim previous edit to playhead', 'Timeline'], ['rippleTrimNext', 'Ripple trim next edit to playhead', 'Timeline'],
  ['clear', 'Delete and leave a gap (lift)', 'Timeline'], ['rippleDelete', 'Delete (the next clip moves up - ripple)', 'Timeline'],
  ['duplicate', 'Duplicate', 'Timeline'], ['transition', 'Apply default video transition', 'Timeline'],
  ['selectAtPlayhead', 'Select clip at playhead', 'Timeline'], ['link', 'Link / unlink audio and video', 'Timeline'],
  ['enable', 'Enable / disable clip', 'Timeline'], ['audioGain', 'Audio gain…', 'Timeline'], ['snap', 'Snap in timeline', 'Timeline'], ['nest', 'Nest…', 'Timeline'],
  ['marker', 'Add marker', 'Markers'], ['nextMarker', 'Go to next marker', 'Markers'], ['prevMarker', 'Go to previous marker', 'Markers'], ['note', 'Add review note', 'Markers'],
  ['zoomIn', 'Zoom in (timeline)', 'View'], ['zoomOut', 'Zoom out (timeline)', 'View'], ['zoomFit', 'Zoom to sequence', 'View'],
  ['maximize', 'Maximize / restore the panel under the mouse', 'View'], ['fullscreen', 'Full screen (Program monitor)', 'View'],
].map(([id, label, group]) => ({ id, label, group }));
export const CMD = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));

const PREMIERE = {
  undo: ['Ctrl+Z'], redo: ['Ctrl+Shift+Z', 'Ctrl+Y'], save: ['Ctrl+S'], cut: ['Ctrl+X'], copy: ['Ctrl+C'], paste: ['Ctrl+V'],
  selectAll: ['Ctrl+A'], deselectAll: ['Ctrl+Shift+A', 'Esc'], exportMedia: ['Ctrl+M'], shortcuts: ['Ctrl+Alt+K'],
  playStop: ['Space'], shuttleL: ['J'], shuttleStop: ['K'], shuttleR: ['L'], stepBack: ['Left'], stepFwd: ['Right'], stepBack5: ['Shift+Left'], stepFwd5: ['Shift+Right'],
  prevEdit: ['Up', 'PageUp'], nextEdit: ['Down', 'PageDown'], goStart: ['Home'], goEnd: ['End'], matchFrame: ['F'],
  markIn: ['I'], markOut: ['O'], goIn: ['Shift+I'], goOut: ['Shift+O'], insert: [','], overwrite: ['.'],
  selectTool: ['V'], razorTool: ['C'], typeTool: ['T'], rippleTool: ['B'], rollingTool: ['N'], rateTool: ['R'], penTool: ['P'], remixTool: [],
  addEdit: ['Ctrl+K'], addEditAll: ['Ctrl+Shift+K'], rippleTrimPrev: ['Q'], rippleTrimNext: ['W'],
  // Delete closes up (the next clip takes the deleted one's place); Shift+Delete leaves a gap. (The other way round
  // from Premiere, on purpose: the gaps Delete used to leave meant shuffling clips by hand every time.)
  clear: ['Shift+Delete', 'Shift+Backspace'], rippleDelete: ['Delete', 'Backspace'], duplicate: [], transition: ['Ctrl+D'],
  selectAtPlayhead: ['D'], link: ['Ctrl+L'], enable: ['Shift+E'], audioGain: ['G'], snap: ['S'], nest: [],
  marker: ['M'], nextMarker: ['Shift+M'], prevMarker: ['Ctrl+Shift+M'], note: ['Alt+M'],
  zoomIn: ['='], zoomOut: ['-'], zoomFit: ['\\'], maximize: ['`'], fullscreen: ['Ctrl+`'],
};
const CLASSIC = {
  ...PREMIERE,
  stepBack5: ['Shift+Left'], stepFwd5: ['Shift+Right'], prevEdit: ['Up'], nextEdit: ['Down'], matchFrame: [],
  razorTool: ['B'], rippleTool: [], rollingTool: [], rateTool: [], addEdit: ['S'], addEditAll: [], duplicate: ['Ctrl+D'], transition: [], selectAtPlayhead: [], link: [], enable: [],
  snap: ['N'], nextMarker: [], prevMarker: [], note: ['Shift+M'], deselectAll: ['Esc'], zoomFit: ['Shift+Z'], exportMedia: [], maximize: [],
};
export const BUILTIN = { premiere: { name: 'Adobe Premiere Pro Default', map: PREMIERE }, classic: { name: 'Limelight Classic', map: CLASSIC } };
// how many frames "Step (many frames)" moves: Premiere 5 frames; Classic 1 second
export const stepMany = (preset, fps) => (preset === 'classic' ? fps : 5);

// ---- a key press as text: "Ctrl+Shift+K", "Space", "`", "Shift+Delete" ----
const CODE = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc', NumpadAdd: '=', NumpadSubtract: '-', NumpadEnter: 'Enter' };
const KEYNAME = { ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc', '~': '`', '+': '=', _: '-', '<': ',', '>': '.', '?': '/', '|': '\\', '{': '[', '}': ']', ':': ';', '"': "'" };
export function keyOf(e) {
  let k = '';
  if (e.code) k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^Numpad\d$/.test(e.code) ? e.code.slice(6) : CODE[e.code] || (/^F\d+$/.test(e.code) ? e.code : '');
  if (!k) k = KEYNAME[e.key] || (e.key?.length === 1 ? e.key.toUpperCase() : e.key || '');
  if (!k || ['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(k)) return '';
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', k].filter(Boolean).join('+');
}

// ---- the chosen preset (per browser) ----
const LS = 've-keys';
const read = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
const write = (o) => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch {} };
export const keyState = () => {
  const s = read();
  // once: own presets made before Delete started closing up get the same swap (Delete = ripple, Shift+Delete = gap)
  if (!s.delSwap) {
    for (const p of Object.values(s.custom || {})) {
      const m = p.map || {}, a = m.clear || [], b = m.rippleDelete || [];
      if (a.includes('Delete') && b.includes('Shift+Delete')) { m.clear = b; m.rippleDelete = a; }
    }
    s.delSwap = 1; write(s);
  }
  return { preset: s.preset || 'premiere', custom: s.custom || {} };
};
export function setKeyState(st) { write({ ...st, delSwap: 1 }); rebuild(); }
export function presetMap(id, st = keyState()) {
  if (BUILTIN[id]) return BUILTIN[id].map;
  const c = st.custom[id]; return c ? c.map : PREMIERE;
}
export const presetName = (id, st = keyState()) => BUILTIN[id]?.name || st.custom[id]?.name || id;
// key -> command id (the active preset)
let byKey = new Map();
export function rebuild() {
  byKey = new Map();
  const m = presetMap(keyState().preset);
  for (const c of COMMANDS) for (const k of m[c.id] || []) if (!byKey.has(k)) byKey.set(k, c.id);
}
rebuild();
export const commandFor = (combo) => byKey.get(combo) || null;
export const keysFor = (id) => presetMap(keyState().preset)[id] || [];
