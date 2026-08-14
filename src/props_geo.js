/* ------------------------------------------------- object material + geo */
let WU = null; // world uniforms, set in main
/* Scale for the LINEAR-radiance encoding used when a material is rendered into
   a bake target instead of to the screen (see uRaw). 8-bit RT + sqrt encode, the
   same trick the sky bake uses: no float render target, so no EXT_color_buffer_
   float dependency and no iOS risk, and a tree's linear radiance never exceeds
   about 1.8 (albedo 1.15 x sun 1.55) so 4.0 has headroom to spare. */
const IMP_HDR = 4.0;

function objMat(o = {}) {
  const u = Object.assign({}, WU, {
    /* uRaw = 1 makes this material write LINEAR radiance, sqrt-encoded, instead
       of a finished display pixel. Set it around a bake and restore it after.
       WHY THIS EXISTS: treeImpostor bakes the far-tree atlas with THIS material,
       and outc() is ACES + gamma. The atlas therefore held display pixels, and
       matBill then squared them (undoing the gamma but NOT the ACES) and ran
       outc() a SECOND time. ACES has a gain of about 1.5 on midtones, so a
       double application lifts and flattens them: measured against the LOD0 mesh
       it was baked from, at the same on-screen size, the billboard read L +16 and
       2.7x the snow fraction. Same class of bug as the sky bake before it stored
       linear HDR. A bake must store RADIANCE; only the final pass may tonemap. */
    uRaw: { value: 0 },
    uSpec: { value: o.spec ?? 0.0 }, uWrap: { value: o.wrap ?? 0.3 },
    uEmis: { value: o.emis ?? 0.0 }, uFade: { value: 1.0 }, uBill: { value: o.bill ? 1 : 0 },
    /* Ambient fill fraction. 0.55 is right for an isolated convex prop, but a
       conifer canopy self-occludes: measured on the v2 hero tree, the non-snow
       pixels averaged sRGB (95,118,132) - a light BLUE-grey, blue-dominant,
       because 0.55 of a (0.26,0.42,0.74) sky was drowning the needle albedo.
       A real snow-laden spruce reads near-black green in its gaps. */
    uAmb: { value: o.amb ?? 0.55 },
    /* Ambient fill for SNOW, as opposed to needles/bark. Defaults to uAmb so
       every other caller is bit-identical.
       MEASURED w3: with one ambient for the whole mesh, the single most common
       colour over an LOD0 tree's silhouette was sRGB (80,104,144) at 20% of its
       pixels - slate BLUE at luminance 102 - and it was SNOW. A snow face turned
       away from the sun gets nothing but uAmb*uSkyCol, and uSkyCol is
       (0.26,0.42,0.74) at 0.30, so 27.7% snow-white VERTICES rendered as blue
       slate no matter how white their albedo. That is most of why wave 2 read as
       a black tree with grey wedges.
       The split is physically right, not a fudge: a needle is opaque and
       self-shaded inside a canopy (which is why uAmb is only 0.30), whereas snow
       is a deep multiple-scattering medium sitting on a snowfield, so its
       ambient response is several times stronger and much less blue. Needles and
       snow are separable with no extra attribute and no extra draw call, because
       the albedo itself is the discriminator: snow is >0.6 linear, every needle
       colour is under 0.07. */
    uAmbS: { value: o.ambS ?? o.amb ?? 0.55 },
    /* Wrap for SNOW. Also defaults to the needle value, so no other caller
       changes. Snow is a deep scattering medium - the terrain shader already
       models loose snow with wrap 0.62 - so a mass lit from the side still
       glows well round toward its shaded flank, whereas an opaque needle does
       not. Without this the ENTIRE shaded half of every tree rendered as blue
       slate at luminance ~147 with B-R 30 (measured), because ndl collapses to
       zero there and the only light left is the blue sky ambient. With it the
       shaded flank picks up warm sun and lands near-neutral, which is what makes
       both sides of the reference tree read as snow. */
    uWrapS: { value: o.wrapS ?? o.wrap ?? 0.3 }
  });
  const m = new THREE.ShaderMaterial({
    uniforms: u, side: o.side || THREE.FrontSide, transparent: false,
    vertexShader: `
      attribute vec3 color;
      varying vec3 vC, vN, vW;
      uniform float uBill; uniform vec3 uSun;
      void main(){
        #ifdef USE_INSTANCING
          mat4 im = instanceMatrix;
        #else
          mat4 im = mat4(1.0);
        #endif
        vec4 lp = vec4(position,1.0);
        vec3 nn = normal;
        if(uBill > 0.5){
          vec3 org = (im*vec4(0.0,0.0,0.0,1.0)).xyz;
          vec3 wo = (modelMatrix*vec4(org,1.0)).xyz;
          vec3 toCam = cameraPosition - wo; toCam.y = 0.0;
          vec3 r = normalize(vec3(toCam.z,0.0,-toCam.x));
          vec3 sc = vec3(length(vec3(im[0].xyz)), length(vec3(im[1].xyz)), 1.0);
          vec3 wp = wo + r*position.x*sc.x + vec3(0.0,position.y*sc.y,0.0);
          vC = color; vN = normalize(vec3(r.z*0.0,0.55,0.0)+normalize(toCam)*0.6); vW = wp;
          gl_Position = projectionMatrix*viewMatrix*vec4(wp,1.0);
          return;
        }
        vec4 wp = modelMatrix*im*lp;
        vC = color;
        #ifdef USE_INSTANCING_COLOR
          vC *= instanceColor;
        #endif
        vN = normalize(mat3(modelMatrix)*(mat3(im)*nn));
        vW = wp.xyz;
        gl_Position = projectionMatrix*viewMatrix*wp;
      }`,
    fragmentShader: GLSL_COMMON + GLSL_CASCADE + `
      uniform float uSpec, uWrap, uEmis, uFade, uAmb, uAmbS, uWrapS, uRaw;
      varying vec3 vC, vN, vW;
      void main(){
        vec3 N = normalize(vN);
        vec3 vd = normalize(vW - cameraPosition);
        float dist = length(vW - cameraPosition);
        /* snow vs needle, straight off the albedo - see uAmbS. sn is 0 for every
           needle, bark and rock colour (all under 0.07 linear) and 1 for snow
           geometry (over 0.6), so a mesh that has no snow in it is unaffected. */
        float sn = smoothstep(0.22, 0.62, dot(vC, vec3(0.2126,0.7152,0.0722)));
        float wr = mix(uWrap, uWrapS, sn);
        float ndl = max((dot(N,uSun)+wr)/(1.0+wr),0.0);
        vec3 amb = mix(uGndCol, uSkyCol, N.y*0.5+0.5);
        /* and snow's ambient is much less blue than a needle's: multiple
           scattering inside the pack plus bounce off the snowfield washes the
           sky tint out, so desaturate toward its own mean as sn rises */
        amb = mix(amb, mix(amb, vec3(dot(amb, vec3(0.3333))), 0.55), sn)
              * mix(uAmb, uAmbS, sn);
        /* trees and rocks sit in the same cascades as the snow, so a trunk in
           the shade of the canopy in front of it actually goes dark */
        float sh = sunShadow(vW, N, dist);
        vec3 col = vC*(uSunCol*ndl*(1.0-0.85*sh) + amb) + vC*uEmis;
        if(uSpec > 0.001){
          vec3 hv = normalize(uSun - vd);
          col += uSunCol*pow(max(dot(N,hv),0.0), 60.0)*uSpec;
        }
        /* bake path: store radiance, never a display pixel. No fog either - the
           consumer is at a different distance than the bake camera was. */
        if(uRaw > 0.5){ gl_FragColor = vec4(sqrt(max(col,0.0)/float(${IMP_HDR})),1.0); return; }
        col = applyFog(col, dist, vd);
        gl_FragColor = vec4(outc(col),1.0);
      }`
  });
  return m;
}

