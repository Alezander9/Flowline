/* ------------------------------------------------- particles, spray, dust
   The board's TRACK is not here. It is not a mesh at all any more: every board
   contact is a stamp in the deformation store and the terrain itself displaces
   from it (wake.js -> stamps.js -> deform.js). What lives here is only the
   AIRBORNE snow. */
const PMAX = 4000;
/* Airborne snow is driven by the CUT, not by a second guess at it: the trail
   author publishes `rider.cutD` (metres of real rut) and the rate is
   K * speed * (cut - floor). The floor is what keeps a groomed piste clean -
   a 1.2 cm scratch throws nothing, which is what the piste reference photos
   show (the track reads as texture, not as airborne snow) - while a 28 cm
   powder trench throws a plume. */
/* Rate scales with the VOLUME thrown per second. Both the depth AND the width
   of the cut grow with the snow, so the rate goes as the SQUARE of the cut,
   which is also what keeps a groomed piste clean without a hard cutoff:
   measured 6/s on piste against ~900/s in deep powder, a 155:1 ratio.
   SPRITES MUST BE LARGE, SOFT AND FAINT. A plume cannot be built out of
   realistically-small grains - measured, ~1200 fine grains read as a line of
   separate dots, and every count/size/alpha combination sat 7-13 sRGB from the
   snow behind it because both are white on the ACES shoulder. What reads as a
   cloud is a few hundred big overlapping discs at low alpha, feathered all the
   way to the centre, whose density comes from overlap and whose shape comes
   from the shadowed side going dark and blue (see `lit` below). */
