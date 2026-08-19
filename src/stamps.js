/* =====================================================================
   stamps.js - the deformation STORE (phase 4 of PLAN_deformable_snow.md)

   The single authority for every mark made in the snow. Nothing here
   renders: the store is a flat packed byte buffer plus a coarse spatial
   index, and both deformation cascades are resolution-appropriate
   RASTERISATIONS of it while physics/props query it directly.

   That structure is what makes "come back later and your trail is still
   there" the DEFAULT BEHAVIOUR rather than a feature (R5b) - re-entering
   a region simply re-rasterises whatever the store already holds there -
   and it lets any number of authors (player, bots, net peers, the
   player's earlier runs) write through one path (R6).

   Because we AUTHOR the deformation rather than simulate it, nothing is
   ever read back off the GPU. That is the whole reason this is cheap.

   Sizing (measured, see the plan's tables): 16 B per stamp at the
   existing 0.55 m sample spacing = 29.1 B per metre of trail, so a
   3.5 km run with bots is ~348 KB and 20 runs is ~6.8 MB. The store is a
   non-issue, which settles R8: decay is NOT needed to bound memory, so
   any healing is a purely artistic choice.
   ===================================================================== */

const ST_B = 16;            // bytes per stamp
/* Spatial index tile size, metres. MEASURED, not guessed: stamps lie along ~1-D
   tracks, so per-tile occupancy scales with tile SIDE length, not area. Sweep at
   a realistic load (8 authors, 3.5 km, 0.55 m step) gave displaceAt / 128 m strip
   query of 5.81/153 us at 64 m, 3.47/130 at 32, 1.44/42 at 8, 1.13/45 at 6,
   1.11/58 at 4, 1.31/132 at 2. Coarse tiles lose on BOTH axes because a strip
   query then drags in a huge candidate set outside the rect (hit count is
   identical at every size). 4-8 m is a broad optimum; 6 balances the two. */
const ST_TILE = 6;
const ST_CAP0 = 1 << 14;    // 16,384 stamps = 256 KB to start
const ST_CAPMAX = 1 << 21;  // 2,097,152 stamps = 33 MB ceiling (R4: big is fine)

/* Quantisation. Every channel's error is far below what can be drawn:
   depth 1.2 m over 16 bits = 0.018 mm, heading 1.4 deg, half width 1 cm,
   compression/ice 1/15 (they are shading channels, not heights). */
const ST_DMAX = 1.2;        // metres of depth the u16 spans
const ST_WMAX = 2.55;       // metres of half width the u8 spans (1 cm steps)
const ST_TQ = 0.25;         // seconds per time tick (u16 -> 4.5 hours)

/* A stamp is a SEGMENT of trail, not a point: its footprint reaches
   ST_REACH half widths along and across, plus a berm shoulder of ST_BERM
   metres outside that. Declared here because add()/queryRect() index and
   cull against them. */
const ST_REACH = 1.15;
const ST_BERM = 0.55;
/* Berm height as a fraction of trench depth. The reference powder photos
   (clean_snowboard_line_powder, powder_snowboard_chunks) show the displaced
   mass piled well up the wall - a cut bank, not a lip - so the trail reads as
   snow MOVED rather than snow removed. Consumed by BOTH the CPU authority
   (displaceAt) and DF_STAMP_FRAG, which interpolates this same constant. */
const ST_BERMH = 0.68;

/* The wake ribbon's own `depth` is a legacy ~12 cm DECAL, tuned when the
   trail was a translucent overlay rather than geometry. The store holds
   the TRUE intended cut in metres, so the same authored shape is scaled
   to what a board really does: R1 asks for deep, rich ruts, and 0.42 m
   is what a fully committed carve reaches here (see the plan's depth
   budget - what limits a rut is drawn resolution, not physics). */
const ST_GAIN = 3.2;

/* Tile keys must survive NEGATIVE world coordinates. Flowline's x runs
   both sides of the piste centre, and `(x / ST_TILE) | 0` truncates
   TOWARD ZERO, so -0.5 and +0.5 would share tile 0 and that tile would be
   twice as wide as every other one. Always Math.floor, then bias. */
