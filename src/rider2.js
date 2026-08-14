/* ------------------------------------------------- rider: events & visuals */
/* PB9 scratch, reused every substep so the query allocates nothing */
const _pcol = { nx: 0, nz: 0, pen: 0, C: null, o: null };
/* Multi-rotation flip prefixes. Anything past QUAD falls back to "5X BACKFLIP",
   which is not a real trick name but is also not reachable in this gravity. */
const FLIPN = { 2: 'DOUBLE', 3: 'TRIPLE', 4: 'QUAD' };
Object.assign(Rider.prototype, {
  land(impact, n) {
    /* write-only: the body's landing spring reads it, the sim never does */
    this.landImp = impact;
    const sp = this.speed;
    const air = this.airT;
    const spins = this.spinTotal;
    this.spinTotal = 0;
    // heading vs travel direction
    const trav = Math.atan2(this.v.x, this.v.z);
    const off = Math.abs(wrapAngle(this.yaw - trav));
    const rev = off > 2.2;                       // landed switch (backwards) - fine
    const bad = rev ? Math.abs(wrapAngle(this.yaw + Math.PI - trav)) : off;
    /* ---- PB10: grade the flip ----
       `pdev` is the deviation from a WHOLE number of rotations, so a completed
       360 or 720 lands exactly as clean as never having flipped at all, while
       180 (inverted) is the worst case. A rider who never pressed Q/E has pitch
       identically 0, hence pdev 0, hence psev 0 - none of this can fire on them.
       Reset happens HERE, unconditionally and ahead of every branch below, so a
       flip can never survive a touchdown and leak into the next airtime. */
    const pdev = this.pitch ? Math.abs(wrapAngle(this.pitch)) : 0;
    /* WHOLE rotations, read from the RAW pitch before the wrap two lines below -
       the rotation count is what names the trick, and wrapAngle would throw it
       away. Nothing wraps pitch in flight (rider.js settles it only once
       grounded), so a double front flip arrives here as ~4*PI. Sign is the
       direction: +pitch is E / nose-down / front. */
    const prot = this.pitch ? Math.round(Math.abs(this.pitch) / TAU) : 0;
    const pfwd = this.pitch > 0;
    /* Deliberately NOT zeroed here any more. The grounded branch in rider.js
       settles it over ~3-4 frames, because a hard zero snapped the rider flat in
       a single frame and looked bad. And on a wipeout it is never zeroed at all:
       update() early-returns to stepDown(), so the tumble animation starts from
       whatever pitch the landing had, which is what Alexander asked for.
       The wrap is essential - an unwrapped 4*PI + 0.2 would visibly unwind two
       whole rotations during the settle instead of the 11 deg actually left. */
    if (this.pitch) this.pitch = wrapAngle(this.pitch);
    this.pitchV = 0;
    const psev = pdev > FLIP.clean ? (pdev - FLIP.clean) * FLIP.k : 0;
    /* Landing on the grab. Gated on real air so that SHIFT on the ground, which
       is the speed scrub, can never trip it - and so a 0.1 s skip off a bump
       while scrubbing is not a "landing" at all. See LAND in rider.js. */
    const gsev = (this.input.grab && air > 0.18) ? LAND.grab : 0;
    /* SPEED SCALE on every landing penalty - 0 below LAND.noPen (30 km/h), full
       at LAND.fullPen (150 km/h). Slow repositioning hops must not be able to cost
       balance, let alone kill; see the LAND comment in rider.js. It scales the
       PENALTY only - `ok`, the settle, the toasts and the SFX are untouched, so a
       slow landing still reads exactly as it did.
       penExp makes the ramp mildly convex so 90 km/h lands strictly under half a
       bar (0.435) instead of the exactly-0.500 a linear ramp gives, while 150 km/h
       still reaches 1.0 on the nose. Math.pow of a clamped 0..1 base is safe. */
    const pen = Math.pow(clamp((sp - LAND.noPen) / (LAND.fullPen - LAND.noPen), 0, 1), LAND.penExp);
    /* `impact` is deliberately absent from this test now - a huge stomped drop is
       a clean landing and gets the full bonus. See the NOTE on LAND. */
    let ok = bad < 0.55 && pdev <= FLIP.clean && !gsev;
    /* The flip kill line is checked OUTSIDE the airtime gate on purpose. Residual
       pitch proves the rider flipped, and landing >45 deg off flat is a crash
       whether it was 0.2 s or 2 s in the air. It also means the flip no longer
       depends on the airtime plumbing that was dead until 2026-08-12.
       `pen > 0` is the low-speed amnesty: under 30 km/h a blown flip falls through
       to the penalty branch below, where the same scale zeroes its damage, so it
       settles flat instead of ending the run. Nothing about a LANDING can kill you
       at walking pace.
       *** DO NOT RE-GATE THIS ON SPEED. I moved it to `sp >= LAND.fullPen`
       (150 km/h) on 2026-08-12 while implementing the "bad landing at 90 km/h
       should take less than half health" retune, and it REVERTED Alexander's
       explicit flip spec - "have a misalignement by more than 45% be a wipe out".
       He caught it: "This build seems to have reverted my punishing flip changes."
       The softening was meant for SCRAPPY LANDINGS and slow repositioning, never
       for flips: a flip is an expert trick the player chose to throw, and blowing
       it is supposed to end the run at any rideable speed. The two rules coexist
       because they are scaled differently - see the sev split below. *** */
    if (pdev > FLIP.kill && pen > 0) {
      this.wipeout('blew the flip');
    } else if (air > 0.18) {
      if (ok) {
        const bonus = clamp(air * 0.16 + this.airPeak * 0.02, 0, 0.42);
        this.flow = Math.min(1, this.flow + bonus);
        this.balance = Math.min(1, this.balance + 0.10);
        this.grace = 0.45;
        this.stat.air = Math.max(this.stat.air, air);
        /* Quantised to 180, NOT 90. 180/360/540/720/900 are the names riders
           actually use; round-to-90 could report a "270" or a "450", which are
           not tricks. (Alexander asked for "580 and 740" - read as the real 540
           and 720, which is what this series produces.) */
        const spinDeg = Math.round(spins / TAU * 2) * 180;
        /* The stomp SOUND is the reward for any decent air and is now the only
           thing here still gated on hangtime. The trick BANNER is not: "there
           should not be an airtime requirement to throw a toast for a 180"
           (Alexander), so a spin or a flip earns its callout on its own merit at
           any airtime. Only BIG AIR still tests the clock, because hangtime IS
           its achievement. Landing on the grab reaches none of this - gsev
           clears `ok`. */
        if (air > 0.55) SFX.landClean(clamp(impact / 12, 0.2, 1));
        else SFX.land(clamp(impact / 12, 0.15, 0.7), this.surf.pow);
        const sub = air.toFixed(1) + 's · ' + Math.round(this.airPeak) + 'm' + (rev ? ' SWITCH' : '');
        if (prot >= 1) {
          /* A flip outranks a spin in the banner because it is the rarer trick; a
             simultaneous spin is still reported, demoted to the sub-line. */
          const nm = (prot > 1 ? (FLIPN[prot] || prot + 'X') + ' ' : '') + (pfwd ? 'FRONT FLIP' : 'BACKFLIP');
          UI.toast(nm, spinDeg >= 180 ? sub + ' · ' + spinDeg + '°' : sub);
        } else if (spinDeg >= 180) UI.toast(spinDeg + '°', sub);
        else if (air >= LAND.bigAir) UI.toast('BIG AIR', sub);
      } else {
        /* The yaw term is only floored at 0 when a flip is actually being
           graded. Left bare it goes NEGATIVE for a straight-heading landing
           (bad 0 -> -0.22) and would quietly discount the flip penalty - but
           flooring it unconditionally would also make today's hard-but-straight
           landings hurt where they currently round to zero, which would be a
           change to riders who never flip. So: bare when psev is 0. */
        const ysev = (bad - 0.4) * 0.55;
        /* The yaw term is bare ONLY when it is the sole cause, because it goes
           NEGATIVE for a straight landing (bad 0 -> -0.22) and would silently
           cancel out a flip or grab penalty added to it. Flooring it
           unconditionally would instead make today's plain bad landings hurt more
           than they were tuned to. `extra` decides which of the two applies. */
        const extra = psev + gsev;
        /* `pen` is the speed scale. At 0 (under 30 km/h) hit() is not called at
           all rather than called with 0, so a slow scrappy landing cannot even
           flash a warn or a stumble - it simply is not a bad landing. */
        /* TWO PENALTIES, TWO SCALINGS - this split is the whole reconciliation of
           Alexander's two asks, which conflict if you scale everything alike.
             yaw + grab : SPEED-SCALED by `pen`. This is the "bad landing" he asked
                          to soften - a scrappy touchdown or a slow repositioning
                          hop. Worst case 0.435 of a bar at 90 km/h, 1.00 at 150.
             flip (psev): FULL STRENGTH, amnesty only. His grading table is defined
                          at full strength (15deg -> 0.14, 25 -> 0.43, 35 -> 0.72,
                          44 -> 0.97 surviving on 0.03) and scaling it by pen turned
                          the 44 deg case into 0.42, which is exactly the "reverted
                          my punishing flip changes" regression. A blown flip is the
                          trick's own risk, not a bad landing.
           `pen > 0` rather than `* pen` keeps the sub-30 km/h amnesty for flips too,
           so nothing kills at walking pace. That step is unreachable in practice -
           you cannot get enough air to rotate below 30 km/h. */
        const yTerm = extra ? Math.max(0, ysev) : ysev;
        const sev = clamp((yTerm + gsev) * pen + (pen > 0 ? psev : 0), 0, LAND.sevMax);
        if (sev > 0) this.hit(sev, psev > 0.12 ? 'bad flip landing' : (gsev ? 'landed on the grab' : 'bad landing'));
        SFX.land(clamp(impact / 10, 0.3, 1), this.surf.pow);
      }
    } else if (impact > 4) SFX.land(clamp(impact / 14, 0.1, 0.6), this.surf.pow);
    if (impact > 2.0) {
      /* landing wants to read as snow being displaced, so the count and the
         spread both grow with how hard the board hit */
      G.fx.burst(this.p, this.n, Math.min(Math.round(6 + impact * 4.6), 62), this.v, 1.0 + this.surf.pow);
      this.shake = Math.min(1.2, this.shake + impact * 0.045);
      this.bump = Math.min(1, impact * 0.09);
    }
    /* Settle a clean landing onto the travel direction - but a SWITCH landing is
       already aligned with travel, just tail-first, so its settle target is
       trav + PI. Snapping it to `trav` un-rotated the 180 the player had just
       landed, which is why you could never keep riding backwards. */
    if (ok && air > 0.4) {
      if (rev) this.yaw = wrapAngle(trav + Math.PI);
      /* commit the stance on touchdown so the controls are right immediately
         instead of waiting out the STANCE_T hysteresis. For a forward landing
         this is a no-op write unless the rider was switch and has just spun
         back to forward. */
      this.stance = rev ? -1 : 1; this.stanceT = 0;
    }
    this.airStart = 0; this.airPeak = 0;
  },

  hit(sev, why) {
    if (this.state !== 'ride') return;
    this.balance -= sev;
    this.flow = Math.max(0, this.flow - sev * 1.25);
    this.shake = Math.min(1.6, this.shake + sev * 0.9);
    this.body.stumble(sev);
    if (sev > 0.12) SFX.stumble(clamp(sev, 0.2, 1));
    if (this.balance <= 0) this.wipeout(why);
    else if (sev > 0.3) UI.warn(why);
  },

  wipeout(why) {
    if (this.state !== 'ride') return;
    this.state = 'down'; this.downT = 0;
    this.balance = 0; this.flow = 0;
    this.tumble = { sp: this.speed, yaw: this.yaw };
    SFX.wipeout();
    G.fx.burst(this.p, this.n, 70, this.v, 1.6);
    UI.wipeout(this.dist, why);
    if (G.net) G.net.wipeout();
  },

  stepDown(dt) {
    this.downT += dt;
    const p = this.p, v = this.v;
    v.y -= G_ACC * dt;
    v.multiplyScalar(Math.max(0, 1 - 1.9 * dt));
    p.addScaledVector(v, dt);
    const gh = terrainH(p.x, p.z);
    if (p.y < gh) { p.y = gh; v.y *= -0.22; v.x *= 0.72; v.z *= 0.72; }
    this.speed = v.length();
    if (this.speed > 2 && this.downT < 1.4 && Math.random() < 0.5)
      G.fx.burst(this.p, this.n, 4, this.v, 1.0);
    if (this.downT > 2.5) {
      const soft = false;
      this.reset(soft);
      this.state = 'ride';
      // teleported to the top of the mountain: rebuild the world here and cut the
      // camera, then let the wipeout overlay fade off the finished frame
      G.terr.update(this.p.x, this.p.z, true);
      camCut();                        // before place(): see camCut
      G.world.place(this.p.x, this.p.z);
      G.world.updateSegs(this.p.z);
      BOTS.reset();
      if (G.wake) G.wake.reset();      // don't stretch the trail across the map
      UI.respawn();
      if (G.net) G.net.respawn();
    }
  },

  checkObstacles(dt) {
    const obs = G.world.obs, n = G.world.obsN, p = this.p;
    let closest = 99;
    for (let i = 0; i < n; i++) {
      const o = i * OBS_S;
      /* VERTICAL CLEARANCE. Obstacles used to be infinitely tall cylinders, so
         clearing a tree on a big jump still killed you. obs[o+4] is the world y
         of the object's top; 0.30 of forgiveness because the top of a conifer is
         a whippy tip, not a wall. Tested before the distance test so it also
         suppresses the close-call bonus for trees you flew clean over, and so it
         skips the sqrt. */
      if (p.y > obs[o + 4] - 0.30) continue;
      const dx = p.x - obs[o], dz = p.z - obs[o + 1];
      const d2 = dx * dx + dz * dz;
      const rad = obs[o + 2];
      if (d2 > (rad + 4) * (rad + 4)) continue;
      const d = Math.sqrt(d2);
      const clear = d - rad;
      if (clear < closest) closest = clear;
      if (clear < 0.42) {
        const sp = this.speed;
        const isRock = obs[o + 3] === 1;
        // push out
        const inv = 1 / (d || 0.01);
        p.x += dx * inv * (0.42 - clear + 0.02);
        p.z += dz * inv * (0.42 - clear + 0.02);
        // kill velocity into the obstacle
        const vd = this.v.x * dx * inv + this.v.z * dz * inv;
        if (vd < 0) { this.v.x -= dx * inv * vd * 1.25; this.v.z -= dz * inv * vd * 1.25; }
        this.v.multiplyScalar(isRock ? 0.55 : 0.62);
        G.fx.treeHit(obs[o], obs[o + 1], p.y, isRock);
        SFX.treeHit(0.3 + sp * 0.028, isRock);
        this.hit(0.20 + sp * (isRock ? 0.040 : 0.032), isRock ? 'clipped a rock' : 'caught a tree');
        return;
      }
    }
    // close call bonus
    if (closest < 1.9 && this.speed > 12 && this.closeT <= 0) {
      this.closeT = 0.9;
      this.flow = Math.min(1, this.flow + 0.06);
      this.stat.close++;
      SFX.whoosh(clamp(this.speed / 30, 0.3, 1));
      if (closest < 1.1) UI.toast('CLOSE', 'threading the trees');
    }
    this.closeT -= dt;
  },

  /* PB9: solid props - buildings, gondola towers, the start gate, the big park
     board and the segment rock clusters. Kept separate from checkObstacles
     because the response differs in kind: a tree scrubs you and lets you ride
     on, a building stops you. It runs AFTER checkObstacles so a tree still owns
     the push-out for the substep it happens in, and it is skipped while on a
     roof - up there p.y is above every wall's `top` anyway, but the explicit
     test makes that independent of the forgiveness constant. */
  checkProps(dt) {
    if (this.state !== 'ride' || this.onPlat) return;
    const w = G.world;
    if (!w || !w.propHit) return;
    const p = this.p, h = w.propHit(p.x, p.z, p.y, 0.42, _pcol);
    if (!h) return;
    const C = h.C, sp = this.speed, hard = C.kind === 'build' || C.kind === 'tower' || C.kind === 'gate';
    p.x += h.nx * (h.pen + 0.02);
    p.z += h.nz * (h.pen + 0.02);
    const vd = this.v.x * h.nx + this.v.z * h.nz;
    if (vd < 0) { this.v.x -= h.nx * vd * (hard ? 1.05 : 1.25); this.v.z -= h.nz * vd * (hard ? 1.05 : 1.25); }
    /* hard props barely bounce you: 1.05 instead of the tree's 1.25, because a
       wall throwing you back up the hill reads as a trampoline */
    this.v.multiplyScalar(C.mul);
    G.fx.treeHit(p.x, p.z, p.y, C.kind !== 'build');
    SFX.treeHit(clamp(0.35 + sp * 0.030, 0.3, 1), C.kind !== 'build');
    this.hit(C.sev0 + sp * C.sevK, C.why);
  },

  postStep(dt) {
    this.shake = approach(this.shake, 0, 3.4, dt);
    this.bump = approach(this.bump, 0, 6, dt);
    this.body.update(this, dt);
    /* Airborne snow only: the track itself is real terrain displacement now.
       The RATE lives in fx.spray and is derived from `this.cutD`, the actual rut
       Wake cut - it used to be re-derived here from skid/edge/pow with no ice
       term, so spray and trench disagreed. */
    if (this.state === 'ride' && this.grounded) {
      G.fx.spray(this, dt);
      if (this.grinding) G.fx.sparks(this);
    }
  }
});

