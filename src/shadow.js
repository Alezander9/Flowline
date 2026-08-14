/* ---------------------------------------- rider shadow (real, sun aligned)
   A tiny orthographic depth pass around the rider, sampled by the terrain
   shader. Replaces the soft blob quad: the shadow now has the shape of the
   board, legs and arms, stretches with the sun angle and lifts off the snow
   on a jump. One extra draw of ~20 small meshes into 512x512. */
class SunShadow {
  constructor(scene, size = 512) {
    this.size = size;
    this.far = 24;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: true, stencilBuffer: false, generateMipmaps: false
    });
    // 16-bit linear depth packed into R,G
    /* the skinning chunks are required: the rider is a SkinnedMesh, and an
       unskinned depth pass would cast its bind pose */
    this.mat = new THREE.ShaderMaterial({
      vertexShader: `
        #include <skinning_pars_vertex>
        void main(){
          vec3 transformed = position;
          #include <skinbase_vertex>
          #include <skinning_vertex>
          gl_Position = projectionMatrix*modelViewMatrix*vec4(transformed,1.0);
        }`,
      fragmentShader: `
        void main(){
          float d = gl_FragCoord.z;               // ortho: already linear in [0,1]
          float g = fract(d*255.0);
          gl_FragColor = vec4(d - g/255.0, g, 0.0, 1.0);
        }`
    });
    // casters live in their own scene so the depth pass draws only the rider,
    // while the main pass still renders them (nested scenes draw normally)
    this.casters = new THREE.Scene();
    this.casters.overrideMaterial = this.mat;
    scene.add(this.casters);
    const e = 3.4;
    this.cam = new THREE.OrthographicCamera(-e, e, e, -e, 0.5, this.far);
    this.mtx = new THREE.Matrix4();
    this.uni = {
      uShMap: { value: this.rt.texture }, uShMtx: { value: this.mtx },
      uShOn: { value: 1 }, uShTex: { value: 1 / size }
    };
    this._c = new THREE.Color();
    this._t = new THREE.Vector3();
  }

  add(obj) { this.casters.add(obj); }

  /* aim the light camera at the rider and render the depth map */
  render(ren, p, sun) {
    if (!this.uni.uShOn.value) return;
    const s = sun, il = 1 / (Math.hypot(s.x, s.y, s.z) || 1);
    const d = this.far * 0.62;
    this.cam.position.set(p.x + s.x * il * d, p.y + s.y * il * d + 0.4, p.z + s.z * il * d);
    this._t.set(p.x, p.y + 0.4, p.z);
    this.cam.lookAt(this._t);
    this.cam.updateMatrixWorld();
    this.cam.updateProjectionMatrix();
    this.mtx.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse);
    const prevRT = ren.getRenderTarget(), prevAC = ren.autoClear;
    ren.getClearColor(this._c);
    const prevA = ren.getClearAlpha();
    ren.setRenderTarget(this.rt);
    ren.setClearColor(0xff0000, 1);          // r=1 -> depth 1 -> unshadowed
    ren.clear(true, true, false);
    ren.autoClear = false;
    ren.render(this.casters, this.cam);
    ren.autoClear = prevAC;
    ren.setRenderTarget(prevRT);
    ren.setClearColor(this._c, prevA);
  }

  enable(on) { this.uni.uShOn.value = on ? 1 : 0; }
}

