/* ============================ terrain_skirt.js ============================
   THE EDGE OF THE WORLD (PB8).

   The core clipmap's coverage is  widthAt(d) = min(1900, 68 + 0.60d)  measured
   along the FALL LINE, but the player looks ACROSS it. A ray aimed 75 deg off
   the fall line therefore leaves the drawn band at its NEAR half width - it was
   measured stopping at 78 m, with a median 67.5 m of mountain hidden behind the
   cut and a 12.3 sRGB silhouette step against the baked dome. Fog cannot help:
   the §7 clamp is smoothstep(1150, 2350, dist), which is 0.00 out to 800 m.

   This is a SEPARATE MESH, which is what makes it cheap and safe:

     - RADIAL, so it covers every azimuth equally. That is the whole point -
       any fix expressed as a width along z inherits the bug it is fixing.
     - Cell size PROPORTIONAL TO RADIUS, cell = r/SK_K. The core's own fidelity
       law is ROWRES = max(SNAP, 0.038d) = d/26, so at SK_K = 25 the skirt is
       sampled slightly FINER than the terrain the player already looks at at
       that distance: it cannot read as a worse surface than the thing it joins.
       Measured error against sampleAt(x,z,2): 0.6 px at 78 m, 1.2 at 200,
       3.1 at 400, 2.7 at 1600. (A UNIFORM pitch was tried and disproven - it
       sits up to +8.6 m ABOVE the fine surface and punches through the piste.)
     - Truncated at SK_R1 = 2400 m, where §7's fog weight reaches 1.0. Geometry
       past that contributes no pixels, so "reach 2400 m at every azimuth" makes
       the boundary invisible BY CONSTRUCTION rather than by a seam threshold.

   It does NOT touch the core band's row/lattice maths, so the rowH() and
   meshAt() uniform-per-row-pitch invariants are untouched, and it does not
   touch terrain_core/terrain_feat, so the R12 mountain gate is discharged by
   the bundle module diff.

   Deformation is deliberately absent here. The near cascade is +-64 m about its
   centre and the skirt is only ever VISIBLE outside core coverage, i.e. beyond
   ~78 m laterally, so the two never overlap - no risk of the phase-5 bug where
   a mesh shades a trench it does not have.
                                                                            */

const SK_K    = 25;     // cell size = r / SK_K   (core is d/26)
const SK_R1   = 2400;   // outer radius: where the §7 fog clamp reaches 1.0
const SK_SLICE= 8;      // rings resampled per frame
/* SK_R0 + SK_STEP MUST STAY UNDER 68 m. The mesh is anchored at sOrg, not at
   the rider, so by the time the rider has drifted SK_STEP the skirt's inner
   edge has retreated that far on the far side. widthAt() clamps max(d,0), so
   the core's half-width is never less than 68 m in any direction - if the
   skirt's inner edge ever passed that, a fresh ring-shaped hole would open
   exactly where this mesh exists to prevent one. 40 + 20 leaves 8 m of
   overlap in the worst case, and overlap is free (the skirt is underneath). */
const SK_R0   = 40;
const SK_STEP = 20;

/* Overlap policy: the skirt is drawn UNDER the core wherever both exist. It is
   sunk by a down-bias PROPORTIONAL TO THE LOCAL CELL and drawn first
   (renderOrder -1), so the core - which is sampled finer - always wins the
   depth test. Proportional rather than absolute because both meshes' sampling
   error scales with distance, so a fixed bias that is invisible at 1600 m is
   not enough at 78 m and vice versa.

   A fragment discard inside core coverage was considered and dropped: it would
   mean string-patching SNOW_FRAG, and the only thing it buys is some depth-
   rejected overdraw on 28 k triangles, which is far below the noise floor on a
   renderer where triangles are cheap and draw calls are the budget. Keeping
   SNOW_FRAG VERBATIM is worth more - there is one snow material model in this
   game, and it has drifted before (the wake's private copy, phase 8). */