/* ------------------------------------------------- chase camera */
const CAM = {
  yaw: 0, dist: 8.4, hgt: 3.0, fov: 72,
  pos: new THREE.Vector3(), look: new THREE.Vector3(), vel: new THREE.Vector3(),
  roll: 0, shakeT: 0, warped: false,
  /* The rider teleports on respawn/warp — kilometres in one frame. The spring
     would fly the camera there through the mountain, so cut instead. */
  snap() { if (!G.dbg.noSnap) this.warped = true; }
};
/* snap() only RAISES A FLAG - the camera does not actually move until the next
   updateCamera. Any caller that teleports the rider and then rebuilds the world
   must cut the camera FIRST, or world.place() runs against the pre-teleport view
   direction: tree LOD is screen-relevance based, so the whole pass is graded
   against a camera nobody will ever look through, and the next frame's ~21 deg
   "turned" test immediately fires a second full pass. dt is unused under snap
   (every term takes its target directly), so 0 is safe. */
function camCut() { CAM.snap(); updateCamera(0); }
function updateCamera(dt) {
  const r = G.rider, p = r.p;
  if (G.dbg.orbit) {                       // debug: close orbit around the rider
    const o = G.dbg.orbit, a = o.a === undefined ? (G.t * 0.35) : o.a;
    G.cam.position.set(p.x + Math.sin(a) * o.d, p.y + o.h, p.z + Math.cos(a) * o.d);
    G.cam.up.set(0, 1, 0); G.cam.lookAt(p.x, p.y + (o.ly || 0.8), p.z);
    G.cam.fov = o.fov || 40; G.cam.updateProjectionMatrix();
    return;
  }
  const snap = CAM.warped; CAM.warped = false;
  const travYaw = (r.speed > 3.5) ? Math.atan2(r.v.x, r.v.z) : r.yaw;
  CAM.yaw += wrapAngle(travYaw - CAM.yaw) * (snap ? 1 : 1 - Math.exp(-5.5 * dt));
  const spN = clamp(r.speed / 34, 0, 1.35);
  const air = clamp(r.airT * 1.6, 0, 1);
  const vf = viewFit();
  /* zoom scales every offset from the rider below (dist, hgt, look-ahead, look
     height, shake) - a similarity transform, so the dynamics and the framing are
     untouched and only the scale changes. See CAMZ in util.js. */
  const zm = CAMZ.zoom;
  const wantD = (6.6 + spN * 2.6 + air * 1.5) * (1 - 0.13 * vf.p - 0.30 * vf.s) * zm;
  const wantH = (2.15 + spN * 0.62 + air * 0.9 + r.crouch * -0.22) * (1 - 0.10 * vf.p - 0.16 * vf.s) * zm;
  CAM.dist = snap ? wantD : approach(CAM.dist, wantD, 3.0, dt);
  CAM.hgt = snap ? wantH : approach(CAM.hgt, wantH, 3.0, dt);
  const sy = Math.sin(CAM.yaw), cy = Math.cos(CAM.yaw);
  const tx = p.x - sy * CAM.dist, tz = p.z - cy * CAM.dist;
  const gh = Math.max(terrainH(tx, tz), terrainH(p.x, p.z) - 3.5);
  const ty = Math.max(p.y + CAM.hgt, gh + 1.5);
  // spring follow
  const k = snap ? 1 : 1 - Math.exp(-9.0 * dt);
  CAM.pos.x += (tx - CAM.pos.x) * k;
  CAM.pos.y += (ty - CAM.pos.y) * (snap ? 1 : 1 - Math.exp(-7.0 * dt));
  CAM.pos.z += (tz - CAM.pos.z) * k;
  // shake
  let shx = 0, shy = 0;
  const shake = snap ? 0 : r.shake + r.chatter * 0.10 + (r.skid > 0.5 ? (r.skid - 0.5) * 0.05 : 0);
  if (shake > 0.001) {
    CAM.shakeT += dt * 42;
    shx = Math.sin(CAM.shakeT * 1.7) * shake * 0.26 * zm;
    shy = Math.sin(CAM.shakeT * 2.3 + 1.1) * shake * 0.20 * zm;
  }
  G.cam.position.set(CAM.pos.x + shx, CAM.pos.y + shy + r.bump * -0.25 * zm, CAM.pos.z);
  const la = (9 + spN * 12) * (1 - 0.18 * vf.p - 0.10 * vf.s) * zm;
  // a tall screen wastes its top half on sky: aim lower so the rider rides
  // nearer the middle of the frame and the mountain fills it
  CAM.look.set(p.x + sy * la * 0.55, p.y + (1.4 + spN * 0.8) * zm - 1.6 * vf.p - 0.5 * vf.s, p.z + cy * la * 0.55);
  G.cam.up.set(0, 1, 0);
  G.cam.lookAt(CAM.look);
  // roll into the turn
  const tgtRoll = -r.omega * 0.055 - r.edge * 0.035;
  CAM.roll = snap ? tgtRoll : approach(CAM.roll, tgtRoll, 5, dt);
  G.cam.rotateZ(CAM.roll);
  const fov = 70 + spN * 15 + (r.state === 'down' ? 6 : 0) - 13 * vf.p - 7 * vf.s;
  if (snap || Math.abs(fov - CAM.fov) > 0.05) {
    CAM.fov = snap ? fov : approach(CAM.fov, fov, 3.5, dt);
    G.cam.fov = CAM.fov; G.cam.updateProjectionMatrix();
  }
}
