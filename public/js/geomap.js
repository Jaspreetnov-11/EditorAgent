// 🗺 Map layers for Motion (like GeoLayers in After Effects): a region's outlines - India's states (official boundary),
// Chhattisgarh's districts or the world's countries - with highlighted areas that glow, an outline that draws itself
// on, city pins with names, a route that travels between them, and a camera (centre + zoom) to fly in; under it, if
// wanted, real satellite / street / dark map tiles (fetched once by the editor and kept: /api/maptile).
// Drawn by motion.js drawLayer in the layer's own space (the box -w/2..w/2, -h/2..h/2), the same for the viewer and
// the bake. Boundaries: public/maps/*.json (built from Natural Earth and datameet-style Survey of India shapes).
//
// L.map = { region, style: 'outline' | 'satellite' | 'street' | 'dark', w, h, center: [lon, lat] | null, zoom,
//           fill, stroke, strokeW, others: true (draw the areas that are not highlighted), hi: [{ name, color }], glow,
//           draw (0..100 outline on), pins: [{ name, lon, lat }], pinColor, pinSize, labelSize, pinPop,
//           route: { on, color, width, progress (0..100), curve } }  (center, zoom, strokeW, draw, route.progress animate)

export const REGIONS = { india: 'India - states', chhattisgarh: 'Chhattisgarh - districts', world: 'World - countries' };
export const STYLES = { outline: 'Outline only', satellite: 'Satellite (Esri imagery)', street: 'Street map (Esri)', dark: 'Dark map (Esri)' };
// places for pins (lon, lat)
export const PLACES = {
  Raipur: [81.63, 21.25], 'Nava Raipur': [81.79, 21.16], Bilaspur: [82.14, 22.08], Durg: [81.28, 21.19], Bhilai: [81.38, 21.21], Korba: [82.75, 22.36],
  Jagdalpur: [82.02, 19.08], Ambikapur: [83.2, 23.12], Raigarh: [83.4, 21.9], Rajnandgaon: [81.03, 21.1], Dantewada: [81.35, 18.9], Kanker: [81.49, 20.27],
  Kawardha: [81.23, 22.01], Dhamtari: [81.55, 20.71], Mahasamund: [82.1, 21.11], Janjgir: [82.58, 22.01], Jashpur: [84.13, 22.88], Sukma: [81.66, 18.39],
  Bijapur: [80.77, 18.84], Narayanpur: [81.25, 19.72], Kondagaon: [81.66, 19.59],
  'New Delhi': [77.21, 28.61], Mumbai: [72.88, 19.08], Kolkata: [88.36, 22.57], Chennai: [80.27, 13.08], Bengaluru: [77.59, 12.97], Hyderabad: [78.49, 17.39],
  Ahmedabad: [72.57, 23.02], Pune: [73.86, 18.52], Jaipur: [75.79, 26.91], Lucknow: [80.95, 26.85], Bhopal: [77.41, 23.26], Patna: [85.14, 25.59],
  Bhubaneswar: [85.82, 20.3], Guwahati: [91.74, 26.14], Srinagar: [74.8, 34.08], Leh: [77.58, 34.15], Chandigarh: [76.78, 30.73], Varanasi: [82.97, 25.32],
  Nagpur: [79.09, 21.15], Thiruvananthapuram: [76.94, 8.52], Panaji: [73.83, 15.49], Ranchi: [85.31, 23.34], Dehradun: [78.03, 30.32], Shimla: [77.17, 31.1],
  Indore: [75.86, 22.72], Visakhapatnam: [83.22, 17.69],
};
export const newMap = (w, h) => ({ region: 'india', style: 'outline', w, h, center: null, zoom: 1, fill: '#13294b', stroke: '#9fc3ff', strokeW: 1.5, others: true,
  hi: [{ name: 'Chhattisgarh', color: '#ff9933' }], glow: 24, draw: 100, pins: [], pinColor: '#ffd400', pinSize: 14, labelSize: 30, pinPop: true,
  route: { on: false, color: '#ffd400', width: 6, progress: 100, curve: 0.25 } });