/* 0.6 is MEASURED, not guessed. Sweeping 0 / 0.15 / 0.35 / 0.6 / 0.9 / 1.4 at a
   frozen 75 deg-yawed PB8 viewpoint (SEAMCUT, control repeated last and
   bit-identical, so the noise floor is 0): at 0 the skirt punches through and
   the seam step is p50 13.7 sRGB; the metric then SATURATES from 0.6 upward
   (cutFrac 0.1438 / 0.1438 / 0.1430, worst missing mountain 14.8 / 14.8 /
   14.5 m at 0.6 / 0.9 / 1.4). Take the SMALLEST saturating value: the sink is
   in CELLS and a cell is r/SK_K, so 1.4 would drop the 2400 m rim by ~134 m for
   nothing measurable. Punch-through falls 471 -> 308 px (0.0042% of frame)
   going 0.35 -> 0.6, against 4.36% of frame of real gap fill. */
const SK_SINK = 0.6;    // sink, in units of the local cell size

/* ...but the sink MUST BE CAPPED IN ABSOLUTE METRES, and that cap is what the
   0.6 sweep above could not see. A cell is r/SK_K, so 0.6 cells is 0.024*r:
   0.96 m at 40 m but 24 m at 1 km and 57.6 m at the 2400 m rim. That does not
   open a hole (the skirt is a full annulus) - it DROPS THE HORIZON, so a strip
   of sky dome shows where mountain belongs. MEASURED offline (horizon elevation
   angle of the true surface vs the drawn one, converted to px at fov 84 / 1838
   px, positive control = a 200 m sink, which correctly reads 27-128 px and
   correctly reads 0 wherever the CORE owns the horizon): the shipped uncapped
   sink loses 18-31 px of mountain height at yaw 40-180, and capping at 3 m
   takes that to -1..12 px, which is the no-sink floor of 4-7 px plus noise.
   3.0 m is reached at exactly r = 125 m, and everything the 0.6 sweep measured
   (the seam at ~78 m, punch-through over 78-200 m) is inside that radius, so
   the near field is BIT-IDENTICAL to the shipped build and only the far field
   rises back toward the true surface. Straight-downhill views measure 0 either
   way - there the near ridge owns the horizon, which is why this only showed in
   a yawed view. */
const SK_SINK_MAX = 3.0;   // metres; caps the sink beyond r = SK_SINK_MAX*SK_K/SK_SINK

const SK_NS = Math.ceil(2 * Math.PI * SK_K);   // sectors for square cells (158)

const SKIRT_VERT = `
  attribute vec4 aMat; attribute float aLat; attribute float aCell;
  uniform vec3 uSkOff;          // skirtOrigin - terrainOrigin
  uniform float uSkSink;        // sink, in units of the local cell
  uniform float uSkSinkMax;     // absolute cap on that sink, in metres
  varying vec3 vN, vW; varying vec4 vM; varying float vLat;
  varying float vAO; varying float vPromo;
  void main(){
    vN = normal; vM = aMat; vLat = aLat; vAO = 1.0; vPromo = 0.0;
    /* uSkOff rebases the static, world-anchored position buffer into the
       CORE's local frame, which is the frame SNOW_FRAG reconstructs world
       from (wp = vW + uOrg). Emitting vW in that frame is what lets this mesh
       share the core's fragment shader untouched. */
    vec3 p = position + uSkOff;
    p.y -= min(uSkSink * aCell, uSkSinkMax);
    vW = p;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(vW, 1.0);
  }`;

/* SNOW_FRAG VERBATIM. Not a copy, not a patched string - the same code object
   the mountain uses, so the skirt cannot drift from it the way the wake's
   private copy of the BRDF did (phase 8). Every varying it reads is supplied
   above; every uniform it reads comes from the shared terr.uni by reference. */
const SKIRT_FRAG = SNOW_FRAG;

