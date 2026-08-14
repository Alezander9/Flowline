/* ------------------------------------------------- terrain: paths & pitch */
let SEED = 1337;                       // the canonical mountain
const SEG = 260;                       // feature segment length (m)

/* the main piste meanders down the fall line */
const pisteC = z => 62 * Math.sin(z * 0.00238) + 30 * Math.sin(z * 0.00578 + 2.1) + 13 * Math.sin(z * 0.0103 + 0.7);
const pisteW = z => 19 + 6.5 * Math.sin(z * 0.00385 + 1.1) + 3 * Math.sin(z * 0.0082);
/* curvature -> banked turns */
const pisteC2 = z => -62 * 5.66e-6 * Math.sin(z * 0.00238) - 30 * 3.34e-5 * Math.sin(z * 0.00578 + 2.1)
  - 13 * 1.06e-4 * Math.sin(z * 0.0103 + 0.7);
/* elevation of the fall line: pitch wanders between ~11 and ~22 degrees */
const baseY = z => -(0.30 * z - 88 * Math.cos(z * 0.0011364) - 15.35 * Math.cos(z * 0.0032573 + 1.3));
const pitchAt = z => 0.30 + 0.10 * Math.sin(z * 0.0011364) + 0.05 * Math.sin(z * 0.0032573 + 1.3);
/* rollers along the groomed run */
const groomRoll = z => 3.1 * Math.sin(z * 0.0195 + 0.4) + 1.15 * Math.sin(z * 0.062 + 1.7) + 0.3 * Math.sin(z * 0.15 + 3);

/* ---- segment cache: branches (side routes) + features ---- */
const segCache = new Map();
function getSeg(s) {
  let e = segCache.get(s);
  if (e) return e;
  e = buildSeg(s);
  segCache.set(s, e);
  if (segCache.size > 220) { // trim far entries
    for (const k of segCache.keys()) { if (Math.abs(k - s) > 90) segCache.delete(k); }
  }
  return e;
}

/* ---- active corridors at a given z (allocation free) ---- */
const _pC = new Float64Array(6), _pW = new Float64Array(6), _pK = new Int8Array(6);
let _pN = 0;
function collectPaths(z) {
  _pN = 0;
  _pC[0] = pisteC(z); _pW[0] = pisteW(z); _pK[0] = 0; _pN = 1;
  const s0 = Math.floor(z / SEG);
  for (let s = s0 - 3; s <= s0 + 1; s++) {
    const seg = getSeg(s);
    const br = seg.br;
    for (let i = 0; i < br.length; i++) {
      const b = br[i];
      if (z < b.z0 || z > b.z0 + b.len || _pN >= 6) continue;
      const t = (z - b.z0) / b.len;
      const bell = 0.5 - 0.5 * Math.cos(TAU * t);
      _pC[_pN] = pisteC(z) + b.side * b.amp * bell;
      _pW[_pN] = b.w * (0.55 + 0.45 * smoothstep(0, 0.18, t) * smoothstep(0, 0.18, 1 - t));
      _pK[_pN] = b.kind;   // 1 glade, 2 gully
      _pN++;
    }
  }
  return _pN;
}

/* ---- poach lines active at a given z (packed tracks, not corridors) ---- */
const _qC = new Float64Array(3), _qW = new Float64Array(3), _qK = new Float64Array(3);
let _qN = 0;
/* §8: how hard the line is turning here, signed, in -1..1. Snow gets thrown to the OUTSIDE of a
   corner and the rider scrubs most where the line bends, so this drives both the berm asymmetry
   and the corner wear - which is what makes a poach line read as a USED route instead of a
   symmetric ditch.
   poachC is analytic, so this needs no new state and above all NO new rnd() call: the segment
   PRNG is a sequential chain, and one extra draw would re-roll the entire mountain. */
