/* --------------------------------- piste furniture: flags, signs, start gate */

/* piste marker -----------------------------------------------------------------
   MEASURED closest approach (45 s ride, tier 3, 1838 px canvas, 32 instances):
   p50 132 px, p90 291 px, and only ~10 are alive at once - so this is one of the
   largest things in the game and it used to be three axis-aligned boxes with a
   3 cm slab standing in for cloth. Budget spent accordingly (<=220 tris x ~10
   instances, one instanced draw call).

   The pole is only ~5 px WIDE even at p50, so it is a hexagonal prism rather
   than a finer tube: at that width more sides buy nothing, but the shading
   gradient across a round pole and the reflective bands both read. The pennant
   is where the pixels are (~29 x 43 px at p50), so it gets a real doubly-curved
   surface: taper, gravity droop, and a flutter wave whose amplitude grows toward
   the free end. Two sheets of opposite winding plus a tip rim, so it reads as
   cloth with thickness from either side and never shows a hollow edge.

   COLOUR: authored FOR the pipeline, not against it. The old cloth was
   [0.98, 0.28, 0.10] - green 0.28 and blue 0.10 ride the ACES shoulder and wash
   an orange pennant out to near-white against snow. Low green/blue with a high
   red keeps the chroma (the same fix the start-gate banner needed). */
function flagGeo() {
  const B = TriBuf();
  const POLE = [0.80, 0.13, 0.025], BAND = [0.92, 0.94, 1.00];
  const CLOTH = [0.85, 0.135, 0.03], CLOTH_B = [0.62, 0.10, 0.022];
  const SNOW = [1.02, 1.04, 1.10];
  const NS = 6, TAU2 = Math.PI * 2;
  const cs = [], sn = [];
  for (let i = 0; i <= NS; i++) { const a = i / NS * TAU2; cs.push(Math.cos(a)); sn.push(Math.sin(a)); }

  /* tapered hexagonal pole, banded. y stops are chosen so the two reflective
     bands are their own segments - the band is vertex colour on real rings, not
     a separate box floating around the pole. */
  const stops = [0.02, 0.85, 1.32, 1.44, 1.90, 2.02, 2.42];
  const bandAt = i => (i === 2 || i === 4);          // segment index -> reflective
  const rAt = y => 0.052 - 0.020 * (y / 2.42);
  for (let i = 0; i < NS; i++) {
    for (let j = 0; j < stops.length - 1; j++) {
      const y0 = stops[j], y1 = stops[j + 1], r0 = rAt(y0), r1 = rAt(y1);
      const col = bandAt(j) ? BAND : POLE;
      const b0 = [r0 * cs[i], y0, r0 * sn[i]], b1 = [r0 * cs[i + 1], y0, r0 * sn[i + 1]];
      const t0 = [r1 * cs[i], y1, r1 * sn[i]], t1 = [r1 * cs[i + 1], y1, r1 * sn[i + 1]];
      pushTri(B, b0, t0, b1, col);
      pushTri(B, t0, t1, b1, col);
    }
  }
  {                                                   // domed top cap
    const y = 2.42, r = rAt(y), c = [0, y + 0.035, 0];
    for (let i = 0; i < NS; i++)
      pushTri(B, c, [r * cs[i + 1], y, r * sn[i + 1]], [r * cs[i], y, r * sn[i]], POLE);
  }

  /* snow mound at the base. The instance is seated at groundH - 0.15, so local
     y = 0.15 is the snow line: the dome starts below it and only its cap shows,
     which also means a cross-slope flag simply shows more mound on the low side
     instead of hanging in the air. */
  {
    /* LOW and IRREGULAR on purpose. A tall regular cone reads as a metal fin
       (its steep sides catch almost no sun and go blue-grey in ambient) - a
       drift has to be wider than it is tall, and the per-vertex radius/height
       wobble keeps it from looking machined. */
    const rr = 0.23, c = [0.012, 0.205, -0.008];
    const wob = [1.00, 0.84, 1.12, 0.90, 1.06, 0.80];
    const yw  = [0.00, 0.02, -0.01, 0.03, 0.00, 0.015];
    const pt = i => { const k = i % NS; return [rr * wob[k] * cs[i], yw[k], rr * wob[k] * sn[i]]; };
    /* UP is out for a mound. (apex, ring[i], ring[i+1]) winds the normal DOWN,
       so this fan was invisible on the flag, the sign and the park marker. */
    for (let i = 0; i < NS; i++) pushTriO(B, c, pt(i), pt(i + 1), UP, SNOW);
  }

  /* pennant: P(u,v), u along the fly, v from bottom edge to top */
  const NU = 6, NV = 3, L = 0.52, R0 = 0.048;
  const P = (u, v) => {
    const h = lerp(0.34, 0.23, u);                    // taper toward the free end
    const yTop = 2.10 - 0.075 * u * u;                // gravity droop
    const amp = 0.052 * u * u;                        // flutter grows toward the tip
    const w = Math.sin(u * 4.3 + 0.6 + v * 0.75) * amp;
    return [R0 + L * u, yTop - h * (1 - v), w];
  };
  const grid = [];
  for (let i = 0; i <= NU; i++) { const row = []; for (let j = 0; j <= NV; j++) row.push(P(i / NU, j / NV)); grid.push(row); }
  const off = (p, d) => [p[0], p[1], p[2] + d];
  const TH = 0.009;
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
    const a = grid[i][j], b = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1];
    pushTri(B, a, b, c, CLOTH); pushTri(B, a, c, d, CLOTH);          // front (+z)
    const a2 = off(a, -TH), b2 = off(b, -TH), c2 = off(c, -TH), d2 = off(d, -TH);
    pushTri(B, a2, c2, b2, CLOTH_B); pushTri(B, a2, d2, c2, CLOTH_B); // back (-z)
  }
  for (let j = 0; j < NV; j++) {                       // tip rim, so the fly edge is solid
    const a = grid[NU][j], d = grid[NU][j + 1];
    const a2 = off(a, -TH), d2 = off(d, -TH);
    pushTri(B, a, d, a2, CLOTH_B); pushTri(B, d, d2, a2, CLOTH_B);
  }
  return bufGeo(B);
}
/* ---- freestyle-feature entry marker ---------------------------------------
   MEASURED FIRST, as section 1.5 requires. The 'park' prop kind gates all THREE
   freestyle features - the terrain park (terrain_feat 227), the halfpipe (261)
   and the big air run-in (279) - and until P11 every one of them drew the plain
   orange piste pennant, so a park entrance was indistinguishable from a piste
   edge. Measured on a halfpipe entry set at tier 3: 39.0 px tall at 82.6 m,
   which IS the 80 m acceptance distance, and the same geometry as a piste flag
   reaches ~2200 px on a close pass, so the silhouette has to carry at 40 px and
   the surface has to survive arm's length.

   What that size implies, and it drove the whole design: at 39 px a 0.17 m pad
   is about 3 px WIDE, so no amount of detail on an upright can read - a marker
   needs a BROAD FLAT element. Hence the 0.46 x 0.32 m top board (8 x 5 px of
   flat colour at 80 m) on a dark padded upright. Value, not hue, is the cue
   that survives: the piste flag is a bright red pennant, so this is mostly
   CHARCOAL - a dark silhouette against snow, which is the same reason the far
   forest reads (T-wave 1) - with amber sleeves for the park identity. Two
   markers of the same hue at 40 px would have been indistinguishable. */
