/* ------------------------------------------------- world streaming */
const CAP_NEAR = 4400, CAP_FAR = 6000, CAP_ROCK = 320, CAP_FLAG = 150, CAP_PARKM = 48;
const _wd = new THREE.Vector3();
const NEAR_D = 168;
/* ---------------------------------------------------------------- grounding
   Props and trees are AUTHORED on the analytic surface (sampleAt) but you LOOK
   AT the clipmap's piecewise-linear, distance-band-limited approximation of it,
   so every foot floats or sinks by the disagreement between the two. Same bug
   the trail had; same fix - read the DRAWN surface.
   MEASURED |analytic - drawn| at the real placed positions (z=2061, tier 3):
        0- 50m  med 3.2cm  max  6.6cm  (n=7)
       50-150m  med 0.9cm  max 21.7cm  (n=7)
      150-300m  med 22cm   max  1.37m  (n=39)
      300-500m  med 94cm   max  2.48m  (n=634)  <- where the forest lives
        500m+   med 1.58m  max  9.09m  (n=187)
   So the near-field 20cm is the small part: the treeline hovers ~1m off the
   snow, which is what makes the far forest read as pasted on.
   NO DISTANCE GATE. I first gated this at 150m, afraid that grounding on a
   band-limited far surface would make a prop slide vertically as the rows
   refine on approach. MEASURED that slide by advancing the clipmap origin 100m
   and re-reading the same world points: med 45cm / max 1.03m at 300-500m, i.e.
   ~7cm per placement pass (passes run every ~15m of travel) = 0.26px at 400m.
   The drift it introduces is sub-pixel and gradual; the error it removes is
   ~94cm and systematic. meshAt() returns false outside the clipmap, so the
   analytic height stays the fallback there. */
const _gm = { h: 0, x: 0, y: 1, z: 0 };
function groundH(x, z) {
  const t = G.terr;
  if (t && t.meshAt && t.meshAt(x, z, _gm)) return _gm.h;
  return terrainH(x, z);
}
/* Ground under a rectangular footprint. A building seated on `hi` never sinks
   into the slope, and `drop` is the gap its foundation has to cover.
   ANALYTIC ON PURPOSE - this must NOT use groundH(). A segment is built one to
   three segments ahead, where the clipmap rows are up to 64 m apart, so the
   DRAWN surface there is wrong by metres (MEASURED: up to 9 m past 500 m). Worse,
   mark() then stores `off = y - terrainH()`, which BAKES that error in forever:
   regroundSegs() faithfully reproduces it every frame, so a poisoned offset can
   never heal. MEASURED before this fix: the seg-2 cabin sat 15.3 m above the
   snow and regrounding recovered only 7 m of it.
   It is also an identity bug of the same class as the accumulated-x tree lattice
   - reading the drawn surface at build time makes a building's SITE depend on
   where the rider happened to be when its segment streamed in. Analytic here is
   position-independent, so `off` is exactly the authored sink and regroundSegs()
   adds the drawn correction at view time, which is what it is for. */
function footGround(x, z, hx, hz) {
  let lo = 1e9, hi = -1e9;
  for (let i = -1; i <= 1; i += 2) for (let j = -1; j <= 1; j += 2) {
    const h = terrainH(x + i * hx, z + j * hz);
    if (h < lo) lo = h; if (h > hi) hi = h;
  }
  return { lo, hi, drop: hi - lo };
}
/* No rigid box can stand cleanly on ground that drops 4m across its own
   footprint (MEASURED: 3.8m under the seg-6 cabin), and seating tricks only
   trade a buried wall for a hanging one. So pick a better SITE instead of a
   better pose: probe a few offsets and take the flattest. Buildings are
   decorative and sparse, so moving one 16m costs nothing. */
function bestSite(x, z, hx, hz) {
  let bx = x, bz = z, bf = footGround(x, z, hx, hz);
  for (const dx of [-16, -8, 8, 16]) for (const dz of [-10, 0, 10]) {
    const f = footGround(x + dx, z + dz, hx, hz);
    if (f.drop < bf.drop) { bf = f; bx = x + dx; bz = z + dz; }
  }
  return { x: bx, z: bz, f: bf };
}
/* Tree LOD. Sized against a MEASUREMENT of what is actually on screen at tier 3
   (1139 visible trees): the median visible tree is 34 px tall, only 2 are
   within 50 m, and 671 sit at 300-500 m. So detail on LOD0 is nearly free and
   LOD2 was grossly oversampled - 94 tris on a 13 px wide tree is under 2 px per
   triangle, and the rasteriser shades in 2x2 quads, so most of that work never
   reached a pixel.
   MEASURED tri counts (headless three.js against the real builders, not
   estimates) and the worst case each cap can actually reach:
       LOD0 2,367 tris <=  24 instances within d0   =   56,808 worst case
       LOD1   296 tris <= 420 instances within d1   =  124,320
       DEAD   295 tris <=  48 instances within d1   =   14,160
       LOD2    32 tris <= the rest of capN (~3900)  =  124,800
                                                       -------
                                                       320,088 worst case
   Typical at tier 3 is ~5/250/900/12 placed = ~118k (the ~155k baseline had a
   near-white 94-tri LOD2), while the far-band density goes UP ~45%: the tris
   saved on LOD2 are spent on canopy, which is what a forest at 300 m is
   actually made of.
   Wave 3 rebalanced the snow geometry WITHIN these budgets (LOD0 100 4-sided
   pillows -> 68 6-sided ones, so the masses read as rounded caps instead of
   spikes): net +2,016 tris on the worst case, +0.6%, no cap or distance moved.
   cap0 is 24, not 40: only 2 LOD0 instances are visible in a measured frame and
   2 trees sit within 50 m, so 24 is 12x the observed need - and LOD0 is the one
   tier that casts with its REAL geometry, so every LOD0 instance is drawn twice
   (near cascade + main pass). 40 x 2,367 x 2 = 189k was a spike waiting to
   happen for instances nobody has ever seen.
   LOD2 is a deliberate stopgap for a rendered impostor - cheap and dark.
   Distances and caps scale down with quality via q.nearD / q.capNear.
   Live tuning: FL.dbg.treeLod({d0, d1, cap0, cap1, capD, capMul, dens}),
   FL.dbg.treeTone({snowPaint, snowFace, pal:{frost:[..]}}) rebuilds the geometry. */
const CAP_L0 = 24, CAP_L1 = 420, CAP_LD = 48;
/* d1 = 210, not the 250 the LOD table nominally asks for: with the measured
   distance histogram, 250 m puts ~336 trees in LOD1 (100k tris) and blows the
   budget, while 210 lands on the ~250-instance / 75k line the table is really
   specifying. It is a live knob - retune it against a real frame. */
/* Tiers are chosen by EFFECTIVE ON-SCREEN SIZE (s0/s1), not by distance radii.
   Measured at tier 3 while riding, frozen at three sites: only 7-16% of near
   trees are on screen AND unoccluded at all, and those visible ones sit at a
   median 1.5-12 deg off the view axis with a median distance of 112-418 m. The
   old d1 = 210 m therefore excluded almost every tree the player actually looks
   at, while spending the budget on trees 80 deg out to the side.
   sz = height / effective distance, so it is the tangent of the tree's angular
   height: ~0.075 is a 60 px tree at fov 79, ~0.020 is a 12 px tree. Using size
   rather than distance also stops a 4 m sapling at 50 m outranking a 14 m pine
   at 100 m, which distance-only tiering did. */
/* s1 = 0.045, i.e. LOD1 only once a tree is ~25 px tall. Measured at z 900 in
   dense near forest against an all-LOD2 mid band, frozen frame, 0-pixel noise
   floor: taking the floor from 42 px to 25 px (LOD1 75 -> 210 instances, +33k
   tris) changed 0.659% of pixels, but taking it on down to 11 px (210 -> 420,
   +52k tris) changed only a further 0.193%. The second doubling costs more tris
   for 3.4x less picture, and at a mid-distance site the whole 420-instance LOD1
   population vs none was worth just 0.04% of the frame. Detail below ~25 px is
   not resolvable, so it is spent where it reads instead. */
/* Per-cell memory of the tier the SIZE THRESHOLDS last asked for, so a tree
   hovering at a threshold does not bounce every placement pass. MEASURED with
   the 3-pass census: true A->B->A oscillation is 437 of 3654 changes at z 900
   (12%), and 424 of those 437 are threshold-driven rather than cap eviction -
   so this is the right and only tool for that 12%. It CANNOT touch the other
   88%, which are settled/monotone transitions any LOD system has to make.
   An open hash on the integer cell index: a collision just gives one tree a
   stale hint for one pass, which is harmless (this is a hint, not state), so
   there is no need to pay for a Map. Cleared by dbg.replayStart, or a replay
   would inherit the previous run's tiers and stop being bit-exact. */