/* ---- geometry helpers ---- */
function geoColor(g, fn) {
  g = g.index ? g.toNonIndexed() : g;
  const p = g.attributes.position, n = g.attributes.normal;
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const col = fn(p.getX(i), p.getY(i), p.getZ(i), n ? n.getY(i) : 1, i);
    c[i * 3] = col[0]; c[i * 3 + 1] = col[1]; c[i * 3 + 2] = col[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
function mergeGeos(list) {
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    const p = g.attributes.position.array, n = g.attributes.normal.array, c = g.attributes.color.array;
    pos.set(p, o * 3); nor.set(n, o * 3); col.set(c, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}
const xf = (g, m) => { g.applyMatrix4(m); return g; };
const MT = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const flat = c => () => c;
const cmul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const cmix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/* ---- triangle-soup builder -------------------------------------------------
   Flat normals, per-vertex colour, non-indexed - the same shape mergeGeos
   wants. Winding is (a,b,c) counter-clockwise as seen from the FRONT, and the
   normal is the cross product of that same winding, so a face can never end up
   lit from the wrong side (the LatheGeometry inside-out trap). */
function TriBuf() { return { p: [], n: [], c: [] }; }
const _tqa = new THREE.Vector3(), _tqb = new THREE.Vector3(), _tqn = new THREE.Vector3();
function pushTri(B, a, b, c, ca, cb, cc) {
  _tqa.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  _tqb.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  _tqn.crossVectors(_tqa, _tqb);
  const l = _tqn.length();
  if (l > 1e-12) _tqn.multiplyScalar(1 / l); else _tqn.set(0, 1, 0);
  B.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  B.n.push(_tqn.x, _tqn.y, _tqn.z, _tqn.x, _tqn.y, _tqn.z, _tqn.x, _tqn.y, _tqn.z);
  cb = cb || ca; cc = cc || ca;
  B.c.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
}
/* ---- winding helpers: state which way is OUT, don't guess the vertex order --
   `pushTri` derives its normal from the winding and every prop material is
   FrontSide, so a backwards face is INVISIBLE, lights from the wrong side, and
   is completely silent - it builds, it loads, nothing logs. That shipped in
   FOUR places at once (the rail bar and its foot drifts, both chairlift bull
   wheels, the sign's and marker's plate rims, and every prop's base drift:
   Alexander's "the rail has no top face"), all found by
   `.bcode/agent-workspace/prop_mesh_qa.mjs` - per-component signed volume for
   closed parts, a ray-parity test plus centroid-outward for open shells.
   Pass the OUTWARD direction (it only needs the right sign, not unit length)
   and these pick the order. Use them for any hand-wound quad or fan. */
const UP = [0, 1, 0], DOWN = [0, -1, 0], LEFT = [-1, 0, 0], RIGHT = [1, 0, 0];
const FRONT = [0, 0, -1], BACKW = [0, 0, 1];   /* the rider rides toward +z, so -z faces them */
function _windOK(a, b, c, ref) {
  _tqa.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  _tqb.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  _tqn.crossVectors(_tqa, _tqb);
  return _tqn.x * ref[0] + _tqn.y * ref[1] + _tqn.z * ref[2] >= 0;
}
function pushTriO(B, a, b, c, ref, col) {
  if (_windOK(a, b, c, ref)) pushTri(B, a, b, c, col); else pushTri(B, a, c, b, col);
}
function pushQuadO(B, a, b, c, d, ref, col) {
  if (_windOK(a, b, c, ref)) { pushTri(B, a, b, c, col); pushTri(B, a, c, d, col); }
  else                       { pushTri(B, a, d, c, col); pushTri(B, a, c, b, col); }
}
function bufGeo(B) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(B.p), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(B.n), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(B.c), 3));
  return g;
}
const triCount = g => g.attributes.position.count / 3;

/* ---- a snow-laden conifer --------------------------------------------------
   The snow is real geometry, not a white vertex-colour lerp:

     * each tier is a ragged double fan (alternating long tip spokes and short
       notch spokes) that droops with branch length, wider and flatter low
       down, tight and upright at the top. Upper face frosted needle green,
       under face dark blue-green - that is the "foliage depth" read.
     * whorl Y spacing is SOLVED (see the overlap solve below) so that every
       whorl's drooping rim reaches past the apex of the whorl beneath it. A
       conifer crown has no sky-visible gaps between whorls, and a stack of
       separated discs is the loudest "procedural" tell there is. Overlap also
       hides the trunk, which is a gap problem and not a bark-colour problem.
     * snow lumps are separate closed pillows placed OUT along a tip spoke
       (radial fraction 0.45-0.95, i.e. toward the tips where snow actually
       piles), embedded into the branch surface analytically so they never
       float, with a drooping outer lip that overhangs the rim and casts the
       thin dark line the reference photo shows under every pillow. Many small
       pillows, never a few big tetrahedra.
     * a small snow collar sits near the stem on the upper tiers, a cap on the
       spire, and a mound skirts the foot.

   COLOUR RULE (this was the bug that made the whole far forest white): the
   dusting on NEEDLES lerps toward CONIF.frost, a cold desaturated blue-grey
   well under the ~0.3 albedo ceiling. Only actual snow GEOMETRY uses
   CONIF.snow (~1.0 linear). Frosting and whiteness are separate knobs: a
   forest at 300 m reads only as a dark mass against snow, so a needle colour
   that resolves near 1.0 makes 1000 trees disappear.

   Unit tree: 1.0 tall, canopy tip radius ~= rMax (0.34). All variation is
   seeded; the LOD builds come out of the same function (see TREE_LOD_GEO),
   and the true tip radius is stamped on geo.userData.rTip so the cascade
   shadow proxy in props_world can never drift from it. */
/* MEASURED, v2 -> v3. The v2 hero tree rendered with non-snow pixels averaging
   sRGB (95,118,132): too light by ~2 stops AND blue-dominant, i.e. the needle
   mass read as pale sage/blue-grey instead of the near-black green of the
   reference. Two causes, both fixed here: `frost` at 0.30 linear was BRIGHTER
   than nmid so a dusted spoke became the dominant tone, and ndark/frost were
   both blue-dominant (B > G). Every needle colour below is now green-dominant
   and under 0.15 linear, which is where a saturated colour has to sit to
   survive the ACES shoulder (see the palette rule in AGENTS.md). */