/* GLSL side: 4-tap PCF lookup, returns 0..1 shadow */
const GLSL_SHADOW = `
uniform sampler2D uShMap; uniform mat4 uShMtx; uniform float uShOn, uShTex;
float riderShadow(vec3 wp){
  if(uShOn < 0.5) return 0.0;
  vec4 lp = uShMtx*vec4(wp,1.0);
  vec3 c = lp.xyz/lp.w;
  vec2 uv = c.xy*0.5+0.5;
  if(uv.x<0.001||uv.x>0.999||uv.y<0.001||uv.y>0.999) return 0.0;
  /* Outside the light frustum's DEPTH range we have no occlusion information,
     so the only correct answer is unshadowed. Without this the map's cleared
     value (depth 1.0) wins: ground further from the sun than the far plane has
     rd > 1.0, step() returns 1 and it goes fully black with no caster. The
     ortho box bounds that laterally, so it read as a hard-edged patch that
     translated - and rose on a jump - with the rider-centred map. Only the
     far side can overrun in practice (the near plane sits 14m up-sun of the
     rider) but both are guarded: every pixel this rejects was unconditionally
     shadowed by the clear colour, never by a caster. */
  if(c.z >= 1.0 || c.z <= -1.0) return 0.0;
  float rd = c.z*0.5+0.5 - 0.0006;                     // depth bias
  float sh = 0.0;
  for(int i=0;i<4;i++){
    vec2 o = vec2(i==0||i==3 ? -1.0 : 1.0, i<2 ? -1.0 : 1.0)*uShTex*0.85;
    vec4 t = texture2D(uShMap, uv+o);
    float sd = t.r + t.g/255.0;
    sh += step(sd, rd);
  }
  sh *= 0.25;
  // feather the map border so the shadow never cuts off with a straight edge
  vec2 e = min(uv, 1.0-uv);
  return sh*smoothstep(0.0, 0.06, min(e.x,e.y));
}
`;

/* ==================================================== sun cascades (world)
   The mountain used to cast NOTHING: only the rider had a shadow, and trees
   faked theirs with alpha ribbons laid on the snow. With no darks anywhere in
   frame the snow had no contrast at any exposure - the real cause of the washed
   look, not the tonemap.
   Two orthographic depth cascades aligned to the sun cover the near slope and
   the mid distance. Casters are the terrain itself, a cheap cone proxy per tree
   and the rocks, so terrain self-shadows, trees shadow the snow and each other,
   and everything shadows the rider.
   Cost control: the tree proxy is ~16 tris instead of the full canopy, and the
   far cascade only re-renders every other frame (its matrix is only updated on
   the frames it is drawn, so texture and matrix never disagree). */
const CSC_SPEC = [
  { size: 2048, ext: 132, ahead: 46 },   // near: 6.4cm texels
  { size: 2048, ext: 660, ahead: 275 }   // far:  32cm texels
];

const CSC_LAYER = 3;

