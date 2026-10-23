// Line icons: thin 16x16 strokes (Lucide / Apple-like), used where the UI once had emoji.
// ic(name) -> an inline <svg class="lic"> string; it takes the text colour (currentColor).
// Transport icons (play / pause / start / end) are filled shapes; the rest are strokes.

const F = (d) => `<path d="${d}" fill="currentColor" stroke="none"/>`;

const P = {
  // transport (filled)
  play: F('M5 3.2v9.6c0 .5.5.8.9.5l7.4-4.8a.6.6 0 0 0 0-1L5.9 2.7c-.4-.3-.9 0-.9.5z'),
  pause: '<rect x="4" y="3" width="2.8" height="10" rx=".7" fill="currentColor" stroke="none"/><rect x="9.2" y="3" width="2.8" height="10" rx=".7" fill="currentColor" stroke="none"/>',
  start: '<rect x="3" y="3.2" width="1.8" height="9.6" rx=".6" fill="currentColor" stroke="none"/>' + F('M13 3.6v8.8c0 .5-.5.8-.9.5L5.6 8.5a.6.6 0 0 1 0-1l6.5-4.4c.4-.3.9 0 .9.5z'),
  end: '<rect x="11.2" y="3.2" width="1.8" height="9.6" rx=".6" fill="currentColor" stroke="none"/>' + F('M3 3.6v8.8c0 .5.5.8.9.5l6.5-4.4a.6.6 0 0 0 0-1L3.9 3.1c-.4-.3-.9 0-.9.5z'),
  prev: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  next: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  // editing
  trash: '<path d="M2.5 4.5h11M6.3 4.5V2.8h3.4v1.7M4 4.5l.7 8.7h6.6l.7-8.7M6.7 7v4M9.3 7v4"/>',
  link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-.7.7"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.7-.7"/>',
  unlink: '<path d="M9.6 5.1l.4-.4a2.6 2.6 0 0 1 3.7 3.7l-.4.4M6.4 10.9l-.4.4a2.6 2.6 0 0 1-3.7-3.7l.4-.4M2.5 2.5l2 2M13.5 13.5l-2-2M6 1.8V3.6M1.8 6h1.8M10 14.2v-1.8M14.2 10h-1.8"/>',
  tag: '<path d="M2.5 3.3v4.1c0 .3.1.5.3.7l5.6 5.6c.4.4 1 .4 1.4 0l3.9-3.9c.4-.4.4-1 0-1.4L8.1 2.8a1 1 0 0 0-.7-.3H3.3a.8.8 0 0 0-.8.8z"/><circle cx="5.5" cy="5.5" r="1"/>',
  edit: '<path d="M11 2.3l2.7 2.7-8.2 8.2H2.8v-2.7z"/><path d="M9.3 4l2.7 2.7"/>',
  pen: '<path d="M2.6 13.4l1.8-6.1L10.7 3l2.3 2.3-4.3 6.3z"/><path d="M2.6 13.4l3.7-3.7"/><circle cx="7.3" cy="8.7" r="1.1"/>',
  // ✂ Roto (AI): a person cut out of the frame
  roto: '<rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke-dasharray="2 1.7"/><circle cx="8" cy="6" r="2.2"/><path d="M4.2 13c.5-2.4 1.9-3.7 3.8-3.7s3.3 1.3 3.8 3.7"/>',
  scissors: '<circle cx="4.3" cy="4.5" r="2"/><circle cx="4.3" cy="11.5" r="2"/><path d="M6 5.7l7.5 6.8M6 10.3l7.5-6.8"/>',
  slip: '<path d="M2 8h12M5 5 2 8l3 3M11 5l3 3-3 3"/>',
  ramp: '<path d="M2 4l5.2 4L2 12zM8.3 4l5.2 4-5.2 4z"/>',
  clip: '<rect x="1.5" y="4.5" width="13" height="7" rx="1.5"/><path d="M5 4.5v7M11 4.5v7"/>',
  attach: '<path d="M13 7.4 8.1 12.3a3.1 3.1 0 0 1-4.4-4.4L9 2.6a2.1 2.1 0 0 1 2.9 2.9l-5.2 5.2a1 1 0 0 1-1.4-1.4l4.8-4.8"/>',
  copy: '<rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5.5V3.3a.8.8 0 0 0-.8-.8H3.3a.8.8 0 0 0-.8.8v6.4c0 .4.4.8.8.8h2.2"/>',
  // media
  camera: '<path d="M2 5.5c0-.6.4-1 1-1h2l1-1.5h4l1 1.5h2c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z"/><circle cx="8" cy="8.5" r="2.3"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.8" cy="6.3" r="1.1"/><path d="M2.4 12 6 8.5l2.5 2.5 2-2 3.1 3.1"/>',
  film: '<rect x="2.5" y="2" width="11" height="12" rx="1.5"/><path d="M5.5 2v12M10.5 2v12M2.5 5.5h3M2.5 8h3M2.5 10.5h3M10.5 5.5h3M10.5 8h3M10.5 10.5h3"/>',
  video: '<rect x="1.5" y="4" width="9" height="8" rx="1.5"/><path d="M10.5 7l4-2.2v6.4l-4-2.2"/>',
  clapper: '<rect x="2.5" y="6.5" width="11" height="7" rx="1"/><path d="M2.6 6.4 2.1 4.3l10.7-2.5.5 2.1zM5.3 3.6l1.5 1.9M8.7 2.8l1.5 1.9"/>',
  music: '<path d="M6 12V3.6l7-1.4v8.3"/><circle cx="4.3" cy="12" r="1.8"/><circle cx="11.3" cy="10.5" r="1.8"/>',
  speaker: '<path d="M2.5 6h2.4L8.5 3v10L4.9 10H2.5z"/><path d="M11 5.6a3.4 3.4 0 0 1 0 4.8M12.9 3.8a6 6 0 0 1 0 8.4"/>',
  mic: '<rect x="6" y="1.8" width="4" height="7.6" rx="2"/><path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2.2M6 14.2h4"/>',
  fader: '<path d="M4 2v12M8 2v12M12 2v12M2.6 10.5h2.8M6.6 5h2.8M10.6 8h2.8"/>',
  wave: '<path d="M1.5 8c1.1-2.6 2.2-2.6 3.3 0s2.2 2.6 3.2 0 2.2-2.6 3.3 0 2.1 2.6 3.2 0"/>',
  // files
  download: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/>',
  upload: '<path d="M8 10.5v-8M4.5 6 8 2.5 11.5 6M3 13.5h10"/>',
  folder: '<path d="M2 4.5c0-.6.4-1 1-1h3.2l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z"/>',
  box: '<path d="M2.5 5 8 2.2 13.5 5v6L8 13.8 2.5 11z"/><path d="M2.5 5 8 7.8 13.5 5M8 7.8v6"/>',
  doc: '<path d="M4 1.8h5.3l2.9 2.9v8.5c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2.8c0-.6.4-1 1-1z"/><path d="M9.3 1.8v2.9h2.9M5.5 8h5M5.5 10.5h3.5"/>',
  note: '<path d="M3 2.5h10v7l-4 4H3z"/><path d="M13 9.5H9v4M5.5 5.5h5M5.5 7.8h3"/>',
  // marks
  star: '<path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z"/>',
  bolt: '<path d="M9 1.8 3.5 9H8l-1 5.2L12.5 7H8z"/>',
  sparkle: '<path d="M6.5 2.2l1.1 3.2 3.2 1.1-3.2 1.1-1.1 3.2-1.1-3.2-3.2-1.1 3.2-1.1zM12 9.6l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z"/>',
  target: '<circle cx="8" cy="8" r="5.3"/><circle cx="8" cy="8" r="2.2"/><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14"/>',
  warn: '<path d="M7.1 2.7a1 1 0 0 1 1.8 0l5.3 9.4a1 1 0 0 1-.9 1.4H2.7a1 1 0 0 1-.9-1.4z"/><path d="M8 6.3v3M8 11.3v.1"/>',
  stop: '<circle cx="8" cy="8" r="5.8"/><path d="M3.9 3.9l8.2 8.2"/>',
  check: '<circle cx="8" cy="8" r="5.8"/><path d="M5.3 8.2 7.2 10l3.5-3.8"/>',
  clock: '<circle cx="8" cy="9" r="5"/><path d="M8 9V6.5M6.5 1.8h3M8 1.8V4M12 4.6l1-1"/>',
  hourglass: '<path d="M4 1.8h8M4 14.2h8M5 1.8c0 3.2 3 4 3 6.2s-3 3-3 6.2M11 1.8c0 3.2-3 4-3 6.2s3 3 3 6.2"/>',
  chat: '<path d="M2.5 3.5c0-.6.4-1 1-1h9c.6 0 1 .4 1 1V10c0 .6-.4 1-1 1H7.2L4.5 13.3V11h-1c-.6 0-1-.4-1-1z"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7.2 12.2h1.6"/>',
  pin: '<path d="M5.8 2h4.4M6.8 2v4L4.5 8.5h7L9.2 6V2M8 8.5V14"/>',
  team: '<circle cx="6" cy="5.5" r="2.2"/><path d="M2 13.2c0-2.3 1.8-4 4-4s4 1.7 4 4"/><path d="M10.6 3.5a2.2 2.2 0 0 1 0 4.1M11.6 9.3c1.4.5 2.4 1.9 2.4 3.9"/>',
  chart: '<path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5"/>',
  monitor: '<rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.2"/><path d="M5.5 14h5M8 11v3"/>',
  shield: '<path d="M8 1.8 13 3.8v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4z"/>',
  leaf: '<path d="M3 13C3 7 7 3 13.2 2.8 13 9 9 13 3 13z"/><path d="M3 13l6-6"/>',
  // camera moves (AI templates)
  zoomin: '<path d="M2 2l4 4M6 3v3H3M14 2l-4 4M10 3v3h3M2 14l4-4M3 10h3v3M14 14l-4-4M13 10h-3v3"/>',
  zoomout: '<path d="M6 6 2 2M2 5V2h3M10 6l4-4M11 2h3v3M6 10l-4 4M2 11v3h3M10 10l4 4M14 11v3h-3"/>',
  drone: '<circle cx="3.6" cy="4" r="1.8"/><circle cx="12.4" cy="4" r="1.8"/><rect x="6" y="7" width="4" height="3" rx="1"/><path d="M5 5.3 6.3 7M11 5.3 9.7 7M8 10v1.8"/>',
  orbit: '<ellipse cx="8" cy="8" rx="6.2" ry="2.6" transform="rotate(-25 8 8)"/><circle cx="8" cy="8" r="1.6"/>',
  rotate: '<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8"/><path d="M13.2 2.4v2.6h-2.6"/>',
  shake: '<rect x="5" y="2.5" width="6" height="11" rx="1.2"/><path d="M2.6 5.5v5M13.4 5.5v5"/>',
  glitch: '<path d="M2 4h7M5 6.7h9M2 9.3h6M6 12h7"/>',
  echo: '<circle cx="10.5" cy="8" r="3"/><path d="M6.4 5.3a3.2 3.2 0 0 0 0 5.4M3.3 5.8a3.2 3.2 0 0 0 0 4.4"/>',
  // controls
  undo: '<path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6"/><path d="M5.5 4 3 6.5 5.5 9"/>',
  reset: '<path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8"/><path d="M2.8 2.4v2.6h2.6"/>',
  diamond: '<path d="M8 2.5 13.5 8 8 13.5 2.5 8z"/>',
  square: '<rect x="3" y="3" width="10" height="10" rx="1.5"/>',
  circle: '<circle cx="8" cy="8" r="5"/>',
  radio: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none"/>',
  dot: '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>',
  rect: '<rect x="2" y="4" width="12" height="8" rx="1"/>',
  ellipse: '<ellipse cx="8" cy="8" rx="6" ry="4.5"/>',
  mask: '<rect x="2.5" y="3.5" width="11" height="9" rx="1" stroke-dasharray="2 1.6"/>',
  maskellipse: '<ellipse cx="8" cy="8" rx="5.8" ry="4.6" stroke-dasharray="2 1.6"/>',
  swap: '<path d="M3 5.5h10M10.5 3l2.5 2.5L10.5 8M13 10.5H3M5.5 8 3 10.5 5.5 13"/>',
  sync: '<path d="M2.5 6h11L11 3.5M13.5 10h-11L5 12.5"/>',
  up: '<path d="M3.5 10 8 5.5l4.5 4.5"/>',
  down: '<path d="M3.5 6 8 10.5 12.5 6"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  more: '<circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
  merge: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5.5v5M5.5 8h5"/>',
  cursor: '<path d="M3.5 2.5 12.5 8l-4 1-2 4z"/>',
  trimstart: '<path d="M3.5 3v10M13 8H5.8M8.6 5.2 5.8 8l2.8 2.8"/>',
  trimend: '<path d="M12.5 3v10M3 8h7.2M7.4 5.2 10.2 8l-2.8 2.8"/>',
  adjust: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M3 13 13 3"/>',
  rowsmin: '<path d="M3 5h10M3 8h10M3 11h10"/>',
  rowsmax: '<rect x="2.5" y="2.5" width="11" height="4.5" rx="1"/><rect x="2.5" y="9" width="11" height="4.5" rx="1"/>',
  group: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><rect x="5.5" y="5.5" width="5" height="5" rx=".8"/>',
  transform: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 8h5.5V2.5"/>',
  selfwd: '<path d="M2 4.5 5.5 8 2 11.5M6 4.5 9.5 8 6 11.5M13 3v10"/>',
  selback: '<path d="M14 4.5 10.5 8l3.5 3.5M10 4.5 6.5 8l3.5 3.5M3 3v10"/>',
  rolling: '<path d="M8 3v10M2 8h4M4.3 6 2.3 8l2 2M14 8h-4M11.7 6l2 2-2 2"/>',
  rate: '<path d="M2 4v8M14 4v8M4.5 8h7M6.5 6l-2 2 2 2M9.5 6l2 2-2 2"/>',
  zoom: '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14M7 5v4M5 7h4"/>',
  extend: '<rect x="1.5" y="4.5" width="8" height="7" rx="1"/><path d="M11 8h3.5M12.8 6.2 14.5 8l-1.7 1.8"/>',
  null: '<circle cx="8" cy="8" r="4"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>',
};
P.refresh = P.rotate; P.loop = P.rotate; P.duplicate = P.copy; P.ripple = P.trimstart; P.slide = P.swap;

export const ICONS = Object.keys(P);

export function ic(name) {
  const body = P[name] || P.sparkle;
  return `<svg class="lic" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px">${body}</svg>`;
}
