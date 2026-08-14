/* =====================================================================
   deform.js - the deformation cascade (plan phase 5, section 4)

   Two toroidal-free windows that follow the rider, each a RASTERISATION of
   the stamp store (stamps.js), which stays the single authority:

     DEFORM_NEAR  2048^2 over 128 m   6.3 cm/texel   depth + shape
     DEFORM_FAR   1024^2 over 640 m   62.5 cm/texel  reach (R5: a bot's
                                                     trail, 480 m ahead)

   WHY THERE IS NO PING-PONG, against the plan's first sketch: the plan
   assumed the buffer had to ACCUMULATE, because SNOWFLOW has no coordinate
   store and its buffer IS its memory. Here the store is the authority, so a
   window can simply be redrawn from world coordinates every frame. That is
   affordable because the content of a window is BOUNDED and does not grow
   with session length - the mountain only ever runs downhill, so a 128 m
   window holds one pass of each author: authors * 128 / 0.55 stamps, about
   1.9 k at 8 authors, regardless of how long the run has been. Redrawing
   also means the content is exact rather than an accumulation of scroll
   copies, which removes a whole class of drift/shimmer bug.

   Overlapping stamps must combine as MAX, exactly as the CPU's displaceAt
   does, so the pass uses the hardware MAX blend equation and one target -
   no ping-pong pair, half the VRAM.

   Channels (RGBA8; 1.2 m / 255 = 4.7 mm of depth quantisation, far below
   what 25 cm cells can draw):
     R depth        metres, scaled by DF_DMAX
     G displaced mass -> berm height, scaled by DF_BMAX. THIS is what makes
       a rut read as a rut and not a decal (plan section 4.1)
     B compression  feeds snowSurf's packed channel
     A ice          feeds snowSurf's ice channel
   ===================================================================== */

const DF_NEAR_N = 2048, DF_NEAR_M = 128;
const DF_FAR_N  = 1024, DF_FAR_M  = 640;
/* fraction of each window kept BEHIND the rider. 25% -> near 32 m back /
   96 m ahead, far 160 m back / 480 m ahead (plan's residency table). */
const DF_BIAS = 0.25;
const DF_DMAX = 1.2;          // metres of depth at channel R = 1 (matches ST_DMAX)
const DF_BMAX = 0.70;         // metres of berm at channel G = 1 (ST_DMAX*ST_BERMH = 0.66)
const DF_CAP_N = 1 << 13;     // 8192 instances; near window needs ~1.9 k at 8 authors
const DF_CAP_F = 1 << 15;     // 32768; far window is 5x longer

/* ---------------------------------------------------------------------
   Sampling side. Included by the terrain and fine-patch shaders, in BOTH
   the vertex and fragment stages.

   The rim between the fine patch and the coarse mesh needs NO taper here
   (unlike uPromo): deformH is a pure function of WORLD position, so a
   vertex shared by both meshes gets the identical value and the join stays
   crack-free by construction. The patch merely resolves the same shape
   with 25 cm cells where the coarse mesh has 2 m ones.
   --------------------------------------------------------------------- */