class SunCascades {
  constructor(scene, spec) {
    this.spec = spec || CSC_SPEC;
    this.scene = scene;
    this.layer = CSC_LAYER;
    this.on = 1;
    this.frame = 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: `
        #include <skinning_pars_vertex>
        void main(){
          vec3 transformed = position;
          #include <skinbase_vertex>
          #include <skinning_vertex>
          vec4 mp = vec4(transformed,1.0);
          #ifdef USE_INSTANCING
            mp = instanceMatrix*mp;
          #endif
          gl_Position = projectionMatrix*modelViewMatrix*mp;
        }`,
      fragmentShader: `
        void main(){
          float d = gl_FragCoord.z;             // ortho: linear in [0,1]
          float g = fract(d*255.0);
          gl_FragColor = vec4(d - g/255.0, g, 0.0, 1.0);
        }`
    });
    this.rts = []; this.cams = []; this.mtx = [];
    for (const s of this.spec) {
      this.rts.push(new THREE.WebGLRenderTarget(s.size, s.size, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        depthBuffer: true, stencilBuffer: false, generateMipmaps: false
      }));
      const h = s.ext * 0.5;
      /* depth range kept tight so 16-bit packing stays sub-centimetre */
      const dist = 300 + s.ext * 0.5, far = dist + 420 + s.ext * 0.7;
      const cam = new THREE.OrthographicCamera(-h, h, h, -h, 0.5, far);
      cam.userData.dist = dist;
      cam.layers.set(this.layer);          // draw ONLY registered casters
      this.cams.push(cam);
      this.mtx.push(new THREE.Matrix4());
    }
    this.uni = {
      uCs0: { value: this.rts[0].texture }, uCs1: { value: this.rts[1].texture },
      uCsM0: { value: this.mtx[0] }, uCsM1: { value: this.mtx[1] },
      uCsOn: { value: 1 },
      uCsTx: { value: new THREE.Vector2(1 / this.spec[0].size, 1 / this.spec[1].size) },
      uCsWt: { value: new THREE.Vector2(this.spec[0].ext / this.spec[0].size, this.spec[1].ext / this.spec[1].size) },
      uCsFade: { value: this.spec[1].ext * 0.52 }
    };
    /* Registered casters. Kept as an explicit list rather than relying on
       scene.overrideMaterial, because a caster whose vertex shader DISPLACES
       geometry (the carve wake) has to cast its displaced shape - an override
       material would flatten it and the berms would never self-shadow. */
    this.list = [];
    this._c = new THREE.Color();
    this._ctr = new THREE.Vector3();
    this._ld = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /* cast AND stay visible in the main pass (terrain, rocks) */
  add(obj) { obj.layers.enable(this.layer); this.list.push(obj); return obj; }
  /* cast ONLY: a cheap stand-in geometry that must never be drawn for real */
  addProxy(obj) { obj.layers.set(this.layer); this.list.push(obj); return obj; }
  remove(obj) {
    obj.layers.disable(this.layer);
    const i = this.list.indexOf(obj);
    if (i >= 0) this.list.splice(i, 1);
  }

  setSize(i, size) {
    if (this.spec[i].size === size) return;
    this.spec[i].size = size;
    this.rts[i].setSize(size, size);
    this.uni.uCsTx.value.setComponent(i, 1 / size);
    this.uni.uCsWt.value.setComponent(i, this.spec[i].ext / size);
  }

  render(ren, p, sun) {
    if (!this.on) return;
    this.frame++;
    const ld = this._ld.copy(sun).normalize();
    /* light-space basis for texel snapping */
    this._r.crossVectors(this._up, ld).normalize();
    this._u.crossVectors(ld, this._r).normalize();
    const prevRT = ren.getRenderTarget(), prevAC = ren.autoClear;
    ren.getClearColor(this._c);
    const prevA = ren.getClearAlpha();

    /* swap to depth materials once, around BOTH cascade passes */
    const L = this.list;
    for (let k = 0; k < L.length; k++) {
      const o = L[k];
      o.userData._pm = o.material;
      o.material = o.userData.cscMat || this.mat;
    }

    for (let i = 0; i < this.spec.length; i++) {
      /* the far cascade is static enough to run at half rate */
      if (i === 1 && (this.frame & 1)) continue;
      const s = this.spec[i], cam = this.cams[i];
      const c = this._ctr.set(p.x, 0, p.z + s.ahead);
      c.y = (typeof terrainH === 'function' ? terrainH(c.x, c.z) : p.y) + 2.0;
      /* snap the centre onto a light-space lattice: without this the whole
         shadow shimmers as the rider moves, because every texel re-samples a
         different part of the slope each frame */
      const tx = s.ext / s.size;
      const a = c.dot(this._r), b = c.dot(this._u);
      const da = Math.round(a / tx) * tx - a, db = Math.round(b / tx) * tx - b;
      c.addScaledVector(this._r, da).addScaledVector(this._u, db);

      const d = cam.userData.dist;
      cam.position.set(c.x + ld.x * d, c.y + ld.y * d, c.z + ld.z * d);
      cam.lookAt(c);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      this.mtx[i].multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

      ren.setRenderTarget(this.rts[i]);
      ren.setClearColor(0xff0000, 1);        // r=1 -> depth 1 -> unshadowed
      ren.clear(true, true, false);
      ren.autoClear = false;
      /* layer filtering keeps this to the registered casters, so the main
         scene can be reused as-is instead of duplicating the terrain */
      ren.render(this.scene, cam);
      ren.autoClear = prevAC;
    }
    for (let k = 0; k < L.length; k++) { L[k].material = L[k].userData._pm; }
    ren.setRenderTarget(prevRT);
    ren.setClearColor(this._c, prevA);
  }

  enable(on) { this.on = on ? 1 : 0; this.uni.uCsOn.value = this.on; }
}

