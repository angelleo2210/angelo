import { makeCutout, makeCanvas } from './cutout.js';
import { analyzeVideo, buildPath, poseAt } from './tracker.js';
import { getLandmarker } from './vision.js';

const $ = (id) => document.getElementById(id);
const video = $('srcVideo');
const stage = $('stage');
const sctx = stage.getContext('2d');
const pick = $('pickCanvas');

const MAX_SECONDS = 30;
const S = {
  file: null, url: null, dur: 0, end: 0, W: 0, H: 0,
  tracks: [], faces: [], bestT: 0, sel: -1,
  analyzing: false, exporting: false, photoTarget: null,
  resultUrl: null, resultFile: null,
};
window.__angelo = S; // para pruebas

// ---------- utilidades de interfaz ----------
let toastTimer;
function toast(msg, ms = 3800) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function busy(on, text = 'Cargando…') { $('busyText').textContent = text; $('busy').classList.toggle('hidden', !on); }
function show(id, on = true) { $(id).classList.toggle('hidden', !on); }
function setProgress(id, p) {
  const el = $(id); el.querySelector('.bar').style.width = (p * 100).toFixed(1) + '%';
  el.querySelector('.ptext').textContent = Math.round(p * 100) + '%';
}
const fmt = (t) => { t = Math.max(0, t); const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + String(s).padStart(2, '0'); };
const defaultAdj = () => ({ scale: 1, dx: 0, dy: 0, rot: 0, opacity: 1, flip: false, turn: true, smooth: 0.5 });

// ---------- Paso 1: video ----------
$('videoInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  await loadVideo(file);
});

function waitEvent(el, ev, ms = 15000) {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('VIDEOERR')); };
    const to = setTimeout(() => { cleanup(); reject(new Error('TIMEOUT')); }, ms);
    function cleanup() { clearTimeout(to); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); }
    el.addEventListener(ev, ok); el.addEventListener('error', bad);
  });
}

async function loadVideo(file) {
  stopPreview();
  if (S.url) URL.revokeObjectURL(S.url);
  S.file = file; S.url = URL.createObjectURL(file);
  S.tracks = []; S.faces = []; S.sel = -1;
  ['step3', 'step4', 'facesArea', 'result'].forEach((id) => show(id, false));
  busy(true, 'Abriendo video…');
  try {
    video.muted = true;
    video.src = S.url;
    video.load();
    await waitEvent(video, 'loadedmetadata');
    if (video.readyState < 2) await waitEvent(video, 'loadeddata').catch(() => {});
  } catch (err) {
    busy(false);
    toast('No pude abrir ese video. Prueba con otro (MP4 o MOV).');
    return;
  }
  busy(false);
  S.dur = video.duration;
  if (!isFinite(S.dur) || S.dur <= 0) S.dur = 30;
  const vw = video.videoWidth, vh = video.videoHeight;
  const sc = Math.min(1, 720 / Math.min(vw, vh), 1280 / Math.max(vw, vh));
  S.W = Math.round(vw * sc / 2) * 2; S.H = Math.round(vh * sc / 2) * 2;
  stage.width = S.W; stage.height = S.H;
  pick.width = S.W; pick.height = S.H;
  const long = S.dur > MAX_SECONDS;
  show('trimRow', long);
  updateEnd();
  const info = $('videoInfo');
  info.innerHTML = `✅ <b>${escapeHtml(file.name || 'video')}</b><br>Duración: <b>${fmt(S.dur)}</b> · ${vw}×${vh}` +
    (sc < 1 ? ` → se trabajará en ${S.W}×${S.H}` : '') +
    (long ? `<br><span class="warn">⚠️ Es un video largo. Recomendado: hasta ${MAX_SECONDS} s para que no se ponga lento.</span>` : '');
  show('videoInfo');
  show('step2');
  $('analyzeBtn').disabled = false;
  $('step2').scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Calienta la IA en segundo plano.
  getLandmarker('IMAGE').catch(() => {});
}
$('trimChk').addEventListener('change', () => { updateEnd(); if (S.tracks.length) toast('Vuelve a buscar las caras para aplicar el cambio.'); });
function updateEnd() { S.end = (S.dur > MAX_SECONDS && $('trimChk').checked) ? MAX_SECONDS : S.dur; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- Paso 2: análisis ----------
$('analyzeBtn').addEventListener('click', async () => {
  if (S.analyzing || !S.url) return;
  S.analyzing = true;
  stopPreview();
  $('analyzeBtn').disabled = true;
  // En iPhone hay que "tocar" el video con un gesto para poder buscar cuadros.
  try { const p = video.play(); if (p) await p.catch(() => {}); video.pause(); } catch (_) {}
  show('facesArea', false); show('step3', false); show('step4', false);
  show('anaProgress'); setProgress('anaProgress', 0);
  $('anaProgress').querySelector('.ptext').textContent = 'Preparando la IA…';
  try {
    const r = await analyzeVideo(video, S.end, (p) => setProgress('anaProgress', p));
    S.tracks = r.tracks; S.bestT = r.bestT;
  } catch (err) {
    console.error(err);
    toast('Algo falló al analizar el video. Intenta de nuevo.');
    S.analyzing = false; $('analyzeBtn').disabled = false; show('anaProgress', false);
    return;
  }
  S.analyzing = false;
  $('analyzeBtn').disabled = false;
  $('analyzeBtn').textContent = '🔁 Buscar caras otra vez';
  show('anaProgress', false);
  if (!S.tracks.length) {
    toast('No encontré caras en el video. Prueba con uno donde las caras se vean claras y de frente.', 6000);
    return;
  }
  S.faces = S.tracks.map((tr, i) => ({ track: tr, num: tr.num, enabled: i === 0, cutout: null, file: null, mode: 'oval', adj: defaultAdj() }));
  S.faces.forEach((f) => buildPath(f.track, f.adj.smooth));
  S.sel = 0;
  show('facesArea');
  await drawPick();
  renderCards();
  toast(S.faces.length === 1 ? 'Encontré 1 cara. Ahora elige la foto.' : `Encontré ${S.faces.length} caras. Elige a cuál le cambias la cara.`);
});

function faceRect(f, t, W, H) {
  const p = poseAt(f.track, t);
  if (!p) return null;
  const h = p.h * H * 1.35, w = Math.max(p.w * H * 1.15, h * 0.75);
  return { x: p.cx * W - w / 2, y: p.cy * H - h / 2, w, h };
}

async function seek(t) {
  await new Promise((res) => {
    const to = setTimeout(res, 2500);
    video.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true });
    video.currentTime = t;
  });
}