const CONIF = {
  bark: [0.048, 0.042, 0.040],        // neutral cold grey-brown, not chocolate
  /* v4 -> v5, MEASURED: with the hue fixed the needle population still rendered
     at mean luminance 128 sRGB against snow at 218, i.e. a mid-tone sage where
     the reference has a near-black mass. ACES is compressive here (output moves
     roughly as albedo^0.45), so hitting ~90 needed a 0.46x cut in LINEAR
     albedo, not a small nudge. 0.046 green is also the physically right number:
     a needle is ~12% reflective but a CANOPY with its own self-shadowing and
     sky gaps is ~5%, and we have no per-needle AO to produce that for us - so
     the occlusion is baked into the albedo where it belongs. */
  /* v5 -> w3, MEASURED: at 0.0119 luminance ndark rendered the whole under-tier
     population at sRGB (8,10,9), i.e. actually black, and since ndark is what
     LOD2 is almost entirely made of it also pinned the distant forest at mean
     vertex luminance 0.023 - a black band, where the reference mountain has a
     dark blue-GREY one. Lifted 3.1x to 0.0369 and given a cold cast (B just
     over R) because a canopy underside over a snowfield is lit by ground bounce
     and sky, never by the sun. Still 27x darker than snow, so the far-forest
     value contrast that wave 2 won is untouched. */
  /* w3 -> T3 (2026-08-01), COOL SEPARATION. MEASURED against
     uploads/mountain_render.jpeg, and the first measurement was misleading: the
     reference forest reads R 80.8 / G 115.2 / B 141.4 (B-R +60.6) against our
     R 96.8 / G 107 / B 123.3 (B-R +26.4), which looks like a 2.3x chroma
     deficit. But the reference's own SNOW is B-R +29.6 (its sunlit peak +47.9)
     where ours is +12.3 - most of that gap is a GLOBAL blue GRADE on an
     overcast photo, and we are a warm-sun bluebird scene. The grade-invariant
     quantity is the tree-vs-snow separation in the SAME frame: reference
     +31.0 (B-R) / +14.1 (G-R), shipped +14.4 / +4.6. That is the real deficit
     and it is a tree job. Now +31.7 / +12.0.
     Two rules came out of the tuning. (1) LOWER RED, do not raise green: R is
     21% of luminance and B only 7%, so trading R for B buys cool separation
     almost free, while raising G (72%) would brighten the forest and undo the
     wave-2/w3 value work. Every colour below is luminance-matched to within
     ~1% of what it replaced and the rendered tree luminance percentiles are
     UNCHANGED (p25/p50/p75 = 72/99/148, identical to shipped).
     (2) The SNOW PAINT is the dominant lever, not the needles - it outweighed
     all four needle colours combined (+19.8 vs +16.7 of separation) because it
     covers most of the tree's pixels. It is also physically right: canopy snow
     is shaded by the needles above it and lit by the SKY (uSkyCol 0.26/0.42/
     0.74), not by the warm sun (1.55/1.22/0.86), and this tree has no
     per-needle AO to produce that for us - so the sky cast is baked into the
     albedo exactly where the w3 comment already bakes in the occlusion. */
  ndark: [0.012, 0.039, 0.076],       // canopy underside: cold, dark, NOT black
  nmid: [0.004, 0.049, 0.058],        // needle mass, now cyan-green not sage
  ntip: [0.009, 0.069, 0.072],        // sunlit tips
  frost: [0.019, 0.059, 0.092],       // FROSTED NEEDLES - a dusting, never CONIF.snow
  snow: [0.90, 1.07, 1.34],           // sky-lit canopy snow; still exceeds 1.0
  /* SNOW FLANK / RIM, MEASURED w3. These were 0.78/0.42 luminance 0.84/0.48 -
     which is why 27.7% of LOD0's vertices were snow-white and yet the rendered
     tree showed no white: from a horizontal eye you see a pillow's FLANK and
     RIM, never its top facet, and a 0.48-albedo rim shaded by a down-facing
     normal came out sRGB ~120 - a slate-blue wedge. A snow surface standing on
     a snowfield gets an enormous ground bounce; it is genuinely near-white on
     every face, and the shape has to be carried by the NORMAL, not by making
     the underside dark. */
  /* The flank and rim MUST be cooled by the same per-channel factors as `snow`
     above (they were 0.843x / 0.745x of it and still are), or the mass reads
     inconsistently - a warm rim under a cool cap. Measured with the family
     cooled together, which is what ships: separation +30.9 -> +31.7. */
  snowMid: [0.76, 0.92, 1.17],        // the flank of a snow mass is still snow
  snowLow: [0.67, 0.83, 1.07]         // and so is its overhanging rim
};
/* ~5% of the forest: last year's dead standing spruce. Grey-brown needles,
   same silhouette family so it does not read as a different species.
   w3: lifted out of black (ndark was luminance 0.0083, i.e. a black skeleton)
   and it now carries snow like everything else - a dead spruce in a blizzard is
   one of the WHITEST things on a mountain, because there are no needles to shed
   it. Kept warm-grey so it still reads as a different individual. */
const CONIF_DEAD = {
  ndark: [0.036, 0.034, 0.033],
  nmid: [0.030, 0.026, 0.021],
  ntip: [0.042, 0.037, 0.029],
  frost: [0.062, 0.060, 0.062]
};
const TREE_RMAX = 0.34;

/* Radius profile. CONVEX, not the old near-straight taper: a belly around 20%
   of the height then a fast taper into the leader. Normalised so its peak is
   exactly 1 and rMax stays the honest canopy half-width. */
const _profRaw = t => Math.pow(1 - t, 0.75) * (0.78 + 0.22 * smoothstep(0, 0.34, t));
const _PROF_PK = (() => { let m = 0; for (let i = 0; i <= 200; i++) { const v = _profRaw(i / 200); if (v > m) m = v; } return m; })();
const coniferProf = t => _profRaw(t) / _PROF_PK;

