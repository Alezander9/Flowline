/* --------------------------------- park hardware: rails, boxes, chairlift */

/* park rail / box -----------------------------------------------------------
   THE GRIND SURFACE IS NOT THIS MESH. terrain_feat case 4 raises the ground to
   `h + f.hgt` for |ax| <= f.w and rider.js grinds on `s.lift` from that
   sampler, so this geometry is purely visual - but it has to agree with the
   invisible deck or you grind beside what you can see. Both invariants below
   are therefore held EXACTLY as the old box version had them:
     - top surface at local y = h + 0.05 (rail) / h + 0.08 (box)
     - lateral extent +-w, matching case 4's `ax > f.w` test
   BAR WIDTH - a decision I made twice. A rail's deck is +-w = +-0.36 m (72 cm
   wide, terrain_feat.js:210), so I first drew the bar at the FULL deck width so
   the board could never grind beside what it can see. MEASURED in game at its
   closest approach (184 px at 13.1 m) that reads as a plank, not a rail. The
   trade is small: with a 40 cm bar and a 26 cm board, the board loses all
   overlap with the bar only when its centre is 0.33-0.36 m off centreline -
   about 8% of the grindable range, and only its outer edge. A rail that reads
   as a rail is worth an 8% sliver, so the bar is 0.20 half-width and a BOX
   (deck +-1.0..1.5 m) still gets its full width, because a box really is wide. */