// ---------------- data + tiles (loaded once; drawing asks, a listener redraws when it arrives) ----------------
const sets = new Map(), tiles = new Map(), listeners = new Set();
let pending = 0, idleWait = [];
export const onGeoLoad = (fn) => listeners.add(fn);
const loaded = () => { listeners.forEach((f) => { try { f(); } catch {} }); if (!pending) { idleWait.forEach((f) => f()); idleWait = []; } };
const doneOne = () => { pending--; loaded(); };
export const geoPending = () => pending > 0;
export const geoIdle = () => (pending ? new Promise((ok) => idleWait.push(ok)) : Promise.resolve());
export function mapSet(k) {
  if (!REGIONS[k] || typeof fetch === 'undefined') return null;
  if (!sets.has(k)) { sets.set(k, null); pending++; fetch(`/maps/${k}.json`).then((r) => r.json()).then((j) => sets.set(k, prep(j))).catch(() => {}).finally(doneOne); }
  return sets.get(k);
}
// rings in Mercator units (0..1 across the world), once
function prep(j) {
  for (const it of j.items) { it.m = it.p.map((r) => { const o = new Float64Array(r.length); for (let i = 0; i < r.length; i += 2) { o[i] = mx(r[i]); o[i + 1] = my(r[i + 1]); } return o; }); }
  const [a, b, c, d] = j.bbox; j.mb = [mx(a), my(d), mx(c), my(b)];
  return j;
}
const TILE_STYLES = new Set(['satellite', 'street', 'dark']);
function tile(s, z, x, y) {
  const k = `${s}/${z}/${x}/${y}`; let im = tiles.get(k);
  if (!im && typeof Image !== 'undefined') {
    im = new Image(); pending++; let done = false; const fin = () => { if (!done) { done = true; doneOne(); } };
    im.onload = fin; im.onerror = fin; im.src = `/api/maptile?s=${s}&z=${z}&x=${x}&y=${y}`; tiles.set(k, im);
    if (tiles.size > 1500) tiles.delete(tiles.keys().next().value);
  }
  return im?.complete && im.naturalWidth ? im : null;
}