const PK_E = 4;      // second-difference step in m: measures the corner, not the wiggle's grain
const PK_N = 0.15;   // normaliser = measured interior p75 of |K| over all 16 lines on the mountain
const PB_ASYM = 0.85; // berm gain on the outside of a corner (x1.85 outside, x0.15 inside)
const PB_WEAR = 0.45; // extra trench depth at a full corner (0.45 m -> 0.65 m); 0 on a straight
function poachTurn(pl, z, c) {
  /* The arc term is sin(pi*t)^0.7, whose second derivative DIVERGES at t=0 and t=1. Measured, that
     spike is confined to the outer 5% of a line (mean |K| 1.224 there vs 0.088 in the interior),
     so the end envelope removes an artifact rather than real signal - and it also tapers the berm
     out where the line merges back into the piste, which is what a real merge looks like. */
  const t = (z - pl.z0) / pl.len;
  const k = poachC(pl, z + PK_E) - 2 * c + poachC(pl, z - PK_E);
  /* tanh soft-saturates rather than clamping: interior |K| spans 0.014..0.417, so a hard clamp
     would flat-top exactly the strongest corners this feature exists to show. */
  return Math.tanh(k / PK_N) * smoothstep(0, 0.10, t) * smoothstep(1, 0.90, t);
}
/* Memo on z. collectPoach is a pure function of z, and the clipmap samples a whole row at one z
   (and the fine patch a whole row too), so a single-entry cache hits on almost every call. This
   was already the hot path before the turn term: it walks the segment list and evaluates poachC
   per sample. Measured on the real row loop, the memo pays for poachTurn several times over. */
let _qZ = NaN;
function collectPoach(z) {
  if (z === _qZ) return _qN;
  _qZ = z;
  _qN = 0;
  const s0 = Math.floor(z / SEG);
  for (let s = s0 - 2; s <= s0 + 1; s++) {
    const ps = getSeg(s).po;
    if (!ps) continue;
    for (let i = 0; i < ps.length; i++) {
      const pl = ps[i];
      if (z < pl.z0 || z > pl.z0 + pl.len || _qN >= 3) continue;
      _qC[_qN] = poachC(pl, z); _qW[_qN] = pl.w;
      _qK[_qN] = poachTurn(pl, z, _qC[_qN]); _qN++;
    }
  }
  return _qN;
}

/* ---- the sample result ---- */
const S = { h: 0, groom: 0, ice: 0, pow: 0, dEdge: 0, lat: 0, kind: 0, park: 0, solid: 0, lift: 0, cw: 0, track: 0, tlat: 0, tad: 12, tw: 2.4 };

/* ---- per-row cache: everything that depends only on z ---- */
const RC = { z: 1e18, base: 0, bank: 0, bias: 0, iceA: 0, fN: 0, f: [] };
function rowSetup(z) {
  if (RC.z === z) return;
  RC.z = z;
  collectPaths(z);
  collectPoach(z);
  RC.base = baseY(z);
  RC.roll = groomRoll(z);
  RC.bank = clamp(-pisteC2(z) * 520, -0.5, 0.5);
  RC.bias = noise1(z * 0.0016) * 0.85;
  RC.iceA = smoothstep(0.15, 0.55, noise1(z * 0.0021 + 7.7) + 0.25);
  RC.fN = 0;
  const s0 = Math.floor(z / SEG);
  for (let s = s0 - 2; s <= s0 + 1; s++) {
    const fs = getSeg(s).ft;
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      // drop features keep a fade-out tail past their end (see LIPT)
      const m = (f.t === 0 || f.t === 9) ? LIPMAX : 0;
      if (z >= f.z0 && z <= f.z1 + m) RC.f[RC.fN++] = f;
    }
  }
}

/* Detail LOD is driven by the local sample spacing (metres), not by distance:
   a band is only added while the mesh can actually resolve it (>= ~3 samples
   per wavelength). That keeps shapes from aliasing / crawling as the clipmap
   origin snaps, and means a finer mesh automatically shows detail further out. */
const LODF = { f0: 3.3, f1: 6.4, m0: 30, m1: 62, x0: 15, x1: 33 };
function setLod(k) {
  const q = 0.72 + 0.28 * clamp(k / 3.2, 0, 1);   // low tiers drop detail sooner
  LODF.f0 = 3.3 * q; LODF.f1 = 6.4 * q;           // moguls / fine grain (amplitude)
  LODF.m0 = 30 * q; LODF.m1 = 62 * q;             // mid ridges (amplitude, far only)
  LODF.x0 = 15 * q; LODF.x1 = 33 * q;             // kickers, rails, cliffs
}
let FRES = 0;      // sample spacing of the current row, for band-limiting features
/* how far to smear a vertical lip so the current row can resolve it: nothing
   until cells are coarser than the lip itself, then ~one cell. */
