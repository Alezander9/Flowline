/* ------------------------------------------------- shared shader library */
const GLSL_COMMON = GLSL_TONE + `
uniform vec3 uSun, uSunCol, uSkyCol, uGndCol, uFogA, uFogB;
uniform float uFogD, uTime;
uniform sampler2D uSkyMap;
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
vec3 skyAt(vec3 d){
  float up = clamp(d.y*0.5+0.5,0.0,1.0);
  vec3 c = mix(uFogA, uSkyCol, pow(up,0.9));
  float s = max(dot(d, uSun),0.0);
  c += uSunCol*pow(s,7.0)*0.55 + uSunCol*pow(s,120.0)*3.0;
  c = mix(c, uFogB, pow(max(s,0.0),3.5)*0.35*(1.0-up));
  return c;
}
/* Aerial perspective. The exponential term fades toward the sun-tinted haze
   colour and is UNCHANGED - looking down at nearby ground the view direction
   points below the horizon, where the equirect sky bake holds no meaningful
   backdrop, so near/mid fog must keep using uFogA/uFogB.

   The FAR CLAMP is different, and it was the whole "edge of the world" defect.
   It used to drive f to 1 with the SAME constant colour, so past 2350 m the
   terrain became a flat slab of uFogA - strongly blue (sRGB 189,215,251) -
   pasted over a dome that varies from 155 to 209 and is near-neutral grey.
   MEASURED: 95.6% of far-terrain pixels differed from the backdrop they occlude
   by more than 8 sRGB, median 41.5, and terrain luminance p50 == p95 == 219.2
   (a constant). Where coverage runs out mid-slope that reads as a pale shelf
   with a hard geometric edge, hiding up to 242 m of mountain (see 7.6 in
   outputs/flowline_todo.md).

   So the clamp now fades to the DOME'S OWN RADIANCE ALONG THE VIEW RAY. At
   full weight the terrain equals its own backdrop BY CONSTRUCTION, so the seam
   cannot exist at any yaw, any sun angle or any time of day - and tending to
   the background radiance is what aerial perspective physically does. The uv
   mapping and the sqrt-HDR decode must match the dome's own shader
   (sky.js: equirect, e*e*SKY_HDR); Sky.relight() re-renders into the same
   render target, so this keeps working when the sun moves. The fetch is
   UNCONDITIONAL because an implicit-LOD texture2D inside non-uniform control
   flow has undefined derivatives; the smoothstep weight does the work. */
vec3 applyFog(vec3 col, float dist, vec3 vdir){
  float f = 1.0-exp(-dist*uFogD);
  float s = pow(max(dot(vdir,uSun),0.0),3.0);
  col = mix(col, mix(uFogA, uFogB, s*0.8), f);
  vec3 d = normalize(vdir);
  vec2 uv = vec2(atan(d.z,-d.x)*0.15915494309,
                 1.0 - acos(clamp(d.y,-1.0,1.0))*0.31830988618);
  vec3 e = texture2D(uSkyMap, uv).rgb;
  return mix(col, e*e*${SKY_HDR.toFixed(1)}, smoothstep(1150.0, 2350.0, dist));
}
`;

/* ------------------------------------------------- snow shading library
   Ported from SNOWFLOW (github.com/Noniv/snowflow_demo, MIT (c) Noniv) - its
   WGSL is all fullscreen/vertex work, so every term here is plain GLSL. What
   the old shader was missing, in order of how much it mattered:
     - no transmission at all, and wrap was 0.11 (i.e. every surface was shaded
       as if it were packed ice). Loose snow wraps ~0.62.
     - one corduroy sine instead of multi-scale detail normals.
     - a 2-colour hemisphere ambient, with the lower half a DARK grey - for a
       material with 0.9 albedo lying on more of itself. Troughs went too dark.
     - surface state was albedo-only, so a packed line could only be made to
       read by faking a light cut. Roughness + thickness are the real channels. */
