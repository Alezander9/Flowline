/* ===================================================== rider: body assembly
   Soft parts (jacket, pants, knit) go in one buffer that takes the fabric map;
   hard parts (board, boots, helmet, goggles, mittens) go in a second buffer
   with a specular term. Two SkinnedMeshes, one Skeleton, 25 bones. */

const REG = {
  TORSO: ['pelvis', 'spine1', 'spine2', 'chest', 'neck', 'clavF', 'clavB'],
  NECK: ['chest', 'neck', 'head'],
  ARMF: ['chest', 'clavF', 'upperF', 'foreF', 'handF'],
  ARMB: ['chest', 'clavB', 'upperB', 'foreB', 'handB'],
  LEGF: ['pelvis', 'thighF', 'shinF', 'footF'],
  LEGB: ['pelvis', 'thighB', 'shinB', 'footB'],
  SCARF: ['neck', 'scarf0', 'scarf1', 'scarf2'],
  SEAT: ['pelvis', 'spine1', 'thighF', 'thighB'],
};

function buildRiderB(rig, pal) {
  const soft = new GeoBuf(), hard = new GeoBuf();
  const { bind: P, index: BI, J } = rig;
  const shoulderAx = yawV(CHEST_YAW, 1);
  const front = J.front.clone();

  /* ---------------- jacket: one twisting sweep, hem to collar -------------
     The cross-section frame rotates from the hip line at the hem to the
     shoulder line at the collar, so the hem can flare across the hips (where
     the thighs are) while the chest still follows the stance twist. */
  soft.reg = REG.TORSO;
  const hem = P.pelvis.clone().add(V3(0, -0.034, 0));
  const hipAx = yawV(Math.PI / 2, 1);                 // the hip line, board-long
  const twist = t => {
    const u = smoothstep(0.10, 0.65, t);
    return yawV(lerp(Math.PI / 2, CHEST_YAW, u), 1);
  };
  const torsoPts = [0, 0.035, 0.09, 0.19, 0.34, 0.54, 0.72, 0.86, 0.95, 1]
    .map(t => hem.clone().lerp(P.neck, t));
  soft.addPath({
    pts: torsoPts, R: 22, ref: hipAx, refFn: twist, col: pal.jacket,
    uvw: 2.0, uvv0: 0, uvv1: 1.15, dome0: 0.14, dome1: 0.10,
    prof: [
      [0.00, 0.190, 0.110, 0.16, pal.jacketD],   // drawcord hem band
      [0.035, 0.202, 0.118, 0.15, pal.jacketD],
      [0.09, 0.198, 0.117, 0.16, pal.jacket],    // bell, sits over the hips
      [0.19, 0.178, 0.112, 0.20, pal.jacket],
      [0.34, 0.156, 0.104, 0.28, pal.jacket],
      [0.54, 0.152, 0.108, 0.28, pal.jacket],
      [0.72, 0.170, 0.120, 0.30, pal.jacket],
      [0.86, 0.186, 0.128, 0.46, pal.jacket],
      [0.95, 0.148, 0.112, 0.34, pal.jacket],
      [1.00, 0.108, 0.098, 0.28, pal.jacketD],
    ]
  });
  /* shoulder caps: the deltoid dome has to be WIDER than the sleeve's first
     ring, or the sleeve exits through it and leaves a ledge (and a sliver of
     background) in the silhouette. Pulled slightly in toward the chest so it
     blends into the torso as well. */
  for (const [sh, reg] of [[P.upperF, REG.ARMF], [P.upperB, REG.ARMB]]) {
    soft.reg = reg;
    const inw = sh.clone().sub(P.chest).normalize().multiplyScalar(-0.014);
    const c = sh.clone().add(inw).add(V3(0, 0.010, 0));
    soft.addGeo(ico(0.103, 3), new THREE.Matrix4().makeTranslation(c.x, c.y, c.z),
      pal.jacket, undefined, [0.35, 0.6]);
  }
  // zip placket + chest pocket + hem cord, on the chest front
  soft.reg = REG.TORSO;
  const put = (buf, g, col, pos, rot, hint) => {
    const m = new THREE.Matrix4().makeRotationY(Math.atan2(front.x, front.z));
    if (rot) m.multiply(rot);
    m.setPosition(pos.x, pos.y, pos.z);
    return buf.addGeo(g, m, col, hint, [0.42, 0.35]);
  };
  put(soft, roundBox(0.028, 0.30, 0.03, 0.012, 6), pal.jacketD,
    P.chest.clone().addScaledVector(front, 0.118).add(V3(0, -0.06, 0)));
  put(soft, roundBox(0.10, 0.062, 0.05, 0.02, 6), pal.jacketD,
    P.chest.clone().addScaledVector(front, 0.098).addScaledVector(shoulderAx, 0.075).add(V3(0, -0.11, 0)));
  // hood bundled behind the collar
  put(soft, roundBox(0.196, 0.086, 0.104, 0.042, 12), pal.jacketD,
    P.neck.clone().addScaledVector(front, -0.076).add(V3(0, -0.076, 0)));

  /* ------------- sleeves and pants: ONE continuous path per limb ---------
     A single swept path from shoulder (or hip) to the wrist (or boot) means
     there is no seam ring at the elbow or knee at all, and the profile can
     carry a kneepad bulge, a calf and a cuff that flares over the boot. */
  const lerpV = (a, b, t) => a.clone().lerp(b, t);
  const chainPts = (a, b, c, fs1, fs2) => {
    const pts = fs1.map(t => lerpV(a, b, t));
    for (const t of fs2) pts.push(lerpV(b, c, t));
    return pts;
  };
  const arm = (buf, reg, sh, el, wr, hbi) => {
    buf.reg = reg;
    // start the sleeve inside the torso: a cap that surfaces reads as a patch
    const shIn = sh.clone().addScaledVector(sh.clone().sub(el).normalize(), 0.040);
    buf.addPath({
      pts: chainPts(shIn, el, wr, [0, 0.30, 0.64, 1], [0.28, 0.58, 0.85, 1]),
      R: 16, ref: shoulderAx, col: pal.jacket, uvw: 1.8, uvv0: 0, uvv1: 1.2, dome0: 0.6, dome1: 0.5,
      // the last rings live inside the mitt gauntlet: pin them rigidly to the
      // hand bone, else a wrist rotation swings them out of the rigid mitt
      hintFn: t => t > 0.925 ? hbi : null,
      prof: [
        [0.00, 0.092, 0.092, 0.22, pal.jacket],
        [0.16, 0.083, 0.083, 0.18, pal.jacket],
        [0.36, 0.074, 0.075, 0.16, pal.jacket],
        [0.50, 0.072, 0.074, 0.20, pal.jacket],   // elbow
        [0.64, 0.067, 0.068, 0.16, pal.jacket],
        [0.86, 0.059, 0.060, 0.18, pal.jacket],
        [0.94, 0.052, 0.053, 0.24, pal.jacketD],  // cuff band, tapering: the
        [1.00, 0.042, 0.043, 0.34, pal.jacketD],  // mitt gauntlet covers it
      ]
    });
  };
  arm(soft, REG.ARMF, P.upperF, P.foreF, P.handF, BI.handF);
  arm(soft, REG.ARMB, P.upperB, P.foreB, P.handB, BI.handB);

  /* pants: hip (up inside the jacket) -> knee -> mid shin, ending in a gaiter
     cuff that sits over the boot shell. */
  const leg = (buf, reg, hip, knee, ankle, fbi) => {
    buf.reg = reg;
    const top = hip.clone().add(V3(0, 0.042, 0));
    /* the hem has to end BELOW the boot cuff rim (BOOT.cuffTop above the ankle),
       or its near-flat end cap floats in the open as a 18cm plate */
    const cuffEnd = lerpV(knee, ankle, 1 - 0.052 / Math.max(0.12, knee.distanceTo(ankle)));
    const pts = chainPts(top, knee, cuffEnd, [0, 0.26, 0.52, 0.78, 1], [0.3, 0.62, 1]);
    const kneeOut = J.front.clone().multiplyScalar(0.020);   // kneecap juts forward
    pts[3].addScaledVector(kneeOut, 0.45); pts[4].add(kneeOut);
    pts[5].addScaledVector(kneeOut, 0.35);
    buf.addPath({
      pts,
      R: 18, ref: shoulderAx, col: pal.pants, uvw: 2.2, uvv0: 0, uvv1: 1.25,
      dome0: 0.5, dome1: 0.16,
      // the hem sits around the rigid boot: pin it to the foot bone as well
      hintFn: t2 => t2 > 0.945 ? fbi : null,
      prof: [
        [0.00, 0.092, 0.100, 0.32, pal.pants],
        [0.14, 0.095, 0.103, 0.26, pal.pants],
        [0.34, 0.095, 0.102, 0.22, pal.pants],
        [0.52, 0.094, 0.102, 0.22, pal.pants],
        [0.60, 0.095, 0.105, 0.26, pal.pants],   // crease above the knee
        [0.64, 0.098, 0.111, 0.36, pal.pants],   // kneepad
        [0.68, 0.094, 0.105, 0.28, pal.pants],   // crease below
        [0.76, 0.094, 0.104, 0.24, pal.pants],
        [0.86, 0.093, 0.101, 0.24, pal.pants],
        [0.92, 0.095, 0.101, 0.30, pal.pantsD],  // gaiter over the boot cuff
        [1.00, 0.088, 0.092, 0.44, pal.pantsD],
      ]
    });
  };
  leg(soft, REG.LEGF, P.thighF, P.shinF, P.footF, BI.footF);
  leg(soft, REG.LEGB, P.thighB, P.shinB, P.footB, BI.footB);
  // cargo pocket on the outer thigh, knee patch over the pad
  for (const [reg, hip, knee] of [[REG.LEGF, P.thighF, P.shinF], [REG.LEGB, P.thighB, P.shinB]]) {
    soft.reg = reg;
    const mid = lerpV(hip, knee, 0.52);
    put(soft, roundBox(0.086, 0.100, 0.026, 0.012, 8), pal.pantsD,
      mid.clone().addScaledVector(front, 0.099).add(V3(0, 0.010, 0)));
    put(soft, roundBox(0.098, 0.086, 0.024, 0.011, 8), pal.pantsD,
      lerpV(hip, knee, 0.96).addScaledVector(front, 0.117));
  }

  /* pelvis: a barrel across the hip line that both thighs grow out of, so the
     legs are continuous with a seat instead of two tubes under a hem */
  soft.reg = REG.SEAT;
  soft.addPath({
    pts: [V3(0, 0.496, -0.086), V3(0, 0.502, -0.040), V3(0, 0.502, 0.040), V3(0, 0.496, 0.086)],
    R: 18, ref: V3(0, 1, 0), col: pal.pants, uvw: 1.4, dome0: 0.45, dome1: 0.45,
    prof: [
      [0.00, 0.078, 0.100, 0.40, pal.pantsD],
      [0.30, 0.088, 0.110, 0.34, pal.pants],
      [0.70, 0.088, 0.110, 0.34, pal.pants],
      [1.00, 0.078, 0.100, 0.40, pal.pantsD],
    ]
  });

  /* ---------------- knit neck warmer ---------------- */
  soft.reg = REG.NECK;
  soft.addSweep({
    a: P.neck.clone().add(V3(0, -0.030, 0)), b: P.neck.clone().add(V3(0, 0.088, 0)), R: 12,
    ref: shoulderAx, col: pal.knit, cap0: false, cap1: false, uvw: 1.6, uvv0: 0, uvv1: 0.5,
    prof: [[0.0, 0.112, 0.104, 0.3, pal.knit], [0.4, 0.089, 0.085, 0.25, pal.knit],
    [0.8, 0.076, 0.073, 0.25, pal.knit], [1.0, 0.079, 0.075, 0.25, pal.knitD]]
  });

  /* ---------------- scarf tail: a curling ribbon shell ---------------------
     A swept tube (or a flat plate) reads as webbing from every angle. A knit
     tail is a SURFACE: sampled along a Catmull chain, it gets a parabolic curl
     across its width whose sign ripples along the length, and the whole
     cross-section rolls - so it catches light like cloth in the wind. */
  soft.reg = REG.SCARF;
  {
    const curve = new THREE.CatmullRomCurve3([P.scarf0, P.scarf1, P.scarf2]);
    const up = V3(0, 1, 0);
    soft.addShell({
      nu: 9, nv: 4, thick: 0.008, flip: true, uvw: 0.22, uvv: 1.6,
      col: (u, v, side) => side === 1 ? pal.knitD
        : (u > 0.52 && u < 0.72 ? pal.knitL : (u > 0.88 ? pal.knitD : pal.knit)),
      at: (u, v) => {
        const p = curve.getPoint(u), tg = curve.getTangent(u).normalize();
        const w = new THREE.Vector3().crossVectors(tg, up).normalize()
          .applyAxisAngle(tg, 1.25 * u);
        const n = new THREE.Vector3().crossVectors(tg, w).normalize();
        const s = v * 2 - 1;
        const hw = 0.060 * (1 - 0.22 * u);
        const curl = 0.024 * Math.sin(u * 4.2 + 0.5);
        return p.clone().addScaledVector(w, hw * s)
          .addScaledVector(n, curl * (s * s - 0.333));
      }
    });
  }

  /* ================= hard parts ================= */
  hard.reg = null;
  boardSweep(hard, null, pal, BI.board);

  // boots: swept sole, shell last and cuff, built from the shared BOOT dims so
  // the sole lands on the binding baseplate and the straps clear the shell
  const boot = (ankle, ang, bi) => {
    const rotY = new THREE.Matrix4().makeRotationY(ang);
    const base = new THREE.Matrix4().makeTranslation(ankle.x, ankle.y, ankle.z).multiply(rotY);
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const B = BOOT;
    const sweep = (pts, prof, R, o) => hard.addPath(Object.assign({
      pts: pts.map(p => p.applyMatrix4(base)), prof, R,
      ref: new THREE.Vector3(1, 0, 0).transformDirection(rotY), hint: bi, col: pal.boot
    }, o || {}));
    const put2 = (g, col, x, y, z) => {
      const m = base.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z));
      hard.addGeo(g, m, col, bi);
    };
    // outsole
    sweep([V(0, B.soleY + 0.002, B.heelZ + 0.008), V(0, B.soleY - 0.003, -0.020),
    V(0, B.soleY - 0.001, 0.070), V(0, B.soleY + 0.008, B.toeZ - 0.010)],
      [[0, 0.050, B.soleT * 0.85, 0.68, pal.bootSole], [0.18, B.soleHW, B.soleT, 0.84, pal.bootSole],
      [0.76, B.soleHW, B.soleT, 0.84, pal.bootSole], [1, 0.046, B.soleT * 0.8, 0.7, pal.bootSole]],
      14, { dome0: 0.5, dome1: 0.5 });
    // shell last, heel to toe
    sweep([V(0, B.lastY + 0.006, B.heelZ + 0.012), V(0, B.lastY, -0.020),
    V(0, B.lastY - 0.004, 0.062), V(0, B.lastY - 0.012, B.toeZ - 0.016)],
      [[0, 0.049, 0.047, 0.48, pal.boot], [0.22, B.lastHX, B.lastHY, 0.62, pal.boot],
      [0.74, B.lastHX - 0.003, 0.040, 0.64, pal.boot], [1, 0.043, 0.027, 0.58, pal.boot]],
      16, { dome0: 0.6, dome1: 0.45 });
    // cuff up the shin
    sweep([V(0, B.lastY + 0.024, B.cuffZ + 0.006), V(0, 0.032, B.cuffZ - 0.004),
    V(0, B.cuffTop, B.cuffZ - 0.012)],
      [[0, B.cuffHX, B.cuffHZ, 0.52, pal.boot], [0.55, B.cuffHX, B.cuffHZ - 0.005, 0.46, pal.boot],
      [1, B.cuffHX + 0.002, B.cuffHZ - 0.010, 0.4, pal.boot]],
      16, { dome0: 0.25, dome1: 0.3 });
    // tongue, power strap, heel loop
    put2(roundBox(0.084, 0.098, 0.028, 0.012, 8), pal.bootLace, 0, 0.026, B.cuffZ + B.cuffHZ - 0.008);
    put2(roundBox(0.140, 0.026, 0.152, 0.011, 12), pal.bootSole, 0, 0.050, B.cuffZ);
    put2(roundBox(0.030, 0.030, 0.022, 0.009, 6), pal.bootLace, 0, 0.030, B.cuffZ - B.cuffHZ - 0.002);
  };
  boot(P.footF, 0.30, BI.footF);
  boot(P.footB, -0.10, BI.footB);

  // mittens, bolted to the hand bones
  /* mitten: swept along the FORE-ARM axis (a world-down mitt reads as a mitt
     glued on sideways and exposes the sleeve cuff), with a gauntlet cuff that
     swallows the sleeve end, fingers curling toward the palm, own thumb sweep */
  const mitt = (el, wr, bi, sgn) => {
    const d = wr.clone().sub(el).normalize();                    // fore-arm axis
    const tD = front.clone().addScaledVector(d, -front.dot(d)).normalize(); // palm side
    const wAx = new THREE.Vector3().crossVectors(tD, d).normalize();  // across palm
    const at = (a, b2, c) => wr.clone().addScaledVector(d, a)
      .addScaledVector(tD, b2).addScaledVector(wAx, sgn * (c || 0));
    hard.addPath({
      pts: [at(-0.078, 0), at(-0.038, 0), at(0.006, 0), at(0.048, 0.004),
      at(0.090, 0.016), at(0.128, 0.036), at(0.152, 0.062)],
      R: 16, ref: wAx, col: pal.glove, hint: bi, dome0: -0.45, dome1: 0.9,
      prof: [
        [0.00, 0.068, 0.062, 0.26, pal.gloveD],   // mouth: clears the tapering
        [0.15, 0.070, 0.062, 0.26, pal.gloveD],   // sleeve, then flares to the
        [0.30, 0.064, 0.056, 0.28, pal.gloveD],   // gauntlet bell, then cinches
        [0.38, 0.062, 0.054, 0.30, pal.glove],    // wrist
        [0.56, 0.062, 0.050, 0.36, pal.glove],    // palm
        [0.71, 0.059, 0.044, 0.38, pal.glove],    // knuckles
        [0.88, 0.049, 0.037, 0.42, pal.glove],
        [1.00, 0.031, 0.025, 0.50, pal.glove],
      ]
    });
    hard.addPath({                                                     // thumb
      pts: [at(0.026, 0.020, 0.030), at(0.070, 0.046, 0.048), at(0.108, 0.066, 0.056)],
      R: 10, ref: d, col: pal.glove, hint: bi, dome0: 0.3, dome1: 0.95,
      prof: [[0, 0.029, 0.029, 0.36, pal.glove], [0.55, 0.026, 0.025, 0.42, pal.glove],
      [1, 0.017, 0.016, 0.50, pal.glove]]
    });
  };
  mitt(P.foreF, P.handF, BI.handF, 1);
  mitt(P.foreB, P.handB, BI.handB, -1);

  // head: helmet shell, brim, goggles, face, ear pads - rigid to the head bone
  const hb = BI.head, hp = P.head.clone().add(V3(0, 0.022, 0));
  const faceYaw = Math.atan2(front.x, front.z);
  const H = (g, col, off, rot, spec) => {
    const m = new THREE.Matrix4().makeRotationY(faceYaw);
    if (rot) m.multiply(rot);
    const pos = hp.clone().addScaledVector(front, off[2]).add(V3(0, off[1], 0))
      .addScaledVector(shoulderAx, off[0]);
    m.setPosition(pos.x, pos.y, pos.z);
    hard.addGeo(g, m, col, hb);
  };
  const squashZ = new THREE.Matrix4().makeScale(0.94, 1.0, 0.86);
  H(ico(0.092, 2), pal.skin, [0, -0.018, -0.004], squashZ);                         // skull / face
  H(helmetShell(0.120, 1.00), pal.helmet, [0, -0.016, -0.008]);                      // shell
  // goggles: swept arcs, so the visor is one continuous wrap instead of a slab
  const hL = (x, y, z) => hp.clone().addScaledVector(shoulderAx, x).add(V3(0, y, 0))
    .addScaledVector(front, z);
  const UP = new THREE.Vector3(0, 1, 0);
  hard.addPath({                                                                    // frame
    pts: bez(hL(-0.101, -0.011, 0.014), hL(0, -0.007, 0.142), hL(0.101, -0.011, 0.014), 12),
    R: 8, ref: UP, col: pal.helmet, hint: hb, dome0: 0.4, dome1: 0.4,
    prof: [[0, 0.020, 0.013, 0.5, pal.helmet], [0.5, 0.027, 0.015, 0.55, pal.helmet],
    [1, 0.020, 0.013, 0.5, pal.helmet]]
  });
  hard.addPath({                                                                    // lens
    pts: bez(hL(-0.094, -0.008, 0.028), hL(0, -0.005, 0.168), hL(0.094, -0.008, 0.028), 12),
    R: 8, ref: UP, col: pal.lens, hint: hb, dome0: 0.4, dome1: 0.4,
    prof: [[0, 0.014, 0.009, 0.5, pal.lens], [0.5, 0.021, 0.011, 0.6, pal.lens],
    [1, 0.014, 0.009, 0.5, pal.lens]]
  });
  // strap: analytic arc around the shell (a bezier would chord straight through it)
  const A0 = 0.13, A1 = -(Math.PI + 0.13), CZ = -0.008, strapPts = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, a = lerp(A0, A1, t);
    const rr = lerp(0.1235, 0.128, clamp(Math.min(t, 1 - t) / 0.16, 0, 1));
    strapPts.push(hL(rr * Math.cos(a), -0.012 + 0.022 * Math.sin(Math.PI * t),
      CZ + rr * Math.sin(a)));
  }
  hard.addPath({
    pts: strapPts, R: 7, ref: UP, col: pal.helmet, hint: hb, dome0: 0.3, dome1: 0.3,
    uvw: 1.2, prof: [[0, 0.013, 0.007, 0.5, pal.helmet], [0.12, 0.017, 0.008, 0.5, pal.helmetL],
    [0.5, 0.019, 0.009, 0.5, pal.helmetL], [0.88, 0.017, 0.008, 0.5, pal.helmetL],
    [1, 0.013, 0.007, 0.5, pal.helmet]]
  });
  const earG = roundBox(0.034, 0.062, 0.058, 0.020, 8);                             // ear covers
  H(earG, pal.helmetL, [0.094, -0.050, -0.012]);
  H(earG, pal.helmetL, [-0.094, -0.050, -0.012]);
  H(roundBox(0.036, 0.030, 0.018, 0.008, 8), pal.helmetL, [0, -0.046, -0.112]);      // fit dial
  H(roundBox(0.122, 0.064, 0.084, 0.028, 10), pal.knitD, [0, -0.082, 0.022]);       // face mask
  const clipG = roundBox(0.016, 0.026, 0.032, 0.007, 8);                            // strap clips
  H(clipG, pal.helmetL, [0.1135, -0.012, 0.006]);
  H(clipG, pal.helmetL, [-0.1135, -0.012, 0.006]);

  return { soft, hard };
}
