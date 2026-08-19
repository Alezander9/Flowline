/* ── wake.js ── the trail AUTHOR ──────────────────────────────────────────
   PHASE 6 (PLAN_deformable_snow.md §7): THE SWEPT RIBBON MESH IS RETIRED.

   For most of this game's life the board's track was a separate 2400-segment
   swept trench mesh laid ON the snow: its own geometry, its own copy of the
   snow BRDF, its own sunken vertices held above the terrain solid by
   polygonOffset plus a `min(trueDepth, groundDepth)` decal clamp. That is why
   the trail read as a SHEET on top of the mountain rather than a cut into it,
   and it is the direct cause of a long list of paid-for bugs: the grey-band
   drift (its BRDF copy fell behind the terrain's), the burial under the drawn
   surface on sharp ground (20 cm of chord error against a 12 cm trench), and
   the whole polygonOffset/decal balancing act.

   The trail is now REAL TERRAIN GEOMETRY. Every board contact is recorded in
   the stamp store (stamps.js), the deformation cascade rasterises the store
   (deform.js), and the terrain itself displaces from it - coarse mesh, fine
   patch and the per-pixel `deformGrad` in SNOW_FRAG all read the same field,
   with compression and ice feeding the SAME snowSurf channels as groom/ice.
   One surface, one material, no decal, nothing to keep coplanar.

   What is left here is the AUTHOR: the contact test, the 0.55 m spacing, the
   touchdown ramp and the carve/skid -> width/depth/compression mapping. It
   owns no geometry, no material and no scene node. Every trail in the game -
   player, bots, net ghosts - already funnelled through Wake.push, so keeping
   this class as the single authoring path satisfies R6 (many authors, one
   service) and left every call site unchanged.

   RETIRED WITH THE RIBBON: WK_CROSS/WK_LAT/WK_VRT/WK_CMP, the eight parallel
   Float32Arrays, the CPU sun/sky visibility solve, shadeSection(), draw(),
   makeMat(), WK_VERT, WK_FRAG, uDecal, polygonOffset, and the per-vertex
   meshAt() coplanarity sampling. None of it has a job any more. */

const WK_SEG = 2400;           // legacy ring length; kept for the constructor's
                               // signature only - there is no ring to size now
const WK_STEP = 0.40;          // metres of travel between contact samples

class Wake {
  /* `scene` and `segs` are accepted and ignored: this class no longer builds
     anything. They stay so main.js and bots.js need no edit, and so a future
     author can be added without caring whether the trail is mesh or field. */
  constructor(scene, segs = WK_SEG, src = 0) {
    this.segs = segs;
    /* Author id for the deformation store, so a bot's trail is attributable
       and can be aged or cleared independently of the player's. */
    this.src = src;
    this.on = false;           // currently in contact and laying trail
    this.ramp = 0;             // touchdown ramp-in, in samples
    this.airVy = 0;            // most negative vertical speed seen while airborne
    this.lastX = 1e9;
    this.lastZ = 0;
    this._d = 0;               // distance accumulated since the last sample
    this.n = 0;                // samples authored since the last reset (debug)
    /* API compatibility: G.dbg.wake used to iterate the ribbon's meshes. There
       are none, and an empty list keeps any old caller from throwing. */
    this.parts = [];
  }

  update(r, t) {
    if (!r || r.state !== 'ride') { this.stop(r); return; }
    const p = r.p;
    const gh = terrainH(p.x, p.z);
    /* Contact, not proximity. The old test (within 1.05 m of the ground) started
       laying trail up to a metre BEFORE touchdown, so a track appeared under the
       board while it was still in the air. */
    const down = !r.grounded || p.y - gh > 0.30;
    if (down) { this.airVy = Math.min(this.airVy, r.v ? r.v.y : 0); this.stop(r); return; }
    if (!this.on) {
      /* touchdown: ramp the cut in over ~5 samples so it does not start on a
         hard edge, and throw the snow the landing displaces */
      this.on = true; this.ramp = 0; this.airVy = 0;
    }
    if (this.lastX > 1e8) { this.lastX = p.x; this.lastZ = p.z; }
    const dx = p.x - this.lastX, dz = p.z - this.lastZ;
    this._d += Math.sqrt(dx * dx + dz * dz);
    this.lastX = p.x; this.lastZ = p.z;
    /* Sample by DISTANCE, not by frame, so the trail is frame-rate independent
       and a fast rider does not get a sparser cut than a slow one. */
    let guard = 0;
    while (this._d >= WK_STEP && guard++ < 4) {
      this._d -= WK_STEP;
      this.push(r, t);
    }
  }

  /* Leaving the ground: kick the snow the board scuffs off the lip, which reads
     as the moment of takeoff and gives the track an end. Landing is NOT handled
     here - rider2.land() already owns that burst. */
  stop(r) {
    if (this.on && r && G.fx && r.n && r.v) {
      const sp = r.speed || 0;
      if (sp > 7) G.fx.burst(r.p, r.n, Math.round(Math.min(6 + sp * 0.7, 26)), r.v, 0.55 + sp * 0.012);
    }
    this.on = false;
    this.lastX = 1e9;
    /* not cutting -> nothing airborne from the edge (landings and takeoff are
       bursts, which are owned elsewhere) */
    if (r) r.cutD = 0;
  }

