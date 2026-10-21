// Title templates (lower thirds, tags, cards) and caption styles. A template is just a set of title-clip properties,
// so everything stays editable in the Inspector after it is applied. Rendered by engine/render2.mjs (drawtext / drawbox)
// and previewed by player.js.
//   title props: text, textStyle (lower | top | center), size (px @1080), textColor, box ('none' | '#rrggbb'),
//                accent ('#rrggbb' bar beside the text), strip ('#rrggbb' full-width band), tricolour (bool, card/strip),
//                anim ('fade' | 'slide' | 'none'), bg (V1 card background)
export const TEMPLATES = [
  { id: 'lt-navy', group: 'Lower thirds', label: 'Name & role (navy)', track: 'V2', dur: 4, props: { text: 'Rahul Sharma\nDistrict Collector, Bastar', textStyle: 'lower', box: '#0b2545', accent: '#ff9933', anim: 'slide', textColor: '#ffffff' } },
  { id: 'lt-saffron', group: 'Lower thirds', label: 'Name & role (saffron)', track: 'V2', dur: 4, props: { text: 'प्रिया वर्मा\nयुवा स्वयंसेवक, रायपुर', textStyle: 'lower', box: '#e8740c', anim: 'slide', textColor: '#ffffff' } },
  { id: 'lt-clean', group: 'Lower thirds', label: 'Clean (no box)', track: 'V2', dur: 4, props: { text: 'Chitrakote Falls\nBastar, Chhattisgarh', textStyle: 'lower', box: 'none', anim: 'fade', textColor: '#ffffff' } },
  { id: 'lt-strip', group: 'Lower thirds', label: 'News strip', track: 'V2', dur: 5, props: { text: 'Viksit Bharat Young Leaders Dialogue 2026 - registrations open', textStyle: 'lower', box: 'none', strip: '#b71c1c', anim: 'slide', textColor: '#ffffff', size: 40 } },
  { id: 'lt-tricolour', group: 'Lower thirds', label: 'Tricolour strip', track: 'V2', dur: 4, props: { text: 'MY Bharat', textStyle: 'lower', box: 'none', strip: '#0b2545', tricolour: true, anim: 'slide', textColor: '#ffffff' } },
  { id: 'tag-location', group: 'Tags & titles', label: 'Location tag (top)', track: 'V2', dur: 3, props: { text: 'Dhudmaras, Bastar', textStyle: 'top', box: '#000000', size: 38, anim: 'fade', textColor: '#ffffff' } },
  { id: 'title-big', group: 'Tags & titles', label: 'Big centre title', track: 'V2', dur: 3, props: { text: 'बस्तर', textStyle: 'center', box: 'none', size: 120, anim: 'fade', textColor: '#ffffff' } },
  { id: 'title-pill', group: 'Tags & titles', label: 'Centre title in a box', track: 'V2', dur: 3, props: { text: 'Viksit Bharat @2047', textStyle: 'center', box: '#e8740c', size: 72, anim: 'fade', textColor: '#ffffff' } },
  { id: 'card-navy', group: 'Full-screen cards', label: 'Navy card', track: 'V1', dur: 3, props: { text: 'सेवा के 25 वर्ष', bg: '#0b2545', textColor: '#ffffff', accent: '#ff9933', size: 96 } },
  { id: 'card-mygov', group: 'Full-screen cards', label: 'White card + tricolour', track: 'V1', dur: 3, props: { text: 'विकसित भारत\nके निर्माण में बनें भागीदार', bg: '#ffffff', textColor: '#0b2545', tricolour: true, size: 84 } },
  { id: 'card-quote', group: 'Full-screen cards', label: 'Quote', track: 'V1', dur: 4, props: { text: '“जिसने जीवन सँवारा,\nउसे आशीर्वाद हमारा।”', bg: '#121212', textColor: '#ffd28a', size: 72 } },
  { id: 'card-cta', group: 'Full-screen cards', label: 'End card / call to action', track: 'V1', dur: 3, props: { text: 'Register today\nmybharat.gov.in', bg: '#e8740c', textColor: '#ffffff', size: 84 } },
];
export const templateById = (id) => TEMPLATES.find((t) => t.id === id);
export const TITLE_KEYS = ['textStyle', 'size', 'textColor', 'box', 'accent', 'strip', 'tricolour', 'anim', 'bg'];

// Restyle an existing title / text clip with a template, keeping its words.
export function applyTemplate(c, t) {
  for (const k of TITLE_KEYS) delete c[k];
  const { text, ...look } = t.props;
  Object.assign(c, look);
  if (c.type !== 'title' || c.bg === undefined) delete c.bg;
  c.template = t.id;
}

// Caption (burned-in subtitle) styles: libass force_style for .srt files (PlayRes = 288 lines tall).
export const CAPTION_STYLES = [
  { id: '', label: 'Classic white (outline)', style: {} },
  { id: 'yellow', label: 'Yellow bold', style: { PrimaryColour: '&H0000D7FF', Outline: 2.5 } },
  { id: 'box', label: 'White on dark box', style: { BorderStyle: 3, Outline: 1.5, Shadow: 0, BackColour: '&H80000000', OutlineColour: '&H80000000' } },
  { id: 'reel', label: 'Reel - big & bold', style: { FontSize: 15, Outline: 3, MarginV: 90 } },
  { id: 'saffron', label: 'Saffron box', style: { BorderStyle: 3, Outline: 1.5, Shadow: 0, BackColour: '&H000C74E8', OutlineColour: '&H000C74E8' } },
];
