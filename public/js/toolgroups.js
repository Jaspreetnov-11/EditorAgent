// 🧰 the Tools panel's groups (timeline.js draws them): Premiere's order and flyouts.
// Premiere's Tools panel: one button per group, showing the tool last used from it; the others are in its flyout
// (click and hold, right-click, or the little ◢ in its corner), like Premiere. [tool, name, key, icon, what it does]
export const TOOL_GROUPS = [
  [['select', 'Selection Tool', 'V', '@pointer', 'Select / move']],
  [['trackfwd', 'Track Select Forward Tool', 'A', '<b>⇥⇥</b>', 'Click a clip: it and everything after it on every track is selected (Shift+click: only that track). Drag an overlay clip to move them all, or Alt+← / → to nudge'],
    ['trackback', 'Track Select Backward Tool', 'Shift+A', '<b>⇤⇤</b>', 'Click a clip: it and everything before it on every track is selected (Shift+click: only that track)']],
  [['ripple', 'Ripple Edit Tool', 'B', '<b>⇤</b>', "Drag a clip's end - the story after it closes up / moves along"],
    ['rolling', 'Rolling Edit Tool', 'N', '<b>⇹</b>', 'Drag a cut - one shot gets longer, the other shorter, nothing else moves'],
    ['rate', 'Rate Stretch Tool', 'R', '<b>⟷</b>', "Drag a clip's end - its speed changes so the same shot fills the new length"],
    ['remix', 'Remix Tool', '', '<b>♫</b>', "Drag a music clip's end to the length you need - the music is re-cut to fit, from its best part"]],
  [['blade', 'Razor Tool', 'C', '@blade', 'Click a clip to cut it']],
  [['slip', 'Slip Tool', 'Y', '<b>↔</b>', 'Drag a clip - it shows an earlier / later part of its file; its place and length stay'],
    ['slide', 'Slide Tool', 'U', '<b>⇆</b>', 'Drag a main-story clip between its neighbours - the one before gets longer, the one after shorter; nothing else moves']],
  [['pen', 'Pen Tool', 'P', '<b>✒</b>', 'Click on a clip to put a keyframe on its opacity (video) / volume (audio) line - higher = more'],
    ['rect', 'Rectangle Tool', '', '<b>▭</b>', 'Drag on the Program monitor to draw a rectangle (a shape graphic on a free overlay track; Shift: square)'],
    ['ellipse', 'Ellipse Tool', '', '<b>◯</b>', 'Drag on the Program monitor to draw an ellipse (Shift: circle)']],
  [['hand', 'Hand Tool', 'H', '<b>✋</b>', 'Drag to scroll the timeline'],
    ['zoom', 'Zoom Tool', 'Z', '<b>⌕</b>', 'Click to zoom in where you click, Alt+click to zoom out']],
  [['type', 'Type Tool', 'T', '<b>T</b>', 'Click on the Program monitor and type - text where you click']],
  [['extend', 'Generative Extend Tool', '', '<b>⇲</b>', "Click a video clip: it carries on past its end for up to 1 s (made from its own motion) into the empty space after it"]],
];

// a click on a group's button: 'set' its tool, open its 'flyout' (the ◢ corner), or 'none' (the press was a hold and
// the flyout is open already). Only a plain click changes the tool - a peek at the others never does (picking Track
// Select by accident made one click on a clip select it and everything after it).
export function groupClick({ held = false, corner = false, many = false }) {
  if (held) return 'none';
  if (corner && many) return 'flyout';
  return 'set';
}
// the tools whose click selects many clips at once: picking one says so
export const MANY_SELECT = new Set(['trackfwd', 'trackback']);

// a press on the Program monitor: what a drag does. Only the Selection tool moves the clip; the Hand tool (or the
// middle button) moves around a zoomed-in picture and never the clip - they were mixed up before.
export function monitorDrag(tool, button, zoomed) {
  if (button === 1 || (button === 0 && tool === 'hand')) return zoomed ? 'pan' : null;
  return button === 0 && tool === 'select' ? 'move' : null;
}