function coniferGeo(o = {}) {
  const P = Object.assign({
    seed: 21,
    tiers: 13, spokes: 13,      // rim points per tier = spokes * 2 (tip, notch, ...)
    lumps: 54,                  // branch snow masses
    lumpSides: 6, lip: true, collars: true, spireCap: true,
    moundSides: 9, moundR: 0.125,
    trunk: true, trunkRad: 6, trunkY: 1,
    spire: true, spireRad: 6,
    snowPaint: 0.42,            // frost dusting on the exposed needles (-> CONIF.frost)
    /* snowFace: how much of each whorl's UPPER face is painted actual snow
       white. The reference tree is snow-DOMINANT (v2 measured only 41.5% snow
       pixels over the hero tree), and a whorl top is exactly the surface that
       holds a mantle - but geometry pillows cost 24 tris each, so paint carries
       the coverage and the pillows carry the silhouette. Weighted DOWN with
       radial extent so the drooping tips stay dark needle: that is the
       white-mantle-over-dark-fringe read the photo has.
       MUST stay 0 on LOD2/far tiers - a far forest that resolves near 1.0
       disappears against the snowfield (that was the v1 bug). */
    snowFace: 0,
    /* snowCore: the whorl APEX only - the innermost, flattest, most sheltered
       point of the upper face, and the deepest snow on a real loaded spruce.
       Split out of snowFace in w3 because the two want opposite things at the
       coarse LODs: LOD2 needs visible snow FLECKING (the reference distant
       forest is dark grey-blue with white specks, not a black band) but must
       keep its rim dark or 3,900 far instances brighten and the forest melts
       into the snowfield, which was the wave-1 bug. Apex-only whitening is
       exactly that: a small bright core inside every dark whorl.
       Defaults to snowFace*0.68 so the fine LODs behave as before. */
    snowCore: null,
    snowLoad: 0.55, droop: 1,
    notch: 0.58,                // short-spoke length: low = ragged, high = full
    jit: 0.25,                  // per-spoke length jitter, +-fraction
    olap: 0.82,                 // whorl overlap: <1 guarantees no sky gap
    gMax: 2.0,                  // ceiling on the droop gain the overlap solve may ask for
    tMax: 0.94,                 // profile cutoff so the top whorl is not degenerate
    tPow: 1,                    // <1 spreads few whorls evenly along the profile
    pal: null,
    rMax: TREE_RMAX, top: 0.93
  }, o);
  const C = P.pal ? Object.assign({}, CONIF, P.pal) : CONIF;
  const snowCore = P.snowCore == null ? P.snowFace * 0.68 : P.snowCore;
  const rnd = mulberry32((P.seed * 2654435761) >>> 0);
  const rr = (a, b) => a + (b - a) * rnd();
  const B = TriBuf();
  const T = P.tiers, N = P.spokes, M = N * 2;

  /* ---- branch tiers ---- */
  const yTopT = P.top - 0.072;
  const radA = [], tA = [];
  for (let i = 0; i < T; i++) {
    const t = T > 1 ? i / (T - 1) : 0;
    tA.push(t);
    /* tPow only matters where whorls are scarce: with 4 tiers a linear t lands
       two of them on the near-flat belly of the profile and the tree reads as
       a stack of lozenges instead of a cone. It samples the SAME curve, so the
       coarse LODs keep the fine LOD's silhouette. */
    radA.push(P.rMax * 0.92 * coniferProf(Math.pow(t, P.tPow) * P.tMax) * rr(0.96, 1.04));
  }
  /* A whorl covers rise+droop vertically, both proportional to its own radius,
     so a build with FEWER tiers spread over the same 0.93 m has to droop
     harder or the crown opens up again at the coarse LODs. Clamped: at T=4 the
     old exponent asked the bottom whorl to droop 0.25 units, i.e. 2.5 m below
     its own root on a 10 m tree. */
  const cov = clamp(Math.pow(7 / T, 0.42), 0.82, 1.22);
  const riseOf = i => radA[i] * 0.22 * cov + 0.010;
  const droop0 = i => radA[i] * (0.56 - 0.28 * tA[i]) * P.droop * cov;

  /* ---- the overlap solve ----
     Whorl i must not leave a sky gap above whorl i-1, i.e.
         y[i] - droop[i]  <  y[i-1] + rise[i-1].
     Set the step to dy[i] = ol*(rise[i-1] + droop[i]) with ol < 1 and that
     inequality holds by construction with margin (1-ol). The steps must also
     sum to the span, so solve for either a droop gain g (crown too tall for
     its droop) or a tighter ol (crown already more than closed). Because
     rise and droop both scale with radius, and radius collapses into the
     leader, the spacing compresses toward the top for free - which is what
     the reference crown does.
     The droop gain g is CAPPED: at 4 whorls the unconstrained solve asked for
     g=3, i.e. a bottom whorl hanging 0.62 below its own node (6 m under the
     snow on a 10 m tree). When g caps out the steps simply share the span and
     the coarse LOD accepts a gap - that is the honest trade at 250 m. The base
     is lifted by a BOUNDED fraction of the bottom droop so its tips rest on
     the snow; bounded because span feeds back into g, and an unbounded lift
     diverges (it once pushed the whole LOD2 crown up to y 0.54). */
  let sR = 0, sD = 0;
  for (let i = 1; i < T; i++) { sR += riseOf(i - 1); sD += droop0(i); }
  let g = 1, ol = P.olap, yBot = 0.098;
  for (let it = 0; it < 4; it++) {
    const span = Math.max(0.02, yTopT - yBot);
    g = (T > 1 && sD > 1e-6) ? clamp((span / P.olap - sR) / sD, 1, P.gMax) : 1;
    ol = (sR + g * sD) > 1e-6 ? span / (sR + g * sD) : 1;
    yBot = clamp(0.098 + droop0(0) * g * 0.62, 0.098, 0.26);
  }

  const tiers = [];
  let rTip = 0, yPrev = yBot;
  for (let i = 0; i < T; i++) {
    const t = tA[i], rad = radA[i];
    const droop = droop0(i) * g;
    const rise = riseOf(i);
    const y = i === 0 ? yBot : yPrev + ol * (riseOf(i - 1) + droop);
    yPrev = y;
    const ph = rnd() * TAU;
    const rim = [];
    for (let j = 0; j < M; j++) {
      const a = ph + (j / M) * TAU + (rnd() - 0.5) * (TAU / M) * 0.34;
      const tip = (j & 1) === 0;
      /* Raggedness comes from MANY SMALL random deviations, not one big
         alternating long/short pattern - 7 spokes on a hard 0.42 notch read as
         7 kite blades, i.e. a fern. */
      const f = tip ? 0.94 * rr(1 - P.jit, 1 + P.jit * 0.72)
                    : P.notch * rr(1 - P.jit * 0.6, 1 + P.jit * 0.6);
      const r = rad * f;
      if (r > rTip) rTip = r;
      rim.push({
        a, f, tip, r,
        y: Math.max(0.008, y - droop * Math.pow(f, 1.45) + (rnd() - 0.5) * rad * 0.07),
        sn: clamp(P.snowPaint * rr(0.25, 1.7), 0, 1)
      });
    }
    tiers.push({ t, y, rad, rim, yA: y + rise, yL: Math.max(0.002, y - 0.012 - rad * 0.05) });
  }
  // no separate spire cone: the top whorl's apex becomes the leader tip
  if (!P.spire && T > 0) tiers[T - 1].yA = P.top;
  /* the leader cone, solved here rather than at build time because the spire
     CAP has to fit inside it and the cap is emitted with the rest of the snow */
  const spB = tiers[T - 1].y - radA[T - 1] * 0.35;
  const spH = Math.max(0.05, P.top - spB);
  const spR = Math.max(P.rMax * 0.045, radA[T - 1] * 0.72);

  const vp = p => [p.r * Math.sin(p.a), p.y, p.r * Math.cos(p.a)];
  for (const S of tiers) {
    /* the whorl apex is the innermost point of the upper face - flat, sheltered
       and, on a loaded spruce, the deepest snow on the whole branch */
    const apexC = cmix(cmul(C.ndark, 0.62 + 0.38 * S.t),
      cmul(C.snow, 0.90 + 0.10 * S.t), clamp(snowCore * (0.56 + 0.34 * S.t), 0, 0.97));
    const lowC = cmul(C.ndark, 0.55 + 0.32 * S.t);
    /* mantle mask: strong near the axis, gone by the tips, modulated by the
       same per-spoke noise that drives the frost so a whole spoke can be bare */
    const faceSn = p => clamp(P.snowFace * (1.00 - 0.86 * p.f) * (0.50 + 1.35 * p.sn), 0, 0.97);
    const upC = p => cmix(cmix(
      cmix(cmul(C.nmid, 0.62 + 0.38 * S.t), C.ntip, clamp(p.f * 0.8, 0, 1)),
      cmul(C.frost, 0.86 + 0.24 * S.t), p.sn),
      cmul(C.snow, 0.92 + 0.08 * S.t), faceSn(p));
    /* Nothing in a snowfield is black. The old floor bottomed out near 0.21x a
       near-black ndark, which rendered under-tier faces as pure black wedges
       that read as holes in the mesh. */
    const rimLow = p => cmul(C.ndark, clamp((0.58 + 0.42 * p.f) * (0.62 + 0.38 * S.t), 0.40, 1.2));
    for (let j = 0; j < M; j++) {
      const p0 = S.rim[j], p1 = S.rim[(j + 1) % M];
      const v0 = vp(p0), v1 = vp(p1);
      /* pushTri takes the TRUE per-face normal from the winding cross product,
         so every wedge of every whorl gets its own normal - there is no
         smoothing toward "up" anywhere in this mesh. */
      pushTri(B, [0, S.yA, 0], v0, v1, apexC, upC(p0), upC(p1));      // upper face
      pushTri(B, [0, S.yL, 0], v1, v0, lowC, rimLow(p1), rimLow(p0)); // under face
    }
  }

  /* ---- a snow pillow. surf(dr) gives the branch height at radial offset dr
     from the lump centre, so the base ring is always sunk into the branch and
     the mass can never float above it. ---- */
  const lump = (ax, rc, la, lb, hL, K, lip, tone, surf) => {
    const sa = Math.sin(ax), ca = Math.cos(ax);
    const px = (dr, dt) => [(rc + dr) * sa + dt * ca, 0, (rc + dr) * ca - dt * sa];
    const ring = [], out = [];
    let ymin = 1e9;
    for (let k = 0; k < K; k++) {
      const ph = (k / K) * TAU + (rnd() - 0.5) * (TAU / K) * 0.5;
      const jr = rr(0.78, 1.24);
      const dr = Math.cos(ph) * la * jr, dt = Math.sin(ph) * lb * jr;
      const base = surf(dr) - hL * 0.30;
      const p = px(dr, dt); p[1] = base;
      ring.push(p); if (base < ymin) ymin = base;
      if (lip) {
        /* THE ROLLED OVERHANGING RIM, and the single most important surface on
           the whole tree - because a 12 m conifer is almost entirely ABOVE the
           rider's eye, so the rim is the only snow you ever actually see.
           MEASURED w3: it used to lean out 0.34x its own footprint while
           dropping ~0.8*hL, i.e. its normal pointed mostly DOWN. In this
           material a down-facing normal gets ndl 0.045 and an ambient of
           uGndCol*0.30 = (0.108,0.117,0.132), so even a 1.0-albedo snow face
           renders at sRGB ~137 - a grey smudge, no matter how white you paint
           it. Leaning it OUT (0.62x its footprint, dropping only ~0.5*hL) turns
           the normal horizontal, which picks up the sun on the lit side of the
           tree and sky bounce on the shaded side: the same albedo now measures
           180-215. Shape has to be carried by the NORMAL here, not by darkening
           the underside. The small down-facing bottom cap still draws the thin
           dark line under every pillow. */
        const q = px(dr * 1.62, dt * 1.62); q[1] = base - hL * rr(0.34, 0.68);
        out.push(q); if (q[1] < ymin) ymin = q[1];
      }
    }
    const top = px(la * rr(-0.22, 0.22), lb * rr(-0.25, 0.25));
    top[1] = surf(0) + hL * rr(0.95, 1.32);
    const bot = px(0, 0); bot[1] = ymin - hL * 0.05;
    const cT = cmul(C.snow, tone), cM = cmul(C.snowMid, tone), cL = cmul(C.snowLow, tone);
    for (let k = 0; k < K; k++) {
      const a0 = ring[k], a1 = ring[(k + 1) % K];
      pushTri(B, top, a0, a1, cT, cM, cM);
      if (lip) {
        const b0 = out[k], b1 = out[(k + 1) % K];
        pushTri(B, a0, b0, a1, cM, cL, cM);
        pushTri(B, b0, b1, a1, cL, cL, cM);
        pushTri(B, bot, b1, b0, cL, cL, cL);
      } else {
        pushTri(B, bot, a1, a0, cL, cL, cL);
      }
    }
  };

  /* branch masses: a weighted shuffle over the tip spokes, biased up the tree
     (exposed crowns catch more) but leaving whole spokes bare on purpose.
     Placement is biased OUT along the spoke (0.45-0.95 of its length): snow
     loads the flat outer half of a branch, not the crowded axis. */
  if (P.lumps > 0) {
    const slots = [];
    for (let i = 0; i < T; i++) for (let j = 0; j < M; j += 2) slots.push({ i, j, k: rnd() * (0.70 + 0.55 * tiers[i].t) });
    slots.sort((a, b) => b.k - a.k);
    for (let s = 0, n = Math.min(P.lumps, slots.length); s < n; s++) {
      const S = tiers[slots[s].i], p = S.rim[slots[s].j];
      /* OUT along the spoke, w3: 0.45-0.95 -> 0.66-0.96. With the rim leaning
         out 1.62x its footprint, a pillow centred at 0.8 of the spoke reaches
         ~1.10 of it, so it OVERHANGS the branch tip and breaks the tree's
         outline - which is the whole point. It is also where snow physically
         loads: the flat outer half of a branch, not the crowded axis. */
      const rc = p.r * rr(0.66, 0.96);
      const la = p.r * rr(0.16, 0.27);
      /* lb is ANGULARLY BOUNDED, and this is the DEFECT-5 FIX. It used to be
         rc*TAU/M*1.40, i.e. +-1.4 WEDGES of arc, so a pillow sprawled almost
         three wedges wide with no reference to the branch it was supposed to sit
         on. On the upper whorls the notch spokes are shorter than rc, so the
         tangential extremities hung off the side of the branch into open air.
         MEASURED: 224 of LOD0's 1,152 pillow triangles had no needle surface
         within 1.5 cm below them (unit tree), gaps up to 0.036 = 43 cm on a 12 m
         instance, every one of them on the top five whorls. That is the detached
         white polygon cluster in the wave-2 forest shot. Held inside its own
         half-wedge, the surf() linear read along the spoke is exact and it
         cannot happen. */
      const lb = clamp(rc * (Math.PI / M) * 0.95, S.rad * 0.045, la * 1.55);
      /* Height is tied to the pillow's OWN footprint, not to the tier radius:
         a pile's height scales with its base, and the old tier-relative height
         made masses that were taller than they were wide - which renders as a
         faceted crystal, not snow. snowLoad is then a clean 0..1 depth knob.
         w3: it used to be min(la, lb*0.8), so the narrow-but-long footprint the
         angular bound produces would have collapsed the height to nothing. Both
         axes contribute now, and the mass ends up PROUD: total vertical extent
         is ~1.3*hL above the blade plane, which on a mid whorl is ~40% of the
         whorl-to-whorl spacing - visible edge-on, which is the only view that
         matters. */
      const hL = (la * 0.52 + lb * 0.80) * rr(0.95, 1.5) * (0.9 + 0.3 * S.t) * P.snowLoad;
      const surf = dr => lerp(S.yA, p.y, clamp((rc + dr) / (p.r || 1e-4), 0, 1.15));
      lump(p.a, rc, la, lb, hL, P.lumpSides, P.lip, rr(0.90, 1.05) * (0.80 + 0.22 * S.t), surf);
    }
  }
  /* Stem collars, upper third only, and SMALL - the old ones were a rad*0.32
     pillow sitting on the axis, which rendered as a white tetrahedron floating
     in the middle of the tree with no branch under it.
     w3: they were STILL floating, just less far. The surface was a CONSTANT
     yA - rad*0.04, but yA is the whorl APEX and the upper face slopes away from
     it, so at radius 0.30*rad the real branch is already ~0.30*(rise+droop)
     lower - measured 1.5-3.0 cm on a unit tree, i.e. 18-36 cm of air on a 12 m
     instance. They now ride a REAL tip spoke and use the same exact linear
     surf() read the pillows do, so they are seated by construction. */
  if (P.collars) for (let i = Math.max(2, Math.floor(T * 0.55)); i < T; i++) {
    const S = tiers[i];
    const p = S.rim[(Math.floor(rnd() * N) * 2) % M];
    const rc = p.r * 0.36;
    const la = Math.min(p.r * 0.18, S.rad * 0.17);
    const lb = clamp(rc * (Math.PI / M) * 0.95, S.rad * 0.035, la * 1.4);
    lump(p.a, rc, la, lb, (la * 0.6 + lb * 0.7) * P.snowLoad, P.lumpSides, false,
      0.84 + 0.20 * S.t, dr => lerp(S.yA, p.y, clamp((rc + dr) / (p.r || 1e-4), 0, 1.15)));
  }
  /* The leader is a cone whose radius collapses to nothing at P.top, and the cap
     used a HARDCODED 0.018 half-width at a hardcoded height - so on a tree whose
     top whorl is small the ring poked out through the cone as a white flange.
     Derive both from the actual cone (spB/spH/spR, computed once below and used
     for the cone itself too) and it fits at any tier count. */
  if (P.spireCap && P.spire) {
    const yc = P.top - spH * 0.34;
    const rC = spR * 0.34 * 0.90;                 // cone radius at yc, inset 10%
    lump(rnd() * TAU, 0, rC, rC, spH * 0.24, 4, false, 1.0, () => yc);
  }

  /* ---- snow mound at the foot. Radius is absolute, NOT rMax-relative: the
     canopy got 70% wider and a mound that scaled with it would be a 2.4 m disc
     that lifts out of the snow the moment the instance leans.
     w3: it still WAS one - moundR 0.16 x a 15 m instance is a 2.4 m disc, and
     its rim sat only 0.03 below the plant point, so a 6 deg lean (TREE_LOD.lean)
     lifts the uphill edge 0.25 m clear of the snow and you see a white polygon
     hanging in the air. Rim dropped to -0.055 (0.83 m of margin on a 15 m tree)
     and the radius pulled in ~22%. ---- */
  if (P.moundSides > 0) {
    const K = P.moundSides, ctr = [0, 0.030, 0], pts = [];
    for (let k = 0; k < K; k++) {
      const a = (k / K) * TAU + rnd() * 0.25;
      const r = P.moundR * rr(0.62, 1.0);
      pts.push([r * Math.sin(a), -0.055 + rnd() * 0.014, r * Math.cos(a)]);
    }
    for (let k = 0; k < K; k++)
      pushTri(B, ctr, pts[k], pts[(k + 1) % K], C.snow, cmul(C.snow, 0.84), cmul(C.snow, 0.84));
  }

  /* Where the needle geometry ends and the snow geometry begins. Every whorl is
     pushed before any snow mass, so this one index splits the buffer into
     "needles" and "snow" - which is what the headless audit
     (.bcode/agent-workspace/tree_raster.mjs) needs to measure snow coverage and
     to prove no mass is left floating. Stamped rather than re-derived, so it
     cannot drift from the LOD table. */
  const snowRange = [T * (N * 2) * 2, B.p.length / 9];
  const parts = [bufGeo(B)];
  /* The foot is flared: a straight cylinder meeting snow at an angle reads as a
     pole stuck in the ground, and the flare also gives the slope-aware sink in
     props_world something to hide. openEnded - the caps are never seen. It ends
     just inside the second whorl. With the whorls now overlapping, almost none
     of it is visible anyway, which is the correct fix for a visible trunk. */
  if (P.trunk) {
    const tkH = Math.min(tiers[Math.min(1, T - 1)].y + 0.03, yBot + 0.19) * P.trunkY;
    parts.push(geoColor(new THREE.CylinderGeometry(0.017, 0.046, tkH, P.trunkRad, 1, true),
      (x, y) => cmul(C.bark, 0.70 + 0.60 * smoothstep(-tkH * 0.5, tkH * 0.5, y)))
      .translate(0, tkH * 0.5 - 0.03, 0));
  }
  /* The leader. Short and slightly bent: the old spire was a clean unbroken
     smooth cone over the top 15% of the tree, which is the one shape a real
     conifer top never has. The top whorls now crowd into it (they are only a
     couple of centimetres apart in unit space) and it only caps the last ~9%. */
  if (P.spire) {
    const sg = geoColor(new THREE.ConeGeometry(spR, spH, P.spireRad, 1),
      (x, y) => cmix(cmul(C.nmid, 0.95), C.frost, clamp(P.snowPaint * 0.6 + (y / spH + 0.5) * 0.55, 0, 1)));
    const lean = new THREE.Matrix4().makeRotationAxis(
      new THREE.Vector3(Math.cos(rnd() * TAU), 0, Math.sin(rnd() * TAU)).normalize(), rr(0.02, 0.10));
    sg.translate(0, spH * 0.5, 0).applyMatrix4(lean).translate(0, spB, 0);
    parts.push(sg);
  }
  const out = mergeGeos(parts);
  out.userData.rTip = rTip * 1.14;      // +14%: the rolled rims overhang the tips
  out.userData.snow = snowRange;   // [firstSnowTri, lastSnowTri)
  return out;
}

