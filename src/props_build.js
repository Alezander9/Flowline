/* ------------------------------------------- buildings: cabin, base lodge */

/* A building gets ONE height sample at its centre, but the ground under a
   7x9m footprint on this mountain drops a long way: MEASURED at the seg-6
   cabin, the four corners sat +2.19 / -1.41 / +1.91 / -1.61 m relative to its
   floor, a 3.8m spread. So one side buried itself in the hill and the other
   hung in the air - the "floating cabin". The floor is now seated part-way up
   the slope (uphill corner buries into the hill, which is invisible) and the
   downhill gap is covered by a foundation plinth, which is what an alpine
   building on a slope actually has. `drop` is that spread, from the placer.
   THE PLINTH IS HARD-CAPPED at 1.4m. Seating on the HIGHEST corner and giving
   the plinth the full drop was tried first and is much worse: on a 4.3m drop it
   built a 4.6m dark tower taller than the cabin itself, and since the median
   cabin is only 11px tall on screen that reads as a dark blob. */
const STONE = [0.185, 0.180, 0.178], STONE2 = [0.225, 0.215, 0.205];
function plinth(w, d, drop, parts) {
  if (!(drop > 0.05)) return;
  const t = Math.min(drop * 0.85 + 0.25, 1.4);
  parts.push(box(w * 0.97, t, d * 0.97, 0, -t / 2 + 0.06, 0, STONE));
  // a course of lighter stone at the top so the plinth reads as masonry, not a shadow
  parts.push(box(w * 1.01, 0.18, d * 1.01, 0, -0.07, 0, STONE2));
}
/* A gable roof whose slabs actually MEET the walls and each other.
   The old code wrote `g.rotateZ(s * pitch)`, which is the wrong sign: rotateZ
   maps local +x to (cos a, sin a), so the +x slab ROSE as x grew and the roof
   came out as an upward-opening valley with its low point over the middle of
   the house. MEASURED on the shipped build: the slab's underside at the eave
   sat 1.60m ABOVE the wall top at every cabin size (2.94m on the lodge), which
   is the reported "roof slabs floating above the wall, V-gap at the ridge".
   Here each slab runs from the ridge DOWN to the eave, overshoots the ridge by
   OR so the two slabs interpenetrate instead of leaving a seam, overhangs the
   eave by `over`, and meets the wall below its top so there is no gap to see.
   Returns the ridge height and a top(x) so a chimney can pierce it correctly. */
function gableRoof(parts, w, d, h, rise, over, thick, col) {
  const half = w * 0.52, pitch = Math.atan2(rise, half), rl = Math.hypot(half, rise);
  const cp = Math.cos(pitch), sp = Math.sin(pitch), OR = thick * 0.45;
  const eaveY = h - thick * 0.45, ridgeY = eaveY + rise;
  for (const s of [-1, 1]) {
    const g = BOXG.clone().scale(rl + OR + over, thick, d + over * 2.2);
    g.rotateZ(-s * pitch);
    g.translate(s * (half + (over - OR) * cp) / 2, (ridgeY + eaveY) / 2 - (over - OR) * sp / 2, 0);
    parts.push(geoColor(g, flat(col)));
  }
  // ridge cap over the seam - snow-valued like the slabs, so it reads as solid roof
  parts.push(box(thick * 1.9, thick * 1.15, d + over * 2.3, 0, ridgeY + thick * 0.6, 0,
    [col[0] * 0.96, col[1] * 0.96, col[2] * 0.96]));
  return { ridgeY, eaveY, half, rise, over, thick, cp,
    top: x => eaveY + (1 - Math.min(1, Math.abs(x) / half)) * rise + thick * 0.5 / cp };
}
/* PB4 - THE ROOF IS A ONE-WAY PLATFORM (consumed by World.platAt).
   Alexander could clear a cabin on a jump and drop straight through it: nothing
   in the game had collision except terrain features, trees and rocks.
   The descriptor is derived from the SAME numbers gableRoof() built the slabs
   from, so the surface you land on cannot drift from the surface you see - the
   lesson from the chairlift, where static geometry and the per-frame tick each
   computed tower height and every chair stepped at a tower. It is attached to
   the GEOMETRY so put() can copy it onto the mesh with no signature change.
     top(lx) = base + (1 - min(1,|lx|/half)) * rise    [local frame, ridge at lx=0]
   hz uses over*1.1 because the slabs are d + over*2.2 deep. */