// ---------------- projection ----------------
const mx = (lon) => (lon + 180) / 360;
const my = (lat) => { const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
// the view: Mercator point at the box centre and px per Mercator unit
function view(m, data, val, t) {
  const w = m.w || 1920, h = m.h || 1080, mb = data?.mb || [mx(68), my(37), mx(97.5), my(6.5)];
  const c = val(m.center, t), z = Math.max(0.05, +val(m.zoom, t) || 1);
  const cx = c ? mx(c[0]) : (mb[0] + mb[2]) / 2, cy = c ? my(c[1]) : (mb[1] + mb[3]) / 2;
  const k = Math.min(w / (mb[2] - mb[0] || 1e-3), h / (mb[3] - mb[1] || 1e-3)) * 0.9 * z;
  return { w, h, cx, cy, k, X: (u) => (u - cx) * k, Y: (v) => (v - cy) * k };
}
// a place (name or [lon, lat]) -> layer px
export function mapPoint(m, data, val, t, lon, lat) { const V = view(m, data, val, t); return [V.X(mx(lon)), V.Y(my(lat))]; }

// ---------------- drawing ----------------
export function drawMap(ctx, L, t, val, opts = {}) {
  const m = L.map, data = mapSet(m.region), india = m.region === 'world' ? mapSet('india') : null, V = view(m, data, val, t);
  const { w, h } = V;
  ctx.save();
  ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.clip();
  // tiles: the zoom level whose pixels match the view, every tile the box sees
  if (TILE_STYLES.has(m.style)) {
    const z = Math.max(0, Math.min(17, Math.ceil(Math.log2(V.k / 256)))), n = 2 ** z, ts = V.k / n;
    const u0 = V.cx - w / 2 / V.k, u1 = V.cx + w / 2 / V.k, v0 = V.cy - h / 2 / V.k, v1 = V.cy + h / 2 / V.k;
    for (let y = Math.max(0, Math.floor(v0 * n)); y <= Math.min(n - 1, Math.floor(v1 * n)); y++) for (let x = Math.floor(u0 * n); x <= Math.floor(u1 * n); x++) {
      const xx = ((x % n) + n) % n, im = tile(m.style, z, xx, y);
      if (im) ctx.drawImage(im, V.X(x / n) - 0.5, V.Y(y / n) - 0.5, ts + 1, ts + 1);
      else if (opts.placeholder) { ctx.fillStyle = '#ffffff0a'; ctx.fillRect(V.X(x / n), V.Y(y / n), ts - 1, ts - 1); }
    }
  }
  if (!data) { ctx.restore(); return; }
  const hi = new Map((m.hi || []).filter((x) => x?.name).map((x) => [x.name.toLowerCase(), x.color || '#ff9933']));
  const tiled = TILE_STYLES.has(m.style), sw = Math.max(0, +val(m.strokeW, t) || 0), drawP = Math.max(0, Math.min(100, val(m.draw, t) ?? 100)) / 100;
  const ring = (r) => { ctx.moveTo(V.X(r[0]), V.Y(r[1])); for (let i = 2; i < r.length; i += 2) ctx.lineTo(V.X(r[i]), V.Y(r[i + 1])); ctx.closePath(); };
  const len = (r) => { let s = 0; for (let i = 2; i < r.length; i += 2) s += Math.hypot((r[i] - r[i - 2]) * V.k, (r[i + 1] - r[i - 1]) * V.k); return s; };
  const items = (data.items || []).filter((it) => !(india && it.n === 'India'));
  const all = india ? [...items, ...india.items.map((it) => ({ ...it, india: true }))] : items;
  // the areas that are not highlighted (fill, then borders); on tiles only their borders
  if (m.others !== false) {
    ctx.beginPath(); for (const it of all) it.m.forEach(ring); // (highlighted ones too: land under them until they light up)
    if (!tiled) { ctx.fillStyle = val(m.fill, t) || '#13294b'; ctx.fill(); }
    if (sw > 0) { ctx.strokeStyle = val(m.stroke, t) || '#9fc3ff'; ctx.lineWidth = sw; ctx.lineJoin = 'round'; ctx.globalAlpha *= tiled ? 0.8 : 0.65; ctx.stroke(); ctx.globalAlpha /= tiled ? 0.8 : 0.65; }
  }
  // highlighted areas: their colour, a glow, the outline drawing itself on
  for (const it of all) {
    const col = hi.get(it.n.toLowerCase()) || (india && it.india ? hi.get('india') : null); if (!col) continue;
    ctx.save();
    ctx.beginPath(); it.m.forEach(ring);
    ctx.globalAlpha *= drawP < 1 ? drawP : 1;
    ctx.fillStyle = col + (tiled ? '55' : 'cc'); ctx.shadowColor = col; ctx.shadowBlur = +val(m.glow, t) || 0; ctx.fill();
    ctx.restore();
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, sw * 2); ctx.lineJoin = 'round'; ctx.shadowColor = col; ctx.shadowBlur = (+val(m.glow, t) || 0) * 0.6;
    for (const r of it.m) { const l = len(r); ctx.setLineDash(drawP < 1 ? [l * drawP, l] : []); ctx.beginPath(); ring(r); ctx.stroke(); }
    ctx.restore();
  }
  drawRoute(ctx, m, V, val, t);
  drawPins(ctx, L, V, val, t);
  if (tiled) { ctx.font = `${Math.round(h * 0.016)}px Segoe UI, Arial`; ctx.fillStyle = '#ffffffb0'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText('Tiles © Esri and its data providers', w / 2 - 10, h / 2 - 6); }
  ctx.restore();
}
const pinXY = (V, p) => [V.X(mx(+p.lon)), V.Y(my(+p.lat))];
function drawPins(ctx, L, V, val, t) {
  const m = L.map, pins = (m.pins || []).filter((p) => Number.isFinite(+p.lon) && Number.isFinite(+p.lat)); if (!pins.length) return;
  const r = +m.pinSize || 14, fs = +m.labelSize || 30, col = m.pinColor || '#ffd400';
  pins.forEach((p, i) => {
    const age = t - (L.in || 0) - 0.15 * i, k = m.pinPop === false ? 1 : Math.max(0, Math.min(1, age / 0.35)); if (k <= 0) return;
    const pop = k < 1 ? 1 + 0.35 * Math.sin(k * Math.PI) : 1, [x, y] = pinXY(V, p);
    ctx.save(); ctx.globalAlpha *= k;
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = r * 1.5;
    ctx.beginPath(); ctx.arc(x, y, r * pop, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.lineWidth = r * 0.3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    if (p.name && m.labels !== false) {
      ctx.font = `700 ${fs}px "Nirmala UI", "Segoe UI", Arial`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.lineWidth = Math.max(3, fs * 0.16); ctx.strokeStyle = '#000000b0'; ctx.lineJoin = 'round';
      ctx.strokeText(p.name, x + r * 1.6, y); ctx.fillStyle = '#ffffff'; ctx.fillText(p.name, x + r * 1.6, y);
    }
    ctx.restore();
  });
}
// the route through the pins in order: curved legs, drawn up to progress %, with a glowing head
function drawRoute(ctx, m, V, val, t) {
  const R = m.route, pins = (m.pins || []).filter((p) => Number.isFinite(+p.lon) && Number.isFinite(+p.lat));
  if (!R?.on || pins.length < 2) return;
  const pts = [], cv = +R.curve || 0;
  for (let i = 0; i < pins.length - 1; i++) {
    const [ax, ay] = pinXY(V, pins[i]), [bx, by] = pinXY(V, pins[i + 1]), qx = (ax + bx) / 2 - (by - ay) * cv, qy = (ay + by) / 2 + (bx - ax) * cv;
    for (let s = i ? 1 : 0; s <= 40; s++) { const u = s / 40; pts.push([(1 - u) ** 2 * ax + 2 * u * (1 - u) * qx + u * u * bx, (1 - u) ** 2 * ay + 2 * u * (1 - u) * qy + u * u * by]); }
  }
  let total = 0; const seg = pts.map((p, i) => (i ? (total += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1])) : 0));
  const want = (Math.max(0, Math.min(100, val(R.progress, t) ?? 100)) / 100) * total; if (want <= 0) return;
  ctx.save(); ctx.strokeStyle = R.color || '#ffd400'; ctx.lineWidth = +R.width || 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.shadowColor = R.color || '#ffd400'; ctx.shadowBlur = 16;
  if (R.dashed) ctx.setLineDash([(+R.width || 6) * 2.5, (+R.width || 6) * 2]);
  ctx.beginPath(); ctx.moveTo(...pts[0]);
  let head = pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (seg[i] <= want) { ctx.lineTo(...pts[i]); head = pts[i]; continue; }
    const f = (want - seg[i - 1]) / (seg[i] - seg[i - 1] || 1); head = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]; ctx.lineTo(...head); break;
  }
  ctx.stroke(); ctx.setLineDash([]);
  if (want < total) { ctx.fillStyle = '#ffffff'; ctx.shadowBlur = 24; ctx.beginPath(); ctx.arc(head[0], head[1], (+R.width || 6) * 1.4, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
// the area at a point of the layer (its own px, as drawn at t) - a double-click on the map turns it on / off
export function mapHit(L, t, val, x, y) {
  const m = L.map, data = mapSet(m.region), V = view(m, data, val, t); if (!data) return null;
  const u = x / V.k + V.cx, v = y / V.k + V.cy;
  const inside = (r) => { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) if ((r[i + 1] > v) !== (r[j + 1] > v) && u < ((r[j] - r[i]) * (v - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c; return c; };
  if (m.region === 'world') { const ind = mapSet('india'); if (ind?.items.some((it) => it.m.some(inside))) return 'India'; }
  return data.items.find((it) => it.n !== 'India' && it.m.some(inside))?.n || null;
}
// the names a region's areas have (for the highlight picker)
export const regionNames = (k) => (mapSet(k)?.items || []).map((x) => x.n);