const TIER_MEM = new Int8Array(1 << 17);
const tierSlot = (ix, iz) => ((ix * 73856093) ^ (iz * 19349663)) & ((1 << 17) - 1);
const TREE_LOD = { s0: 0.075, s1: 0.045, hyst: 0.25, hystIn: 0.25, cap0: CAP_L0, cap1: CAP_L1, capD: CAP_LD,
  capMul: 1.35,      // headroom over q.capNear to pay for the density rise
  densK: 1.38,       // canopy acceptance, UNIFORM in distance (= old far value 0.92+0.46)
  dead: 0.05,        // fraction of near/mid trees that are bare standing dead
  sap: 0.12,         // fraction that are saplings
  lean: 0.105,       // max instance lean, radians (~6 deg)
  /* screen-relevance weighting of the LOD radii (measured waste it fixes:
     94% of LOD1 instances were OFF SCREEN, median 81 deg off the view axis) */
  /* gate = rad of margin past the frustum edge before a tree is capped to LOD2.
     Swept 0.26 / 0.12 / 0.03 at three sites: 0.03 was monotonically best (LOD0
     off screen 50% -> 0% at z900, and slightly FEWER tris), but placement only
     refreshes on 21 deg of view swing, so a hard edge could pop a tree from LOD2
     to LOD1 as it enters frame. 0.07 keeps a ~4 deg buffer: at speed the rider
     re-places every 14-16 m (~0.5 s), in which the chase camera swings a couple
     of degrees, so the buffer is never consumed in practice. */
  gate: 0.07,
  perif: 1.1,        // soft off-axis penalty INSIDE the frustum (edge of frame < centre)
  ax0: 0.55, ax1: 0.93,  // cos(view angle) where the soft penalty ends / starts
  /* deep MEASURED WRONG, left at 0 as a knob: penalising trees by how far they
     sit past the treeline edge assumes an eye-level view into a wall of trunks.
     Riding downhill you look DOWN onto the canopy, so stand-interior trees are
     visible - at deep 1.5 this excluded ~160 on-screen unoccluded trees per
     frame at z 1700-2600 while cap1 sat two thirds empty. */
  deep: 0,
  deep0: 7, deep1: 46 };
/* Far-tier impostor atlas resolution. cw/ch/pad scale TOGETHER: the bake's world
   bounds are R + pad*R/(cw/2 - pad), so doubling cw, ch and pad at once leaves
   the quad's world size bit-identical and changes ONLY the sampling density -
   which is what makes a resolution A/B a clean experiment.
   MEASURED AND REJECTED: 224x448 (4x the texels, 4x the VRAM) to test whether
   the far tier read too bright because the MSAA-free bake was dropping the thin
   dark needle fringe at sub-texel width. It is not: at 25 / 42 / 400 px the
   billboard moved by L -0.2 / -0.4 / +0.2 and snow fraction +0.011 / -0.012 /
   +0.011, i.e. nothing. The cause was the double tonemap (see matBill), and this
   stays at 112x224. Do not re-run this experiment. */
const TREE_IMP = { cells: 8, cw: 112, ch: 224, pad: 6 };
const TREE_TRI = [0, 0, 0, 0];      // filled once the geometry is built
const TREE_KEYS = ['treeA', 'treeB', 'treeC', 'treeD', 'treeF', 'rocks', 'shC', 'shD'];