/* The LOD builds. Same seed so the silhouette family stays recognisable
   through a switch. Counts are MEASURED (headless three.js, see the deliverable
   note in props_world TREE_LOD), not estimated. LOD2 is a deliberate stopgap for
   a rendered impostor: cheap and DARK is the whole job at 250 m, where the
   median tree is 34 px tall and value contrast against snow is the only
   property that survives.

   TRI BUDGET, and where it goes. Measured at 4,223 tris the LOD0 build was 76%
   over its 2,400 allowance, and 64% of it was pillow TESSELLATION - 96 masses
   at 7 sides. Ranked by what survives on screen:
     1. whorl count (closes the sky gaps, kills the tier shimmer) - keep high
     2. pillow COUNT (the reference is many small masses)         - keep high
     3. pillow tessellation                                       - spend here
   So the diet is 18/19 -> 16/17 whorls (still 4 above the 12/13 the spec asks),
   96 -> 72 pillows (spec asks 44) and 7 -> 4 pillow sides. A 4-gon pillow keeps
   its rolled lip - which is the part that draws the thin dark line - and loses
   only top-facet roundness that is sub-pixel past ~15 m. 4,223 -> 2,345.

   ASPECT IS MATCHED PER LOD, NOT PER PARAMETER. rMax is a nominal half-width;
   the RENDERED width also depends on how many spokes get a chance to roll the
   +jit tail, so the same rMax gave 0.698 / 0.627 / 0.601 width:height at LOD0 /
   1 / 2 and every LOD switch popped the crown narrower. rMax is now solved per
   LOD to land all three on ~0.70 (reference photo is ~0.72) - free, and it also
   widens exactly the 1000 far instances that ARE the forest.

   ov: optional overrides, merged into every LOD (ov.pal into the palette) so
   G.dbg.treeTone can rebuild the whole family live for an A/B.
   ov.lod: OPTIONAL per-tier overrides, ov.lod[i] merged into tier i ONLY and
   applied last, so a single tier can be A/B'd without disturbing the others.
   That matters because the tiers want opposite things (see the LOD2 note) and a
   family-wide override cannot separate them. */