const SPRAY = { k: 1900, d0: 0.015, exp: 2, size: 1, alpha: 1, clod: 0.30, shade: 1 };
class FX {
  constructor(scene) {
    // ---- particle pool
    this.n = PMAX;
    this.px = new Float32Array(PMAX); this.py = new Float32Array(PMAX); this.pz = new Float32Array(PMAX);
    this.vx = new Float32Array(PMAX); this.vy = new Float32Array(PMAX); this.vz = new Float32Array(PMAX);
    this.lf = new Float32Array(PMAX); this.ml = new Float32Array(PMAX);
    this.sz = new Float32Array(PMAX); this.gr = new Float32Array(PMAX); this.dg = new Float32Array(PMAX);
    this.al = new Float32Array(PMAX);
    this.head = 0;
    const pos = new Float32Array(PMAX * 3), col = new Float32Array(PMAX * 3);
    const size = new Float32Array(PMAX), alp = new Float32Array(PMAX);
    this.aPos = pos; this.aCol = col; this.aSize = size; this.aAlp = alp;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCol', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlp', new THREE.BufferAttribute(alp, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.pmat = new THREE.ShaderMaterial({
      uniforms: Object.assign({ uPix: { value: innerHeight / 2 } }, WU),
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      vertexShader: `
        attribute vec3 aCol; attribute float aSize, aAlp;
        varying vec3 vC; varying float vA; varying float vD;
        uniform float uPix;
        void main(){
          vC = aCol; vA = aAlp;
          vec4 mv = modelViewMatrix*vec4(position,1.0);
          vD = -mv.z;
          gl_PointSize = max(1.0, aSize*uPix/max(vD,0.5));
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: GLSL_COMMON + `
        varying vec3 vC; varying float vA; varying float vD;
        void main(){
          vec2 d = gl_PointCoord-0.5;
          float r = dot(d,d);
          if(r > 0.25) discard;
          float a = vA*pow(smoothstep(0.25,0.0,r),2.6);
          vec3 col = vC*(uSunCol*0.55+uSkyCol*0.55);
          float f = 1.0-exp(-vD*uFogD);
          col = mix(col, uFogA, f*0.85);
          gl_FragColor = vec4(outc(col), a*(1.0-f*0.7));
        }`
    });
    this.points = new THREE.Points(g, this.pmat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // ---- diamond dust drifting around the camera
    this.dustN = 260;
    const dpos = new Float32Array(this.dustN * 3), dsz = new Float32Array(this.dustN);
    for (let i = 0; i < this.dustN; i++) {
      dpos[i * 3] = (Math.random() - 0.5) * 90; dpos[i * 3 + 1] = Math.random() * 30 - 5; dpos[i * 3 + 2] = (Math.random() - 0.5) * 90;
      dsz[i] = 0.028 + Math.random() * 0.05;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dpos, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('aSize', new THREE.BufferAttribute(dsz, 1));
    dg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.dust = new THREE.Points(dg, new THREE.ShaderMaterial({
      uniforms: Object.assign({ uPix: { value: innerHeight / 2 } }, WU),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float aSize; uniform float uPix; varying float vD;
        void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); vD=-mv.z;
          gl_PointSize=max(1.0,aSize*uPix/max(vD,0.5)); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: GLSL_COMMON + `
        varying float vD;
        void main(){
          vec2 d=gl_PointCoord-0.5; float r=dot(d,d);
          if(r>0.25) discard;
          float a=smoothstep(0.25,0.0,r)*0.55*smoothstep(90.0,8.0,vD);
          gl_FragColor=vec4(outc(uSunCol*0.9+uSkyCol*0.3), a);
        }`
    }));
    if (typeof G !== 'undefined' && G.dbg) {
      G.dbg.SPRAY = SPRAY;
      G.dbg.spray = (k, size, alpha, shade, ex) => {
        if (k !== undefined) SPRAY.k = k;
        if (size !== undefined) SPRAY.size = size;
        if (alpha !== undefined) SPRAY.alpha = alpha;
        if (shade !== undefined) SPRAY.shade = shade;
        if (ex !== undefined) SPRAY.exp = ex;
        return Object.assign({}, SPRAY);
      };
    }
    this.dust.frustumCulled = false;
    /* clamped: the buffer is allocated once at dustN, and QLEVELS[3] asked for
       340 against a 260-particle buffer, i.e. the top tier was drawing off the
       end of it every frame */
    this.dust.geometry.setDrawRange(0, Math.min(G.q.dust, this.dustN));
    scene.add(this.dust);
    this.dpos = dpos;
  }

  spawn(x, y, z, vx, vy, vz, size, life, r, g, b, grav, drag, alpha = 0.85) {
    const i = this.head; this.head = (this.head + 1) % PMAX;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.lf[i] = life; this.ml[i] = life; this.sz[i] = size;
    this.gr[i] = grav; this.dg[i] = drag; this.al[i] = alpha;
    this.aCol[i * 3] = r; this.aCol[i * 3 + 1] = g; this.aCol[i * 3 + 2] = b;
  }

  /* AIRBORNE SNOW OFF THE EDGE.
     `dt` is real seconds and `lod` is a caller-side distance fade; the RATE is
     derived here from the cut the trail author recorded, so this can never
     drift away from the trench the way a duplicated formula did. */
  spray(rd, dt, lod = 1) {
    const sp = rd.speed || 0;
    const cut = rd.cutD || 0;                 // metres of real rut, from wake.push
    if (cut <= SPRAY.d0 || sp < 1) return;
    const rate = SPRAY.k * sp * Math.pow(cut - SPRAY.d0, SPRAY.exp) * (rd.grinding ? 0.1 : 1) * lod;
    /* Per-rider accumulator. It used to be one field on FX shared by the player
       and every bot, so a distant bot's fractional remainder ate into the
       player's emission budget and the 16-per-call cap was global. */
    rd._sprayAcc = (rd._sprayAcc || 0) + rate * dt;
    const cnt = Math.min(40, Math.floor(rd._sprayAcc));
    if (cnt <= 0) return;
    rd._sprayAcc -= cnt;
    const p = rd.p;
    /* The BOARD's lateral axis, raw. It flips in the world while switch (yaw is
       180 off), and since steering became rider-relative the TURN flips with it
       (rider.js omegaWant, 2026-08-03), so `side` below lands on the outside of
       the arc in both stances by construction.

       This used to carry a `rd.stance < 0 ? -1 : 1` factor, which was the
       downstream compensation for the artificial `* sw` in omegaWant: back then
       the turn did NOT flip while switch, so an unstanced axis threw the fan to
       the inside. Removing the correction at the source removes the need for the
       compensation here - keep the two in step, and note that bots have no
       stance, so a raw axis is also one less thing for them to get wrong. */
    const rx = Math.cos(rd.yaw), rz = -Math.sin(rd.yaw);
    const ae = Math.abs(rd.edge || 0);
    /* An edged turn throws the fan to the outside of the arc. Running straight
       there is no outside, and `-sgn(0) || 1` used to send every particle to
       the SAME side, which read as a permanent list; throw symmetrically. */
    const side = ae > 0.08 ? (-sgn(rd.edge) || 1) : (Math.random() < 0.5 ? -1 : 1);
    const powy = num(rd.surf && rd.surf.pow, 0);
    /* Horizontal sun direction, so one side of the fan can be lit and the other
       shadowed. Shared uniform, read by reference - never a second copy. */
    const sun = (typeof G !== 'undefined' && G.terr && G.terr.uni) ? G.terr.uni.uSun.value : null;
    const sx = sun ? sun.x : 0.62, sz = sun ? sun.z : 0.73;
    const sl = Math.hypot(sx, sz) || 1;
    for (let k = 0; k < cnt; k++) {
      /* Spawn over a patch, not a point. `t` runs across the board, `u` along
         the direction of travel: without `u` every grain of a frame starts on
         one line and the plume reads as a string of beads threaded on the
         trail. Vertical jitter gives the cloud a body. */
      const t = (Math.random() - 0.5) * 1.8, u = (Math.random() - 0.5) * 1.1;
      const ox = p.x + rx * t * 0.8 - rz * u, oz = p.z + rz * t * 0.8 + rx * u;
      /* CLODS. Deep snow does not only mist - it breaks off in chunks that arc
         and fall back (uploads/powder_snowboard_chunks.jpeg). A clod is bigger,
         slower, heavier and DARKER: it is a lump with shadowed facets, where
         the mist is lit from every side. Same pool, same draw call - only the
         spawn parameters differ. */
      const clod = powy > 0.45 && Math.random() < SPRAY.clod * powy;
      const spd = 1.2 + sp * (0.16 + 0.24 * rd.skid) * (0.5 + Math.random()) * (clod ? 0.45 : 1);
      /* Powder spray FANS - it is thrown sideways and back by the board and
         only drifts up. Measured: at up ~4.7 m/s against a lateral ~3 m/s the
         whole plume rose as a 0.5 m wide vertical column (outputs/review/
         s4e_k900.png). Keep the vertical component well under the lateral. */
      const up = (0.8 + sp * 0.04 * (0.5 + Math.random()) + powy * 0.95) * (clod ? 0.55 : 1);
      const fan = 0.55 + Math.random() * 1.15;
      const wx = rx * side * spd * fan - rd.v.x * 0.10 - rz * (Math.random() - 0.5) * spd * 0.55;
      const wz = rz * side * spd * fan - rd.v.z * 0.10 + rx * (Math.random() - 0.5) * spd * 0.55;
      /* THE PLUME IS MADE OF SNOW, SO IT CANNOT READ BY BRIGHTNESS. Measured:
         every count/size/alpha combination sat at 7-9 sRGB from the sunlit snow
         behind it, because both are white on the ACES shoulder. What makes a
         cloud read is its own INTERNAL range - the side facing away from the sun
         is in the cloud's shadow, lit only by sky, so it goes dark AND blue.
         `lit` is the grain's launch direction against the sun: one side of the
         fan glows, the other is a shadow. shade = 0 restores the flat white. */
      const wl = Math.hypot(wx, wz) || 1;
      const lit = Math.max(0, Math.min(1, 0.5 + 0.5 * (wx * sx + wz * sz) / (wl * sl) + (Math.random() - 0.5) * 0.3));
      const f = SPRAY.shade * (1 - lit);
      this.spawn(ox, p.y + 0.06 + Math.random() * 0.28, oz, wx, up, wz,
        (clod ? 0.30 + Math.random() * 0.55 : 0.09 + Math.random() * 0.40 + powy * 0.20) * SPRAY.size,
        clod ? 0.7 + Math.random() * 0.7 : 0.5 + Math.random() * (0.6 + powy * 0.8),
        (clod ? 0.80 : 1.05) * (1 - f * 0.72),
        (clod ? 0.85 : 1.07) * (1 - f * 0.66),
        (clod ? 0.97 : 1.14) * (1 - f * 0.48),
        clod ? -11.5 : -7.5, clod ? 0.5 : 1.1,
        /* A chunk is fairly opaque, mist is barely there. At 0.29 the discs
           saturated to white where they overlapped and every one of them read
           as a separate bubble; the cloud has to be built out of many almost
           invisible grains instead. */
        (clod ? 0.52 : 0.155) * SPRAY.alpha);
    }
  }

  burst(p, n, count, v, scale) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU, r = Math.random();
      const spd = (2 + Math.random() * 6) * scale;
      this.spawn(p.x + Math.cos(a) * r * 0.6, p.y + 0.1, p.z + Math.sin(a) * r * 0.6,
        Math.cos(a) * spd * 0.7 - v.x * 0.12, 1.5 + Math.random() * 5.5 * scale, Math.sin(a) * spd * 0.7 - v.z * 0.12,
        0.14 + Math.random() * 0.3 * scale, 0.6 + Math.random() * 0.9, 1.05, 1.08, 1.15, -8, 1.3);
    }
  }

  treeHit(x, z, y, rock) {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * TAU, spd = 1.5 + Math.random() * 5;
      const dark = Math.random() < (rock ? 0.35 : 0.45);
      this.spawn(x + (Math.random() - 0.5) * 1.2, y + 0.4 + Math.random() * 1.6, z + (Math.random() - 0.5) * 1.2,
        Math.cos(a) * spd, 1 + Math.random() * 4, Math.sin(a) * spd,
        0.09 + Math.random() * 0.22, 0.5 + Math.random() * 1.0,
        dark ? 0.12 : 1.05, dark ? (rock ? 0.13 : 0.26) : 1.08, dark ? (rock ? 0.16 : 0.16) : 1.15, -9, 1.6);
    }
  }

  sparks(rd) {
    if (Math.random() > 0.6) return;
    const p = rd.p;
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * TAU;
      this.spawn(p.x, p.y + 0.05, p.z, Math.cos(a) * 2.5 - rd.v.x * 0.2, 1.5 + Math.random() * 2, Math.sin(a) * 2.5 - rd.v.z * 0.2,
        0.05 + Math.random() * 0.05, 0.22 + Math.random() * 0.2, 2.4, 1.5, 0.45, -14, 0.6);
    }
  }


  update(dt) {
    // particles
    const pos = this.aPos, alp = this.aAlp, sz = this.aSize;
    for (let i = 0; i < PMAX; i++) {
      if (this.lf[i] <= 0) { alp[i] = 0; sz[i] = 0; continue; }
      this.lf[i] -= dt;
      const t = Math.max(0, this.lf[i] / this.ml[i]);
      this.vy[i] += this.gr[i] * dt;
      const d = Math.max(0, 1 - this.dg[i] * dt);
      this.vx[i] *= d; this.vz[i] *= d;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      pos[i * 3] = this.px[i]; pos[i * 3 + 1] = this.py[i]; pos[i * 3 + 2] = this.pz[i];
      alp[i] = Math.min(1, t * 2.2) * this.al[i];
      sz[i] = this.sz[i] * (1 + (1 - t) * 1.3);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aAlp.needsUpdate = true;
    this.points.geometry.attributes.aSize.needsUpdate = true;
    this.points.geometry.attributes.aCol.needsUpdate = true;

    // dust follows the camera
    const c = G.cam.position, d = this.dpos;
    for (let i = 0; i < this.dustN; i++) {
      let x = d[i * 3] - c.x, y = d[i * 3 + 1] - c.y, z = d[i * 3 + 2] - c.z;
      d[i * 3 + 1] -= dt * (0.35 + (i % 5) * 0.1);
      d[i * 3] += dt * 0.5 * Math.sin(G.t * 0.4 + i);
      if (x > 45) d[i * 3] -= 90; if (x < -45) d[i * 3] += 90;
      if (z > 45) d[i * 3 + 2] -= 90; if (z < -45) d[i * 3 + 2] += 90;
      if (y > 26) d[i * 3 + 1] -= 40; if (y < -14) d[i * 3 + 1] += 40;
    }
    this.dust.geometry.attributes.position.needsUpdate = true;
    this.dust.geometry.setDrawRange(0, Math.min(G.q.dust, this.dustN));   // see the note at construction
  }
}
