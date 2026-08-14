/* ---------------------------------------------------------------- fine patch
   A 0.25 m grid that fills the rectangle terrain_mesh.js cut out of the
   clipmap. Everything it draws it reads from the structural grid, so it is a
   REFINEMENT of the coarse surface, never a second opinion about it:

   - height is structH(), which at a coarse lattice point returns that coarse
     vertex's height exactly, and along a coarse cell edge is exactly the linear
     interpolation the rasteriser was already doing. So the join has no crack and
     needs no skirt.
   - the normal is structN() at the GRID step, which is the same central
     difference the coarse normals pass takes over the same lattice - so the
     boundary has no shading seam either.
   - state (groom / ice / poach / lat / ao) is bilinear over the same texels the
     coarse vertices were filled from.

   With nothing promoted yet that makes the patch a visual no-op, which is the
   whole point of phase 2: the refinement lands first and provably changes
   nothing, then phase 3 promotes relief octaves into real displacement and phase
   4 adds the deformation buffer, both of which only have to taper to zero at the
   rectangle edge to stay crack-free.

   Cost: 241 x 265 = 63,865 vertices and 126,720 triangles, against the 990
   coarse cells (1,980 triangles) removed; measured +0.34 ms GPU median at a
   frozen tier-3 viewpoint. No CPU per-frame work beyond two uniforms - the
   vertex grid is a constant template and the displacement is a texture fetch. */
class FinePatch {
  constructor(scene, terr) {
    this.terr = terr;
    this.fineScene = scene;
    this.ok = FP_OK;
    if (!FP_OK) { console.warn('FinePatch: rectangle does not fit the structural band, disabled'); return; }
    this.step = FP_STEP;
    this.build(FP_STEP, scene);
  }

