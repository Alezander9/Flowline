/* ------------------------------------------------- rider physics */
const _rut = {};
const G_ACC = 18.0;
const SPAWN = { x: 0, z: 4 };
/* sustained tail-first travel needed to commit to a switch stance (s).
   Long enough that a hard scrub past 90 degrees never trips it, short
   enough that a landed 180 feels immediate. */
const STANCE_T = 0.28;
/* §10.4 - riding in an existing trench (yours after a switchback, or a bot's).
   Until now the rider's snow state came from the ANALYTIC surface only, so the
   deformation store had no physical effect at all: a bot could plough a 30 cm
   trench across your line and you would feel virgin powder. A cut trench is
   PACKED, so it is faster and grippier than the powder beside it - which is
   what makes following a line PAY OFF, and it is the same lever `groom`
   already pulls, so nothing new is invented.
   A second effect - the trench WALL resisting being crossed, to make a line
   easier to FOLLOW - was built and REJECTED by measurement: adding lateral
   velocity is the wrong channel, because the grip solver owns that channel and
   damps it out each frame. It moved the rider 9 mm over 80 m at a safe
   strength, and strong enough to hold the line it manufactured skid 0.365
   (false spray, deeper trail). The correct mechanism is to tilt the surface
   NORMAL by the cross-trench gradient so the floor is a banked channel and
   gravity does the work with the grip solver rather than against it. Not
   attempted here; see the §10.4 log entry. */
const RUTF = {
  amt: 1,      // master; rutf(0) is the pre-§10.4 build bit-exactly
  mu: 1.0,     // weight of the blend toward the groomed friction
  grip: 1.0    // weight of the blend toward the groomed grip
};

class Rider {
  constructor() {
    this.p = new THREE.Vector3();
    this.v = new THREE.Vector3();
    this.n = new THREE.Vector3(0, 1, 0);
    this.pPrev = new THREE.Vector3();
    this.pDraw = new THREE.Vector3();
    this.nDraw = new THREE.Vector3(0, 1, 0);
    this.yawPrev = 0;
    this.yawDraw = 0;
    this.input = { steer: 0, tuck: 0, pop: false, grab: false };
    this.body = new RiderBody(G.scene, 0xff7a33);
    this.reset();
    /* Each argument is guarded on its own: rutf(0) kills the feature,
       rutf(undefined, {wall: 20}) tunes one term without touching amt. */
    if (typeof G !== 'undefined' && G.dbg) {
      G.dbg.RUTF = RUTF;
      G.dbg.rutf = (amt, ov) => {
        if (amt !== undefined) RUTF.amt = amt;
        if (ov) Object.assign(RUTF, ov);
        return Object.assign({}, RUTF);
      };
      /* FL.dbg.flip()                 -> read the tuning
         FL.dbg.flip({rate: 6})        -> retune live, no rebuild
         FL.dbg.flip(null, 1.57)       -> force pitch to 1.57 rad to inspect a pose */
      G.dbg.FLIP = FLIP;
      G.dbg.flip = (ov, setPitch) => {
        if (ov) Object.assign(FLIP, ov);
        if (setPitch !== undefined) { this.pitch = setPitch; this.pitchV = 0; }
        return { FLIP: Object.assign({}, FLIP), pitch: this.pitch, pitchV: this.pitchV };
      };
      /* FL.dbg.land()                  -> read the landing tuning
         FL.dbg.land({bigAir: 1.5})     -> retune live, no rebuild
         Also reports the best airtime of the run, which is the number that says
         whether LAND.bigAir is actually reachable on this terrain. */
      G.dbg.LAND = LAND;
      G.dbg.land = (ov) => {
        if (ov) Object.assign(LAND, ov);
        return { LAND: Object.assign({}, LAND), bestAir: +(this.stat.air || 0).toFixed(2) };
      };
    }
  }

