/* =========================================== rider: parametric geometry kit
   Everything is swept cross-sections (superellipse rings along a path), welded
   and indexed, so the silhouette is a real curve and vertices are shared
   instead of tripled. Each vertex carries a bone hint: null means "solve
   weights from the skeleton", a number means "rigid to this bone". */

class GeoBuf {
  constructor() {
    this.pos = []; this.nor = []; this.col = []; this.uv = []; this.idx = [];
    this.hint = [];          // per vertex: null (skin) or bone index (rigid)
    this.regs = [];          // per vertex: which bones may influence it
    this.reg = null;         // current region, set before adding a part
  }
  get count() { return this.pos.length / 3; }
  vert(p, n, c, u, hint) {
    this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z);
    this.col.push(c[0], c[1], c[2]); this.uv.push(u[0], u[1]);
    this.hint.push(hint === undefined ? null : hint);
    this.regs.push(this.reg);
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  /* stitch two open rings of R verts (same winding) into a closed joint */
  bridge(r0, r1, R) {
    for (let i = 0; i < R; i++) { const j = (i + 1) % R; this.quad(r0 + i, r0 + j, r1 + j, r1 + i); }
  }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  /* duplicate a ring, keeping position/normal/colour but giving it disc UVs.
     A cap fan built off the tube ring has ONE v across the whole cap, so it
     samples a single row of the fabric texture - a quilt line smears over the
     entire cap as a bright patch. Disc UVs give the cap real texture. */
  capRing(ringStart, R, at, du, hint) {
    const s0 = this.count, v = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < R; i++) {
      const k = ringStart + i, th = i / R * TAU;
      v.set(this.pos[k * 3], this.pos[k * 3 + 1], this.pos[k * 3 + 2]);
      n.set(this.nor[k * 3], this.nor[k * 3 + 1], this.nor[k * 3 + 2]);
      this.vert(v, n, [this.col[k * 3], this.col[k * 3 + 1], this.col[k * 3 + 2]],
        [0.5 + Math.cos(th) * du, at + Math.sin(th) * du], hint);
    }
    return s0;
  }

  /* merge an existing (indexed or not) geometry, transformed, single colour */
  addGeo(g, m, col, hint, uv) {
    const src = g.index ? g : g.toNonIndexed();
    const p = src.attributes.position, n = src.attributes.normal;
    const base = this.count;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3(), nv = new THREE.Vector3();
    const hasCol = !!src.attributes.color;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      nv.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      const c = hasCol
        ? [src.attributes.color.getX(i), src.attributes.color.getY(i), src.attributes.color.getZ(i)]
        : col;
      this.vert(v, nv, c, uv || NEUTRAL_UV, hint);
    }
    if (src.index) { const ix = src.index.array; for (let i = 0; i < ix.length; i++) this.idx.push(base + ix[i]); }
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    return base;
  }

  /* interpolate a profile table [t, halfRef, halfSide, squareness, col] */
  static profAt(prof, t) {
    let i = 0;
    while (i < prof.length - 2 && prof[i + 1][0] < t) i++;
    const a = prof[i], b = prof[Math.min(i + 1, prof.length - 1)];
    const s = b[0] > a[0] ? clamp((t - a[0]) / (b[0] - a[0]), 0, 1) : 0;
    const L = (p, q) => p + (q - p) * s;
    const ca = a[4], cb = b[4] || a[4];
    return [L(a[1], b[1]), L(a[2], b[2]), L(a[3] ?? 0.25, b[3] ?? 0.25),
      ca ? [L(ca[0], cb[0]), L(ca[1], cb[1]), L(ca[2], cb[2])] : null];
  }

  /* sweep a cross-section along an arbitrary polyline: one continuous, welded
     tube, so limbs have no seam ring at the joints and straps can curve. */
  addPath(o) {
    const { pts, prof, R = 12, col } = o;
    const n = pts.length;
    const len = [0];
    for (let i = 1; i < n; i++) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = len[n - 1] || 1;
    const ref0 = (o.ref || new THREE.Vector3(1, 0, 0)).clone().normalize();
    const refFn = o.refFn || null;             // t -> reference axis (twisting frame)
    const uvw = o.uvw ?? 1, uvv0 = o.uvv0 ?? 0, uvv1 = o.uvv1 ?? 1;
    const rings = [], ends = [];
    const v = new THREE.Vector3(), nrm = new THREE.Vector3(), tang = new THREE.Vector3();
    for (let s = 0; s < n; s++) {
      tang.subVectors(pts[Math.min(n - 1, s + 1)], pts[Math.max(0, s - 1)]).normalize();
      const rBase = refFn ? refFn(len[s] / total) : ref0;
      const ref = rBase.clone().addScaledVector(tang, -rBase.dot(tang));
      if (ref.lengthSq() < 1e-6) ref.set(0, 0, 1).addScaledVector(tang, -tang.z);
      ref.normalize();
      const side = new THREE.Vector3().crossVectors(tang, ref).normalize();
      const t = len[s] / total;
      const [hx, hz, sq, pc] = GeoBuf.profAt(prof, t);
      const c = pc || col;
      const e = 2 / (2 + sq * 3.2);
      const hint = o.hintFn ? o.hintFn(t) : o.hint;
      const start = this.count;
      for (let i = 0; i < R; i++) {
        const th = i / R * TAU, ct = Math.cos(th), st = Math.sin(th);
        const px = Math.sign(ct) * Math.pow(Math.abs(ct), e) * hx;
        const pz = Math.sign(st) * Math.pow(Math.abs(st), e) * hz;
        v.copy(pts[s]).addScaledVector(ref, px).addScaledVector(side, pz);
        nrm.set(0, 0, 0).addScaledVector(ref, px / (hx * hx)).addScaledVector(side, pz / (hz * hz));
        if (nrm.lengthSq() < 1e-9) nrm.copy(ref);
        nrm.normalize();
        this.vert(v, nrm, c, [MIRU(i, R) * uvw, lerp(uvv0, uvv1, t)], hint);
      }
      rings.push(start);
      ends.push([tang.clone(), Math.min(hx, hz), c, hint]);
    }
    for (let s = 0; s + 1 < n; s++) this.bridge(rings[s], rings[s + 1], R);
    const cap = (ringStart, s, sgn, dome) => {
      const [tg, r, c, hint] = ends[s];
      const at = sgn > 0 ? uvv1 : uvv0;
      const cr = this.capRing(ringStart, R, at, 0.06, hint);
      const ci = this.count;
      this.vert(pts[s].clone().addScaledVector(tg, sgn * r * dome),
        tg.clone().multiplyScalar(sgn), c, [0.5, at], hint);
      for (let i = 0; i < R; i++) {
        const j = (i + 1) % R;
        if (sgn > 0) this.tri(cr + i, cr + j, ci); else this.tri(cr + j, cr + i, ci);
      }
    };
    if (o.cap0 !== false) cap(rings[0], 0, -1, o.dome0 ?? 0.85);
    if (o.cap1 !== false) cap(rings[n - 1], n - 1, 1, o.dome1 ?? 0.85);
    return rings;
  }

  /* sweep a superellipse ring along a straight bone segment.
     prof: [t, halfX, halfZ, squareness, colour?] samples, t from 0 (at a) to 1 */
  /* a THICK CURVED SHELL over a parametric patch: at(u,v) is the mid-surface,
     offset +-t/2 along its own normal, rim quads close the edge. A superellipse
     sweep is always convex, so anything that has to WRAP (a highback around a
     calf, a fitted plate) needs this instead - a flat sweep reads as a blade. */
  addShell(o) {
    const { nu, nv, at, col } = o;
    const uvw = o.uvw ?? 1, uvv = o.uvv ?? 1;
    const thick = typeof o.thick === 'number' ? () => o.thick : o.thick;
    const colFn = typeof col === 'function' ? col : () => col;
    const sgn = o.flip ? -1 : 1;
    const M = [], N = [];
    for (let i = 0; i <= nu; i++) {
      M.push([]); for (let j = 0; j <= nv; j++) M[i].push(at(i / nu, j / nv));
    }
    const du = new THREE.Vector3(), dv = new THREE.Vector3();
    for (let i = 0; i <= nu; i++) {
      N.push([]);
      for (let j = 0; j <= nv; j++) {
        du.subVectors(M[Math.min(nu, i + 1)][j], M[Math.max(0, i - 1)][j]);
        dv.subVectors(M[i][Math.min(nv, j + 1)], M[i][Math.max(0, j - 1)]);
        const n = new THREE.Vector3().crossVectors(dv, du).normalize().multiplyScalar(sgn);
        N[i].push(n);
      }
    }
    const idx = [[], []];                       // 0 = outer face, 1 = inner face
    for (const side of [0, 1]) {
      const f = side ? -1 : 1;
      for (let i = 0; i <= nu; i++) {
        idx[side].push([]);
        for (let j = 0; j <= nv; j++) {
          const u = i / nu, v = j / nv, t = thick(u, v);
          const p = M[i][j].clone().addScaledVector(N[i][j], f * t * 0.5);
          idx[side][i].push(this.count);
          this.vert(p, N[i][j].clone().multiplyScalar(f), colFn(u, v, side),
            [v * uvw, u * uvv], o.hint);
        }
      }
    }
    /* R7: `flip` negates the NORMALS, so it must reverse the WINDING with them or
       every triangle is wound against its own normal - and the material is
       FrontSide, so the outer wall is then culled and you see the dark inner wall
       through it (that is the "thin blade" highback and the "flat strap" scarf). */
    const qd = sgn > 0 ? (a, b, c, d) => this.quad(a, b, c, d)
      : (a, b, c, d) => this.quad(d, c, b, a);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = idx[0], b = idx[1];
      qd(a[i][j], a[i][j + 1], a[i + 1][j + 1], a[i + 1][j]);
      qd(b[i][j], b[i + 1][j], b[i + 1][j + 1], b[i][j + 1]);
    }
    // rim: walk the four boundaries, joining outer to inner with its own normal
    const rim = (pairs) => {
      for (let k = 0; k + 1 < pairs.length; k++) {
        const [i0, j0] = pairs[k], [i1, j1] = pairs[k + 1];
        const nr = new THREE.Vector3().subVectors(M[i1][j1], M[i0][j0])
          .cross(N[i0][j0]).normalize();
        const q = [];
        for (const [ii, jj] of [[i0, j0], [i1, j1]]) {
          const u = ii / nu, v = jj / nv, t = thick(u, v);
          for (const f of [1, -1]) {
            q.push(this.count);
            this.vert(M[ii][jj].clone().addScaledVector(N[ii][jj], f * t * 0.5),
              nr, colFn(u, v, 2), [v * uvw, u * uvv], o.hint);
          }
        }
        /* the rim was wound against `nr` for BOTH values of sgn: flipping sgn
           flips nr AND swaps which offset q[0] takes, so the error is invariant
           and has to be corrected once, here, rather than through qd(). */
        this.quad(q[1], q[3], q[2], q[0]);
      }
    };
    const seq = (n, f) => Array.from({ length: n + 1 }, (_, k) => f(k));
    rim(seq(nv, k => [nu, k]));                       // top edge
    rim(seq(nv, k => [0, nv - k]));                   // bottom edge
    rim(seq(nu, k => [nu - k, 0]));                   // left edge
    rim(seq(nu, k => [k, nv]));                       // right edge
    return idx;
  }

  addSweep(o) {
    const { a, b, prof, R = 12, col } = o;
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length(); dir.normalize();
    const ref = (o.ref || new THREE.Vector3(1, 0, 0)).clone();
    ref.addScaledVector(dir, -ref.dot(dir));
    if (ref.lengthSq() < 1e-6) ref.set(0, 0, 1).addScaledVector(dir, -dir.z);
    ref.normalize();
    const side = new THREE.Vector3().crossVectors(dir, ref).normalize();  // "front" axis
    const rings = [], v = new THREE.Vector3();
    const uvw = o.uvw ?? 1, uvv0 = o.uvv0 ?? 0, uvv1 = o.uvv1 ?? 1;
    for (let s = 0; s < prof.length; s++) {
      const P = prof[s], t = P[0], hx = P[1], hz = P[2], sq = P[3] ?? 0.25, c = P[4] || col;
      const start = this.count;
      for (let i = 0; i < R; i++) {
        const th = i / R * TAU;
        const ct = Math.cos(th), st = Math.sin(th);
        const e = 2 / (2 + sq * 3.2);           // superellipse exponent
        const px = Math.sign(ct) * Math.pow(Math.abs(ct), e) * hx;
        const pz = Math.sign(st) * Math.pow(Math.abs(st), e) * hz;
        v.copy(a).addScaledVector(dir, t * len).addScaledVector(ref, px).addScaledVector(side, pz);
        const nrm = new THREE.Vector3().addScaledVector(ref, px / (hx * hx)).addScaledVector(side, pz / (hz * hz));
        if (nrm.lengthSq() < 1e-9) nrm.copy(ref);
        nrm.normalize();
        this.vert(v, nrm, c, [MIRU(i, R) * uvw, lerp(uvv0, uvv1, t)], o.hint);
      }
      rings.push(start);
    }
    for (let s = 0; s + 1 < rings.length; s++) {
      const r0 = rings[s], r1 = rings[s + 1];
      for (let i = 0; i < R; i++) {
        const j = (i + 1) % R;
        this.quad(r0 + i, r0 + j, r1 + j, r1 + i);
      }
    }
    // caps: fan to a slightly domed centre so limb ends read round
    const cap = (ringStart, P, at, sgn, dome) => {
      const t = P[0], hx = P[1], hz = P[2];
      const c = new THREE.Vector3().copy(a).addScaledVector(dir, t * len)
        .addScaledVector(dir, sgn * Math.min(hx, hz) * dome);
      const cr = this.capRing(ringStart, R, at, 0.06, o.hint);
      const ci = this.count;
      this.vert(c, dir.clone().multiplyScalar(sgn), P[4] || col, [0.5, at], o.hint);
      for (let i = 0; i < R; i++) {
        const j = (i + 1) % R;
        if (sgn > 0) this.tri(cr + i, cr + j, ci);
        else this.tri(cr + j, cr + i, ci);
      }
    };
    if (o.cap0 !== false) cap(rings[0], prof[0], uvv0, -1, o.dome0 ?? 0.85);
    if (o.cap1 !== false) cap(rings[rings.length - 1], prof[prof.length - 1], uvv1, 1, o.dome1 ?? 0.85);
    return rings;
  }
}
const NEUTRAL_UV = [0.5, 0.5];
/* mirrored ring u: a plain i/R wrap makes the closing quad span the whole
   texture, which shows up as a bright hairline seam down every limb. */