const GLSL_DEFORM = `
uniform sampler2D uDfN, uDfF;
uniform vec3 uDfNO;            // near window: origin x, origin z, size (m)
uniform vec3 uDfFO;            // far window
uniform vec3 uDfP;             // DF_DMAX, DF_BMAX, master amount (0 = off)

/* raw 0..1 channels, near where available, far elsewhere, cross-faded over
   the outer few % of the near window so the resolution change is not a seam */
vec4 dfFetch(vec2 w){
  if(uDfP.z <= 0.0) return vec4(0.0);
  vec4 D = vec4(0.0);
  vec2 uf = (w - uDfFO.xy)/uDfFO.z;
  if(uf.x > 0.0 && uf.x < 1.0 && uf.y > 0.0 && uf.y < 1.0) D = texture2D(uDfF, uf);
  vec2 un = (w - uDfNO.xy)/uDfNO.z;
  if(un.x > 0.0 && un.x < 1.0 && un.y > 0.0 && un.y < 1.0){
    vec2 e = min(un, 1.0 - un);
    D = mix(D, texture2D(uDfN, un), smoothstep(0.0, 0.045, min(e.x, e.y)));
  }
  return D;
}

/* (x) trench depth in m, (y) berm height in m, (z) compression, (w) ice */
vec4 deformAt(vec2 w){
  vec4 d = dfFetch(w);
  return vec4(d.x*uDfP.x*uDfP.z, d.y*uDfP.y*uDfP.z, d.z, d.w);
}

/* signed height offset: the berm is displaced mass piled OUT of the trench */
float deformH(vec2 w){ vec4 d = deformAt(w); return d.y - d.x; }

/* Gradient for the shading normal, so a berm reads with 6.3 cm detail even
   though the geometry carries it at 25 cm - the same division of labour
   between displacement and normal that snowRelief already uses.
   Caller must gate this on there being any deformation here at all: on a
   normal frame the vast majority of terrain pixels are undisturbed snow,
   and this is 4 more fetches. */
vec2 deformGrad(vec2 w){
  float e = uDfNO.z/${DF_NEAR_N}.0 * 1.5;      // ~1.5 near texels
  return vec2(deformH(w + vec2(e, 0.0)) - deformH(w - vec2(e, 0.0)),
              deformH(w + vec2(0.0, e)) - deformH(w - vec2(0.0, e))) / (2.0*e);
}

/* ---------------------------------------------------------------------
   S1 - THE DEFORMATION SHADES ITSELF.

   Measured from uploads/clean_snowboard_line_powder.png: what makes a cut in
   a photograph read as a CUT is almost entirely VALUE CONTRAST inside it - a
   sunlit berm crest near clipping against a deep blue-grey trench floor, a
   huge local range over about a metre of ground. Shape contributes far less.
   Our trench was within a few sRGB levels of the snow beside it, so it could
   not read at any distance.

   Both terms below are computed per-pixel from the deformation field we are
   already sampling, so - unlike geometry - they work at EVERY distance and
   need no mesh density. That is what makes this the cheapest drama available
   and why it leads section 5.

   The sun is passed in rather than read from uSun: GLSL_DEFORM is also
   included by two VERTEX shaders (terrain_mesh, terrain_fine) which do not
   include GLSL_COMMON and therefore have no uSun to link against.
   --------------------------------------------------------------------- */
uniform vec2 uDfSh;            // (self-shadow amount, sky-occlusion amount)

/* Self-shadowing. A 25 cm trench under our 16 deg raking sun is genuinely in
   shadow from its own rim, and that is the one thing a normal-map-only trench
   can never have. March sunward in world XZ and ask whether the field ever
   rises above the ray leaving this point. */
float deformShadow(vec2 w, vec3 sun){
  if(uDfSh.x <= 0.0) return 0.0;
  vec2 sd = sun.xz;
  float sl = length(sd);
  if(sl < 1e-3) return 0.0;                    // sun overhead: nothing casts
  sd /= sl;
  float tanEl = sun.y/sl;                      // rise per metre travelled sunward
  float h0 = deformH(w);
  float occ = 0.0;
  /* GEOMETRICALLY SPACED TAPS, and the spacing matters: a uniform 0.34 m march
     put only ONE tap (0.68 m) on the wall of a 1.0 m wide trench and measured a
     blocking tangent of 0.178 where the wall's real slope is 1.37. Dense near,
     sparse far - 0.16 / 0.37 / 0.65 / 1.02 / 1.50 m - samples the near wall
     properly and still reaches a tall berm crest. */
  float t = 0.0, st = 0.16;
  for(int i = 0; i < 5; i++){
    t += st; st *= 1.32;
    /* tangent of the blocking angle, minus the sun's own elevation tangent:
       positive means the field pokes above the ray leaving this point */
    occ = max(occ, (deformH(w + sd*t) - h0)/t - tanEl);
  }
  return clamp(occ*3.0, 0.0, 1.0)*uDfSh.x;
}

/* Sky occlusion. The depth channel IS the occlusion - a point in a trench sits
   below the surrounding snow and sees less of the dome, a berm crest sees
   slightly more than flat ground. Free: it reuses the fetch the caller already
   made, no extra taps. */
float deformAO(vec4 D){
  if(uDfSh.y <= 0.0) return 1.0;
  float depth = D.x*uDfP.x*uDfP.z, berm = D.y*uDfP.y*uDfP.z;
  return mix(1.0, clamp(1.0 - depth*1.15 + berm*0.30, 0.52, 1.06), uDfSh.y);
}
`;

