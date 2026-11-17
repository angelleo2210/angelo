// Utilidades de geometría facial a partir de los 478 puntos de MediaPipe.
export const OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];

// Devuelve la "pose" de una cara en píxeles de la imagen analizada.
export function faceMetrics(lm, w, h) {
  const P = (i) => ({ x: lm[i].x * w, y: lm[i].y * h });
  const top = P(10), chin = P(152), le = P(33), re = P(263), lc = P(234), rc = P(454);
  const cx = (top.x + chin.x) / 2, cy = (top.y + chin.y) / 2;
  const fh = Math.hypot(chin.x - top.x, chin.y - top.y);
  const fw = Math.hypot(rc.x - lc.x, rc.y - lc.y);
  const roll = Math.atan2(re.y - le.y, re.x - le.x);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of lm) {
    const x = p.x * w, y = p.y * h;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  return { cx, cy, fh, fw, roll, box: { x: minx, y: miny, w: maxx - minx, h: maxy - miny } };
}