const GLSL_SNOW = `
uniform float uPxK, uDetail; uniform vec2 uWind, uSss, uBrm; uniform vec3 uSast;
uniform sampler2D uGrain; uniform vec3 uGrainK;
/* value noise with an analytic gradient: (value, dV/dx, dV/dy). 4 hashes. */
vec3 vnoiseD(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = h21(i), b = h21(i+vec2(1.0,0.0)), c = h21(i+vec2(0.0,1.0)), d = h21(i+vec2(1.0,1.0));
  vec2 u = f*f*(3.0-2.0*f), du = 6.0*f*(1.0-f);
  float k0 = b-a, k1 = c-a, k2 = a-b-c+d;
  return vec3(a + k0*u.x + k1*u.y + k2*u.x*u.y,
              du.x*(k0 + k2*u.y),
              du.y*(k1 + k2*u.x));
}
/* One octave of wind-shaped relief, as a world-space XZ gradient.
     wv     wavelength in metres, amp = peak height in metres
     shear  stretches the cell ALONG wdir, so ridges run downwind
     sharp  0..1 creases the crest. Real sastrugi have a knife crest and a
            rounded trough, which is ridged noise (h = 1-|2n-1|), not a sine.
     skew   steepens the up-wind face and stretches the lee tail. This
            asymmetry is what makes a field read as wind-CARVED rather than
            as lumpy noise, and it costs one divide.
     fp     the pixel's world footprint - an octave the screen cannot resolve
            is faded out instead of aliased. */
vec2 reliefGrad(vec2 p, vec2 wdir, float wv, float amp, float shear, float sharp, float skew, float fp){
  float res = smoothstep(2.0, 5.0, wv/max(fp,0.0015));   // >~2.5 px per wave
  if(res <= 0.001) return vec2(0.0);
  vec2 cw = vec2(-wdir.y, wdir.x);
  vec2 q = vec2(dot(p,wdir)/shear, dot(p,cw));           // wind-aligned, stretched
  vec3 n = vnoiseD(q/wv);
  vec2 g = vec2(n.y/shear, n.z)/wv;
  /* d/dq of 1-|2n-1| is -2*sgn(2n-1)*dn. The sgn is softened: a true step
     makes the crease itself unresolvable and it shades as a bright spike. */
  float s = 2.0*n.x - 1.0;
  g *= mix(1.0, -2.0*(s/(abs(s)+0.22)), sharp);
  g.x *= 1.0 + skew*(g.x/(abs(g.x) + 0.30/wv));          // asymmetry along the wind
  /* MEASURED: this value noise has mean |dV/dcell| ~= 0.33 (the corner hashes
     differ by ~1/3 on average and smoothstep spreads that over a whole cell),
     while a real crest of peak height A and wavelength wv reaches a slope of
     2*pi*A/wv - about 6x more. Without that factor amp behaves like a height
     but shades like a 1-degree ripple: at amp 5cm / wv 1.9m the whole octave
     moved 0.02% of an on-piste frame. GK restores the slope a crest that tall
     actually has, so amp can stay an honest height in metres. */
  const float GK = 5.2;
  return (wdir*g.x + cw*g.y)*amp*res*GK;
}
/* The whole wind-relief stack as one world-XZ gradient, to be added to the base
   slope before the normal is built. Lives here, next to snowSurf/snowLight, so
   the terrain and the carve trail cannot drift apart in look - the same reason
   the material model is shared.
     N      geometric normal: drives windward exposure and the steep fade
     loose  1 = untouched powder, 0 = groomed / packed / carved flat
     detail 0 = low tier, coarse octave only
   Returns (gradient.x, gradient.y, exposure), the last so the caller can couple
   surface state to it: wind-scoured snow is genuinely harder than deposited snow. */
vec3 snowRelief(vec3 wp, vec3 N, float loose, float fp, float detail, float promo){
  vec2 p = wp.xz, W = uWind, CW = vec2(-W.y, W.x);
  /* One broad fetch, two jobs: its VALUE is the exposure patch field (scoured
     vs deposited), its GRADIENT domain-warps every octave below, so drift
     fields snake across the slope instead of tiling as evenly spaced lumps. */
  vec3 br = vnoiseD(p*0.0216);
  vec2 warp = vec2(br.y, br.z)*3.4;
  /* Wind travels toward W, so a slope facing INTO it has -dot(N.xz,W) > 0.
     Windward gets scoured into hard sastrugi, lee collects soft deep drifts;
     the noise term breaks it up so exposure is not purely a function of slope.
     MEASURED: the slope weight was 2.2, but a piste normal has |N.xz| ~0.4, so
     that term alone was +-0.9 and clamped the whole near field to expo 0 (dumped
     it to a debug colour to see it). Keep the slope weight below the constant. */
  float expo = clamp(0.45 - dot(N.xz, W)*0.90 + (br.x-0.5)*1.30, 0.0, 1.0);
  expo = mix(0.5, expo, uSast.z);
  float steep = smoothstep(0.72, 0.34, N.y);
  /* steep faces lose most of it: the gradient form degenerates there (it is a
     heightfield trick, not a tangent-space map), and stretched grain up a 60
     degree face is instantly legible as a smear.
     A groomer erases wind relief but does not polish glass, so packed snow keeps
     half. MEASURED: at the old 0.35 floor and old amplitudes, an 8x sastrugi
     multiplier changed 0.035% of an on-piste frame - i.e. invisible. */
  float amp = (1.0 - 0.72*steep) * (0.50 + 0.50*loose);
  /* Amplitudes are set by SLOPE, not height: what shading sees is amp/wavelength.
     Real sastrugi run 10-25 cm over a 1-2 m wave, i.e. slopes around 0.2 - the
     old 5 cm over 1.9 m was a 1.6 degree tilt and could not read at any exposure. */
  /* PK is the slope fraction real geometry supplies once an octave is promoted
     (1/GK). Scaling the fake by (1-promo*PK) keeps the TOTAL slope identical to
     the unpromoted build, so promotion is a change of substrate, not of look. */
  const float PK = 1.0/5.2;
  float pc = 1.0 - promo*PK;
  /* DG: the 7.5 m octave is now REAL geometry in sampleAt (see terrain_core),
     so the fake must shed the slope the geometry supplies or the drift is
     counted twice. For slope invariance the fake must shed EXACTLY the slope the
     geometry supplies: real/fake = A_geo/(GK*A_fake) = 0.26/(5.2*0.49) = 0.102,
     so DG = 1 - 0.102 = 0.90.
     MEASURED: the frozen-frame A/B against the shipped build is NULL - shading
     sd 34.053 -> 34.059, hf energy 5.189 -> 5.193, mean 124.17 -> 124.18 at a
     byte-matched site. That null IS THE PROOF this compensation is right, not a
     failure: the look is meant to be preserved. What promotion buys is that the
     height is REAL, so physics, props and the trail all feel the drift and the
     fine patch displaces a true surface instead of a normal-map lie. */
  const float DG = 0.90;
  vec2 g = reliefGrad(p + warp, W, 7.50, 0.480*amp*(1.25-0.45*expo)*pc*DG, 2.60, 0.10, 0.30, fp);
  if(detail > 0.5){
    // knife-crested ridges running downwind, only where the wind scours
    g += reliefGrad(p + warp*0.5, W, 1.90, 0.350*amp*(0.55+0.90*expo)*uSast.x*pc, 2.20, 0.62, 0.85, fp);
    // wind ripples run ACROSS the wind - the opposite orientation to sastrugi
    g += reliefGrad(p, CW, 0.44, 0.0520*amp*(0.60+0.70*expo)*uSast.y, 2.60, 0.35, 0.45, fp);
    g += reliefGrad(p, W, 0.13, 0.0055*amp, 1.15, 0.0, 0.0, fp);   // grain
    /* S2 - TILED GRAIN, the sub-13 cm range procedural octaves cannot reach.
       Another reliefGrad octave at, say, 2 cm would alias hopelessly: the
       resolvability term would fade it out before it was ever resolvable, because a value-noise
       fetch has no mip chain. A TILED TEXTURE gets hardware trilinear mip
       filtering for free, and that IS the whole trick - as a pixel's footprint
       grows the fetch converges to the map's mean, and the map is the gradient
       of a periodic field so its mean is EXACTLY zero. The layer therefore
       fades itself out with distance instead of shimmering.
       Folded in as a world-XZ SLOPE, not as a tangent-space normal: this stack
       is already a gradient sum, so there is no frame to build and no RNM blend
       to do - and a slope cannot wash out the landform the way an over-strong
       normal map does.
       ONE map at TWO tile sizes: 0.13 m carries 1.6 cm -> 1 mm, 0.55 m carries
       6.9 cm -> 4 mm, and the second scale is what stops the first one's repeat
       from being legible. Both fetches are UNCONDITIONAL: an implicit-LOD
       texture read behind non-uniform control flow has undefined derivatives,
       so the resolvability term scales the RESULT and never gates the fetch. */
    float gf = smoothstep(1.0, 3.0, 0.13/max(fp,0.0015));
    float gm = smoothstep(1.0, 3.0, 0.55/max(fp,0.0015));
    /* Steep faces shed it for the same reason the other octaves do (a heightfield
       gradient trick smears up a 60 degree wall), and a groomer/carve polishes
       the grain down without erasing it - SNOWFLOW's compression term. */
    float gk = (1.0 - 0.72*steep) * (0.45 + 0.55*loose) * uGrainK.z;
    g += (texture2D(uGrain, (p + warp*0.25)/0.13).xy*2.0-1.0) * (uGrainK.x*gk*gf);
    g += (texture2D(uGrain, p/0.55).xy*2.0-1.0) * (uGrainK.y*gk*gm);
  }
  return vec3(g, expo);
}
/* Wrapped diffuse. 0 is Lambert; loose snow wants ~0.6, which carries the
   terminator most of the way round the back of a drift. */
float wrapDiffuse(float ndl, float w){ return max(0.0,(ndl+w)/((1.0+w)*(1.0+w))); }
/* Back-scatter transmission. L points TOWARD the sun; the lobe is measured
   against -(L+N*distortion), the direction light continues after passing
   through. Building it from -L inverts the term and the snow goes dead exactly
   where it should be most alive. Thin edges transmit brightly and widely;
   deep snow transmits little and only near straight-through. */
vec3 snowSubsurface(vec3 N, vec3 L, vec3 V, vec3 lcol, float thick, float strength, float radius){
  vec3 tint = mix(vec3(0.94,0.965,1.0), vec3(0.55,0.72,1.0), clamp(thick*radius,0.0,1.0));
  vec3 H = normalize(L + N*(0.28*radius));
  float back = pow(clamp(dot(V,-H),0.0,1.0), mix(3.0,9.0,thick)) * mix(1.0,0.30,thick);
  return lcol*tint*back*strength;
}
float distGGX(float ndh, float r){
  float a = r*r, a2 = a*a, d = ndh*ndh*(a2-1.0)+1.0;
  return a2/max(3.14159*d*d, 1e-5);
}
float visSmith(float ndv, float ndl, float r){
  float a = r*r;
  float gv = ndl*sqrt(ndv*ndv*(1.0-a)+a), gl = ndv*sqrt(ndl*ndl*(1.0-a)+a);
  return 0.5/max(gv+gl, 1e-5);
}
vec3 fresnel(float u, vec3 f0){ return f0 + (1.0-f0)*pow(1.0-u, 5.0); }
/* Irradiance for snow lying on more of itself: a sky dome that hazes to the
   horizon colour, and a bright sun-tinted BOUNCE from below - not the dark grey
   the old hemisphere ambient used. */
vec3 snowIrradiance(vec3 N, vec3 bounce){
  float up = N.y*0.5+0.5;
  vec3 sky = mix(uFogA, uSkyCol, pow(up,0.8));
  return mix(bounce, sky, smoothstep(0.0,0.62,up));
}

/* ---------------- surface state: ONE material, three channels -------------
   Anything made of snow must derive its albedo, roughness and thickness from
   the same packed/loose/ice mix, or it reads as a different substance stuck to
   the slope. That is exactly what went wrong with the carve trail: it had its
   own hand-tuned constants, drifted from the terrain as the terrain gained a
   real BRDF, and ended up a grey ribbon lying between its own berms. */
struct SnowSurf { vec3 alb; float rough; float thick; vec3 f0; float wrap; };
SnowSurf snowSurf(float groom, float packed, float ice){
  SnowSurf s;
  float loose = (1.0-packed)*(1.0-ice);
  s.rough = mix(0.62, 0.78, loose);
  s.rough = mix(s.rough, 0.22, packed);
  s.rough = mix(s.rough, 0.07, ice);
  s.thick = mix(1.0, 0.28, packed);
  s.thick = mix(s.thick, 0.15, ice);
  s.f0    = mix(vec3(0.028), vec3(0.055), packed);
  s.f0    = mix(s.f0, vec3(0.070), ice);
  s.wrap  = mix(0.62, 0.12, max(packed, ice));
  s.alb   = mix(vec3(0.945,0.958,0.978), vec3(0.975,0.982,0.995), groom);
  s.alb   = mix(s.alb, vec3(0.52,0.57,0.66), packed*0.72);
  s.alb   = mix(s.alb, vec3(0.62,0.70,0.78), ice*0.42);
  return s;
}

/* ---------------- the snow lighting model, in ONE place -------------------
   Everything here depends only on view, light and surface state, so the piste
   and anything carved into it MUST share it. Callers add their own extras
   afterwards (the terrain its corduroy/track cut and crystal glints).
   ao = sky visibility, rsh = fraction of the sun occluded. */
vec3 snowLight(vec3 N, vec3 V, vec3 L, SnowSurf s, vec2 sss, float ice, float rsh, float ao){
  float ndl = dot(N,L), ndv = max(dot(N,V),1e-4);
  float shadow = 1.0 - 0.86*rsh;
  vec3 col = s.alb*uSunCol*wrapDiffuse(ndl, s.wrap)*shadow;
  /* Transmission is only PARTLY shadowed: scattered light still arrives
     through the snow, so a shadowed drift lip keeps glowing. Killing it
     with the shadow term is what makes shadowed snow flat and grey. */
  col += snowSubsurface(N,L,V,uSunCol,s.thick,sss.x,sss.y)*s.alb*mix(0.42,1.0,shadow);
  if(ndl > 0.0){
    vec3 H = normalize(V+L);
    col += uSunCol*distGGX(clamp(dot(N,H),0.0,1.0),s.rough)
         * visSmith(ndv,max(ndl,1e-4),s.rough)
         * fresnel(clamp(dot(V,H),0.0,1.0),s.f0)*ndl*shadow;
  }
  vec3 bounce = (uSunCol*max(uSun.y,0.0)*0.40*(1.0-0.72*rsh) + uSkyCol*0.30)*vec3(0.93,0.955,0.99);
  vec3 irr = snowIrradiance(N, bounce);
  irr += bounce*0.28*clamp(-N.y*0.5+0.5,0.0,1.0);       // snow onto itself
  /* Shadowed snow is not grey. It loses the sun but is still lit by the
     whole blue sky dome, which is exactly why real ski photos have
     luminous blue shadows - so tint ambient to sky rather than dim it. */
  irr = mix(irr, uSkyCol*0.92 + uFogA*0.22, rsh*0.50);
  irr *= ao;
  col += s.alb*irr*(0.46 - 0.05*rsh);
  // sky reflection, roughness-weighted (ice mirrors, powder does not)
  col += skyAt(reflect(-V,N))*fresnel(ndv,s.f0)*mix(0.35,2.6,ice)*(1.0-s.rough*0.8)*ao;
  col *= 1.0 - 0.10*(1.0 - ao);
  return col;
}
`;

