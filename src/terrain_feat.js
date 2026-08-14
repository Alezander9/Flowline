/* ------------------------------------------------- terrain: features */
function branchCenter(b, z) {
  if (b.poach) return poachC(b, z);
  const t = clamp((z - b.z0) / b.len, 0, 1);
  return pisteC(z) + b.side * b.amp * (0.5 - 0.5 * Math.cos(TAU * t));
}
/* poach line: leaves the piste edge, arcs out through the trees and rejoins */
function poachC(p, z) {
  const t = clamp((z - p.z0) / p.len, 0, 1);
  const arc = Math.pow(Math.sin(Math.PI * t), 0.7);
  const env = Math.sin(Math.PI * t);
  return pisteC(z) + p.side * (pisteW(z) + 3.5 + p.amp * arc) + p.wig * Math.sin(t * p.wf * TAU + p.ph) * env;
}
const featCenter = (f, z) => (f.br ? branchCenter(f.br, z) : pisteC(z)) + f.lat;
const smoothFloor = z => baseY(z) + groomRoll(z);

function featureH(f, x, z, h) {
  const c = featCenter(f, z), dx = x - c, ax = Math.abs(dx);
  const t = (z - f.z0) / (f.z1 - f.z0);
  switch (f.t) {
    case 0: { // kicker ramp -> lip
      if (ax > f.w + 3) return h;
      /* Past the lip the ground drops instantly. A mesh row coarser than the
         lip cannot represent that, and the error changes as the ramp crosses a
         ring boundary - which is what made ramp tops twitch. So fade the lip
         out over a length that is zero at fine resolution (physics + near mesh
         keep the hard lip) and about one cell wide once cells get big. */
      const tl = LIPT();
      let ramp;
      if (z <= f.z1) ramp = t * t * (3 - 2 * t);
      else if (tl > 0.05) ramp = 1 - smoothstep(0, tl, z - f.z1);
      else return h;
      return h + f.hgt * ramp * smoothstep(f.w + 2.2, f.w - 0.8, ax);
    }
    case 1: { // gap / drop bowl
      const dip = -f.A * (f.z1 - f.z0) / TAU * (1 - Math.cos(TAU * t));
      return h + dip * smoothstep(f.w + 15, f.w + 1, ax);
    }
    case 2: { // rhythm rollers
      if (ax > f.w + 4) return h;
      const env = smoothstep(0, 0.12, t) * smoothstep(0, 0.12, 1 - t);
      const r = 0.5 - 0.5 * Math.cos(TAU * (z - f.z0) / f.wav);
      return h + f.amp * r * env * smoothstep(f.w + 3, f.w - 2, ax);
    }
    case 3: { // banked berm on one side
      const u = clamp((dx * f.side - f.lat0) / f.wid, 0, 1);
      const env = Math.sin(Math.PI * clamp(t, 0, 1)) ** 0.7;
      return h + f.hgt * Math.pow(u, 1.6) * env;
    }
    case 4: { // box / rail (solid flat top), riding on the ground it was built on
      if (ax > f.w) return h;
      const on = smoothstep(f.z0, f.z0 + (f.rail ? 1.2 : 2.6) + FRES, z);
      return h + f.hgt * on;
    }
    case 6: { // groomed pad: flatten the ground toward the piste floor
      if (ax > f.w + 6) return h;
      const g = smoothstep(f.w + 6, f.w - 1, ax) * smoothstep(0, 0.10, t) * smoothstep(0, 0.10, 1 - t);
      return h + (smoothFloor(z) + (f.rise || 0) - h) * g * (f.k || 1);
    }
    case 7: { // half pipe: flat floor, quarter-pipe walls both sides
      if (ax > f.w1 + 10) return h;
      const env = smoothstep(0, 0.06, t) * smoothstep(0, 0.06, 1 - t);
      const floor = smoothFloor(z) - f.deck * 0.10;
      let y = floor;
      if (ax > f.w0) {
        const u = clamp((ax - f.w0) / (f.w1 - f.w0), 0, 1);
        y = floor + f.deck * (1 - Math.sqrt(Math.max(0, 1 - u * u)));
        if (ax > f.w1) y = floor + f.deck + (ax - f.w1) * 0.16;
      }
      const g = env * smoothstep(f.w1 + 10, f.w1 + 1, ax);
      return h + (y - h) * g;
    }
    case 8: { // cliff band: a clean drop, then the pitch steepens and recovers
      if (ax > f.w + 18) return h;
      const g = smoothstep(f.w + 18, f.w - 2, ax);
      // the lip is knife sharp for the rider, but softens once a mesh row
      // spans more than the drop itself - otherwise it terraces at distance
      const fall = smoothstep(f.z0 - 1.5 - FRES * 0.7, f.z0 + 2.0 + FRES * 1.3, z) * (1 - smoothstep(f.z0 + 55, f.z1, z));
      return h - f.drop * fall * g;
    }
    case 9: { // big air: smooth in-run, lip, gap, landing ramp
      if (ax > f.w + 12) return h;
      const g = smoothstep(f.w + 12, f.w - 2, ax);
      const fl = smoothFloor(z);
      const L = f.z1 - f.z0, zz = z - f.z0;
      const inRun = f.inRun, lip = f.lip, gap = f.gap, land = f.land;
      let y;
      if (zz < inRun) {                                   // groomed accelerating in-run
        y = fl - f.dive * smoothstep(0, inRun * 0.8, zz);
      } else if (zz < inRun + lip) {                      // kicker
        const u = (zz - inRun) / lip;
        y = fl - f.dive + f.kick * u * u;
      } else if (zz < inRun + lip + gap) {                // the gap: scooped out
        const u = (zz - inRun - lip) / gap, tl = LIPT();
        y = fl - f.dive - f.pit * Math.sin(Math.PI * u)
          + (tl > 0.05 ? f.kick * (1 - smoothstep(0, tl, zz - inRun - lip)) : 0);
      } else {                                            // landing ramp, back to grade
        const u = clamp((zz - inRun - lip - gap) / land, 0, 1);
        y = fl - f.dive + f.kick * 0.55 * (1 - u) * (1 - u);
      }
      const env = smoothstep(0, 0.02, zz / L) * (1 - smoothstep(0.94, 1.0, zz / L));
      return h + (y - h) * g * env;
    }
    case 5: { // wind lip / cornice roller on the piste edge
      if (ax > f.w + 4) return h;
      const env = Math.sin(Math.PI * clamp(t, 0, 1)) ** 0.8;
      return h + f.hgt * env * smoothstep(f.w + 3.5, f.w - 3, ax);
    }
  }
  return h;
}