const MIRU = (i, R) => 1 - Math.abs(2 * (i / R) - 1);

/* quadratic bezier from a to b through control c, n+1 samples: strap arcs */
function bez(a, c, b, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push(new THREE.Vector3(
      u * u * a.x + 2 * u * t * c.x + t * t * b.x,
      u * u * a.y + 2 * u * t * c.y + t * t * b.y,
      u * u * a.z + 2 * u * t * c.z + t * t * b.z));
  }
  return out;
}

/* ---------- palette ---------- */
function riderPalette(jacket, seed) {
  const rnd = mulberry32(seed | 0);
  const J = new THREE.Color(jacket);
  const jc = [J.r * 1.02 + 0.02, J.g * 1.02 + 0.02, J.b * 1.02 + 0.02];
  const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  return {
    jacket: jc,
    jacketD: mul(jc, 0.62),
    jacketL: [Math.min(1, jc[0] * 1.18 + 0.05), Math.min(1, jc[1] * 1.18 + 0.05), Math.min(1, jc[2] * 1.18 + 0.06)],
    pants: [0.145, 0.185, 0.295],
    pantsD: [0.092, 0.118, 0.205],
    boot: [0.048, 0.052, 0.066],
    bootSole: [0.088, 0.093, 0.108],
    bindBase: [0.200, 0.215, 0.260],
    bindStrap: [0.130, 0.140, 0.172],
    bindPad: [0.078, 0.083, 0.104],
    glove: [0.105, 0.115, 0.155],
    gloveD: [0.058, 0.064, 0.084],
    skin: [0.46, 0.315, 0.245],
    helmet: [0.125, 0.135, 0.175],
    helmetL: [0.165, 0.18, 0.225],
    lens: [0.085, 0.325, 0.435],
    metal: [0.30, 0.325, 0.375],
    board: mul(jc, 0.55),
    base: [0.10, 0.115, 0.155],
    /* sunlit surfaces sit on the ACES shoulder and DESATURATE toward white, so
       a knit red has to stay low and saturated or the scarf reads pale pink */
    knit: [0.235, 0.048, 0.042],
    knitD: [0.112, 0.026, 0.024],
    knitL: [0.300, 0.078, 0.058],
    bootLace: [0.145, 0.155, 0.195],
    r: rnd,
  };
}