/* ------------------------------------------------- terrain mesh (clipmap) */
const NX = 131, SNAP = 2, ANCH = 16, FAR = 2800;
/* Conforming clipmap.
   Every row has a cell size P that doubles at fixed distances, and every row is
   snapped onto a world lattice, so the set of sampled world positions never
   changes as the rider moves - it only ever slides by a whole cell. That is what
   keeps a kicker lip from breathing at any speed.
   Two things make the ring boundaries invisible:
   - all rows share ONE lateral anchor (a 16 m grid), and P only ever doubles, so
     a coarse row's lattice is always a subset of the fine row's in front of it.
     The 2:1 seam can then be stitched with real triangles (3 per coarse cell)
     from a static index buffer.
   - the row half-width is a continuous function of distance and the column count
     absorbs the pitch change, so the mesh no longer flares by 130 m in one row.
     That flare was the "dark ring at a fixed radius": its near-degenerate
     triangles spanned a whole hillside sideways. */
const LVL = [100, 200, 400, 800, 1600];
const cellAt = d => { let p = SNAP; for (let i = 0; i < LVL.length; i++) if (d >= LVL[i]) p *= 2; return p; };
const widthAt = d => Math.min(1900, 68 + 0.60 * Math.max(d, 0));
const ROWD = [], ROWP = [], ROWN = [], ROWM = [], ROWRES = [];
(() => {
  const push = (d, p) => {
    const n = Math.min(NX - (NX + 1) % 2, 2 * Math.max(4, Math.round(widthAt(d) / p)) + 1);
    ROWD.push(d); ROWP.push(p); ROWN.push(n); ROWM.push((n - 1) >> 1);
    // detail cutoff is continuous in distance: a stepped one puts a fold in the
    // snow exactly where the step is
    ROWRES.push(Math.max(SNAP, 0.038 * Math.max(d, 0)));
  };
  /* Behind the camera the rows step by SNAP, not 2*SNAP. They used to be 4 m
     apart, which was invisible (it is behind you) but it broke the one property
     the structural grid below depends on: that the whole near band is a single
     uniform 2 m world lattice. 30 rows instead of 15 costs ~1035 extra samples
     (~7 %) and it also halves the chord error under the trail, which is laid
     exactly here. */
  for (let d = -60; d < -0.5; d += SNAP) push(d, SNAP);
  let d = 0;
  while (d < FAR) { const p = cellAt(d); push(d, p); d += p; }
})();
const NZ = ROWD.length;
const MID = (NX - 1) >> 1;

/* ---- the STRUCTURAL grid: one surface, one authority ---------------------
   Everything that has ever gone wrong at the seam between two "versions" of the
   ground - the trail sinking under the snow, props floating 94 cm at the tree
   line, PB8's near-field lateral void - comes from there being three surfaces:
   the analytic sampleAt() field, the clipmap's vertex heights (band-limited by
   ROWRES), and what the rasteriser actually interpolates between them. The fix
   is not to make them agree more closely; it is to elect ONE of them and have
   every consumer read it.

   The elected surface is a uniform 2 m world lattice, and the useful discovery
   is that the clipmap ALREADY contains it. Every row snaps its own z to its own
   pitch (lz = round((sz+ROWD)/P)*P - sz) and every row shares one lateral
   anchor (ANCH = 16, a multiple of SNAP), so in the band where pitch == SNAP the
   vertices sit exactly on the global lattice x,z in 2*Z. So the structural grid
   is a WINDOW into rows that were going to be sampled anyway: zero extra
   sampleAt calls, and agreement with the drawn mesh by construction rather than
   by tuning.

   The band is the contiguous run of rows with pitch == SNAP *and*
   res == SNAP. Both conditions matter: past ~52 m ROWRES starts band-limiting by
   screen resolution, so a given world point's height would depend on which row
   happened to read it, i.e. on where the rider is. That is time-variance, the
   PB3 bug class, and it would make the grid unusable as an authority. */
let _sb = 0;
while (_sb + 1 < NZ && ROWP[_sb + 1] === SNAP && ROWRES[_sb + 1] === SNAP) _sb++;
const SB0 = 0, SB1 = _sb, NSZ = SB1 - SB0 + 1;
let _sim = Infinity;
for (let j = SB0; j <= SB1; j++) _sim = Math.min(_sim, ROWM[j]);
const SIM = _sim, NSX = 2 * SIM + 1;   // 69 x 57 texels = 16 KB at R32F

/* Reading the structural grid in a shader.
     uStrO.xy = world xz of texel (0,0)   uStrO.z = org.y, added back on read
     uStrK.xy = (NSX, NSZ)                uStrK.z = step (m)

   The interpolation is done in float from four NEAREST fetches rather than by
   asking the sampler for LINEAR, and that is not fussiness. Measured on an M5
   Pro, hardware bilinear on an R32F texture disagreed with the identical CPU
   bilinear by 1.39 mm RMS and 6.4 mm worst - the sampler quantises its subtexel
   WEIGHTS to about 8 bits, so on a 2 m texel with a metre of height across it
   the error lands in millimetres. The storage was never the problem. Since the
   whole point of this grid is that the CPU and the GPU read one surface, a
   6 mm split would be a designed-in disagreement, and it is exactly the size of
   detail (a rut rim, a berm shoulder) later phases care about. Four fetches and
   two mixes cost nothing and make the two paths agree to float epsilon.
   The index arithmetic deliberately mirrors strAt() line for line. */
const GLSL_STRUCT = `
  uniform sampler2D uStr, uStrA, uStrB; uniform vec4 uStrO; uniform vec4 uStrK;
  vec2 structG(vec2 p){ return (p - uStrO.xy)/uStrK.z; }
  float structH(vec2 p){
    vec2 g = clamp(structG(p), vec2(0.0), uStrK.xy - 1.0);
    vec2 i0 = min(floor(g), uStrK.xy - 2.0);
    vec2 t = g - i0, inv = 1.0/uStrK.xy;
    float h00 = texture2D(uStr, (i0 + vec2(0.5, 0.5))*inv).r;
    float h10 = texture2D(uStr, (i0 + vec2(1.5, 0.5))*inv).r;
    float h01 = texture2D(uStr, (i0 + vec2(0.5, 1.5))*inv).r;
    float h11 = texture2D(uStr, (i0 + vec2(1.5, 1.5))*inv).r;
    return mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y) + uStrO.z;
  }
  /* 0 outside the grid, 1 well inside, with a one-cell ramp so anything that
     fades between the grid and a fallback has no visible edge. */
  float structIn(vec2 p){
    vec2 g = structG(p);
    vec2 e = min(g, uStrK.xy - 1.0 - g);
    return clamp(min(e.x, e.y), 0.0, 1.0);
  }
  /* the same manual bilinear, for the two RGBA state grids. Same reason for
     NEAREST + float lerp: the fine patch and the coarse vertex it sits on must
     read one value, not two that differ in the eighth bit. */
  vec4 str4(in sampler2D s, vec2 p){
    vec2 g = clamp(structG(p), vec2(0.0), uStrK.xy - 1.0);
    vec2 i0 = min(floor(g), uStrK.xy - 2.0);
    vec2 t = g - i0, inv = 1.0/uStrK.xy;
    vec4 a = texture2D(s, (i0 + vec2(0.5, 0.5))*inv);
    vec4 b = texture2D(s, (i0 + vec2(1.5, 0.5))*inv);
    vec4 c = texture2D(s, (i0 + vec2(0.5, 1.5))*inv);
    vec4 d = texture2D(s, (i0 + vec2(1.5, 1.5))*inv);
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  }
  vec4 structA(vec2 p){ return str4(uStrA, p); }   // groom, ice, poachW, poachDist
  vec4 structB(vec2 p){ return str4(uStrB, p); }   // lat, ao, -, -
  /* Central difference at e metres. At e == the grid step this reproduces the
     coarse mesh's own normal exactly (it differences the same lattice at the
     same spacing), which is what keeps the patch boundary free of a shading
     seam as well as free of a crack. */
  vec3 structN(vec2 p, float e){
    float hx = structH(p + vec2(e, 0.0)) - structH(p - vec2(e, 0.0));
    float hz = structH(p + vec2(0.0, e)) - structH(p - vec2(0.0, e));
    return normalize(vec3(-hx, 2.0*e, -hz));
  }`;

/* ---- the FINE patch: a static hole in the clipmap, refilled at 0.25 m -----
   Deformation needs about four cells across a rut, so a 40 cm trench wants
   ~10 cm cells and the 1 m ruts R1 asks for want ~25 cm. Rebuilding the whole
   clipmap ladder down to 0.25 m is not the way: a 0.25 m row re-snaps every
   0.25 m travelled (120 rebuilds/s at 30 m/s), and it would put the four hard
   invariants of section 3.2 of the plan - uniform per-row pitch, one shared
   lateral anchor, a static index buffer, per-row snapping - at risk for the sake
   of a band only metres wide.

   Instead the coarse mesh keeps its 2 m ladder EXACTLY as it is and a rectangle
   of it is simply not indexed; a separate mesh fills that rectangle at 0.25 m,
   taking its height from the structural grid. Because the patch reads the same
   grid the coarse rows published, it agrees with them at every coarse lattice
   point, and along a coarse cell EDGE bilinear degenerates to the same linear
   interpolation the rasteriser was already doing - so the join is crack-free by
   construction rather than by a skirt or a fudge, and with no detail promoted
   yet the patch is a pure visual no-op.

   The rectangle is anchored to ax and to the 2 m z lattice, and 0.25 divides 2,
   so the patch vertices sit on a fixed global 0.25 m lattice: it slides by whole
   cells and never breathes. */