/* ---------------------------------------------------------------------
   The stamp pass. One instanced quad per stamp, profile identical to
   stamps.js displaceAt so the CPU authority and the drawn surface are the
   same model (they differ only by rasterisation: bilinear over 6.3 cm
   texels vs an exact analytic max).
   --------------------------------------------------------------------- */
const DF_STAMP_VERT = `
attribute vec2 aCen;           // stamp centre, world xz
attribute vec4 aPar;           // depth (m), halfW (m), comp, ice
attribute vec3 aDir;           // cos(head), sin(head), berm foreshorten (1 = flat)
uniform vec3 uWin;             // origin x, origin z, size (m)
varying vec2 vOff;             // metres from the stamp centre
varying vec4 vPar;
varying vec3 vDir;
varying vec2 vWP;              // world xz, so chunk noise is world-stable
void main(){
  float R = aPar.y*${1.15} + ${0.55};        // ST_REACH, ST_BERM
  vOff = position.xy * R;
  vPar = aPar; vDir = aDir;
  vWP = aCen + vOff;
  vec2 uv = (aCen + vOff - uWin.xy)/uWin.z;
  gl_Position = vec4(uv*2.0 - 1.0, 0.0, 1.0);
}`;

const DF_STAMP_FRAG = `
precision highp float;
varying vec2 vOff;
varying vec4 vPar;
varying vec3 vDir;
varying vec2 vWP;
uniform vec2 uEnc;             // 1/DF_DMAX, 1/DF_BMAX

/* Value noise on world xz. Keyed on WORLD position, never on stamp-local
   coords: the blend is MAX, so two overlapping stamps must agree on the
   chunk pattern or the clods flicker as one stamp wins over the other. */
float dfH(vec2 p){
  return fract(sin(p.x*127.1 + p.y*311.7)*43758.5453);
}
float dfN(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0 - 2.0*f);
  return mix(mix(dfH(i), dfH(i+vec2(1.0,0.0)), f.x),
             mix(dfH(i+vec2(0.0,1.0)), dfH(i+vec2(1.0,1.0)), f.x), f.y);
}
void main(){
  float halfW = vPar.y;
  if(halfW <= 0.0) discard;
  float depth = vPar.x;
  /* Clods only where the board actually threw snow. A groomed-piste scratch
     is a clean fine line in every reference photo, so fade chunk break-up in
     with cut depth instead of needing a powder attribute. */
  float chunky = smoothstep(0.06, 0.18, depth);
  /* two octaves at clod scale: ~35 cm masses, ~14 cm grain */
  float cn = dfN(vWP*2.9)*0.66 + dfN(vWP*7.1)*0.34;

  /* same frame as displaceAt: lat across the travel line, along it */
  float lat   = abs(vOff.x*vDir.x - vOff.y*vDir.y);
  float along = abs(vOff.x*vDir.y + vOff.y*vDir.x);
  if(along > halfW*${1.15} + ${0.55}) discard;
  /* ragged cut edge: the rim of a powder trench is torn, not machined */
  float hw = halfW*(1.0 + chunky*(cn - 0.5)*0.17);
  float d = 0.0, b = 0.0, c = 0.0, ic = 0.0;
  if(lat <= hw){
    float u = lat/hw;
    d = depth*(1.0 - u*u*0.35);          // rounded floor, not a slot
    c = vPar.z; ic = vPar.w;
  } else {
    /* project the berm like halfW already is; max() mirrors the CPU floor so
       a zero attribute can never divide by zero and discard every berm */
    float u = (lat - hw)/(${0.55}*max(vDir.z, 0.1));
    if(u >= 1.0) discard;
    b = depth*${ST_BERMH.toFixed(3)}*(1.0 - u)*(1.0 - u);
    /* broken wall: scatter the displaced mass into clods rather than
       leaving the smooth extruded ridge a swept ribbon would give */
    b *= 1.0 + chunky*(cn*1.15 - 0.45);
    b = max(b, 0.0);
  }
  gl_FragColor = vec4(d*uEnc.x, b*uEnc.y, c, ic);
}`;

