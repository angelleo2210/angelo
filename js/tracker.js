// Analiza el video CUADRO POR CUADRO, sigue cada cara y guarda su pose
// con el tiempo exacto del cuadro (mediaTime) para pegar la cara sin retraso.
import { newVideoDetector, getLandmarker } from './vision.js';
import { faceMetrics } from './geometry.js';
import { makeCanvas } from './cutout.js';

const MAX_SAMPLE_FPS = 30;  // analiza hasta 30 cuadros por segundo (todos en videos de 24/25/30)
const GAP_SPLIT = 0.25;     // s: huecos más largos no se interpolan (se predice / mantiene)
const PREDICT = 0.12;       // s: si se pierde la cara, sigue su movimiento este tiempo
const HOLD_OUT = 0.35;      // s: luego la mantiene quieta y la desvanece
const HOLD_IN = 0.06;       // s: aparece un poquito antes de la primera detección
export const FACE_UNIT = 2.2; // tamaño de "una cara" respecto a la medida frente→nariz

const hasVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

// Mide los cuadros por segundo reales reproduciendo un instante (sin sonido).
async function measureFrameDuration(video) {
  if (!hasVFC) return 1 / 30;
  const times = [];
  await new Promise((resolve) => {
    let n = 0;
    const to = setTimeout(resolve, 1500);
    const cb = (now, md) => {
      times.push(md.mediaTime);
      if (++n >= 8) { clearTimeout(to); resolve(); return; }
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
    video.muted = true;
    video.currentTime = 0;
    const p = video.play(); if (p && p.catch) p.catch(() => {});
  });
  video.pause();
  const d = [];
  for (let i = 1; i < times.length; i++) { const x = times[i] - times[i - 1]; if (x > 0.004 && x < 0.2) d.push(x); }
  if (!d.length) return 1 / 30;
  d.sort((a, b) => a - b);
  // El menor salto entre cuadros consecutivos = duración de un cuadro.
  return Math.max(1 / 120, Math.min(1 / 10, d[0]));
}

// Va a un tiempo y devuelve el tiempo EXACTO del cuadro que quedó en pantalla.
let vfcHits = 0, vfcMiss = 0;
function seekFrame(video, t) {
  const useVFC = hasVFC && !(vfcHits === 0 && vfcMiss >= 3);
  return new Promise((resolve) => {
    let done = false, seeked = false, mt = null, extra = null;
    const fin = () => {
      if (done) return; done = true;
      clearTimeout(to); clearTimeout(extra);
      video.removeEventListener('seeked', onSeeked);
      if (useVFC) { if (mt != null) vfcHits++; else vfcMiss++; }
      resolve(mt != null ? mt : video.currentTime);
    };
    const onSeeked = () => { seeked = true; if (mt != null || !useVFC) fin(); else extra = setTimeout(fin, 120); };
    const to = setTimeout(fin, 3000);
    if (useVFC) video.requestVideoFrameCallback((now, md) => { if (!done) { mt = md.mediaTime; if (seeked) fin(); } });
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
  });
}

function mergeTracks(tracks, asp) {
  const key = (x) => Math.round(x.t * 1000);
  const dist = (a, b) => Math.hypot((a.cx - b.cx) * asp, a.cy - b.cy) / (Math.max(a.h, b.h) * FACE_UNIT);
  let changed = true;
  while (changed) {
    changed = false;
    tracks.sort((a, b) => b.samples.length - a.samples.length);
    outer: for (let i = 0; i < tracks.length; i++) {
      for (let j = i + 1; j < tracks.length; j++) {
        const A = tracks[i], B = tracks[j];
        const mapA = new Map(A.samples.map((x) => [key(x), x]));
        let common = 0, sum = 0;
        for (const x of B.samples) { const y = mapA.get(key(x)); if (y) { common++; sum += dist(x, y); } }
        const a0 = A.samples[0], a1 = A.samples[A.samples.length - 1];
        const b0 = B.samples[0], b1 = B.samples[B.samples.length - 1];
        let merge = false;
        if (common >= 2 && sum / common < 0.6) merge = true; // duplicada
        else if (common === 0) { // continuación
          if (b0.t > a1.t && b0.t - a1.t < 0.6 && dist(a1, b0) < 1.2) merge = true;
          else if (a0.t > b1.t && a0.t - b1.t < 0.6 && dist(b1, a0) < 1.2) merge = true;
        }
        if (!merge) continue;
        for (const x of B.samples) {
          const y = mapA.get(key(x));
          if (!y) mapA.set(key(x), x);
          else if (y.rough && !x.rough) mapA.set(key(x), x);
        }
        A.samples = [...mapA.values()].sort((p, q) => p.t - q.t);
        if (B.thumbH > A.thumbH) { A.thumb = B.thumb; A.thumbH = B.thumbH; }
        tracks.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
}

function kpCentre(kp) {
  // Promedio de ojos, nariz y boca del detector (coordenadas 0..1).
  const n = Math.min(4, kp.length); let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += kp[i].x; y += kp[i].y; }
  return { x: x / n, y: y / n };
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
  vfcHits = 0; vfcMiss = 0;
  const PERF = { seek: 0, det: 0, lm: 0, frames: 0 };
  const frameDur = await measureFrameDuration(video);
  const stride = Math.max(1, Math.round((1 / frameDur) / MAX_SAMPLE_FPS));
  const step = frameDur * stride;
  const tracks = [];
  const frames = [];
  const seen = new Set();
  const n = Math.max(1, Math.floor(end / step));

  const toDet = (m, t) => ({ t, cx: m.cx / aw, cy: m.cy / ah, h: m.fh / ah, w: m.fw / ah, roll: m.roll,
    box: { x: m.box.x / aw, y: m.box.y / ah, w: m.box.w / aw, h: m.box.h / ah } });

  let lastTs = 0;
  for (let k = 0; k <= n; k++) {
    if (isCancelled()) break;
    // Mitad del cuadro para no caer en el borde entre dos cuadros.
    const want = Math.min(Math.max(0, end - frameDur * 0.5), k * step + frameDur * 0.5);
    const tA = performance.now();
    const t = await seekFrame(video, want);
    PERF.seek += performance.now() - tA;
    const key = Math.round(t * 1000);
    if (seen.has(key)) { onProgress && onProgress((k + 1) / (n + 1)); continue; }
    seen.add(key);
    g.drawImage(video, 0, 0, aw, ah);
    let dets = [];
    let boxes = [];
    const ts = Math.max(lastTs + 1, Math.round(t * 1000) + 1); lastTs = ts;
    const tB = performance.now();
    try { boxes = (det.detectForVideo(ac, ts).detections || []).slice(0, 6); } catch (e) { console.warn(e); }
    PERF.det += performance.now() - tB;
    for (const b of boxes) {
      const bb = b.boundingBox;
      const bcx = bb.originX + bb.width / 2, bcy = bb.originY + bb.height / 2;
      const size = Math.max(bb.width, bb.height) * 2.2;
      const x0 = bcx - size / 2, y0 = bcy - size / 2;
      cg.fillStyle = '#000'; cg.fillRect(0, 0, CROP, CROP);
      cg.drawImage(ac, x0, y0, size, size, 0, 0, CROP, CROP);
      let res = null;
      const tC = performance.now();
      try { res = lmImg.detect(cc); } catch (e) { console.warn(e); }
      PERF.lm += performance.now() - tC;
      let bestL = null, bd = Infinity;
      for (const L of (res && res.faceLandmarks) || []) {
        const d = Math.hypot(L[1].x - 0.5, L[1].y - 0.5);
        if (d < bd) { bd = d; bestL = L; }
      }
      if (bestL && bd < 0.3) {
        const mapped = bestL.map((p) => ({ x: (x0 + p.x * size) / aw, y: (y0 + p.y * size) / ah, z: p.z }));
        const dd = toDet(faceMetrics(mapped, aw, ah), t);
        if (b.keypoints && b.keypoints.length >= 3) dd.kc = kpCentre(b.keypoints);
        dets.push(dd);
      } else if (b.keypoints && b.keypoints.length >= 3) {
        const k0 = b.keypoints[0], k1 = b.keypoints[1], k2 = b.keypoints[2];
        const roll = Math.atan2((k1.y - k0.y) * ah, (k1.x - k0.x) * aw);
        const kc = kpCentre(b.keypoints);
        dets.push({ t, kc, cx: kc.x, cy: kc.y, h: (bb.height * 0.48) / ah, w: (bb.width * 0.95) / ah, roll,
          box: { x: bb.originX / aw, y: bb.originY / ah, w: bb.width / aw, h: bb.height / ah }, rough: true });
      }
    }
    if (!boxes.length) {
      try {
        const r2 = lmImg.detect(ac);
        for (const L of r2.faceLandmarks || []) dets.push(toDet(faceMetrics(L, aw, ah), t));
      } catch (e) { console.warn(e); }
    }
    dets = dets.filter((d, i) => !dets.some((o, j) => j < i && Math.hypot((d.cx - o.cx) * asp, d.cy - o.cy) < Math.max(d.h, o.h) * 1.8));

    // Asociación: predice dónde debería estar cada cara (con su velocidad) y empareja por cercanía.
    const pairs = [];
    dets.forEach((d, i) => tracks.forEach((tr, j) => {
      const L = tr.last; const dt = t - L.t;
      if (dt <= 0 || dt > 2.5) return;
      const v = tr.vel || { x: 0, y: 0 };
      const pdt = Math.min(dt, 0.2);
      const px = L.cx + v.x * pdt, py = L.cy + v.y * pdt;
      const unit = Math.max(L.h, d.h, 1e-3) * FACE_UNIT;
      const dist = Math.hypot((d.cx - px) * asp, d.cy - py) / unit;
      const sizeRatio = Math.max(d.h, L.h) / Math.max(1e-3, Math.min(d.h, L.h));
      if (dist < 0.9 + dt * 0.8 && sizeRatio < 1.8) pairs.push([dist + dt * 0.6, i, j]);
    }));
    pairs.sort((a, b) => a[0] - b[0]);
    const usedD = new Set(), usedT = new Set();
    const ids = [];
    const assign = (d, tr) => {
      const L = tr.last;
      if (L && !d.rough && !L.rough && d.t > L.t && d.t - L.t < 0.3) {
        const dt = d.t - L.t;
        const nv = { x: (d.cx - L.cx) / dt, y: (d.cy - L.cy) / dt };
        tr.vel = tr.vel ? { x: tr.vel.x * 0.4 + nv.x * 0.6, y: tr.vel.y * 0.4 + nv.y * 0.6 } : nv;
      }
      if (L && L.t !== d.t && (d.t - L.t) >= 0.3) tr.vel = null;
      tr.samples.push(d); tr.last = d; ids.push(tr.id);
      if (!d.rough && d.h > tr.thumbH) {
        tr.thumbH = d.h;
        const sz = d.h * ah * FACE_UNIT * 1.5;
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
      const tr = { id: tracks.length, samples: [], last: null, vel: null, thumbH: 0, thumb: null };
      tracks.push(tr); assign(d, tr);
    });
    frames.push({ t, ids });
    onProgress && onProgress((k + 1) / (n + 1));
    if (k % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  try { det.close(); } catch (_) {}
  PERF.frames = frames.length; console.log('[angelo] perf', JSON.stringify(PERF));

  // Detecciones "aproximadas" (sin puntos finos, p. ej. con la mano en la cara):
  // se calibran con la detección fina más cercana para que no salte; si hay una fina muy cerca, se descartan.
  for (const tr of tracks) {
    const fine = tr.samples.filter((x) => !x.rough && x.kc);
    if (!fine.length) continue;
    tr.samples = tr.samples.filter((x) => {
      if (!x.rough) return true;
      let nf = null, nd = Infinity;
      for (const f of fine) { const d = Math.abs(f.t - x.t); if (d < nd) { nd = d; nf = f; } }
      if (nd < 0.1) return false;
      x.cx = x.kc.x + (nf.cx - nf.kc.x) ; x.cy = x.kc.y + (nf.cy - nf.kc.y);
      x.h = nf.h; x.w = nf.w;
      return true;
    });
  }
  // Une pistas que en realidad son la misma cara (duplicadas o cortadas un momento).
  mergeTracks(tracks, asp);
  for (const tr of tracks) tr.id = tracks.indexOf(tr);
  const maxN = tracks.reduce((m, tr) => Math.max(m, tr.samples.length), 0);
  const minN = Math.max(4, Math.min(Math.round(1 / step), maxN * 0.2));
  let good = tracks.filter((tr) => tr.samples.length >= minN && tr.samples.some((x) => !x.rough));
  good.sort((a, b) => b.samples.length - a.samples.length);
  good = good.slice(0, 6);
  const keep = new Set(good.map((t) => t.id));
  let bestT = 0, bestScore = -1;
  for (const f of frames) {
    const ids = f.ids.filter((id) => keep.has(id));
    const size = ids.reduce((acc, id) => {
      const sm = tracks[id].samples.find((x) => x.t === f.t); return acc + (sm ? sm.h : 0);
    }, 0);
    const score = ids.length * 10 + size;
    if (score > bestScore) { bestScore = score; bestT = f.t; }
  }
  good.forEach((tr, i) => { tr.num = i + 1; });
  return { tracks: good, bestT, aspect: asp, frameDur, step };
}

// Suavizado ADAPTATIVO centrado: quita el temblor cuando la cara está casi quieta,
// y casi no suaviza cuando se mueve rápido (así no se queda atrás).
export function buildPath(track, smooth = 0.2) {
  const sigmaMax = 0.004 + smooth * 0.09; // s
  const segs = [];
  let cur = [];
  for (const s of track.samples) {
    if (cur.length) {
      const L = cur[cur.length - 1], gap = s.t - L.t;
      const moved = Math.hypot(s.cx - L.cx, s.cy - L.cy) / Math.max(1e-3, L.h * FACE_UNIT);
      // Hueco corto y la cabeza casi no se movió (p. ej. una mano tapó la cara): se rellena.
      if (gap > GAP_SPLIT && !(gap <= 0.6 && moved < 0.4)) { segs.push(cur); cur = []; }
    }
    cur.push(s);
  }
  if (cur.length) segs.push(cur);
  track.path = segs.map((seg) => {
    const rolls = []; let prev = null;
    for (const s of seg) {
      let r = s.roll;
      if (prev !== null) { while (r - prev > Math.PI) r -= 2 * Math.PI; while (r - prev < -Math.PI) r += 2 * Math.PI; }
      rolls.push(r); prev = r;
    }
    // Velocidad local (en caras por segundo).
    const speed = seg.map((s, i) => {
      const a = seg[Math.max(0, i - 1)], b = seg[Math.min(seg.length - 1, i + 1)];
      const dt = b.t - a.t; if (dt <= 0) return 0;
      return Math.hypot(b.cx - a.cx, b.cy - a.cy) / dt / Math.max(1e-3, s.h * FACE_UNIT);
    });
    return seg.map((s, i) => {
      const sigma = sigmaMax / (1 + speed[i] * 1.5);
      if (sigma < 0.006) return { t: s.t, cx: s.cx, cy: s.cy, h: s.h, w: s.w, roll: rolls[i] };
      let W = 0, cx = 0, cy = 0, h = 0, w = 0, roll = 0;
      for (let j = Math.max(0, i - 12); j < Math.min(seg.length, i + 13); j++) {
        const dt = seg[j].t - s.t;
        if (Math.abs(dt) > sigma * 3) continue;
        const wt = Math.exp(-(dt * dt) / (2 * sigma * sigma));
        W += wt; cx += seg[j].cx * wt; cy += seg[j].cy * wt; h += seg[j].h * wt; w += seg[j].w * wt; roll += rolls[j] * wt;
      }
      return { t: s.t, cx: cx / W, cy: cy / W, h: h / W, w: w / W, roll: roll / W };
    });
  });
}

function velocity(seg, fromEnd) {
  if (seg.length < 2) return { x: 0, y: 0, h: 0, r: 0 };
  const a = fromEnd ? seg[seg.length - 2] : seg[0], b = fromEnd ? seg[seg.length - 1] : seg[1];
  const dt = b.t - a.t; if (dt <= 0) return { x: 0, y: 0, h: 0, r: 0 };
  return { x: (b.cx - a.cx) / dt, y: (b.cy - a.cy) / dt, h: (b.h - a.h) / dt, r: (b.roll - a.roll) / dt };
}

export function poseAt(track, t) {
  if (!track.path) buildPath(track);
  for (const seg of track.path) {
    const a = seg[0], z = seg[seg.length - 1];
    if (t < a.t - HOLD_IN || t > z.t + HOLD_OUT) continue;
    if (t <= a.t) {
      const v = velocity(seg, false), dt = t - a.t; // dt <= 0: proyecta hacia atrás
      return { t, cx: a.cx + v.x * dt, cy: a.cy + v.y * dt, h: a.h, w: a.w, roll: a.roll, alpha: 1 };
    }
    if (t >= z.t) {
      // Se perdió la cara: sigue su movimiento un instante y luego la mantiene y desvanece.
      const v = velocity(seg, true);
      const pdt = Math.min(t - z.t, PREDICT);
      const fade = t - z.t <= PREDICT ? 1 : Math.max(0, 1 - (t - z.t - PREDICT) / (HOLD_OUT - PREDICT));
      return { t, cx: z.cx + v.x * pdt, cy: z.cy + v.y * pdt, h: Math.max(z.h * 0.5, z.h + v.h * pdt), w: z.w, roll: z.roll + v.r * pdt, alpha: fade };
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
