// Delivery presets - shared by the Deliver page and the server (server.mjs passes the chosen one to engine/render2.mjs).
//   aspects:   frame shapes the platform shows well (first = preferred); others still render, with a warning
//   tag:       added to the file name (MyFilm_reel_v1.mp4)
//   short:     cap on the short side of the frame in pixels (1080 = Full HD, 720 = HD); never upscales
//   fps:       frame-rate cap
//   crf:       H.264 quality (lower = better, bigger)       maxrate: video bitrate ceiling in kbit/s (0 = none)
//   sizeMB:    keep the file under this size (lowers the bitrate ceiling for long videos)
//   maxDur:    longest video the platform accepts in that slot, seconds (a warning, not a cut)
//   codec:     'h264' (.mp4) or 'prores' (.mov, ProRes 422 HQ + PCM audio for Premiere / Resolve / broadcast)
export const PRESETS = [
  { id: 'reel', label: 'Instagram Reel / Story', tag: 'reel', aspects: ['9:16'], short: 1080, fps: 30, crf: 20, maxrate: 8000, abr: 192, loudness: -14, maxDur: 180 },
  { id: 'insta-feed', label: 'Instagram / Facebook feed', tag: 'feed', aspects: ['4:5', '1:1'], short: 1080, fps: 30, crf: 20, maxrate: 8000, abr: 192, loudness: -14 },
  { id: 'shorts', label: 'YouTube Shorts', tag: 'shorts', aspects: ['9:16'], short: 1080, fps: 60, crf: 18, maxrate: 0, abr: 256, loudness: -14, maxDur: 180 },
  { id: 'youtube', label: 'YouTube (16:9)', tag: 'youtube', aspects: ['16:9'], short: 2160, fps: 60, crf: 18, maxrate: 0, abr: 256, loudness: -14 },
  { id: 'facebook', label: 'Facebook video', tag: 'fb', aspects: ['16:9', '1:1', '4:5', '9:16'], short: 1080, fps: 30, crf: 20, maxrate: 8000, abr: 192, loudness: -16 },
  { id: 'x', label: 'X (Twitter)', tag: 'x', aspects: ['16:9', '1:1'], short: 1080, fps: 30, crf: 21, maxrate: 6000, abr: 128, loudness: -16, maxDur: 140, sizeMB: 512 },
  { id: 'linkedin', label: 'LinkedIn', tag: 'linkedin', aspects: ['16:9', '1:1', '4:5'], short: 1080, fps: 30, crf: 20, maxrate: 8000, abr: 192, loudness: -16 },
  { id: 'whatsapp', label: 'WhatsApp (small file)', tag: 'whatsapp', aspects: [], short: 720, fps: 30, crf: 26, maxrate: 2000, abr: 128, loudness: -14, sizeMB: 16 },
  { id: 'broadcast', label: 'Event screen / LED wall', tag: 'screen', aspects: ['16:9'], short: 2160, fps: 60, crf: 14, maxrate: 0, abr: 320, loudness: -23 },
  { id: 'master', label: 'Master MP4 (highest quality)', tag: 'master', aspects: [], short: 2160, fps: 60, crf: 14, maxrate: 0, abr: 320, loudness: -16 },
  { id: 'prores', label: 'ProRes 422 HQ .mov (for Premiere / Resolve)', tag: 'prores', aspects: [], short: 2160, fps: 60, codec: 'prores', loudness: -16 },
];
export const presetById = (id) => PRESETS.find((p) => p.id === id);

export const REFRAME = [['blur', 'Blurred background'], ['fill', 'Crop to fill'], ['fit', 'Fit with black bars']];

// Problems worth telling the editor about before rendering (plain sentences).
export function presetWarnings(p, { aspect, duration }) {
  const w = [];
  if (p.aspects.length && !p.aspects.includes(aspect)) w.push(`${p.label} works best in ${p.aspects.join(' or ')}; this edit is ${aspect}.`);
  if (p.maxDur && duration > p.maxDur) w.push(`${p.label} takes up to ${Math.floor(p.maxDur / 60)}:${String(p.maxDur % 60).padStart(2, '0')} min; this edit is ${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')}.`);
  if (p.sizeMB && duration > 0) {
    const kbps = (p.sizeMB * 8192 * 0.95) / duration - (p.abr || 128);
    if (kbps < 500) w.push(`To stay under ${p.sizeMB} MB this ${Math.round(duration)}s video gets only ~${Math.max(0, Math.round(kbps))} kbit/s, so it will look soft. Shorten it or pick another preset.`);
  }
  return w;
}