/* S3: the rectangle is as large as the elected surface allows. The uphill
   ceiling is NOT a taste decision - the structural band is the contiguous run of
   rows with pitch == SNAP *and* res == SNAP, and ROWRES leaves SNAP at d = 54
   (0.038*54 = 2.052), so the band ends at +52 m. Extending past it would make a
   world point's height depend on which row sampled it, i.e. time-variance, the
   PB3 bug class, which is exactly what disqualifies the grid as an authority.
   Laterally the limit is SIM*SNAP = +-68 m; +-30 m is taken because that is what
   a carve sweeps through, and behind the rider is left at -14 m because the
   chase camera sits ~8 m back, so geometry further behind is off screen.
   Measured cost of the enlargement at a frozen tier-3 viewpoint: 15,633 ->
   63,865 verts for +0.34 ms GPU (control noise floor 0.10 ms), which is why the
   0.25/0.5/1.0 m ring ladder that was planned for this is unnecessary - a flat
   0.25 m grid is affordable, and a flat grid keeps rowH()/meshAt()'s uniform
   per-row pitch invariant intact. */
const FP_STEP = 0.25, FP_HW = 30, FP_Z0 = -14, FP_Z1 = 52;
let _fj0 = -1, _fj1 = -1;
for (let j = SB0; j <= SB1; j++) { if (ROWD[j] === FP_Z0) _fj0 = j; if (ROWD[j] === FP_Z1) _fj1 = j; }
const FPJ0 = _fj0, FPJ1 = _fj1;
const FP_CI = Math.round(FP_HW / SNAP);          // coarse cells per side
const FP_NX = Math.round(2 * FP_HW / FP_STEP) + 1;
const FP_NZ = Math.round((FP_Z1 - FP_Z0) / FP_STEP) + 1;
/* the patch may only exist if its rectangle is entirely inside the uniform 2 m
   structural band and inside the narrowest row in it - otherwise the hole would
   expose ground the grid cannot refill */
const FP_OK = FPJ0 >= SB0 && FPJ1 > FPJ0 && FPJ1 <= SB1 && SIM >= FP_CI
  && (2 * FP_HW) % SNAP === 0 && SNAP % FP_STEP === 0;


/* THE snow fragment shader, shared verbatim by the coarse clipmap and the fine
   patch. One surface, one material model: the patch is a refinement of the
   same snow, so it must not own a second copy of this (that drift is exactly
   what made the wake trail read as a grey band before v8). */
const GLSL_PROMO = `
/* Declared here because the patch VERTEX shader includes this block without
   GLSL_SNOW (which owns these in the fragment). GLSL_PROMO and GLSL_SNOW are
   never concatenated into the same shader, so there is no redefinition. */
uniform vec2 uWind; uniform vec3 uSast; uniform float uPromo;
/* ------------------------------------------------- promoted relief (phase 3)
   The two octaves the 0.25 m fine patch can actually resolve (7.50 m and 1.90 m;
   Nyquist at 0.25 m cells is 0.5 m, so 0.44 m and 0.13 m stay shader-only) as
   REAL vertex displacement instead of a faked normal.

   THE NUMBER THAT DECIDES THIS DESIGN: reliefGrad multiplies its gradient by
   GK = 5.2 because value noise is far smoother per unit amplitude than a real
   crest. So the shipped relief is a normal-map lie whose IMPLIED height is 5.2x
   its stated amp - the 0.35 m sastrugi octave shades as though it were 1.8 m
   tall. That gives promotion only two self-consistent options:
     - displace by the implied height  -> 1.8 m boulders in the snow, and the
       drawn surface tears away from the CPU authority by metres;
     - displace by the HONEST height   -> real geometry, but only 1/GK = 19.2%
       of the slope the shader was faking, so the relief would go 5x flatter.
   Neither is acceptable alone, so we do both halves of one split: displace by
   the honest height AND scale the faked gradient by (1 - w/GK). The total slope
   is then exactly what ships today, but 19.2% of it is now genuine geometry -
   the part that can self-shadow, occlude, catch a rut and change a silhouette.
   w is per-vertex so it can taper to 0 at the patch rim, which is what keeps
   the join crack-free (measured worst 0 in phase 2a).

   Returns vec3(height metres, d/dx, d/dz) from ONE noise evaluation, so the
   height and the normal that shades it cannot drift apart. Helpers carry a _r
   suffix so this block is safe to concatenate next to GLSL_SNOW. */
float h21r(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)))*43758.5453123); }
vec3 vnoiseDr(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = h21r(i), b = h21r(i+vec2(1,0)), c = h21r(i+vec2(0,1)), d = h21r(i+vec2(1,1));
  vec2 u = f*f*(3.0-2.0*f), du = 6.0*f*(1.0-f);
  float k0 = b-a, k1 = c-a, k2 = a-b-c+d;
  return vec3(a + k0*u.x + k1*u.y + k2*u.x*u.y,
              du.x*(k0 + k2*u.y),
              du.y*(k1 + k2*u.x));
}
/* Same noise coordinates, same crest shaping and same skew as reliefGrad, so the
   promoted octave is the identical field - just measured as a height as well. */
vec3 reliefHG(vec2 p, vec2 wdir, float wv, float amp, float shear, float sharp, float skew){
  vec2 cw = vec2(-wdir.y, wdir.x);
  vec2 q = vec2(dot(p,wdir)/shear, dot(p,cw));
  vec3 n = vnoiseDr(q/wv);
  float v = n.x;
  vec2 g = vec2(n.y/shear, n.z)/wv;
  float s = 2.0*n.x - 1.0;
  /* ridged crest: h = 1-|2n-1|, and its derivative carries the same softened sgn */
  float sh = 1.0 - abs(s);
  v = mix(v, sh, sharp);
  g *= mix(1.0, -2.0*(s/(abs(s)+0.22)), sharp);
  g.x *= 1.0 + skew*(g.x/(abs(g.x) + 0.30/wv));
  /* centre it so promotion adds shape, not a DC lift of the whole surface */
  return vec3((v - 0.5)*amp, (wdir*g.x + cw*g.y)*amp);
}
/* The promoted part of the stack. Derives exposure and amp exactly as snowRelief
   does, from quantities a vertex shader also has, so the two agree by
   construction. loose here is built from groom/ice only (the poach-line trk term
   is a fragment-only distance field), which is why the fragment cancels with the
   same simplified weight. */
vec3 snowReliefPromo(vec3 wp, vec3 N, float loose){
  vec2 p = wp.xz, W = uWind;
  vec3 br = vnoiseDr(p*0.0216);
  vec2 warp = vec2(br.y, br.z)*3.4;
  float expo = clamp(0.45 - dot(N.xz, W)*0.90 + (br.x-0.5)*1.30, 0.0, 1.0);
  expo = mix(0.5, expo, uSast.z);
  float steep = smoothstep(0.72, 0.34, N.y);
  float amp = (1.0 - 0.72*steep) * (0.50 + 0.50*loose);
  vec3 a = reliefHG(p + warp,     W, 7.50, 0.480*amp*(1.25-0.45*expo), 2.60, 0.10, 0.30);
  vec3 b = reliefHG(p + warp*0.5, W, 1.90, 0.350*amp*(0.55+0.90*expo)*uSast.x, 2.20, 0.62, 0.85);
  return a + b;
}
`;