class TerrainSkirt {
  constructor(scene, terr) {
    this.terr = terr;
    this.ok = false;

    /* ---- radii: geometric, so the cell stays r/SK_K at every ring -------- */
    const rs = [];
    for (let r = SK_R0; r < SK_R1; r *= 1 + 1 / SK_K) rs.push(r);
    rs.push(SK_R1);
    this.rs = rs;
    const NR = rs.length, NV = NR * SK_NS;
    this.NR = NR; this.NV = NV;

    /* ---- static index buffer, wrapping in theta -------------------------- */
    const idx = new (NV > 65535 ? Uint32Array : Uint16Array)((NR - 1) * SK_NS * 6);
    let t = 0;
    for (let i = 0; i < NR - 1; i++) {
      const a = i * SK_NS, b = a + SK_NS;
      for (let s = 0; s < SK_NS; s++) {
        const s1 = (s + 1) % SK_NS;
        idx[t++] = a + s; idx[t++] = b + s;  idx[t++] = b + s1;
        idx[t++] = a + s; idx[t++] = b + s1; idx[t++] = a + s1;
      }
    }

    this.pos  = new Float32Array(NV * 3);
    this.nrm  = new Float32Array(NV * 3);
    this.mat4 = new Float32Array(NV * 4);
    this.lat  = new Float32Array(NV);
    this.cell = new Float32Array(NV);
    /* scratch: a resample is SLICED across frames, so it must not be visible
       until it is complete or the mesh would be half on the old origin. */
    this.posN = new Float32Array(NV * 3);
    this.nrmN = new Float32Array(NV * 3);
    this.matN = new Float32Array(NV * 4);
    this.latN = new Float32Array(NV);

    /* unit direction per sector, so the hot loop is two multiplies */
    this.cs = new Float32Array(SK_NS); this.sn = new Float32Array(SK_NS);
    for (let s = 0; s < SK_NS; s++) {
      const a = s * 2 * Math.PI / SK_NS;
      this.cs[s] = Math.cos(a); this.sn[s] = Math.sin(a);
    }
    for (let i = 0; i < NR; i++) {
      const c = rs[i] / SK_K;
      for (let s = 0; s < SK_NS; s++) this.cell[i * SK_NS + s] = c;
    }

    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3);
    this.aNrm = new THREE.BufferAttribute(this.nrm, 3);
    this.aMat = new THREE.BufferAttribute(this.mat4, 4);
    this.aLat = new THREE.BufferAttribute(this.lat, 1);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aNrm.setUsage(THREE.DynamicDrawUsage);
    this.aMat.setUsage(THREE.DynamicDrawUsage);
    this.aLat.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('normal',   this.aNrm);
    g.setAttribute('aMat',     this.aMat);
    g.setAttribute('aLat',     this.aLat);
    g.setAttribute('aCell',    new THREE.BufferAttribute(this.cell, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
    this.geo = g;

    /* shares terr.uni BY REFERENCE, exactly like the fine patch: every
       per-frame write the game already makes (uSun, uFogD, uCam, uPxK, the
       cascades, the tonemap) reaches this material for free. */
    this.uni = Object.assign({}, this.terr.uni, {
      uSkOff: { value: new THREE.Vector3() },
      uSkSink: { value: SK_SINK },
      uSkSinkMax: { value: SK_SINK_MAX } });
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uni, vertexShader: SKIRT_VERT, fragmentShader: SKIRT_FRAG });

    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = -1;      // behind the core, so its depth lands first
    this.sOrg = new THREE.Vector3(0, 0, 0);
    this.nOrg = new THREE.Vector3(0, 0, 0);
    this.ring = 0;                   // next ring to resample (NR = idle)
    this.building = false;
    scene.add(this.mesh);
  }

  /* Sample rings [i0, i1) of the pending pass. ONE terr.surf call per vertex,
     at the vertex's OWN cell size, so each ring is band-limited to what it can
     represent - that is what keeps a 96 m cell from aliasing the ridge noise.
     Normals are NOT sampled here: doing them by central difference would cost
     four more surf calls per vertex (a 5x cost, ~49 ms a pass), and the core
     itself does not do that either - it reads its neighbours (rowH). */
  _rings(i0, i1) {
    const { rs, cs, sn, nOrg } = this, S = this.terr;
    const ox = nOrg.x, oz = nOrg.z, oy = nOrg.y;
    for (let i = i0; i < i1; i++) {
      const r = rs[i], res = r / SK_K;
      for (let s = 0; s < SK_NS; s++) {
        const dx = cs[s] * r, dz = sn[s] * r;
        const q = S.surf(ox + dx, oz + dz, res);
        const k = i * SK_NS + s, k3 = k * 3, k4 = k * 4;
        this.posN[k3] = dx; this.posN[k3 + 1] = q.h - oy; this.posN[k3 + 2] = dz;
        this.matN[k4] = q.groom; this.matN[k4 + 1] = q.ice;
        this.matN[k4 + 2] = 0;   this.matN[k4 + 3] = 999;   // no poach line out here
        this.latN[k] = q.lat;
      }
    }
  }

  /* Normals from the sampled lattice itself, by crossing the radial and
     tangential tangents. This describes the surface WE ACTUALLY DREW rather
     than a finer one we did not sample, so the shading cannot disagree with
     the silhouette. Pure array maths over ~16 k vertices - no surf calls. */
  _normals() {
    const P = this.posN, N = this.nrmN, NR = this.NR, NS = SK_NS;
    for (let i = 0; i < NR; i++) {
      const im = Math.max(0, i - 1), ip = Math.min(NR - 1, i + 1);
      for (let s = 0; s < NS; s++) {
        const a = ((i * NS + s)) * 3;
        const rp = (ip * NS + s) * 3, rm = (im * NS + s) * 3;
        const tp = (i * NS + (s + 1) % NS) * 3, tm = (i * NS + (s + NS - 1) % NS) * 3;
        const ux = P[rp] - P[rm], uy = P[rp + 1] - P[rm + 1], uz = P[rp + 2] - P[rm + 2];
        const vx = P[tp] - P[tm], vy = P[tp + 1] - P[tm + 1], vz = P[tp + 2] - P[tm + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }   // orient upward
        const il = 1 / (Math.hypot(nx, ny, nz) || 1);
        N[a] = nx * il; N[a + 1] = ny * il; N[a + 2] = nz * il;
      }
    }
  }

  /* Called once per frame from the game loop. Cheap unless a pass is running. */
  update(px, pz) {
    const S = this.terr;
    /* ride the CORE's origin: the material reconstructs world as vW + uOrg, so
       the mesh transform and the rebase offset must both be relative to it. */
    this.mesh.position.copy(S.org);
    this.mesh.updateMatrix();
    this.uni.uSkOff.value.set(
      this.sOrg.x - S.org.x, this.sOrg.y - S.org.y, this.sOrg.z - S.org.z);

    if (!this.building) {
      const dx = px - this.sOrg.x, dz = pz - this.sOrg.z;
      if (!this.ok || dx * dx + dz * dz > SK_STEP * SK_STEP) {
        this.nOrg.set(px, 0, pz);
        this.nOrg.y = S.org.y;
        this.building = true; this.ring = 0;
      }
    }
    if (!this.building) return;

    const i1 = Math.min(this.NR, this.ring + (this.ok ? SK_SLICE : this.NR));
    this._rings(this.ring, i1);
    this.ring = i1;
    if (this.ring < this.NR) return;

    this._normals();
    this.pos.set(this.posN); this.nrm.set(this.nrmN);
    this.mat4.set(this.matN); this.lat.set(this.latN);
    this.aPos.needsUpdate = this.aNrm.needsUpdate = true;
    this.aMat.needsUpdate = this.aLat.needsUpdate = true;
    this.sOrg.copy(this.nOrg);
    this.uni.uSkOff.value.set(
      this.sOrg.x - S.org.x, this.sOrg.y - S.org.y, this.sOrg.z - S.org.z);
    this.building = false; this.ok = true;
  }

  info() {
    return { verts: this.NV, tris: this.geo.index.count / 3, rings: this.NR,
      sectors: SK_NS, r0: SK_R0, r1: SK_R1, k: SK_K,
      sink: this.uni.uSkSink.value, sinkMax: this.uni.uSkSinkMax.value,
      visible: this.mesh.visible, ok: this.ok, building: this.building,
      sOrg: [+this.sOrg.x.toFixed(1), +this.sOrg.z.toFixed(1)] };
  }
}