const TREE_LOD_GEO = (ov = {}) => {
  const o = Object.assign({}, ov); delete o.pal; delete o.lod;
  let li = 0;
  const mk = (p, dead) => {
    const per = ov.lod ? ov.lod[li] : null; li++;
    return coniferGeo(Object.assign(p, o,
      ov.pal ? { pal: Object.assign({}, dead ? CONIF_DEAD : null, ov.pal) } : null, per || null));
  };
  return [
  // LOD0  0-60 m   2,313 tris, ~5 visible instances - this is what screenshots see
  mk({ seed: 21, tiers: 12, spokes: 13, lumps: 18, lumpSides: 6, lip: true, collars: true, spireCap: true, moundSides: 7, trunkRad: 6, spireRad: 6, snowPaint: 0.52, snowFace: 0.70, snowLoad: 0.40, notch: 0.58, jit: 0.25 }),
  // LOD1  60-210 m 296 tris - LIPPED masses now, see the continuity note above
  mk({ seed: 21, tiers: 9, spokes: 5, lumps: 3, lumpSides: 4, lip: true, collars: false, spireCap: false, moundSides: 4, moundR: 0.105, trunkRad: 4, spireRad: 4, trunkY: 0.90, snowPaint: 0.54, snowFace: 0.55, snowCore: 0.60, snowLoad: 0.45, notch: 0.60, jit: 0.22, rMax: 0.378 }),
  /* LOD2  210 m+   32 tris, no trunk, no spire cone (the top whorl IS the leader)
     snowFace/snowCore are much higher here than at LOD1 and that is deliberate,
     not drift. LOD2 has lumps:0 and only 2 spokes, so it has none of the
     geometric snow masses that carry the read at LOD0/LOD1 - all of its snow has
     to be PAINT. Solved against LOD1 on the HORIZONTAL view with tree_raster
     (LOD1 sideSnow 36.1% / sideMeanSrgb 132): 0.34/0.70 gave 20.3% / 114 - the
     mid band read as a dark cone band between snowy near trees and snowy far
     billboards - and 0.62/0.86 gives 36.7% / 133. Horizontal is the right
     authority for this tier: at 210-470 m the view is level or looking DOWN onto
     the canopy, never the looking-up view that a 12 m near tree gets. */
  /* PB9: tiers 4 -> 6 (32 -> 48 tris). With 2 spokes every view shows one big
     lit face and one big shaded face, so this tier's brightness was BIMODAL in
     azimuth: 16-azimuth sd of meanSrgb was 40.7 against 25.5 for LOD1, range 121
     sRGB levels, which reads as a salt-and-pepper stand where each tree swings
     dark<->light as the camera moves. More whorls = more, smaller faces that
     average within a single view: sd 40.7 -> 35.2, range 121 -> 102.
     NEGATIVE RESULTS, do not re-try (measured with tree_pb9.mjs, which grades
     azimuth variance AGAINST silhouette IoU through LOD1's own fit box):
       - droop is NOT the free lever an earlier note claimed. droop 0.2 gives
         sd 34.0 but silhouette IoU collapses 56.8% -> 33.8% and area to 45.9%,
         i.e. the tree loses half its shape. droop 0.35 -> IoU 40.9. Rejected.
       - more SPOKES does not help at all (2/3/4 -> sd 40.7/41.2/41.4).
       - tiers 7 and 8 are WORSE on variance (36.2, 36.5) and cost more tris.
       - notch 0.70 reaches sd 31.9 but runs +6 sRGB over LOD1 and drops area to
         76%, so it buys stability by losing the silhouette.
     tiers 6 is the only candidate that improves BOTH: IoU 56.8% -> 60.5% (so the
     LOD1->LOD2 switch is a closer shape match too) with area 91% vs 92%. */
  /* T2: notch 0.90 -> 0.72, jit 0.10 -> 0.32, rMax 0.411 -> 0.49. The filed defect
     ("4 wide quads read as paper triangles") is real and the numbers name it: at
     25 px, graded against LOD1 through LOD1's own fit box (tree_t2.mjs, 16
     azimuths, horizontal eye), notch 0.90 is barely a notch at all, so the rim was
     a near-regular 4-gon - a convex plate. Its straight-line edge residual was
     5.9% of height against LOD1's 8.0%, i.e. a measurably straighter edge.
     Widening the notch and jittering it, then paying the lost area back with
     radius, improves EVERY shape measure at EVERY size for zero triangles:
       25 px  IoU 60.3 -> 65.4%   area 93.8 -> 99.1%   azSd 35.3 -> 30.9   dL -1.8 -> -0.5
       18 px  IoU 58.0 -> 62.8%   area 91.0 -> 97.9%   azSd 34.6 -> 29.6
       40 px  IoU 59.3 -> 63.6%   area 91.6 -> 97.6%   azSd 35.4 -> 31.2
     Note the azimuth-variance win is FREE where PB9 paid +24 tris for -5.5: this
     is -4.4, because a jittered rim breaks the two-big-faces symmetry that made
     the tier's brightness bimodal. Area is now within 1% of the tier it replaces,
     which also makes the LOD1->LOD2 switch a smaller size step.
     NEGATIVE RESULTS, do not re-try:
       - olap is INERT here. 0.72 / 0.80 / 0.88 / 0.96 give byte-identical rasters
         (the overlap solve clamps it), so whorl spacing cannot buy openness.
       - notch alone (0.75/0.62/0.50, no radius compensation) costs 21-36% of the
         silhouette AREA and runs +8 to +11 sRGB brighter than LOD1 - a smaller,
         paler tree, i.e. the wave-1 far-forest bug direction. Always pay the area
         back with rMax.
       - the critic's literal "6-8 narrow spokes at the same budget" (t4 s3, t3 s4)
         is WORSE: spokes cost whorls at a fixed budget, and azSd goes 35.3 -> 41.1
         / 38.2 while t3 s4 drops IoU to 42%. tiers are worth more than spokes here.
       - t6 s3 (72 tris, +50%) buys nothing this does not: IoU 59.5, azSd 36.3.
     STRUCTURAL LIMIT, recorded for whoever revisits this: LOD2 is still far too
     SOLID. Rows whose interior is not solid ("sky through the canopy") are 7.5% at
     25 px against LOD1's 34.4% and LOD0's 37.1%, and nothing at 48 tris moves it
     past ~10% - with 4 rim points per whorl the plates simply overlap in
     projection, where LOD1 gets its air from 10 rim points with deep notches.
     Closing that gap needs either more rim points (tris) or an alpha-tested card
     (fill + a second material), so it is a budget decision, not a tuning one. */
  mk({ seed: 21, tiers: 6, spokes: 2, lumps: 0, collars: false, spireCap: false, moundSides: 0, trunk: false, spire: false, snowPaint: 0.50, snowFace: 0.62, snowCore: 0.86, notch: 0.72, jit: 0.32, olap: 0.72, tPow: 0.62, tMax: 0.92, rMax: 0.49 }),
  // DEAD  ~5% of the near/mid forest: bare standing spruce, and it holds snow
  mk({ seed: 57, tiers: 8, spokes: 6, lumps: 3, lumpSides: 4, lip: true, collars: false, spireCap: false, moundSides: 5, moundR: 0.105, trunkRad: 5, spireRad: 4, snowPaint: 0.42, snowFace: 0.46, snowCore: 0.52, snowLoad: 0.45, notch: 0.40, jit: 0.34, rMax: 0.26, pal: CONIF_DEAD }, true)
  ];
};