async function drawPick() {
  await seek(S.bestT);
  drawPickFrame();
}
function drawPickFrame() {
  const g = pick.getContext('2d');
  g.drawImage(video, 0, 0, S.W, S.H);
  const lw = Math.max(3, S.W / 200);
  S.faces.forEach((f) => {
    const r = faceRect(f, S.bestT, S.W, S.H);
    if (!r) return;
    g.lineWidth = lw;
    g.setLineDash(f.enabled ? [] : [lw * 3, lw * 2]);
    g.strokeStyle = f.enabled ? '#ff3d7f' : '#ffffff';
    roundRect(g, r.x, r.y, r.w, r.h, lw * 4); g.stroke();
    g.setLineDash([]);
    const fs = Math.max(18, S.W / 22);
    g.font = `900 ${fs}px -apple-system, sans-serif`;
    g.fillStyle = f.enabled ? '#ff3d7f' : 'rgba(0,0,0,.6)';
    const label = (f.enabled ? '✓ ' : '') + f.num;
    const tw = g.measureText(label).width + fs * 0.6;
    roundRect(g, r.x, r.y - fs * 1.3, tw, fs * 1.2, fs * 0.3); g.fill();
    g.fillStyle = '#fff'; g.fillText(label, r.x + fs * 0.3, r.y - fs * 0.32);
  });
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function canvasPoint(cv, ev) {
  const rect = cv.getBoundingClientRect();
  // El canvas usa object-fit: contain, calculamos el área real.
  const ar = cv.width / cv.height, rr = rect.width / rect.height;
  let w = rect.width, h = rect.height, ox = 0, oy = 0;
  if (rr > ar) { w = h * ar; ox = (rect.width - w) / 2; } else { h = w / ar; oy = (rect.height - h) / 2; }
  return { x: (ev.clientX - rect.left - ox) / w * cv.width, y: (ev.clientY - rect.top - oy) / h * cv.height };
}
pick.addEventListener('click', (ev) => {
  const p = canvasPoint(pick, ev);
  let hit = null;
  S.faces.forEach((f) => { const r = faceRect(f, S.bestT, S.W, S.H); if (r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y - r.h * 0.2 && p.y <= r.y + r.h) hit = f; });
  if (hit) toggleFace(hit);
});
function toggleFace(f) {
  f.enabled = !f.enabled;
  if (f.enabled) S.sel = S.faces.indexOf(f);
  drawPickFrame(); renderCards(); refreshEditor();
}

function renderCards() {
  const box = $('faceCards'); box.innerHTML = '';
  S.faces.forEach((f) => {
    const card = document.createElement('div');
    card.className = 'facecard' + (f.enabled ? ' on' : '');
    const thumbs = document.createElement('div'); thumbs.className = 'thumbs';
    if (f.track.thumb) { const c = makeCanvas(96, 96); c.getContext('2d').drawImage(f.track.thumb, 0, 0); thumbs.appendChild(c); }
    const cut = makeCanvas(144, 144); cut.className = 'cut';
    if (f.cutout) {
      const cc = f.cutout.canvas, s = Math.min(144 / cc.width, 144 / cc.height);
      cut.getContext('2d').drawImage(cc, (144 - cc.width * s) / 2, (144 - cc.height * s) / 2, cc.width * s, cc.height * s);
      thumbs.appendChild(cut);
    }
    const body = document.createElement('div');
    body.innerHTML = `<div class="ttl">Cara ${f.num}</div>`;
    const acts = document.createElement('div'); acts.className = 'acts';
    const tg = document.createElement('button'); tg.className = 'pill' + (f.enabled ? ' on' : '');
    tg.textContent = f.enabled ? '✓ Reemplazar' : 'No tocar';
    tg.onclick = () => toggleFace(f);
    const ph = document.createElement('button'); ph.className = 'pill'; ph.dataset.face = f.num;
    ph.textContent = f.cutout ? '📷 Cambiar foto' : '📷 Elegir foto';
    ph.onclick = () => { S.photoTarget = f; $('photoInput').click(); };
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="oval">Solo cara (óvalo)</option><option value="hair">Cara + pelo (IA)</option>';
    sel.value = f.mode;
    sel.onchange = async () => { f.mode = sel.value; if (f.file) await applyPhoto(f, f.file); };
    acts.append(tg, ph, sel);
    body.appendChild(acts);
    card.append(thumbs, body);
    box.appendChild(card);
  });
}

$('photoInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  const f = S.photoTarget;
  if (!file || !f) return;
  await applyPhoto(f, file);
});