  reset(soft) {
    this.p.set(SPAWN.x + pisteC(SPAWN.z), 0, SPAWN.z);
    this.p.y = terrainH(this.p.x, this.p.z);
    this.v.set(0, 0, 2.5);
    this.yaw = 0; this.omega = 0;
    /* PB10 flips. `pitch` is a rotation about the board's LATERAL axis (i.e. the
       long way of the board tips up or down) and is EXACTLY 0 for any rider who
       never presses Q/E. Every consumer guards on it being falsy, so 0 is not
       "almost unchanged" - it is the identical pre-flip code path. land() hard
       resets both to 0 so a float can never leak in and un-guard the feature. */
    this.pitch = 0; this.pitchV = 0;
    this.stance = 1; this.stanceT = 0;   // +1 forward, -1 switch (hysteretic)
    this.lean = 0; this.leanV = 0; this.edge = 0;
    this.grounded = true; this.airT = 0; this.groundT = 1;
    this.flow = 0.12; this.balance = 1; this.crouch = 0; this.charge = 0;
    this.skid = 0; this.spin = 0; this.spinTotal = 0; this.spinStart = 0;
    this.state = 'ride'; this.downT = 0;
    this.surf = { groom: 1, ice: 0, pow: 0, solid: 0, park: 0, kind: 0, dEdge: -20 };
    this.maxZ = 0; this.startZ = this.p.z;
    this.grinding = 0; this.grindT = 0; this.railCool = 0; this.grace = 0;
    this.onPlat = 0;
    this.shake = 0; this.bump = 0; this.sink = 0; this.rut = 0;
    this.lastY = this.p.y; this.airPeak = 0; this.airStart = 0;
    this.vmax = 16; this.speed = 0; this.chatter = 0;
    this.closeT = 0; this.trickTag = '';
    this.stat = { air: 0, grind: 0, close: 0, best: 0 };
    this.pPrev.copy(this.p); this.pDraw.copy(this.p);
    this.nDraw.copy(this.n); this.yawPrev = this.yaw; this.yawDraw = this.yaw;
    if (!soft) { this.runT = 0; }
  }

  get dist() { return Math.max(0, this.maxZ - this.startZ); }

