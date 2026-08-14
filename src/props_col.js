/* ------------------------------------- PB9: solid props (side collision) --
   Before this, the ONLY things in the world you could not ride through were
   terrain features, streamed trees and streamed boulders (props_build.js:52).
   Buildings were half-solid: PB4 made their roofs one-way platforms you can
   land on and slide off, but deliberately left the walls open so the change
   could not put an invisible wall on the piste. The result Alexander reported
   is that you phase through the side of a cabin and through gondola towers.

   A descriptor lives on the GEOMETRY (put() copies it to the mesh, exactly as
   userData.plat works) or directly on a Group, and is derived from the SAME
   constants the geometry was built from - the props_build.js:53 lesson, so the
   wall you hit cannot drift from the wall you see.

   Shapes are in the OBJECT'S LOCAL FRAME, in metres, and SCALE IS IGNORED:
   every producer either has scale 1, or passes world-metre numbers (the
   segment rock cluster computes its radius from `sc` exactly as the streamed
   boulders do at props_world.js:739, which is also what makes the two kinds of
   rock finally behave the same).
     {c:0, x, z, hx, hz, top}  box, OBB about local +x/+z, solid for |lx|<=hx
     {c:1, x, z, r,      top}  cylinder about local (x,z)
   Both are implicitly INFINITE DOWNWARDS, like the obstacle cylinders.

   `top` is the local y of the collidable top, and it is what keeps the roof
   working: a wall stops at the EAVE, so everything above it belongs to
   World.platAt and landing on a roof can never be read as hitting a wall.
   Same 0.30 m of forgiveness as the tree/rock cylinders (rider2.js:118), so
   clipping the top 30 cm of a wall drops you onto the roof instead of
   killing you. */
const PC_FORGIVE = 0.30;

/* Response table. sev = sev0 + speed*sevK, fed to Rider.hit, which wipes you
   out when it reaches your balance (1.0 from full). mul is the speed kept
   after the impact.
   Buildings are meant to TAKE YOU OUT (Alexander): 0.55 + 0.075*sp reaches 1.0
   at 6 m/s, so anything above a crawl is a wipeout, while walking into a wall
   at 3 m/s is a hard stop and a stumble rather than an instant run reset.
   The big park board is graded like a tree instead - it is a signboard, not a
   building, so it is survivable at moderate speed. Small trail signs, piste
   flags, park markers, cables and chairs stay non-solid by design. */
const PC_KIND = {
  build: { sev0: 0.55, sevK: 0.075, mul: 0.35, why: 'hit a building' },
  shed:  { sev0: 0.55, sevK: 0.075, mul: 0.35, why: 'hit the lift terminal' },
  tower: { sev0: 0.50, sevK: 0.070, mul: 0.45, why: 'hit a lift tower' },
  gate:  { sev0: 0.50, sevK: 0.070, mul: 0.45, why: 'hit the start gate' },
  sign:  { sev0: 0.22, sevK: 0.034, mul: 0.62, why: 'clipped a sign' },
  rock:  { sev0: 0.20, sevK: 0.040, mul: 0.55, why: 'clipped a rock' }
};

function pcBox(hx, hz, top, x, z) { return { c: 0, x: x || 0, z: z || 0, hx, hz, top }; }
function pcCyl(x, z, r, top) { return { c: 1, x, z, r, top }; }
/* `reach` is the L1 pre-reject bound: the largest |x|+|z| + extent of any part,
   so one cheap test per PROP rejects every part of it. */
function pcMake(kind, parts) {
  const K = PC_KIND[kind];
  let reach = 0;
  for (const P of parts) {
    const e = P.c === 1 ? P.r : P.hx + P.hz;
    reach = Math.max(reach, Math.abs(P.x) + Math.abs(P.z) + e);
  }
  return { kind, parts, reach, sev0: K.sev0, sevK: K.sevK, mul: K.mul, why: K.why };
}
/* A building's walls, from the numbers gableRoof() used. Stops at the eave. */
function pcWalls(w, d, roof) { return pcMake('build', [pcBox(w * 0.5, d * 0.5, roof.eaveY)]); }

/* World-space query, mirroring World.platAt (props_world.js:1080): brute force
   over the live segment entries, an L1 pre-reject, then world->local by the
   object's yaw so rotation.y is honoured. Reads o.position LIVE because
   regroundSegs() moves every prop's y every frame.
   Returns the DEEPEST penetration, so a rider wedged at the corner of two
   parts is pushed out of the one that actually has to move him. */
function propHitIn(segGroups, x, z, y, R, out) {
  let best = null, bestPen = 0;
  for (const [, e] of segGroups) {
    for (const o of e.cols) {
      const C = o.userData.col;
      const dx = x - o.position.x, dz = z - o.position.z;
      if (Math.abs(dx) + Math.abs(dz) > C.reach + R) continue;
      const a = o.rotation.y, ca = Math.cos(a), sa = Math.sin(a);
      const lx = ca * dx - sa * dz, lz = sa * dx + ca * dz;
      for (const P of C.parts) {
        if (y > o.position.y + P.top - PC_FORGIVE) continue;   // cleared it
        const ex = lx - P.x, ez = lz - P.z;
        let nx = 0, nz = 0, pen = 0;
        if (P.c === 1) {
          const d = Math.hypot(ex, ez);
          pen = P.r + R - d; if (pen <= 0) continue;
          /* dead centre of the cylinder gives NO direction. `1/(d||1e-4)` looks
             like it handles it but yields nx = 0*1e4 = 0, i.e. a ZERO push-out
             that silently fails to depenetrate - measured as n:[0,0] probing a
             tower axis. Any unit direction is correct here; none is not. */
          if (d > 1e-6) { const iv = 1 / d; nx = ex * iv; nz = ez * iv; }
          else { nx = 1; nz = 0; }
        } else {
          const gx = ex - clamp(ex, -P.hx, P.hx), gz = ez - clamp(ez, -P.hz, P.hz);
          const d = Math.hypot(gx, gz);
          if (d > 1e-6) {
            pen = R - d; if (pen <= 0) continue;
            const iv = 1 / d; nx = gx * iv; nz = gz * iv;
          } else {
            /* centre is INSIDE the footprint - only reachable by tunnelling or
               by a building being regrounded onto you. Push out of the nearest
               face, never leave him inside. */
            const ox = P.hx - Math.abs(ex), oz = P.hz - Math.abs(ez);
            if (ox < oz) { nx = ex < 0 ? -1 : 1; pen = ox + R; }
            else { nz = ez < 0 ? -1 : 1; pen = oz + R; }
          }
        }
        if (pen <= bestPen) continue;
        bestPen = pen;
        out.nx = ca * nx + sa * nz; out.nz = -sa * nx + ca * nz;   // local -> world
        out.pen = pen; out.C = C; out.o = o;
        best = out;
      }
    }
  }
  return best;
}