function parkMarkerGeo() {
  const B = TriBuf();
  /* charcoal pad, amber sleeve. Amber keeps GREEN and BLUE low so it stays
     saturated on the ACES shoulder instead of washing to cream - the rule the
     start-gate banner and the P4 pennant both had to be re-authored for. */
  const PAD = [0.052, 0.055, 0.062], PAD_D = [0.028, 0.030, 0.036];
  const AMB = [0.82, 0.30, 0.012], AMB_D = [0.46, 0.165, 0.007];
  const SNOW = [1.02, 1.04, 1.10];
  const NS = 8, TAU2 = Math.PI * 2, cs = [], sn = [];
  for (let i = 0; i <= NS; i++) { const a = i / NS * TAU2 + 0.19; cs.push(Math.cos(a)); sn.push(Math.sin(a)); }

  /* Padded upright. 8-gon, not the flag's 6: this pad is 0.17 m across and
     ~170 px wide on the close pass measured above, where 6 facets read as a
     hexagonal post rather than a foam sleeve. The two amber sleeves are their
     own segments at a LARGER radius, so they read as a raised collar - vertex
     colour alone on a straight tube reads as a painted stripe. */
  const stops = [0.02, 0.58, 0.70, 1.34, 1.46, 2.02];
  const sleeve = j => (j === 1 || j === 3);
  const rAt = y => 0.085 - 0.012 * (y / 2.02);
  for (let i = 0; i < NS; i++) for (let j = 0; j < stops.length - 1; j++) {
    const y0 = stops[j], y1 = stops[j + 1];
    const g = sleeve(j) ? 0.0135 : 0;                  /* sleeve stands off the pad */
    const r0 = rAt(y0) + g, r1 = rAt(y1) + g;
    const col = sleeve(j) ? AMB : (j === 0 ? PAD_D : PAD);
    const b0 = [r0 * cs[i], y0, r0 * sn[i]], b1 = [r0 * cs[i + 1], y0, r0 * sn[i + 1]];
    const t0 = [r1 * cs[i], y1, r1 * sn[i]], t1 = [r1 * cs[i + 1], y1, r1 * sn[i + 1]];
    pushTri(B, b0, t0, b1, col); pushTri(B, t0, t1, b1, col);
  }
  { const y = 2.02, r = rAt(y), c = [0, y + 0.030, 0];  /* domed pad top */
    for (let i = 0; i < NS; i++) pushTri(B, c, [r * cs[i + 1], y, r * sn[i + 1]], [r * cs[i], y, r * sn[i]], PAD); }

  /* Top marker board: the element that actually reads at 80 m. A closed slab,
     not a pair of facing quads - a 3 cm slab still shows an edge on a close
     pass and can never be seen through when the marker is viewed edge-on. */
  {
    const hw = 0.23, y0 = 1.74, y1 = 2.06, zf = -0.049, zb = 0.049;
    /* Each face declares its outward direction: 8 of these 14 triangles were
       wound inward, so the slab showed neither its snow-topped rim nor its
       sides (the same bug as the sign plate and the rail bar). */
    const q = (a, b, c, d, ref, col) => pushQuadO(B, a, b, c, d, ref, col);
    /* front (-z, toward the approaching rider): amber field over a dark foot,
       so the board has an internal edge instead of reading as one flat chip */
    const ym = y0 + (y1 - y0) * 0.30;
    q([hw, ym, zf], [-hw, ym, zf], [-hw, y1, zf], [hw, y1, zf], FRONT, AMB);
    q([hw, y0, zf], [-hw, y0, zf], [-hw, ym, zf], [hw, ym, zf], FRONT, PAD_D);
    q([-hw, y0, zb], [hw, y0, zb], [hw, y1, zb], [-hw, y1, zb], BACKW, AMB_D);  /* back */
    q([-hw, y1, zf], [hw, y1, zf], [hw, y1, zb], [-hw, y1, zb], UP, SNOW);      /* snow-topped rim */
    q([hw, y0, zf], [-hw, y0, zf], [-hw, y0, zb], [hw, y0, zb], DOWN, PAD_D);
    q([-hw, y0, zf], [-hw, y1, zf], [-hw, y1, zb], [-hw, y0, zb], LEFT, PAD);
    q([hw, y1, zf], [hw, y0, zf], [hw, y0, zb], [hw, y1, zb], RIGHT, PAD);
  }

  /* base drift. P4's lesson: wider than it is tall and irregular, or the steep
     faces catch no sun and it reads as a grey metal fin. The instance is seated
     at groundH - 0.15 like a flag, so local y = 0.15 is the snow line. */
  {
    const rr = 0.30, c = [0.015, 0.215, -0.010];
    const wob = [1.00, 0.82, 1.14, 0.88, 1.06, 0.78, 1.10, 0.90];
    const yw = [0.00, 0.02, -0.012, 0.028, 0.00, 0.016, -0.008, 0.022];
    const pt = i => { const k = i % NS; return [rr * wob[k] * cs[i], yw[k], rr * wob[k] * sn[i]]; };
    for (let i = 0; i < NS; i++) pushTriO(B, c, pt(i), pt(i + 1), UP, SNOW);
  }
  return bufGeo(B);
}
/* ---- trail signs ----------------------------------------------------------
   MEASURED FIRST, as section 1.5 requires. Signs stand at pisteW + 2.5, i.e.
   2.5 m outside the piste edge, and over a 90 s tier-3 ride (14 instances seen,
   5553 frames) their own closest approach is p50 ~138 px of an 1838 px canvas,
   max 908 px at 5.9 m - you ride straight past them. The old population median
   of 2.5 px averaged every instance in view, most of them 400 m away, and it is
   what had these written off as three plain boxes.

   The three kinds were placed to MEAN something - kind 3 at the start, kind 1 at
   the wide side routes and poach lines, kind 2 at the narrow branches and cliff
   drops - but signGeo() returned identical boxes differing only in panel colour.
   So the information is now real: resort difficulty glyph, run name, direction
   chevron.

   Why an 8-cell atlas rather than one arrow quad: the panel faces the rider, so
   world +x lands on the viewer's LEFT, which means text has to run against x and
   an arrow pointing to the route's side has to flip with p.side. Mirroring the
   panel UV would mirror the text with it, and a separate arrow quad would need
   alpha (the material is opaque). Baking BOTH directions gives 3 kinds x 2 = 6
   cells, no transparency, no mirrored text, one material. */