/* ---------- rigid sub-parts, built from primitives but kept indexed -------- */
const ico = (r, d) => new THREE.IcosahedronGeometry(r, d ?? 1);
function roundBox(w, h, d, r, seg) {
  const g = new THREE.SphereGeometry(1, seg || 12, Math.max(4, Math.round((seg || 12) * 0.62)));
  const pos = g.attributes.position;
  const hx = Math.max(w / 2 - r, 0), hy = Math.max(h / 2 - r, 0), hz = Math.max(d / 2 - r, 0);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    pos.setXYZ(i, x * r + Math.sign(x) * hx * Math.min(1, Math.abs(x) * 1.9),
      y * r + Math.sign(y) * hy * Math.min(1, Math.abs(y) * 1.9),
      z * r + Math.sign(z) * hz * Math.min(1, Math.abs(z) * 1.9));
  }
  g.computeVertexNormals();
  return g;
}
/* Helmet shell. NOT a lathe: a lathe is a closed dome, which swallows the face
   and the goggles. This is a swept shell whose lower edge rises across the front
   to leave a face opening, with a real wall thickness so the rim reads as an
   edge instead of a hole. Local frame: +z faces forward, +y up. */
function helmetShell(r, squash) {
  const A = 26, J = 9, WALL = 0.90, pos = [], nrm = [], idx = [];
  // lower edge: deep over the ears and the nape, high across the face opening
  const pMaxAt = (az) => {
    const ang = Math.abs(Math.atan2(Math.sin(az), Math.cos(az)));    // 0 = front
    return lerp(2.00, 1.15, smoothstep(0, 1, clamp((1.15 - ang) / 0.85, 0, 1)));
  };
  const P = (az, p, k) => {
    const rr = r * (1 + 0.045 * Math.sin(p * 2.4)) * k;
    return new THREE.Vector3(Math.sin(p) * Math.sin(az) * rr,
      Math.cos(p) * rr * squash, Math.sin(p) * Math.cos(az) * rr);
  };
  const pushN = (v, n) => {
    pos.push(v.x, v.y, v.z); nrm.push(n.x, n.y, n.z);
    return pos.length / 3 - 1;
  };
  const push = (v, sgn) => pushN(v, v.clone().normalize().multiplyScalar(sgn));
  const V = (i) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  // wind each quad so its face normal agrees with the vertex normal we stored
  const quad = (a, b, c, d) => {
    const fn = V(b).sub(V(a)).cross(V(c).sub(V(a)));
    const want = new THREE.Vector3(nrm[a * 3], nrm[a * 3 + 1], nrm[a * 3 + 2]);
    if (fn.dot(want) >= 0) idx.push(a, b, c, a, c, d); else idx.push(a, d, c, a, c, b);
  };
  const ring = [[], []];                                  // [outer, inner] grids
  for (let s = 0; s < 2; s++) {
    const k = s === 0 ? 1 : WALL, sgn = s === 0 ? 1 : -1;
    for (let j = 0; j <= J; j++) {
      const row = [];
      for (let i = 0; i < A; i++) {
        const az = i / A * Math.PI * 2, pm = pMaxAt(az);
        const t = Math.max(j / J, 0.06);                  // keep the top ring open
        row.push(push(P(az, pm * Math.pow(t, 0.95), k), sgn));
      }
      ring[s].push(row);
    }
  }
  const topO = push(new THREE.Vector3(0, r * squash, 0), 1);
  const topI = push(new THREE.Vector3(0, r * squash * WALL, 0), -1);
  for (let s = 0; s < 2; s++) {
    const g = ring[s], top = s === 0 ? topO : topI;
    for (let i = 0; i < A; i++) {
      const i2 = (i + 1) % A;
      const fn = V(g[0][i]).sub(V(top)).cross(V(g[0][i2]).sub(V(top)));
      const w = new THREE.Vector3(nrm[top * 3], nrm[top * 3 + 1], nrm[top * 3 + 2]);
      if (fn.dot(w) >= 0) idx.push(top, g[0][i], g[0][i2]); else idx.push(top, g[0][i2], g[0][i]);
      for (let j = 0; j < J; j++) quad(g[j][i], g[j][i2], g[j + 1][i2], g[j + 1][i]);
    }
  }
  /* Rim: bridge the outer and inner lower edges. The rim is the visible EDGE of the
     face opening, and it needs a normal of its OWN - it points along the sweep, i.e.
     roughly 90 deg away from both the outer wall's (outward) and the inner wall's
     (inward) normal, so it cannot borrow either. It used to be emitted TWICE, once in
     each winding order, to sidestep that; the cost was that every second rim triangle
     disagreed with its own normal (52 of them, at worstDot ~0, so they lit as garbage)
     and 104 edges ended up shared by four faces. Instead give the rim its own pair of
     vertex rings carrying the sweep direction, then wind it ONCE - quad() self-orients
     against the stored normal. Halves the rim to 52 tris. */
  const rimO = [], rimI = [];
  for (let i = 0; i < A; i++) {
    const o = ring[0][J], n = ring[1][J], up = ring[0][J - 1];
    const rn = V(o[i]).sub(V(up[i])).normalize();          // sweep dir at the opening
    rimO.push(pushN(V(o[i]), rn));
    rimI.push(pushN(V(n[i]), rn));
  }
  for (let i = 0; i < A; i++) {
    const i2 = (i + 1) % A;
    quad(rimO[i], rimI[i], rimI[i2], rimO[i2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/* boot dimensions in ankle-local space (+z = toe). The binding is built from
   the same numbers, so the sole lands on the baseplate and the straps clear
   the shell by a few mm instead of floating. */
const BOOT = {
  ankleY: 0.132,
  soleY: -0.058, soleT: 0.016, soleHW: 0.067,
  heelZ: -0.090, toeZ: 0.152,
  lastY: -0.016, lastHX: 0.064, lastHY: 0.047,
  cuffZ: -0.024, cuffHX: 0.066, cuffHZ: 0.070, cuffTop: 0.076,
};

/* a snowboard: sidecut, camber, rolled rails, indexed along its length */
function boardSweep(buf, mat, pal, boardBone) {
  const L = 1.52, waist = 0.126, tip = 0.164, N = 34, th = 0.017, R = 14;
  const halfW = t => {
    const a = Math.abs(t);
    const side = waist + (tip - waist) * Math.pow(a, 1.75);
    const nose = 1 - Math.pow(Math.max(0, (a - 0.90) / 0.10), 2);
    return side * Math.max(0.05, nose);
  };
  const camber = t => 0.020 * (1 - t * t * 1.10) + 0.052 * Math.pow(Math.abs(t), 3.4);
  const rings = [];
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let s = 0; s <= N; s++) {
    const t = -1 + 2 * s / N, z = t * L / 2;
    const w = halfW(t), y = camber(t);
    const start = buf.count;
    const stripe = Math.abs(t) < 0.32;
    for (let i = 0; i < R; i++) {
      const a = i / R * TAU;
      // rounded-rectangle cross-section: wide, thin, rolled edges
      const ct = Math.cos(a), st = Math.sin(a);
      const e = 0.28;
      const px = Math.sign(ct) * Math.pow(Math.abs(ct), e) * w;
      const py = Math.sign(st) * Math.pow(Math.abs(st), e) * th * 0.5 + th * 0.5;
      const up = st > 0.25, down = st < -0.25;
      const col = up ? (stripe ? pal.jacketL : pal.board) : (down ? pal.base : pal.metal);
      v.set(px, y + py, z);
      n.set(px / (w * w), py / (th * th) * 0.25, 0).normalize();
      const uv = up ? [0.5 + 0.46 * (px / Math.max(w, 0.001)), 0.5 + 0.48 * t] : NEUTRAL_UV;
      buf.vert(v, n, col, uv, boardBone);
    }
    rings.push(start);
  }
  for (let s = 0; s + 1 < rings.length; s++) {
    for (let i = 0; i < R; i++) {
      const j = (i + 1) % R;
      buf.quad(rings[s] + i, rings[s] + j, rings[s + 1] + j, rings[s + 1] + i);
    }
  }
  // nose / tail caps
  for (const [rs, sgn] of [[rings[0], -1], [rings[rings.length - 1], 1]]) {
    const ci = buf.count;
    const zc = sgn * (L / 2 + 0.006);
    buf.vert(new THREE.Vector3(0, camber(sgn) + th * 0.5, zc), new THREE.Vector3(0, 0, sgn), pal.board, NEUTRAL_UV, boardBone);
    for (let i = 0; i < R; i++) {
      const j = (i + 1) % R;
      if (sgn > 0) buf.tri(rs + i, rs + j, ci); else buf.tri(rs + j, rs + i, ci);
    }
  }
  // bindings: fitted baseplate, cradle rails, curved highback, two strap arcs
  const bind = (fx, fz, ang) => {
    const deck = camber(fz / (L / 2)) + th;
    const by = BOOT.ankleY - deck;                       // ankle height over the deck
    const soleBot = by + BOOT.soleY - BOOT.soleT;        // where the boot rests
    const rotY = new THREE.Matrix4().makeRotationY(ang);
    const base = new THREE.Matrix4().makeTranslation(fx, deck, fz).multiply(rotY);
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const put = (geo, col, x, y, z, rx) => {
      const full = base.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z));
      if (rx) full.multiply(new THREE.Matrix4().makeRotationX(rx));
      buf.addGeo(geo, full, col, boardBone);
    };
    const path = (o) => {
      o.pts = o.pts.map(p => p.applyMatrix4(base));
      if (o.ref) o.ref = o.ref.transformDirection(rotY);
      o.hint = boardBone;
      return buf.addPath(o);
    };
    // baseplate, top face exactly at the sole
    path({
      pts: [V(0, soleBot - 0.009, -0.100), V(0, soleBot - 0.009, -0.040),
      V(0, soleBot - 0.009, 0.070), V(0, soleBot - 0.009, 0.138)],
      ref: V(1, 0, 0), R: 12, col: pal.bindBase, dome0: 0.4, dome1: 0.4,
      prof: [[0, 0.068, 0.009, 0.72, pal.bindBase], [0.22, 0.080, 0.009, 0.8, pal.bindBase],
      [0.78, 0.079, 0.009, 0.8, pal.bindBase], [1, 0.060, 0.008, 0.7, pal.bindBase]]
    });
    // cradle rails hugging the sole edges
    for (const sx of [-1, 1])
      put(roundBox(0.013, 0.036, 0.170, 0.006, 8), pal.bindBase, sx * 0.0755, soleBot + 0.018, 0.005);
    /* highback: a shell that WRAPS the calf (a flat sweep read as a thin blade),
       with a raised spine rib and rolled-in top corners */
    const hbY0 = soleBot + 0.010, hbH = 0.148, hbR = 0.078;
    const hbAt = (u, v) => {
      const y = hbY0 + u * hbH;
      const zc = -0.078 - u * 0.026 + hbR;             // arc centre, leaning back
      let hw = 0.062 * (1 - 0.20 * u);                 // half width, narrowing up
      hw *= 1 - smoothstep(0.78, 1, u) * 0.28;         // rolled-in top corners
      const a = (v * 2 - 1) * (hw / hbR);
      const spine = (1 - Math.abs(v * 2 - 1) ** 1.6) * 0.005 * smoothstep(0.05, 0.5, u);
      return V(Math.sin(a) * hbR, y, zc - Math.cos(a) * (hbR + spine))
        .applyMatrix4(base);
    };
    buf.addShell({
      nu: 7, nv: 9, at: hbAt, hint: boardBone, flip: true,
      thick: u => 0.012 - 0.005 * u,
      col: (u, v, side) => side === 1 ? pal.bindPad
        : (u > 0.80 ? pal.bindStrap : pal.bindBase)
    });
    // ankle strap: arc over the instep, clearing the shell by ~4mm
    const strapProf = [[0, 0.028, 0.009, 0.5, pal.bindStrap], [0.5, 0.034, 0.011, 0.6, pal.bindStrap],
    [1, 0.028, 0.009, 0.5, pal.bindStrap]];
    path({
      pts: bez(V(-0.081, by - 0.062, 0.004), V(0, by + 0.108, 0.116), V(0.081, by - 0.062, 0.004), 10),
      ref: V(0, 0, 1), R: 8, col: pal.bindStrap, prof: strapProf, dome0: 0.3, dome1: 0.3
    });
    // toe strap: arc over the toe box
    path({
      pts: bez(V(-0.072, by - 0.066, 0.086), V(0, by + 0.126, 0.136), V(0.072, by - 0.066, 0.086), 10),
      ref: V(0, 0, 1), R: 8, col: pal.bindStrap, prof: strapProf, dome0: 0.3, dome1: 0.3
    });
    // ratchet buckles on the strap ends
    put(roundBox(0.026, 0.030, 0.046, 0.007, 8), pal.metal, 0.084, by - 0.030, 0.030);
    put(roundBox(0.024, 0.026, 0.042, 0.006, 8), pal.metal, 0.078, by - 0.044, 0.096);
  };
  bind(0.004, 0.238, 0.30); bind(0.004, -0.238, -0.10);
}
/* ---- canvas textures: fabric weave + a knit for the neck warmer ---- */
let _FAB = null;
function fabricTex() {
  if (_FAB) return _FAB;
  const N = 512, c = document.createElement('canvas'); c.width = c.height = N;
  const x = c.getContext('2d');
  x.fillStyle = '#7a7d82'; x.fillRect(0, 0, N, N);
  const rnd = mulberry32(7);
  // ripstop diamonds
  x.strokeStyle = 'rgba(255,255,255,.11)'; x.lineWidth = 1;
  for (let i = -N; i < N * 2; i += 18) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i + N, N); x.stroke();
    x.beginPath(); x.moveTo(i, N); x.lineTo(i + N, 0); x.stroke();
  }
  // crinkled nylon grain
  const img = x.getImageData(0, 0, N, N), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() * 2 - 1) * 22;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n * 0.9, 0, 255);
  }
  x.putImageData(img, 0, 0);
  // taped seams
  x.strokeStyle = 'rgba(18,20,24,.28)'; x.lineWidth = 3;
  x.beginPath(); x.moveTo(0, N * 0.33); x.lineTo(N, N * 0.33); x.stroke();
  x.beginPath(); x.moveTo(N * 0.5, 0); x.lineTo(N * 0.5, N); x.stroke();
  x.fillStyle = 'rgba(255,255,255,.08)';
  x.fillRect(0, N * 0.18, N, N * 0.09);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  _FAB = t;
  return t;
}