const SNOW_FRAG = GLSL_COMMON + GLSL_SNOW + GLSL_SHADOW + GLSL_CASCADE + GLSL_DEFORM + `
        uniform vec3 uOrg, uCam;   // uDetail is declared in GLSL_SNOW
        uniform float uAOAmt;
        varying float vAO;   // terrain sky occlusion (bowls, gullies, corridor walls)
        /* one band of crystal glints: round dots on a fixed lattice of cell
           size cs. The clipmap origin only ever moves in 2 m steps and cs
           divides 2 m, so the lattice is identical after a snap - the dots stay
           welded to the snow instead of sweeping past in the periphery. */
        float glint(vec2 p, float cs, float thr, float t){
          vec2 q = p/cs, c = floor(q);
          float sk = h21(c);
          if(sk < thr) return 0.0;
          vec2 ctr = 0.28 + 0.44*vec2(h21(c+vec2(11.3,4.7)), h21(c+vec2(27.7,63.1)));
          float d = length(fract(q) - ctr);
          return smoothstep(0.26,0.03,d)*(0.55+0.45*sin(t+sk*90.0));
        }
        varying vec3 vN, vW; varying vec4 vM; varying float vLat;
        varying float vPromo;   // 0 on the coarse mesh, the patch's taper on the patch
        void main(){
          vec3 N = normalize(vN);
          vec3 wp = vW + uOrg;
          vec3 vd = normalize(vW + uOrg - uCam);
          float dist = length(vW + uOrg - uCam);
          float fp = dist*uPxK;                 // world size of one pixel here
          float groom = vM.x, ice = vM.y;
          /* poach line, rebuilt per pixel from the interpolated distance field:
             a packed slick core, a shoulder crease either side, board ruts. */
          float pw = vM.z, tad = vM.w;
          /* ---------------- deformation --------------------------------
             Ruts and berms, rasterised from the stamp store into the two
             cascades. Read ONCE here; the gradient (4 more fetches) is gated
             on there being anything here at all, because on a normal frame
             almost every terrain pixel is undisturbed snow. */
          vec4 DF = dfFetch(wp.xz);
          float dfAny = DF.x + DF.y;
          float trk  = smoothstep(pw + 0.15, pw - 0.75, tad);
          float rf = smoothstep(820.0,40.0,dist);
          float crease = exp(-pow((tad - pw - 0.35) / 0.55, 2.0)) * smoothstep(11.0, 6.0, tad);

          /* ---------------- surface state -------------------------------
             One material, three channels. Every state drives albedo AND
             roughness AND thickness together - that coupling is what lets a
             packed line read without faking a light cut. */
          /* a rut is packed snow, and a hard-carved one glazes: these feed the
             SAME snowSurf channels as groom/ice, so a track is a material
             change (albedo AND roughness AND thickness), never a decal. */
          ice = max(ice, DF.w*0.85);
          float packed = max(max(groom, trk), DF.z);
          float loose  = (1.0-packed)*(1.0-ice);

          /* ---------------- relief -------------------------------------
             Multi-scale gradients accumulated in world XZ, then one normal
             built from the total. For a heightfield that is exactly right and
             avoids a tangent-frame RNM blend entirely. Runs BEFORE the surface
             state because it hands back the wind exposure the state needs. */
          vec3 rel = snowRelief(wp, N, loose, fp, uDetail, vPromo);
          vec2 g = vec2(-N.x, -N.z)/max(N.y, 0.30) + rel.xy;   // base slope + relief
          /* Wind-scoured snow is genuinely harder than snow the wind dropped, so
             exposure drives the packed channel too - which means it changes
             roughness and transmission, not just the normal. Without this the
             sastrugi read as a normal map laid over uniform material. Held to
             off-piste snow: a groomer erases the wind. */
          packed = max(packed, rel.z*loose*0.34);
          SnowSurf surf = snowSurf(groom, packed, ice);
          /* ---------------- S5: berm-crest translucency -----------------
             A berm is snow the board threw OUT of the cut, so it stands as a
             thin ridge with nothing behind it - and thin sunlit snow transmits.
             The material already has a thickness channel, so this needs no new
             lighting term: drop the thickness at the crest and the subsurface lobe
             widens (exponent 9 -> ~3.4) and stops being attenuated (x0.30 ->
             x0.96), which together is ~3x the transmission, tinted white
             instead of deep blue, because the tint keys on thickness too.
             DF.y is the berm channel normalised by DF_BMAX, so it is 0 on
             undisturbed snow and this whole block is then a no-op - the guard
             the acceptance asks for. It peaks at the crest by construction
             because that is where the berm is tallest.
             Transmission is geometric: snowSubsurface keys on dot(V,-H), so the
             glow only appears when the crest is between the camera and the sun.
             That is correct and is why it reads as light coming THROUGH the
             snow rather than as a brighter albedo. */
          float bermT = smoothstep(0.04, 0.26, DF.y);
          vec2 sss = uSss;
          /* CLAMP IS LOAD-BEARING: uBrm.x is a 0..1 BLEND toward the thin-snow
             target, so an amount above 1 would EXTRAPOLATE thickness past 0.06
             toward negative and buy contrast unphysically. Strength above the
             fully-thin crest belongs to uBrm.y, which is a bounded multiplier. */
          surf.thick = mix(surf.thick, 0.06, clamp(bermT*uBrm.x, 0.0, 1.0));
          sss.x *= 1.0 + bermT*uBrm.y;
          float rough = surf.rough;

          // corduroy: a real groove now, not an albedo stripe
          float cord = sin(vLat*3.05)*0.5+0.5;
          /* A BOARD ON HARDPACK CANNOT DIG A TRENCH - IT SMEARS THE CORDUROY.
             On a groomed piste groom is already 1.0, so max(groom, DF.z)
             saturates and the deformation's compression channel is completely
             masked: the track's material change does nothing on exactly the
             surface where its depth is smallest (measured ~4 cm on piste vs
             ~32 cm in powder). Erasing the corduroy where the board passed is
             what actually reads, and it is what the reference photographs show
             - on a piste a ridden line is visible because it has WIPED OUT the
             groomer's ridges, not because it is deep
             (uploads/snowboard_heavy_tracks_piste.png, gondola_piste_texture.jpg). */
          float cordF = groom*(1.0-ice)*smoothstep(640.0,28.0,dist)*(1.0 - clamp(DF.z*1.85, 0.0, 1.0));
          g.x += cos(vLat*3.05)*3.05*0.020*cordF;
          // board ruts inside a poach line
          g.y += cos(tad*8.5 + wp.z*0.5)*0.014*trk*rf;
          /* Berm shape at 6.3 cm even though the geometry carries it at 25 cm
             (coarse mesh: 2 m) - the same split between displacement and
             normal that the wind relief above already uses. */
          /* S1: the same gate buys the self-shadow march as well. On a normal
             frame the vast majority of terrain pixels are undisturbed snow, so
             both of these cost nothing there; dsh 0 / dao 1 is the pre-S1 image
             bit-for-bit. */
          float dsh = 0.0, dao = 1.0;
          if(dfAny > 0.004){
            g += deformGrad(wp.xz);
            dsh = deformShadow(wp.xz, uSun);
            dao = deformAO(DF);
          }
          N = normalize(vec3(-g.x, 1.0, -g.y));

          /* ---------------- albedo ------------------------------------- */
          surf.alb *= 1.0 - 0.10*cord*cordF;      // corduroy is terrain-only
          /* Board line is NOT the packed channel — on a groomed piste groom already
             saturates packed to 1, so that channel cannot mark a track.
             DF.x (cut depth) and DF.z (this stamp's compression) are zero
             off the line, so they are the only honest mask. */
          float boardLine = max(smoothstep(0.005, 0.050, DF.x), DF.z);
          surf.alb *= 1.0 - 0.38*boardLine*rf;
          surf.rough = mix(surf.rough, 0.13, boardLine*0.70*rf);
          surf.alb *= 1.0 + 0.10*smoothstep(0.03, 0.20, DF.y)*rf;

          /* ---------------- lighting ----------------------------------- */
          vec3 V = -vd, L = uSun;
          float ndv = max(dot(N,V),1e-4);
          /* the mountain and the trees now occlude the sun too, not just the
             rider - this is where the snow finally gets darks to shade against */
          /* The trench's own shadow goes into the SAME channel as the terrain
             and tree shadows, which is what earns it the whole treatment for
             free: transmission stays partly alive, and ambient tints to the sky
             dome instead of dimming - so a shadowed trench floor is luminous
             blue, exactly like the reference photographs, not grey. */
          float rsh = max(max(riderShadow(wp), sunShadow(wp, N, dist)), dsh);
          /* Large-scale occlusion. Ambient is sky light, so a bowl or a gully
             genuinely receives less of it - that is where the darks the image
             was missing come from. The SUN is deliberately left untouched: it
             already has real cascade shadows, and occluding it twice crushes. */
          /* terrain-scale occlusion (bowls, gullies) x deformation occlusion
             (this trench). Kept as separate factors so FL.dbg.ao(0) still
             isolates the terrain term. */
          float aoT = mix(1.0, vAO, uAOAmt)*dao;
          vec3 col = snowLight(N, V, L, surf, sss, ice, rsh, aoT);
          /* A trench genuinely loses sky, so a modest occlusion term stays - but
             it is now much smaller than before: the packed albedo + roughness +
             thickness carry the read, so this no longer has to be a 35% light
             cut fighting the tonemap to make the line visible at all. */
          col *= 1.0 - (0.12*trk + 0.18*crease)*rf;

          /* Crystal glints. The GGX lobe above now owns the broad sheen (the old
             pow(N.H,42/60/130) stack was doing that job by hand and is gone -
             keeping both double-counts specular). What is left here is the part
             a BRDF cannot express: individual sub-pixel facets flashing. They
             strengthen at grazing angles, where you actually see them. */
          vec3 hv = normalize(uSun - vd);
          float sp = pow(max(dot(N,hv),0.0), 42.0);
          float graze = mix(1.0, pow(1.0-ndv, 1.6)*2.4, 0.72);
          /* dot size tracks distance in power-of-two bands (crossfaded), so a
             glint is always a couple of pixels - never a metre-wide plate */
          float lvl = clamp(log2(max(dist,4.0)/17.0), 0.0, 3.99);
          float lf = floor(lvl), fr = lvl - lf;
          float cs = 0.125*exp2(lf);
          float thr = 0.88 - 0.03*uDetail;
          float twinkle = glint(vW.xz, cs, thr, uTime*7.0)*(1.0-fr)
                        + glint(vW.xz, cs*2.0, thr, uTime*7.0+1.7)*fr;
          float tw2 = glint(vW.xz*1.7+vec2(11.3,4.1), cs*0.55, thr-0.03, uTime*11.0);
          col += uSunCol*sp*(twinkle*1.15*6.4 + tw2*0.70*4.2)*graze
               *(1.0-ice*0.35)*(1.0-trk*0.22)
               * smoothstep(980.0,16.0,dist)*(1.0-rsh);
          /* crisp sun glitter on open snow — packed piste sparkles too */
          float dust = glint(vW.xz*0.31, 0.48, 0.82, uTime*1.7);
          float dust2 = glint(vW.xz*0.19+vec2(3.1,8.4), 0.95, 0.86, uTime*0.9);
          col += uSunCol*vec3(1.08,1.01,0.92)*(dust*0.14 + dust2*0.09)*graze
               *(0.35 + 0.65*loose)*(1.0-rsh)*smoothstep(1400.0,28.0,dist);

          col = applyFog(col, dist, vd);
          gl_FragColor = vec4(outc(col),1.0);
        }`;