  step(dt) {
    this.pPrev.copy(this.p);
    this.yawPrev = this.yaw;
    const inp = this.input;
    if (this.state === 'down') { this.stepDown(dt); return; }
    this.runT += dt;
    const p = this.p, v = this.v;

    /* ---- ground sample ---- */
    const s = sample(p.x, p.z);
    let gh = s.h;
    this.surf.groom = s.groom; this.surf.ice = s.ice; this.surf.pow = s.pow;
    this.surf.solid = s.solid; this.surf.park = s.park; this.surf.kind = s.kind; this.surf.dEdge = s.dEdge;
    const nn = terrainNormal(p.x, p.z, this.grounded ? 1.5 : 1.8);
    const n = this.n.set(nn.x, nn.y, nn.z);

    /* ---- PB4: building roofs are one-way platforms ----
       The tolerance is the tunnelling allowance: at 20 m/s of fall a 1/120 s
       sub-step covers 17 cm, so it must scale with fall speed, and it is held
       wide while already up there so a ridge crossing cannot drop you through.
       Everything downstream then treats the roof as the ground - landing, the
       board frame, the camera - because it goes through gh and n. */
    const pl = G.world && G.world.platAt
      ? G.world.platAt(p.x, p.z, p.y, this.onPlat ? 1.1 : Math.max(0.30, -v.y * dt * 2.5), _plat)
      : null;
    this.onPlat = pl ? 1 : 0;
    if (pl) {
      gh = pl.h; n.set(pl.nx, pl.ny, pl.nz);
      /* the surf mirror feeds audio, the body and the trail: a roof is not snow,
         so no powder spray and no groomed corduroy hiss up there */
      this.surf.groom = 1; this.surf.pow = 0; this.surf.ice = 0.30; this.surf.solid = 0;
    }

    /* ---- lean spring (weight shift has inertia) ---- */
    const maxLean = 1.0;
    const tgt = clamp(inp.steer, -1, 1) * maxLean * (0.72 + 0.28 * this.crouch);
    const stiff = RESP.stiff, damp = RESP.damp;
    this.leanV += ((tgt - this.lean) * stiff - this.leanV * damp) * dt;
    this.lean = clamp(this.lean + this.leanV * dt, -1.35, 1.35);
    this.crouch = approach(this.crouch, inp.tuck ? 1 : 0, 9, dt);
    this.charge = inp.tuck ? Math.min(1, this.charge + dt * 2.2) : 0;

    const wasGround = this.grounded;
    this.grounded = p.y <= gh + 0.06;

    if (this.grounded) {
      /* =========================== ON SNOW =========================== */
      const impact = -v.dot(n);
      p.y = gh;
      this.groundT += dt;
      /* ---- ORDER IS LOAD BEARING (bug fixed 2026-08-12) ----
         `this.airT = 0` USED TO RUN HERE, one line before this call, and land()
         opens with `const air = this.airT` and gates its entire body on
         `air > 0.18`. So `air` was always 0, the gate never passed, and the whole
         landing-quality system was dead code: no air toasts, no air flow bonus,
         no sketchy-landing penalty, no hard-impact penalty - and, once PB10
         landed, no flip punishment either. MEASURED before the fix: a deliberate
         180 deg upside-down landing at impact 22.7 did exactly 0 damage and
         stayed in 'ride'. Zero the timer AFTER land() has read it. */
      if (!wasGround) this.land(impact, n);
      this.airT = 0;
      /* PB10: unwind a landed flip over ~3-4 frames instead of snapping flat in
         one, which read as the rider teleporting onto the terrain. land() has
         already wrapped pitch to its residual, so this settles ~10 deg, never a
         whole rotation. Guarded on a nonzero pitch, so a rider who never flips
         never enters it; the explicit snap to 0 is what restores the exact
         pre-flip path afterwards, since `approach` is asymptotic.
         A wipeout never reaches here - update() early-returns to stepDown() -
         so the crash keeps whatever pitch it landed at, by design. */
      if (this.pitch) {
        this.pitch = approach(this.pitch, 0, FLIP.settle, dt);
        if (Math.abs(this.pitch) < 0.012) { this.pitch = 0; this.pitchV = 0; }
      }
      // remove into-surface velocity
      const vn = v.dot(n);
      if (vn < 0) v.addScaledVector(n, -vn);

      const sp = v.length();
      this.speed = sp;
      // board frame projected on the surface
      let fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const fd = fx * n.x + fz * n.z;
      let f = _tv1.set(fx - n.x * fd, -fd * n.y, fz - n.z * fd).normalize();
      const r = _tv2.crossVectors(n, f).normalize();
      this.edge = this.lean;

      /* ---- surface properties ---- */
      const ice = pl ? 0.30 : s.ice, pow = pl ? 0 : s.pow * (1 - s.park);
      let mu = 0.030 * s.groom + 0.082 * pow + 0.013 * 4 * ice;
      mu = lerp(mu, 0.013, ice * 0.8);
      let gripSurf = 1.0 - ice * 0.62 - pow * 0.10;
      /* ONE deformation query, hoisted from the rut-sink line at the end of
         this block, so §10.4 costs nothing: it was already being paid. */
      const dq = G.stamps ? G.stamps.displaceAt(p.x, p.z, _rut) : null;
      const rutD = dq ? num(dq.depth, 0) : 0;
      /* Scaled by pow as well as by compression, so a groomed piste - where the
         snow is already hard and the cut is 2-6 cm - is bit-identical. */
      const packed = dq ? clamp(num(dq.comp, 0), 0, 1) * smoothstep(0.05, 0.15, rutD) * pow * RUTF.amt : 0;
      if (packed > 0) {
        /* Blend toward what this same snow would be if it were GROOMED, never
           past it: a used line is fast, but no amount of traffic beats a
           piste basher. Expressing it as a lerp instead of a subtraction is
           what makes that bound automatic at any compression. */
        const muP = 0.030 + 0.013 * 4 * ice, gripP = 1.0 - ice * 0.62;
        mu = lerp(mu, Math.min(mu, muP), packed * RUTF.mu);
        gripSurf = lerp(gripSurf, Math.max(gripSurf, gripP), packed * RUTF.grip);
      }
      if (s.solid && !pl) { mu = 0.010; gripSurf = 0.55; }
      /* snow-loaded shingle: slick and low-grip, but not rail-slick */
      if (pl) { mu = 0.018; gripSurf = 0.72; }

      /* ---- carve ---- */
      const vf = v.dot(f);
      const absE = Math.abs(this.edge);
      /* A snowboard is symmetric, so riding SWITCH (tail leading, nose pointing
         back up the hill) is a real stance and not a spin-out. Two things follow.
         (1) Steering must stay consistent on screen: the board's forward axis
         points backwards when switch, so a raw vf*edge would invert the controls
         the moment you land a 180. But vf = |v|*cos(yaw - trav), so sign(vf) is
         ALREADY the stance test - and it goes negative on 23% of grounded frames
         of ordinary forward riding (measured), because a hard scrub swings the
         board past 90 degrees off travel for a few frames. Keying the flip on
         sign(vf) would therefore change ordinary forward carving. So the stance
         is HYSTERETIC: it flips only after STANCE_T of sustained tail-first
         travel, which a slide never reaches and a landed 180 holds. Below
         walking pace the travel direction is ill-defined, so hold the stance.
         (2) The fall-line restoring torque must be PI-periodic: it pulls the
         board back to whichever END is pointing down the hill. With the old
         2*PI-periodic error, yaw was dragged to 0 from anywhere, so switch was
         literally unrideable - you could only ever turn back toward forward. */
      const want = sp > 1.0 && Math.abs(wrapAngle(this.yaw - Math.atan2(v.x, v.z))) > Math.PI / 2 ? -1 : 1;
      if (want === this.stance) this.stanceT = 0;
      else if ((this.stanceT += dt) > STANCE_T) { this.stance = want; this.stanceT = 0; }
      const sw = this.stance;
      /* STEERING IS RIDER-RELATIVE IN BOTH STANCES (Alexander, 2026-08-03): A is
         the rider's left and D the rider's right whether you are forward or
         switch, so riding backwards DOES feel inverted relative to the screen.
         That is intended - it is what riding switch is.

         So the carve term carries NO stance factor. `vf = v.dot(f)` is already
         negative while switch, which mirrors the turn for free; the `* sw` that
         used to sit here was an artificial correction that cancelled exactly
         that, making the turn screen-relative instead.

         Removing it also fixes the §10.5a visual defect for free. The body frame
         is rooted on `yaw` (rider_body.js), so every lean term is mirrored while
         switch: worldLean(switch, E) == worldLean(forward, -E). With the old
         correction the turn was NOT mirrored, so switch leaned OUT of the arc
         (measured: fwd/D -2.22 deg, sw/D -12.47, fwd/A -13.92, sw/A -1.93).
         Now turn and lean mirror together and the rider leans INTO the turn.
         The two are one bug, not two - fixing them separately double-corrects.

         The DIRECT term is a low-speed pivot straight from the input, not a
         consequence of the edge, so it is the one that needs `* sw` to become
         rider-relative. `edge` itself stays screen-derived (the lean spring is
         untouched), which keeps the invariant fx.js relies on. */
      let omegaWant = vf * this.edge * 0.077 + inp.steer * sw * 1.05 * Math.exp(-sp * 0.16);
      // deviation from the nearer of the two stable stances (forward or switch)
      let yawE = (this.yaw + Math.PI / 2) % Math.PI;
      if (yawE < 0) yawE += Math.PI;
      yawE -= Math.PI / 2;
      const yawLim = 1.00;
      if (Math.abs(yawE) > yawLim) omegaWant -= sgn(yawE) * (Math.abs(yawE) - yawLim) * 1.9;
      // grip limit -> skid
      const aNeed = Math.abs(vf * omegaWant);
      const aMax = (0.95 + 2.35 * absE) * gripSurf * G_ACC * (0.8 + 0.2 * this.crouch);
      let excess = 0;
      if (aNeed > aMax && aNeed > 0.01) {
        excess = aNeed - aMax;
        omegaWant *= aMax / aNeed;
      }
      // slip from lateral velocity
      const vr = v.dot(r);
      const slipCap = aMax * dt * 1.35;
      let vrNew = vr;
      if (Math.abs(vr) > 0.02) vrNew = vr - clamp(vr, -slipCap, slipCap);
      const scrub = Math.abs(vr - vrNew) < Math.abs(vr) * 0.98 ? Math.abs(vrNew) : 0;
      v.addScaledVector(r, vrNew - vr);
      // drift outward when the edge lets go
      if (excess > 0) v.addScaledVector(r, -sgn(this.edge) * Math.min(excess * dt * 0.55, 4 * dt));

      this.grace = Math.max(0, this.grace - dt);
      this.skid = approach(this.skid, clamp((excess * 0.055 + Math.abs(vrNew) * 0.42), 0, 1.6), 12, dt);
      if (this.grace > 0) this.skid = Math.min(this.skid, 0.26);   // stomped landings stay clean
      this.omega = omegaWant;
      this.yaw += this.omega * dt;
      // the velocity follows the arc (a pure carve keeps its speed)
      const ca = Math.cos(this.omega * dt), sa = Math.sin(this.omega * dt);
      const nvx = v.x * ca + v.z * sa, nvz = -v.x * sa + v.z * ca;
      v.x = nvx; v.z = nvz;

      /* ---- forces ---- */
      // gravity along the surface
      const gdot = -n.y;
      _tv3.set(-n.x * gdot, -1 - n.y * gdot, -n.z * gdot).multiplyScalar(G_ACC);
      v.addScaledVector(_tv3, dt);
      // friction + scrub loss + drag
      if (sp > 0.05) {
        const brake = inp.grab ? 1.0 : 0;
        const fr = (mu + brake * 0.42 + this.skid * 0.055 + absE * 0.012 * (1 - ice)) * G_ACC;
        const drag = (this.crouch > 0.5 ? 0.0011 : 0.0019) * sp * sp;
        const dec = (fr + drag) * dt;
        const k = Math.max(0, 1 - dec / sp);
        v.multiplyScalar(k);
      }
      // powder plow
      if (pow > 0.3) v.multiplyScalar(Math.max(0, 1 - pow * 0.038 * dt * (0.4 + sp * 0.04)));

      /* ---- flow ceiling ---- */
      this.vmax = 15.5 + 27 * this.flow;
      const sp2 = v.length();
      if (sp2 > this.vmax) {
        const over = sp2 - this.vmax;
        const dec = (0.65 * over + 0.035 * over * over) * dt;
        v.multiplyScalar(Math.max(0, 1 - dec / sp2));
      }

      /* ---- pop / ollie ---- */
      if (inp.pop) {
        inp.pop = false;
        if (this.groundT > 0.10) {
          const pw = 4.3 + this.charge * 3.4 + this.flow * 1.1;
          v.addScaledVector(n, pw);
          p.y += 0.04;
          this.grounded = false; this.airStart = this.p.z; this.airPeak = 0;
          this.charge = 0; this.groundT = 0;
          SFX.pop(clamp(pw / 8, 0.3, 1));
          this.body.popAnim();
        }
      }

      /* ---- rail grind ---- */
      const onRail = s.solid && s.lift > 0.22 && !pl;
      this.railCool = Math.max(0, this.railCool - dt);
      if (onRail) {
        const align = Math.abs(Math.sin(this.yaw));
        if (align > 0.42 || Math.abs(vrNew) > 3.0) {
          // crossed it sideways: scrub off, one penalty per approach
          this.skid = Math.max(this.skid, 0.9);
          if (this.railCool <= 0) { this.hit(0.14 + sp * 0.005, 'off the rail'); this.railCool = 1.4; }
          this.grinding = 0; this.grindT = 0;
        } else {
          this.grinding = 1; this.grindT += dt;
          this.flow = Math.min(1, this.flow + dt * 0.30); this.stat.grind += dt;
        }
      } else { if (this.grinding && this.grindT > 0.35) UI.toast('GRIND', (this.grindT).toFixed(1) + 's clean'); this.grinding = 0; this.grindT = 0; }

      /* ---- ice chatter ---- */
      this.chatter = approach(this.chatter, ice * absE * clamp(sp / 22, 0, 1.2), 8, dt);
      if (this.chatter > 0.55) this.balance -= (this.chatter - 0.55) * 0.55 * dt;

      /* ---- flow build ---- */
      const clean = clamp(1 - this.skid * 1.15, 0, 1);
      const carve = clamp(absE * 1.45, 0, 1);
      const smoothness = clamp(1 - Math.abs(this.leanV) * 0.26, 0, 1);
      let gain = clean * (0.46 + 0.54 * carve) * (0.62 + 0.38 * smoothness);
      if (s.solid || pl) gain = Math.max(gain, 0.9);
      gain *= clamp(0.35 + this.balance, 0, 1);
      this.flow = approach(this.flow, gain, this.flow < gain ? 0.50 : 0.80, dt);
      if (this.skid > 0.5) this.flow = Math.max(0, this.flow - (this.skid - 0.5) * 0.85 * dt);
      // balance recovers when calm
      this.balance = clamp(this.balance + (0.155 * clamp(1 - this.skid, 0, 1) - this.skid * 0.06) * dt, 0, 1);
      // planing: at speed the board floats up out of the powder
      this.sink = approach(this.sink, pow * 0.105 * clamp(1 - sp * 0.030, 0.18, 1), 6, dt);
      /* THE BOARD MUST RIDE THE FLOOR OF ITS OWN RUT. p.y stays on the
         undeformed physics surface (deformation is aesthetic, R2), but the
         DRAWN snow under the board is displaced down by the cut, so without
         this the board hovered the full rut depth - ~25 cm in powder, which
         is exactly the "floating above the surface" report. No feedback is
         possible: wake.push reads only p.x/p.z and derives depth from
         edge/skid/surf, never from y. */
      this.rut = approach(this.rut, rutD, 9, dt);
    } else {
      /* =========================== IN THE AIR =========================== */
      this.airT += dt; this.groundT = 0; this.grinding = 0;
      if (this.airT > 0.08 && this.airStart === 0) { this.airStart = p.z; }
      v.y -= G_ACC * dt;
      const sp = v.length(); this.speed = sp;
      const drag = (inp.grab ? 0.0009 : 0.0016) * sp;
      v.multiplyScalar(Math.max(0, 1 - drag * dt));
      // spin
      const spinRate = 3.0 * (inp.grab ? 0.55 : 1);
      /* Rider-relative in the air too, for the same reason as the ground carve:
         "always" (Alexander, 2026-08-03). Without the stance factor a switch
         rider spins one way on the snow and the other way off a lip, and the
         reversal would land exactly at takeoff. */
      this.omega = approach(this.omega, clamp(inp.steer, -1, 1) * this.stance * spinRate, 6, dt);
      this.yaw += this.omega * dt;
      this.spinTotal += Math.abs(this.omega * dt);
      /* ---- PB10 flip (desktop, Q/E) ----
         Deliberately NOT coupled to anything physical: it never touches v, drag,
         spin or air control, so it cannot change how the rider flies. The whole
         cost of using it is paid at touchdown in land(). That decoupling is what
         makes the "no change for riders who ignore it" guarantee hold.
         The outer guard matters: `approach` is asymptotic and never returns
         exactly 0, so without the explicit snap a single flip would leave pitchV
         at ~1e-9 for ever, keeping `if (r.pitch)` truthy downstream and silently
         un-guarding the feature for the rest of the run. */
      const fi = inp.flip || 0;
      if (fi || this.pitchV) {
        this.pitchV = approach(this.pitchV, fi * FLIP.rate, FLIP.accel, dt);
        if (!fi && Math.abs(this.pitchV) < 1e-4) this.pitchV = 0;
        this.pitch += this.pitchV * dt;
      }
      this.skid = approach(this.skid, 0, 6, dt);
      this.airPeak = Math.max(this.airPeak, p.y - gh);
      this.edge = approach(this.edge, this.lean * 0.5, 6, dt);
      this.flow = approach(this.flow, Math.max(this.flow, 0.55 + (inp.grab ? 0.35 : 0)), 0.5, dt);
      this.sink = approach(this.sink, 0, 8, dt);
      this.rut = approach(this.rut, 0, 8, dt);
    }

    /* ---- integrate ---- */
    p.addScaledVector(v, dt);
    if (this.grounded) p.y = Math.max(p.y, (pl ? gh : terrainH(p.x, p.z)) - 0.02);
    this.maxZ = Math.max(this.maxZ, this.p.z);
    this.speed = this.v.length();

    /* ---- obstacles ---- */
    this.checkObstacles(dt);
    this.checkProps(dt);                     // PB9: solid buildings, towers, signs
    if (this.balance <= 0 && this.state === 'ride') this.wipeout();
  }
}
/* ---- PB10 flip tuning -------------------------------------------------------
   rate/accel:  DELIBERATELY IDENTICAL to the air yaw spin above (spinRate 3.0,
                approach k 6). At 4.6 the pitch visibly outran yaw, which read as
                wrong - "much faster than yaw change and it shouldn't be"
                (Alexander). Do not raise it above the yaw rate. A full rotation
                now needs ~2.1 s of air, so the difficulty lives in FINDING a lip
                big enough, which is the intended expert gate - not in mashing a
                key faster.
   clean:       deviation from a WHOLE number of rotations that still lands free.
                0.175 rad = 10 deg. A rider who never flips has pitch 0, so dev 0,
                and this gate can never fire on them.
   kill:        0.785 rad = 45 deg, an outright wipeout regardless of balance.
   k:           1.64/rad, set so severity reaches exactly 1.00 at the 45 deg kill
                line, i.e. the graded band and the hard kill meet continuously
                instead of stepping. The first tuning (clean 17 deg, kill 123 deg)
                was far too forgiving - Alexander could not wipe out at all even
                when trying, "the exact opposite of punishing".
   settle:      how fast a landed flip unwinds to flat. ~70 zeroes it in 3-4
                frames at 60 fps: almost instant, but not the single-frame SNAP
                that looked bad. Only runs while state is 'ride'.
   Retune live: FL.dbg.flip({rate: 6}) */
