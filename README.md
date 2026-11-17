# Angelo

Pon cualquier cara en cualquier video, desde el teléfono. Gratis, sin anuncios y sin cuentas.

- Subes un video tuyo (hasta ~30 s recomendado) y una foto con la cara.
- La app encuentra las caras del video, sigue cada cabeza mientras se mueve y le pega la cara de la foto.
- Ajustas tamaño, posición, giro, opacidad y suavizado, miras la vista previa y creas el video (MP4 en iPhone) para descargar o compartir.

**Privacidad:** todo se procesa en el navegador con MediaPipe (WASM/WebGL). Los videos y fotos nunca salen del teléfono.

## Técnica
- HTML + JS puro, sin build. Sitio estático (Render Static Site).
- MediaPipe Tasks Vision 1.2.3 (vendorizado en `vendor/mediapipe`), modelos en `models/`:
  - `blaze_face_full_range.tflite` – detecta caras grandes y pequeñas en cada cuadro.
  - `face_landmarker.task` – 478 puntos de la cara (en un recorte ampliado de cada cara) para posición, tamaño, giro e inclinación.
  - `selfie_multiclass_256x256.tflite` – recorte opcional "cara + pelo".
- Seguimiento por cercanía entre cuadros, suavizado gaussiano centrado, la cara se mantiene ~0.45 s si se pierde la detección.
- Exportación con `canvas.captureStream()` + `MediaRecorder` (prefiere `video/mp4`), audio original vía WebAudio.
- PWA instalable (manifest + service worker).

Instalar en iPhone: abre el enlace en Safari → Compartir → **Agregar a pantalla de inicio**.
