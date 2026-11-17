// Carga perezosa de MediaPipe Tasks Vision (todo corre en el teléfono).
import { FilesetResolver, FaceLandmarker, FaceDetector, ImageSegmenter } from '../vendor/mediapipe/vision_bundle.mjs';

const BASE = new URL('../', import.meta.url).href;
let filesetP = null;
const cache = {};

function fileset() {
  if (!filesetP) filesetP = FilesetResolver.forVisionTasks(BASE + 'vendor/mediapipe/wasm');
  return filesetP;
}

async function withDelegate(factory) {
  // Intenta GPU (WebGL) y si falla usa CPU.
  try { return await factory('GPU'); }
  catch (e) { console.warn('[angelo] GPU no disponible, uso CPU', e); return await factory('CPU'); }
}

export async function getLandmarker(mode /* 'IMAGE' | 'VIDEO' */, numFaces = 4) {
  const key = 'lm_' + mode;
  if (!cache[key]) {
    cache[key] = (async () => {
      const fs = await fileset();
      return withDelegate((delegate) => FaceLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: BASE + 'models/face_landmarker.task', delegate },
        runningMode: mode,
        numFaces,
        minFaceDetectionConfidence: 0.35,
        minFacePresenceConfidence: 0.35,
        minTrackingConfidence: 0.35,
      }));
    })();
    cache[key].catch(() => { delete cache[key]; });
  }
  return cache[key];
}

// Crea un landmarker de video nuevo (los timestamps deben ser crecientes por instancia).
export async function newVideoLandmarker(numFaces = 4) {
  const fs = await fileset();
  return withDelegate((delegate) => FaceLandmarker.createFromOptions(fs, {
    baseOptions: { modelAssetPath: BASE + 'models/face_landmarker.task', delegate },
    runningMode: 'VIDEO',
    numFaces,
    minFaceDetectionConfidence: 0.35,
    minFacePresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
  }));
}

export async function getSegmenter() {
  if (!cache.seg) {
    cache.seg = (async () => {
      const fs = await fileset();
      return withDelegate((delegate) => ImageSegmenter.createFromOptions(fs, {
        baseOptions: { modelAssetPath: BASE + 'models/selfie_multiclass_256x256.tflite', delegate },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      }));
    })();
    cache.seg.catch(() => { delete cache.seg; });
  }
  return cache.seg;
}

// Detector de caras de largo alcance (encuentra caras pequeñas o lejanas).
export async function newVideoDetector() {
  const fs = await fileset();
  return withDelegate((delegate) => FaceDetector.createFromOptions(fs, {
    baseOptions: { modelAssetPath: BASE + 'models/blaze_face_full_range.tflite', delegate },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.45,
    minSuppressionThreshold: 0.3,
  }));
}