/* ── S2: tileable grain gradient map ──────────────────────────────────────
   A periodic multi-octave value-noise height field, differentiated ON the grid
   with wrap-around and normalised to +-1, stored as (dH/dx, dH/dy). Because the
   field is periodic the map tiles seamlessly, and because it stores a DERIVATIVE
   of a zero-mean field every mip level averages toward 0.5 = "no slope", which
   is what makes the layer self-fading at distance rather than aliasing.
   Lattice periods divide N, so every octave wraps too. 256^2 RGBA8 = 256 KB
   with mips; built once and cached. */
const GRAIN_OCT = [[8, 1.00], [16, 0.62], [32, 0.38], [64, 0.22], [128, 0.12]];
let _grainTex = null;
function grainTexture(N) {
  if (_grainTex) return _grainTex;
  const H = new Float32Array(N * N);
  const hash = (x, y, s) => {
    let h = Math.imul(x, 1836311903) ^ Math.imul(y, 2971215073) ^ Math.imul(s + 1, 1013904223);
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const sm = t => t * t * (3 - 2 * t);
  for (let o = 0; o < GRAIN_OCT.length; o++) {
    const P = GRAIN_OCT[o][0], w = GRAIN_OCT[o][1], cell = N / P;
    for (let y = 0; y < N; y++) {
      const fy = y / cell, j0 = Math.floor(fy), ty = sm(fy - j0);
      const jj = j0 % P, j1 = (j0 + 1) % P;
      for (let x = 0; x < N; x++) {
        const fx = x / cell, i0 = Math.floor(fx), tx = sm(fx - i0);
        const ii = i0 % P, i1 = (i0 + 1) % P;
        const a = hash(ii, jj, o), b = hash(i1, jj, o), c = hash(ii, j1, o), d = hash(i1, j1, o);
        const lo = a + (b - a) * tx, hi = c + (d - c) * tx;
        H[y * N + x] += w * (lo + (hi - lo) * ty);
      }
    }
  }
  const G2 = new Float32Array(N * N * 2);
  let mx = 1e-9;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const xp = (x + 1) % N, xm = (x + N - 1) % N, yp = (y + 1) % N, ym = (y + N - 1) % N;
    const gx = (H[y * N + xp] - H[y * N + xm]) * 0.5, gy = (H[yp * N + x] - H[ym * N + x]) * 0.5;
    G2[(y * N + x) * 2] = gx; G2[(y * N + x) * 2 + 1] = gy;
    mx = Math.max(mx, Math.abs(gx), Math.abs(gy));
  }
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round(clamp(G2[i * 2] / mx * 0.5 + 0.5, 0, 1) * 255);
    data[i * 4 + 1] = Math.round(clamp(G2[i * 2 + 1] / mx * 0.5 + 0.5, 0, 1) * 255);
    data[i * 4 + 2] = 128; data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  _grainTex = t; return t;
}