const ST_OFF = 1 << 15;
const ST_SPAN = 1 << 16;
function stTile(v) { return Math.floor(v / ST_TILE); }
function stKey(ix, iz) { return (ix + ST_OFF) * ST_SPAN + (iz + ST_OFF); }

function stClamp(v, a, b) { return v < a ? a : v > b ? b : v; }

class StampStore {
  constructor(cap = ST_CAP0) {
    this.cap = cap;
    this._alloc(cap);   // sizes the packed buffer AND the dedup tags
    this.n = 0;
    this.tiles = new Map();       // tile key -> array of stamp indices
    this.maxReach = 0;            // widest influence radius in the store
    this._last = new Map();       // src -> {x, z} for spacing enforcement
    this.drops = 0;               // stamps refused at the capacity ceiling
  }

  _alloc(cap) {
    const buf = new ArrayBuffer(cap * ST_B);
    this.buf = buf;
    this.f32 = new Float32Array(buf);   // x at i*4+0, z at i*4+1
    this.u16 = new Uint16Array(buf);    // depth at i*8+4, time at i*8+5
    this.u8 = new Uint8Array(buf);      // halfW 12, head 13, comp|ice 14, src 15
    /* dedup tags for queries. A stamp is indexed into every tile its
       footprint touches, so a query spanning tiles sees it several times.
       An Int32 tag per stamp compared against a per-query id is O(1) with
       no hashing and no allocation - a Set here cost 2.3x on the hot
       physics path (measured 5.77 -> 2.5 us). */
    this._tag = new Int32Array(this.cap);
    this._qid = 0;
    /* BERM FORESHORTENING, one byte per stamp, in a PARALLEL array rather than
       the packed record: all 16 bytes of ST_B are taken, and the f32/u16 views
       above index at i*4 / i*8, which hard-codes a 16-byte stride - restriding
       to make room would touch every accessor. 255 = 1.0 = no foreshortening.
       WHY IT EXISTS: halfW arrives already projected onto world XZ (wake.js
       :148-162), but ST_BERM did not, and the berm is the MAJORITY of a track's
       lateral extent (measured on Alexander's M5, 2026-08-12: median halfW 0.254
       against a 0.55 berm, so 68% of the width was unprojected). That left the
       ORIGINAL "too wide on a wall" bug alive in the berm term at about half
       strength - 1.27x too wide at 46 deg, 1.50x at 62 deg. */
    this.bf = new Uint8Array(this.cap);
  }

  /* Grow by doubling, preserving every byte. Returns false at the ceiling. */
  _grow() {
    if (this.cap >= ST_CAPMAX) return false;
    const cap = Math.min(this.cap * 2, ST_CAPMAX);
    const old = this.u8, oldbf = this.bf;
    this.cap = cap;          // _alloc sizes _tag from this.cap
    this._alloc(cap);
    this.u8.set(old);
    this.bf.set(oldbf);      // the parallel berm-factor array grows with it
    return true;
  }