  /* The grid is a pure function of the step, and the HOLE does not depend on the
     step at all (it is defined by the rectangle), so the step is free to sweep at
     runtime - which is the only honest way to price a density. */
  build(step, scene) {
    if (SNAP % step !== 0) { console.warn('FinePatch: step must divide', SNAP); return; }
    if (this.mesh) { (scene || this.mesh.parent).remove(this.mesh); this.geo.dispose(); }
    this.step = step;
    const nx = Math.round(2 * FP_HW / step) + 1, nz = Math.round((FP_Z1 - FP_Z0) / step) + 1, n = nx * nz;
    /* local template: x,z are the patch's own offsets, y is unused (the vertex
       shader displaces from the grid). Constant for the life of the mesh. */
    const pos = new Float32Array(n * 3);
    for (let jz = 0; jz < nz; jz++) {
      for (let ix = 0; ix < nx; ix++) {
        const k = (jz * nx + ix) * 3;
        pos[k] = ix * step; pos[k + 1] = 0; pos[k + 2] = jz * step;
      }
    }
    /* same winding convention as the clipmap's 1:1 branch: a, c, b then b, c, d */
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let q = 0;
    for (let jz = 0; jz < nz - 1; jz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = jz * nx + ix, b = a + 1, c = a + nx, d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
    this.geo = g;
    this.tris = q / 3; this.verts = n; this.nx = nx; this.nz = nz;
    /* shares terr.uni BY REFERENCE (a shallow copy, so every per-frame write to
       a uniform's .value reaches both materials), plus the patch's own origin */
    this.uni = this.uni || Object.assign({}, this.terr.uni, {
      uPatchO: { value: this.terr.patchO },
      uPatchSpan: { value: new THREE.Vector2(2*FP_HW, FP_Z1 - FP_Z0) } });
    this.mat = this.mat || new THREE.ShaderMaterial({
      uniforms: this.uni,
      vertexShader: GLSL_STRUCT + GLSL_PROMO + GLSL_DEFORM + `
        uniform vec3 uOrg; uniform vec2 uPatchO;   // uStrK comes from GLSL_STRUCT
        uniform vec2 uPatchSpan;                   // the rectangle, for the rim taper
        varying vec3 vN, vW; varying vec4 vM; varying float vLat; varying float vAO;
        varying float vPromo;
        void main(){
          vec2 l = position.xz + uPatchO;      // terrain-local xz
          vec2 w = l + uOrg.xz;                // world xz
          float wy = structH(w);
          vec3 N = structN(w, uStrK.z);
          vec4 A = structA(w), B = structB(w);
          vM = A; vLat = B.x; vAO = B.y;
          /* Rim taper: promotion must reach exactly 0 at the rectangle edge, or
             the patch stops agreeing with the coarse mesh it is stitched into and
             the crack-free join (measured worst 0) is lost. Fades over the outer
             TAPER metres, measured on the patch's own template coords. */
          const float TAPER = 1.75;
          vec2 e = min(position.xz, uPatchSpan - position.xz);   // distance to nearest edge
          float taper = smoothstep(0.0, TAPER, min(e.x, e.y));
          float promo = uPromo * taper;
          vPromo = promo;
          if(promo > 0.0009){
            /* loose from groom/ice only - the fragment cancels with the same
               simplified weight, so geometry and shading cannot disagree. */
            float loose = (1.0 - A.x)*(1.0 - A.y);
            vec3 hg = snowReliefPromo(vec3(w.x, wy, w.y), N, loose);
            wy += promo*hg.x;
            /* the normal must follow the geometry we just made, or the promoted
               shape is displaced but still shaded as though it were flat */
            vec2 gp = promo*hg.yz;
            N = normalize(vec3(N.x/max(N.y,0.30) - gp.x, 1.0, N.z/max(N.y,0.30) - gp.y));
          }
          vN = N;
          /* The deformation, at 25 cm cells instead of the coarse mesh's 2 m.
             CONFORMING RIM. deformH is a ~6 cm texture fetch, so unlike structH
             it is NOT linear along a coarse edge. The coarse mesh joins this
             patch with straight 2 m edges, so an exact fetch at a rim vertex
             that lies BETWEEN two coarse vertices tears the seam by up to the
             full rut depth (measured worst 0.50 m where a trench crosses a rim).
             Inside the outermost coarse cell we therefore blend to the value the
             coarse mesh interpolates: bilinear over the 2 m lattice, which ON a
             lattice line collapses exactly to the coarse edge's linear
             interpolation - so the join is watertight BY CONSTRUCTION, not by
             tuning. Fades to the exact 25 cm shape over one cell, and at a
             lattice point conform == exact, so the corners need no special case.
             Note the fragment still shades from the exact deformGrad in that
             band; the coarse mesh has the same geometry-vs-shading resolution
             gap inherently, so the two sides stay consistent with each other. */
          float P = uStrK.z;
          vec2 e2 = min(position.xz, uPatchSpan - position.xz);
          float dr = min(e2.x, e2.y);
          float dfE = deformH(w);
          if (dr < P) {
            vec2 lat = floor(w/P)*P;
            vec2 fr = (w - lat)/P;
            float d00 = deformH(lat),              d10 = deformH(lat + vec2(P, 0.0));
            float d01 = deformH(lat + vec2(0.0,P)), d11 = deformH(lat + vec2(P, P));
            float dfC = mix(mix(d00, d10, fr.x), mix(d01, d11, fr.x), fr.y);
            dfE = mix(dfC, dfE, smoothstep(0.0, P, dr));
          }
          wy += dfE;
          vW = vec3(l.x, wy - uOrg.y, l.y);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(vW, 1.0);
        }`,
      fragmentShader: SNOW_FRAG
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    (scene || this.terr.fineScene).add(this.mesh);
    this.fineScene = scene || this.terr.fineScene;
    this.update();
  }

  /* the patch rides the same local origin as the clipmap, so its transform is
     the clipmap's transform; uPatchO already points at terr.patchO by reference */
  update() {
    if (!this.ok) return;
    this.mesh.position.copy(this.terr.org);
    this.mesh.updateMatrix();
  }

  setVisible(v) { if (this.ok) this.mesh.visible = v !== false; return this.ok && this.mesh.visible; }

  info() {
    return {
      ok: this.ok, step: this.step, halfWidth: FP_HW, z0: FP_Z0, z1: FP_Z1,
      nx: this.nx, nz: this.nz, verts: this.verts, tris: this.tris,
      rows: [FPJ0, FPJ1], cells: FP_CI,
      holeTris: (this.terr.idxCountFull - this.terr.idxCount) / 3,
      visible: this.ok ? this.mesh.visible : false, hole: this.terr._hole
    };
  }
}