  /* One board contact -> one stamp. No geometry is touched: the store is the
     authority and the cascades rasterise it.

     Note what is NOT needed any more. The ribbon had to sample the DRAWN
     surface per vertex (terr.meshAt) to stay coplanar with the snow, and the
     mesh normal once per segment to light identically to it. A stamp carries
     no height and no normal at all - it is a footprint in the XZ plane, and the
     terrain supplies its own height and normal wherever the cut lands. That
     deletes the entire class of burial/coplanarity bug along with the code. */
  push(r, t) {
    const e = r.edge || 0, sk = r.skid || 0, ae = Math.abs(e);
    /* A rider may carry a MINIMAL surf with no groom/ice (bots did, and net
       ghosts still can), so a truthiness guard here writes undefined into a
       Float32Array = NaN. `num` (util.js) takes the number or the default. */
    const pw = num(r.surf && r.surf.pow, 1);   // 0 = groomed hardpack, 1 = deep powder
    const ic = num(r.surf && r.surf.ice, 0);
    const ramp = clamp(this.ramp, 0, 1);
    const comp = clamp(0.62 + ae * 0.32 + sk * 0.22, 0, 1) * ramp;
    /* HOW MUCH SNOW THERE IS TO MOVE. Until now depth ignored the surface
       entirely, so a carve on hardpack cut the same 45 cm trench as one in deep
       powder - and a deep uniform trench on packed snow is precisely what reads
       as a ribbon laid ON the slope rather than a cut INTO it.

       Reference photos (uploads/): in powder the board opens a real trench with
       broken, chunky walls (clean_snowboard_line_powder, snowboard_powder,
       powder_snowboard_chunks); on a groomed piste the very same turn leaves
       only a fine shallow scratch a couple of centimetres deep, and a whole
       slope of them reads as TEXTURE, not as displacement
       (gondola_piste_texture, snowboard_heavy_tracks_piste). Ice barely cuts
       at all. The piste read is carried by the compression channel instead -
       albedo AND roughness AND thickness - which SNOW_FRAG already applies from
       DF.z, so nothing is lost by letting the geometry go shallow there. */
    const soft = (0.34 + 0.66 * pw) * (1.0 - 0.50 * ic);
    const depth = (0.092 + ae * 0.078 + sk * 0.042) * (0.58 + comp * 0.42) * ramp * soft;
    /* PUBLISH THE CUT (metres of real rut) so the airborne snow can be driven
       by it. Until now fx.spray carried its OWN idea of how much snow was
       moving - `skid*40 + |edge|*sp*1.45 + pow*sp*1.3` - with no ice term at
       all, so a carve on boilerplate threw exactly as much spray as one on
       soft groomed snow while cutting less than half as deep, and the
       powder-vs-piste contrast arrived at about a quarter of its physical
       strength. Two formulas for one physical quantity is the same fault as
       the bots' frozen `surf` placeholder: publish what the sim computed and
       let the consumer read it, never re-derive it. */
    r.cutD = depth * ST_GAIN;
    this.ramp += 0.22;
    /* a locked carve cuts a narrow line; a skid smears a wide one - and the
       board sinks in powder, so the same turn displaces a wider footprint */
    let hw = (0.30 + sk * 0.28 + ae * 0.06) * (0.90 + 0.55 * pw);
    /* THE FOOTPRINT IS A HEIGHTFIELD, SO IT MUST BE MEASURED IN WORLD XZ.
       The board's width is fixed ALONG THE SURFACE, but the deformation buffer
       is indexed by world xz, so a constant xz half-width covers width/cos(t)
       of actual surface on a cross-slope - riding a wall suddenly ploughed a
       trench half again as wide. Project the on-surface width down onto the
       horizontal plane instead: the cross-track horizontal direction matches
       the stamp's own lat convention (lat = |dx*cos a - dz*sin a|), so it is
       (cos a, -sin a), and the surface slope along it is -(n.c)/n.y. */
    /* Carried to the stamp so the BERM can be projected by the same factor -
       see the bf array in stamps.js. 1 = flat = unchanged. It is published
       rather than recomputed downstream for the reason given above about two
       formulas for one physical quantity: the consumer must read what the sim
       computed, and a reader deriving it again would need the normal at read
       time, which neither displaceAt nor the deform shader has cheaply. */
    let bfac = 1;
    if (r.n) {
      const ca = Math.cos(r.yaw), sa = Math.sin(r.yaw);
      const ny = Math.max(r.n.y, 0.2);
      const dh = -(r.n.x * ca + r.n.z * (-sa)) / ny;
      /* floored: a near-vertical wall must still leave a readable track */
      bfac = Math.max(1 / Math.sqrt(1 + dh * dh), 0.45);
      hw *= bfac;
    }
    /* ST_GAIN converts the ribbon-era depth (a ~12 cm visual decal) into a real
       rut depth in metres. It is the one number that carries the old tuning
       forward, and the honest place to deepen the cut. */
    if (G.stamps) G.stamps.add(r.p.x, r.p.z, r.yaw, hw, depth * ST_GAIN, comp, ic, this.src, t, bfac);
    this.n++;
  }

  reset() {
    this.on = false; this.lastX = 1e9; this.lastZ = 0; this._d = 0; this.n = 0;
  }

  /* Nothing to free: no geometry, no material, no render target. Kept because
     bots call it when a rider retires. */
  dispose() {}
}