async function applyPhoto(f, file) {
  busy(true, f.mode === 'hair' ? 'Recortando cara y pelo…' : 'Recortando la cara…');
  try {
    f.cutout = await makeCutout(file, f.mode);
    f.file = file; f.enabled = true;
    S.sel = S.faces.indexOf(f);
  } catch (err) {
    console.error(err);
    busy(false);
    toast(err.message === 'NOFACE' ? 'No encontré una cara en esa foto. Prueba con otra donde se vea de frente y clara.' : 'No pude abrir esa foto. Prueba con otra.', 5000);
    return;
  }
  busy(false);
  renderCards(); drawPickFrame(); refreshEditor();
  if (!$('step3').classList.contains('hidden')) return;
  show('step3'); show('step4');
  await seek(0);
  drawStage();
  $('step3').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Paso 3: editor ----------
const sliders = { scale: 's_scale', dx: 's_dx', dy: 's_dy', rot: 's_rot', opacity: 's_op', smooth: 's_smooth' };
const outs = { scale: 'o_scale', dx: 'o_dx', dy: 'o_dy', rot: 'o_rot', opacity: 'o_op', smooth: 'o_smooth' };
function activeFaces() { return S.faces.filter((f) => f.enabled && f.cutout); }
function selFace() { const f = S.faces[S.sel]; return f && f.enabled && f.cutout ? f : activeFaces()[0]; }

function refreshEditor() {
  const act = activeFaces();
  if (!act.length) { show('step3', false); show('step4', false); return; }
  if (!selFace()) S.sel = S.faces.indexOf(act[0]);
  const cur = selFace(); S.sel = S.faces.indexOf(cur);
  const chips = $('faceChips'); chips.innerHTML = '';
  if (act.length > 1) {
    act.forEach((f) => {
      const b = document.createElement('button');
      b.className = 'pill' + (f === cur ? ' on' : '');
      b.textContent = 'Ajustar cara ' + f.num;
      b.onclick = () => { S.sel = S.faces.indexOf(f); refreshEditor(); };
      chips.appendChild(b);
    });
  }
  for (const k in sliders) $(sliders[k]).value = cur.adj[k];
  $('c_flip').checked = cur.adj.flip; $('c_turn').checked = cur.adj.turn;
  updateOutputs();
  drawStage();
}
function updateOutputs() {
  const f = selFace(); if (!f) return;
  $(outs.scale).textContent = Math.round(f.adj.scale * 100) + '%';
  $(outs.dx).textContent = f.adj.dx.toFixed(2);
  $(outs.dy).textContent = f.adj.dy.toFixed(2);
  $(outs.rot).textContent = f.adj.rot + '°';
  $(outs.opacity).textContent = Math.round(f.adj.opacity * 100) + '%';
  $(outs.smooth).textContent = Math.round(f.adj.smooth * 100) + '%';
}
for (const k in sliders) {
  $(sliders[k]).addEventListener('input', (e) => {
    const f = selFace(); if (!f) return;
    f.adj[k] = parseFloat(e.target.value);
    if (k === 'smooth') buildPath(f.track, f.adj.smooth);
    updateOutputs(); if (video.paused) drawStage();
  });
}
$('c_flip').addEventListener('change', (e) => { const f = selFace(); if (f) { f.adj.flip = e.target.checked; drawStage(); } });
$('c_turn').addEventListener('change', (e) => { const f = selFace(); if (f) { f.adj.turn = e.target.checked; drawStage(); } });
$('resetBtn').addEventListener('click', () => { const f = selFace(); if (!f) return; f.adj = defaultAdj(); buildPath(f.track, f.adj.smooth); refreshEditor(); });

// Arrastrar la cara con el dedo.
let drag = null;
stage.addEventListener('pointerdown', (ev) => {
  const p = canvasPoint(stage, ev);
  const t = video.currentTime;
  let best = null, bd = Infinity;
  activeFaces().forEach((f) => {
    const pose = poseAt(f.track, t); if (!pose) return;
    const cx = pose.cx * S.W + f.adj.dx * pose.h * S.H, cy = pose.cy * S.H + f.adj.dy * pose.h * S.H;
    const d = Math.hypot(p.x - cx, p.y - cy) / (pose.h * S.H);
    if (d < bd) { bd = d; best = { f, pose }; }
  });
  if (!best || bd > 1.5) return;
  if (S.faces[S.sel] !== best.f) { S.sel = S.faces.indexOf(best.f); refreshEditor(); }
  drag = { f: best.f, h: best.pose.h * S.H, x: p.x, y: p.y, dx: best.f.adj.dx, dy: best.f.adj.dy };
  stage.setPointerCapture(ev.pointerId);
});
stage.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const p = canvasPoint(stage, ev);
  const cl = (v) => Math.max(-1, Math.min(1, v));
  drag.f.adj.dx = cl(drag.dx + (p.x - drag.x) / drag.h);
  drag.f.adj.dy = cl(drag.dy + (p.y - drag.y) / drag.h);
  $('s_dx').value = drag.f.adj.dx; $('s_dy').value = drag.f.adj.dy; updateOutputs();
  if (video.paused) drawStage();
});
const endDrag = () => { drag = null; };
stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);

