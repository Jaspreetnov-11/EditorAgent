// 💥 VFX picture effects in the live monitor, on the graphics card (WebGL). One shared canvas and context for every
// layer (a context each would pass the browser's ~16); a layer's picture goes in as a texture, the effect's shader draws
// the result, and the caller copies it into its own canvas right away. The maths is the same as the render's FFmpeg
// graphs in vfxfx.js (displacement maps, ring, glitch rows, fog from depth…), so what plays is what exports.
// Nothing here runs at import (Node imports effects.js -> vfxfx.js -> this file for the render).

const HEAD = `precision highp float;varying vec2 v;uniform sampler2D S0,S1,S2,S3;uniform vec2 R;uniform float T,hasA,hasS,hasM;uniform float u[12];uniform vec3 c1,c2;
float h(float n){return fract(sin(n)*43758.5453);}
vec4 tex(vec2 q){return texture2D(S0,clamp(q,vec2(0.),vec2(1.)));}
`;
// each body sets vec4 col from the picture (S0); S1 = depth / sky matte, S2 = subject matte, S3 = the new sky
const FX = {
  heathaze: `float m=u[3]>.5?clamp((v.y-.25)/.75,0.,1.):1.;
    float dx=u[0]*(.6*sin(v.y*40./u[1]+T*u[2]*4.+3.*sin(v.x*9./u[1]+T*u[2]))+.4*sin(v.x*23./u[1]-T*u[2]*3.+v.y*17./u[1]))*m;
    float dy=u[0]*.5*sin(v.x*31./u[1]+T*u[2]*5.+2.*sin(v.y*11./u[1]))*m;
    col=tex(v+vec2(dx,dy)/R);`,
  shockwave: `float age=T-u[2];col=tex(v);
    if(age>=0.){float Rr=age*u[3];vec2 d=vec2(v.x-u[0],(v.y-u[1])*u[7]);float dist=max(length(d),.001);
    float k=exp(-pow((dist-Rr)/u[4],2.))*clamp(1.-Rr/1.2,0.,1.);vec2 dir=d/dist;
    col=tex(v+dir*u[5]*k/R);col.rgb+=c1*u[6]*k*.6;}`,
  glitch: `float f=floor(T*u[2]);float row=floor(v.y*u[1]);
    float burst=step(.35,h(floor(T*u[2]/3.)*5.3+1.7));
    float on=step(1.-u[0]*.6,h(row*12.9898+f*78.233))*burst;
    float dx=on*(h(row*3.1+f*1.7)-.5)*2.*u[0]*.06;
    vec2 q=v+vec2(dx,0.);float sp=u[3]/R.x;
    col=vec4(tex(q-vec2(sp,0.)).r,tex(q).g,tex(q+vec2(sp,0.)).b,1.);`,
  hologram: `col=tex(v);float l=dot(col.rgb,vec3(.299,.587,.114));col.rgb=c1*l*1.4;
    if(mod(v.y*R.y,u[0])<u[0]*.5)col.rgb*=.65;
    col.rgb+=u[1]*.08*sin(T*50.);col.rgb=clamp(col.rgb,0.,1.);`,
  keypro: `col=tex(v);float d=distance(col.rgb,c1)/1.7320508;float a=smoothstep(u[0],u[0]+max(u[1],.001),d);
    if(u[4]<.5)col.g-=u[2]*max(0.,col.g-max(col.r,col.b));else col.b-=u[2]*max(0.,col.b-max(col.r,col.g));
    col.rgb=mix(col.rgb,c2,u[3]*(1.-a)*step(.001,a));col.a=a;`,
  depthfog: `col=tex(v);if(hasA>.5){float d=1.-texture2D(S1,v).r;float x=clamp((d-u[1])/max(u[2]-u[1],.001),0.,1.);
    col.rgb=mix(col.rgb,c1,clamp(u[0]*x*x*(3.-2.*x),0.,1.));}`,
  depthdof: `col=tex(v);if(hasA>.5){float d=texture2D(S1,v).r;float m=clamp((abs(d-u[0])-u[1])/.25,0.,1.);
    if(m>.01){vec4 s=vec4(0.);float r=u[2]*m;for(int i=0;i<16;i++){float a=float(i)*2.39996;float rr=sqrt((float(i)+.5)/16.)*r;s+=tex(v+vec2(cos(a),sin(a))*rr/R);}col=s/16.;}}`,
  skyreplace: `col=tex(v);if(hasA>.5){float m=0.;for(int i=-2;i<=2;i++)for(int j=-2;j<=2;j++)m+=texture2D(S1,v+vec2(float(i),float(j))*u[0]/R).r;m/=25.;
    vec3 sky=hasM>.5?texture2D(S3,v).rgb:mix(c1,c2,pow(v.y,.8));col.rgb=mix(col.rgb,sky*u[1],m);}`,
};
let st;
function init() {
  if (st !== undefined) return st;
  st = null;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const texs = [0, 1, 2, 3].map((i) => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, x] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, x);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  });
  st = { canvas, gl, texs, buf, progs: {} };
  canvas.addEventListener('webglcontextlost', () => { st = undefined; });
  return st;
}
function prog(type) {
  const s = init(); if (!s || !FX[type]) return null;
  if (s.progs[type] !== undefined) return s.progs[type];
  const gl = s.gl, sh = (t, src) => { const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.warn('VFX shader', type, gl.getShaderInfoLog(o)); return o; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a;varying vec2 v;void main(){v=vec2(a.x*.5+.5,.5-a.y*.5);gl_Position=vec4(a,0.,1.);}'));
  // (🧍 keep the subject clean: the picture as it was where the subject matte is white)
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, `${HEAD}void main(){vec4 col;${FX[type]}if(hasS>.5){vec4 o=tex(v);col=mix(col,o,texture2D(S2,v).r);}gl_FragColor=col;}`));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return (s.progs[type] = null);
  const U = (k) => gl.getUniformLocation(p, k);
  s.progs[type] = { p, a: gl.getAttribLocation(p, 'a'), R: U('R'), T: U('T'), u: U('u'), c1: U('c1'), c2: U('c2'), hasA: U('hasA'), hasS: U('hasS'), hasM: U('hasM'), S: [0, 1, 2, 3].map((i) => U(`S${i}`)) };
  return s.progs[type];
}
const okSrc = (x) => x && (x.tagName !== 'VIDEO' || x.readyState >= 2) && (x.videoWidth || x.naturalWidth || x.width);
// src: the layer's picture (a canvas); o = { T, u: [12 numbers], c1, c2: [r, g, b] 0-1, aux, subj, sky: pictures or null }
// -> the shared canvas with the result (W x H), or null when WebGL is not there
export function runGL(type, src, W, H, o = {}) {
  const pr = prog(type); if (!pr) return null;
  const { canvas, gl, texs } = st;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  gl.viewport(0, 0, W, H);
  gl.useProgram(pr.p);
  const put = (i, img) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, texs[i]); if (!img) return false; try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); return true; } catch { return false; } };
  if (!put(0, src)) return null;
  const hasA = okSrc(o.aux) && put(1, o.aux), hasS = okSrc(o.subj) && put(2, o.subj), hasM = okSrc(o.sky) && put(3, o.sky);
  pr.S.forEach((l, i) => gl.uniform1i(l, i));
  gl.uniform2f(pr.R, W, H); gl.uniform1f(pr.T, o.T || 0);
  const u = new Float32Array(12); (o.u || []).forEach((x, i) => { u[i] = +x || 0; });
  gl.uniform1fv(pr.u, u); gl.uniform3fv(pr.c1, o.c1 || [1, 1, 1]); gl.uniform3fv(pr.c2, o.c2 || [1, 1, 1]);
  gl.uniform1f(pr.hasA, hasA ? 1 : 0); gl.uniform1f(pr.hasS, hasS ? 1 : 0); gl.uniform1f(pr.hasM, hasM ? 1 : 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, st.buf);
  gl.enableVertexAttribArray(pr.a); gl.vertexAttribPointer(pr.a, 2, gl.FLOAT, false, 0, 0);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}
export const glTypes = Object.keys(FX);