class DeformCascade {
  constructor(ren, THREE) {
    this.ren = ren;
    this.ok = false;
    this.frame = 0;
    this.stats = { near: 0, far: 0, drawn: 0, clipped: 0 };
    const mkRT = n => new THREE.WebGLRenderTarget(n, n, {
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });

    this.lv = [
      { n: DF_NEAR_N, m: DF_NEAR_M, cap: DF_CAP_N, rt: mkRT(DF_NEAR_N), every: 1 },
      { n: DF_FAR_N,  m: DF_FAR_M,  cap: DF_CAP_F, rt: mkRT(DF_FAR_N),  every: 2 },
    ];

    /* shared uniforms - merged into WU by reference, so one write per frame
       reaches the terrain, the fine patch and anything else made of snow */
    this.uni = {
      uDfN:  { value: this.lv[0].rt.texture },
      uDfF:  { value: this.lv[1].rt.texture },
      uDfNO: { value: new THREE.Vector3(0, 0, DF_NEAR_M) },
      uDfFO: { value: new THREE.Vector3(0, 0, DF_FAR_M) },
      uDfP:  { value: new THREE.Vector3(DF_DMAX, DF_BMAX, 1) },
      /* S1 live A/B knobs: (self-shadow, sky occlusion). Both 0 restores the
         pre-S1 image exactly, which keeps the review surface one state. */
      uDfSh: { value: new THREE.Vector2(1, 1) },
    };

    /* one instanced quad, sized to the larger cap and reused by both levels */
    const cap = Math.max(DF_CAP_N, DF_CAP_F);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0,  1, -1, 0,  1, 1, 0,  -1, 1, 0]), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    this.aCen = new THREE.InstancedBufferAttribute(new Float32Array(cap*2), 2);
    this.aPar = new THREE.InstancedBufferAttribute(new Float32Array(cap*4), 4);
    this.aDir = new THREE.InstancedBufferAttribute(new Float32Array(cap*3), 3);
    for (const a of [this.aCen, this.aPar, this.aDir]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aCen', this.aCen);
    g.setAttribute('aPar', this.aPar);
    g.setAttribute('aDir', this.aDir);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geo = g;

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uWin: { value: new THREE.Vector3() },
                  uEnc: { value: new THREE.Vector2(1/DF_DMAX, 1/DF_BMAX) } },
      vertexShader: DF_STAMP_VERT, fragmentShader: DF_STAMP_FRAG,
      /* MAX, so overlapping stamps combine exactly as displaceAt's max does.
         Arithmetic in the shader cannot do this without a ping-pong pair. */
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.cam = new THREE.Camera();       // ignored; the vertex shader emits clip coords
    this.hits = [];
    this.tmp = {};
    this.ok = true;
  }

  /* Snap a window origin to its OWN texel lattice. Without this the whole
     buffer resamples every frame as the rider moves and the ruts crawl -
     the same lesson SunCascades already paid for. */
  _origin(l, cx, cz, out) {
    const t = l.m / l.n;
    out.x = Math.floor((cx - l.m*0.5)/t)*t;
    out.z = Math.floor((cz - l.m*DF_BIAS)/t)*t;
  }

  update(store, cx, cz) {
    if (!this.ok || !store) return;
    /* amount 0 = the quality tier has switched deformable snow off. The snow
       shaders already skip their sampling on this same uniform (uDfP.z <= 0.0 in
       deformAt), but that alone still paid for BOTH render-target passes and every
       stamp quad in them, every frame - so "off" cost full GPU and was merely
       invisible. That is the whole reason a low tier could not rescue a weak
       machine. Bail before any GL work.
       Leaving the textures stale is safe precisely because nothing samples them
       while the amount is 0, and the origins are republished on the first frame
       after it comes back. this.frame is NOT advanced, so the alternate-frame far
       window resumes on the same parity it left on. */
    if (this.uni.uDfP.value.z <= 0) return;
    this.frame++;
    const ren = this.ren;
    const prevRT = ren.getRenderTarget();
    let drawn = 0, clipped = 0;
    for (let k = 0; k < this.lv.length; k++) {
      const l = this.lv[k];
      /* the far window is redrawn on alternate frames; its ORIGIN uniform is
         only moved on the frames it is redrawn, or the texture and the window
         it is claimed to cover would disagree for a frame (SunCascades' rule) */
      if (this.frame % l.every !== 0) continue;
      const o = this.tmp;
      this._origin(l, cx, cz, o);
      const uni = k === 0 ? this.uni.uDfNO.value : this.uni.uDfFO.value;
      uni.x = o.x; uni.y = o.z; uni.z = l.m;

      const hits = store.queryRect(o.x, o.z, o.x + l.m, o.z + l.m, this.hits);
      const n = Math.min(hits.length, l.cap);
      if (hits.length > l.cap) clipped += hits.length - l.cap;
      const C = this.aCen.array, P = this.aPar.array, D = this.aDir.array;
      const s = {};
      for (let i = 0; i < n; i++) {
        store.get(hits[i], s);
        C[i*2] = s.x; C[i*2+1] = s.z;
        P[i*4] = s.depth; P[i*4+1] = s.halfW; P[i*4+2] = s.comp; P[i*4+3] = s.ice;
        D[i*3] = Math.cos(s.head); D[i*3+1] = Math.sin(s.head);
        D[i*3+2] = s.bfac === undefined ? 1 : s.bfac;
      }
      this.aCen.needsUpdate = true; this.aPar.needsUpdate = true; this.aDir.needsUpdate = true;
      this.aCen.addUpdateRange ? this.aCen.addUpdateRange(0, n*2) : 0;
      this.geo.instanceCount = n;
      this.mat.uniforms.uWin.value.set(o.x, o.z, l.m);
      l.count = n;

      ren.setRenderTarget(l.rt);
      /* NEVER call setViewport here: it takes CSS pixels and is multiplied by
         the pixel ratio even with a target bound (the impostor-atlas bug).
         setRenderTarget already sets the viewport to the target's size. */
      ren.setClearColor(0x000000, 0);
      ren.clear(true, false, false);
      if (n > 0) ren.render(this.scene, this.cam);
      drawn += n;
    }
    ren.setRenderTarget(prevRT);        // restores the stored viewport for free
    this.stats.near = this.lv[0].count | 0;
    this.stats.far = this.lv[1].count | 0;
    this.stats.drawn = drawn; this.stats.clipped = clipped;
  }

  /* live knob: 0 disables sampling entirely (one uniform, same-frame A/B) */
  setAmount(v) { this.uni.uDfP.value.z = v; }

  dispose() { for (const l of this.lv) l.rt.dispose(); this.geo.dispose(); this.mat.dispose(); }
}