// Dibuja un cuadro: video + caras pegadas.
function renderFrame(ctx, W, H, t) {
  ctx.drawImage(video, 0, 0, W, H);
  for (const f of activeFaces()) {
    const p = poseAt(f.track, t);
    if (!p || p.alpha <= 0) continue;
    const c = f.cutout, a = f.adj;
    const faceH = p.h * H;
    const sc = (faceH / c.faceH) * a.scale;
    let sx = 1;
    if (a.turn) { // simula el giro de la cabeza estrechando la cara
      const ratioT = p.w / p.h, ratioC = c.faceW / c.faceH;
      sx = Math.max(0.55, Math.min(1.15, ratioT / ratioC));
    }
    ctx.save();
    ctx.globalAlpha = a.opacity * p.alpha;
    ctx.translate(p.cx * W + a.dx * faceH, p.cy * H + a.dy * faceH);
    ctx.rotate(p.roll - (a.flip ? -c.roll : c.roll) + (a.rot * Math.PI) / 180);
    ctx.scale(sc * sx * (a.flip ? -1 : 1), sc);
    ctx.drawImage(c.canvas, -c.ax, -c.ay);
    ctx.restore();
  }
}
function drawStage() {
  if (!S.W) return;
  renderFrame(sctx, S.W, S.H, video.currentTime);
  if (!S.exporting) {
    $('seek').value = Math.round((video.currentTime / (S.end || 1)) * 1000);
    $('timeLbl').textContent = fmt(video.currentTime);
  }
}

// Reproducción de vista previa.
let raf = 0;
function loop() {
  drawStage();
  if (!S.exporting && video.currentTime >= S.end - 0.02) { video.pause(); }
  if (!video.paused) raf = requestAnimationFrame(loop); else { raf = 0; setPlayIcon(); drawStage(); }
}
function setPlayIcon() { $('playBtn').textContent = video.paused ? '▶' : '❚❚'; }
function stopPreview() { if (!video.paused) video.pause(); cancelAnimationFrame(raf); raf = 0; setPlayIcon(); }

