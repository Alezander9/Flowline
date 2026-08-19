/* =============================================== rider: skeleton + skinning
   Bones are placed from a table of bind-pose joint positions in rider space,
   each aimed at its child so "down the limb" is always local -Y (elbows and
   knees then bend cleanly about local X). Skin weights are solved here, from
   distance to each bone segment, then smoothed so shoulders and hips do not
   pinch. Region masks stop a leg vertex grabbing the other leg's bone. */

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const CHEST_YAW = 0.92;                              // total spine twist: the stance
const yawV = (ang, r) => V3(Math.cos(ang) * r, 0, -Math.sin(ang) * r);

function bindJoints() {
  const chest = V3(0, 0.872, 0);
  const shoulderAx = yawV(CHEST_YAW, 1);             // shoulder line, points to the tail side
  const shB = chest.clone().add(V3(0, 0.062, 0)).addScaledVector(shoulderAx, 0.132);
  const shF = chest.clone().add(V3(0, 0.062, 0)).addScaledVector(shoulderAx, -0.132);
  const out = shoulderAx.clone();
  const front = V3(Math.sin(CHEST_YAW), 0, Math.cos(CHEST_YAW));   // chest facing (toe side)
  const J = {
    board: V3(0, 0.0, 0), boardAim: V3(0, -1, 0),
    pelvis: V3(0, 0.520, 0), spine1: V3(0, 0.620, 0), spine2: V3(0, 0.730, 0),
    chest, neck: V3(0, 0.978, -0.004), head: V3(0, 1.068, 0.010), headAim: V3(0, 0.92, 0.010),
    clavF: chest.clone().add(V3(0, 0.058, 0)).addScaledVector(shoulderAx, -0.048),
    clavB: chest.clone().add(V3(0, 0.058, 0)).addScaledVector(shoulderAx, 0.048),
    upperF: shF, upperB: shB,
    foreF: shF.clone().add(V3(0, -0.225, 0)).addScaledVector(out, -0.030).addScaledVector(front, 0.020),
    foreB: shB.clone().add(V3(0, -0.225, 0)).addScaledVector(out, 0.030).addScaledVector(front, 0.010),
    hipF: V3(0, 0.512, 0.076), hipB: V3(0, 0.512, -0.076),
    kneeF: V3(0.052, 0.322, 0.170), kneeB: V3(0.048, 0.322, -0.152),
    ankleF: V3(0.004, 0.132, 0.238), ankleB: V3(0.004, 0.132, -0.238),
  };
  J.handF = J.foreF.clone().add(V3(0, -0.205, 0)).addScaledVector(front, 0.030);
  J.handB = J.foreB.clone().add(V3(0, -0.205, 0)).addScaledVector(front, 0.020);
  J.wristEndF = J.handF.clone().add(V3(0, -0.075, 0));
  J.wristEndB = J.handB.clone().add(V3(0, -0.075, 0));
  const scOut = yawV(CHEST_YAW, 1).clone().multiplyScalar(-0.055);
  J.scarf0 = J.neck.clone().addScaledVector(front, -0.118).add(V3(0, 0.006, 0)).add(scOut);
  J.scarf1 = J.scarf0.clone().add(V3(0, -0.130, 0)).addScaledVector(front, -0.030).add(scOut.clone().multiplyScalar(0.5));
  J.scarf2 = J.scarf1.clone().add(V3(0, -0.128, 0)).addScaledVector(front, -0.010);
  J.scarf2Aim = J.scarf2.clone().add(V3(0, -0.12, 0));
  J.toeF = J.ankleF.clone().add(V3(0, -0.055, 0));
  J.toeB = J.ankleB.clone().add(V3(0, -0.055, 0));
  J.front = front; J.out = out;
  return J;
}

