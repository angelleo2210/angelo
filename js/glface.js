// Pega la cara con la malla facial (852 triángulos) usando WebGL2:
// cada triángulo de la foto se deforma al triángulo correspondiente de la cara del video,
// con borde difuminado que sigue el contorno real de la cara y color igualado (Lab).
import { TRIS, RING } from './mesh.js';
import { NPTS } from './geometry.js';

const VS = `#version 300 es
in vec2 aPos; in vec2 aUV; in float aRing; in float aFore;
uniform vec2 uRes;
out vec2 vUV; out float vRing; out float vFore;
void main() {
  vUV = aUV; vRing = aRing; vFore = aFore;
  vec2 p = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV; in float vRing; in float vFore;
uniform sampler2D uTex;
uniform float uOpacity, uFeather, uForeAmt, uBias, uColorAmt;
uniform vec3 uMS, uSS, uMT, uST;
out vec4 outColor;
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float f(float t) { return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0; }
float fi(float t) { float t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16.0 / 116.0) / 7.787; }
vec3 rgb2lab(vec3 c) {
  vec3 l = toLin(c);
  vec3 xyz = mat3(0.4124564, 0.2126729, 0.0193339, 0.3575761, 0.7151522, 0.1191920, 0.1804375, 0.0721750, 0.9503041) * l;
  xyz /= vec3(0.95047, 1.0, 1.08883);
  float fx = f(xyz.x), fy = f(xyz.y), fz = f(xyz.z);
  return vec3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}
vec3 lab2rgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0, fx = lab.y / 500.0 + fy, fz = fy - lab.z / 200.0;
  vec3 xyz = vec3(fi(fx) * 0.95047, fi(fy), fi(fz) * 1.08883);
  vec3 l = mat3(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252) * xyz;
  return toSrgb(l);
}
void main() {
  vec4 tx = texture(uTex, vUV, uBias);
  vec3 c = tx.a > 0.004 ? tx.rgb / tx.a : vec3(0.0); // textura premultiplicada
  if (uColorAmt > 0.0) {
    vec3 lab = rgb2lab(c);
    vec3 r = clamp(uST / uSS, vec3(0.5), vec3(1.8));
    // Al oscurecer, el contraste de luz baja en proporción (los ojos/cejas no se vuelven negros).
    r.x = min(r.x, max(uMT.x / max(uMS.x, 1.0), 0.35));
    vec3 t = (lab - uMS) * r + uMT;
    c = mix(c, clamp(lab2rgb(t), 0.0, 1.0), uColorAmt);
  }
  float a = clamp(vRing / max(uFeather, 0.001), 0.0, 1.0);
  a = a * a * (3.0 - 2.0 * a);
  a *= mix(1.0, vFore, uForeAmt);
  a *= tx.a;
  a *= uOpacity;
  outColor = vec4(c * a, a);
}`;

// Solo para pruebas: ?sim=blankgl simula un iPhone donde WebGL no dibuja nada.
const SIM_BLANK = /[?&]sim=blankgl/.test(location.search);

export class FaceGL {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true });
    if (!gl) throw new Error('NOWEBGL2');
    this.gl = gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    this.pr = pr;
    this.loc = {};
    for (const n of ['uRes', 'uTex', 'uOpacity', 'uFeather', 'uForeAmt', 'uBias', 'uColorAmt', 'uMS', 'uSS', 'uMT', 'uST']) this.loc[n] = gl.getUniformLocation(pr, n);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const buf = (name, size, data, usage) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      const l = gl.getAttribLocation(pr, name); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
      return b;
    };
    this.bPos = buf('aPos', 2, new Float32Array(NPTS * 2), gl.DYNAMIC_DRAW);
    this.bUV = buf('aUV', 2, new Float32Array(NPTS * 2), gl.DYNAMIC_DRAW);
    this.bRing = buf('aRing', 1, new Float32Array(RING), gl.STATIC_DRAW);
    this.bFore = buf('aFore', 1, new Float32Array(NPTS), gl.DYNAMIC_DRAW);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, TRIS, gl.STATIC_DRAW);
    this.nIdx = TRIS.length;
    this.tex = new Map();
  }
  textureFor(cut) {
    const gl = this.gl;
    let t = this.tex.get(cut.id);
    if (t) return t;
    t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); // filtrado correcto en los bordes de la máscara
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cut.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex.set(cut.id, t);
    return t;
  }
  // items: [{cut, pts (Float32Array px), opacity, feather(0..1), fore(0..1), color(0..1), tgtStats}]
  render(W, H, items) {
    const gl = this.gl;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.pr); gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.loc.uRes, W, H);
    for (const it of items) {
      const c = it.cut;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textureFor(c));
      gl.uniform1i(this.loc.uTex, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, it.pts);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bUV); gl.bufferSubData(gl.ARRAY_BUFFER, 0, c.uv);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bFore); gl.bufferSubData(gl.ARRAY_BUFFER, 0, c.fore);
      gl.uniform1f(this.loc.uOpacity, it.opacity);
      gl.uniform1f(this.loc.uFeather, 0.6 + it.feather * 3.4); // anillos de difuminado
      gl.uniform1f(this.loc.uForeAmt, it.fore);
      gl.uniform1f(this.loc.uBias, it.bias || 0.5);
      const ok = it.color > 0 && c.stats && it.tgtStats;
      gl.uniform1f(this.loc.uColorAmt, ok ? it.color : 0);
      if (ok) {
        const s = c.stats, t = it.tgtStats;
        gl.uniform3f(this.loc.uMS, s[0], s[1], s[2]); gl.uniform3f(this.loc.uSS, s[3], s[4], s[5]);
        gl.uniform3f(this.loc.uMT, t[0], t[1], t[2]); gl.uniform3f(this.loc.uST, t[3], t[4], t[5]);
      }
      if (!SIM_BLANK) gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0);
    }
    return this.canvas;
  }
  // Lee el alfa dibujado en un punto (x,y en px de la imagen). Sirve para detectar
  // un dibujo invisible (contexto perdido, textura vacía, etc.).
  probe(x, y) {
    const gl = this.gl;
    if (gl.isContextLost()) return -1;
    const px = new Uint8Array(4);
    gl.readPixels(Math.round(x), Math.round(this.canvas.height - 1 - y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px[3];
  }
  lost() { return this.gl.isContextLost(); }
}