class World {
  get obs() { return this.cur.obs; }
  get obsN() { return this.cur.obsN; }
  constructor(scene, quality, ren) {
    this.scene = scene;
    this.q = quality;
    const im = (geo, mat, cap, col) => {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.frustumCulled = false; m.count = 0;
      if (col) { m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); m.instanceColor.setUsage(THREE.DynamicDrawUsage); }
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
      return m;
    };
    /* wrap 0.42 lifted a fully back-facing needle face to 0.30 of full sun,
       which is most of why the tree read as if lit from the camera. 0.34 keeps
       a real light gradient across the crown; the under-tier faces stay off
       black because CONIF.ndark was lifted and tinted to sky bounce instead. */
    /* amb 0.34, not the 0.55 default: a canopy self-occludes, and 0.55 of a
       (0.26,0.42,0.74) sky was the single largest term in the v2 needle pixel -
       it made the gaps blue-grey where the reference has near-black green. */
    /* ambS 0.55: the needle ambient (0.30) is deliberately low because a canopy
       self-occludes, but applying it to the SNOW made every shaded snow mass
       render as slate blue at luminance ~100 - measured as the single most common
       colour over an LOD0 tree. See the uAmbS note in objMat. Needles are
       untouched (the split is driven by albedo). */
    this.matTree = objMat({ wrap: 0.34, amb: 0.30, ambS: 0.55, wrapS: 0.72 });
    this.matRock = objMat({ wrap: 0.3 });
    this.matProp = objMat({ wrap: 0.4 });
    this.matSign = signMat(signTex());          // shared by every trail sign panel
    this.matBill = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, WU, { uMap: { value: null }, uCells: { value: 1.0 } }),
      /* NOTE: `alphaTest` on a raw ShaderMaterial is INERT - three.js only acts on
         it through the <alphatest_fragment> include, which a custom shader does
         not have. The threshold that is actually in force is the discard in the
         fragment shader below. It is kept here only as documentation of intent.
         0.40, not 0.50: minification shrinks an alpha-tested silhouette, so a far
         sprite loses coverage and the forest thins out. */
      transparent: false, alphaTest: 0.40, side: THREE.DoubleSide,
      vertexShader: `
        uniform vec3 uSun; uniform float uCells;
        varying vec2 vUv; varying vec3 vW;
        void main(){
          vec3 org = (instanceMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;
          vec3 toCam = cameraPosition - org; toCam.y = 0.0;
          /* pick the nearest baked view azimuth. WORLD azimuth, never instance
             yaw: the bake carries the fixed world sun, so indexing by yaw would
             spin the sun around with each tree. */
          float _az = atan(toCam.x, toCam.z);
          float _c = floor(mod(_az/6.2831853*uCells + 0.5, uCells));
          vUv = vec2((_c + uv.x)/uCells, uv.y);
          vec3 r = normalize(vec3(toCam.z,0.0,-toCam.x));
          float sx = length(instanceMatrix[0].xyz), sy = length(instanceMatrix[1].xyz);
          vec3 wp = org + r*position.x*sx + vec3(0.0,position.y*sy,0.0);
          vW = wp;
          gl_Position = projectionMatrix*viewMatrix*vec4(wp,1.0);
        }`,
      fragmentShader: GLSL_COMMON + `
        uniform sampler2D uMap; varying vec2 vUv; varying vec3 vW;
        void main(){
          vec4 t = texture2D(uMap, vUv);
          if(t.a < 0.40) discard;
          vec3 vd = normalize(vW - cameraPosition);
          /* the atlas holds LINEAR radiance, sqrt-encoded (objMat uRaw), so this
             squaring is the exact inverse of the encode and the ONLY tonemap in
             the chain is the outc() below. It used to be t.rgb*t.rgb*1.15 +
             uSkyCol*0.10 over an atlas of already-tonemapped pixels, i.e. a
             double ACES plus two hand fudges to fight it; those fudges are gone.
             The per-view lighting ramp (vSh) is gone too: the atlas bakes 8 real
             view azimuths under the fixed world sun, so a fake dot(view,sun)
             brightening was double-counting the thing the bake already has. */
          vec3 col = t.rgb*t.rgb*float(${IMP_HDR});
          col = applyFog(col, length(vW-cameraPosition), vd);
          gl_FragColor = vec4(outc(col),1.0);
        }`
    });
    /* every streamed set is double buffered: a pass fills the hidden copy over
       several frames and the two are swapped only once it is complete, so the
       world never shows a half-built forest and no frame pays the whole cost */
    const pineG = TREE_LOD_GEO();                 // [LOD0, LOD1, LOD2, DEAD], see TREE_LOD
    for (let i = 0; i < 4; i++) TREE_TRI[i] = triCount(pineG[i]);
    this.pineG = pineG;
    /* Far tier = a rendered impostor of the REAL LOD0 tree. billFit carries the
       bake's world bounds so the quad below is scaled to the mesh tree's true
       footprint: the old sprite was 2*hgt tall against a 1.09*hgt mesh, i.e.
       nearly double, which is most of why the LOD2 -> far switch popped. */
    const _imp = ren ? treeImpostor(ren, pineG[0], this.matTree, TREE_IMP) : null;
    this.matBill.uniforms.uMap.value = _imp || pineTex();
    this.matBill.uniforms.uCells.value = _imp ? _imp.userData.cells : 1.0;
    this.billFit = _imp ? _imp.userData : null;
    this.ren = ren;                               // kept for rebakeImpostor()
    const billG = new THREE.PlaneGeometry(1, 2).translate(0, 1, 0), rockG = rockGeo(7);
    /* Shadow proxy for the FAR tiers only: a tree silhouette at 150 m+ does
       not need 300 tris, so the cascades draw an 8-sided cone (16 tris) per
       tree instead of the full canopy. It reuses the canopy's instanceMatrix
       ATTRIBUTE OBJECT, so placement writes once and both meshes see it, and it
       lives only on the cascade layer so it is never drawn for real.
       The MID tier is NOT proxied any more - see the treeB note below.
       SIZE IS READ OFF THE SOURCE GEOMETRY'S BOUNDING BOX, not off
       userData.rTip: rTip is the canopy's rim-lump reach (rTip*1.14 for the
       rims), which overstates the actual silhouette by 14-26% - it had the far
       cone at r 0.395 where the tree only spans 0.347, and a shadow wider than
       its tree is exactly what reads as a slab. Height likewise: the tree tops
       out at 0.930, the cone was hardcoded 0.9.
       One cone per proxied SOURCE geometry, because the standing-dead variant is
       a third narrower than a live tree and a shared cone would hand it a
       shadow wider than itself - the far cone used to be built from pineG[1]
       while proxying pineG[2], which is that same bug in the other direction.
       A geometry is not a draw call - shC/shD are already separate meshes. */
    const cone = i => {
      const g = this.pineG[i];
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      const r = Math.max(bb.max.x, bb.max.z, -bb.min.x, -bb.min.z) || TREE_RMAX;
      const h = bb.max.y || 0.93;
      return new THREE.ConeGeometry(r * 0.96, h, 8, 1).translate(0, h * 0.5, 0);
    };
    const coneC = cone(2), coneD = cone(3);
    this._cone = [coneC, coneD];                  // owned, so treeTone can free them
    const proxyMat = new THREE.MeshBasicMaterial();
    const proxy = (geo, src, cap) => {
      const m = new THREE.InstancedMesh(geo, proxyMat, cap);
      m.frustumCulled = false; m.count = 0;
      m.instanceMatrix = src.instanceMatrix;      // shared, not copied
      scene.add(m);
      if (G.csc) G.csc.addProxy(m);
      return m;
    };
    const mk = () => {
      /* one instanced mesh per LOD tier; every proxied tier keeps its own
         cascade proxy because a proxy borrows its source mesh's instanceMatrix */
      const treeA = im(pineG[0], this.matTree, CAP_L0, true);
      const treeB = im(pineG[1], this.matTree, CAP_L1, true);
      const treeC = im(pineG[2], this.matTree, CAP_NEAR, true);
      const treeD = im(pineG[3], this.matTree, CAP_LD, true);
      const rocks = im(rockG, this.matRock, CAP_ROCK, true);
      if (G.csc) {
        G.csc.add(rocks);                         // rocks cast and are visible
        /* LOD0 casts with its REAL geometry (add, not addProxy): a cone proxy
           can only ever put an ellipse on the snow, so a close tree could never
           shadow its own lower tiers - and that structured dark interior is
           most of where the reference photo gets its depth. It is also why cap0
           is only 24: an LOD0 instance is drawn TWICE (near cascade + main), so
           the worst case is 24 x 2,345 x 2 = 113k, against a measured 2 visible
           LOD0 trees per frame. */
        G.csc.add(treeA);
        /* LOD1 casts with its real geometry too, for the same reason - MEASURED:
           the 365 mid-tier cone proxies in one backlit frame were 40.9% of the
           treeline band and 5.6% of the whole frame, and they were the hard-edged
           dark slabs on the snow. Swapping in the real canopy is what breaks them
           up into dappled shade (a narrower cone only softens them: band delta
           5.49% vs 11.1%). It costs 420 x 248 = 104k cascade tris worst case
           against the cone's 6.7k, which is the same order as PB9's +63k tris at
           +0.05-0.11 ms. The FAR tiers keep their cones: shC is 3908 instances
           and was worth only 0.05% of the frame, so real geometry there would be
           ~15x the tris for nothing visible. */
        G.csc.add(treeB);
      }
      return {
      treeA, treeB, treeC, treeD, rocks,
      shC: proxy(coneC, treeC, CAP_NEAR), shD: proxy(coneD, treeD, CAP_LD),
      treeF: im(billG, this.matBill, CAP_FAR, false),
      obs: new Float32Array((CAP_NEAR + CAP_ROCK) * OBS_S), obsN: 0
    };};
    this.A = mk(); this.B = mk();
    for (const S of [this.A, this.B]) {
      for (const k of TREE_KEYS) S[k].count = 0;
    }
    this.cur = this.A; this.bak = this.B;
    this.flags = im(flagGeo(), this.matProp, CAP_FLAG, false);
    /* freestyle markers are their own instanced mesh rather than more flags:
       different geometry, and it shares matProp so it is +1 draw call. */
    this.parkM = im(parkMarkerGeo(), this.matProp, CAP_PARKM, false);
    this.segGroups = new Map();
    this.ticks = [];
    this.lastPlace = { x: 1e9, z: 1e9 };
    this.lastFwd = new THREE.Vector3(0, 0, 1);
    this.pl = null;                       // in-flight placement pass
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._q2 = new THREE.Quaternion(); this._v2 = new THREE.Vector3();
    this._c = new THREE.Color();
    /* FL.dbg.treeLod()                      -> live counts + tri total
       FL.dbg.treeLod({s1:0.010, cap0:400}) -> retune, takes effect next pass
       FL.dbg.treeLod({densK:0.92, lean:0}, true)-> A/B a single knob immediately
       FL.dbg.treeLod({s0:0}, true)          -> force every tree to LOD0 and
                                                re-place immediately          */
    G.dbg.treeLod = (o, now) => {
      if (o) Object.assign(TREE_LOD, o);
      if (now && G.rider) this.place(G.rider.p.x, G.rider.p.z);
      const S = this.cur, n = [S.treeA.count, S.treeB.count, S.treeC.count, S.treeD.count];
      return { ...TREE_LOD, tri: TREE_TRI.slice(), n, far: S.treeF.count, obs: S.obsN,
        tris: n[0] * TREE_TRI[0] + n[1] * TREE_TRI[1] + n[2] * TREE_TRI[2] + n[3] * TREE_TRI[3] };
    };
    /* ---- PB5: LOD comparison rig -------------------------------------------
       Alexander: "in a test show a tree large on screen and force it through all
       the LODs and see how you could improve the closeness between them."

         FL.dbg.lodRig(tier, {px, hgt, fov, yaw})   tier 0/1/2/3 = mesh tiers,
                                                    4 = far billboard impostor,
                                                    -1 = nothing (empty frame)
         FL.dbg.lodRigOff()                         restore the game

       It drives the REAL instanced meshes at count = 1 rather than building
       copies, so every tier goes through exactly the in-game material path
       (instancing, tint, fog, tonemap) and cannot drift from what ships.

       Three things make the comparison honest:
         * ONE anchor and ONE camera for every tier at a given size - the anchor
           is placed ahead of the rider by dist + 12 m so the camera sits in
           front of the rider and the rider is never in frame.
         * tier -1 renders the identical frame with no tree, so a capture diff
           gives an EXACT tree mask (no luminance threshold guessing, and while
           paused the noise floor is 0 pixels).
         * cascade shadows OFF for the duration. A tree's shadow falls on the
           snow and would be counted as silhouette; and the mesh tiers cast via
           cone proxies while the billboard cannot cast at all, so leaving them
           on compares three different shadow systems instead of three trees.
       Size is specified in PIXELS, not metres, because that is the axis the
       tier thresholds actually use (s0 ~42 px, s1 ~25 px at fov 79). */
    G.dbg.lodRig = (tier, o) => {
      o = o || {};
      const S = this.cur, r = G.rider;
      if (!r) return { err: 'no rider yet' };
      const st = this._rig || (this._rig = {});
      const hgt = o.hgt || st.hgt || 11, fov = o.fov || st.fov || 55;
      const px = o.px || st.px || 400;
      st.hgt = hgt; st.fov = fov; st.px = px;
      if (st.csOn === undefined) {                      // first call: take the world offline
        const u = this.matBill.uniforms.uCsOn;
        st.csOn = u ? u.value : null; if (u) u.value = 0;
        st.fovWas = G.cam.fov;
      }
      G.paused = true;
      /* solve the camera distance that puts the tree at the requested pixel
         height: px = H * (hgt/dist) / (2 tan(fov/2)) */
      const H = G.ren.domElement.height;
      const dist = hgt * H / (px * 2 * Math.tan(fov * Math.PI / 360));
      if (!st.anchor || o.place || st.aDist !== dist) {
        const z = r.p.z + dist + 12, x = r.p.x + (o.lat || 0);
        const q = {}; const hit = G.terr.meshAt(x, z, q);
        const gy = (hit && Number.isFinite(q.h)) ? q.h : r.p.y;
        st.anchor = { x, y: gy, z }; st.aDist = dist;
      }
      const A = st.anchor;
      for (const k of TREE_KEYS) S[k].count = 0;
      const M = this._m, Q = this._q, V = this._v, S2 = this._s;
      if (tier >= 0 && tier <= 3) {
        const tm = tier === 0 ? S.treeA : tier === 1 ? S.treeB : tier === 3 ? S.treeD : S.treeC;
        Q.setFromAxisAngle(V.set(0, 1, 0), o.yaw || 0);
        M.compose(V.set(A.x, A.y - 0.10, A.z), Q, S2.set(hgt, hgt, hgt));
        tm.setMatrixAt(0, M); tm.instanceMatrix.needsUpdate = true;
        /* mid tint, identical on every tier: the placement tint spans
           0.80..1.22 on a hash, and letting it vary would show up as a
           per-tier colour difference that is really just noise */
        this._c.setRGB(0.975, 1.02, 1.055);
        tm.setColorAt(0, this._c); if (tm.instanceColor) tm.instanceColor.needsUpdate = true;
        tm.count = 1;
      } else if (tier === 4) {
        const bf = this.billFit;
        if (bf) { M.makeScale(hgt * bf.w, hgt * bf.h * 0.5, 1);
                  M.setPosition(A.x, A.y - 0.10 + bf.y0 * hgt, A.z); }
        else { M.makeScale(hgt * 0.52, hgt, 1); M.setPosition(A.x, A.y - 0.4 - hgt * 0.035, A.z); }
        S.treeF.setMatrixAt(0, M); S.treeF.instanceMatrix.needsUpdate = true;
        S.treeF.count = 1;
      }
      const cam = G.cam;
      cam.fov = fov; cam.position.set(A.x, A.y + hgt * 0.45, A.z - dist);
      cam.lookAt(A.x, A.y + hgt * 0.45, A.z);
      cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      if (G.sky && G.sky.dome) G.sky.dome.position.copy(cam.position);
      G.ren.render(G.scene, cam);
      const P = cam.position.constructor;
      const b = new P(A.x, A.y, A.z).project(cam), t = new P(A.x, A.y + hgt, A.z).project(cam);
      return { tier, hgt, fov, distM: +dist.toFixed(2), pxWant: px,
        pxGot: +(Math.abs(b.y - t.y) * 0.5 * H).toFixed(1),
        tris: tier >= 0 && tier <= 3 ? TREE_TRI[tier] : (tier === 4 ? 2 : 0),
        anchor: { x: +A.x.toFixed(2), y: +A.y.toFixed(2), z: +A.z.toFixed(2) } };
    };
    G.dbg.lodRigOff = () => {
      const st = this._rig; if (!st) return 0;
      const u = this.matBill.uniforms.uCsOn;
      if (u && st.csOn !== null && st.csOn !== undefined) u.value = st.csOn;
      if (st.fovWas) G.cam.fov = st.fovWas;
      G.cam.updateProjectionMatrix();
      st.csOn = undefined; st.anchor = null;
      G.paused = false;
      if (G.rider) this.place(G.rider.p.x, G.rider.p.z);
      return 1;
    };
    /* ---- LOD-pop instrumentation (section 3 of the work list) ----
       FL.dbg.rec(1) arms per-pass recording, FL.dbg.rec(0) disarms it.
       FL.dbg.popJoin() joins the last TWO recorded passes on the grid key and
       returns the tier-change census plus an identity-stability check.
       Tiers: 0/1/2 mesh LODs, 3 standing-dead, 4 far billboard, -1 absent. */
    G.dbg.rec = (on) => {
      TREE_LOD.rec = on ? 1 : 0;
      if (on) { this.recAll = []; this.prevRec = this.lastRec = null; }
      return { rec: TREE_LOD.rec };
    };
    /* popJoin(i) joins recAll[i] with recAll[i+1] - a FIXED pair, so a scripted
       replay reports the same census every run. popJoin() with no argument keeps
       the old "last two passes" behaviour for interactive poking. */
    G.dbg.tierMemClear = () => { TIER_MEM.fill(0); return 1; };
    G.dbg.hyst = (v, vin) => { if (v !== undefined) TREE_LOD.hyst = v; if (vin !== undefined) TREE_LOD.hystIn = vin; TIER_MEM.fill(0); return { hyst: TREE_LOD.hyst, hystIn: TREE_LOD.hystIn }; };
    G.dbg.popN = () => (this.recAll || []).length;
    G.dbg.popJoin = (i) => {
      let A = this.prevRec, B = this.lastRec;
      if (i !== undefined) {
        const R = this.recAll || [];
        if (R.length < i + 2) return { err: 'need pass ' + (i + 1) + ', have ' + R.length };
        A = R[i]; B = R[i + 1];
      }
      if (!A || !B) return { err: 'need two recorded passes; FL.dbg.rec(1) then force two placements' };
      const F = 9, CELL = 6.6;
      const key = (x, z) => Math.round(x / CELL) + ':' + Math.round(z / CELL);
      const load = (R) => { const m = new Map();
        for (let i = 0; i < R.r.length; i += F) m.set(key(R.r[i], R.r[i + 1]), i);
        return m; };
      const ma = load(A), mb = load(B);
      // px per unit of (hgt/dist): hpx = h/d * cssH / (2 tan(fov/2)), captured at pass time
      const kpx = B.kpx || (G.ren.domElement.clientHeight / (2 * Math.tan(G.cam.fov * 0.5 * Math.PI / 180)));
      const trans = {}, changed = [];
      let matched = 0, drift = 0, maxDrift = 0;
      for (const [k, ib] of mb) {
        const ia = ma.get(k); if (ia === undefined) continue;
        matched++;
        // identity check: same cell must give bit-identical procedural properties
        for (const o of [3, 4, 5]) {
          const d = Math.abs(A.r[ia + o] - B.r[ib + o]);
          if (d > 1e-9) { drift++; if (d > maxDrift) maxDrift = d; break; }
        }
        const ta = A.r[ia + 2], tb = B.r[ib + 2];
        if (ta !== tb) {
          const t = ta + '->' + tb; trans[t] = (trans[t] || 0) + 1;
          const hpx = B.r[ib + 3] / B.r[ib + 6] * kpx;
          changed.push({ t, hpx: +hpx.toFixed(1), dist: +B.r[ib + 6].toFixed(0),
            csc: +B.r[ib + 7].toFixed(3), on: B.r[ib + 7] > 0.5 });
        }
      }
      changed.sort((p, q) => q.hpx - p.hpx);
      const nA = A.r.length / F, nB = B.r.length / F;
      return { nPrev: nA, nLast: nB, matched, onlyPrev: nA - matched, onlyLast: nB - matched,
        identityDrift: drift, maxDrift: +maxDrift.toExponential(2),
        moved: Math.hypot(B.px - A.px, B.pz - A.pz).toFixed(1),
        nChanged: changed.length, trans,
        worst: changed.slice(0, 12),
        changedOnScreen: changed.filter(c => c.on).length,
        sumHpx: +changed.reduce((s, c) => s + c.hpx, 0).toFixed(0),
        sumHpxOn: +changed.filter(c => c.on).reduce((s, c) => s + c.hpx, 0).toFixed(0) };
    };
    /* popFlip(i) looks at THREE consecutive passes and classifies each cell's
       tier sequence, because "nChanged" alone cannot tell a genuine oscillation
       from a settled transition - and they need opposite fixes:
         flip   A->B->A  the tree bounced and came back. Real churn. Hysteresis
                         fixes this and nothing else does.
         step   A->B->B  a settled change (a tree legitimately getting closer).
                         Hysteresis only delays it; it cannot remove it.
         drift  A->B->C  three different tiers in a row.
       Each is attributed with the PRE-CAP tier (field 8): if liRaw is identical
       across the passes then the size thresholds never moved and the change was
       CAP EVICTION - the budget was full and another tree took the slot, which
       hysteresis on thresholds cannot fix at all. */
    G.dbg.popFlip = (i = 0) => {
      const R = this.recAll || [];
      if (R.length < i + 3) return { err: 'need 3 passes from ' + i + ', have ' + R.length };
      const F = 9, CELL = 6.6;
      const key = (x, z) => Math.round(x / CELL) + ':' + Math.round(z / CELL);
      const load = (P) => { const m = new Map();
        for (let k = 0; k < P.r.length; k += F) m.set(key(P.r[k], P.r[k + 1]), k);
        return m; };
      const [A, B, C] = [R[i], R[i + 1], R[i + 2]];
      const ma = load(A), mb = load(B), mc = load(C);
      const o = { seen: 0, stable: 0, flip: 0, step: 0, drift: 0,
        flipCap: 0, flipThresh: 0, stepCap: 0, stepThresh: 0,
        flipHpx: 0, stepHpx: 0, flipPairs: {}, worstFlip: [] };
      for (const [k, ib] of mb) {
        const ia = ma.get(k), ic = mc.get(k);
        if (ia === undefined || ic === undefined) continue;
        o.seen++;
        const ta = A.r[ia + 2], tb = B.r[ib + 2], tc = C.r[ic + 2];
        if (ta === tb && tb === tc) { o.stable++; continue; }
        const ra = A.r[ia + 8], rb = B.r[ib + 8], rc = C.r[ic + 8];
        const capDriven = (ra === rb && rb === rc);
        const hpx = B.r[ib + 3] / B.r[ib + 6] * (B.kpx || 560);
        if (ta === tc && tb !== ta) {
          o.flip++; o.flipHpx += hpx;
          capDriven ? o.flipCap++ : o.flipThresh++;
          const t = ta + '->' + tb + '->' + tc;
          o.flipPairs[t] = (o.flipPairs[t] || 0) + 1;
          o.worstFlip.push({ t, hpx: +hpx.toFixed(1), cap: capDriven });
        } else if (tb === tc) {
          o.step++; o.stepHpx += hpx;
          capDriven ? o.stepCap++ : o.stepThresh++;
        } else o.drift++;
      }
      o.flipHpx = +o.flipHpx.toFixed(0); o.stepHpx = +o.stepHpx.toFixed(0);
      o.worstFlip.sort((a, b) => b.hpx - a.hpx); o.worstFlip = o.worstFlip.slice(0, 8);
      return o;
    };
    /* Needle tone and snow load live in VERTEX COLOURS, i.e. in the geometry, so
       they cannot be a uniform. This rebuilds the whole LOD family with the
       override merged into every tier and hot-swaps it into both streamed sets
       (they share the geometry objects) - ~40 ms, no page reload, so the lead can
       A/B the thing that decides whether the far forest reads dark:
         FL.dbg.treeTone({snowPaint: 0.9})            -> the wave-1 frost load
         FL.dbg.treeTone({pal:{frost:[1.02,1.05,1.15]}}) -> the wave-1 BUG, back
         FL.dbg.treeTone()                            -> shipped values
       The shadow proxies are re-cut too, or a wider canopy keeps a narrow shadow. */
    G.dbg.treeTone = (ov = {}) => {
      const old = this.pineG;
      const g = TREE_LOD_GEO(ov);
      this.pineG = g;
      for (let i = 0; i < 4; i++) TREE_TRI[i] = triCount(g[i]);
      const keys = ['treeA', 'treeB', 'treeC', 'treeD'];
      for (const S of [this.A, this.B]) for (let i = 0; i < 4; i++) S[keys[i]].geometry = g[i];
      const nc = cone(2), nd = cone(3);
      for (const S of [this.A, this.B]) {
        S.shC.geometry = nc; S.shD.geometry = nd;
      }
      for (const o of old) o.dispose();
      if (this._cone) for (const c of this._cone) c.dispose();
      this._cone = [nc, nd];
      return { tri: TREE_TRI.slice(), rTip: g.map(x => +x.userData.rTip.toFixed(4)), ov };
    };
  }

  /* ---- streamed placement: begin / step / commit ---- */
  /* Re-bake the far-tree impostor atlas for whatever the sun is NOW. The atlas
     stores baked RADIANCE under the world sun (that is the whole point of it -
     see treeImpostor), so a runtime time-of-day change would otherwise leave the
     entire distant forest, ~1600 instances and most of the visible tree count,
     lit from the previous sun's side while the terrain under it moved. Not
     needed at boot: main.js sets the sun before `new World`, so the first bake
     is already correct and this is only for a live switch from the pause menu.
     Disposes the superseded texture, or repeated switching leaks 896x224 RGBA
     each time. */
  rebakeImpostor() {
    if (!this.ren || !this.pineG) return false;
    const t = treeImpostor(this.ren, this.pineG[0], this.matTree, TREE_IMP);
    if (!t) return false;
    const old = this.matBill.uniforms.uMap.value;
    this.matBill.uniforms.uMap.value = t;
    this.matBill.uniforms.uCells.value = t.userData.cells;
    this.billFit = t.userData;
    if (old && old !== t && old.dispose) old.dispose();
    return true;
  }
  place(px, pz) {                        // synchronous full pass (warp, quality change)
    this.beginPlace(px, pz);
    while (this.pl) this.stepPlace(1e9);
  }
  beginPlace(px, pz) {
    const vd = G.cam.getWorldDirection(_wd);
    let fx = vd.x, fz = vd.z;
    const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const capF = Math.min(this.q.capFar, CAP_FAR);
    const farD = this.q.farD || (200 + capF * 0.17);
    const CELL = 6.6;
    const sq = Math.max(1, 470 / Math.max(120, this.q.nearD));   // quality -> size demand
    /* Hard frustum gate for the LOD decision. A tree outside the frame cannot
       benefit from detail however large it is, and a soft angular penalty could
       not stop a big one beside the rider from claiming LOD0 (measured: 33% of
       LOD0 instances off screen even with perif 2.6). Half the HORIZONTAL fov,
       plus a margin so a tree does not pop as the camera swings. */
    const hHalf = Math.atan(Math.tan(G.cam.fov * 0.5 * Math.PI / 180) * G.cam.aspect);
    const csCut = Math.cos(Math.min(1.50, hHalf + TREE_LOD.gate));
    this.lastFwd.set(fx, 0, fz);
    this.pl = {
      px, pz, fx, fz, ex: px - fx * 14, ez: pz - fz * 14,
      /* capMul buys back the instance headroom the LOD2 tri cut paid for, so
         the extra far-band density has somewhere to go */
      capN: Math.min(Math.round(this.q.capNear * TREE_LOD.capMul), CAP_NEAR), capF,
      nearD: this.q.nearD, farD, CELL,
      /* LOD size thresholds and caps ride the quality tier: a weak device with
         nearD 90 must not spend its whole budget on LOD0, so it demands a
         BIGGER on-screen tree before granting a tier */
      s0: TREE_LOD.s0 * sq, s1: TREE_LOD.s1 * sq, csCut,
      cx: G.cam.position.x, cz: G.cam.position.z,
      cap0: Math.min(TREE_LOD.cap0, Math.round(this.q.capNear * 0.05)),
      cap1: Math.min(TREE_LOD.cap1, Math.round(this.q.capNear * 0.28)),
      capD: Math.min(TREE_LOD.capD, Math.round(this.q.capNear * 0.04)),
      nL: [0, 0, 0, 0],
      /* Walk the lattice by INTEGER INDEX and derive z as `iz * CELL`.
         Accumulating `z += CELL` from a start that moves with the rider reaches
         the same cell as a slightly different double, and every per-tree hash
         truncates a multiple of it (`h2(x * 13 | 0, ...)`). 6.6 * 5 = 33 exactly,
         so `x * 5 | 0` sits ON an integer boundary in 200/200 cells and the
         other multipliers in 20% - one ulp of drift flips the hash and the cell
         grows a DIFFERENT tree. MEASURED before this fix: ~2% of cells changed
         height/jitter between consecutive passes, by up to 7.56 m. A product
         from the index is bit-identical for a given cell forever. */
      iz: Math.ceil((pz - 120) / CELL), z1: pz + farD,
      nN: 0, nF: 0, nR: 0, nO: 0,
      dc: new Map(),
      /* LOD-pop instrumentation (FL.dbg.rec(1)). Off by default: one property
         read and one branch per candidate. A tree's IDENTITY is its grid cell
         (x, z) - both are exact multiples of CELL on a global lattice and every
         per-tree property is hashed from them - so joining two passes on that
         key is what makes a tier CHANGE measurable at all. */
      rec: TREE_LOD.rec ? [] : null
    };
  }
  stepPlace(budgetMs) {
    const P = this.pl; if (!P) return;
    const t0 = nowMs();
    const S = this.bak;
    const M = this._m, V = this._v, S2 = this._s, C = this._c, Q = this._q;
    const { px, pz, fx, fz, ex, ez, capN, capF, nearD, farD, CELL, s0, s1, cap0, cap1, capD,
      csCut, cx, cz } = P;
    const Q2 = this._q2, V2 = this._v2;
    const COSCUT = -0.16;
    const GS = 22, dc = P.dc;
    const node = (kx, kz) => {
      const k = kx * 8192 + kz;
      let v = dc.get(k);
      if (v === undefined) { v = fbm2(kx * GS * 0.0031, kz * GS * 0.0027, 2); dc.set(k, v); }
      return v;
    };
    const densAt = (x, z) => {
      const gx = x / GS, gz = z / GS;
      const ix = Math.floor(gx), iz = Math.floor(gz);
      const fxx = gx - ix, fzz = gz - iz;
      const a = node(ix, iz), b = node(ix + 1, iz), c = node(ix, iz + 1), d = node(ix + 1, iz + 1);
      const t0r = a + (b - a) * fxx, t1r = c + (d - c) * fxx;
      return t0r + (t1r - t0r) * fzz;
    };
    let rows = 0;
    while (P.iz * CELL < P.z1) {
      const z = P.iz * CELL;
      collectPaths(z);
      collectPoach(z);
      const cc = _pC[0];
      const xr = 330;
      const ixEnd = (cc + xr) / CELL;
      for (let ix = Math.ceil((cc - xr) / CELL); ix < ixEnd; ix++) {
        const x = ix * CELL;                       // product, never accumulated
        const hh = h2(x * 13 | 0, z * 7 | 0);
        let dmin = 1e9;
        for (let i = 0; i < _pN; i++) { const d = Math.abs(x - _pC[i]) - _pW[i]; if (d < dmin) dmin = d; }
        if (dmin < 2.2 + hh * 5) continue;
        const jx = x + (h2(x | 0, z * 3 | 0) - 0.5) * CELL * 0.95;
        const jz = z + (h2(x * 5 | 0, z | 0) - 0.5) * CELL * 0.95;
        /* poach lines get a rideable slot cut in the pines (tested on the
           jittered trunk position, or a tree hops back into the track), while
           the forest stays dense right up to the edge */
        let dpo = 1e9;
        for (let i = 0; i < _qN; i++) { const d = Math.abs(jx - _qC[i]) - _qW[i]; if (d < dpo) dpo = d; }
        if (dpo < 2.4 + hh * 2.0) continue;
        const dist = Math.hypot(jx - px, jz - pz);
        if (dist > farD) continue;
        const ddx = jx - ex, ddz = jz - ez, dl = Math.hypot(ddx, ddz) || 1;
        const cs = (ddx * fx + ddz * fz) / dl;      // 1 = dead ahead, -1 = behind
        if (dl > 26 && cs < COSCUT) continue;                             // outside the view cone
        const dens = smoothstep(-0.22, 0.30, densAt(jx, jz)) * smoothstep(1.0, 12.0, dmin);
        const rr = h2(x * 31 | 0, z * 17 | 0);
        if (rr > 0.982 && dmin > 14 && dpo > 4 && P.nR < CAP_ROCK) {
          const sc = 0.7 + hh * 2.4;
          // seat the boulder on the lowest point under its footprint
          const rr2 = sc * 0.8;
          let y = groundH(jx, jz);
          y = Math.min(y, groundH(jx + rr2, jz), groundH(jx - rr2, jz),
                          groundH(jx, jz + rr2), groundH(jx, jz - rr2));
          M.makeRotationY(hh * 9); M.setPosition(jx, y - sc * 0.35, jz);
          M.scale(S2.set(sc, sc * (0.7 + hh * 0.5), sc));
          S.rocks.setMatrixAt(P.nR, M);
          const g = 0.9 + hh * 0.25;
          S.rocks.setColorAt(P.nR, C.setRGB(g, g, g * 1.03));
          if (dist < nearD + 40) { const o = P.nO * OBS_S; S.obs[o] = jx; S.obs[o + 1] = jz; S.obs[o + 2] = sc * 0.95; S.obs[o + 3] = 1;
            S.obs[o + 4] = y + sc * 0.75; P.nO++; }
          P.nR++; continue;
        }
        /* A TREE'S EXISTENCE MUST NEVER DEPEND ON THE RIDER'S POSITION.
           This test used to be
             rr > dens * (0.92 + TREE_LOD.dens * smoothstep(230, 430, dist))
           i.e. canopy density deliberately ROSE with distance (the far band is
           where the forest lives and a tree there costs 32 tris, so the tri
           saving was spent on far density). But that makes acceptance a function
           of `dist`, so as the rider rode TOWARD a tree its threshold fell and
           the tree winked OUT OF EXISTENCE somewhere in the 230-430 m ramp.
           MEASURED (existence-churn census, 11 placement passes, tier 3): 22.8
           on-screen trees dropped PER PASS, median 14.8 px, max 27.1 px, median
           distance 314 m - ~23 plainly visible trees vanishing every 16 m of
           travel, about twice a second at speed. That is Alexander's PB3, "in
           some places I can see the loading and unloading of the snow world
           grid". Zeroing the knob cut it to 0.5/pass (46x), which is what
           identified it; note popJoin could never have found this because it
           joins passes on the cell key and SKIPS cells missing from either side.
           Now one rider-independent constant, held at the old FAR value so the
           far-band mass the canopy-density pass won is preserved exactly. The
           near band gets that same density instead of 33% less, which also
           serves the open T1 canopy-coverage item (45% vs 96% in the reference).
           Density may vary over the WORLD (densAt, dmin) - never over time. */
        if (rr > dens * TREE_LOD.densK) continue;
        const y = groundH(jx, jz);
        /* ONE height for this tree, shared by the mesh branch and the far
           billboard branch below. They used to compute it separately and the far
           one was missing BOTH the sapling factor and the dmin bonus, so a
           sapling was drawn as a billboard at full mature height and snapped to
           ~40% of it the instant it crossed nearD. MEASURED: 10.09 m -> 4.58 m on
           one cell, and a flat 1.50 m step on every tree with dmin > 30. Since
            `4->2` is 68-93% of all tier changes, that made the billboard edge the
            single largest pop source in the game.

            The stand-depth bonus used to be a HARD STEP, `dmin > 30 ? 1.5 : 0`.
            dmin is min(|x - corridorCentre| - width) over the corridors, which is
            recomputed every pass and wobbles a hair as the corridor blend shifts,
            so a cell sitting within that hair of 30 m GREW 1.5 m INSTANTLY between
            two passes. Caught by the identity-drift check (1 cell in 6589, maxDrift
            exactly 1.50) - the same class of bug as the accumulated-x lattice: a
            hard threshold on a continuously varying quantity inside a formula that
            is supposed to define a tree's identity forever. Smoothstepped over
            24-36 m it keeps the art intent (deeper in the stand = taller) with no
            discontinuity to trip over, and it also removes the visible line across
            the forest where trees abruptly got taller. */
         const cls = h2(x * 11 | 0, z * 23 | 0);
         const sap = cls < TREE_LOD.sap;
         const hgt = (5.2 + hh * 8.5 + 1.5 * smoothstep(24, 36, dmin)) * (sap ? 0.28 + hh * 0.20 : 1);
        if (dist < nearD && P.nN < capN) {
          const nrm = terrainNormal(jx, jz, 1.2);
          if (nrm.y < 0.60) continue;
          /* size classes: most trees are mature, ~12% are saplings. One
             geometry per LOD means the instance matrix is the only place
             topology variation can come from, so it carries scale, yaw AND a
             small lean - a stand of perfectly vertical clones is the second
             loudest procedural tell after the whorl gaps. */
          Q.setFromAxisAngle(V.set(0, 1, 0), hh * 21);
          const la = h2(x * 17 | 0, z * 29 | 0) * TAU;
          Q2.setFromAxisAngle(V2.set(Math.cos(la), 0, Math.sin(la)),
            (h2(x * 3 | 0, z * 41 | 0) - 0.5) * 2 * TREE_LOD.lean);
          Q.premultiply(Q2);
          /* A fixed 0.35m sink leaves the DOWNHILL side of the trunk foot hanging
             in the air on a steep slope (the ground falls ~1.3m across a 15m
             tree's base at 53deg). Plant the tree on the lowest point of its own
             foot instead: nrm.xz points downhill, so one extra height sample
             there is all it takes. */
          const xzs = 0.85 + hh * 0.3;
          const rB = hgt * 0.072 * xzs;
          const dnl = Math.hypot(nrm.x, nrm.z) || 1;
          const dnx = nrm.x / dnl * rB, dnz = nrm.z / dnl * rB;
          /* the smooth downhill estimate alone still left every foot ~0.19m in the
             air, because the snow under a 1m-wide foot has its own noise. Sample
             the ring itself: downhill, uphill and both cross points. */
          const yLow = Math.min(y,
            groundH(jx + dnx, jz + dnz), groundH(jx - dnx, jz - dnz),
            groundH(jx - dnz, jz + dnx), groundH(jx + dnz, jz - dnx));
          M.compose(V.set(jx, yLow - 0.10, jz), Q, S2.set(hgt * xzs, hgt, hgt * xzs));
          /* pick the LOD tier by distance; a full tier spills into the next
             coarser one so a dense stand never drops trees outright. Tier 3 is
             the bare standing-dead variant: only worth its own draw call where
             you can resolve it, so it borrows the LOD1 band and falls back to a
             normal tree when its cap is full. */
          /* Pick the tier by EFFECTIVE distance, not geometric distance. Raw
             distance is isotropic and occlusion-blind, and it spent the detail
             budget on trees nobody can see: measured at tier 3 while riding,
             94% of LOD1 instances were off screen, the median one sat 81 deg off
             the view axis, and 61% were behind another tree - hit rate onto the
             trees that actually deserved the budget was 9.5%.
             Two penalties, both from quantities already computed here, so this
             costs two smoothsteps per candidate and no extra sampling:
               - off-axis: the chase camera looks down the fall line, so a tree
                 at 80 deg is outside the frustum however close it is. cs is the
                 cosine already used for the view-cone cull.
               - stand depth: the rider is on the piste, so dmin (metres past the
                 corridor edge) is how much forest stands between the camera and
                 this tree - a free occlusion proxy. The front rank reads against
                 the snow; rank 12 is a texture.
             Both only ever SHRINK the effective size, so the thresholds can be
             opened up to buy real detail straight ahead without also handing it
             to the periphery. */
          const ccx = jx - cx, ccz = jz - cz, cdl = Math.hypot(ccx, ccz) || 1;
          const csc = (ccx * fx + ccz * fz) / cdl;   // cosine from the REAL camera
          const de = dist
            * (1 + TREE_LOD.perif * (1 - smoothstep(TREE_LOD.ax0, TREE_LOD.ax1, csc)))
            * (1 + TREE_LOD.deep * smoothstep(TREE_LOD.deep0, TREE_LOD.deep1, dmin));
          const sz = hgt / de;                       // tan(angular height on screen)
          /* hysteresis: widen the threshold a tree has to cross to CHANGE tier,
             and narrow the one it has to cross to KEEP its current tier */
          const _ms = tierSlot(ix, P.iz), _pt = TIER_MEM[_ms] - 1;
          /* ASYMMETRIC on purpose. A symmetric margin also raises the bar to
             ENTER a detail tier, which leaves the LOD1 budget unfilled: measured
             420 -> 269 instances at hyst 0.35, i.e. 151 trees that had earned
             detail were denied it. A flip-flop is a tree GAINING detail and then
             losing it again, so only the exit needs to be sticky.
             MEASURED both ways, and SYMMETRIC won: asym 0.25 keeps all 420 LOD1
             slots filled but only cuts pop energy 15% (83781 -> 74162), while
             sym 0.25 cuts it 33% (-> 55799) and flips 79% (437 -> 92) for 97
             fewer LOD1 instances, all at the small end (median 41.4 -> 44.4 px).
             Isolated pixel cost of that detail loss, same camera/rider/terrain,
             0-px noise floor: 0.287% of the frame. Pop is a TEMPORAL artifact
             the player notices; this is a static difference a fifth of a percent
             in size. It also saves 7% of the triangles. */
          const _h = TREE_LOD.hyst, _hi = TREE_LOD.hystIn;
          const e0 = _pt === 0 ? s0 * (1 - _h) : s0 * (1 + _hi);
          const e1 = (_pt === 0 || _pt === 1) ? s1 * (1 - _h) : s1 * (1 + _hi);
          let li = csc < csCut ? 2 : sz > e0 ? 0 : sz > e1 ? 1 : 2;
          if (li < 2 && cls > 1 - TREE_LOD.dead && P.nL[3] < capD) li = 3;
          TIER_MEM[_ms] = li + 1;
          /* the tier the SIZE THRESHOLDS asked for, before the caps get a say.
             A change with the same liRaw on both passes is cap eviction (the
             budget was full and someone else took the slot); a change where
             liRaw itself moved is threshold churn. They need opposite fixes. */
          const liRaw = li;
          if (li === 0 && P.nL[0] >= cap0) li = 1;
          if (li === 1 && P.nL[1] >= cap1) li = 2;
          const tm = li === 0 ? S.treeA : li === 1 ? S.treeB : li === 3 ? S.treeD : S.treeC;
          const ni = P.nL[li]++;
          tm.setMatrixAt(ni, M);
          // per-instance tint: overall lightness plus a small needle-tone skew
          const t2 = h2(z | 0, x * 3 | 0), t3 = h2(x * 7 | 0, z * 5 | 0);
          tm.setColorAt(ni, C.setRGB(0.80 + t2 * 0.42 - t3 * 0.07, 0.88 + t2 * 0.28, 0.80 + t2 * 0.42 + t3 * 0.09));
          /* Obstacles are scanned linearly every frame by the rider, the
             autopilot and every bot, and the longest look-ahead in the game is
             ~60 m - so registering trees out to nearD (470 m at tier 3) was
             paying O(capN) three ways for nothing. 160 m is still 2.5x the
             longest query. */
          if (dist < 160) {
            const o = P.nO * OBS_S; S.obs[o] = jx; S.obs[o + 1] = jz; S.obs[o + 2] = 0.55 + hgt * 0.035; S.obs[o + 3] = 0;
            /* unit tree geometry has boundingBox.max.y = 0.930; base is yLow-0.10 */
            S.obs[o + 4] = (yLow - 0.10) + hgt * 0.930; P.nO++;
          }
          if (P.rec) P.rec.push(x, z, li, hgt, jx, jz, dist, csc, liRaw);
          P.nN++;
        } else if (P.nF < capF) {
          if (dist > farD * 0.55 && rr > 0.55 * dens) continue;
          if (dist > farD * 0.78 && rr > 0.30 * dens) continue;
          const bf = this.billFit;
          if (bf) {
            const bxz = 0.85 + hh * 0.3;          // same girth jitter the mesh trees get
            M.makeScale(hgt * bf.w * bxz, hgt * bf.h * 0.5, 1);
            M.setPosition(jx, y - 0.10 + bf.y0 * hgt, jz);
          } else {
            M.makeScale(hgt * 0.52, hgt, 1); M.setPosition(jx, y - 0.4 - hgt * 0.035, jz);
          }
          S.treeF.setMatrixAt(P.nF, M);
          /* tier 4 = the far billboard population. It is a SEPARATE branch, not a
             coarser mesh tier, so the LOD2 -> impostor switch is a hard
             `dist < nearD` test with no hysteresis - the prime pop suspect. */
          if (P.rec) {
            const _cx = jx - cx, _cz = jz - cz, _cl = Math.hypot(_cx, _cz) || 1;
            P.rec.push(x, z, 4, hgt, jx, jz, dist, (_cx * fx + _cz * fz) / _cl, 4);
          }
          P.nF++;
        }
      }
      P.iz++;
      if (++rows % 4 === 0 && nowMs() - t0 > budgetMs) return;
    }
    this.commitPlace();
  }
  commitPlace() {
    const P = this.pl, S = this.bak;
    S.treeA.count = P.nL[0];                      // LOD0 casts with its own geometry
    S.treeB.count = P.nL[1];                      // LOD1 casts with its own geometry
                                                  // cascade proxies follow the canopy
    S.treeC.count = S.shC.count = P.nL[2];
    S.treeD.count = S.shD.count = P.nL[3];
    S.treeF.count = P.nF; S.rocks.count = P.nR;
    S.obsN = P.nO;
    for (const k of ['treeA', 'treeB', 'treeC', 'treeD']) { S[k].instanceMatrix.needsUpdate = true; S[k].instanceColor.needsUpdate = true; }
    S.treeF.instanceMatrix.needsUpdate = true;
    S.rocks.instanceMatrix.needsUpdate = true; S.rocks.instanceColor.needsUpdate = true;
    // swap: the finished set becomes visible in one go
    const old = this.cur;
    this.cur = S; this.bak = old;
    for (const k of TREE_KEYS) { S[k].visible = true; old[k].visible = false; }
    this.lastPlace.x = P.px; this.lastPlace.z = P.pz;
    if (P.rec) {
      this.prevRec = this.lastRec;
      /* kpx is captured HERE, not at popJoin time: fov moves with speed, so
         reading it later reports pixel heights under a camera that no longer
         matches the pass being judged. */
      const cssH = G.ren.domElement.clientHeight || G.ren.domElement.height;
      this.lastRec = { px: P.px, pz: P.pz, cx: P.cx, cz: P.cz, nearD: P.nearD, r: P.rec,
        kpx: cssH / (2 * Math.tan(G.cam.fov * 0.5 * Math.PI / 180)) };
      /* Keep the first N passes after arming, indexed. A deterministic replay
         must join a FIXED PAIR: polling for "the last two" can straddle a
         different pair depending on how the poll interval lands, which is
         exactly the non-determinism that made sumHpx incomparable. */
      if (!this.recAll) this.recAll = [];
      if (this.recAll.length < 12) this.recAll.push(this.lastRec);
    }
    this.pl = null;
    this.placeFlags(P.pz);
  }
  placeFlags(pz) {
    const M = this._m;
    let nFl = 0, nPk = 0;
    const s0 = Math.floor(pz / SEG);
    for (let s = s0 - 1; s <= s0 + 2; s++) {
      for (const p of getSeg(s).pr) {
        const park = p.k === 'park';
        if (p.k !== 'flag' && !park) continue;
        const z = p.z; if (z < pz - 60 || z > pz + 420) continue;
        if (park ? nPk >= CAP_PARKM : nFl >= CAP_FLAG) continue;
        const x = park ? pisteC(z) + p.lat : pisteC(z) + p.side * (pisteW(z) + 1.4);
        /* a marker BOARD has a front and it has to face the approaching rider,
           so unlike a pennant it gets a small deterministic jitter instead of
           the z*0.7 spin - which is also what keeps a line of them coherent. */
        M.makeRotationY(park ? Math.sin(z * 1.7) * 0.20 : z * 0.7);
        M.setPosition(x, groundH(x, z) - 0.15, z);
        if (park) { this.parkM.setMatrixAt(nPk, M); nPk++; }
        else { this.flags.setMatrixAt(nFl, M); nFl++; }
      }
    }
    this.flags.count = nFl;
    this.flags.instanceMatrix.needsUpdate = true;
    this.parkM.count = nPk;
    this.parkM.instanceMatrix.needsUpdate = true;
  }

  buildSegGroup(s) {
    const seg = getSeg(s);
    const g = new THREE.Group();
    const own = [], gnd = [], plats = [], cols = [];
    /* PB9: `cols` is shaped exactly like `plats` and for the same reason - a
       prop collider is held per SEGMENT ENTRY so it shares the segment's
       lifetime and eviction keeps it in sync for free. It deliberately does NOT
       go in the World.obs Float32Array: that array is wiped and swapped by
       stepPlace/commitPlace every ~14 m of travel, an unrelated lifetime. */
    /* off = the authored height ABOVE THE ANALYTIC ground, so regroundSegs()
       can re-derive this prop's y from the drawn surface at any time and always
       get the same answer. Storing the raw y instead would make it drift. */
    const mark = (o, x, z) => {
      o.userData.gnd = { x, z, off: o.position.y - terrainH(x, z) };
      gnd.push(o); return o;
    };
    const put = (geo, x, y, z, ry, nm) => {
      const m = new THREE.Mesh(geo, this.matProp);
      m.position.set(x, y, z); if (ry) m.rotation.y = ry;
      if (nm) m.name = nm;
      /* PB4: a building carries a roof-platform descriptor on its geometry.
         Held per SEGMENT ENTRY, so it shares the segment's lifetime exactly and
         cannot outlive the mesh it describes. */
      if (geo.userData && geo.userData.plat) { m.userData.plat = geo.userData.plat; plats.push(m); }
      if (geo.userData && geo.userData.col) { m.userData.col = geo.userData.col; cols.push(m); }
      g.add(m); own.push(geo); return mark(m, x, z);
    };
    for (const p of seg.pr) {
      const z = seg.z0 + (p.z - seg.z0);
      if (p.k === 'lodge') { const q = bestSite(pisteC(z) + p.lat, z, 8.0, 5.2);
        put(lodgeGeo(q.f.drop), q.x, q.f.lo + 0.60 * q.f.drop - 0.2, q.z, p.rot, 'lodge'); }
      else if (p.k === 'cabin') { const q = bestSite(pisteC(z) + p.lat, z, 4.3, 4.7);
        put(cabinGeo(hashStr('c' + s + z), q.f.drop), q.x, q.f.lo + 0.60 * q.f.drop - 0.15, q.z, p.rot, 'cabin'); }
      else if (p.k === 'sign') { const x = pisteC(z) + p.side * (pisteW(z) + 2.5);
        const m = put(signGeo(p.kind), x, terrainH(x, z) - 0.1, z, p.side * 0.4, 'sign');
        /* the textured panel rides as a CHILD, so it inherits the post's
           transform and regroundSegs() keeps moving both from one entry */
        const pg = signPanelGeo(p.kind, p.side);
        m.userData.sign = { kind: p.kind, side: p.side };   // lets a probe grade the chevron
        m.add(new THREE.Mesh(pg, this.matSign)); own.push(pg); }
      else if (p.k === 'parkboard') {
        /* one mesh, matSign: panel cell + swatch-sampled structure (see
           parkBoardGeo), so a site is a single draw call */
        /* at the piste EDGE like a trail sign, never at p.lat: the corridor is
           11-19 m wide here, so a lat-based board could stand in the middle of
           the run. side keeps it beside the marker line at any width. */
        const x = pisteC(z) + p.side * (pisteW(z) + 2.2), bg = parkBoardGeo(p.kind);
        const m = new THREE.Mesh(bg, this.matSign);
        m.position.set(x, terrainH(x, z) - 0.05, z);
        m.rotation.y = Math.sin(z * 0.9) * 0.13;
        m.name = 'parkboard';
        g.add(m); own.push(bg); mark(m, x, z);
        if (bg.userData.col) { m.userData.col = bg.userData.col; cols.push(m); }   // PB9: not via put()
      }
      else if (p.k === 'gate') { const x = pisteC(z), y0 = terrainH(x, z); const gr = gateGroup(dx => terrainH(x + dx, z) - y0); gr.position.set(x, y0, z); g.add(gr); mark(gr, x, z);
        /* PB9: the two start-gate posts are solid. 0.5 m square at x = +-13.5,
           i.e. 27 m apart on the piste centreline, so they are nowhere near the
           natural line - but they are the biggest object in the game and riding
           through one looked absurd. The 24 m banner overhead stays a banner. */
        gr.userData.col = pcMake('gate', [pcBox(0.25, 0.25, 6.6, -13.5, 0), pcBox(0.25, 0.25, 6.6, 13.5, 0)]);
        cols.push(gr); }
      else if (p.k === 'rocks') {
        for (let i = 0; i < p.n; i++) {
          const x = pisteC(z) + p.lat + (i - p.n / 2) * 3.2, zz = z + (i % 2) * 2.5;
          const sc = 1.1 + (i % 3) * 0.8;
          const m = put(rockGeo(hashStr('r' + s + i)), x, terrainH(x, zz) - sc * 0.3, zz, i * 1.7, 'rock');
          m.scale.set(sc * 1.2, sc * 0.8, sc);
          /* PB9: THESE ROCKS HAD NO COLLISION AT ALL. Only the procedurally
             streamed boulders were registered in `obs`, so "rocks collide" was
             two-thirds true and a whole class of rock was a ghost. Same radius
             and same top as a streamed boulder of this size (see the obs write
             at the rock branch of stepPlace) so both kinds now feel identical.
             World metres, because the query ignores mesh scale. */
          m.userData.col = pcMake('rock', [pcCyl(0, 0, sc * 0.95, sc * 1.05)]);
          cols.push(m);
        }
      }
      else if (p.k === 'lift') {
        const lat = p.lat;
        const gr = liftGroup(seg.z0 + 10, zz => pisteC(zz) + lat);
        g.add(gr); this.ticks.push(gr.userData.tick);
        gr.userData._tick = gr.userData.tick;
        if (gr.userData.col) cols.push(gr);        // PB9: the 13 towers
        /* PB9b: each terminal shed is an anchor carrying BOTH a flat roof
           platform and a wall box - see the comment in liftGroup for why the
           lift group itself cannot be the query frame. */
        for (const a of (gr.userData.terms || [])) { plats.push(a); cols.push(a); }
      }
    }
    // park rails & boxes
    for (const f of seg.ft) {
      if (f.t === 4 && f.prop) {
        const zc = (f.z0 + f.z1) / 2, len = f.z1 - f.z0;
        const x = featCenter(f, zc);
        /* the deck stands on the pad: sample the snow just beside it, clear of its own solid top */
        const off = f.w + 2.0;
        const gnd = z => { const c = featCenter(f, z); return (terrainH(c - off, z) + terrainH(c + off, z)) * 0.5; };
        const yA = gnd(f.z0 + 0.5), yB = gnd(f.z1 - 0.5);
        const m = put(railGeo(len, f.w, f.hgt, f.rail), x, (yA + yB) / 2, zc, 0, f.rail ? 'rail' : 'box');
        m.rotation.x = Math.atan2(yA - yB, len);      // lie along the fall line
      }
    }
    return { g, own, gnd, plats, cols };
  }
  /* PB9: solid-prop query, see propHitIn in props_col.js. Same shape as platAt. */
  propHit(x, z, y, R, out) { return propHitIn(this.segGroups, x, z, y, R, out); }

  updateSegs(pz) {
    const s0 = Math.floor(pz / SEG);
    for (let s = s0 - 1; s <= s0 + 3; s++) {
      if (!this.segGroups.has(s)) {
        const e = this.buildSegGroup(s);
        this.scene.add(e.g);
        this.segGroups.set(s, e);
      }
    }
    for (const [s, e] of this.segGroups) {
      if (s < s0 - 2 || s > s0 + 4) {
        this.scene.remove(e.g);
        for (const geo of e.own) geo.dispose();
        e.g.traverse(o => { if (o.userData._tick) this.ticks = this.ticks.filter(t => t !== o.userData._tick); });
        this.segGroups.delete(s);
      }
    }
  }

  /* ---- PB4: building roofs are ONE-WAY PLATFORMS ----------------------
     Returns the roof surface under (x,z) if the rider is at or above it, else
     null. ONE-WAY is the whole design: engaging only from above means the walls
     stay non-solid, so riding into a cabin at snow level behaves exactly as it
     always has and this change cannot put an invisible wall on the piste.
     `tol` is the caller's tunnelling allowance and must scale with fall speed;
     the caller passes a larger one while already on a roof, so a ridge crossing
     or a bump cannot drop you through.
     The height is read from the CURRENT mesh position, so regroundSegs() moving
     a building every frame moves its roof with it for free. */
  platAt(x, z, y, tol, out) {
    let hit = null;
    for (const [, e] of this.segGroups) {
      for (const o of e.plats) {
        const P = o.userData.plat, dx = x - o.position.x, dz = z - o.position.z;
        if (Math.abs(dx) + Math.abs(dz) > P.hx + P.hz) continue;
        const a = o.rotation.y, ca = Math.cos(a), sa = Math.sin(a);
        const lx = ca * dx - sa * dz, lz = sa * dx + ca * dz;   // world -> building local
        if (Math.abs(lx) > P.hx || Math.abs(lz) > P.hz) continue;
        const h = o.position.y + P.base + (1 - Math.min(1, Math.abs(lx) / P.half)) * P.rise;
        if (y < h - tol) continue;                  // under the roof: not a platform
        if (hit && h <= out.h) continue;            // overlapping roofs: take the higher
        const sl = lx > 0 ? P.sl : lx < 0 ? -P.sl : 0, iv = 1 / Math.hypot(sl, 1);
        out.h = h; out.nx = ca * sl * iv; out.ny = iv; out.nz = -sa * sl * iv;
        out.o = o; hit = out;
      }
    }
    return hit;
  }

  /* buildSegGroup() runs ONCE per segment, hundreds of metres ahead, where the
     drawn surface is still coarse - so a segment prop cannot be grounded at
     build time the way a re-placed instance (tree, rock, flag) can. Snap it to
     the drawn surface once it is inside the fine band instead. Idempotent. */
  regroundSegs() {
    const t = G.terr; if (!t || !t.meshAt) return;
    for (const [, e] of this.segGroups) {
      if (!e.gnd) continue;
      for (const o of e.gnd) {
        const q = o.userData.gnd;
        if (t.meshAt(q.x, q.z, _gm)) o.position.y = _gm.h + q.off;
      }
    }
  }

  update(px, pz, t) {
    /* Sliced at 3 ms so a pass never spikes a frame. NOTE the next pass can only
       begin once this one commits, so on a slow machine passes trigger LATER in
       world space - that is wall-clock dependence a pinned timestep cannot
       remove, and it is why the pop census was not reproducible. dbg.placeBudget
       (set by the deterministic replay) makes each pass complete in the frame it
       is stepped, so trigger positions depend only on the rider path. Pass
       CONTENT is identical either way; only the slicing changes. */
    if (this.pl) this.stepPlace(G.dbg.placeBudget || 3.0);
    else {
      const vd = G.cam.getWorldDirection(_wd);
      const turned = (vd.x * this.lastFwd.x + vd.z * this.lastFwd.z) /
        (Math.hypot(vd.x, vd.z) || 1) < 0.93;            // ~21 deg of view swing
      if (turned || Math.abs(px - this.lastPlace.x) > 14 || Math.abs(pz - this.lastPlace.z) > 16) this.beginPlace(px, pz);
    }
    this.updateSegs(pz);
    this.regroundSegs();
    for (const fn of this.ticks) fn(t);
  }
}
