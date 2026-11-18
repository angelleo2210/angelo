// Utilidades de geometría facial a partir de los 478 puntos de MediaPipe.
export const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];

// Puntos rígidos (ojos, nariz, frente): no se mueven al hablar ni al abrir la boca.
export const RIGID = [33, 133, 362, 263, 168, 6, 1, 2, 10];

// Devuelve la "pose" de una cara en píxeles de la imagen analizada.
// cx,cy = centro de los puntos rígidos; fh = tamaño (frente→base de la nariz, no cambia al hablar);
// fw = ancho mejilla a mejilla (para simular el giro); roll = inclinación por la línea de los ojos.
export function faceMetrics(lm, w, h) {
  const P = (i) => ({ x: lm[i].x * w, y: lm[i].y * h });
  let cx = 0, cy = 0;
  for (const i of RIGID) { cx += lm[i].x * w; cy += lm[i].y * h; }
  cx /= RIGID.length; cy /= RIGID.length;
  const top = P(10), sub = P(2), le = P(33), re = P(263), lc = P(234), rc = P(454);
  const fh = Math.hypot(sub.x - top.x, sub.y - top.y);
  const fw = Math.hypot(rc.x - lc.x, rc.y - lc.y);
  // Ojos: promedio de esquinas externas e internas (más estable).
  const li = P(133), ri = P(362);
  const roll = Math.atan2((re.y + ri.y) / 2 - (le.y + li.y) / 2, (re.x + ri.x) / 2 - (le.x + li.x) / 2);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of lm) {
    const x = p.x * w, y = p.y * h;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  return { cx, cy, fh, fw, roll, box: { x: minx, y: miny, w: maxx - minx, h: maxy - miny } };
}

// ---- Malla completa ----
export const NPTS = 468; // puntos de la malla (sin iris)
// Puntos para la "similitud" (posición, tamaño, giro): ojos y línea de la nariz.
export const SIM = [33, 133, 362, 263, 168, 6, 197, 195, 5, 4, 1, 2];
// Puntos de piel para medir color (mejillas, frente, nariz, barbilla).
// (sin barbilla ni bigote, donde suele haber barba o sombra)
export const SKIN = [151, 9, 108, 337, 69, 299, 50, 101, 118, 117, 123, 280, 330, 347, 346, 352, 4, 5, 195, 197, 36, 205, 266, 425, 116, 345];

// pts: Float32Array [x0,y0,x1,y1,...] en coordenadas isótropas (mismo factor en x e y).
export function simOf(pts) {
  let cx = 0, cy = 0;
  for (const i of SIM) { cx += pts[2 * i]; cy += pts[2 * i + 1]; }
  cx /= SIM.length; cy /= SIM.length;
  let ss = 0;
  for (const i of SIM) { const dx = pts[2 * i] - cx, dy = pts[2 * i + 1] - cy; ss += dx * dx + dy * dy; }
  const s = Math.sqrt(ss / SIM.length) || 1e-6;
  const ex = (pts[2 * 263] + pts[2 * 362]) / 2 - (pts[2 * 33] + pts[2 * 133]) / 2;
  const ey = (pts[2 * 263 + 1] + pts[2 * 362 + 1]) / 2 - (pts[2 * 33 + 1] + pts[2 * 133 + 1]) / 2;
  return { x: cx, y: cy, s, r: Math.atan2(ey, ex) };
}

// Forma local de la cara (sin posición/tamaño/giro).
export function localShape(pts, sim) {
  const L = new Float32Array(NPTS * 2);
  const c = Math.cos(-sim.r), sn = Math.sin(-sim.r);
  for (let i = 0; i < NPTS; i++) {
    const dx = (pts[2 * i] - sim.x) / sim.s, dy = (pts[2 * i + 1] - sim.y) / sim.s;
    L[2 * i] = dx * c - dy * sn; L[2 * i + 1] = dx * sn + dy * c;
  }
  return L;
}

// Reconstruye los puntos (en píxeles) a partir de similitud + forma local.
export function compose(sim, L, scaleMul, rotAdd, offX, offY, out) {
  const s = sim.s * scaleMul, r = sim.r + rotAdd;
  const c = Math.cos(r) * s, sn = Math.sin(r) * s;
  const o = out || new Float32Array(NPTS * 2);
  for (let i = 0; i < NPTS; i++) {
    const x = L[2 * i], y = L[2 * i + 1];
    o[2 * i] = sim.x + offX + x * c - y * sn;
    o[2 * i + 1] = sim.y + offY + x * sn + y * c;
  }
  return o;
}

// Color: sRGB (0..255) -> Lab
function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function fl(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
export function rgb2lab(r, g, b) {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
  const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const fx = fl(X), fy = fl(Y), fz = fl(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Estadísticas de color (media y desviación Lab) de la piel en una imagen.
// data: ImageData.data de tamaño w x h; pts en píxeles de esa imagen.
export function skinStats(data, w, h, pts, rad = 1) {
  const vals = [];
  for (const i of SKIN) {
    const px = Math.round(pts[2 * i]), py = Math.round(pts[2 * i + 1]);
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const k = (y * w + x) * 4;
      vals.push(rgb2lab(data[k], data[k + 1], data[k + 2]));
    }
  }
  if (vals.length < 10) return null;
  // Quita extremos (brillos/sombras fuertes): usa el 10%-90% de luminosidad.
  vals.sort((a, b) => a[0] - b[0]);
  const v = vals.slice(Math.floor(vals.length * 0.1), Math.ceil(vals.length * 0.9));
  const m = [0, 0, 0], s = [0, 0, 0];
  for (const x of v) for (let c = 0; c < 3; c++) m[c] += x[c] / v.length;
  for (const x of v) for (let c = 0; c < 3; c++) s[c] += (x[c] - m[c]) ** 2 / v.length;
  return [m[0], m[1], m[2], Math.sqrt(s[0]) + 1, Math.sqrt(s[1]) + 1, Math.sqrt(s[2]) + 1];
}
