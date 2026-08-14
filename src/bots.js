let BOT_SRC = 0;   // rolling author id for bot trails (see Wake.src)
/* ------------------------------------------------- AI riders on the mountain
   Kinematic riders that share the player's terrain. They spawn behind, ride
   their own line down the fall line and are retired once far ahead.        */

const BOT_KINDS = [
  { id: 'carver', col: 0x4ec9f0, vmax: 30, turn: 1.25, amp: 16, freq: 0.017, lat: 0, air: 0.45, grab: 0.5, spin: 0.35, fall: 0.008, tuck: 0.35 },
  { id: 'trick', col: 0xf7d354, vmax: 31, turn: 1.45, amp: 9, freq: 0.030, lat: 0, air: 1.00, grab: 0.95, spin: 0.95, fall: 0.030, tuck: 0.40 },
  { id: 'powder', col: 0x9be86a, vmax: 27, turn: 1.05, amp: 22, freq: 0.011, lat: 42, air: 0.55, grab: 0.4, spin: 0.20, fall: 0.020, tuck: 0.30 },
  { id: 'sniper', col: 0xff6fa5, vmax: 37, turn: 0.75, amp: 3.5, freq: 0.008, lat: 0, air: 0.25, grab: 0.2, spin: 0.05, fall: 0.004, tuck: 0.90 },
  { id: 'looser', col: 0xa98cff, vmax: 33, turn: 1.6, amp: 13, freq: 0.024, lat: 0, air: 0.8, grab: 0.7, spin: 0.6, fall: 0.115, tuck: 0.5 }
];

