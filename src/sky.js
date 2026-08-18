/* ------------------------------------------------- sky: baked dome + ranges */

/* Shared noise. One copy, used by the sky quad, the heightfield pass and the
   range mesh - three shaders that MUST agree on the terrain or the ranges will
   not line up with their own shadows. */
const GLSL_NOISE = `
float h21b(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  float a=h21b(i), b=h21b(i+vec2(1,0)), c=h21b(i+vec2(0,1)), d=h21b(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fb(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*vn(p); p*=2.03; a*=0.5;} return s; }
float rg(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<4;i++){ s+=a*(1.0-abs(vn(p)*2.0-1.0)); p*=2.07; a*=0.5;} return s; }
`;

/* ============================================================ range geometry
   The ranges were 2D noise painted onto an analytic silhouette. That can never
   read as geology: there is no coherent spur structure, the "slope" driving the
   rock/snow split was a noise-domain gradient rather than a real surface
   orientation, and nothing could cast a shadow on anything.

   They are now REAL DISPLACED GEOMETRY, rendered once into the same equirect
   bake. Silhouettes, normals, occlusion between ranges and cast shadows all
   fall out of the geometry. Runtime cost is unchanged - this happens entirely
   inside the one-time bake, and the game still samples a single dome texture. */
/* Grid resolution is a BAKE-TIME cost only: bake() runs once at construction
   and the mesh is disposed straight after (see the end of the ctor), so this
   buys silhouette quality for startup milliseconds and zero runtime or VRAM.
   Radial spacing is dr/r = ln(R1/R0)/NR, so NR sets how much slope the grid
   averages away; NA is matched to ~2 texels per column of the 4096-wide bake. */
const RG_NA = 2048, RG_NR = 384;          // azimuth columns x log-spaced radial rings

/* WEAK-GPU BAKE TIER.  The range bake is ONE draw of RG_NA*RG_NR vertices, each
   running a dependent-texture sun march - 786k verts / 1.57M tris / 21 steps at
   full size.  That is 3.45 ms on an M5, but on an Intel iGPU through ANGLE->D3D11
   it can exceed Windows' ~2 s TDR limit, and a TDR resets the driver, kills the
   WebGL context and (before the handlers in main.js) froze the picture forever
   while audio and the distance meter kept running.  So the grid is now chosen at
   construction.  1024x192 is NOT a guess: it is close to the 1280x192 grid that
   shipped and was accepted before the bake-leak fix made the raise affordable,
   so the weak tier is a return to known-good fidelity rather than new art.
   maxTextureSize is NOT a usable proxy here - Intel iGPUs report 16384 - so the
   renderer string is the signal that actually correlates with the failure. */
