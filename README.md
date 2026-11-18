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
- Análisis **cuadro por cuadro** (todos los cuadros en videos de 24/25/30 fps); cada pose se guarda con el tiempo exacto del cuadro (`requestVideoFrameCallback` → `mediaTime`).
- La vista previa y la exportación dibujan la cara con la pose de **ese mismo cuadro** (sin retraso).
- Ancla en puntos rígidos (ojos, nariz, frente), así la cara no "flota" cuando la persona habla.
- Suavizado adaptativo centrado: quita temblor cuando la cabeza está quieta y casi no suaviza cuando se mueve rápido.
- Si se pierde la cara, sigue su velocidad 0.12 s y luego la mantiene y la desvanece; huecos cortos (mano tapando la cara) se rellenan.
- Exportación con `canvas.captureStream()` + `MediaRecorder` (prefiere `video/mp4`), audio original vía WebAudio.
- PWA instalable (manifest + service worker).

Instalar en iPhone: abre el enlace en Safari → Compartir → **Agregar a pantalla de inicio**.

## Calidad de la cara (v5)

- **Malla 3D, no calcomanía:** la foto se deforma con los 468 puntos de MediaPipe (852 triángulos, WebGL2) para que ojos, nariz y boca caigan sobre los del video. Sigue cabezas inclinadas o mirando abajo y nunca es más grande que la cara real.
- **Borde suave** que sigue el contorno de la cara del video (slider "Borde suave").
- **Igualar color**: transferencia de color en espacio Lab (media y desviación) entre la piel de la foto y la del video.
- **Ocultar frente/pelo de la foto**: se desvanece la frente y se recorta el pelo con el segmentador, para que no aparezca un flequillo ajeno.
- Se suaviza la foto (mipmaps) para igualar la nitidez del video.
- El modo "Cara + pelo (cabezón)" mantiene la calcomanía grande alineada por mínimos cuadrados.
- Sin WebGL2 se usa la calcomanía como respaldo.

Comparación: `screenshots/calidad-antes-despues.jpg`.

## Modos (v6)

- **Careta (recomendado, por defecto):** la cara de la foto recortada en óvalo con borde suave se coloca sobre el contorno de la cara del video (mismo centro, giro de los ojos, ancho y alto; nunca más grande que la cara). Solo canvas 2D, sin WebGL ni segmentación: funciona en cualquier iPhone.
- **Natural (experimental):** malla deformada con WebGL2. Si falla (sin WebGL2, contexto perdido o dibujo vacío) cambia solo a Careta y avisa en pantalla.
- **Cara + pelo (cabezón):** si el recorte de pelo falla, pega solo la cara y avisa.
- Los errores se muestran en un aviso en pantalla, en vez de fallar en silencio.
- El segmentador corre en CPU: en iPhone las máscaras hechas por GPU salen vacías (bug de MediaPipe con `getAsUint8Array`). Esa fue la causa de que v5 no dibujara nada en iPhone.