// back-compat shim: nothing else calls this, but keep the old name working
const pineGeo = (layers, radial, hgt, snow) =>
  coniferGeo({ tiers: layers, spokes: Math.max(4, radial >> 1), snowLoad: snow ? 0.55 : 0, snowPaint: snow ? 0.42 : 0 });

/* ---- rendered impostor atlas ----
   Replaces the hand-drawn pineTex, which was 7 gradient triangles with a hard
   white cap and read nothing like the tree it stood in for - at CAP_FAR that is
   most of the visible forest, so it was the single worst-looking asset in the
   game. This renders the REAL geometry with the REAL material into an N-cell
   atlas, so the far tier is the same tree by construction and cannot drift when
   the palette is retuned (the reason this is a runtime bake and not a baked-in
   PNG).
   The sun is FIXED in this game, so the lighting can be baked: cells are VIEW
   azimuths under the world sun, indexed at draw time by WORLD view azimuth.
   Indexing by instance yaw instead would rotate the baked sun with every tree.
   Fog and cascade shadow are neutralised for the bake - matBill applies fog per
   pixel, and a baked shadow would be wrong for every instance.
   Returns the texture; userData carries the exact bake bounds so the billboard
   quad can be scaled to the mesh tree's true footprint, which is what makes the
   LOD2 -> far switch seamless in SIZE as well as tone. */
