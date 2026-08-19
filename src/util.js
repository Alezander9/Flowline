/* ---------------------------------------------------------------- util */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
// polynomial smooth min: rounds the crease where two distance fields cross
const smin = (a, b, k) => { const h = Math.max(0, 1 - Math.abs(a - b) / k); return Math.min(a, b) - h * h * k * 0.25; };
const TAU = Math.PI * 2;

/* Obstacle record stride, shared by props_world (writer) and rider2 / auto /
   bots (readers): x, z, radius, kind (0 tree, 1 rock), topY.
   topY is the WORLD y of the object's highest point. Before it existed every
   obstacle was an INFINITELY TALL CYLINDER - Alexander cleared a tree on a big
   jump and still got killed by it. Any new reader must use this constant. */
/* ---- rider response tuning (R4) -------------------------------------------
   Alexander: "it feels unresponsive". MEASURED on the shipped build with a real
   Input.dispatchKeyEvent KeyA hold: the yaw rate reached 63% of its value after
   346 ms and 90% after 545 ms. That is the sum of TWO serial lags - a first
   order filter on the steer axis (rate 16/s = 62 ms time constant) feeding a
   lean spring (stiff 40, damp 10.2 => omega_n 6.3 rad/s, zeta 0.81) - and at
   speed there is no unfiltered path at all, because the direct steer term in
   the turn solver decays as exp(-sp*0.16) (0.8% at 30 m/s).
   Kept as one live-tunable object so the feel can be swept in ONE build:
   FL.dbg.resp. steerK is the input filter rate; stiff/damp are the spring, and
   for a target omega_n with damping zeta you want stiff = omega_n^2 and
   damp = 2*zeta*omega_n - do NOT raise stiff without raising damp or the lean
   overshoots and the board wobbles. */
const RESP = { steerK: 18, stiff: 48, damp: 13.86 };
/* Chase-camera zoom. A pure SIMILARITY TRANSFORM about the rider: every offset
   from the rider (orbit distance, height, look-ahead, look height, shake) is
   multiplied by this, so the framing - where the rider sits in the frame, the
   camera pitch, the perceived shake - is unchanged and only the SCALE moves.
   fov is deliberately NOT touched: fov rises with speed as the speed cue, and
   narrowing it would both flatten that cue and tighten the tree-LOD frustum
   gate (props_world beginPlace). Lives here because util.js is first in build
   ORDER, so ui.js (the slider) and rider2.js (updateCamera) both see it. */
/* Chase-camera scale. 0.60 is the default: measured on desktop it puts the rider
   at 451px of an 1838px viewport (vs 275px at 1.0) without the rider starting to
   block the mountain. The slider floor is 0.30 (885px, 48% of the viewport, still
   a readable chase cam); 0.20 already fills 74% of the frame. It cannot usefully
   go to 0 - zoom is a similarity transform about the rider, so the look-target
   collapses onto the eye and the ground-clearance floor tips the camera to nadir
   (measured: pitch 38deg down at 0.10, straight down at 0). Real first person is a
   separate branch, not a slider value: see CAMZ_FP in the todo. */
const CAMZ = { zoom: 0.48 };
const OBS_S = 5;
const DEG = Math.PI / 180;
// exponential smoothing that is frame-rate independent
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const sgn = v => v < 0 ? -1 : v > 0 ? 1 : 0;
/* Numeric guard for OPTIONAL fields on a state object. A truthiness guard
   (`v || d`) is not enough: an absent field is `undefined`, which becomes NaN
   the moment it reaches a Float32Array, and a NaN in the deformation store or a
   particle position is silent. Take the number or the default, never the field.
   (Both bots' minimal `surf` and net ghosts have hit this.) */
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const wrapAngle = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };

/* How much the viewport fights us: a phone held upright wastes most of a wide
   vertical fov on sky and snow, and a phone on its side is only ~370px tall, so
   the rider shrinks to a speck. p = portrait-ness, s = shortness (both 0..1).
   Cameras pull in and tighten the vertical fov by these. */
const VIEW = { p: 0, s: 0, w: 0, h: 0 };
function viewFit() {
  const w = innerWidth, h = innerHeight;
  if (w !== VIEW.w || h !== VIEW.h) {
    VIEW.w = w; VIEW.h = h;
    VIEW.p = clamp((1.30 - w / Math.max(1, h)) / 0.72, 0, 1);
    VIEW.s = clamp((620 - h) / 260, 0, 1);
  }
  return VIEW;
}

// mulberry32 PRNG
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// integer hash -> [0,1)
function ihash(x) {
  x = (x ^ 61) ^ (x >>> 16); x = x + (x << 3) | 0; x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d); x = x ^ (x >>> 15);
  return (x >>> 0) / 4294967296;
}
const h2 = (i, j) => ihash((i * 374761393 + j * 668265263) | 0);
const h3 = (i, j, k) => ihash((i * 374761393 + j * 668265263 + k * 2147483647) | 0);

