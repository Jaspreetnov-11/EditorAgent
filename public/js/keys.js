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
  ['markIn', 'Mark In (Source monitor, else the timeline)', 'Source monitor'], ['markOut', 'Mark Out (Source monitor, else the timeline)', 'Source monitor'], ['goIn', 'Go to In', 'Source monitor'], ['goOut', 'Go to Out', 'Source monitor'],
  ['clearInOut', 'Clear In and Out (timeline)', 'Timeline'], ['openXml', 'Open a Premiere / Resolve XML as a project', 'Timeline'], ['speedDuration', 'Clip Speed / Duration…', 'Timeline'],
  ['insert', 'Insert', 'Source monitor'], ['overwrite', 'Overwrite (overlay)', 'Source monitor'],
  ['selectTool', 'Selection tool', 'Tools'], ['razorTool', 'Razor tool', 'Tools'], ['typeTool', 'Type tool (write on the monitor)', 'Tools'],
  ['rippleTool', 'Ripple edit tool', 'Tools'], ['rollingTool', 'Rolling edit tool', 'Tools'], ['rateTool', 'Rate stretch tool', 'Tools'], ['penTool', 'Pen tool', 'Tools'], ['remixTool', 'Remix tool', 'Tools'],
  ['slipTool', 'Slip tool', 'Tools'], ['slideTool', 'Slide tool', 'Tools'], ['handTool', 'Hand tool', 'Tools'], ['rectTool', 'Rectangle tool (draw on the monitor)', 'Tools'], ['ellipseTool', 'Ellipse tool (draw on the monitor)', 'Tools'], ['extendTool', 'Generative Extend tool', 'Tools'], ['zoomTool', 'Zoom tool', 'Tools'],
  ['trackFwdTool', 'Track select forward tool', 'Tools'], ['trackBackTool', 'Track select backward tool', 'Tools'],
  ['nudgeL', 'Nudge selected clips 1 frame left', 'Timeline'], ['nudgeR', 'Nudge selected clips 1 frame right', 'Timeline'],
  ['nudgeL5', 'Nudge selected clips 5 frames left', 'Timeline'], ['nudgeR5', 'Nudge selected clips 5 frames right', 'Timeline'],
  ['trackUp', 'Move selected clips one track up', 'Timeline'], ['trackDown', 'Move selected clips one track down', 'Timeline'],
  ['pasteInsert', 'Paste insert (everything after the playhead moves along)', 'Application'], ['group', 'Group', 'Timeline'], ['ungroup', 'Ungroup', 'Timeline'],
  ['trimMode', 'Trim mode (trim the cut nearest the playhead)', 'Timeline'], ['exportFrame', 'Export Frame (PNG of the playhead frame)', 'Application'], ['closeGaps', 'Close gaps (main story)', 'Timeline'],
  ['nextGap', 'Go to next gap', 'Timeline'], ['prevGap', 'Go to previous gap', 'Timeline'], ['clipMarker', 'Add clip marker', 'Markers'], ['rippleMarkers', 'Ripple sequence markers (on / off)', 'Markers'], ['history', 'History panel', 'View'], ['autoReframe', 'Auto Reframe Sequence…', 'Timeline'], ['seqSettings', 'Sequence Settings…', 'Timeline'], ['replaceEdit', 'Replace with clip from Source monitor', 'Source monitor'], ['timecode', 'Type a timecode (go there, or +15 / -1:00 to move)', 'Timeline'],
  ['lift', 'Lift (In to Out out, leave a gap)', 'Timeline'], ['extract', 'Extract (In to Out out, close the gap)', 'Timeline'],
  ['addEdit', 'Add edit (split selected / at playhead)', 'Timeline'], ['addEditAll', 'Add edit to all tracks', 'Timeline'],
  ['rippleTrimPrev', 'Ripple trim previous edit to playhead', 'Timeline'], ['rippleTrimNext', 'Ripple trim next edit to playhead', 'Timeline'],
  ['clear', 'Delete (leaves a gap - nothing else moves)', 'Timeline'], ['rippleDelete', 'Ripple delete (the clips after it move up)', 'Timeline'],
  ['duplicate', 'Duplicate', 'Timeline'], ['markersList', 'Markers list', 'Timeline'], ['exportEdl', 'Export EDL (CMX 3600)', 'File'], ['dupFrames', 'Show duplicate frame markers', 'Timeline'], ['makeSubclip', 'Make subclip (Source In - Out)', 'Source monitor'], ['pasteAttr', 'Paste attributes…', 'Timeline'], ['transition', 'Apply default video transition', 'Timeline'],
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
  markIn: ['I'], markOut: ['O'], goIn: ['Shift+I'], goOut: ['Shift+O'], clearInOut: ['Ctrl+Shift+X'], openXml: ['Ctrl+O'], speedDuration: ['Ctrl+R'], insert: [','], overwrite: ['.'],
  selectTool: ['V'], razorTool: ['C'], typeTool: ['T'], rippleTool: ['B'], rollingTool: ['N'], rateTool: ['R'], penTool: ['P'], remixTool: [], slipTool: ['Y'], slideTool: ['U'], handTool: ['H'], rectTool: [], ellipseTool: [], extendTool: [], zoomTool: ['Z'],
  trackFwdTool: ['A'], trackBackTool: ['Shift+A'], nudgeL: ['Alt+Left'], nudgeR: ['Alt+Right'], nudgeL5: ['Alt+Shift+Left'], nudgeR5: ['Alt+Shift+Right'], trackUp: ['Alt+Up'], trackDown: ['Alt+Down'],
  pasteInsert: ['Ctrl+Shift+V'], group: ['Ctrl+G'], ungroup: ['Ctrl+Shift+G'], trimMode: ['Shift+T'], replaceEdit: [], timecode: [], exportFrame: ['Ctrl+Shift+E'], closeGaps: [], nextGap: [], prevGap: [], clipMarker: [], rippleMarkers: [], history: [], autoReframe: [], seqSettings: [],
  lift: [';'], extract: ["'"], addEdit: ['Ctrl+K'], addEditAll: ['Ctrl+Shift+K'], rippleTrimPrev: ['Q'], rippleTrimNext: ['W'],
  // 📌 Delete leaves a gap, so every other clip stays exactly where it was put; Shift+Delete closes up (ripple) - like
  // Premiere. (For a while Delete closed up, and clips slid along whenever something before them was deleted.)
  clear: ['Delete', 'Backspace'], rippleDelete: ['Shift+Delete', 'Shift+Backspace'], duplicate: [], pasteAttr: ['Ctrl+Alt+V'], markersList: [], exportEdl: [], dupFrames: [], makeSubclip: ['Ctrl+U'], transition: ['Ctrl+D'],
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
  // once: own presets made while Delete closed up get Delete back as "leave a gap" (Shift+Delete = ripple)
  if (s.delSwap !== 2) {
    for (const p of Object.values(s.custom || {})) {
      const m = p.map || {}, a = m.clear || [], b = m.rippleDelete || [];
      if (b.includes('Delete') && a.includes('Shift+Delete')) { m.clear = b; m.rippleDelete = a; }
    }
    s.delSwap = 2; write(s);
  }
  return { preset: s.preset || 'premiere', custom: s.custom || {} };
};
export function setKeyState(st) { write({ ...st, delSwap: 2 }); rebuild(); }
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