function pantsCanvas() {
  const N = 512, c = document.createElement('canvas'); c.width = c.height = N;
  const x = c.getContext('2d');
  x.fillStyle = '#6a6c70'; x.fillRect(0, 0, N, N);
  const rnd = mulberry32(11);
  x.lineWidth = 1.2;
  for (let i = 0; i < N * 3; i++) {
    const gx = rnd() * N, gy = rnd() * N, l = 5 + rnd() * 10;
    const v = 108 + (rnd() * 2 - 1) * 20;
    x.strokeStyle = `rgb(${v | 0},${(v * 0.98) | 0},${(v * 0.94) | 0})`;
    x.beginPath(); x.moveTo(gx, gy); x.lineTo(gx + l, gy + l * 0.45); x.stroke();
  }
  x.strokeStyle = 'rgba(255,255,255,.07)';
  for (let i = 0; i < 10; i++) {
    const a = (i + 0.5) * N / 10;
    x.beginPath(); x.moveTo(0, a); x.lineTo(N, a); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function loadGameTex(url, wrapRepeat, fallback) {
  /* Start on the procedural canvas so a single-file build (no /tex) still
     looks right. If a hosted jpg loads, swap it in. */
  const t = fallback ? fallback() : new THREE.Texture();
  t.wrapS = t.wrapT = wrapRepeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  if (!url) return t;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (!img.naturalWidth) return;
    t.image = img;
    t.needsUpdate = true;
  };
  img.onerror = () => {};
  img.src = url;
  return t;
}

const _GTEX = {};
function gameTex(name) {
  if (_GTEX[name]) return _GTEX[name];
  if (name === 'jacket') _GTEX[name] = loadGameTex('/tex/jacket.jpg', true, fabricTex);
  else if (name === 'pants') _GTEX[name] = loadGameTex('/tex/pants.jpg', true, pantsCanvas);
  else if (name === 'boots') _GTEX[name] = loadGameTex('/tex/boots.jpg', true, fabricTex);
  else if (name === 'board') _GTEX[name] = loadGameTex('/tex/board.jpg', false, fabricTex);
  return _GTEX[name];
}