const FLIP = { rate: 3.0, accel: 6, clean: 0.175, k: 1.64, kill: 0.785, settle: 70 };
/* ---- landing quality, retuned from playtest feedback 2026-08-12 ----
   These numbers only became reachable at all on 2026-08-12: `airT` was being
   zeroed one line before land() read it, so every rule below was dead code.
   bigAir: airtime that earns the BIG AIR callout. Was an 'AIR' toast at 0.55 s,
           which fired on essentially every pop - "just some air is not exciting
           to warrant a callout" (Alexander). 2.5 s is deliberately rare. It was
           3.0 s, but Alexander landed exactly one and it "was tough and took a
           lot of speed", so 2.5 keeps the banner an event without putting it out
           of reach on terrain that rarely offers a big enough lip. The
           clean-landing STOMP SOUND still fires from 0.55 s, so a normal air
           keeps its feedback and only the banner became scarce. A spin of 180
           deg or more still toasts on its own merit at any airtime - the trick
           is the achievement there, not the hangtime.
   grab:   balance cost for still holding SHIFT at touchdown. Grabbing is a real
           speed play (the air branch lifts flow toward 0.90 while held), so the
           intended skill is to hold it as long as you dare and LET GO before the
           board lands - "you should not land on your hands on board" (Alexander).
           0.35 also exceeds hit()'s 0.3 warn line, so the reason text shows.
   NOTE there is deliberately NO impact term any more. A hard landing used to
   deny the bonus (impact < 11) and add (impact-10)*0.055 of damage; both are
   gone, because "getting huge air is epic and ruining it with damage is not
   making flow feel good". Impact still drives the snow burst, camera shake and
   SFX volume - it simply cannot hurt you.
   noPen/fullPen: the bad-landing penalty is scaled by SPEED, from playtest
           feedback 2026-08-12. "At high speeds getting a land with bad yaw and
           losing speed and taking damage feels fair and right. But when at slow
           speeds trying to reposition and get back down the hill and jump to
           turn and then wiping out feels very bad" (Alexander). So below noPen
           (30 km/h) a landing cannot cost balance AT ALL - not a bad yaw, not a
           blown flip, not a grab - and the scale ramps to full only at fullPen.
           This is a penalty scale, NOT a rule change: every landing
           still settles, toasts and sounds exactly as before.
   RETUNED 2026-08-12 (2nd pass), Alexander: "a bad landing at 90 km/h should
           take less than half health and not have a bad landing be fatal until
           150 km/h". fullPen was 60 km/h, which meant every landing at or above
           60 was already at FULL penalty and a worst-case one could reach the
           1.2 ceiling - instantly fatal from full health at 60 km/h, twice as
           early as asked. Three numbers now carry that spec exactly:
             fullPen 41.67 m/s = 150 km/h - the ramp reaches 1.0 only there.
             sevMax  1.00      - the pre-scale ceiling, so full scale x full
                                 severity is exactly one full balance bar. Was
                                 1.2, which overshot death by 20%.
             penExp  1.2       - a mild convex ramp. Linear would put 90 km/h at
                                 exactly 0.500 = half a bar, and the ask was
                                 strictly LESS than half; ^1.2 puts it at 0.435
                                 while still hitting 1.0 dead on at 150.
           Worst case therefore: 0.435 at 90 km/h, 1.00 at 150 km/h, and 0 below
           30 km/h. NOTE this bounds a landing from FULL health - balance is a
           pool, so a rider already hurt can still die below 150. That is the
           point of a health bar and is deliberate.
           The one death that deliberately SURVIVES this is the stuck/repositioning
           timeout in ui.js, which is not a landing at all: "aside from the
           basically not moving and repositioning death everything else felt good".
   Retune live: FL.dbg.land({bigAir: 1.5}) */
const LAND = { bigAir: 2.5, grab: 0.35, noPen: 8.33, fullPen: 41.67, penExp: 1.2, sevMax: 1.0 };
const _tv1 = new THREE.Vector3(), _tv2 = new THREE.Vector3(), _tv3 = new THREE.Vector3();
const _plat = { h: 0, nx: 0, ny: 1, nz: 0, o: null };