function railGeo(len, w, h, rail) {
  const parts = [], B = TriBuf();
  /* Steel has to read as METAL beside snow, and snow is albedo ~1.0. The first
     pass used 0.72-0.80 linear, which sits on the ACES shoulder and rendered
     the bar as white - a rail the same value as the ground it stands on. Mid
     grey is what separates it. CAP is its own tone because an end cap faces
     up-slope, away from the sun, and at STEEL_D it went near-black. */
  const STEEL = [0.34, 0.36, 0.42], STEEL_D = [0.20, 0.21, 0.25];
  const CAP = [0.50, 0.52, 0.58];
  const LEG = [0.46, 0.48, 0.54], SNOW = [1.02, 1.04, 1.10];
  const hl = len * 0.5;

  /* --- rounded-bar cross-section, extruded along z ---
     A capsule outline: flat top (the grind face) with semicircular shoulders,
     so the silhouette curves instead of ending in the hard square edge the
     old slab had.
     THE LOOP MUST RUN CCW IN XY VIEWED FROM +z. It did not: the first version
     swept both shoulders top->bottom, which is CW (shoelace -0.037), so
     `extrude` wound EVERY side quad and BOTH end caps backwards. `pushTri`
     takes its normal from the winding and matProp is FrontSide, so all 40
     triangles of a rail bar (32 of a box crown) were back-facing: the top face
     was culled and you saw the interior of the bottom face 10 cm lower, i.e.
     Alexander's "the rail has no top face". Audited with
     `.bcode/agent-workspace/prop_mesh_qa.mjs` (per-component signed volume).
     Right shoulder now runs bottom->top and left top->bottom, which makes the
     wrap segments the flat top (leftward) and the flat bottom (rightward). */
  const barLoop = (halfW, cy, r, NA) => {
    const L = [], flat = Math.max(halfW - r, 0);
    for (let i = 0; i <= NA; i++) {                       // right shoulder, bottom -> top
      const a = -Math.PI * 0.5 + i / NA * Math.PI;
      L.push([flat + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    for (let i = 0; i <= NA; i++) {                       // left shoulder, top -> bottom
      const a = Math.PI * 0.5 + i / NA * Math.PI;
      L.push([-flat + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return L;
  };
  const extrude = (loop, z0, z1, colFn) => {
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      const A = [p[0], p[1], z0], Bp = [q[0], q[1], z0], C = [q[0], q[1], z1], D = [p[0], p[1], z1];
      const up = (p[1] + q[1]) * 0.5;
      pushTri(B, A, Bp, C, colFn(up)); pushTri(B, A, C, D, colFn(up));
    }
    let cx = 0, cy = 0;                                    // end caps
    for (const p of loop) { cx += p[0]; cy += p[1]; }
    cx /= loop.length; cy /= loop.length;
    const c1 = [cx, cy, z1], c0 = [cx, cy, z0];
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      pushTri(B, c1, [p[0], p[1], z1], [q[0], q[1], z1], CAP);
      pushTri(B, c0, [q[0], q[1], z0], [p[0], p[1], z0], CAP);
    }
  };

  /* --- snow at the foot of each leg -------------------------------------
     NOT a ramp at the deck ends. I built that first and MEASURED it in game:
     terrain_feat ramps the GROUND up over 1.2 m to a deck only +-0.36 m wide,
     and the near clipmap pitch is 2 m, so that strip is NEVER actually drawn -
     the ramp mesh had nothing to blend into and read as a floating vertical
     sail beside the rail. What a standalone mesh can do honestly is hide the
     leg/ground junction, and per the flag drift the shape rule is that a pile
     must be WIDER THAN IT IS TALL or it reads as a metal fin. */
  const footDrift = (cx, zc, r, hgt) => {
    const N = 7, top = [cx, hgt, zc];
    for (let i = 0; i < N; i++) {
      const a0 = i / N * Math.PI * 2, a1 = (i + 1) / N * Math.PI * 2;
      const w0 = r * (0.78 + 0.34 * Math.abs(Math.sin(a0 * 2.3 + cx)));
      const w1 = r * (0.78 + 0.34 * Math.abs(Math.sin(a1 * 2.3 + cx)));
      /* a1 BEFORE a0: with the ring running CCW in XZ, (apex, a0, a1) points the
         normal DOWN and inward, so the drift was culled from every eye above it
         (same bug as the bar loop). */
      pushTri(B, top, [cx + Math.cos(a1) * w1, 0, zc + Math.sin(a1) * w1 * 1.35],
                      [cx + Math.cos(a0) * w0, 0, zc + Math.sin(a0) * w0 * 1.35], SNOW);
    }
  };

  if (rail) {
    /* bar: top stays at h + 0.05 exactly (the deck invariant), shoulders rounded */
    const bw = Math.min(w, 0.20);                        // see BAR WIDTH above
    extrude(barLoop(bw, h, 0.05, 4), -hl, hl, up => (up > h ? STEEL : STEEL_D));
    /* A-frame legs. The old ones were single 9 cm posts straight down, which is
       not how a rail stands up - the splay is what makes it read as hardware. */
    const n = Math.max(2, Math.round(len / 4));
    for (let i = 0; i < n; i++) {
      const zc = -hl + 0.6 + i * (len - 1.2) / (n - 1);
      /* Build each leg from its two ENDPOINTS - top under the bar at x=0, base
         splayed out to x=+-spread - and derive the angle, rather than guessing a
         tilt. Guessing gave an inverted A whose feet converged under the bar. */
      const spread = 0.22, L = Math.hypot(spread, h), th = Math.asin(spread / L);
      for (const sx of [-1, 1]) {
        const g = box(0.070, L, 0.070, 0, 0, 0, LEG);
        g.rotateZ(th * sx);
        g.translate(sx * spread * 0.5, h * 0.5, zc);
        parts.push(g);
        parts.push(box(0.13, 0.035, 0.15, sx * spread, 0.017, zc, LEG));   // foot plate
        footDrift(sx * spread, zc, 0.30, 0.10);
      }
    }
  } else {
    /* box: rounded snow crown on top (top face stays at h + 0.08), wooden body */
    extrude(barLoop(w, h + 0.03, 0.05, 3), -hl, hl, up => (up > h + 0.03 ? SNOW : [0.80, 0.83, 0.90]));
    parts.push(box(w * 2, 0.10, len, 0, h - 0.03, 0, [0.80, 0.83, 0.90]));
    parts.push(box(w * 2 - 0.06, h - 0.02, len - 0.1, 0, (h - 0.02) * 0.5, 0, [0.42, 0.30, 0.20]));
  }
  parts.push(bufGeo(B));
  return mergeGeos(parts);
}
/* chairlift: tubular towers + sheave trains + CATENARY cable + chairs running
   both directions, with a terminal shed at each end.
   MEASURED: the mast is ~180-240 px tall at the rider's closest approach (the
   lift is placed 52-78 m off the piste and the mast is 9-12 m), which makes this
   the tallest prop in the game and the only one that breaks the skyline - so the
   silhouette is what has to be right. */
function liftGroup(z0, latFn) {
  const grp = new THREE.Group();
  const mat = objMat({ wrap: 0.35, spec: 0.15 });
  const parts = [], SPAN = 65, N = 12;
  const STEEL = [0.44, 0.46, 0.52], STEEL_D = [0.33, 0.35, 0.41];
  const ARM = [0.50, 0.52, 0.58], DARK = [0.16, 0.17, 0.19];
  const SHED = [0.28, 0.31, 0.36], SNOWC = [1.02, 1.04, 1.10];
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const z = z0 + i * SPAN, x = latFn(z), y = terrainH(x, z);
    pts.push(new THREE.Vector3(x, y, z));
  }
  /* Tower height and cable height are now SHARED by the geometry and the tick.
     The old tick used the height of the tower it had just passed, so a chair
     STEPPED vertically at every tower where the height changed. */
  const TH = i => 9 + (i % 3) * 1.2;
  const CY = i => pts[i].y + TH(i) - 1.0;
  const SIDES = [-2.2, 2.2], SAG = 2.4, CSEG = 5;
  /* A real cable hangs in a catenary. Over a 65 m span at this sag a parabola is
     within a couple of centimetres of one and costs a single multiply, so the
     geometry and the chairs share this one closed form. */
  const cableAt = (i, f, side, o) =>
    o.set(lerp(pts[i].x, pts[i + 1].x, f) + side,
          lerp(CY(i), CY(i + 1), f) - SAG * 4 * f * (1 - f),
          lerp(pts[i].z, pts[i + 1].z, f));

  const B = TriBuf();
  const _a = new THREE.Vector3(), _b = new THREE.Vector3();
  const _u = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
  /* 3-sided prism. At the closest approach the cable is ~2 px wide, so what
     matters is that it never vanishes edge-on (a ribbon does), not roundness.
     Winding: with _v = _w x _u the angle runs _u -> _v, so (p,p2,q) faces out. */
  const tube3 = (a, b, r, col) => {
    _w.subVectors(b, a); if (_w.lengthSq() < 1e-9) return; _w.normalize();
    _u.set(0, 1, 0).cross(_w);
    if (_u.lengthSq() < 1e-6) _u.set(1, 0, 0); else _u.normalize();
    _v.crossVectors(_w, _u).normalize();
    const p = [], q = [];
    for (let k = 0; k < 3; k++) {
      const t = k / 3 * Math.PI * 2, c = Math.cos(t) * r, s = Math.sin(t) * r;
      p.push([a.x + _u.x * c + _v.x * s, a.y + _u.y * c + _v.y * s, a.z + _u.z * c + _v.z * s]);
      q.push([b.x + _u.x * c + _v.x * s, b.y + _u.y * c + _v.y * s, b.z + _u.z * c + _v.z * s]);
    }
    for (let k = 0; k < 3; k++) { const k2 = (k + 1) % 3;
      pushTri(B, p[k], p[k2], q[k], col); pushTri(B, p[k2], q[k2], q[k], col); }
  };
  /* n-gon prism about a vertical axis - the bull wheel at each terminal */
  const disc = (cx, cy, cz, r, th, nseg, col, colSide) => {
    const c0 = [cx, cy - th * 0.5, cz], c1 = [cx, cy + th * 0.5, cz];
    for (let k = 0; k < nseg; k++) {
      const a0 = k / nseg * Math.PI * 2, a1 = (k + 1) / nseg * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * r, z0b = cz + Math.sin(a0) * r;
      const x1 = cx + Math.cos(a1) * r, z1b = cz + Math.sin(a1) * r;
      const lo0 = [x0, cy - th * 0.5, z0b], lo1 = [x1, cy - th * 0.5, z1b];
      const hi0 = [x0, cy + th * 0.5, z0b], hi1 = [x1, cy + th * 0.5, z1b];
      /* All four were wound inward (both bull wheels, 32 tris each, were
         inside out and therefore invisible - found by the same signed-volume
         audit as the rail bar). The rim runs CCW in XZ, so an outward side quad
         is (lo0, hi1, lo1), the top cap fans (c1, hi1, hi0) and the bottom
         (c0, lo0, lo1). */
      pushTri(B, lo0, hi1, lo1, colSide); pushTri(B, lo0, hi0, hi1, colSide);
      pushTri(B, c1, hi1, hi0, col); pushTri(B, c0, lo0, lo1, col);
    }
  };

  for (let i = 0; i <= N; i++) {
    const p = pts[i], H = TH(i);
    /* tubular tapered mast (a modern lift tower is a tube, not a lattice) */
    const NS = 6, rAt = y => 0.40 - 0.13 * (y / H);
    const stops = [0.0, H * 0.55, H];
    for (let k = 0; k < NS; k++) {
      const b0 = k / NS * Math.PI * 2 + 0.26, b1 = (k + 1) / NS * Math.PI * 2 + 0.26;
      for (let j = 0; j < stops.length - 1; j++) {
        const y0 = stops[j], y1 = stops[j + 1], r0 = rAt(y0), r1 = rAt(y1);
        const col = j === 0 ? STEEL_D : STEEL;
        const A = [p.x + Math.cos(b0) * r0, p.y + y0, p.z + Math.sin(b0) * r0];
        const Bp = [p.x + Math.cos(b0) * r1, p.y + y1, p.z + Math.sin(b0) * r1];
        const C = [p.x + Math.cos(b1) * r0, p.y + y0, p.z + Math.sin(b1) * r0];
        const D = [p.x + Math.cos(b1) * r1, p.y + y1, p.z + Math.sin(b1) * r1];
        pushTri(B, A, Bp, C, col); pushTri(B, Bp, D, C, col);
      }
    }
    parts.push(box(1.5, 0.5, 1.5, p.x, p.y + 0.25, p.z, STEEL_D));      // footing
    parts.push(box(5.4, 0.34, 0.34, p.x, p.y + H, p.z, ARM));            // crossarm
    /* sheave train under each arm end: the assembly the cable actually rides */
    for (const side of SIDES) {
      parts.push(box(1.5, 0.20, 0.20, p.x + side, p.y + H - 0.34, p.z, STEEL_D));
      for (const dz of [-0.42, 0.42])
        parts.push(box(0.34, 0.34, 0.13, p.x + side + dz, p.y + H - 0.62, p.z, DARK));
    }
    /* catenary cable to the next tower */
    if (i < N) for (const side of SIDES) for (let k = 0; k < CSEG; k++) {
      cableAt(i, k / CSEG, side, _a); cableAt(i, (k + 1) / CSEG, side, _b);
      tube3(_a, _b, 0.075, DARK);
    }
  }
  /* terminal shed + bull wheel at both ends - the lift used to begin and end in
     nothing, which is what made it read as scenery rather than a machine. */
  for (const i of [0, N]) {
    const p = pts[i], H = TH(i), zf = i === 0 ? -1 : 1;
    const cz = p.z + zf * 3.6;
    parts.push(box(7.0, 3.4, 5.4, p.x, p.y + 1.7, cz, SHED));
    parts.push(box(7.8, 0.26, 6.0, p.x, p.y + 3.53, cz, STEEL_D));
    parts.push(box(7.4, 0.14, 5.6, p.x, p.y + 3.73, cz, SNOWC));
    parts.push(box(0.5, H - 1.4, 0.5, p.x, p.y + (H - 1.4) * 0.5, cz, STEEL_D));
    disc(p.x, CY(i) - 0.2, cz, 2.2, 0.36, 8, STEEL, STEEL_D);
  }
  parts.push(bufGeo(B));
  grp.add(new THREE.Mesh(mergeGeos(parts), mat));

  const chairGeo = mergeGeos([
    box(0.07, 1.7, 0.07, 0, 0.85, 0, [0.25, 0.26, 0.30]),
    box(1.7, 0.14, 0.7, 0, 0.05, 0, [0.20, 0.34, 0.55]),
    box(1.7, 0.9, 0.12, 0, 0.5, -0.3, [0.22, 0.38, 0.60]),
    box(0.5, 0.75, 0.4, -0.45, 0.5, 0.05, [0.85, 0.35, 0.25]),
    box(0.42, 0.42, 0.42, -0.45, 1.05, 0.05, [0.92, 0.74, 0.60]),
    box(0.5, 0.75, 0.4, 0.45, 0.5, 0.05, [0.30, 0.42, 0.70]),
    box(0.42, 0.42, 0.42, 0.45, 1.05, 0.05, [0.88, 0.70, 0.56])
  ]);
  const chairs = [];
  const cm = objMat({ wrap: 0.3 });
  for (let i = 0; i < 14; i++) { const m = new THREE.Mesh(chairGeo, cm); grp.add(m); chairs.push(m); }
  const _c = new THREE.Vector3();
  /* Chairs ride BOTH cables in opposite directions (a real lift does), hang from
     the catenary rather than a straight line, and face the way they travel.
     Same 14 iterations as before, so the tick cost is unchanged. */
  grp.userData.tick = (t) => {
    for (let i = 0; i < chairs.length; i++) {
      const dn = i & 1, side = dn ? SIDES[1] : SIDES[0];
      let u = (i >> 1) / (chairs.length >> 1) + t * 0.0055 * (dn ? -1 : 1);
      u = u - Math.floor(u);
      const fi = u * N, i0 = Math.min(Math.floor(fi), N - 1), fr = fi - i0;
      cableAt(i0, fr, side, _c);
      chairs[i].position.set(_c.x, _c.y - 1.45, _c.z);
      chairs[i].rotation.y = dn ? Math.PI : 0;
      chairs[i].rotation.z = Math.sin(t * 0.7 + i) * 0.04;
    }
  };
  /* PB9: the TOWERS are solid. Radius 0.85 covers the 1.5 m footing box and the
     0.40 m mast base with a little margin - you are meant to feel a steel pole,
     not thread a needle. Built from `pts` and TH, the same numbers the masts are
     drawn from, so the collider cannot drift from the geometry.
     Everything else on the lift stays non-solid on purpose: the cables are 7 cm
     tubes, the chairs hang 4.2-6.6 m above the snow (unreachable except off a
     big jump, and a solid moving chair would need a moving collider), and the
     terminal sheds sit at the ends of a 780 m line, far off-piste - making them
     solid is all risk of an invisible wall for no gameplay.
     NOTE this Group is never positioned (props_world.js:1040) and never
     regrounded, so its parts are already in WORLD metres and `top` is a world y,
     which is consistent because the query adds o.position.y = 0. */
  /* A TERMINAL MAST IS CAPPED AT THE SHED ROOF, and that is load-bearing.
     MEASURED: the mast stands at pts[i].z while the shed cap ends 0.8 m short of
     it, so the mast's 0.85 + 0.42 rider cylinder overlaps the roof lip. With the
     mast solid to its full height, landing on the new snowy top and sliding off
     the downhill end was a GUARANTEED wipeout ("hit a lift tower") - a flat roof
     has nothing to slow you, so you exit across that lip every single time. That
     turns the one surface Alexander asked to be able to slide off into a death
     trap, which is worse than the phase-through it replaced.
     Capping at the shed's wall top (+3.40) is the same trick that lets a cabin
     wall and its roof coexist: below the roof the mast is solid, above it the
     roof owns the space. The cost is that the upper mast and bull wheel are
     non-solid while you are up there, consistent with the bull-wheel column
     already being non-solid. Mid-line towers (0 < i < N) keep their full height. */
  const tcol = [];
  for (let i = 0; i <= N; i++) {
    const term = (i === 0 || i === N);
    tcol.push(pcCyl(pts[i].x, pts[i].z, 0.85, pts[i].y + (term ? 3.40 : TH(i))));
  }
  grp.userData.col = pcMake('tower', tcol);
  /* PB9b: THE TERMINAL SHED IS A BUILDING, so it gets what a building gets -
     solid walls and a RIDE-ON snowy top. Alexander rode straight through the big
     snow-capped box and reported it, correctly: it is the most roof-like surface
     in the game and it was the one thing you could not land on. My original PB9
     note claimed the terminals sit "far off-piste... all risk for no gameplay";
     MEASURED at his report the shed was 1.9 m off his lateral line, so that
     reasoning was simply wrong.
     The lift's own geometry is baked in ABSOLUTE world coordinates with the mesh
     at the group origin, so the group cannot serve as a platAt/propHit frame
     (its position is 0,0,0 while its vertices are 500 m away). Each terminal
     therefore gets an empty anchor Object3D at its own world position, which is
     the frame both queries need. Numbers below are read straight off the four
     boxes pushed above, per the props_build.js:53 rule:
       body      7.0 x 3.4 x 5.4  at y+1.7  -> walls hx 3.5, hz 2.7, top y+3.40
       roof slab 7.8 x 0.26       at y+3.53
       snow cap  7.4 x 0.14       at y+3.73 -> WALKABLE SURFACE at y+3.80
     The cap overhangs the wall by 0.2 m, the same sign as a cabin eave, so
     sliding off the edge does not clip the wall on the way down.
     The bull-wheel column (0.5 x 0.5, dead centre of the cap) is left NON-solid
     on purpose: it pierces the walkable surface exactly as a cabin chimney
     pierces its roof, and making it solid would put an obstacle in the middle of
     the only thing Alexander asked to be able to slide across. */
  const terms = [];
  for (const i of [0, N]) {
    const p = pts[i], cz = p.z + (i === 0 ? -1 : 1) * 3.6;
    const a = new THREE.Object3D();
    a.position.set(p.x, p.y, cz);
    a.name = 'liftterm';
    /* FLAT platform: rise 0 and sl 0 collapse platAt's gable arithmetic to a
       level surface with a straight-up normal. `half` still divides, so it must
       stay non-zero even though rise is 0. */
    a.userData.plat = { half: 3.7, rise: 0, sl: 0, base: 3.80, hx: 3.7, hz: 2.8 };
    a.userData.col = pcMake('shed', [pcBox(3.5, 2.7, 3.40)]);
    grp.add(a); terms.push(a);
  }
  grp.userData.terms = terms;
  return grp;
}