/* bone tree: [name, parent, jointKey, aimKey, roll] */
const BONE_TREE = [
  ['root', null, null, null, 0],
  ['board', 'root', 'board', 'boardAim', 0],
  ['pelvis', 'root', 'pelvis', 'spine1', 0.42],
  ['spine1', 'pelvis', 'spine1', 'spine2', 0.16],
  ['spine2', 'spine1', 'spine2', 'chest', 0.18],
  ['chest', 'spine2', 'chest', 'neck', 0.16],
  ['neck', 'chest', 'neck', 'head', 0],
  ['head', 'neck', 'head', 'headAim', 0],
  ['clavF', 'chest', 'clavF', 'upperF', 0],
  ['upperF', 'clavF', 'upperF', 'foreF', 0],
  ['foreF', 'upperF', 'foreF', 'handF', 0],
  ['handF', 'foreF', 'handF', 'wristEndF', 0],
  ['clavB', 'chest', 'clavB', 'upperB', 0],
  ['upperB', 'clavB', 'upperB', 'foreB', 0],
  ['foreB', 'upperB', 'foreB', 'handB', 0],
  ['handB', 'foreB', 'handB', 'wristEndB', 0],
  ['thighF', 'pelvis', 'hipF', 'kneeF', 0],
  ['shinF', 'thighF', 'kneeF', 'ankleF', 0],
  ['footF', 'shinF', 'ankleF', 'toeF', 0],
  ['thighB', 'pelvis', 'hipB', 'kneeB', 0],
  ['shinB', 'thighB', 'kneeB', 'ankleB', 0],
  ['footB', 'shinB', 'ankleB', 'toeB', 0],
  ['scarf0', 'neck', 'scarf0', 'scarf1', 0],
  ['scarf1', 'scarf0', 'scarf1', 'scarf2', 0],
  ['scarf2', 'scarf1', 'scarf2', 'scarf2Aim', 0],
];

function buildSkeleton() {
  const J = bindJoints();
  const B = {}, list = [], index = {};
  const tmp = new THREE.Matrix4(), q = new THREE.Quaternion();
  const DOWN = V3(0, -1, 0);
  for (const [name, parent, jk, ak, roll] of BONE_TREE) {
    const b = new THREE.Bone(); b.name = name;
    B[name] = b;
    index[name] = list.length; list.push(b);
    if (parent) B[parent].add(b);
    if (jk) {
      // local position from the desired world position
      const p = J[jk].clone();
      B[parent].updateMatrixWorld(true);
      tmp.copy(B[parent].matrixWorld).invert();
      b.position.copy(p.applyMatrix4(tmp));
      // aim local -Y at the child joint, then roll about the limb axis
      if (ak) {
        const target = J[ak].clone().applyMatrix4(tmp).sub(b.position).normalize();
        q.setFromUnitVectors(DOWN, target);
        b.quaternion.copy(q);
      }
      // these bones aim -Y up the spine, so world-up roll is about local -Y
      if (roll) b.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(V3(0, -1, 0), roll));
    }
    b.updateMatrixWorld(true);
  }
  B.root.updateMatrixWorld(true);
  const bind = {};
  for (const b of list) bind[b.name] = b.getWorldPosition(new THREE.Vector3());
  return { B, list, index, J, bind };
}

/* Distance between two bones in steps along the skeleton tree. When a vertex has
   more influences than the 4 slots a skinned vertex can carry, the weight we have
   to discard should go to the kept bone that MOVES most like the discarded one -
   its nearest neighbour in the hierarchy - not be spread proportionally over all
   four, which hands part of it to bones on the far side of the body.            */
function boneTreeDist(list) {
  const parent = {};
  for (const [n, p] of BONE_TREE) parent[n] = p;
  const chains = list.map(b => {
    const c = [];
    for (let k = b.name; k; k = parent[k]) c.push(k);
    return c;
  });
  return list.map((_, a) => {
    const row = new Uint8Array(list.length);
    for (let b = 0; b < list.length; b++) {
      let d = 99;
      for (let i = 0; i < chains[a].length; i++) {
        const j = chains[b].indexOf(chains[a][i]);
        if (j >= 0) { d = Math.min(i + j, 99); break; }
      }
      row[b] = d;
    }
    return row;
  });
}