/* GLSL side: 8-tap Poisson PCF, near cascade blended into the far one.
   Offsets are unrolled because GLSL ES 1.00 has no const array initialisers. */
const GLSL_CASCADE = `
uniform sampler2D uCs0, uCs1; uniform mat4 uCsM0, uCsM1;
uniform float uCsOn, uCsFade; uniform vec2 uCsTx, uCsWt;
float cscTap(sampler2D m, vec2 uv, float rd){
  vec4 t = texture2D(m, uv);
  return step(t.r + t.g/255.0, rd);
}
float cscPCF(sampler2D m, vec3 c, float tx, float bias){
  vec2 uv = c.xy*0.5+0.5;
  float rd = c.z*0.5+0.5 - bias;
  float s = 0.0;
  s += cscTap(m, uv + vec2(-0.94, 0.34)*tx, rd);
  s += cscTap(m, uv + vec2( 0.86,-0.51)*tx, rd);
  s += cscTap(m, uv + vec2( 0.28, 0.96)*tx, rd);
  s += cscTap(m, uv + vec2(-0.41,-0.91)*tx, rd);
  s += cscTap(m, uv + vec2( 1.62, 0.98)*tx, rd);
  s += cscTap(m, uv + vec2(-1.55, 1.05)*tx, rd);
  s += cscTap(m, uv + vec2( 1.05,-1.66)*tx, rd);
  s += cscTap(m, uv + vec2(-1.12,-1.58)*tx, rd);
  return s*0.125;
}
/* returns 0..1 occlusion. N is the surface normal: offsetting along it by a
   texel is what removes shadow acne without a depth bias big enough to make
   contact shadows float. */
float cscPCF4(sampler2D m, vec3 c, float tx, float bias){
  vec2 uv = c.xy*0.5+0.5;
  float rd = c.z*0.5+0.5 - bias;
  float s = 0.0;
  s += cscTap(m, uv + vec2(-0.94, 0.34)*tx, rd);
  s += cscTap(m, uv + vec2( 0.86,-0.51)*tx, rd);
  s += cscTap(m, uv + vec2( 0.28, 0.96)*tx, rd);
  s += cscTap(m, uv + vec2(-0.41,-0.91)*tx, rd);
  return s*0.25;
}
float sunShadow(vec3 wp, vec3 N, float dist){
  if(uCsOn < 0.5) return 0.0;
  vec4 lp0 = uCsM0*vec4(wp + N*uCsWt.x*1.7, 1.0);
  vec3 c0 = lp0.xyz/lp0.w;
  vec2 e0 = min(c0.xy*0.5+0.5, 1.0-(c0.xy*0.5+0.5));
  float in0 = step(0.0, min(e0.x,e0.y)) * step(abs(c0.z), 1.0);
  float w0 = in0 * smoothstep(0.0, 0.045, min(e0.x,e0.y));
  float sh = 0.0;
  if(w0 > 0.001) sh = cscPCF(uCs0, c0, uCsTx.x, 0.0016);
  if(w0 < 0.999){
    vec4 lp1 = uCsM1*vec4(wp + N*uCsWt.y*1.7, 1.0);
    vec3 c1 = lp1.xyz/lp1.w;
    vec2 u1 = c1.xy*0.5+0.5;
    vec2 e1 = min(u1, 1.0-u1);
    float s1 = 0.0;
    if(min(e1.x,e1.y) > 0.0 && abs(c1.z) < 1.0){
      s1 = cscPCF4(uCs1, c1, uCsTx.y, 0.0022)*smoothstep(0.0, 0.03, min(e1.x,e1.y));
    }
    sh = mix(s1, sh, w0);
  }
  // let the mid distance keep its shadows, then fade rather than pop
  return sh*(1.0 - smoothstep(uCsFade, uCsFade*1.9, dist));
}
`;