class Bot {
  constructor(kind, x, z) {
    this.k = kind;
    this.side = Math.random() < 0.5 ? -1 : 1;
    this.phase = Math.random() * TAU;
    this.vmax = kind.vmax * (0.9 + Math.random() * 0.22);
    this.latBias = kind.lat ? this.side * (kind.lat * (0.7 + Math.random() * 0.7)) : (Math.random() - 0.5) * 12;
    this.body = new RiderBody(G.scene, kind.col, true);
    /* Bots carve real snow too. A short ring is plenty: by the time it runs out
       the bot is far enough away that the tail is not readable anyway. */
    /* author ids: 0 is the player, bots take 1.. so the store can tell whose
       trail is whose (R6). Modulo 254, not a bit mask - `& 0xfe` clears the low
       bit, which makes every consecutive PAIR of bots share an id. */
    this.wake = new Wake(G.scene, 150, 1 + (BOT_SRC++ % 254));
    this.downT = 0; this.spinV = 0; this.obsT = Math.random(); this.avoid = 0;
    this.alive = true; this.t = 0;
    const y = terrainH(x, z);
    this.r = {
      p: new THREE.Vector3(x, y, z), v: new THREE.Vector3(0, 0, 9), n: new THREE.Vector3(0, 1, 0),
      yaw: 0, edge: 0, speed: 9, crouch: 0, skid: 0, balance: 1, airT: 0, grounded: true,
      state: 'ride', input: { grab: false }, sink: 0, runT: 0, omega: 0,
      /* Real surface state, refreshed every frame in update(). It used to be a
         frozen `{ pow: 0.2 }`, which meant a bot's trail depth, width and spray
         were decoupled from the snow it was actually riding: MEASURED, a bot on
         the same groomed piste as the player cut 8.6 cm against the player's
         1.9 cm (4.5x), while a bot in real powder (pow 1) cut only 8 cm instead
         of ~30, and one on near-solid ice (0.93) cut 5.6x too deep. Full shape
         so no consumer reads undefined on frame 0 - wake.push writes these
         straight into a Float32Array, where undefined becomes NaN. */
      surf: { pow: 0, ice: 0, groom: 1 }
    };
  }
  destroy() {
    this.body.dispose();            // frees the skeleton's bone texture too
    this.wake.dispose();
    this.alive = false;
  }
  /* steer around the nearest tree / rock in front of us */
  scanObstacles() {
    const w = G.world; if (!w || !w.obsN) { this.avoid = 0; return; }
    const r = this.r, ob = w.obs;
    const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
    let best = 0, bestD = 26;
    for (let i = 0; i < w.obsN; i++) {
      const o = i * OBS_S, dx = ob[o] - r.p.x, dz = ob[o + 1] - r.p.z;
      const fwd = dx * fx + dz * fz;
      if (fwd < 1 || fwd > bestD) continue;
      const side = dx * fz - dz * fx;
      const clear = ob[o + 2] + 1.7;
      if (Math.abs(side) > clear) continue;
      bestD = fwd;
      best = (side >= 0 ? -1 : 1) * (1 - Math.abs(side) / clear);
    }
    this.avoid = best;
  }
  update(dt) {
    const r = this.r, k = this.k, p = r.p;
    this.t += dt;
    if (r.state === 'down') {
      this.downT -= dt;
      r.speed *= Math.exp(-2.2 * dt);
      p.x += r.v.x * dt * 0.25; p.z += r.v.z * dt * 0.25;
      p.y = terrainH(p.x, p.z);
      if (this.downT <= 0) { r.state = 'ride'; r.v.set(0, 0, 5); r.speed = 5; this.body.tumble = 0; }
      this.body.update(r, dt);
    if (this.wake) {
      const c = G.cam ? G.cam.position : null;
      const near = !c || ((c.x - r.p.x) ** 2 + (c.z - r.p.z) ** 2) < 210 * 210;
      this.wake.update(near ? r : null, WU.uTime.value);
    }
      return;
    }
    // --- line: fall line + personality weave, biased off-piste for powder hounds
    this.obsT -= dt;
    if (this.obsT <= 0) { this.obsT = 0.12; this.scanObstacles(); }
    const zAhead = p.z + 14;
    const weave = Math.sin(this.phase + p.z * k.freq) * k.amp;
    let wantX = pisteC(zAhead) + this.latBias + weave + this.avoid * 16;
    const dx = wantX - p.x, dz = 14;
    const wantYaw = Math.atan2(dx, dz);
    const dy = wrapAngle(wantYaw - r.yaw);
    const rate = k.turn * (1.4 - clamp(r.speed / 46, 0, 0.7));
    const steer = clamp(dy * 2.4, -rate, rate);
    if (r.grounded) r.yaw += steer * dt; else r.yaw += this.spinV * dt;

    // --- speed: slope pull, drag, turn scrub
    const gradAhead = (terrainH(p.x, p.z) - terrainH(p.x + Math.sin(r.yaw) * 6, p.z + Math.cos(r.yaw) * 6)) / 6;
    const turnScrub = Math.abs(steer) * (0.6 + k.amp * 0.02);
    if (r.grounded) {
      const acc = gradAhead * 26 + 2.2 - turnScrub * 5.5;
      const vmax = this.vmax * (0.75 + k.tuck * 0.35);
      r.speed += (acc - r.speed * r.speed / (vmax * vmax) * 9.5) * dt;
      r.speed = clamp(r.speed, 3, 52);
      /* [-1,1], the player's own edge domain. Bots used to cap at +-1.15 and
         MEASURED they sat exactly there while weaving, pushing the depth and
         compression curves past the range they were authored against. */
      r.edge = approach(r.edge, clamp(-steer * 2.6, -1, 1), 6, dt);
      r.crouch = approach(r.crouch, k.tuck * 0.5 + Math.abs(r.edge) * 0.35, 3.2, dt);
    } else {
      r.edge = approach(r.edge, 0, 3, dt);
    }
    r.v.set(Math.sin(r.yaw) * r.speed, r.v.y, Math.cos(r.yaw) * r.speed);
    p.x += r.v.x * dt; p.z += r.v.z * dt;

    // --- ground contact / air
    const h = terrainH(p.x, p.z);
    if (r.grounded) {
      const vyFollow = (h - p.y) / Math.max(dt, 1e-4);
      if (vyFollow < r.v.y - 26 * dt && r.v.y > 0.6) {           // lip fell away: launch
        r.grounded = false; r.airT = 0; this.spinV = 0;
        if (Math.random() < k.spin * 0.8) this.spinV = (Math.random() < 0.5 ? -1 : 1) * (3.4 + Math.random() * 4.6);
        r.input.grab = Math.random() < k.grab;
      } else {
        p.y = h;
        r.v.y = clamp(vyFollow, -14, 13);
      }
    }
    if (!r.grounded) {
      r.v.y -= 26 * dt;
      p.y += r.v.y * dt;
      r.airT += dt;
      if (p.y <= h) {
        p.y = h; r.grounded = true; r.input.grab = false;
        const hard = -r.v.y;
        r.v.y = 0;
        const messy = this.spinV !== 0 && Math.abs(wrapAngle(r.yaw - Math.atan2(r.v.x, r.v.z))) > 0.85;
        this.spinV = 0;
        if (Math.random() < k.fall * (1 + hard * 0.05) + (messy ? k.fall * 4 : 0)) this.crash();
        else if (hard > 6) { r.crouch = 1; if (G.fx) G.fx.burst(p, r.n, 10, r.v, 0.7); }
        r.airT = 0;
      }
    } else if (Math.random() < k.fall * dt * 0.5) this.crash();

    // orientation + fx
    const nn = terrainNormal(p.x, p.z, 1.2);
    r.n.set(nn.x, nn.y, nn.z);
    /* Read the snow we are ON, next to the normal we already pay for. wake.push
       derives depth/width from surf.pow and surf.ice, and fx.spray reads surf.pow,
       so a bot that never sampled the surface left a constant-depth track across
       piste, powder and ice alike - precisely the "ribbon laid on top" read that
       retiring the swept mesh was meant to end. ~0.2 us per bot per frame. */
    if (G.terr) {
      const gs = G.terr.surf(p.x, p.z, 2);
      r.surf.pow = gs.pow; r.surf.ice = gs.ice; r.surf.groom = gs.groom;
    }
    r.speed = Math.hypot(r.v.x, r.v.z);
    r.skid = clamp(Math.abs(r.edge) * 0.8, 0, 1);
    r.runT = G.t + this.phase;
    if (G.fx && r.grounded && r.speed > 8 && Math.abs(r.edge) > 0.35) {
      const d2 = (p.x - G.rider.p.x) ** 2 + (p.z - G.rider.p.z) ** 2;
      if (d2 < 90 * 90) G.fx.spray(r, dt, d2 < 40 * 40 ? 1.1 : 0.45);
    }
    this.body.update(r, dt);
    if (this.wake) {
      const c = G.cam ? G.cam.position : null;
      const near = !c || ((c.x - r.p.x) ** 2 + (c.z - r.p.z) ** 2) < 210 * 210;
      this.wake.update(near ? r : null, WU.uTime.value);
    }
  }
  crash() {
    const r = this.r;
    if (r.state === 'down') return;
    r.state = 'down'; this.downT = 2.0 + Math.random() * 1.6;
    if (G.fx) G.fx.burst(r.p, r.n, 26, r.v, 1.2);
  }
}