  /* Raw append. Angles in radians, depth/halfW/reach in metres, comp and
     ice in 0..1, src an integer author id, t seconds. */
  add(x, z, head, halfW, depth, comp, ice, src, t, bfac) {
    if (this.n >= this.cap && !this._grow()) { this.drops++; return -1; }
    const i = this.n++;
    const f = i * 4, h = i * 8, b = i * ST_B;
    this.f32[f] = x;
    this.f32[f + 1] = z;
    this.u16[h + 4] = stClamp(Math.round(depth / ST_DMAX * 65535), 0, 65535);
    this.u16[h + 5] = stClamp(Math.round(t / ST_TQ), 0, 65535);
    this.u8[b + 12] = stClamp(Math.round(halfW / ST_WMAX * 255), 0, 255);
    /* The caller passes the SAME projection factor it already applied to halfW,
       so nothing re-samples the terrain. Absent (bots with no normal, net
       ghosts, feed()) means "flat" = 1.0, which reproduces the old behaviour
       exactly rather than collapsing the berm to nothing. */
    this.bf[i] = bfac === undefined ? 255 : stClamp(Math.round(bfac * 255), 1, 255);
    /* wrap heading into 0..2pi BEFORE quantising, so a negative or
       multi-turn angle does not clamp to an end stop */
    let a = head % 6.283185307179586;
    if (a < 0) a += 6.283185307179586;
    this.u8[b + 13] = Math.round(a / 6.283185307179586 * 255) & 255;
    this.u8[b + 14] = (stClamp(Math.round(comp * 15), 0, 15) << 4) |
                       stClamp(Math.round(ice * 15), 0, 15);
    this.u8[b + 15] = src & 255;

    /* index it. A stamp is a short segment of trail, not a point, so its
       influence spans halfW plus the berm shoulder either side; register
       it in every tile that footprint touches or a query along a tile
       boundary will miss it. */
    const reach = halfW * ST_REACH + ST_BERM;
    if (reach > this.maxReach) this.maxReach = reach;
    const ix0 = stTile(x - reach), ix1 = stTile(x + reach);
    const iz0 = stTile(z - reach), iz1 = stTile(z + reach);
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = stKey(ix, iz);
        const a2 = this.tiles.get(k);
        if (a2) a2.push(i); else this.tiles.set(k, [i]);
      }
    return i;
  }

  /* The ONE service every author writes through (R6). Enforces the same
     0.55 m spacing the wake already uses, per source, so a fast rider and
     a slow one lay the same density of stamps and a stationary one lays
     none. Returns the stamp index, or -1 if this sample was too close to
     the source's previous one. */
  feed(src, x, z, head, halfW, depth, comp, ice, t, step) {
    const s = step === undefined ? 0.55 : step;
    const p = this._last.get(src);
    if (p) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < s * s) return -1;
      p.x = x; p.z = z;
    } else this._last.set(src, { x, z });
    return this.add(x, z, head, halfW, depth, comp, ice, src, t);
  }

  /* Unpack one stamp into `out` (reused; never allocates). */
  get(i, out) {
    const o = out || {};
    const f = i * 4, h = i * 8, b = i * ST_B;
    o.x = this.f32[f];
    o.z = this.f32[f + 1];
    o.depth = this.u16[h + 4] / 65535 * ST_DMAX;
    o.t = this.u16[h + 5] * ST_TQ;
    o.halfW = this.u8[b + 12] / 255 * ST_WMAX;
    o.head = this.u8[b + 13] / 255 * 6.283185307179586;
    o.comp = (this.u8[b + 14] >> 4) / 15;
    o.ice = (this.u8[b + 14] & 15) / 15;
    o.src = this.u8[b + 15];
    /* 0 can only mean "written before this field existed"; treat as flat. */
    o.bfac = this.bf[i] ? this.bf[i] / 255 : 1;
    return o;
  }

  /* Walk every UNIQUE stamp whose footprint could influence the rect,
     calling fn(i) for each. No allocation, no output array - both
     queryRect and displaceAt are thin wrappers over this. */
  _each(x0, z0, x1, z1, pad, fn) {
    const p = (pad === undefined || pad === null) ? this.maxReach : pad;
    const ix0 = stTile(x0 - p), ix1 = stTile(x1 + p);
    const iz0 = stTile(z0 - p), iz1 = stTile(z1 + p);
    if (++this._qid >= 0x7fffffff) { this._tag.fill(0); this._qid = 1; }
    const qid = this._qid, tag = this._tag;
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iz = iz0; iz <= iz1; iz++) {
        const a = this.tiles.get(stKey(ix, iz));
        if (!a) continue;
        for (let j = 0; j < a.length; j++) {
          const i = a[j];
          if (tag[i] === qid) continue;
          tag[i] = qid;
          const f = i * 4, x = this.f32[f], z = this.f32[f + 1];
          const reach = this.u8[i * ST_B + 12] / 255 * ST_WMAX * ST_REACH + ST_BERM;
          if (x + reach < x0 || x - reach > x1 || z + reach < z0 || z - reach > z1) continue;
          fn(i);
        }
      }
  }

  /* Every stamp that could influence the rect, deduplicated. `out` is
     reused. This is what a cascade calls for its newly exposed strip. */
  queryRect(x0, z0, x1, z1, out, pad) {
    const r = out || [];
    r.length = 0;
    this._each(x0, z0, x1, z1, pad, i => r.push(i));
    return r;
  }

  /* Surface displacement at a world point: how far the snow is pushed
     down, and how high the berm beside it stands. This is the physics /
     props coupling hook - one tile lookup, never a GPU readback.

     The cross-track profile is deliberately the same shape the cascade
     rasteriser will draw, so CPU and GPU agree by construction rather
     than by tuning. */
  displaceAt(x, z, out) {
    const o = out || {};
    o.depth = 0; o.berm = 0; o.comp = 0; o.ice = 0; o.n = 0;
    const self = this;
    this._each(x, z, x, z, undefined, function (i) {
      const f = i * 4, b = i * ST_B;
      const sx = self.f32[f], sz = self.f32[f + 1];
      const halfW = self.u8[b + 12] / 255 * ST_WMAX;
      if (halfW <= 0) return;
      /* lateral distance from the stamp's travel line */
      const a = self.u8[b + 13] / 255 * 6.283185307179586;
      const dx = x - sx, dz = z - sz;
      const lat = Math.abs(dx * Math.cos(a) - dz * Math.sin(a));
      const along = Math.abs(dx * Math.sin(a) + dz * Math.cos(a));
      if (along > halfW * ST_REACH + ST_BERM) return;
      const depth = self.u16[i * 8 + 4] / 65535 * ST_DMAX;
      o.n++;
      if (lat <= halfW) {
        /* Dual-rail snowboard track: two edge grooves + packed mid-sole.
           Must match DF_STAMP_FRAG exactly. */
        const railC = halfW * 0.68;
        const railW = Math.max(halfW * 0.26, 0.035);
        const tt = (lat - railC) / railW;
        const rail = Math.exp(-tt * tt);
        const mid = 1 - smoothstep(0, railC * 0.9, lat);
        const d = depth * (0.28 * mid + 1.0 * rail);
        if (d > o.depth) o.depth = d;
        const c = (self.u8[b + 14] >> 4) / 15;
        /* whole board width is compacted snow, rails extra so */
        const ck = c * (0.52 + 0.48 * mid + 0.22 * rail);
        if (ck > o.comp) o.comp = ck;
        const ic = (self.u8[b + 14] & 15) / 15;
        if (ic > o.ice) o.ice = ic;
      } else {
        /* displaced mass piles into a berm just outside the track - this
           is the channel that makes a rut read as a rut instead of a
           flat decal, and it is why the old wake needed a berm mesh */
        /* Foreshorten the berm exactly as halfW already was. On flat ground bf
           is 255 -> 1.0 and this is bit-identical to the old `/ ST_BERM`, so
           groomed piste is untouched; only a cross-slope narrows. Floored at
           0.1 so a corrupt 0 can never divide by zero and erase every berm. */
        const u = (lat - halfW) / (ST_BERM * Math.max(self.bf[i] ? self.bf[i] / 255 : 1, 0.1));
        if (u < 1) {
          const bh = depth * ST_BERMH * (1 - u) * (1 - u);
          if (bh > o.berm) o.berm = bh;
        }
      }
    });
    return o;
  }

  clear() {
    this.n = 0;
    this._tag.fill(0);
    this._qid = 0;
    this.tiles.clear();
    this._last.clear();
    this.maxReach = 0;
    this.drops = 0;
  }

  stats() {
    let per = 0, mx = 0;
    for (const a of this.tiles.values()) { per += a.length; if (a.length > mx) mx = a.length; }
    return {
      n: this.n, cap: this.cap, bytes: this.cap * ST_B, used: this.n * ST_B,
      tiles: this.tiles.size, refs: per,
      perTile: this.tiles.size ? +(per / this.tiles.size).toFixed(1) : 0,
      maxTile: mx, maxReach: +this.maxReach.toFixed(3), drops: this.drops
    };
  }
}