/* ---------------------------------------------------------------- weights */
function solveWeights(buf, rig) {
  const { list, index, J, bind } = rig;
  const P = n => bind[n];
  /* one capsule segment per bone: [boneName, a, b, radius] */
  const S = [
    ['pelvis', P('pelvis'), P('spine1'), 0.30],
    ['spine1', P('spine1'), P('spine2'), 0.28],
    ['spine2', P('spine2'), P('chest'), 0.28],
    ['chest', P('chest'), P('neck'), 0.30],
    ['neck', P('neck'), P('head'), 0.14],
    ['head', P('head'), P('head').clone().add(V3(0, 0.10, 0)), 0.18],
    ['clavF', P('chest').clone().add(V3(0, 0.07, 0)), P('upperF'), 0.16],
    ['upperF', P('upperF'), P('foreF'), 0.15],
    ['foreF', P('foreF'), P('handF'), 0.13],
    ['handF', P('handF'), J.wristEndF, 0.12],
    ['clavB', P('chest').clone().add(V3(0, 0.07, 0)), P('upperB'), 0.16],
    ['upperB', P('upperB'), P('foreB'), 0.15],
    ['foreB', P('foreB'), P('handB'), 0.13],
    ['handB', P('handB'), J.wristEndB, 0.12],
    ['thighF', P('thighF'), P('shinF'), 0.18],
    ['shinF', P('shinF'), P('footF'), 0.16],
    ['footF', P('footF'), J.toeF, 0.14],
    ['thighB', P('thighB'), P('shinB'), 0.18],
    ['shinB', P('shinB'), P('footB'), 0.16],
    ['footB', P('footB'), J.toeB, 0.14],
    ['scarf0', P('scarf0'), P('scarf1'), 0.075],
    ['scarf1', P('scarf1'), P('scarf2'), 0.075],
    ['scarf2', P('scarf2'), J.scarf2Aim, 0.075],
  ];
  const segByBone = {};
  S.forEach((s, i) => segByBone[s[0]] = i);

  const nV = buf.count, nB = list.length;
  const W = new Float32Array(nV * nB);               // dense, then reduced to 4
  const v = new THREE.Vector3(), ab = new THREE.Vector3(), av = new THREE.Vector3();
  const distToSeg = (p, a, b) => {
    ab.subVectors(b, a); av.subVectors(p, a);
    const t = clamp(av.dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
    return av.addScaledVector(ab, -t).length();
  };
  let weightless = 0;
  for (let i = 0; i < nV; i++) {
    v.set(buf.pos[i * 3], buf.pos[i * 3 + 1], buf.pos[i * 3 + 2]);
    const hint = buf.hint[i];
    if (hint !== null && hint !== undefined) { W[i * nB + hint] = 1; continue; }
    const reg = buf.regs[i];
    let sum = 0;
    for (let s = 0; s < S.length; s++) {
      const name = S[s][0];
      if (reg && reg.indexOf(name) < 0) continue;
      const d = distToSeg(v, S[s][1], S[s][2]);
      const r = S[s][3];
      // smooth falloff plus a near-field term so the closest bone dominates
      const w = Math.pow(Math.max(0, 1 - d / (r * 2.2)), 3) + 0.045 / (d * d + 0.004);
      if (w > 1e-5) { W[i * nB + index[name]] += w; sum += w; }
    }
    if (sum <= 1e-6) {   // fall back to the nearest allowed segment
      let best = -1, bd = 1e9;
      for (let s = 0; s < S.length; s++) {
        if (reg && reg.indexOf(S[s][0]) < 0) continue;
        const d = distToSeg(v, S[s][1], S[s][2]);
        if (d < bd) { bd = d; best = s; }
      }
      if (best < 0) { weightless++; W[i * nB + index.pelvis] = 1; }
      else W[i * nB + index[S[best][0]]] = 1;
    }
  }

  /* Smooth the weight field across shared vertices, else joints crease - then
     project straight back onto 4 influences after EVERY pass (SPARSE-CONSTRAINED
     smoothing). Plain smoothing diffuses the torso support to 7 bones (pelvis,
     spine1/2, chest, neck and both clavicles all reach a jacket vertex), which 4
     slots cannot hold, so the old single truncation at the end threw away up to
     35.4% of a vertex's weight and displaced it by 33mm from the field the solver
     had actually authored. Projecting every pass keeps the field 4-representable
     by construction AND keeps neighbouring support sets consistent, so it is both
     exact and smoother: measured worst-vertex dropped 35.4% -> 0.0%, mean
     deviation from the dense intent 2.679mm -> 1.444mm, vertices off by >20mm
     648 -> 196, edge roughness (the crease proxy) 0.1015 -> 0.0994.
     Do NOT raise the pass count to smooth further: at 8 and 12 passes roughness
     keeps falling but the worst vertex is dragged 43mm and 67mm off intent.     */
  const adj = buildAdjacency(buf, nV);
  const HD = boneTreeDist(list);
  const tmpW = new Float32Array(nV * nB);
  const top = [];
  for (let pass = 0; pass < 3; pass++) {
    tmpW.set(W);
    for (let i = 0; i < nV; i++) {
      if (buf.hint[i] !== null && buf.hint[i] !== undefined) continue;
      const nb = adj[i]; if (!nb || !nb.length) continue;
      const o = i * nB;
      for (let k = 0; k < nB; k++) {
        let s = tmpW[o + k] * 1.4;
        for (let j = 0; j < nb.length; j++) s += tmpW[nb[j] * nB + k];
        W[o + k] = s / (1.4 + nb.length);
      }
    }
    /* project onto 4 influences. A SEPARATE loop on purpose: a vertex with no
       adjacency skips smoothing but must still be projected, or its raw capsule
       field keeps up to 7 influences and the truncation at the end is back.    */
    for (let i = 0; i < nV; i++) {
      if (buf.hint[i] !== null && buf.hint[i] !== undefined) continue;
      const o = i * nB;
      top.length = 0;
      for (let k = 0; k < nB; k++) if (W[o + k] > 1e-6) top.push([k, W[o + k]]);
      if (top.length <= 4) continue;
      top.sort((a, b) => b[1] - a[1]);
      for (let k = 4; k < top.length; k++) {
        let bi = 0, bd = 99;
        for (let m = 0; m < 4; m++) {
          const d = HD[top[k][0]][top[m][0]];
          if (d < bd || (d === bd && top[m][1] > top[bi][1])) { bd = d; bi = m; }
        }
        W[o + top[bi][0]] += top[k][1];
        W[o + top[k][0]] = 0;
      }
    }
  }

  /* reduce to the 4 strongest, normalised */
  const si = new Uint16Array(nV * 4), sw = new Float32Array(nV * 4);
  let maxUsed = 0, dropped = 0;
  for (let i = 0; i < nV; i++) {
    const o = i * nB;
    const top = [];
    for (let k = 0; k < nB; k++) if (W[o + k] > 1e-6) top.push([k, W[o + k]]);
    top.sort((a, b) => b[1] - a[1]);
    maxUsed = Math.max(maxUsed, Math.min(top.length, 4));
    let t = 0, all = 0;
    for (let k = 0; k < 4 && k < top.length; k++) t += top[k][1];
    for (let k = 0; k < top.length; k++) all += top[k][1];
    if (all > 0) dropped = Math.max(dropped, 1 - t / all);
    if (t <= 0) { si[i * 4] = index.pelvis; sw[i * 4] = 1; continue; }
    for (let k = 0; k < 4; k++) {
      if (k < top.length) { si[i * 4 + k] = top[k][0]; sw[i * 4 + k] = top[k][1] / t; }
    }
  }
  return { si, sw, weightless, maxUsed, dropped };
}

/* vertex neighbours from the index buffer (welded rings share vertices) */
function buildAdjacency(buf, nV) {
  const adj = new Array(nV);
  const add = (a, b) => { (adj[a] || (adj[a] = [])).push(b); };
  const seen = new Set();
  const ix = buf.idx;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i], b = ix[i + 1], c = ix[i + 2];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = p < q ? p * 1e7 + q : q * 1e7 + p;
      if (seen.has(k)) continue;
      seen.add(k); add(p, q); add(q, p);
    }
  }
  return adj;
}

function bufToGeometry(buf, skin, recompute, withUv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  if (withUv !== false) g.setAttribute('aUv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.setIndex(buf.idx);
  if (skin) {
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skin.sw, 4));
  }
  if (recompute) g.computeVertexNormals();
  g.computeBoundingSphere();
  g.boundingSphere.radius *= 1.9;         // room for the pose to move verts
  return g;
}