const BOTS = {
  list: [], on: true, next: 0,
  reset() { for (const b of this.list) b.destroy(); this.list.length = 0; this.next = 0.8; },
  target() { const l = (G.q && G.q.lvl) | 0; return l <= 0 ? 3 : (l === 1 ? 5 : 7); },
  update(dt) {
    if (!this.on) return;
    const pz = G.rider.p.z;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      const rel = b.r.p.z - pz;
      if (rel > 420 || rel < -160 || Math.abs(b.r.p.x - G.rider.p.x) > 260) { b.destroy(); this.list.splice(i, 1); continue; }
      b.update(dt);
    }
    this.next -= dt;
    if (this.next <= 0 && this.list.length < this.target() && G.rider.state !== 'idle') {
      this.next = 1.6 + Math.random() * 3.4;
      this.spawn(pz);
    }
  },
  /* place a bot at a chosen offset from the rider (trailer / debug) */
  place(kindId, relZ, lat, spd) {
    const k = BOT_KINDS.find(x => x.id === kindId) || BOT_KINDS[0];
    const r = G.rider;
    const z = r.p.z + relZ, x = pisteC(z) + (lat || 0);
    const b = new Bot(k, x, z);
    b.r.speed = spd || 24;
    b.r.v.set(0, 0, b.r.speed);
    this.list.push(b);
    return b;
  },
  spawn(pz) {
    const k = BOT_KINDS[(Math.random() * BOT_KINDS.length) | 0];
    const z = pz - (45 + Math.random() * 85);
    const x = pisteC(z) + (Math.random() - 0.5) * 26 + (k.lat ? (Math.random() < 0.5 ? -1 : 1) * k.lat * 0.6 : 0);
    const b = new Bot(k, x, z);
    b.r.speed = 16 + Math.random() * 10;
    this.list.push(b);
  }
};
