// Recorta la cara de una foto con bordes suaves (óvalo) o con pelo (segmentación IA).
import { getLandmarker, getSegmenter } from './vision.js';
import { OVAL, faceMetrics, NPTS, skinStats } from './geometry.js';

let CUT_ID = 0;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

export function loadImageCanvas(file, maxSide = 1024) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = makeCanvas(img.naturalWidth * s, img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('BADIMAGE')); };
    img.src = url;
  });
}

// Dibuja una forma con borde difuminado usando el truco de la sombra
// (ctx.filter no existe en Safari de iPhone).
function featherDraw(target, feather, drawFn) {
  const g = target.getContext('2d');
  const off = target.width + feather * 4 + 50;
  g.save();
  g.shadowColor = '#fff';
  g.shadowBlur = feather;
  g.shadowOffsetX = off;
  g.translate(-off, 0);
  drawFn(g);
  g.restore();
}

function polyPath(g, pts) {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
}

export async function makeCutout(file, mode = 'oval') {
  const src = await loadImageCanvas(file, 1024);
  const W = src.width, H = src.height;
  const lm = await getLandmarker('IMAGE', 4);
  const res = lm.detect(src);
  if (!res.faceLandmarks || !res.faceLandmarks.length) throw new Error('NOFACE');
  let best = null;
  for (const L of res.faceLandmarks) {
    const m = faceMetrics(L, W, H);
    if (!best || m.fh > best.m.fh) best = { L, m };
  }
  const { L, m } = best;
  // Alto completo de la cara (frente→barbilla) solo para el recorte.
  const tx = L[10].x * W, ty = L[10].y * H, bx = L[152].x * W, by = L[152].y * H;
  const FH = Math.hypot(bx - tx, by - ty);
  const feather = Math.max(2, FH * 0.06);
  const c = { x: (tx + bx) / 2, y: (ty + by) / 2 };
  // Óvalo de la cara, un poco más grande y con más frente.
  let pts = OVAL.map((i) => ({ x: L[i].x * W, y: L[i].y * H }));
  pts = pts.map((p) => {
    const dx = p.x - c.x, dy = p.y - c.y;
    const k = 1.03, up = dy < 0 ? 1.08 : 1.0;
    const nx = c.x + dx * k, ny = c.y + dy * k * up;
    // Encoge medio "feather" para que el borde difuminado quede dentro.
    const d = Math.hypot(nx - c.x, ny - c.y) || 1;
    const s = Math.max(0, (d - feather * 0.5) / d);
    return { x: c.x + (nx - c.x) * s, y: c.y + (ny - c.y) * s };
  });

  const mask = makeCanvas(W, H);
  if (mode === 'hair') {
    const seg = await getSegmenter();
    const r = seg.segment(src);
    const cm = r.categoryMask;
    const data = cm.getAsUint8Array();
    const mw = cm.width, mh = cm.height;
    const raw = makeCanvas(mw, mh);
    const rg = raw.getContext('2d');
    const id = rg.createImageData(mw, mh);
    const sx = mw / W, sy = mh / H;
    const chinY = (L[152].y * H + FH * 0.02) * sy;
    const x0 = (m.cx - m.fw * 1.1) * sx, x1 = (m.cx + m.fw * 1.1) * sx;
    const yTop = (c.y - FH * 1.4) * sy;
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const i = y * mw + x;
        const cat = data[i];
        if ((cat === 1 || cat === 3) && y <= chinY && y >= yTop && x >= x0 && x <= x1) id.data[i * 4 + 3] = 255;
      }
    }
    rg.putImageData(id, 0, 0);
    try { cm.close(); } catch (_) {}
    try { r.close && r.close(); } catch (_) {}
    featherDraw(mask, feather * 0.6, (g) => {
      g.imageSmoothingEnabled = true;
      g.drawImage(raw, 0, 0, W, H);
      g.fillStyle = '#fff';
      polyPath(g, pts); g.fill();
    });
  } else {
    featherDraw(mask, feather, (g) => { g.fillStyle = '#fff'; polyPath(g, pts); g.fill(); });
  }

  // Recorta al rectángulo con contenido.
  const mg = mask.getContext('2d');
  const md = mg.getImageData(0, 0, W, H).data;
  let bx0 = W, by0 = H, bx1 = 0, by1 = 0;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    if (md[(y * W + x) * 4 + 3] > 8) {
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
  }
  bx0 = Math.max(0, bx0 - 2); by0 = Math.max(0, by0 - 2);
  bx1 = Math.min(W, bx1 + 3); by1 = Math.min(H, by1 + 3);
  const cw = bx1 - bx0, ch = by1 - by0;
  if (cw < 8 || ch < 8) throw new Error('NOFACE');
  const out = makeCanvas(cw, ch);
  const og = out.getContext('2d');
  og.drawImage(src, bx0, by0, cw, ch, 0, 0, cw, ch);
  og.globalCompositeOperation = 'destination-in';
  og.drawImage(mask, bx0, by0, cw, ch, 0, 0, cw, ch);
  og.globalCompositeOperation = 'source-over';
  // ---- Datos para pegar con la malla (modo "cara") ----
  const mp = new Float32Array(NPTS * 2);
  let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
  for (let i = 0; i < NPTS; i++) {
    const x = L[i].x * W, y = L[i].y * H; mp[2 * i] = x; mp[2 * i + 1] = y;
    if (x < mx0) mx0 = x; if (x > mx1) mx1 = x; if (y < my0) my0 = y; if (y > my1) my1 = y;
  }
  const padX = (mx1 - mx0) * 0.08, padY = (my1 - my0) * 0.08;
  const tx0 = Math.max(0, Math.floor(mx0 - padX)), ty0 = Math.max(0, Math.floor(my0 - padY));
  const tx1 = Math.min(W, Math.ceil(mx1 + padX)), ty1 = Math.min(H, Math.ceil(my1 + padY));
  const tw = tx1 - tx0, th = ty1 - ty0;
  const ts = Math.min(1, 768 / Math.max(tw, th));
  const tex = makeCanvas(tw * ts, th * ts);
  const tg = tex.getContext('2d');
  tg.drawImage(src, tx0, ty0, tw, th, 0, 0, tex.width, tex.height);
  // Máscara de piel (IA): el pelo, el fondo y la ropa de la foto se vuelven transparentes
  // para que no tapen la cara del video. Va en el canal alfa de la textura.
  let skinMask = false;
  try {
    const seg = await getSegmenter();
    const r = seg.segment(src);
    const cm = r.categoryMask, data = cm.getAsUint8Array(), mw = cm.width, mh = cm.height;
    const raw = makeCanvas(mw, mh), rg = raw.getContext('2d'), id = rg.createImageData(mw, mh);
    for (let i = 0; i < mw * mh; i++) { const c = data[i]; id.data[i * 4 + 3] = (c === 2 || c === 3 || c === 5) ? 255 : 0; }
    rg.putImageData(id, 0, 0);
    try { cm.close(); } catch (_) {}
    try { r.close && r.close(); } catch (_) {}
    const mk = makeCanvas(tex.width, tex.height);
    featherDraw(mk, Math.max(1.5, tex.width / 160), (g) => { g.imageSmoothingEnabled = true; g.drawImage(raw, tx0 * mw / W, ty0 * mh / H, tw * mw / W, th * mh / H, 0, 0, tex.width, tex.height); });
    tg.globalCompositeOperation = 'destination-in';
    tg.drawImage(mk, 0, 0);
    tg.globalCompositeOperation = 'source-over';
    skinMask = true;
  } catch (e) { console.warn('[angelo] sin máscara de piel', e); }
  const uv = new Float32Array(NPTS * 2);
  for (let i = 0; i < NPTS; i++) { uv[2 * i] = (mp[2 * i] - tx0) / tw; uv[2 * i + 1] = (mp[2 * i + 1] - ty0) / th; }
  const img = src.getContext('2d').getImageData(0, 0, W, H);
  const stats = skinStats(img.data, W, H, mp, 2);
  // La frente de arriba se desvanece hacia la frente real (oculta pelo/entradas de la foto).
  const brow = [105, 66, 107, 334, 296, 336].reduce((a, i) => a + mp[2 * i + 1], 0) / 6;
  const top = mp[2 * 10 + 1];
  const fore = new Float32Array(NPTS);
  for (let i = 0; i < NPTS; i++) {
    const f = Math.max(0, Math.min(1, (brow - mp[2 * i + 1]) / Math.max(1, brow - top)));
    const t = Math.max(0, Math.min(1, (f - 0.2) / 0.75));
    fore[i] = 1 - t * t * (3 - 2 * t);
  }
  const srcPts = new Float32Array(NPTS * 2);
  for (let i = 0; i < NPTS; i++) { srcPts[2 * i] = mp[2 * i] - bx0; srcPts[2 * i + 1] = mp[2 * i + 1] - by0; }
  return { id: ++CUT_ID, canvas: out, ax: m.cx - bx0, ay: m.cy - by0, faceH: m.fh, faceW: m.fw, roll: m.roll,
    tex, uv, stats, fore, srcPts, mode, skinMask };
}
