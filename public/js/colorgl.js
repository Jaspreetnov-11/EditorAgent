// WebGL2 grading preview: runs the same per-pixel maths as the renderer (colormath.js) on the live video frame,
// with an optional before/after split, and hands small graded frames to the scopes.
import { channelParams, LUMA, parseCube, activeGrade, hasPost, postFn, hasVig, cubeSampler } from './colormath.js';

// LUTs are fetched and parsed once per session.
const lutCache = new Map();
export function cachedLut(name) { return lutCache.get(name) || null; }
export async function loadLut(proj, name) {
  if (!lutCache.has(name)) {
    const r = await fetch(`/api/lut/file?p=${encodeURIComponent(proj)}&name=${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(`LUT ${name} not found`);
    lutCache.set(name, parseCube(await r.text()));
  }
  return lutCache.get(name);
}

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler2D src; uniform sampler3D lut; uniform bool useLut; uniform float lutSize; uniform vec3 lutMin, lutMax;
uniform vec3 mul, gain, lift, offs, gInv; uniform float contrast, pivot, sat, split; uniform bool graded;
// post stage (colormath.js postFn: tone, creative, curves, HSL secondary) baked into a 3D texture
uniform sampler3D post; uniform bool usePost; uniform float postSize;
uniform float sharp; uniform vec2 texel; uniform vec4 vig; // vig = amount, mid, feather, roundness factor k
in vec2 uv; out vec4 o;
void main() {
  vec3 c = texture(src, uv).rgb;
  if (graded && uv.x >= split) {
    if (sharp > 0.0) { vec3 n = (texture(src, uv + vec2(texel.x, 0)).rgb + texture(src, uv - vec2(texel.x, 0)).rgb + texture(src, uv + vec2(0, texel.y)).rgb + texture(src, uv - vec2(0, texel.y)).rgb) * 0.25; c = clamp(c + (c - n) * sharp * 3.0, 0.0, 1.0); }
    if (useLut) { vec3 q = clamp((c - lutMin) / (lutMax - lutMin), 0.0, 1.0); c = texture(lut, q * (lutSize - 1.0) / lutSize + 0.5 / lutSize).rgb; }
    c = (c * mul - pivot) * contrast + pivot;
    c = c * gain + lift * (1.0 - c) + offs;
    c = pow(clamp(c, 0.0, 1.0), gInv);
    float l = dot(c, vec3(${LUMA.join(', ')}));
    c = clamp(l + (c - l) * sat, 0.0, 1.0);
    if (usePost) c = texture(post, c * (postSize - 1.0) / postSize + 0.5 / postSize).rgb;
    if (vig.x != 0.0) {
      vec2 p = vec2((uv.x - 0.5) * 2.0 * vig.w, (0.5 - uv.y) * 2.0);
      float d = length(p) / length(vec2(vig.w, 1.0)), t = clamp((d - (vig.y - vig.z / 2.0)) / vig.z, 0.0, 1.0), f = t * t * (3.0 - 2.0 * t) * vig.x;
      c = f < 0.0 ? c * (1.0 + f) : c + (1.0 - c) * f;
    }
  }
  if (graded && split > 0.0 && abs(uv.x - split) < 0.0015) c = vec3(1.0, 0.6, 0.2);
  o = vec4(c, 1.0);
}`;

export class Grader {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    this.pr = pr; gl.useProgram(pr);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = Object.fromEntries(['src', 'lut', 'useLut', 'lutSize', 'lutMin', 'lutMax', 'mul', 'gain', 'lift', 'offs', 'gInv', 'contrast', 'pivot', 'sat', 'split', 'graded', 'post', 'usePost', 'postSize', 'sharp', 'texel', 'vig'].map((k) => [k, gl.getUniformLocation(pr, k)]));
    this.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.uniform1i(this.u.src, 0);
    this.lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.uniform1i(this.u.lut, 1);
    this.postTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, this.postTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.uniform1i(this.u.post, 2); this.postKey = null;
    this.lutName = null; this.split = 0; this.graded = true; this.src = null;
    this.fbo = gl.createFramebuffer(); this.fboTex = gl.createTexture(); this.fboW = 0; this.fboH = 0;
    this.setGrade({});
  }

  setSource(el) { this.src = el; }
  setLut(name, cube) {
    const gl = this.gl;
    this.lutName = name || null;
    if (!name || !cube) { this.useLut = false; return; }
    const N = cube.size, d = new Uint8Array(N * N * N * 4);
    for (let i = 0; i < N * N * N; i++) { d[i * 4] = Math.round(Math.min(1, Math.max(0, cube.data[i * 3])) * 255); d[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, cube.data[i * 3 + 1])) * 255); d[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, cube.data[i * 3 + 2])) * 255); d[i * 4 + 3] = 255; }
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
    this.lutSize = N; this.lutMin = cube.min; this.lutMax = cube.max; this.useLut = true;
  }
  // c: the clip's grade (switched-off Lumetri sections are left out here); look: the parsed creative look LUT
  setGrade(c0, look = null) {
    const c = activeGrade(c0 || {}) || {};
    this.c = c;
    const ps = ['r', 'g', 'b'].map((ch) => channelParams(c, ch));
    this.p = { mul: ps.map((p) => p.mul), gain: ps.map((p) => p.gain), lift: ps.map((p) => p.lift), offs: ps.map((p) => p.offset), gInv: ps.map((p) => 1 / p.gamma),
      contrast: ps[0].contrast, pivot: ps[0].pivot, sat: Number.isFinite(+c.saturation) ? +c.saturation : 1,
      sharp: +c.sharpen || 0, vig: hasVig(c) ? c.vig : null };
    // the post stage as a 33-point 3D texture, rebuilt only when it changes
    this.usePost = hasPost(c);
    const key = this.usePost ? JSON.stringify([c.highlights, c.shadows, c.whites, c.blacks, c.look, c.lookAmt, c.faded, c.vibrance, c.csat, c.shTint, c.hiTint, c.tintBal, c.curves, c.hue, c.hsl, !!look]) : null;
    if (this.usePost && key !== this.postKey) {
      const N = 33, fn = postFn(c, { look: look ? cubeSampler(look) : null }), d = new Uint8Array(N * N * N * 4);
      let i = 0;
      for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++, i++) { const q = fn([r / (N - 1), g / (N - 1), b / (N - 1)]); d[i * 4] = Math.round(q[0] * 255); d[i * 4 + 1] = Math.round(q[1] * 255); d[i * 4 + 2] = Math.round(q[2] * 255); d[i * 4 + 3] = 255; }
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, this.postTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
      this.postSize = N;
    }
    this.postKey = key;
  }

  // Draw the current source frame into the canvas (w x h) or, with toFbo, into a small framebuffer for scopes.
  draw(toFbo = null) {
    const gl = this.gl, el = this.src;
    if (!el) return false;
    const ready = el.tagName === 'VIDEO' ? el.readyState >= 2 : el.complete && el.naturalWidth > 0;
    if (!ready) return false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // the scopes pass right after a screen draw reuses the frame already uploaded
    if (!toFbo || !this._fresh) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, el);
    this._fresh = !toFbo;
    const u = this.u, p = this.p;
    gl.uniform1i(u.useLut, this.useLut ? 1 : 0);
    if (this.useLut) { gl.uniform1f(u.lutSize, this.lutSize); gl.uniform3fv(u.lutMin, this.lutMin); gl.uniform3fv(u.lutMax, this.lutMax); }
    gl.uniform3fv(u.mul, p.mul); gl.uniform3fv(u.gain, p.gain); gl.uniform3fv(u.lift, p.lift); gl.uniform3fv(u.offs, p.offs); gl.uniform3fv(u.gInv, p.gInv);
    gl.uniform1f(u.contrast, p.contrast); gl.uniform1f(u.pivot, p.pivot); gl.uniform1f(u.sat, p.sat);
    gl.uniform1i(u.graded, this.graded ? 1 : 0);
    gl.uniform1i(u.usePost, this.usePost ? 1 : 0); gl.uniform1f(u.postSize, this.postSize || 33);
    gl.uniform1f(u.sharp, p.sharp); gl.uniform2f(u.texel, 1 / (el.videoWidth || el.naturalWidth || 1920), 1 / (el.videoHeight || el.naturalHeight || 1080));
    const V = p.vig, asp = (el.videoWidth || el.naturalWidth || 16) / (el.videoHeight || el.naturalHeight || 9);
    gl.uniform4f(u.vig, V ? Math.max(-1, Math.min(1, +V.amount || 0)) : 0, V ? (Number.isFinite(+V.mid) ? +V.mid : 0.5) : 0.5, V ? Math.max(0.02, Number.isFinite(+V.feather) ? +V.feather : 0.5) : 0.5, V ? Math.pow(asp, Math.min(1, Math.max(-1, +V.round || 0))) : 1);
    if (toFbo) {
      const [w, h] = toFbo;
      if (w !== this.fboW || h !== this.fboH) {
        gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
        this.fboW = w; this.fboH = h;
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, w, h);
      gl.uniform1f(u.split, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return px;
    }
    const cw = this.canvas.width, ch = this.canvas.height;
    gl.viewport(0, 0, cw, ch);
    gl.uniform1f(u.split, this.split);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
}