let audio = null;
function ensureAudio() {
  if (audio) { if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {}); return audio; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const src = ctx.createMediaElementSource(video);
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest); src.connect(ctx.destination);
    audio = { ctx, src, dest };
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch (e) { console.warn('[angelo] sin audio', e); audio = { failed: true, ctx: { state: 'running', resume() { return Promise.resolve(); } } }; }
  return audio;
}

$('playBtn').addEventListener('click', async () => {
  if (S.exporting) return;
  if (video.paused) {
    ensureAudio();
    video.muted = false;
    if (video.currentTime >= S.end - 0.05) await seek(0);
    try { await video.play(); } catch (e) { video.muted = true; await video.play().catch(() => {}); }
    setPlayIcon(); cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  } else { stopPreview(); drawStage(); }
});
$('seek').addEventListener('input', async (e) => {
  if (S.exporting) return;
  stopPreview();
  await seek((e.target.value / 1000) * S.end);
  drawStage();
});

// ---------- Paso 4: exportar ----------
function pickMime() {
  if (!window.MediaRecorder) return null;
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=h264,aac', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const t of types) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) {} }
  return '';
}

$('exportBtn').addEventListener('click', exportVideo);
async function exportVideo() {
  if (S.exporting || !activeFaces().length) return;
  const mime = pickMime();
  if (mime === null || !stage.captureStream) { toast('Este navegador no puede grabar video. Usa Safari actualizado en iPhone.', 6000); return; }
  stopPreview();
  S.exporting = true;
  $('exportBtn').disabled = true; show('result', false); show('expProgress'); show('expNote'); setProgress('expProgress', 0);
  const au = ensureAudio();
  const stream = stage.captureStream(30);
  if (au && au.dest) { const tr = au.dest.stream.getAudioTracks()[0]; if (tr) stream.addTrack(tr); }
  const rec = new MediaRecorder(stream, Object.assign(mime ? { mimeType: mime } : {}, { videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 }));
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  await seek(0);
  video.muted = false;
  renderFrame(sctx, S.W, S.H, 0);
  let started = false;
  const startRec = () => { if (!started) { started = true; rec.start(1000); } };
  try { await video.play(); } catch (e) { video.muted = true; await video.play().catch(() => {}); }
  await new Promise((resolve) => {
    const useVFC = 'requestVideoFrameCallback' in video;
    const tick = () => {
      startRec();
      const t = video.currentTime;
      renderFrame(sctx, S.W, S.H, t);
      setProgress('expProgress', Math.min(1, t / S.end));
      if (t >= S.end - 0.02 || video.ended) { resolve(); return; }
      if (useVFC) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
    };
    video.addEventListener('ended', resolve, { once: true });
    if (useVFC) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
  });
  video.pause();
  renderFrame(sctx, S.W, S.H, video.currentTime);
  await new Promise((r) => setTimeout(r, 120));
  startRec();
  rec.stop();
  await stopped;
  stream.getVideoTracks().forEach((t) => t.stop());
  const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type });
  const d = new Date();
  const name = `angelo-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.${ext}`;
  if (S.resultUrl) URL.revokeObjectURL(S.resultUrl);
  S.resultUrl = URL.createObjectURL(blob);
  try { S.resultFile = new File([blob], name, { type }); } catch (_) { S.resultFile = null; }
  S.resultBlob = blob; S.resultType = type;
  $('resultVideo').src = S.resultUrl;
  const dl = $('downloadBtn'); dl.href = S.resultUrl; dl.download = name;
  const canShare = !!(S.resultFile && navigator.canShare && navigator.canShare({ files: [S.resultFile] }));
  show('shareBtn', canShare); show('saveHint', canShare);
  S.exporting = false;
  $('exportBtn').disabled = false; $('exportBtn').textContent = '✨ Crear de nuevo';
  show('expProgress', false); show('expNote', false); show('result');
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(blob.size ? '¡Listo! Tu video está creado 🎉' : 'El video salió vacío. Intenta de nuevo.');
  document.body.dataset.exported = String(blob.size);
}

$('shareBtn').addEventListener('click', async () => {
  if (!S.resultFile) return;
  try { await navigator.share({ files: [S.resultFile], title: 'Angelo' }); }
  catch (e) { if (e && e.name !== 'AbortError') toast('No se pudo compartir. Usa “Descargar”.'); }
});

video.addEventListener('pause', setPlayIcon);
video.addEventListener('play', setPlayIcon);