/* smooth 2d value noise, ~[-1,1] */
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  const t = (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
  return t * 2 - 1;
}
function noise1(x) {
  const xi = Math.floor(x), xf = x - xi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const a = ihash(xi | 0), b = ihash(xi + 1 | 0);
  return (a + (b - a) * u) * 2 - 1;
}
function fbm2(x, y, oct, gain = 0.5, lac = 2.0) {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += amp * noise2(x * f, y * f); norm += amp; amp *= gain; f *= lac; }
  return s / norm;
}
// ridged noise, [0,1], sharp crests
function ridge2(x, y, oct) {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += amp * (1 - Math.abs(noise2(x * f, y * f))); norm += amp; amp *= 0.5; f *= 2.07; }
  return s / norm;
}
/* Fractional-octave variants: `oct` may be fractional and the top octave fades
   its amplitude out (normalised by the full octave count, so the low octaves
   never change gain). Lets the mesh shed only the bands it cannot resolve
   instead of the whole term - no LOD creases, no aliasing shimmer. */
function fbm2f(x, y, oct, max, gain = 0.5, lac = 2.0) {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < max; i++) { norm += amp; amp *= gain; }
  amp = 1;
  for (let i = 0; i < max; i++) {
    const w = oct - i;
    if (w > 0) s += amp * (w < 1 ? w : 1) * noise2(x * f, y * f); else break;
    amp *= gain; f *= lac;
  }
  return s / norm;
}
function ridge2f(x, y, oct, max) {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < max; i++) { norm += amp; amp *= 0.5; }
  amp = 1;
  for (let i = 0; i < max; i++) {
    const w = oct - i;
    if (w <= 0) break;
    // sqrt(n^2+k) instead of |n|: rounds the crest so a ridge reads as a
    // rolling spur instead of a sawtooth of mesh facets
    const n = noise2(x * f, y * f);
    s += amp * (w < 1 ? w : 1) * (1 - Math.sqrt(n * n + 0.014));
    amp *= 0.5; f *= 2.07;
  }
  return s / norm;
}

const nowMs = () => performance.now();
const fmt = n => Math.round(n).toLocaleString('en-US');

/* ------------------------------------------------- tonemap (shared, ONE curve)
   The sky used to bake its own ACES+gamma into an 8-bit target, so it was
   finished display pixels and could never take part in an exposure or curve
   change - the horizon stayed a washed-out smear no matter what the snow did.
   The bake now stores LINEAR radiance and EVERY material, sky included, ends on
   outc(). uTM/uExp are shared by reference, so one write regrades the frame. */
const TONE = { uTM: { value: 0 }, uExp: { value: 1.06 } };
/* Radiance is stored as sqrt(c/SKY_HDR) in 8 bits: keeps range up to SKY_HDR
   with better-than-gamma precision in the darks, and needs no float render
   target extension, so iOS stays happy. */
const SKY_HDR = 4.0;
const GLSL_TONE = `
uniform float uTM, uExp;
vec3 aces(vec3 x){
  return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0);
}
vec3 agxContrast(vec3 x){
  vec3 x2 = x*x, x4 = x2*x2;
  return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x
       + 0.4298*x2 + 0.1191*x - 0.00232;
}
vec3 agx(vec3 c){
  const mat3 TO2020 = mat3(
    vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 TOSRGB = mat3(
    vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 IN = mat3(
    vec3(0.8566271533, 0.1373189729, 0.1118982130),
    vec3(0.0951212405, 0.7612419906, 0.0767994186),
    vec3(0.0482516061, 0.1014390365, 0.8113023684));
  const mat3 OUT = mat3(
    vec3(1.1271005818, -0.1413297635, -0.1413297635),
    vec3(-0.1106066431, 1.1578237022, -0.1106066431),
    vec3(-0.0164939387, -0.0164939387, 1.2519364066));
  c = IN*(TO2020*c);
  c = clamp((log2(max(c, 1e-10)) + 12.47393)/16.5, 0.0, 1.0);
  c = OUT*agxContrast(c);
  c = pow(max(c, 0.0), vec3(2.2));
  return clamp(TOSRGB*c, 0.0, 1.0);
}
vec3 tonemap(vec3 c){ return uTM < 0.5 ? aces(c) : agx(c); }
vec3 outc(vec3 c){ return pow(max(tonemap(c*uExp), 0.0), vec3(0.4545)); }
`;