function roofPlat(roof, d) {
  return { half: roof.half, rise: roof.rise, sl: roof.rise / roof.half,
    base: roof.eaveY + roof.thick * 0.5 / roof.cp,
    hx: roof.half + roof.over, hz: d / 2 + roof.over * 1.1 };
}
/* THE GABLE ENDS WERE OPEN. The walls are one box of height h and the roof sits
   on top of it, so the triangle between the wall top and the ridge was simply
   MISSING at both ends: from any end-on view you looked straight through the
   hole at the flat top face of the wall box, i.e. into a roofless attic. It is
   the same class of defect as the inverted roof - a join nobody checked - and it
   shows at the cabin's p90 of 45 px, let alone the 327 px you get passing one at
   18 m. Filled here with 2 triangles per end (4 tris total).
   The base sits at the roof's eave height, NOT at the wall top, so the slabs
   overlap it and there is no seam to see; the apex runs to the ridge, where the
   ridge cap swallows it. Inset 3 cm so the part below the wall top is inside the
   wall box instead of z-fighting with its end face. The apex vertex is shaded
   darker: a gable is in the roof's shadow up near the ridge, and per-vertex
   colour is free here (pushTri takes one colour per corner). */
function gableEnds(parts, w, d, h, rise, thick, col) {
  const half = w / 2, eaveY = h - thick * 0.45, ridgeY = eaveY + rise;
  const zf = d / 2 - 0.03, apex = cmul(col, 0.72), B = TriBuf();
  //                       winding is CCW seen from the FRONT of each face
  pushTri(B, [-half, eaveY, zf], [half, eaveY, zf], [0, ridgeY, zf], col, col, apex);
  pushTri(B, [half, eaveY, -zf], [-half, eaveY, -zf], [0, ridgeY, -zf], col, col, apex);
  parts.push(bufGeo(B));
}
/* A chimney has to START INSIDE THE HOUSE and pierce the roof. The old one was
   placed at a fixed `h + 1.9`, which left its base floating 0.33m above the
   roof surface - the reported "detached chimney". */
function chimney(parts, roof, x, z, wide, deep, up, col, capCol) {
  const top = roof.top(x) + up, bot = Math.min(roof.eaveY - 0.9, top - 1.1);
  parts.push(box(wide, top - bot, deep, x, (top + bot) / 2, z, col));
  parts.push(box(wide * 1.22, 0.14, deep * 1.22, x, top + 0.07, z, capCol));
}
/* alpine cabin */
function cabinGeo(seed, drop) {
  const rnd = mulberry32(seed);
  const w = 5 + rnd() * 3, d = 4.5 + rnd() * 2.5, h = 2.7 + rnd() * 0.8;
  const wood = [0.26, 0.17, 0.115], wood2 = [0.33, 0.22, 0.145];
  const parts = [box(w, h, d, 0, h / 2, 0, wood)];
  const roof = gableRoof(parts, w, d, h, 1.7, 0.40, 0.28, [1.02, 1.04, 1.10]);
  gableEnds(parts, w, d, h, 1.7, 0.28, wood2);
  chimney(parts, roof, w * 0.28, d * 0.2, w * 0.02 + 0.5, 0.5, 0.95,
    [0.30, 0.30, 0.33], [0.245, 0.245, 0.275]);
  for (let i = 0; i < 2; i++) parts.push(box(0.9, 0.75, 0.09, -w * 0.22 + i * w * 0.44, h * 0.58, d / 2 + 0.02, [1.6, 1.15, 0.55]));
  parts.push(box(w * 0.9, 0.16, 1.6, 0, 0.18, d / 2 + 0.7, wood2));
  // firewood stack
  parts.push(box(1.2, 0.7, 0.7, -w / 2 - 0.5, 0.35, 0, [0.34, 0.24, 0.16]));
  plinth(w, d, drop, parts);
  /* PB9: walls stop at the eave, so the roof platform above still owns the
     landing. The porch slab and the firewood stack stick out past the wall box
     and stay non-solid on purpose - they are ankle-height clutter, not walls. */
  const g = mergeGeos(parts); g.userData.plat = roofPlat(roof, d);
  g.userData.col = pcWalls(w, d, roof); return g;
}
/* the base lodge */
function lodgeGeo(drop) {
  const wood = [0.30, 0.20, 0.135];
  const parts = [box(15, 4.4, 9, 0, 2.2, 0, wood)];
  const roof = gableRoof(parts, 15, 9, 4.4, 2.8, 0.70, 0.34, [1.02, 1.05, 1.12]);
  gableEnds(parts, 15, 9, 4.4, 2.8, 0.34, [0.37, 0.25, 0.165]);
  for (let i = 0; i < 5; i++) parts.push(box(1.5, 1.3, 0.1, -5.6 + i * 2.8, 2.5, 4.55, [1.7, 1.22, 0.58]));
  parts.push(box(16, 0.2, 3.6, 0, 0.35, 6.4, [0.36, 0.25, 0.17]));
  chimney(parts, roof, 5.2, 0, 1.1, 1.1, 1.5, [0.32, 0.32, 0.35], [0.26, 0.26, 0.29]);
  for (let i = 0; i < 4; i++) parts.push(box(0.16, 1.0, 0.16, -6 + i * 4, 0.9, 8.1, [0.28, 0.2, 0.14]));
  plinth(15, 9, drop, parts);
  const g = mergeGeos(parts); g.userData.plat = roofPlat(roof, 9);
  g.userData.col = pcWalls(15, 9, roof); return g;      // PB9, see cabinGeo
}