/* ---------------- segment generation ---------------- */
/* The park draws from its own stream, so any segment's park span is known
   without building that segment: cliffs and other set pieces steer clear of
   it instead of dropping the ground out from under a rail. */
function parkRollOf(s) {
  const r = mulberry32(hashStr('park' + SEED + ':' + s));
  return { roll: r(), pz: s * SEG + 40 + r() * 50 };
}
function parkSpanOf(s) {
  if (s <= 0) return null;
  const p = parkRollOf(s);
  return p.roll < 0.30 ? [p.pz - 34, p.pz + 292] : null;   // superset of the built park
}
const spanFree = (s, a, b) => {
  for (let k = s - 1; k <= s + 1; k++) {
    const sp = parkSpanOf(k);
    if (sp && a < sp[1] && b > sp[0]) return false;
  }
  return true;
};

function buildSeg(s) {
  const z0 = s * SEG;
  const rnd = mulberry32(hashStr('fl' + SEED + ':' + s));
  const br = [], ft = [], pr = [], po = [];
  const R = (a, b) => a + rnd() * (b - a);
  const pick = arr => arr[Math.floor(rnd() * arr.length) % arr.length];

  if (s < 0) return { br, ft, pr, po, z0, label: null };

  // start area: a lodge, a gate, gentle ground
  if (s === 0) {
    // a flat groomed apron to stand on, then a clean roll-in
    ft.push({ t: 6, z0: -46, z1: 34, w: 26, lat: 0, br: null, k: 1, rise: 0 });
    ft.push({ t: 6, z0: 34, z1: 96, w: 24, lat: 0, br: null, k: 0.7, rise: 0 });
    pr.push({ k: 'lodge', z: -30, lat: -pisteW(0) - 24, rot: 0.35 });
    pr.push({ k: 'cabin', z: -16, lat: pisteW(0) + 17, rot: -0.5 });
    pr.push({ k: 'gate', z: 30, lat: 0 });
    pr.push({ k: 'sign', z: 30, lat: 0, side: 1, kind: 3 });
    for (let i = 0; i < 7; i++) pr.push({ k: 'flag', z: 34 + i * 38, lat: 0, side: i % 2 ? 1 : -1 });
    pr.push({ k: 'rocks', z: -8, lat: -pisteW(0) - 12, n: 3 });
    // a warm-up roller train
    ft.push({ t: 2, z0: 130, z1: 210, amp: 0.9, wav: 20, w: 18, lat: 0, br: null });
    return { br, ft, pr, po, z0, label: 'WARM UP' };
  }

  let label = null;
  const park = parkRollOf(s);

  /* ---- side route through the trees ---- */
  if (rnd() < 0.58) {
    const kind = rnd() < 0.42 ? 2 : 1;
    const b = {
      z0: z0 + R(20, 90), len: R(330, 560), side: rnd() < 0.5 ? -1 : 1,
      amp: R(44, 82), w: kind === 2 ? R(8.5, 12) : R(10, 15.5), kind
    };
    br.push(b);
    pr.push({ k: 'sign', z: b.z0 + 8, lat: b.side * 9, br: null, side: b.side, kind });
    // features down the side route
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const zz = b.z0 + b.len * (0.16 + 0.68 * (i + rnd() * 0.5) / n);
      const r = rnd();
      if (r < 0.34) {
        const L = R(6.5, 10);
        ft.push({ t: 0, z0: zz, z1: zz + L, hgt: R(1.5, 2.9), w: b.w * 0.62, lat: R(-2, 2), br: b });
      } else if (r < 0.6) {
        const L = R(52, 84);
        ft.push({ t: 1, z0: zz, z1: zz + L, A: R(0.26, 0.42), w: b.w, lat: 0, br: b });
      } else if (r < 0.82) {
        ft.push({ t: 2, z0: zz, z1: zz + R(50, 90), amp: R(0.7, 1.5), wav: R(13, 20), w: b.w, lat: 0, br: b });
      } else {
        const side = rnd() < 0.5 ? -1 : 1;
        ft.push({ t: 3, z0: zz, z1: zz + R(50, 95), side, wid: R(9, 15), lat0: b.w * 0.45, hgt: R(2.2, 4.4), lat: 0, br: b });
      }
    }
    label = kind === 2 ? 'GULLY' : 'TREES';
  }

  /* ---- terrain park ---- */
  if (park.roll < 0.30) {
    const pz = park.pz;
    const lane = R(-6, 6);
    let zc = pz;
    const nk = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < nk; i++) {
      const hgt = 2.4 + i * R(0.5, 1.0), L = R(6.5, 8.5);
      ft.push({ t: 0, z0: zc, z1: zc + L, hgt, w: R(5, 7.5), lat: lane + R(-3, 3), br: null, park: 1 });
      /* NO 'kickerpad' prop here. This line used to push one and NOTHING read it:
         placeFlags() hard-filters to 'flag'/'park' and buildSegGroup()'s dispatch
         has no default, so it was inert (33 dead records per 40 segments).
         The only thing a "pad" could have meant is a packed/groomed apron at the
         takeoff, and that is a MEASURED no-op: the park is placed inside the
         piste corridor, so the snow here is already fully groomed - surf() at 5
         park kickers reads groom 1.00 / pow 0.00 across the whole run-in, 13-16 m
         inside the piste edge. max(corr, pad) cannot change anything.
         Nor does the takeoff need a marker to be legible: the ramp face is 7 deg
         where the piste is 28 deg, so it shades 60% darker than the snow around
         it (n.l 0.273 vs 0.685) and reads clearly at 29 m - measured, not eyeballed
         (outputs/review/p10_kicker_lip.png). */
      zc += R(46, 64);
    }
    for (let i = 0; i < 2; i++) {
      const rail = rnd() < 0.55, L = R(11, 19);
      const lat = lane + (i ? R(5, 9) : R(-9, -5));
      // flatten the ground under and around the feature so it is rideable
      ft.push({ t: 6, z0: zc - 26, z1: zc + L + 22, w: 7.5, lat, br: null, k: 0.95, park: 1 });
      ft.push({
        t: 4, z0: zc, z1: zc + L, w: rail ? 0.36 : R(1.0, 1.5), hgt: rail ? R(0.55, 0.95) : R(0.4, 0.7),
        rail, lat, br: null, park: 1, solid: 1,
        prop: { k: rail ? 'rail' : 'box' }
      });
      if (i) zc += R(30, 44);
    }
    for (let i = 0; i < 4; i++) pr.push({ k: 'park', z: pz - 14 + i * 3, lat: lane - 11 + i * 7 });
    /* P11: one piece of signage per freestyle site. Uses only values already
       rolled (pz, lane) - calling rnd() here would re-roll the whole mountain. */
    pr.push({ k: 'parkboard', z: pz - 19, lat: 0, side: Math.floor(pz) % 2 ? 1 : -1, kind: 'park' });
    label = 'TERRAIN PARK';
  } else {
    /* ---- natural features on the groomed run ---- */
    if (rnd() < 0.55) {
      const zz = z0 + R(20, 150);
      ft.push({ t: 2, z0: zz, z1: zz + R(70, 130), amp: R(0.7, 1.4), wav: R(16, 26), w: 20, lat: 0, br: null });
    }
    if (rnd() < 0.45) {
      const zz = z0 + R(40, 200), L = R(7, 11);
      ft.push({ t: 0, z0: zz, z1: zz + L, hgt: R(1.4, 2.6), w: R(4.5, 8), lat: R(-14, 14), br: null });
    }
    if (rnd() < 0.34) {
      const zz = z0 + R(30, 170);
      ft.push({ t: 3, z0: zz, z1: zz + R(70, 130), side: rnd() < 0.5 ? -1 : 1, wid: R(11, 18), lat0: R(12, 18), hgt: R(2.4, 5), lat: 0, br: null });
    }
    if (rnd() < 0.16) {
      const zz = z0 + R(40, 160);
      ft.push({ t: 1, z0: zz, z1: zz + R(60, 90), A: R(0.24, 0.36), w: 20, lat: 0, br: null });
      label = 'DROP';
    }
    if (rnd() < 0.4) {
      const zz = z0 + R(20, 190);
      ft.push({ t: 5, z0: zz, z1: zz + R(26, 46), hgt: R(1.1, 2.4), w: R(6, 11), lat: R(-24, 24) * (rnd() < 0.5 ? 1 : -1), br: null });
    }
  }

  /* ---- rare set pieces ---- */
  const spec = rnd();
  if (spec < 0.14) {
    const zz = z0 + R(60, 140), L = R(190, 300);
    if (spanFree(s, zz - 30, zz + L + 30)) {
      ft.push({ t: 6, z0: zz - 20, z1: zz + L + 20, w: 15, lat: 0, br: null, k: 0.9 });
      ft.push({ t: 7, z0: zz, z1: zz + L, w0: R(7.5, 9.5), w1: R(15, 18), deck: R(4.2, 5.6), lat: 0, br: null, park: 1 });
      for (let i = 0; i < 5; i++) pr.push({ k: 'park', z: zz - 12 + i * 4, lat: -13 + i * 6.5 });
      pr.push({ k: 'parkboard', z: zz - 17, lat: 0, side: Math.floor(zz) % 2 ? 1 : -1, kind: 'pipe' });
      label = 'HALFPIPE';
    }
  } else if (spec < 0.26) {
    const zz = z0 + R(70, 180), L = R(150, 220);
    if (spanFree(s, zz - 30, zz + L + 20)) {
      ft.push({ t: 8, z0: zz, z1: zz + L, drop: R(7, 13), w: R(26, 44), lat: R(-8, 8), br: null });
      pr.push({ k: 'sign', z: zz - 26, lat: 0, side: rnd() < 0.5 ? -1 : 1, kind: 2 });
      label = 'CLIFF DROP';
    }
  } else if (spec < 0.34) {
    const zz = z0 + R(50, 120);
    const inRun = R(120, 170), lip = R(15, 19), gap = R(30, 40), land = R(70, 95);
    if (spanFree(s, zz - 20, zz + inRun + lip + gap + land + 20)) {
      ft.push({
        t: 9, z0: zz, z1: zz + inRun + lip + gap + land, w: R(11, 15), lat: 0, br: null, park: 1,
        inRun, lip, gap, land, dive: R(4, 7), kick: R(4.6, 6.0), pit: R(3.0, 4.2)
      });
      for (let i = 0; i < 4; i++) pr.push({ k: 'park', z: zz + inRun - 30 + i * 7, lat: -10 + i * 6.5 });
      pr.push({ k: 'parkboard', z: zz + inRun - 35, lat: 0, side: Math.floor(zz) % 2 ? 1 : -1, kind: 'air' });
      label = 'BIG AIR';
    }
  }

  /* ---- poach line: a narrow packed track that ducks into the trees ----
     Not a corridor: it never cuts the ground, it only packs the snow and
     clears the pines, so the reward is speed and the penalty is deep powder. */
  if (rnd() < 0.40) {
    const side = rnd() < 0.5 ? -1 : 1;
    const pl = {
      poach: 1, z0: z0 + R(25, 165), len: R(200, 340), side,
      amp: R(30, 74), w: R(2.1, 3.0), wig: R(4, 10), wf: R(0.8, 1.9), ph: R(0, TAU)
    };
    po.push(pl);
    pr.push({ k: 'sign', z: pl.z0 + 4, lat: side * (pisteW(pl.z0) - 1.5), br: null, side, kind: 1 });
    if (rnd() < 0.62) {                                  // a little kicker on the line
      const zz = pl.z0 + pl.len * R(0.34, 0.64), L = R(4.5, 6.5);
      ft.push({ t: 0, z0: zz, z1: zz + L, hgt: R(1.0, 1.8), w: pl.w * 0.95, lat: 0, br: pl });
    }
    if (!label) label = 'POACH LINE';
  }

  /* ---- scenery ---- */
  for (let i = 0; i < 6; i++) {
    if (rnd() < 0.72) pr.push({ k: 'flag', z: z0 + i * 43 + R(0, 12), lat: 0, side: rnd() < 0.5 ? -1 : 1 });
  }
  if (rnd() < 0.22) pr.push({ k: 'cabin', z: z0 + R(30, 220), lat: (rnd() < 0.5 ? -1 : 1) * R(46, 90), rot: R(-0.6, 0.6) });
  if (rnd() < 0.14) pr.push({ k: 'lift', z: z0 + R(20, 230), lat: (rnd() < 0.5 ? -1 : 1) * R(52, 78) });
  if (rnd() < 0.3) pr.push({ k: 'rocks', z: z0 + R(20, 240), lat: (rnd() < 0.5 ? -1 : 1) * R(40, 110), n: 2 + Math.floor(rnd() * 4) });

  return { br, ft, pr, po, z0, label };
}