export const LIPT = () => Math.min(Math.max(FRES - 2.2, 0) * 1.4, 13);
export const LIPMAX = 13;
function sampleAt(x, z, res) {
  rowSetup(z);
  /* Corridors are blended, never winner-take-all: picking one corridor's cross
     offset made the banking term jump by tens of metres where a branch crossed
     the piste - a sheer 15 m step that no mesh can draw without sawtoothing. */
  // corridor edges soften with the sample spacing: a 12 m fold across a 26 m
  // row would terrace, so the transition is widened to stay band-limited
  const sr = res === undefined ? 0 : res;
  let corr = 0, dEdge = 1e9, kind = 0, cw = 25, lsum = 0, lwei = 0;
  for (let i = 0; i < _pN; i++) {
    const dx = x - _pC[i], d = Math.abs(dx), w = _pW[i];
    const g = smoothstep(w + 9 + sr, w - 3 - sr * 0.5, d);
    if (g > corr) { corr = g; kind = _pK[i]; cw = w; }
    if (g > 0) { lsum += g * dx; lwei += g; }
    const de = d - w;
    dEdge = dEdge > 1e8 ? de : smin(dEdge, de, 12 + sr);
  }
  const lat = lwei > 0 ? lsum / lwei : x - _pC[0];
  const dd = Math.max(0, dEdge);
  const off = smoothstep(4, 70, dd);
  const off2 = smoothstep(10, 250, dd);
  /* continuous detail weights: keep LOD rings crack-free */
  const wFine = res === undefined ? 1 : 1 - smoothstep(LODF.f0, LODF.f1, res);
  const wMid = res === undefined ? 1 : 1 - smoothstep(LODF.m0, LODF.m1, res);
  const wFeat = res === undefined ? 1 : 1 - smoothstep(LODF.x0, LODF.x1, res);

  /* poach track: packed, fast, a hand-width lower than the powder around it */
  let track = 0, tlat = 0, berm = 0, tad = 12, tw = 2.4, twear = 0;
  for (let i = 0; i < _qN; i++) {
    const dx = x - _qC[i], ad = Math.abs(dx), w = _qW[i], kh = _qK[i];
    const g = smoothstep(w + 1.1 + sr * 0.4, w - 0.5, ad);            // packed, sunken lane
    let b = smoothstep(w - 0.2, w + 1.1, ad) * smoothstep(w + 3.4 + sr * 0.5, w + 1.3, ad);
    /* §8: build the ridge on the OUTSIDE of the corner and let it nearly vanish on the inside.
       The outside is the -sgn(kh) side, so -dx*kh is positive there; dividing by w and clamping
       keeps this smooth in BOTH dx and kh (it goes to zero on a straight, and at dx = 0 where the
       berm mask is zero anyway), so no sign() and no discontinuity. */
    b *= clamp(1 + PB_ASYM * clamp(-dx * kh / w, -1, 1), 0, 2);
    if (g > track) { track = g; tlat = dx; twear = Math.abs(kh); }
    if (b > berm) berm = b;                                            // snow shoved to the sides
    /* Unsigned distance to the nearest line, for the shader. A per-vertex 0..1
       mask cannot survive 2 m vertex spacing (a 3 m rut washes out), but a
       distance field interpolates cleanly, so the fragment stage can rebuild a
       crisp rut, edge crease and board ruts at any mesh resolution. */
    if (ad < tad) { tad = ad; tw = w; }
  }

  let h = RC.base + RC.roll * (0.5 + 0.5 * corr) + RC.bank * lat * corr;

  if (dd > 0.01) {
    const side = 1 + RC.bias * (lat < 0 ? -1 : 1);
    h += 0.052 * Math.pow(dd, 1.22) * clamp(side, 0.18, 1.85) * (0.78 + 0.42 * fbm2(x * 0.004, z * 0.0035, 2));
    h += 44 * (fbm2(x * 0.00092, z * 0.00081, 2) - 0.12) * off2;
    // big mountain octaves shed only the bands the mesh cannot resolve
    h += 23 * fbm2f(x * 0.0026, z * 0.0021, res === undefined ? 3 : clamp(3 - (res - 18) / 16, 1, 3), 3) * off2;
    h += 6.0 * (ridge2f(x * 0.011, z * 0.009, res === undefined ? 3 : clamp(3 - (res - 6.5) / 6, 1, 3), 3) - 0.55) * off * wMid;
  }
  if (track > 0.01 || berm > 0.01) {
    /* A 45 cm trench inside a 2-3 m lane is finer than a 2 m lattice can hold:
       as GEOMETRY it aliases and smears (the single biggest source of the
       drawn-vs-physics gap). Band-limit the RELIEF with the sample spacing and
       let the fragment shader keep the rut crisp from its distance field - the
       look is carried by shading, which has no resolution limit. */
    const gk = 1 / (1 + (sr / 1.3) * (sr / 1.3));
    /* §8 wear: a rider scrubs most where the line bends, so corners are dug out deeper than the
       straights. The straight-line depth is deliberately unchanged (twear = 0 there), so nothing
       gets globally deeper - only corners do. */
    h += (0.20 * berm - 0.45 * track * (1 + PB_WEAR * twear)) * gk;
  }
  if (wFine > 0.01) {
    const mog = off * (0.55 + 0.45 * noise2(x * 0.012, z * 0.011)) * wFine * (1 - 0.75 * track);
    if (mog > 0.02) {
      h += 0.85 * mog * Math.sin(x * 0.52 + noise2(x * 0.02, z * 0.02) * 2) * Math.sin(z * 0.44 + 1.3);
      h += 0.5 * mog * Math.sin(x * 0.17 + z * 0.09);
    }
    h += 0.28 * wFine * fbm2(x * 0.075, z * 0.075, 2) * (0.45 + 0.55 * off) * (1 - 0.6 * track);
  }
  /* The groomed corridor had NO relief at all (moguls are gated by `off`, which
     is zero on the piste), so the one part of the mountain the player actually
     rides was a perfectly flat plane - unmistakably artificial next to snow that
     now shades every drift. Add long-wavelength roll that a 2 m lattice can
     genuinely hold (>= ~45 m, so it cannot alias), strongest toward the edges
     where traffic pushes snow around and weakest down the groomed centre. */
  const pist = corr * (1 - off);
  if (pist > 0.01) {
    const edge = clamp(Math.abs(lat) / Math.max(cw, 1), 0, 1);
    h += 0.15 * pist * Math.sin(x * 0.081 + z * 0.041 + noise2(x * 0.010, z * 0.010) * 2.6);
    h += 0.10 * pist * Math.sin(z * 0.104 - x * 0.030);
    h += 0.22 * pist * (0.35 + 0.9 * edge) * (fbm2(x * 0.026, z * 0.022, 2) - 0.5);
  }

  let park = 0, solid = 0, lift = 0;
  if (wFeat > 0.01) {
    FRES = sr;
    for (let i = 0; i < RC.fN; i++) {
      const f = RC.f[i];
      const hf = featureH(f, x, z, h);
      const nh = wFeat >= 1 ? hf : h + (hf - h) * wFeat;
      if (f.solid) { solid = 1; lift += nh - h; }   // how far the deck stands off the snow
      h = nh;
      if (f.park) park = 1;
    }
  }

  let ice = 0;
  if (RC.iceA > 0.01) {
    const n = fbm2f(x * 0.021, z * 0.017, res === undefined ? 3 : clamp(3 - (res - 2.6) / 4, 1.4, 3), 3);
    ice = smoothstep(0.14, 0.42, n) * RC.iceA * (0.35 + 0.65 * corr) * (0.4 + 0.6 * smoothstep(0.24, 0.4, pitchAt(z)));
  }
  /* ---------------------------------------------- promoted drift (phase 3)
     The 7.5 m wind-drift octave as REAL height instead of a faked normal.

     WHY IT LIVES HERE AND NOT ON THE FINE PATCH. The obvious place was the
     patch's vertex shader, and that is what I built first - but the patch
     rectangle is pinned to the clipmap origin, which SNAPS IN 2 m STEPS, while
     any promotion must taper to 0 at the rectangle edge to stay crack-free.
     MEASURED consequence: with a 1.75 m taper a fixed world point can go from
     zero to full promoted height inside ONE snap, i.e. a 0.2-0.4 m instantaneous
     pop at the patch boundary - trading phase 1's verified time-invariance for
     the feature. Widening the taper only slows it (3/T per snap).
     Promoting into sampleAt instead means the coarse mesh, the structural grid,
     strAt, meshAt, hAuth, physics, props and the trail ALL carry it with no new
     code path, no boundary and no GLSL/JS twin to drift apart - which is the
     "one surface" the whole plan is aiming at.

     It is band-limited by `res` exactly as wFine/wMid/wFeat already are, so it
     is present wherever the surface is sampled finely enough to represent it
     (near rows and PRES physics at res 2) and fades out by res 5 (~130 m). That
     is the mechanism previously MEASURED to morph sub-pixel, because it acts far
     away where 0.24 m is ~1.5 px, spread over ~79 m of approach.

     Amplitude is modulated by `loose`: a groomer erases drifts, so a groomed
     piste keeps only 0.30 of it (~0.10 m, i.e. +-5 cm - deliberately gentle, the
     piste must stay a piste), while open snow gets the full 0.34 m. Solid decks
     (rails, boxes) are excluded - snow drifts on the mountain, not on steel. */
  const wDrift = res === undefined ? 1 : 1 - smoothstep(2.2, 5.0, res);
  if (wDrift > 0.01 && !solid) {
    const loose = (1 - corr) * (1 - clamp(ice, 0, 1));
    /* CAUTION, this file mixes two noise conventions: noise2 is ALREADY CENTRED
       on 0 (~[-1,1]) while the fbm2 call ~50 lines up is written as
       (fbm2(..) - 0.5). Subtracting 0.5 here too was a real bug I shipped into
       the first gate run: it is a CONSTANT -0.5*A offset, i.e. it dropped the
       whole near field ~17 cm, and a DC offset passes a low-pass untouched, so
       it alone accounted for a THIRD of the R12 shape budget (rms 0.189 -> 0.125
       at identical amplitude). Do not reintroduce it.
       (The pre-existing fbm2 - 0.5 above carries the same bias, but that is
       shipped mountain shape and R12 forbids changing it.)
       Amplitude chosen against the measured gate: 0.26 puts this at ~48% of the
       20 cm RMS budget, leaving headroom. Wavelength is a WEAK lever (7.5 -> 4.5
       m cell moves RMS only 0.125 -> 0.116), so there is nothing to gain by
       distorting the drift shape to dodge the gate - amplitude is the lever. */
    const A = 0.26 * (0.30 + 0.70 * loose) * wDrift;
    /* NO DOMAIN WARP, deliberately. Warping made the drifts snake rather than sit
       as separate lumps, but it needs two more noise fetches and sampleAt is the
       hottest function in the engine (~12,900 calls per clipmap rebuild).
       MEASURED: 3 fetches cost terr.update 2.25 -> 2.78 ms (+23.6%) where one
       costs ~+0.18 ms. Since the frozen-frame A/B is null - the shader's faked
       normal, not this height, is what the eye reads at this amplitude - the warp
       bought nothing visible for 2/3 of the cost. Value noise is hash-based and
       already irregular, just less elongated. */
    h += A * noise2(x / 7.5, z / 7.5);
  }
  S.h = h; S.groom = corr; S.ice = clamp(ice, 0, 1);
  S.pow = (1 - corr) * (1 - 0.72 * track); S.track = track; S.tlat = tlat;
  S.tad = tad < 12 ? tad : 12; S.tw = tw;
  S.dEdge = dEdge; S.lat = lat; S.kind = kind; S.park = park; S.solid = solid; S.lift = lift; S.cw = cw;
  return S;
}
/* PHYSICS SAMPLES WHAT IS DRAWN.
   The near clipmap row samples at res = SNAP (2 m); physics used to sample the
   UNFILTERED field (res undefined). The band weights are identical at res 2, so
   the only terms that differed were exactly the sub-cell ones - corridor and
   poach-track edge softening - and that mismatch put the drawn surface up to
   38 cm ABOVE the physics surface. The rider then stood below the snow it can
   see, and its trail (laid at the physics height) vanished under the mesh.
   Sampling at the same spacing the near mesh uses costs nothing and keeps the
   board, its trail, the props and the collision surface on ONE surface.
   Must match SNAP in terrain_mesh.js. */
const PRES = 2;
const sample = (x, z) => sampleAt(x, z, PRES);

const terrainH = (x, z) => sample(x, z).h;

/* surface normal by finite difference */
const _nrm = { x: 0, y: 1, z: 0 };
function terrainNormal(x, z, eps = 0.8) {
  const hL = terrainH(x - eps, z), hR = terrainH(x + eps, z);
  const hD = terrainH(x, z - eps), hU = terrainH(x, z + eps);
  const nx = -(hR - hL) / (2 * eps), nz = -(hU - hD) / (2 * eps);
  const il = 1 / Math.hypot(nx, 1, nz);
  _nrm.x = nx * il; _nrm.y = il; _nrm.z = nz * il;
  return _nrm;
}
