// Analiza el video cuadro por cuadro, sigue cada cara y suaviza su movimiento.
import { newVideoDetector, getLandmarker } from './vision.js';
import { faceMetrics } from './geometry.js';
import { makeCanvas } from './cutout.js';

const SAMPLE_FPS = 12;      // muestras por segundo de video
const GAP_SPLIT = 0.75;     // s: huecos más largos parten el recorrido
const HOLD_IN = 0.12;       // s: aparece un poquito antes
const HOLD_OUT = 0.45;      // s: mantiene la última posición si se pierde la cara

function seekTo(video, t) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; video.removeEventListener('seeked', fin); clearTimeout(to); resolve(); };
    const to = setTimeout(fin, 2500);
    video.addEventListener('seeked', fin);
    video.currentTime = t;
  });
}

export async function analyzeVideo(video, end, onProgress, isCancelled = () => false) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.min(1, 960 / Math.max(vw, vh));
  const aw = Math.round(vw * s), ah = Math.round(vh * s);
  const asp = aw / ah;
  const ac = makeCanvas(aw, ah);
  const g = ac.getContext('2d');
  const CROP = 256;
  const cc = makeCanvas(CROP, CROP);
  const cg = cc.getContext('2d');
  const det = await newVideoDetector();
  const lmImg = await getLandmarker('IMAGE', 4);
  const tracks = [];
  const frames = []; // {t, ids:[]}
  const n = Math.max(1, Math.floor(end * SAMPLE_FPS));
  const step = Math.round(1000 / SAMPLE_FPS);

  const toDet = (m, t) => ({ t, cx: m.cx / aw, cy: m.cy / ah, h: m.fh / ah, w: m.fw / ah, roll: m.roll,
    box: { x: m.box.x / aw, y: m.box.y / ah, w: m.box.w / aw, h: m.box.h / ah } });

  for (let k = 0; k <= n; k++) {
    if (isCancelled()) break;
    const t = Math.min(Math.max(0, end - 0.05), k / SAMPLE_FPS);
    await seekTo(video, t);
    g.drawImage(video, 0, 0, aw, ah);
    let dets = [];
    // 1) Detector de largo alcance en todo el cuadro.
    let boxes = [];
    try { boxes = (det.detectForVideo(ac, k * step + 1).detections || []).slice(0, 6); } catch (e) { console.warn(e); }
    // 2) Para cada cara, acerca la imagen y saca los 478 puntos de la cara.
    for (const b of boxes) {
      const bb = b.boundingBox;
      const bcx = bb.originX + bb.width / 2, bcy = bb.originY + bb.height / 2;
      const size = Math.max(bb.width, bb.height) * 2.2;
      const x0 = bcx - size / 2, y0 = bcy - size / 2;
      cg.fillStyle = '#000'; cg.fillRect(0, 0, CROP, CROP);
      cg.drawImage(ac, x0, y0, size, size, 0, 0, CROP, CROP);
      let res = null;
      try { res = lmImg.detect(cc); } catch (e) { console.warn(e); }
      let bestL = null, bd = Infinity;
      for (const L of (res && res.faceLandmarks) || []) {
        const d = Math.hypot(L[1].x - 0.5, L[1].y - 0.5);
        if (d < bd) { bd = d; bestL = L; }
      }
      if (bestL && bd < 0.3) {
        const mapped = bestL.map((p) => ({ x: (x0 + p.x * size) / aw, y: (y0 + p.y * size) / ah, z: p.z }));
        dets.push(toDet(faceMetrics(mapped, aw, ah), t));
      } else if (b.keypoints && b.keypoints.length >= 2) {
        // Sin puntos finos: usa la caja y los ojos del detector.
        const k0 = b.keypoints[0], k1 = b.keypoints[1];
        const roll = Math.atan2((k1.y - k0.y) * ah, (k1.x - k0.x) * aw);
        dets.push({ t, cx: bcx / aw, cy: (bcy + bb.height * 0.02) / ah, h: (bb.height * 1.12) / ah, w: (bb.width * 0.95) / ah, roll,
          box: { x: bb.originX / aw, y: bb.originY / ah, w: bb.width / aw, h: bb.height / ah }, rough: true });
      }
    }
    // 3) Respaldo: si el detector no vio nada, intenta con el cuadro completo.
    if (!boxes.length) {
      try {
        const r2 = lmImg.detect(ac);
        for (const L of r2.faceLandmarks || []) dets.push(toDet(faceMetrics(L, aw, ah), t));
      } catch (e) { console.warn(e); }
    }
    // Quita duplicados (misma cara vista dos veces).
    dets = dets.filter((d, i) => !dets.some((o, j) => j < i && Math.hypot((d.cx - o.cx) * asp, d.cy - o.cy) < Math.max(d.h, o.h) * 0.8));
    // Asociación por cercanía (cara más cercana a la última posición de cada pista).
    const pairs = [];
    dets.forEach((d, i) => tracks.forEach((tr, j) => {
      const L = tr.last; const dt = t - L.t;
      if (dt <= 0 || dt > 2.5) return;
      const dist = Math.hypot((d.cx - L.cx) * asp, d.cy - L.cy) / Math.max(L.h, d.h, 1e-3);
      const sizeRatio = Math.max(d.h, L.h) / Math.max(1e-3, Math.min(d.h, L.h));
      if (dist < 1.1 + dt * 0.4 && sizeRatio < 1.8) pairs.push([dist, i, j]);
    }));
    pairs.sort((a, b) => a[0] - b[0]);
    const usedD = new Set(), usedT = new Set();
    const ids = [];
    const assign = (d, tr) => {
      tr.samples.push(d); tr.last = d; ids.push(tr.id);
      if (d.h > tr.thumbH) { // guarda la mejor miniatura
        tr.thumbH = d.h;
        const sz = d.h * ah * 1.5;
        const tc = tr.thumb || (tr.thumb = makeCanvas(96, 96));
        const tg = tc.getContext('2d');
        tg.clearRect(0, 0, 96, 96);
        tg.drawImage(ac, d.cx * aw - sz / 2, d.cy * ah - sz / 2, sz, sz, 0, 0, 96, 96);
      }
    };
    for (const [, i, j] of pairs) {
      if (usedD.has(i) || usedT.has(j)) continue;
      usedD.add(i); usedT.add(j); assign(dets[i], tracks[j]);
    }
    dets.forEach((d, i) => {
      if (usedD.has(i) || tracks.length >= 12) return;
      const tr = { id: tracks.length, samples: [], last: d, thumbH: 0, thumb: null };
      tracks.push(tr); assign(d, tr);
    });
    frames.push({ t, ids });
    onProgress && onProgress((k + 1) / (n + 1));
  }
  try { det.close(); } catch (_) {}

  // Descarta pistas muy cortas (falsos positivos) y ordena por duración.
  const maxN = tracks.reduce((m, tr) => Math.max(m, tr.samples.length), 0);
  let good = tracks.filter((tr) => tr.samples.length >= Math.max(4, Math.min(SAMPLE_FPS, maxN * 0.2)));
  good.sort((a, b) => b.samples.length - a.samples.length);
  good = good.slice(0, 6);
  const keep = new Set(good.map((t) => t.id));
  // Mejor cuadro para elegir caras: el que tenga más caras (y más grandes).
  let bestT = 0, bestScore = -1;
  for (const f of frames) {
    const ids = f.ids.filter((id) => keep.has(id));
    const size = ids.reduce((acc, id) => {
      const tr = tracks[id]; const sm = tr.samples.find((x) => x.t === f.t); return acc + (sm ? sm.h : 0);
    }, 0);
    const score = ids.length * 10 + size;
    if (score > bestScore) { bestScore = score; bestT = f.t; }
  }
  good.forEach((tr, i) => { tr.num = i + 1; });
  return { tracks: good, bestT, aspect: asp };
}