/* ------------------------------------------------ TIME OF DAY: the sun's arc */
/* Alexander picked two looks out of the six-angle sweep (outputs/flowline_light
   .html): 07:00 morning and 17:00 raking evening. Both of those stills came off
   the old dbg.sunTime curve, and BOTH sit at elevation 14.73 deg - they differ
   only in AZIMUTH (27.5 vs 152.5 deg from the fall line, which is why one reads
   mean 223 sRGB and the other 180 with 31% more surface detail). So the shipped
   arc is defined to pass exactly through them:

     hour <= 7  ->  az  27.5, el 14.73   (his morning, bit-exact)
     hour >= 17 ->  az 152.5, el 14.73   (his evening, bit-exact)

   Every player at any clock time therefore sees an interpolation between two
   looks he actually approved, and the endpoints are not an approximation of the
   stills he judged - they are the same numbers.

   Hours outside [7,17] CLAMP rather than wrap: there is no night art, so 23:00
   renders as his evening instead of as black. Evening is prime playing time and
   it is the look he liked most, so clamping lands well.

   THE MIDDAY BUMP IS DELIBERATELY SMALL (max el 21.7). The old sun was 35 deg
   and near-frontal, which is the flattest light possible and is exactly why the
   snow used to read as a white sheet at any exposure - a full solar arc up to
   ~34 deg at noon would walk midday players straight back into that regression.
   The sun stays raking all day; only its direction goes round. */
const TOD_LO = 7, TOD_HI = 17;
/* TOD_EL is written as the expression the OLD curve evaluated to at both h=7 and
   h=17 (8 + 26*sin(pi/12) = 14.7292951727), not as a rounded 14.73, so the two
   approved looks reproduce to the last bit and the new build can be A/B'd
   against the stills he judged with an expected difference of exactly zero. */
const TOD_AZ0 = 27.5, TOD_AZ1 = 152.5, TOD_EL = 8 + 26 * Math.sin(Math.PI / 12), TOD_ELB = 7.0;

const todClock = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
/* 24h clock, both fields padded: an unpadded "7:00" next to "17:00" makes the
   AUTO label jump width as the day passes, and .cyc is tabular-nums so that
   would read as a wobble rather than as a clock. */
const todHM = h => (String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.round((h % 1) * 60)).padStart(2, '0'));

function sunFor(hour) {
  const h = clamp(hour, TOD_LO, TOD_HI);
  const u = (h - TOD_LO) / (TOD_HI - TOD_LO);
  const az = TOD_AZ0 + u * (TOD_AZ1 - TOD_AZ0);
  const el = TOD_EL + TOD_ELB * Math.sin(Math.PI * u);
  const a = az * Math.PI / 180, e = el * Math.PI / 180;
  /* Colour is a function of ELEVATION ONLY, anchored so el 14.73 - i.e. BOTH of
     his endpoints - reproduces the tuned shipped palette exactly. Only the
     middle of the day moves, where a higher sun has less air mass to redden it.
     Morning and evening are deliberately NOT tinted differently from each other:
     he judged both stills with this one palette, so tinting them apart now would
     change the very thing he approved. Warmer evenings are a separate look
     change for him to judge, not something to smuggle in with the plumbing. */
  const t = clamp((el - TOD_EL) / TOD_ELB, 0, 1);
  return {
    hour: h, u, az, el, t,
    dir: [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)],
    sun: [lerp(1.55, 1.44, t), lerp(1.22, 1.25, t), lerp(0.86, 1.02, t)],
    sky: [lerp(0.26, 0.28, t), lerp(0.42, 0.45, t), lerp(0.74, 0.80, t)],
    fogA: [lerp(0.50, 0.53, t), lerp(0.665, 0.70, t), lerp(0.95, 0.98, t)]
  };
}

/* Write a time of day into the shared uniform block. Everything downstream -
   the sky bake, the cascades, the snow BRDF, every prop material - reads these
   by reference, so this one call is the whole world's lighting. */
function applySun(U, hour) {
  const s = sunFor(hour);
  U.uSun.value.set(s.dir[0], s.dir[1], s.dir[2]).normalize();
  U.uSunCol.value.setRGB(s.sun[0], s.sun[1], s.sun[2]);
  U.uSkyCol.value.setRGB(s.sky[0], s.sky[1], s.sky[2]);
  U.uFogA.value.setRGB(s.fogA[0], s.fogA[1], s.fogA[2]);
  return s;
}

/* Where the hour comes from, in priority order. ?hour=17 (or #hour=17) forces
   one for testing and for sharing a reproducible screenshot and is NOT
   persisted; otherwise OPT.tod is either 'auto' (follow the player's clock) or a
   pinned hour. OPT lives in ui.js, which is parsed before this ever runs. */
function todResolve() {
  const m = /[?&#]hour=([\d.]+)/.exec(typeof location === 'undefined' ? '' : location.href);
  if (m) return { hour: clamp(+m[1], 0, 24), src: 'url' };
  if (typeof OPT !== 'undefined' && OPT.tod !== 'auto' && OPT.tod !== undefined)
    return { hour: +OPT.tod, src: 'opt' };
  return { hour: todClock(), src: 'clock' };
}