class TerrainMesh {
  constructor(scene) {
    const n = NX * NZ;
    this.pos = new Float32Array(n * 3);
    this.nor = new Float32Array(n * 3);
    this.lat = new Float32Array(n);
    this.ao = new Float32Array(n).fill(1);   // large-scale terrain occlusion
    this.mat = new Float32Array(n * 4);   // groom, ice, poach half-width, distance to poach line
    // local xz template (constant), only y changes with world origin
    this.tx = new Float32Array(n); this.tz = new Float32Array(n);
    this.res = new Float32Array(NZ);
    /* structural grid, stored as LOCAL y (pos[] units) so a float32 keeps ~10 um
       of precision instead of the ~0.1 mm it would keep at a world y of -1300 */
    this.sh = new Float32Array(NSX * NSZ);
    this.strX0 = 0; this.strZ0 = 0;
    this.strTex = new THREE.DataTexture(this.sh, NSX, NSZ, THREE.RedFormat, THREE.FloatType);
    /* NEAREST on purpose: structH() interpolates in float (see GLSL_STRUCT) */
    this.strTex.minFilter = this.strTex.magFilter = THREE.NearestFilter;
    this.strTex.wrapS = this.strTex.wrapT = THREE.ClampToEdgeWrapping;
    this.strTex.generateMipmaps = false;
    this.strTex.needsUpdate = true;
    /* the surface STATE on the same grid, so the fine patch shades from the same
       numbers the coarse vertices carry: A = (groom, ice, poachW, poachDist),
       B = (lat, ao, -, -). Pure copies out of the rows, like sh above. */
    this.sA = new Float32Array(NSX * NSZ * 4);
    this.sB = new Float32Array(NSX * NSZ * 4);
    const mkT = a => {
      const t = new THREE.DataTexture(a, NSX, NSZ, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false; t.needsUpdate = true;
      return t;
    };
    this.strTexA = mkT(this.sA); this.strTexB = mkT(this.sB);
    for (let j = 0; j < NZ; j++) {
      this.res[j] = ROWRES[j];
      for (let i = 0; i < NX; i++) { const k = j * NX + i; this.tx[k] = (i - ROWM[j]) * ROWP[j]; this.tz[k] = ROWD[j]; }
    }
    /* index buffer: same-pitch rows share a lattice (offset by the width
       difference), a 2:1 seam gets three triangles per coarse cell, and the few
       columns by which one row overhangs its neighbour are fanned onto its edge
       vertex. Static, because every row is anchored to the same 16 m grid. */
    /* TWO index buffers over the SAME vertices: the drawn one has the fine
       patch's rectangle cut out of it, the full one does not. The full one is
       what the sun cascades rasterise - a hole in the shadow caster would put a
       lit rectangle under the rider - and it is also what FL.dbg.hole(false)
       restores, which makes "patch off + hole off" bit-identical to the mesh
       before the patch existed and so gives the no-op A/B an exact noise floor. */
    const idx = new Uint32Array(NX * NZ * 8);
    const idxF = new Uint32Array(NX * NZ * 8);
    let p = 0, pf = 0, hole = false;
    const tri = (a, b, c) => {
      idxF[pf++] = a; idxF[pf++] = b; idxF[pf++] = c;
      if (!hole) { idx[p++] = a; idx[p++] = b; idx[p++] = c; }
    };
    for (let j = 0; j < NZ - 1; j++) {
      const b0 = j * NX, b1 = (j + 1) * NX;
      const n0 = ROWN[j], n1 = ROWN[j + 1], m0 = ROWM[j], m1 = ROWM[j + 1];
      if (ROWP[j + 1] === ROWP[j]) {
        const D = m1 - m0;                       // row j vertex i == row j+1 vertex i+D
        const cut = FP_OK && j >= FPJ0 && j < FPJ1;
        for (let i = 0; i < n0 - 1; i++) {
          const a = b0 + i, b = b0 + i + 1, c = b1 + i + D, d = c + 1;
          hole = cut && (i - m0) >= -FP_CI && (i - m0) < FP_CI;
          tri(a, c, b); tri(b, c, d);
        }
        hole = false;
        for (let k = 0; k < D; k++) tri(b1 + k, b1 + k + 1, b0);                     // left overhang
        for (let k = n0 - 1 + D; k < n1 - 1; k++) tri(b0 + n0 - 1, b1 + k, b1 + k + 1); // right
      } else {                                   // row j fine, row j+1 coarse (2:1)
        for (let ic = 0; ic < n1 - 1; ic++) {
          const a = m0 + 2 * (ic - m1);          // fine vertex under coarse ic
          if (a >= 0 && a + 2 <= n0 - 1) {
            tri(b0 + a, b1 + ic, b0 + a + 1);
            tri(b0 + a + 1, b1 + ic, b1 + ic + 1);
            tri(b0 + a + 1, b1 + ic + 1, b0 + a + 2);
          } else {
            tri(b0 + (a < 0 ? 0 : n0 - 1), b1 + ic, b1 + ic + 1);
          }
        }
      }
    }
    this.idxCount = p; this.idxCountFull = pf;
    this.idxAttr = new THREE.BufferAttribute(idx, 1);
    this.idxFullAttr = new THREE.BufferAttribute(idxF, 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    g.setAttribute('aLat', new THREE.BufferAttribute(this.lat, 1));
    g.setAttribute('aMat', new THREE.BufferAttribute(this.mat, 4));
    g.setAttribute('aAO', new THREE.BufferAttribute(this.ao, 1));
    g.setIndex(this.idxAttr);
    g.setDrawRange(0, p);
    this._hole = true;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 500), 2400);
    this.geo = g;
    this.uni = {
      uSun: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color() },
      uSkyCol: { value: new THREE.Color() }, uGndCol: { value: new THREE.Color() },
      uFogA: { value: new THREE.Color() }, uFogB: { value: new THREE.Color() },
      uFogD: { value: 0.0016 }, uTime: { value: 0 }, uOrg: { value: new THREE.Vector3() },
      uCam: { value: new THREE.Vector3() }, uDetail: { value: 1 },
      /* uPxK: world metres per pixel at 1m, so the shader can fade a relief
         octave it cannot resolve instead of aliasing it. Refreshed per frame
         because fov moves with speed. */
      uPxK: { value: 0.002 }, uWind: { value: new THREE.Vector2(0.82, 0.57).normalize() },
      uSss: { value: new THREE.Vector2(0.9, 0.55) },
      /* S5 berm-crest translucency: (x = 0..1 blend of the crest's thickness
         toward the 0.06 thin-snow target, y = extra transmission strength once
         thin). x is CLAMPED in the shader, so the amount cannot buy contrast by
         extrapolating past the target - raise y instead. Live A/B: FL.dbg.berm();
         berm(0,0) is the pre-S5 image bit-for-bit.
         MEASURED on a 0.135 m berm over a 0.246 m trench (M5 Pro, tier 3, deep
         powder, geometric crest located via stamps.displaceAt): crest reads
         +13.3 sRGB against the shadowed trench floor, up from +3.4 pre-S5, and
         undisturbed sunlit snow moves EXACTLY 0.0 at every amount. */
      uBrm: { value: new THREE.Vector2(1.0, 1.0) },
      /* (sastrugi amp x, wind-ripple amp x, exposure amount) - live A/B knobs
         for the wind relief, see FL.dbg.sast(). */
      uSast: { value: new THREE.Vector3(1, 1, 1) },
      /* S2 tiled grain: (fine slope at the 0.13 m tile, mid slope at 0.55 m,
         master amount). Peak slopes - the map is normalised to +-1 - so RMS is
         roughly a quarter of these. Live A/B: FL.dbg.grain(). */
      uGrain: { value: grainTexture(256) },
      uGrainK: { value: new THREE.Vector3(0.72, 0.45, 1) },
      /* phase 3 promotion weight. 0 = the verified phase-2a build exactly (the
         patch is a pure refinement); 1 = the two resolvable octaves become real
         displacement. Held at 0 until the CPU authority carries the same height,
         because turning it on before that re-opens the surface-agreement bug
         (props floating, trail burial) that phase 1 closed. */
      uPromo: { value: 0 },
      /* structural grid (see GLSL_STRUCT) */
      uStr: { value: this.strTex },
      uStrA: { value: this.strTexA }, uStrB: { value: this.strTexB },
      uStrO: { value: new THREE.Vector4(0, 0, 0, 0) },
      uStrK: { value: new THREE.Vector4(NSX, NSZ, SNAP, 0) }
    };
    this.uni.uAOAmt = { value: 1 };
    if (G.sh) Object.assign(this.uni, G.sh.uni);
    if (G.csc) Object.assign(this.uni, G.csc.uni);
    if (G.df) Object.assign(this.uni, G.df.uni);
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: this.uni,
      vertexShader: GLSL_DEFORM + `
        attribute float aLat; attribute vec4 aMat; attribute float aAO;
        uniform vec3 uOrg;
        varying vec3 vN, vW; varying vec4 vM; varying float vLat; varying float vAO;
        varying float vPromo;
        void main(){
          vN = normal; vLat = aLat; vM = aMat; vAO = aAO;
          vPromo = 0.0;              // the coarse mesh never promotes: 2 m cells cannot carry it
          /* Deformation is a pure function of WORLD xz, so the coarse mesh and
             the fine patch displace a shared rim vertex IDENTICALLY and the
             crack-free join survives with no taper (unlike uPromo). The coarse
             mesh merely under-resolves the same shape at 2 m. */
          vW = position + vec3(0.0, deformH(position.xz + uOrg.xz), 0.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(vW,1.0);
        }`,
      fragmentShader: SNOW_FRAG,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
    /* The cascade caster: the SAME vertex buffers (so one upload, one CPU fill)
       with the unholed index. Registered with csc.addProxy, i.e. layer 3 only,
       so it is never drawn in the main pass. */
    const gp = new THREE.BufferGeometry();
    for (const a of ['position', 'normal', 'aLat', 'aMat', 'aAO']) gp.setAttribute(a, g.getAttribute(a));
    gp.setIndex(this.idxFullAttr);
    gp.setDrawRange(0, pf);
    gp.boundingSphere = g.boundingSphere;
    this.shadowGeo = gp;
    this.shadowProxy = new THREE.Mesh(gp, this.mesh.material);
    this.shadowProxy.frustumCulled = false;
    this.shadowProxy.matrixAutoUpdate = false;
    scene.add(this.shadowProxy);
    this.org = new THREE.Vector3(0, 0, 0);
    this.patchO = new THREE.Vector2(-FP_HW, FP_Z0);
    this.fine = null;                      // set by main once FinePatch exists
    this.lastKey = null;
    this.rlx = new Float32Array(NZ);   // per-row local x of column 0, this update
    this.rlz = new Float32Array(NZ);   // per-row local z, this update
    this._m = { h: 0, x: 0, y: 1, z: 0 };
  }

  /* ---- the DRAWN surface, sampled on the CPU ----------------------------
     sampleAt() is a continuous analytic field; this mesh is a piecewise-LINEAR
     approximation of it, and the two are not the same surface. Measured over an
     81x351 m grid around the rider: they differ by a median 0.4 cm but a max of
     20 cm within 52 m, 1.1 m by 100 m and 3.3 m by 250 m - the near-field error
     is chord error across a 2 m cell wherever the ground is sharp (corridor
     edges, lips), and the far-field error is the ROWRES band-limiting.
     A carve trench is 12 cm deep and its berm 6 cm high, so a 20 cm disagreement
     is enough to swallow the trail whole. Anything that must sit ON the visible
     snow therefore has to be placed against THIS, not against sampleAt.
     Returns false outside the clipmap, so the caller can fall back. */
  /* Read the ANALYTIC surface state at a world point - height plus the snow
     descriptor (groom / ice / pow / track / park / solid / lift / dEdge / cw).
     sampleAt is module-scope, so without this there is no way to ask "how
     packed is the snow here?" from a probe. Returns a COPY: sampleAt reuses
     one object, so keeping the reference would alias the next call. */
  surf(x, z, res) { return Object.assign({}, sampleAt(x, z, res === undefined ? 2 : res)); }

  /* Cut the fine patch's rectangle out of the drawn mesh, or put it back. Off is
     bit-identical to the clipmap before the patch existed. */
  setHole(on) {
    const h = on !== false;
    if (h === this._hole) return h;
    this._hole = h;
    this.geo.setIndex(h ? this.idxAttr : this.idxFullAttr);
    this.geo.setDrawRange(0, h ? this.idxCount : this.idxCountFull);
    return h;
  }

  /* ---- the structural grid, read on the CPU -----------------------------
     Bilinear over the same texels the shader samples, so every consumer agrees
     by construction instead of by tuning. Returns NaN outside the grid; callers
     fall back to the analytic terrainH, which is defined everywhere. */
  strAt(wx, wz) {
    const gx = (wx - this.strX0) / SNAP, gz = (wz - this.strZ0) / SNAP;
    if (!(gx >= 0 && gz >= 0 && gx <= NSX - 1 && gz <= NSZ - 1)) return NaN;
    let i0 = gx | 0, j0 = gz | 0;
    if (i0 > NSX - 2) i0 = NSX - 2;
    if (j0 > NSZ - 2) j0 = NSZ - 2;
    const fx = gx - i0, fz = gz - j0, sh = this.sh;
    const a = j0 * NSX + i0, b = a + NSX;
    const h0 = sh[a] * (1 - fx) + sh[a + 1] * fx;
    const h1 = sh[b] * (1 - fx) + sh[b + 1] * fx;
    return h0 * (1 - fz) + h1 * fz + this.org.y;
  }

  /* THE authority: the one height every consumer should ask for. Inside the
     structural band that is the drawn surface; outside it the analytic field,
     which is what build-time-ahead placement must use anyway (PB4). Kept as a
     single method so later phases (promoted relief octaves, then deformation)
     have exactly one place to extend. */
  hAuth(wx, wz) {
    const h = this.strAt(wx, wz);
    return h === h ? h : terrainH(wx, wz);
  }

  meshAt(wx, wz, out) {
    const o = out || this._m;
    const lx = wx - this.org.x, lz = wz - this.org.z;
    const pos = this.pos, nor = this.nor, rlx = this.rlx, rlz = this.rlz;
    if (lz < rlz[0] || lz > rlz[NZ - 1]) return false;
    let j = 0;                                  // rows are sorted by distance
    while (j < NZ - 2 && rlz[j + 1] <= lz) j++;
    const z0 = rlz[j], z1 = rlz[j + 1];
    if (z1 <= z0) return false;
    const f = (lz - z0) / (z1 - z0);
    let h0 = 0, h1 = 0, ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
    for (let s = 0; s < 2; s++) {
      const jj = j + s, P = ROWP[jj], n = ROWN[jj], base = jj * NX;
      const t = (lx - rlx[jj]) / P;
      if (t < -0.001 || t > n - 0.999) return false;   // outside this row's width
      const i0 = t < 0 ? 0 : (t | 0), g = t - i0, i1 = i0 + 1 < n ? i0 + 1 : i0;
      const a = (base + i0) * 3, b = (base + i1) * 3, w = 1 - g;
      const hh = pos[a + 1] * w + pos[b + 1] * g;
      const nx = nor[a] * w + nor[b] * g, ny = nor[a + 1] * w + nor[b + 1] * g,
            nz = nor[a + 2] * w + nor[b + 2] * g;
      if (s === 0) { h0 = hh; ax = nx; ay = ny; az = nz; }
      else { h1 = hh; bx = nx; by = ny; bz = nz; }
    }
    o.h = (h0 * (1 - f) + h1 * f) + this.org.y;
    let nx = ax * (1 - f) + bx * f, ny = ay * (1 - f) + by * f, nz = az * (1 - f) + bz * f;
    const il = 1 / (Math.hypot(nx, ny, nz) || 1);
    o.x = nx * il; o.y = ny * il; o.z = nz * il;   // same shape as terrainNormal()
    return true;
  }

  /* Camera position + the pixel footprint scale. fov moves with speed and the
     backing store moves with dpr/resize, so this is refreshed every frame. */
  setView(cam, ren) {
    this.uni.uCam.value.copy(cam.position);
    const h = ren.domElement.height || 1;
    this.uni.uPxK.value = 2 * Math.tan(cam.fov * Math.PI / 360) / h;
  }

  update(px, pz, force) {
    const sx = Math.round(px / SNAP) * SNAP, sz = Math.round(pz / SNAP) * SNAP;
    const key = sx + ':' + sz;
    if (key === this.lastKey && !force) return false;
    this.lastKey = key;
    const n = NX * NZ, pos = this.pos, nor = this.nor;
    const oy = baseY(sz);
    this.org.set(sx, oy, sz);
    // one lateral anchor for every row: all the row lattices nest inside it, so
    // the 2:1 seams stitch with a static index buffer and nothing breathes
    const ax = Math.round(sx / ANCH) * ANCH;
    for (let j = 0; j < NZ; j++) {
      const P = ROWP[j], res = ROWRES[j], nAct = ROWN[j], m = ROWM[j];
      const lz = Math.round((sz + ROWD[j]) / P) * P - sz;   // own lattice in z
      const wz = sz + lz, lx0 = ax - sx - m * P;
      this.rlx[j] = lx0; this.rlz[j] = lz;      // so meshAt() can read this row
      for (let i = 0; i < nAct; i++) {
        const k = j * NX + i, lx = lx0 + i * P;
        const s = sampleAt(sx + lx, wz, res);
        const k3 = k * 3;
        pos[k3] = lx; pos[k3 + 1] = s.h - oy; pos[k3 + 2] = lz;
        this.tx[k] = lx; this.tz[k] = lz;
        this.lat[k] = s.lat;
        const k2 = k * 4;
        this.mat[k2] = s.groom; this.mat[k2 + 1] = s.ice;
        this.mat[k2 + 2] = s.tw; this.mat[k2 + 3] = s.tad;
      }
      // rows use only as many columns as their width needs: park the spares on
      // the last real vertex so the unused quads collapse to nothing
      const src = j * NX + nAct - 1;
      for (let i = nAct; i < NX; i++) {
        const k = j * NX + i;
        pos[k * 3] = pos[src * 3]; pos[k * 3 + 1] = pos[src * 3 + 1]; pos[k * 3 + 2] = pos[src * 3 + 2];
        this.tx[k] = this.tx[src]; this.tz[k] = this.tz[src];
        this.lat[k] = this.lat[src];
        for (let c = 0; c < 4; c++) this.mat[k * 4 + c] = this.mat[src * 4 + c];
      }
    }
    /* ---- publish the structural grid ------------------------------------
       A pure copy out of the rows just filled - no sampleAt calls of its own.
       Row j's column i sits at local x = (ax - sx - ROWM[j]*SNAP) + i*SNAP, so
       the grid column ix (which is pinned to the NARROWEST row in the band) maps
       to i = ix + ROWM[j] - SIM. Every band row has ROWM >= SIM by construction,
       so that index is always inside the row's active columns. */
    this.strX0 = ax - SIM * SNAP;
    this.strZ0 = sz + ROWD[SB0];
    const sA = this.sA, sB = this.sB, lat = this.lat, mt = this.mat, aoA = this.ao;
    for (let jz = 0; jz < NSZ; jz++) {
      const j = SB0 + jz, dm = ROWM[j] - SIM, base = (j * NX + dm) * 3, o = jz * NSX;
      const bk = j * NX + dm, o4 = o * 4;
      for (let ix = 0; ix < NSX; ix++) {
        this.sh[o + ix] = pos[base + ix * 3 + 1];
        const q = (bk + ix) * 4, r = o4 + ix * 4;
        sA[r] = mt[q]; sA[r + 1] = mt[q + 1]; sA[r + 2] = mt[q + 2]; sA[r + 3] = mt[q + 3];
        sB[r] = lat[bk + ix];
      }
    }
    this.strTex.needsUpdate = true;
    this.strTexA.needsUpdate = true;
    this.uni.uStrO.value.set(this.strX0, this.strZ0, oy, 0);
    /* the patch's own local origin: anchored to ax laterally and to the 2 m z
       lattice, so it slides by whole 0.25 m cells */
    this.patchO.set(ax - sx - FP_HW, FP_Z0);

    /* Normals. The neighbouring row can be on a coarser lattice, so its vertex
       i is NOT straight ahead - reading its height as a pure forward slope is
       what shaded a whole row black at a pitch change. Sample the neighbour row
       at the SAME world x instead (exact: the lattices nest). */
    const rowH = (jn, lx) => {
      const Pn = ROWP[jn], nn = ROWN[jn], base = jn * NX;
      let t = (lx - (ax - sx - ROWM[jn] * Pn)) / Pn;
      t = t < 0 ? 0 : (t > nn - 1 ? nn - 1 : t);
      const i0 = t | 0, f = t - i0, i1 = i0 + 1 < nn ? i0 + 1 : i0;
      return pos[(base + i0) * 3 + 1] * (1 - f) + pos[(base + i1) * 3 + 1] * f;
    };
    for (let j = 0; j < NZ; j++) {
      const jm = Math.max(0, j - 1), jp = Math.min(NZ - 1, j + 1), nAct = ROWN[j];
      const wz = (pos[(jp * NX) * 3 + 2] - pos[(jm * NX) * 3 + 2]) || ROWP[j];
      /* AO offsets in VERTICES, derived from the row pitch so the occlusion is
         measured over the same ~11 m / ~34 m of world on every ring */
      const Pj = ROWP[j];
      const oA = Math.max(1, Math.round(11 / Pj)), oB = Math.max(1, Math.round(34 / Pj));
      const dA = oA * Pj, dB = oB * Pj, zH = Math.abs(wz) * 0.5 || Pj;
      for (let i = 0; i < nAct; i++) {
        const im = i > 0 ? i - 1 : 0, ip = i + 1 < nAct ? i + 1 : i;
        const a = (j * NX + im) * 3, b = (j * NX + ip) * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1];
        const lx = pos[(j * NX + i) * 3];
        const hp = rowH(jp, lx), hm = rowH(jm, lx);
        const wy = hp - hm;
        // normal = Tz x Tx , Tx=(ux,uy,0) Tz=(0,wy,wz)
        const nx = -wz * uy, ny = wz * ux, nz = -wy * ux;
        const il = 1 / (Math.hypot(nx, ny, nz) || 1);
        const k3 = (j * NX + i) * 3;
        nor[k3] = nx * il; nor[k3 + 1] = ny * il; nor[k3 + 2] = nz * il;
        /* concavity = how far this vertex sits BELOW the mean of its neighbours,
           in slope units, at two lateral scales plus the free forward one */
        const hC = pos[k3 + 1];
        const iAm = i - oA < 0 ? 0 : i - oA, iAp = i + oA >= nAct ? nAct - 1 : i + oA;
        const iBm = i - oB < 0 ? 0 : i - oB, iBp = i + oB >= nAct ? nAct - 1 : i + oB;
        const cA = ((pos[(j * NX + iAm) * 3 + 1] + pos[(j * NX + iAp) * 3 + 1]) * 0.5 - hC) / dA;
        const cB = ((pos[(j * NX + iBm) * 3 + 1] + pos[(j * NX + iBp) * 3 + 1]) * 0.5 - hC) / dB;
        const cF = ((hp + hm) * 0.5 - hC) / zH;
        /* A DEAD ZONE matters more than strength here. Almost the whole piste is
           mildly concave (it is a corridor cut cross-slope), so occluding every
           small concavity dimmed the entire foreground to a flat grey and the
           snow read dirty. Subtract a floor first: only genuine bowls, gully
           bottoms and corridor walls survive, and open snow stays white. */
        let occ = 1.15 * (cA > 0 ? cA : 0) + 0.95 * (cB > 0 ? cB : 0) + 0.60 * (cF > 0 ? cF : 0);
        occ = occ > 0.10 ? (occ - 0.10) * 1.25 : 0;
        const ao = 1 - occ;
        this.ao[j * NX + i] = ao < 0.38 ? 0.38 : (ao > 1 ? 1 : ao);
      }
      const s3 = (j * NX + nAct - 1) * 3, sA = j * NX + nAct - 1;
      for (let i = nAct; i < NX; i++) {
        const k3 = (j * NX + i) * 3;
        nor[k3] = nor[s3]; nor[k3 + 1] = nor[s3 + 1]; nor[k3 + 2] = nor[s3 + 2];
        this.ao[j * NX + i] = this.ao[sA];
      }
    }
    /* AO is only known after the normals pass above, so its copy lands here */
    for (let jz = 0; jz < NSZ; jz++) {
      const j = SB0 + jz, bk = j * NX + (ROWM[j] - SIM), o4 = jz * NSX * 4;
      for (let ix = 0; ix < NSX; ix++) sB[o4 + ix * 4 + 1] = aoA[bk + ix];
    }
    this.strTexB.needsUpdate = true;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.attributes.aLat.needsUpdate = true;
    this.geo.attributes.aMat.needsUpdate = true;
    this.geo.attributes.aAO.needsUpdate = true;
    this.mesh.position.copy(this.org);
    this.mesh.updateMatrix();
    this.shadowProxy.position.copy(this.org);
    this.shadowProxy.updateMatrix();
    if (this.fine) this.fine.update();     // rides the same local origin
    this.uni.uOrg.value.copy(this.org);
    return true;
  }
}