// Suavizado gaussiano centrado (sin retraso porque se hace después del análisis).
export function buildPath(track, smooth = 0.5) {
  const sigma = 0.015 + smooth * 0.2;
  const segs = [];
  let cur = [];
  for (const s of track.samples) {
    if (cur.length && s.t - cur[cur.length - 1].t > GAP_SPLIT) { segs.push(cur); cur = []; }
    cur.push(s);
  }
  if (cur.length) segs.push(cur);
  track.path = segs.map((seg) => {
    // Desenrolla el ángulo para que no salte de +180 a -180.
    const rolls = []; let prev = null;
    for (const s of seg) {
      let r = s.roll;
      if (prev !== null) { while (r - prev > Math.PI) r -= 2 * Math.PI; while (r - prev < -Math.PI) r += 2 * Math.PI; }
      rolls.push(r); prev = r;
    }
    return seg.map((s, i) => {
      let W = 0, cx = 0, cy = 0, h = 0, w = 0, roll = 0;
      for (let j = 0; j < seg.length; j++) {
        const dt = seg[j].t - s.t;
        if (Math.abs(dt) > sigma * 3) continue;
        const wt = Math.exp(-(dt * dt) / (2 * sigma * sigma));
        W += wt; cx += seg[j].cx * wt; cy += seg[j].cy * wt; h += seg[j].h * wt; w += seg[j].w * wt; roll += rolls[j] * wt;
      }
      return { t: s.t, cx: cx / W, cy: cy / W, h: h / W, w: w / W, roll: roll / W };
    });
  });
}

export function poseAt(track, t) {
  if (!track.path) buildPath(track);
  for (const seg of track.path) {
    const a = seg[0], z = seg[seg.length - 1];
    if (t < a.t - HOLD_IN || t > z.t + HOLD_OUT) continue;
    if (t <= a.t) return { ...a, alpha: 1 };
    if (t >= z.t) {
      const k = (t - z.t - HOLD_OUT * 0.5) / (HOLD_OUT * 0.5);
      return { ...z, alpha: Math.max(0, Math.min(1, 1 - k)) };
    }
    let lo = 0, hi = seg.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (seg[mid].t <= t) lo = mid; else hi = mid; }
    const p = seg[lo], q = seg[hi];
    const u = (t - p.t) / Math.max(1e-6, q.t - p.t);
    const L = (x, y) => x + (y - x) * u;
    return { t, cx: L(p.cx, q.cx), cy: L(p.cy, q.cy), h: L(p.h, q.h), w: L(p.w, q.w), roll: L(p.roll, q.roll), alpha: 1 };
  }
  return null;
}