const SIGN_KINDS = {
  3: { bg: '#1d7a3a', glyph: 'circle',  name: 'MAIN PISTE' },   /* easy   */
  1: { bg: '#1a4f96', glyph: 'square',  name: 'SIDE ROUTE' },   /* medium */
  2: { bg: '#16181c', glyph: 'diamond', name: 'STEEPS' }        /* hard   */
};
const SIGN_ROW = { 3: 0, 1: 1, 2: 2 };                          /* atlas row per kind */
/* ---- park entry banner: three labels + a swatch strip in the spare row ----
   The atlas is 2 cols x 4 rows of 512x256 and the piste signs use rows 0-2, so
   row 3 (canvas y 768..1024) was dark and never sampled. A park banner wants a
   WIDE aspect, so row 3 is subdivided into 512x128 half-cells: three carry the
   three freestyle labels and the fourth is cut into four flat 128px swatches.
   Those swatches are the point - they let the board's posts, rails and back
   face sample matSign as well, so the whole board is ONE mesh in ONE draw call.
   The alternative (a vertex-coloured matProp mesh for the structure plus a
   matSign child for the panel, which is how a trail sign is built) would have
   cost a second draw call per site, and PB6's prop-round budget is +2 total. */
const PARK_CELL = { park: [0, 768, 512, 128], pipe: [512, 768, 512, 128], air: [0, 896, 512, 128] };
const PARK_SW = { post: [512, 896], postD: [640, 896], rail: [768, 896], snow: [896, 896] };
const PARK_LBL = {
  park: { name: 'TERRAIN PARK', tint: '#f0a81e' },
  pipe: { name: 'HALFPIPE', tint: '#2ab6dc' },
  air: { name: 'BIG AIR', tint: '#ef6a1e' }
};
/* canvas rect -> uv rect. Canvas y runs DOWN, uv v runs UP. */
function atlasUV(px, py, w, h) { const S = 1024; return [px / S, 1 - (py + h) / S, (px + w) / S, 1 - py / S]; }
/* centre of a flat swatch, so all four corners of a structural quad share one uv */
function swUV(k) { const s = PARK_SW[k]; return [(s[0] + 64) / 1024, 1 - (s[1] + 64) / 1024]; }
function signTex() {
  const CW = 512, CH = 256, W = 1024, H = 1024;                 /* 2 cols x 4 rows, 6 used */
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#0b0d10'; x.fillRect(0, 0, W, H);              /* spare cells: dark, never sampled */
  const glyph = (gx, gy, r, kind) => {
    x.fillStyle = '#ffffff';
    if (kind === 'circle') { x.beginPath(); x.arc(gx, gy, r, 0, Math.PI * 2); x.fill(); }
    else if (kind === 'square') x.fillRect(gx - r * 0.88, gy - r * 0.88, r * 1.76, r * 1.76);
    else {                                                      /* black diamond: white lozenge */
      x.beginPath(); x.moveTo(gx, gy - r); x.lineTo(gx + r * 0.74, gy);
      x.lineTo(gx, gy + r); x.lineTo(gx - r * 0.74, gy); x.closePath(); x.fill();
    }
  };
  const chevron = (cx, cy, s, dir) => {                          /* dir +1 points right */
    x.strokeStyle = '#ffffff'; x.lineWidth = s * 0.34;
    x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath();
    x.moveTo(cx - dir * s * 0.42, cy - s * 0.62);
    x.lineTo(cx + dir * s * 0.42, cy);
    x.lineTo(cx - dir * s * 0.42, cy + s * 0.62);
    x.stroke();
  };
  for (const k of Object.keys(SIGN_ROW)) {
    const K = SIGN_KINDS[k], row = SIGN_ROW[k];
    for (let col = 0; col < 2; col++) {
      const ox = col * CW, oy = row * CH, dir = col === 0 ? 1 : -1;
      x.fillStyle = K.bg; x.fillRect(ox, oy, CW, CH);
      /* a real sign has a bright edge and a shaded lower lip; this is albedo, so
         keep it subtle - the lighting adds its own gradient on top */
      x.fillStyle = 'rgba(255,255,255,.16)'; x.fillRect(ox, oy, CW, 7);
      x.fillStyle = 'rgba(0,0,0,.22)';       x.fillRect(ox, oy + CH - 9, CW, 9);
      x.strokeStyle = 'rgba(244,248,252,.55)'; x.lineWidth = 5;
      x.strokeRect(ox + 12, oy + 12, CW - 24, CH - 24);
      /* glyph on the leading side, chevron on the trailing side, name between:
         mirrored per column so the chevron always points at the route */
      const gX = dir > 0 ? ox + 84 : ox + CW - 84;
      const cX = dir > 0 ? ox + CW - 70 : ox + 70;
      glyph(gX, oy + CH * 0.5, 54, K.glyph);
      chevron(cX, oy + CH * 0.5, 54, dir);
      /* AUTO-FIT: 'SIDE ROUTE' at a fixed 62px overran the free strip and was
         clipped at both ends while colliding with the chevron. The strip is
         whatever is left between the glyph and the chevron, so measure it. */
      const gEdge = 150, cEdge = CW - 112;                       /* occupied zones */
      const avail = cEdge - gEdge - 16;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.letterSpacing = '1px';
      let fs = 58;
      do { x.font = '800 ' + fs + 'px ui-rounded, system-ui, sans-serif'; fs -= 2; }
      while (fs > 26 && x.measureText(K.name).width > avail);
      x.fillStyle = '#ffffff';
      x.fillText(K.name, ox + (dir > 0 ? gEdge + avail * 0.5 + 8 : CW - cEdge + avail * 0.5 + 8), oy + CH * 0.5 + 3);
    }
  }
  /* ---- park banners in the spare row ----
     Dark field, not a bright one: a charcoal board is the highest-contrast thing
     you can put on snow, and at the 80 m acceptance distance the panel is only
     ~36 x 9 px, where contrast is all that survives. The hazard chevrons at each
     end are the park-entry code and they keep reading after the text has
     dissolved; the tint band identifies which of the three features it is. */
  for (const k of Object.keys(PARK_CELL)) {
    const R = PARK_CELL[k], L = PARK_LBL[k], ox = R[0], oy = R[1], cw = R[2], ch = R[3];
    x.fillStyle = '#14161a'; x.fillRect(ox, oy, cw, ch);
    x.fillStyle = L.tint; x.fillRect(ox, oy, cw, 9); x.fillRect(ox, oy + ch - 9, cw, 9);
    x.save(); x.beginPath(); x.rect(ox, oy, cw, ch); x.clip();
    x.fillStyle = L.tint;
    for (let e = 0; e < 2; e++) {                       /* hazard chevrons, both ends */
      const bx = e === 0 ? ox : ox + cw - 96;
      for (let i = -1; i < 4; i++) {
        const sx = bx + i * 30;
        x.beginPath(); x.moveTo(sx, oy + ch); x.lineTo(sx + 26, oy + ch);
        x.lineTo(sx + 26 + ch * 0.55, oy); x.lineTo(sx + ch * 0.55, oy); x.closePath(); x.fill();
      }
    }
    x.restore();
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.letterSpacing = '2px';
    const avail = cw - 232;                             /* free strip between the chevrons */
    let fs = 78;
    do { x.font = '800 ' + fs + 'px ui-rounded, system-ui, sans-serif'; fs -= 2; }
    while (fs > 26 && x.measureText(L.name).width > avail);
    x.fillStyle = '#14161a'; x.fillRect(ox + cw * 0.5 - avail * 0.5 - 10, oy + 12, avail + 20, ch - 24);
    x.fillStyle = '#ffffff'; x.fillText(L.name, ox + cw * 0.5, oy + ch * 0.5 + 2);
  }
  /* flat swatches for the board's structure (see PARK_SW) */
  const SWC = { post: '#71767d', postD: '#474b52', rail: '#f0a81e', snow: '#ffffff' };
  for (const k of Object.keys(PARK_SW)) {
    const s = PARK_SW[k]; x.fillStyle = SWC[k]; x.fillRect(s[0], s[1], 128, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
/* Opaque lit panel: bannerMat's proven pipeline (GLSL_COMMON + GLSL_CASCADE,
   fog, one outc()) without the cloth slack or transmission. Anything that skips
   this ends up like the old banner - a MeshBasicMaterial outside the colour
   pipeline that no exposure change can touch. */
function signMat(tex) {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign({}, WU, { uMap: { value: tex } }),
    vertexShader: `
      varying vec2 vUv; varying vec3 vN, vW;
      void main(){
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal); vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: GLSL_COMMON + GLSL_CASCADE + `
      uniform sampler2D uMap;
      varying vec2 vUv; varying vec3 vN, vW;
      void main(){
        vec3 alb = texture2D(uMap, vUv).rgb;
        vec3 N = normalize(vN);
        vec3 vd = normalize(vW - cameraPosition);
        float dist = length(vW - cameraPosition);
        float ndl = max((dot(N, uSun) + 0.40)/1.40, 0.0);
        float sh = 1.0 - 0.85*sunShadow(vW, N, dist);
        vec3 amb = mix(uGndCol, uSkyCol, N.y*0.5 + 0.5) * 0.55;
        /* SNOW BOUNCE. uSun.z is +0.73, so the face a sign turns toward the
           approaching rider is ALWAYS backlit - with ambient alone every panel
           rendered as flat shade. The bounce is strongest exactly there,
           because a panel facing away from the sun is looking at sunlit snow
           (albedo ~0.9). This is the opaque-panel equivalent of the cloth
           transmission term bannerMat needs for the same reason. */
        float bnc = 0.34 * (0.45 + 0.55*max(-dot(N, uSun), 0.0));
        vec3 col = alb * (uSunCol*(ndl + bnc*sh) + amb);
        col = applyFog(col, dist, vd);
        gl_FragColor = vec4(outc(col), 1.0);
      }`
  });
}
const SIGN_P = { w: 1.30, h: 0.65, y: 1.92, z: -0.045 };         /* panel: 2:1, matches a cell */
/* the panel's own mesh - the only part that needs uv, kept separate so TriBuf /
   mergeGeos (shared with every tree and rock) stay uv-free */
function signPanelGeo(kind, side) {
  const P = SIGN_P, hw = P.w * 0.5, hh = P.h * 0.5;
  /* Column choice: the panel faces -z (the rider rides toward +z), and for a
     viewer at -z looking along +z, world +x is on the LEFT. u must therefore
     increase as local x DECREASES for the text to read, which makes column 0's
     right-pointing chevron point toward -x. So a route on side +1 needs col 1. */
  const col = side > 0 ? 1 : 0, row = SIGN_ROW[kind] !== undefined ? SIGN_ROW[kind] : 0;
  const u0 = col * 0.5, u1 = u0 + 0.5;
  const v1 = 1.0 - row * 0.25, v0 = v1 - 0.25;
  const g = new THREE.BufferGeometry();
  /* two tris, uv running against local x (see above) */
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
     hw, P.y - hh, P.z,  -hw, P.y - hh, P.z,  -hw, P.y + hh, P.z,
     hw, P.y - hh, P.z,  -hw, P.y + hh, P.z,   hw, P.y + hh, P.z
  ]), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
    0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1
  ]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    u0,v0,  u1,v0,  u1,v1,   u0,v0,  u1,v1,  u0,v1
  ]), 2));
  g.computeBoundingSphere();
  return g;
}
/* post, back plate, bolts and winter dressing - vertex colour, no uv */
function signGeo(kind) {
  const B = TriBuf();
  const WOOD = [0.30, 0.20, 0.13], WOOD_D = [0.19, 0.13, 0.085];
  const METAL = [0.42, 0.44, 0.48], SNOW = [1.02, 1.04, 1.10];
  const BACK = [0.34, 0.35, 0.37];
  const P = SIGN_P, hw = P.w * 0.5, hh = P.h * 0.5;
  const NS = 6, TAU2 = Math.PI * 2, cs = [], sn = [];
  for (let i = 0; i <= NS; i++) { const a = i / NS * TAU2 + 0.26; cs.push(Math.cos(a)); sn.push(Math.sin(a)); }

  /* tapered hexagonal post. At the measured closest approach the post is ~44 px
     WIDE, so the shading gradient around a real prism is worth its 12 tris; a
     flat box reads as a cardboard strip. */
  const TOP = 2.20, rAt = y => 0.058 - 0.017 * (y / TOP);
  const stops = [0.0, 0.62, 1.55, 1.62, TOP];
  const collar = j => j === 2;                        /* steel collar under the panel */
  for (let i = 0; i < NS; i++) for (let j = 0; j < stops.length - 1; j++) {
    const y0 = stops[j], y1 = stops[j + 1], r0 = rAt(y0), r1 = rAt(y1);
    const col = collar(j) ? METAL : (j === 0 ? WOOD_D : WOOD);
    pushTri(B, [r0*cs[i], y0, r0*sn[i]], [r1*cs[i], y1, r1*sn[i]], [r0*cs[i+1], y0, r0*sn[i+1]], col);
    pushTri(B, [r1*cs[i], y1, r1*sn[i]], [r1*cs[i+1], y1, r1*sn[i+1]], [r0*cs[i+1], y0, r0*sn[i+1]], col);
  }
  { const y = TOP, r = rAt(y), c = [0, y + 0.022, 0];
    for (let i = 0; i < NS; i++) pushTri(B, c, [r*cs[i+1], y, r*sn[i+1]], [r*cs[i], y, r*sn[i]], WOOD); }

  /* back plate: a real slab, so the sign has thickness and an edge rim. The
     front face is the panel mesh's job; this closes everything behind it. */
  const zB = 0.030, zF = P.z + 0.002;
  /* MEASURED: four of these five faces were wound inward, so the slab had no
     visible rim at all - the panel read as a zero-thickness chip. Each quad now
     declares its outward direction and pushQuadO picks the order. */
  const q = (a, b, c, d, ref, col) => pushQuadO(B, a, b, c, d, ref, col);
  q([-hw, P.y - hh, zB], [hw, P.y - hh, zB], [hw, P.y + hh, zB], [-hw, P.y + hh, zB], BACKW, BACK);
  q([-hw, P.y + hh, zF], [hw, P.y + hh, zF], [hw, P.y + hh, zB], [-hw, P.y + hh, zB], UP, BACK);       /* top */
  q([hw, P.y - hh, zF], [-hw, P.y - hh, zF], [-hw, P.y - hh, zB], [hw, P.y - hh, zB], DOWN, WOOD_D);   /* under lip */
  q([-hw, P.y - hh, zF], [-hw, P.y + hh, zF], [-hw, P.y + hh, zB], [-hw, P.y - hh, zB], LEFT, BACK);
  q([hw, P.y + hh, zF], [hw, P.y - hh, zF], [hw, P.y - hh, zB], [hw, P.y + hh, zB], RIGHT, BACK);

  /* two bolt heads where the plate meets the post */
  for (const by of [P.y + hh - 0.11, P.y - hh + 0.11]) {
    const br = 0.026, bz = P.z - 0.004, c = [0, by, bz - 0.012];
    for (let i = 0; i < NS; i++) {
      const a = [br*cs[i], by + br*sn[i], bz], b = [br*cs[i+1], by + br*sn[i+1], bz];
      pushTriO(B, c, a, b, FRONT, METAL);          /* the head protrudes toward -z */
    }
  }

  /* winter dressing. P4's lesson: a snow cap must be WIDER than it is tall and
     irregular, or its steep faces catch no sun and read as a grey metal fin. */
  {
    /* A drift LYING on the sign, not a shelf bolted to it. First attempt was a
       full-width slab with a VERTICAL front lip: the lip faces -z, which is
       exactly the direction the sun does not come from (uSun.z = +0.73), so it
       shaded flat grey and read as a metal shelf floating above the panel -
       the same failure P4 hit with a tall cone at the flag base. Fixes: inset
       from the ends and taper to nothing, slope both faces so each catches some
       sun, and start BELOW the panel's top edge so there is no gap to read as a
       seam. */
    const yT = P.y + hh, N = 6;
    const wob = [0.72, 1.06, 0.86, 1.14, 0.94, 0.78];
    const zFr = zF - 0.014, zMid = (zF + zB) * 0.5;
    const xAt = i => -hw + 0.05 + (P.w - 0.10) * (i / N);
    const hAt = i => {
      const t = i / N, taper = Math.min(1, Math.sin(Math.PI * t) * 1.9);  /* 0 at both ends */
      return 0.062 * wob[i % N] * taper;
    };
    for (let i = 0; i < N; i++) {
      const x0 = xAt(i), x1 = xAt(i + 1), h0 = hAt(i), h1 = hAt(i + 1);
      /* front slope: from just under the panel lip up to the crest */
      q([x0, yT - 0.018, zFr], [x1, yT - 0.018, zFr],
        [x1, yT + h1, zMid], [x0, yT + h0, zMid], [0, 1, -0.6], SNOW);
      /* back slope down onto the plate top */
      q([x0, yT + h0, zMid], [x1, yT + h1, zMid],
        [x1, yT - 0.004, zB], [x0, yT - 0.004, zB], [0, 1, 0.6], SNOW);
    }
  }
  {                                                   /* base drift, low and wobbly */
    const rr = 0.26, c = [0.01, 0.20, -0.01];
    const wob = [1.00, 0.82, 1.14, 0.92, 1.06, 0.86], yw = [0, 0.02, -0.01, 0.03, 0, 0.015];
    const pt = i => { const k = i % NS; return [rr*wob[k]*cs[i], yw[k], rr*wob[k]*sn[i]]; };
    for (let i = 0; i < NS; i++) pushTriO(B, c, pt(i), pt(i + 1), UP, SNOW);
  }
  return bufGeo(B);
}
/* start gate with a canvas banner */
/* ---- park entry board -----------------------------------------------------
   One piece of signage per freestyle site, standing just outside the marker
   line. Deliberately ONE mesh with ONE material: the panel samples its label
   cell and every structural face samples a flat swatch (see PARK_SW), so a site
   costs a single draw call. Note the uv direction - the panel faces -z toward
   the approaching rider, and for a viewer at -z looking along +z world +x is on
   the LEFT, so u must increase as local x DECREASES or the text mirrors. That is
   the same trap signPanelGeo documents. */
const PARK_B = { w: 2.56, h: 0.60, top: 2.46, px: 1.12, pr: 0.058 };
function parkBoardGeo(kind) {
  const P = [], N = [], U = [];
  const tri = (a, b, c, n, ua, ub, uc) => {
    P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    N.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
    U.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  };
  const quad = (a, b, c, d, n, ua, ub, uc, ud) => { tri(a, b, c, n, ua, ub, uc); tri(a, c, d, n, ua, uc, ud); };
  const flat = (a, b, c, d, n, k) => { const u = swUV(k); quad(a, b, c, d, n, u, u, u, u); };
  const B = PARK_B, hw = B.w * 0.5, y1 = B.top, y0 = B.top - B.h, zf = -0.038, zb = 0.038;

  /* panel front: the label cell */
  const C = PARK_CELL[kind] || PARK_CELL.park;
  const uv = atlasUV(C[0], C[1], C[2], C[3]), u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];
  tri([hw, y0, zf], [-hw, y0, zf], [-hw, y1, zf], [0, 0, -1], [u0, v0], [u1, v0], [u1, v1]);
  tri([hw, y0, zf], [-hw, y1, zf], [hw, y1, zf], [0, 0, -1], [u0, v0], [u1, v1], [u0, v1]);
  /* back and rims, so the board is a slab with a visible edge from any angle */
  flat([-hw, y0, zb], [hw, y0, zb], [hw, y1, zb], [-hw, y1, zb], [0, 0, 1], 'postD');
  flat([-hw, y1, zf], [hw, y1, zf], [hw, y1, zb], [-hw, y1, zb], [0, 1, 0], 'snow');
  flat([hw, y0, zf], [-hw, y0, zf], [-hw, y0, zb], [hw, y0, zb], [0, -1, 0], 'postD');
  flat([-hw, y0, zf], [-hw, y1, zf], [-hw, y1, zb], [-hw, y0, zb], [-1, 0, 0], 'post');
  flat([hw, y1, zf], [hw, y0, zf], [hw, y0, zb], [hw, y1, zb], [1, 0, 0], 'post');

  /* two square posts, and an amber rail across the bottom of the panel */
  for (const sx of [-1, 1]) {
    const cx = sx * B.px, r = B.pr, ty = y1 - 0.02;
    const c0 = [cx - r, 0.02, -r], c1 = [cx + r, 0.02, -r], c2 = [cx + r, 0.02, r], c3 = [cx - r, 0.02, r];
    const t0 = [cx - r, ty, -r], t1 = [cx + r, ty, -r], t2 = [cx + r, ty, r], t3 = [cx - r, ty, r];
    flat(c0, c1, t1, t0, [0, 0, -1], 'post');
    flat(c2, c3, t3, t2, [0, 0, 1], 'postD');
    flat(c1, c2, t2, t1, [1 * sx, 0, 0], 'postD');
    flat(c3, c0, t0, t3, [-1 * sx, 0, 0], 'post');
    flat(t0, t1, t2, t3, [0, 1, 0], 'snow');
  }
  { const ry = y0 - 0.055, rr = 0.032;
    flat([-hw, ry - rr, -rr], [hw, ry - rr, -rr], [hw, ry + rr, -rr], [-hw, ry + rr, -rr], [0, 0, -1], 'rail');
    flat([-hw, ry + rr, -rr], [hw, ry + rr, -rr], [hw, ry + rr, rr], [-hw, ry + rr, rr], [0, 1, 0], 'snow'); }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(U), 2));
  g.computeBoundingSphere();
  /* PB9: the big park board is solid - it is 2.56 m of panel on two posts, wide
     enough to be a real obstacle. Graded like a tree, not like a building, so
     clipping one at moderate speed costs balance rather than the run. The thin
     hz is the panel's own 0.076 m plus a little; the rider's 0.42 m radius does
     the rest. Small trail signs (signGeo) stay non-solid. */
  g.userData.col = pcMake('sign', [pcBox(PARK_B.w * 0.5, 0.12, PARK_B.top)]);
  return g;
}
function bannerTex(text) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 128;
  const x = c.getContext('2d');
  /* Authored FOR the colour pipeline, not for a raw blit. The banner used to be
     drawn with toneMapped:false, so these bytes reached the screen untouched.
     Now it is lit, fogged and ACES-tonemapped like everything else, and ACES
     pulls a bright saturated orange toward yellow-white as it approaches the
     shoulder: MEASURED, the original #f7873a/#ffc95e gradient rendered with
     chroma R-B 136 against the old 190, and the gain made almost no difference
     (135 / 137 / 136 / 132 across a 2.5x sweep) because the red channel is over
     the shoulder either way. Verified analytically too: mid stop (255,201,94)
     -> linear -> x light -> ACES -> gamma predicts (194,149,72) vs (193,145,57)
     measured. So the G and B channels are pre-compensated DOWN here; the orange
     you see on screen is the result of this times the light, not this. */
  const g = x.createLinearGradient(0, 0, 1024, 0);
  g.addColorStop(0, '#e85f14'); g.addColorStop(0.5, '#ff9c22'); g.addColorStop(1, '#e85f14');
  x.fillStyle = g; x.fillRect(0, 0, 1024, 128);
  x.fillStyle = 'rgba(255,255,255,.25)'; x.fillRect(0, 0, 1024, 10); x.fillRect(0, 118, 1024, 10);
  x.fillStyle = '#3a1c06';
  x.font = '800 74px ui-rounded, system-ui, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.letterSpacing = '14px';
  x.fillText(text, 512, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/* The banner was the ONE surface in the game outside the shared colour pipeline:
   `MeshBasicMaterial({ toneMapped: false })` takes no light, no cascade shadow
   and no tonemap, and because `scene.fog` is null in this game (every other
   surface fogs itself in its own shader via applyFog) it took no fog either.
   That mattered far more than "it is only the start gate": MEASURED during the
   real ride-through, the banner is 119 px tall at the start line and reaches
   1618 px - 88% of an 1838 px canvas - as you pass under it, making it the
   largest on-screen object in the game. It stayed equally bright in a whiteout.
   It is cloth, and the sun is BEHIND it from the rider's point of view (the sun
   is +z-ish and the banner faces the rider down-mountain), so the term that
   actually lights it is transmission, not reflection - a backlit banner glows.
   Hence uTrans, and hence the legibility check in the todo's acceptance. */
function bannerMat(tex) {
  /* Cloth response, tunable because the FIRST version over-drove it: trans 0.85
     / wrap 0.80 / amb 0.70 gave a red channel multiplier of ~1.24, which pushes
     an already-bright orange PAST 1.0 and onto the ACES shoulder, where it
     desaturates toward white - measured mean luminance 184.6 vs the old 120.1,
     and the orange read as pale gold. Same trap as the old poach lines and the
     pale scarf: if a colour must stay saturated in sunlight, keep its lit value
     under ~1.0 linear. Exposed as FL.dbg.banner for a live sweep. */
  const BAN = { trans: 0.45, wrap: 0.45, amb: 0.52 };
  const u = Object.assign({}, WU, { uMap: { value: tex },
    uTrans: { value: BAN.trans }, uWrapB: { value: BAN.wrap }, uAmbB: { value: BAN.amb } });
  if (typeof G !== 'undefined' && G.dbg) G.dbg.banner = (t, w, a) => {
    if (t !== undefined) u.uTrans.value = t;
    if (w !== undefined) u.uWrapB.value = w;
    if (a !== undefined) u.uAmbB.value = a;
    return { trans: u.uTrans.value, wrap: u.uWrapB.value, amb: u.uAmbB.value };
  };
  return new THREE.ShaderMaterial({
    uniforms: u, side: THREE.DoubleSide,
    vertexShader: `
      uniform float uTime;
      varying vec2 vUv; varying vec3 vN, vW;
      void main(){
        vUv = uv;
        vec3 p = position;
        /* slack is 0 at the posts and 1 mid-span, so the cloth stays pinned */
        float ex = p.x / 12.0, slack = 1.0 - ex*ex;
        float ph = uTime * 1.6;
        float A = 0.30, B = 0.12, ka = 0.55, kb = 1.30;
        float rip = sin(p.x*ka + ph)*A + sin(p.x*kb - ph*1.37)*B;
        p.y -= 0.40 * slack;                       /* catenary droop */
        p.z += rip * slack;                        /* bow + travelling ripple */
        p.y += cos(p.x*ka + ph) * 0.045 * slack;
        /* analytic slope of the ripple, so the cloth actually shades as it waves */
        float d = (cos(p.x*ka + ph)*ka*A + cos(p.x*kb - ph*1.37)*kb*B) * slack;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vN = normalize(mat3(modelMatrix) * normalize(vec3(-d, 0.18*slack, 1.0)));
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: GLSL_COMMON + GLSL_CASCADE + `
      uniform sampler2D uMap;
      uniform float uTrans, uWrapB, uAmbB;
      varying vec2 vUv; varying vec3 vN, vW;
      void main(){
        vec3 alb = texture2D(uMap, vUv).rgb;
        vec3 N = normalize(vN);
        if(!gl_FrontFacing) N = -N;
        vec3 vd = normalize(vW - cameraPosition);
        float dist = length(vW - cameraPosition);
        float ndl = max((dot(N, uSun) + uWrapB)/(1.0 + uWrapB), 0.0);
        float trans = max(-dot(N, uSun), 0.0) * uTrans;   /* sun through the weave */
        float sh = 1.0 - 0.85*sunShadow(vW, N, dist);
        vec3 amb = mix(uGndCol, uSkyCol, N.y*0.5 + 0.5) * uAmbB;
        vec3 col = alb * (uSunCol*(ndl + trans)*sh + amb);
        col = applyFog(col, dist, vd);
        gl_FragColor = vec4(outc(col), 1.0);
      }`
  });
}
function gateGroup(hFn) {
  const grp = new THREE.Group();
  const mat = objMat({ wrap: 0.45 });
  const wood = [0.30, 0.21, 0.145], snow = [1.0, 1.02, 1.08];
  const HX = 13.5, TOP = 6.6;
  const dyL = hFn ? hFn(-HX) : 0, dyR = hFn ? hFn(HX) : 0;
  const post = (x, dy) => mergeGeos([
    box(0.5, TOP - dy + 2.0, 0.5, x, (TOP + dy) / 2 - 1.0, 0, wood),   // buried 2m so it never floats
    box(1.5, 0.36, 1.5, x, dy + 0.18, 0, snow),
    box(0.9, 0.5, 0.9, x, TOP - 0.25, 0, wood),
    box(1.02, 0.13, 1.02, x, TOP + 0.06, 0, snow)                      // cap of snow on the post head
  ]);
  grp.add(new THREE.Mesh(mergeGeos([
    post(-HX, dyL), post(HX, dyR),
    box(HX * 2 + 0.8, 0.32, 0.32, 0, TOP + 0.12, 0, wood),
    box(HX * 2 + 0.8, 0.11, 0.44, 0, TOP + 0.33, 0, snow)              // and along the crossbar
  ]), mat));
  const ban = new THREE.Mesh(new THREE.PlaneGeometry(24, 3.0, 28, 2),
    bannerMat(bannerTex('FLOWLINE')));
  ban.position.set(0, TOP - 1.62, 0);
  ban.rotation.y = Math.PI;
  grp.add(ban);
  return grp;
}
