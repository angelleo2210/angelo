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