function treeImpostor(ren, geo, mat, o = {}) {
  const cells = o.cells ?? 8, cw = o.cw ?? 112, ch = o.ch ?? 224, pad = o.pad ?? 6;
  const rt = new THREE.WebGLRenderTarget(cw * cells, ch, {
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true
  });
  rt.texture.generateMipmaps = true;
  geo.computeBoundingBox();
  const H = geo.boundingBox.max.y, R = geo.userData.rTip || TREE_RMAX;
  /* pad in TEXELS, converted to world, so a cell's tree never touches its edge:
     mip levels bleed across cells, and bleeding into transparent margin only
     softens the silhouette instead of smearing in the neighbouring view */
  const px = R / (cw * 0.5 - pad), py = H / (ch - 2 * pad);
  const halfW = R + pad * px, y0 = -pad * py, y1 = H + pad * py;
  const cy = (y0 + y1) * 0.5;
  const cam = new THREE.OrthographicCamera(-halfW, halfW, (y1 - y0) * 0.5, -(y1 - y0) * 0.5, 0.01, 14);
  const sc = new THREE.Scene(); sc.add(new THREE.Mesh(geo, mat));
  const sFog = WU.uFogD.value, sCsc = WU.uCsOn ? WU.uCsOn.value : null;
  WU.uFogD.value = 0; if (WU.uCsOn) WU.uCsOn.value = 0;
  /* store LINEAR radiance, not a finished pixel - see uRaw in objMat */
  const sRaw = mat.uniforms.uRaw ? mat.uniforms.uRaw.value : null;
  if (mat.uniforms.uRaw) mat.uniforms.uRaw.value = 1;
  const pRT = ren.getRenderTarget(), pAC = ren.autoClear;
  const pCC = new THREE.Color(); ren.getClearColor(pCC); const pCA = ren.getClearAlpha();
  /* Cells are driven by the RENDER TARGET's own viewport/scissor, which the
     renderer uses verbatim. renderer.setViewport/setScissor take CSS pixels and
     are multiplied by pixelRatio (2 on a retina display) EVEN while a render
     target is bound: that baked 4 double-size apex-cropped trees across the 8
     cells, and left the SCREEN viewport at 2x the framebuffer until the next
     resize - the first seconds of a run showed one quadrant of the frame. */
  const cellRect = (x, y, w, h) => { rt.viewport.set(x, y, w, h); rt.scissor.set(x, y, w, h); };
  cellRect(0, 0, rt.width, rt.height); rt.scissorTest = false;
  ren.setRenderTarget(rt);
  ren.setClearColor(0x000000, 0); ren.clear(true, true, false);
  ren.autoClear = false; rt.scissorTest = true;
  for (let k = 0; k < cells; k++) {
    const az = k / cells * Math.PI * 2, el = o.el ?? -0.06;
    cam.position.set(Math.sin(az) * 7, cy + Math.sin(el) * 7, Math.cos(az) * 7);
    cam.up.set(0, 1, 0); cam.lookAt(0, cy, 0);
    cellRect(k * cw, 0, cw, ch);
    ren.setRenderTarget(rt);                 // re-bind to apply the cell rect
    ren.render(sc, cam);
  }
  rt.scissorTest = false; cellRect(0, 0, rt.width, rt.height);
  ren.autoClear = pAC;
  ren.setClearColor(pCC, pCA); ren.setRenderTarget(pRT);
  WU.uFogD.value = sFog; if (WU.uCsOn) WU.uCsOn.value = sCsc;
  if (mat.uniforms.uRaw) mat.uniforms.uRaw.value = sRaw;
  rt.texture.userData = { cells, w: halfW * 2, h: y1 - y0, y0, hdr: IMP_HDR };
  return rt.texture;
}

/* ---- billboard pine texture (legacy, kept as the no-renderer fallback) ---- */
function pineTex() {
  const c = document.createElement('canvas'); c.width = 96; c.height = 192;
  const x = c.getContext('2d');
  const W = 96, H = 192;
  x.clearRect(0, 0, W, H);
  x.fillStyle = '#2b1c12';
  x.fillRect(W / 2 - 4, H * 0.80, 8, H * 0.20);
  for (let i = 0; i < 7; i++) {
    const t = i / 7;
    const y = H * (0.80 - t * 0.74);
    const w = W * (0.46 - 0.34 * t);
    const g = x.createLinearGradient(W / 2 - w, 0, W / 2 + w, 0);
    const l = 1 - t * 0.25;
    g.addColorStop(0, `rgb(${28 * l},${68 * l},${44 * l})`);
    g.addColorStop(0.55, `rgb(${44 * l},${96 * l},${58 * l})`);
    g.addColorStop(1, `rgb(${20 * l},${50 * l},${34 * l})`);
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(W / 2, y - H * 0.15);
    x.lineTo(W / 2 - w, y + H * 0.02);
    x.quadraticCurveTo(W / 2, y - H * 0.01, W / 2 + w, y + H * 0.02);
    x.closePath(); x.fill();
    x.fillStyle = 'rgba(255,255,255,.85)';
    x.beginPath();
    x.moveTo(W / 2, y - H * 0.13);
    x.lineTo(W / 2 - w * 0.72, y - H * 0.005);
    x.quadraticCurveTo(W / 2, y - H * 0.03, W / 2 + w * 0.72, y - H * 0.005);
    x.closePath(); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

/* ---- rock ---- */
function rockGeo(seed) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  const rnd = mulberry32(seed);
  // IcosahedronGeometry (PolyhedronGeometry) is NON-INDEXED: every triangle
  // carries its OWN copy of each corner, so a shared corner appears up to 5
  // times in the buffer. Keying the offset on the buffer index therefore gave
  // each copy a DIFFERENT offset and pulled the corner apart - the boulder
  // rendered as 80 loose interpenetrating triangles you could see through.
  // Key on the QUANTISED ORIGINAL POSITION instead so every copy of a corner
  // gets the same offset and the solid stays closed.
  const tab = new Map();
  const off = (x, y, z) => {
    const k = Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
    let v = tab.get(k);
    if (!v) { v = [0.74 + rnd() * 0.44, 0.80 + rnd() * 0.34, 0.74 + rnd() * 0.44]; tab.set(k, v); }
    return v;
  };
  const ox = [], oy = [], oz = [];
  for (let i = 0; i < p.count; i++) { const v = off(p.getX(i), p.getY(i), p.getZ(i)); ox.push(v[0]); oy.push(v[1]); oz.push(v[2]); }
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * ox[i] * 1.22, p.getY(i) * oy[i] * 0.80, p.getZ(i) * oz[i]);
  g.computeVertexNormals();
  return geoColor(g, (x, y, z, ny) => {
    // Snow only sits on facets that are near HORIZONTAL. The old smoothstep
    // started at ny 0.35, which painted snow over almost the whole boulder
    // (measured snowFrac 0.99 from the sun side) so a rock in a snowfield was
    // white on white and vanished. A tighter band leaves a crisp snow line.
    const snow = smoothstep(0.62, 0.86, ny);
    // Warm grey granite. The old base was BLUE-tinted (b = base * 1.12) and
    // shaded faces take sky-coloured ambient, so a shaded rock came out navy -
    // it read as ice, not stone. Keep r >= g > b, and under ~0.25 linear or
    // the ACES shoulder desaturates it back to grey.
    const n = Math.sin(x * 4 + z * 3) * 0.5 + Math.sin(x * 9.3 - y * 7.1) * 0.5;
    const base = 0.205 + 0.055 * n;
    return [lerp(base * 1.10, 1.02, snow), lerp(base, 1.05, snow), lerp(base * 0.88, 1.12, snow)];
  });
}