function skyGpuTier(ren) {
  let r = '';
  try {
    const gl = ren.getContext(), d = gl.getExtension('WEBGL_debug_renderer_info');
    if (d) r = String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL) || '');
  } catch (e) { /* extension blocked (privacy.resistFingerprinting): fall through */ }
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const soft = /SwiftShader|Software|Microsoft Basic|llvmpipe/i.test(r);
  const igpu = /Intel|UHD Graphics|HD Graphics|Iris|Mali|Adreno|PowerVR|Vivante/i.test(r);
  const small = (ren.capabilities.maxTextureSize || 2048) < 4096;
  /* ?skylow / ?skyhigh force either path on ANY GPU.  Without this the weak tier
     is only reachable on hardware I cannot get hold of, i.e. untestable - and it
     lets a player on a laptop try the cheap bake without waiting for a detect fix. */
  const q = typeof location !== 'undefined' ? location.href : '';
  if (/[?&#]skylow/.test(q)) return skyTierOf(true, r);
  if (/[?&#]skyhigh/.test(q)) return skyTierOf(false, r);
  return skyTierOf(mobile || soft || igpu || small, r);
}

function skyTierOf(weak, r) {
  return { weak: weak, renderer: r,
    /* The march must keep its 65 km REACH, not just fewer steps: 140*1.34^21 =
       65.5 km, and naively cutting to 14 steps at 1.34 would reach only 8.4 km,
       truncating the field and changing which distant peaks are sunlit.  Growing
       faster instead - 140*1.55^14 = 64.8 km - samples the SAME field coarsely. */
    na: weak ? 1024 : RG_NA, nr: weak ? 192 : RG_NR,
    steps: weak ? 14 : 21, grow: weak ? 1.55 : 1.34 };
}
/* Sun gain on the range faces. Snow albedo is ~1.05, so this sets where sunlit
   distant snow lands on the tonemap curve - the one number that decides whether
   a peak has form or is a paper cut-out. Graded against the SAME frame's near
   sunlit terrain snow, which is the same material under the same sun. */
/* 2.45 put sunlit distant snow at sRGB 237 with 33.6% of the lit faces pinned
   above 0.95 output - brighter than the SAME frame's near sunlit terrain snow
   (228), which is backwards, and 10.5% of the whole mountain area rendered as
   flat paper. uploads/mountain_render.jpeg has its distant peak snow at 0.976x
   its near snow with essentially no clipping, so 1.45 (ratio 0.982) is matched
   to the photograph, not picked by eye. Measured with the alpha mask over a
   pixel set FROZEN from the 2.45 bake (the obvious r>b "sunlit" test weakens
   with the gain, which made an earlier sweep read backwards):
     gain  lit p10-p90  srgb50  lit white95  lit sd  mtn white95  contrast
     2.45      13         237      33.6%     0.0483    10.5%       0.2836
     1.70      16         227      12.1%     0.0608     3.8%       0.2752
     1.45      18         224       3.4%     0.0662     1.1%       0.2711
     1.20      19         219       0%       0.0723     0%         0.2657
   i.e. +37% shape signal inside the lit faces for -4.4% whole-mountain
   contrast. Below ~1.2 the ranges start reading grey. */
const R_SUN = 1.45;
/* Keep the bake resources resident so the sky can be RE-LIT after the sun moves.
   Costs ~25 MB (a 4.7 M-entry index buffer, the aIJ attribute and the polar
   heightfield target); a re-bake is one 1.57 M-tri pass. Set false to reclaim it
   and freeze the sun where it was at boot. */
const SKY_DYN = true;
const RG_R0 = 900.0, RG_R1 = 52000.0;     // metres: nearest / farthest ring
const RG_HLO = -1400.0, RG_HHI = 5400.0;  // span of the 16-bit height packing

/* World heightfield for the background, in METRES, bake origin (the camera) at
   y = 0. Domain-warped ridged noise so peaks form coherent CHAINS with spurs
   and valleys between them, rather than an even field of bumps. */
const GLSL_TERRAIN = `
const float R0 = ${RG_R0.toFixed(1)}, R1 = ${RG_R1.toFixed(1)};
const float LR0 = ${Math.log(RG_R0).toFixed(6)}, LRS = ${(Math.log(RG_R1) - Math.log(RG_R0)).toFixed(6)};
const float HLO = ${RG_HLO.toFixed(1)}, HSPAN = ${(RG_HHI - RG_HLO).toFixed(1)};

vec2  packH(float h){ float v = clamp((h-HLO)/HSPAN, 0.0, 1.0);
                      float e = floor(v*255.0); return vec2(e/255.0, v*255.0-e); }
float unpackH(vec2 p){ return HLO + (p.x + p.y/255.0)*HSPAN; }

/* OCTAVE BALANCE IS WHAT MAKES A RANGE ALPINE, not amplitude and not the crest
   exponent. Measured on the baked grid (.bcode/agent-workspace/sky_geo_field.mjs,
   an exact port of this function, so candidates cost a second instead of a
   build): the old 0.65/0.26/0.13/0.042 split put 65% of the height into a 9 km
   octave, giving crest slopes of only [20,28,37,49] deg - rolling hills, which
   is why no amount of mask tuning could expose rock. Weight moved into the
   2.4 km / 900 m / 330 m octaves gives [36,47,57,67] deg.
   Do NOT reach for pow() to fix slope: sharpening the crest exponent drops
   everything below the peaks, and the ranges lose elevation presence fast
   (max crest elevation 12.9 -> 5.4 deg at pw 5). It steepens by shrinking the
   mountain. Frequency steepens by keeping it. */
float rgeH(vec2 w){
  vec2 q = w * (1.0/7000.0);
  q += (vec2(fb(q*0.63+vec2(2.1,7.7)), fb(q*0.63+vec2(9.3,1.4))) - 0.5) * 0.85;
  float chain = rg(q);                        // ~7 km massifs
  float d1    = rg(q*2.9 + vec2(11.2,4.5));   // ~2.4 km ridges
  float d2    = rg(q*7.7 + vec2(3.4,19.1));   // ~900 m spurs
  float d3    = fb(q*21.0 + vec2(7.1,2.2));   // ~330 m roughness
  float s = chain*0.38 + d1*0.30 + d2*0.28 + d3*0.14;
  s = pow(clamp(s, 0.0, 1.7), 1.82);          // sharper alpine horns, still massy
  float r = length(w);
  /* the near field must stay a valley: a peak 1 km from the camera would tower
     over everything and the game's own terrain already owns that ground */
  float nf = smoothstep(1100.0, 4800.0, r);
  /* far ranges stand taller or they never clear the near ones */
  float amp = mix(3400.0, 6200.0, clamp((r-3600.0)/24000.0, 0.0, 1.0));
  return -640.0 + s*amp*nf;
}

/* equirect direction -> sky radiance, for the ranges' aerial perspective. Must
   track the sky quad's own gradient or the ranges will not melt into it. */
vec3 hazeCol(vec3 d, vec3 sun){
  vec3 c = mix(vec3(0.80,0.76,0.86), vec3(0.09,0.28,0.82), pow(clamp(d.y,0.0,1.0),0.70));
  return mix(c, vec3(1.10,0.88,0.62), pow(max(dot(d,sun),0.0),2.6)*0.52);
}
`;

const SKY_FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uPhase;
uniform vec3 uSunB;   /* shared BY REFERENCE with the scene's uSun - see inject() */
${GLSL_NOISE}
void main(){
  float phi = vUv.x*6.2831853;
  float theta = (1.0-vUv.y)*3.14159265;
  vec3 d = vec3(-cos(phi)*sin(theta), cos(theta), sin(phi)*sin(theta));
  vec3 sun = normalize(SUNDIR);
  /* analytic angles: the driver's atan can be coarse, which banded the ranges */
  float el = 1.5707963268 - theta;
  float az = 3.1415926536 - phi;
  float sunAz = atan(sun.z, sun.x);
  float up = clamp(d.y*0.5+0.5,0.0,1.0);

  // ---- sky gradient
  vec3 zen = vec3(0.09,0.28,0.82);
  vec3 hor = vec3(0.82,0.78,0.88);
  vec3 col = mix(hor, zen, pow(clamp(d.y,0.0,1.0), 0.70));
  float sd = max(dot(d,sun),0.0);
  /* SSX golden-hour wash: a wide warm halo, tight sun disc, peach horizon */
  col += vec3(1.35,0.92,0.55)*pow(sd,9.0)*0.42;
  col += vec3(1.15,0.82,0.48)*pow(sd,42.0)*1.35;
  col += vec3(1.7,1.35,0.95)*smoothstep(0.9982,0.9996,sd)*10.0;
  col = mix(col, vec3(1.12,0.86,0.62), pow(1.0-up,5.5)*0.88);

  // ---- clouds
  if(d.y > 0.012){
    vec2 cp = d.xz/max(d.y,0.02)*0.42 + vec2(uPhase*0.013,-uPhase*0.004);
    float n = fb(cp*0.5);
    float m = smoothstep(0.50,0.82,n)*smoothstep(0.012,0.16,d.y);
    float lit = smoothstep(0.34,0.86, fb(cp*0.5 + sun.xz*0.55));
    vec3 cc = mix(vec3(0.80,0.85,0.95), vec3(1.35,1.26,1.10), lit);
    col = mix(col, cc, m*0.9);
    // thin high cirrus
    float c2 = smoothstep(0.60,0.85, fb(cp*0.19+vec2(3.1,1.7)));
    col = mix(col, vec3(1.15,1.12,1.08), c2*0.30*smoothstep(0.05,0.35,d.y));
  }

  /* ---- the valley floor.
     Everything below the horizon used to be the sky gradient continued
     downward plus a 20% blue wash, i.e. a flat grey-blue field. The clipmap
     only reaches ~1.9 km, so in every wide shot that field is what you see
     between the near hillside and the ranges - it read unmistakably as a LAKE,
     and it was the single most artificial thing in the frame.
     Model it as what is actually down there: a snow valley floor a few hundred
     metres below the camera, seen at a grazing angle. A flat plane at depth H
     sits at distance H/tan(-el), so aerial perspective does all the work -
     near the horizon the distance diverges and the floor melts into the same
     haze the ranges use, which is exactly the read a real valley has. Drawn
     BEFORE the ranges so they occlude it. */
  if(el < -0.0015){
    float H = 560.0;                                  // camera height over the floor
    float dist = H/max(-el, 0.0015);                  // metres, 0.37 M m at the horizon
    float ldd = log2(dist/900.0);                     // distance in octaves, for texture
    /* forest patches and open snow. Scale with 1/dist so the pattern condenses
       toward the horizon the way real ground texture does under perspective. */
    /* The angular frequency of a fixed-size ground feature GROWS with distance,
       so the old az*11.0/sc2 term ran away to ~az*190 near the horizon and
       aliased to a flat mid grey - which is most of why this field still read as
       water. Band-limit it instead: keep the frequency bounded, and fade
       CONTRAST toward the patch mean as the pattern stops resolving. That is
       what real ground texture does under perspective, and it leaves a dark
       forested valley rather than a smooth grey sheet. */
    float sc2 = clamp(1600.0/dist, 0.05, 1.0);
    float res = smoothstep(0.05, 0.34, sc2);          // 1 = resolvable, 0 = not
    float pn = fb(vec2(az*24.0 + 4.7, ldd*2.4));
    float forest = smoothstep(0.46, 0.72, pn);
    float open = smoothstep(0.30, 0.50, fb(vec2(az*44.0 + 1.3, ldd*3.1 + 8.0)));
    vec3 gAlb = mix(vec3(0.94,0.98,1.08), vec3(0.030,0.056,0.050),
                    mix(0.60, forest*0.94, res));
    gAlb *= 0.90 + 0.16*open*res;
    /* the floor is nearly flat, so its sun term is a constant - the variation
       has to come from patchiness and from cloud shadow, not from facing */
    float gLit = 0.62 + 0.30*smoothstep(0.35,0.75, fb(vec2(az*4.3+11.0, ldd*1.1)));
    vec3 gnd = gAlb*(vec3(1.35,1.20,0.96)*gLit + vec3(0.30,0.42,0.68)*0.34);
    float gh = clamp(1.0 - exp(-dist/9000.0), 0.0, 1.0);
    gh = mix(gh, 1.0, 0.22);                          // valleys always hold some haze
    vec3 hz0 = mix(vec3(0.46,0.62,0.94), vec3(1.00,0.94,0.82),
                   pow(max(cos(az-sunAz),0.0),2.0)*0.40);
    col = mix(gnd, hz0*1.02, gh);
    // feather the first 0.15 deg so the horizon line itself is not a hard seam
    col = mix(mix(hor, zen, 0.0), col, smoothstep(0.0015, 0.0075, -el));
  }

  /* The ranges are no longer painted here - they are real geometry rendered
     into this same target right after this quad. See RANGE_VERT / RANGE_FRAG. */

  /* valley haze pooling: now only a light touch, since the floor above already
     hazes with distance. 0.20 of a flat blue over everything below the horizon
     was most of why the old void read as water. */
  col = mix(col, vec3(0.56,0.70,0.95), smoothstep(-0.006,-0.10,el)*0.07);
  /* store LINEAR radiance (sqrt-encoded, see SKY_HDR) - the tonemap is applied
     once at render time by the dome, so the sky grades with the rest of the
     image instead of arriving as finished 8-bit display pixels.
     ALPHA IS A RANGE MASK: sky writes 0, the range mesh writes 1. The dome
     samples .rgb only, so alpha was dead storage; as a mask it makes "how do
     the range faces themselves read" answerable exactly, instead of by a
     colour heuristic that cannot tell a snow face from warm sky near the sun.
     Blending is off here (opaque material, NormalBlending) so a 0 alpha does
     NOT darken the sky - verify that before touching the material flags. */
  gl_FragColor = vec4(sqrt(clamp(col/SKY_HDR_C, 0.0, 1.0)), 0.0);
}`;

const QUAD_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }`;

/* pass 1: the heightfield, in the SAME polar grid the mesh uses, so every
   vertex reads one texel centre and the shadow march reads the same surface. */
const HT_FRAG = `
precision highp float;
varying vec2 vUv;
${GLSL_NOISE}
${GLSL_TERRAIN}
void main(){
  float phi = vUv.x*6.2831853;
  float r = exp(LR0 + vUv.y*LRS);
  gl_FragColor = vec4(packH(rgeH(vec2(-cos(phi)*r, sin(phi)*r))), 0.0, 1.0);
}`;

/* pass 2: the range mesh, projected STRAIGHT to equirect so it lands in the
   same bake as the sky quad. Each column is one azimuth, so a column maps to a
   vertical line and no triangle ever straddles the +-PI seam (the last column
   duplicates the first). Depth is the radial ring index, which is exactly the
   right occlusion order for rays leaving the origin. */
const RANGE_VERT = `
precision highp float;
attribute vec2 aIJ;
uniform sampler2D uHT;
uniform vec3 uSunB;
varying vec3 vW; varying vec3 vN; varying float vVis; varying float vR;
${GLSL_NOISE}
${GLSL_TERRAIN}
const float NA = RG_NA_C, NR = RG_NR_C;

float hGrid(float i, float j){ return unpackH(texture2D(uHT, vec2((i+0.5)/NA,(j+0.5)/NR)).rg); }
vec3 posAt(float i, float j){
  float phi = (i+0.5)/NA*6.2831853;
  float r = exp(LR0 + ((j+0.5)/NR)*LRS);
  return vec3(-cos(phi)*r, hGrid(i,j), sin(phi)*r);
}
float hWorld(vec2 w){
  float r = max(length(w), R0);
  return unpackH(texture2D(uHT, vec2(fract(atan(w.y,-w.x)*0.15915494309),
                                     clamp((log(r)-LR0)/LRS, 0.0, 1.0))).rg);
}
void main(){
  vec3 p  = posAt(aIJ.x, aIJ.y);
  vec3 pa = posAt(aIJ.x+1.0, aIJ.y), pb = posAt(aIJ.x-1.0, aIJ.y);
  vec3 pc = posAt(aIJ.x, min(aIJ.y+1.0, NR-1.0)), pd = posAt(aIJ.x, max(aIJ.y-1.0, 0.0));
  vec3 n = normalize(cross(pc-pd, pa-pb));
  vN = n.y < 0.0 ? -n : n;
  vW = p;
  vR = length(p.xz);

  /* CAST SHADOWS: march the heightfield along the sun azimuth and compare the
     horizon angle it subtends against the sun's own elevation. This is the
     thing a painted silhouette can never do, and it is most of what makes a
     real range read as solid rather than as a texture. */
  vec3 s = normalize(SUNDIR);
  vec2 sd = normalize(s.xz);
  float sunTan = s.y/length(s.xz);
  /* 21 steps is exactly the field: 140 * 1.34^21 = 65 km, just past R1 = 52 km,
     beyond which hWorld clamps to the last ring and every further sample is
     redundant. The old 26 marched to 282 km, i.e. 19% of the bake's dependent
     texture fetches - and this loop is what dominates bake time, since it runs
     per VERTEX and each step costs an atan plus a texture read. */
  float dh = 140.0, horiz = -9.0;
  for(int k=0;k<SUN_STEPS_C;k++){
    horiz = max(horiz, (hWorld(p.xz + sd*dh) - p.y)/dh);
    dh *= SUN_GROW_C;
  }
  vVis = 1.0 - smoothstep(sunTan-0.040, sunTan+0.012, horiz);

  float theta = atan(vR, p.y);                       // polar angle from +Y, 0..PI
  gl_Position = vec4(((aIJ.x+0.5)/NA)*2.0-1.0,
                     (1.0 - theta*0.31830988618)*2.0-1.0,
                     (aIJ.y/(NR-1.0))*2.0-1.0, 1.0);
}`;

const RANGE_FRAG = `
precision highp float;
uniform float uRSun;      /* sun gain, sweepable in-page with #keepsky + bake() */
uniform vec3 uSunB;
varying vec3 vW; varying vec3 vN; varying float vVis; varying float vR;
${GLSL_NOISE}
${GLSL_TERRAIN}
void main(){
  vec3 N = normalize(vN), s = normalize(SUNDIR);
  float y = vW.y, steep = 1.0 - N.y;

  /* Surface type from REAL altitude and REAL surface slope. The old painted
     version had to fake both - a "dep" ramp for altitude and a noise-domain
     gradient for slope - and every mask bug in this file came from that. */
  float jit = (vn(vW.xz*0.00035)-0.5)*420.0;         // wandering snow/tree lines
  /* This is a WINTER scene: snow is the DEFAULT surface and rock is what steep
     ground exposes, not the other way round. Gating snow purely on altitude
     left the whole valley as bare rock, which hazed to a flat fog grey and was
     most of why the first geometry build read as overcast. */
  /* Re-tuned against the steepened field above. These thresholds are only
     meaningful relative to the geometry's slope distribution, so they must be
     re-measured whenever rgeH changes - the sweep reports crest-band
     snow/rock/forest directly. Target came from uploads/mountain_render.jpeg:
     crest 56% snow / 31% rock / 13% forest. */
  float gentle  = 1.0 - smoothstep(0.21, 0.63, steep);
  float snowAlt = smoothstep(-820.0+jit, 240.0+jit, y);
  float snow    = clamp(gentle*(0.42 + 0.58*snowAlt), 0.0, 1.0);
  float below   = 1.0 - smoothstep(-180.0+jit, 620.0+jit, y);  // treeline
  float forest  = below*(1.0-smoothstep(0.24,0.58,steep))
                       *smoothstep(0.34,0.62, fb(vW.xz*0.00052));
  snow *= 1.0 - forest*0.92;

  vec3 rock = mix(vec3(0.050,0.055,0.068), vec3(0.115,0.113,0.126), vn(vW.xz*0.0032));
  vec3 alb  = mix(rock, vec3(1.02,1.05,1.13), snow);
  alb = mix(alb, vec3(0.026,0.047,0.043), forest);

  /* strong sun, restrained ambient. A big hemisphere fill flattens exactly the
     sun/shade separation that gives a range its form. */
  vec3 col = alb*( vec3(1.42,1.24,0.98)*uRSun*max(dot(N,s),0.0)*vVis
                 + vec3(0.32,0.48,0.86)*(0.5+0.5*N.y)*0.30
                 + vec3(0.34,0.34,0.30)*0.06 );

  /* aerial perspective on REAL distance, pooling a little in the valleys */
  float haze = (1.0-exp(-vR/30000.0))*(0.72+0.28*clamp(1.0-(y+720.0)/2600.0,0.0,1.0));
  col = mix(col, hazeCol(normalize(vW), s)*1.02, clamp(haze,0.0,1.0));

  /* alpha 1 = "this pixel is a mountain" (see the mask note in SKY_FRAG) */
  gl_FragColor = vec4(sqrt(clamp(col/SKY_HDR_C, 0.0, 1.0)), 1.0);
}`;

function glowTex() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,246,214,.95)');
  g.addColorStop(0.14, 'rgba(255,226,160,.55)');
  g.addColorStop(0.42, 'rgba(255,206,140,.16)');
  g.addColorStop(1, 'rgba(255,200,140,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class Sky {
  constructor(scene, ren, uni) {
    this.uni = uni;
    const sun = uni.uSun.value;
    /* the ranges sit right at the horizon, where an equirect bake is most
       stretched: go 4k wide wherever the GPU allows it */
    /* The old gate here shrank ONLY the output RT and only for mobile UAs, so a
       Windows laptop reporting maxTextureSize 16384 baked at full size no matter
       how weak its GPU actually was.  One tier now drives grid, march and RT. */
    const tier = skyGpuTier(ren);
    this.tier = tier;
    const big = !tier.weak;
    /* depthBuffer is now REQUIRED: the range geometry depth-tests against
       itself so nearer ranges occlude farther ones. */
    this.rt = new THREE.WebGLRenderTarget(big ? 4096 : 2048, big ? 2048 : 1024, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, generateMipmaps: false,
      colorSpace: THREE.NoColorSpace, depthBuffer: true
    });
    /* THE SUN USED TO BE SUBSTITUTED IN AS A LITERAL HERE, which froze the baked
       sky - its sun disc, halo, cloud shading and every range face - to whatever
       uSun was at construction. Moving uSun then re-lit the whole world while the
       sky kept the OLD sun painted into it, so the glare sat in one place and the
       shadows fell from another. It is now a real uniform, SHARED BY REFERENCE
       with the scene's uSun, so a re-bake always agrees with the lighting. */
    const inject = src => src
      .replace(/SUNDIR/g, 'uSunB')
      .replace(/SKY_HDR_C/g, SKY_HDR.toFixed(1))
      .replace(/RG_NA_C/g, tier.na.toFixed(1))
      .replace(/RG_NR_C/g, tier.nr.toFixed(1))
      /* loop bound must stay a literal: GLSL ES 1.00 needs a constant expression */
      .replace(/SUN_STEPS_C/g, String(tier.steps))
      .replace(/SUN_GROW_C/g, tier.grow.toFixed(2));

    this.bakeMat = new THREE.ShaderMaterial({
      uniforms: { uPhase: { value: 0 }, uSunB: uni.uSun },
      vertexShader: QUAD_VERT,
      fragmentShader: inject(SKY_FRAG),
      depthTest: false, depthWrite: false
    });
    this.bakeScene = new THREE.Scene();
    const skyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bakeMat);
    skyQuad.renderOrder = 0;
    this.bakeScene.add(skyQuad);
    this.bakeCam = new THREE.Camera();

    // ---- pass 1 target: polar heightfield, one texel per mesh vertex
    this.htRT = new THREE.WebGLRenderTarget(tier.na, tier.nr, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false, depthBuffer: false, colorSpace: THREE.NoColorSpace
    });
    this.htScene = new THREE.Scene();
    this.htScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: inject(HT_FRAG),
      depthTest: false, depthWrite: false
    })));

    // ---- the range mesh: a polar grid carrying only its own (column,row)
    const cols = tier.na + 1;                     // last column duplicates the first
    const ij = new Float32Array(cols * tier.nr * 2);
    for (let j = 0, k = 0; j < tier.nr; j++)
      for (let i = 0; i < cols; i++, k += 2) { ij[k] = i; ij[k + 1] = j; }
    const idx = new Uint32Array(tier.na * (tier.nr - 1) * 6);
    for (let j = 0, k = 0; j < tier.nr - 1; j++)
      for (let i = 0; i < tier.na; i++) {
        const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    const rg_ = new THREE.BufferGeometry();
    rg_.setAttribute('aIJ', new THREE.BufferAttribute(ij, 2));
    rg_.setIndex(new THREE.BufferAttribute(idx, 1));
    this.rangeMesh = new THREE.Mesh(rg_, new THREE.RawShaderMaterial({
      uniforms: { uHT: { value: this.htRT.texture }, uRSun: { value: R_SUN }, uSunB: uni.uSun },
      vertexShader: inject(RANGE_VERT), fragmentShader: inject(RANGE_FRAG),
      side: THREE.DoubleSide, depthTest: true, depthWrite: true
    }));
    this.rangeMesh.frustumCulled = false;         // it has no 'position' attribute
    this.rangeMesh.renderOrder = 1;               // after the sky quad
    this.bakeScene.add(this.rangeMesh);

    this.bakeMs = 0;
    this.bake(ren, 0);

    /* bake() runs exactly once and uPhase never changes at runtime, so every
       resource above is dead the moment it returns. Keeping them cost ~25 MB of
       VRAM for the whole session (a 4.7 M-entry Uint32 index buffer plus the
       aIJ attribute) and held the polar heightfield target open on top.
       Dropping them is what makes the grid resolution above free.
       Note the probe harness reads htRT, so keep a debug escape hatch. */
    if (!SKY_DYN && !(typeof location !== 'undefined' && /[?&#]keepsky/.test(location.href))) {
      this.bakeScene.remove(this.rangeMesh);
      this.rangeMesh.geometry.dispose();
      this.rangeMesh.material.dispose();
      this.rangeMesh = null;
      this.htRT.dispose();
      this.htDisposed = true;
    }

    this.dome = new THREE.Mesh(new THREE.SphereGeometry(4200, 48, 24), new THREE.ShaderMaterial({
      uniforms: Object.assign({ uMap: { value: this.rt.texture } }, TONE),
      side: THREE.BackSide,
      depthWrite: false, depthTest: false,
      vertexShader: `varying vec3 vD; void main(){ vD=position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: GLSL_TONE + `uniform sampler2D uMap; varying vec3 vD;
        void main(){
          vec3 d = normalize(vD);
          float th = acos(clamp(d.y,-1.0,1.0));
          float ph = atan(d.z, -d.x);
          vec2 uv = vec2(ph*0.15915494309, 1.0 - th*0.31830988618);
          vec3 e = texture2D(uMap, uv).rgb;
          gl_FragColor = vec4(outc(e*e*${SKY_HDR.toFixed(1)}), 1.0);
        }`
    }));
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);

    // sun glare sprite
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex(), transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.9
    }));
    this.glow.scale.setScalar(900);
    this.glow.renderOrder = -8;
    scene.add(this.glow);
  }
  bake(ren, phase) {
    /* The range mesh is disposed right after the one and only bake, so a second
       call would quietly re-render the sky quad ALONE and wipe the mountains.
       Nothing calls it twice today; fail loudly if that ever changes rather
       than shipping a sky that silently lost its ranges. */
    if (!this.rangeMesh && this.htDisposed) {
      console.warn('sky.bake() after dispose - ranges would be lost; ignored. ' +
                   'Load with #keepsky to re-bake.');
      return;
    }
    const t0 = nowMs();
    this.bakeMat.uniforms.uPhase.value = phase;
    const old = ren.getRenderTarget();
    ren.setRenderTarget(this.htRT);               // pass 1: heightfield
    ren.render(this.htScene, this.bakeCam);
    ren.setRenderTarget(this.rt);                 // pass 2: sky quad + ranges
    ren.render(this.bakeScene, this.bakeCam);
    ren.setRenderTarget(old);
    try { ren.getContext().finish(); } catch (e) { }
    this.bakeMs = nowMs() - t0;
    this.lastBake = phase;
  }
  /* Re-light the baked sky for whatever uSun currently holds. Pass 1 (the polar
     heightfield) is sun-INDEPENDENT and its target persists, so a re-light only
     needs pass 2 - the sky quad plus the range mesh and its shadow march. */
  relight(ren) {
    if (!this.rangeMesh) { console.warn('sky.relight() after dispose - ignored (SKY_DYN false?)'); return false; }
    const t0 = nowMs();
    const old = ren.getRenderTarget();
    ren.setRenderTarget(this.rt);
    ren.render(this.bakeScene, this.bakeCam);
    ren.setRenderTarget(old);
    this.bakeMs = nowMs() - t0;
    return true;
  }
  update(cam, t, ren) {
    this.dome.position.copy(cam.position);
    const s = this.uni.uSun.value;
    this.glow.position.set(cam.position.x + s.x * 2600, cam.position.y + s.y * 2600, cam.position.z + s.z * 2600);

  }
}

