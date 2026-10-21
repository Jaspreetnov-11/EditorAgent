// ◯ ▭ Masks, like Premiere's: an ellipse or a rectangle on the picture that limits where something shows.
//   effect.mask - the effect shows only inside it (blur a face, brighten a sky)
//   clip.omask  - the clip shows only inside it (Opacity mask; on V1 the rest is black, on V2+ the shot below shows)
// mask = { shape: 'ellipse' | 'rect', x, y (centre), w, h (size) as fractions of the frame,
//          feather, expand (px of a 1920-wide frame), opacity 0..1, invert }
// The mask belongs to the clip's picture: Motion (position / scale) moves it along with the picture.
// One maths for the viewer (a small picture used as a CSS mask) and the render (a PNG laid in with FFmpeg's alphamerge).

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const MASK_SHAPES = [['ellipse', '◯ Ellipse'], ['rect', '▭ Rectangle']];
export const newMask = (shape = 'ellipse') => ({ shape, x: 0.5, y: 0.5, w: shape === 'ellipse' ? 0.32 : 0.4, h: shape === 'ellipse' ? 0.5 : 0.4, feather: 40, expand: 0, opacity: 1, invert: false });

// how much of the picture shows at each pixel, 0..255, for a W x H frame
export function maskAlpha(m, W, H) {
  const out = new Uint8Array(W * H), k = W / 1920;
  const fe = Math.max(0.75, (+m.feather || 0) * k), ex = (+m.expand || 0) * k, op = clamp(m.opacity ?? 1, 0, 1);
  const cx = (m.x ?? 0.5) * W, cy = (m.y ?? 0.5) * H, rx = Math.max(1, ((m.w ?? 0.3) * W) / 2), ry = Math.max(1, ((m.h ?? 0.3) * H) / 2);
  const ell = m.shape !== 'rect';
  for (let y = 0; y < H; y++) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      let d; // distance to the edge in px (negative inside)
      if (ell) {
        const q = Math.hypot(dx / rx, dy / ry);
        const g = q > 1e-6 ? Math.hypot(dx / (rx * rx), dy / (ry * ry)) / q : 1 / Math.min(rx, ry);
        d = (q - 1) / g;
      } else {
        const qx = Math.abs(dx) - rx, qy = Math.abs(dy) - ry;
        d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
      }
      let a = clamp(0.5 - (d - ex) / fe, 0, 1);
      if (m.invert) a = 1 - a;
      out[y * W + x] = Math.round(a * op * 255);
    }
  }
  return out;
}

// the mask where it is seen on the frame once Motion has moved / scaled the picture (rotation is left out)
export function movedMask(m, t = {}) {
  const z = +t.zoom || 1, X = (+t.x || 0) / 100, Y = (+t.y || 0) / 100;
  return { ...m, x: 0.5 + ((m.x ?? 0.5) - 0.5) * z + X, y: 0.5 + ((m.y ?? 0.5) - 0.5) * z + Y, w: (m.w ?? 0.3) * z, h: (m.h ?? 0.3) * z, feather: (+m.feather || 0) * z, expand: (+m.expand || 0) * z };
}
// and back: a mask drawn on the frame -> the picture's own
export function unmovedMask(m, t = {}) {
  const z = +t.zoom || 1, X = (+t.x || 0) / 100, Y = (+t.y || 0) / 100;
  return { ...m, x: 0.5 + ((m.x ?? 0.5) - 0.5 - X) / z, y: 0.5 + ((m.y ?? 0.5) - 0.5 - Y) / z, w: (m.w ?? 0.3) / z, h: (m.h ?? 0.3) / z };
}

export const hasMask = (o) => !!(o?.mask?.shape || o?.omask?.shape);
export const maskKey = (m) => JSON.stringify([m.shape, m.x, m.y, m.w, m.h, m.feather, m.expand, m.opacity, m.invert]);
