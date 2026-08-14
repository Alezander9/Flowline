/* ------------------------------------------------- rider mesh & animation
   Two SkinnedMeshes (soft fabric + hard shells) share one 25-bone Skeleton.
   Posing is procedural so it stays continuous with speed, edge and crouch;
   the boots are pinned to the bindings with analytic two-bone IK, a grab
   reaches the real board rail with the same solver, and a 3-link verlet
   chain drives the scarf. Generated clips ride on top for one-shots.
   Geometry + solved weights are cached per jacket colour and shared. */

let SHADOW_TEX = null;
function shadowTex() {
  if (SHADOW_TEX) return SHADOW_TEX;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 2, 32, 32, 31);
  g.addColorStop(0, 'rgba(30,52,80,.55)'); g.addColorStop(0.55, 'rgba(30,52,80,.28)');
  g.addColorStop(1, 'rgba(30,52,80,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  SHADOW_TEX = new THREE.CanvasTexture(c);
  return SHADOW_TEX;
}

/* objMat's lighting and fog, plus skinning and an optional fabric map. The
   skinning chunks are inert unless the object being drawn is a SkinnedMesh. */
function riderMat(o = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: Object.assign({}, WU, {
      uSpec: { value: o.spec ?? 0.0 }, uWrap: { value: o.wrap ?? 0.34 },
      uRim: { value: o.rim ?? 0.0 }, uMap: { value: o.map || null },
      uMapAmt: { value: o.map ? (o.mapAmt ?? 1.0) : 0.0 },
    }),
    defines: o.map ? { HAS_MAP: '' } : {},
    side: o.side || THREE.FrontSide,
    vertexShader: `
      attribute vec3 color;
      #ifdef HAS_MAP
        attribute vec2 aUv;
        varying vec2 vUv;
      #endif
      varying vec3 vC, vN, vW;
      #include <skinning_pars_vertex>
      void main(){
        vec3 objectNormal = normal;
        vec3 transformed = position;
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <skinning_vertex>
        vec4 wp = modelMatrix * vec4(transformed, 1.0);
        vC = color;
        vN = normalize(mat3(modelMatrix) * objectNormal);
        vW = wp.xyz;
        #ifdef HAS_MAP
          vUv = aUv;
        #endif
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: GLSL_COMMON + GLSL_CASCADE + `
      uniform float uSpec, uWrap, uRim, uMapAmt;
      uniform sampler2D uMap;
      varying vec3 vC, vN, vW;
      #ifdef HAS_MAP
        varying vec2 vUv;
      #endif
      void main(){
        vec3 N = normalize(vN);
        vec3 vd = normalize(vW - cameraPosition);
        float dist = length(vW - cameraPosition);
        vec3 base = vC;
        #ifdef HAS_MAP
          vec3 tx = texture2D(uMap, vUv).rgb;
          base *= mix(vec3(1.0), tx*2.0, uMapAmt);
        #endif
        float ndl = max((dot(N,uSun)+uWrap)/(1.0+uWrap),0.0);
        vec3 amb = mix(uGndCol, uSkyCol, N.y*0.5+0.5);
        /* riding into tree shade now visibly dims the rider */
        float sh = sunShadow(vW, N, dist);
        vec3 col = base*(uSunCol*ndl*(1.0-0.85*sh) + amb*0.55);
        if(uSpec > 0.001){
          vec3 hv = normalize(uSun - vd);
          col += uSunCol*pow(max(dot(N,hv),0.0), 60.0)*uSpec;
        }
        if(uRim > 0.001){
          float f = pow(1.0 - max(dot(N,-vd),0.0), 3.0);
          col += uSkyCol*f*uRim;
        }
        col = applyFog(col, dist, vd);
        gl_FragColor = vec4(outc(col),1.0);
      }`
  });
  return m;
}

/* ---- shared kit: geometry, weights and materials are built once per colour.
   Bones are per rider (they animate), the buffers are not. */
const _RKIT = {};
function riderKit(jacket) {
  const key = jacket + '';
  if (_RKIT[key]) return _RKIT[key];
  const rig = buildSkeleton();                       // throwaway: bind pose only
  const pal = riderPalette(jacket, 11);
  const { soft, hard } = buildRiderB(rig, pal);
  const wS = solveWeights(soft, rig), wH = solveWeights(hard, rig);
  const gSoft = bufToGeometry(soft, wS, false, true);
  const gHard = bufToGeometry(hard, wH, false, false);
  // skinned bounds: the bind-pose sphere, grown so a grab or a tumble never pops
  for (const g of [gSoft, gHard]) {
    if (!g.boundingSphere) g.computeBoundingSphere();
    g.boundingSphere.radius *= 1.7;
  }
  return (_RKIT[key] = {
    gSoft, gHard, pal,
    matSoft: riderMat({ wrap: 0.36, rim: 0.055, map: fabricTex(), mapAmt: 0.34 }),
    matHard: riderMat({ wrap: 0.30, spec: 0.55, rim: 0.06 }),
    stats: {
      tris: (gSoft.index.count + gHard.index.count) / 3,
      verts: gSoft.attributes.position.count + gHard.attributes.position.count,
      bones: rig.list.length, weightless: wS.weightless + wH.weightless,
      dropped: Math.max(wS.dropped, wH.dropped),
    },
  });
}
/* warm the cache off the critical path: the first bot of a colour would
   otherwise build ~10k tris and solve its weights inside a frame */
function riderPrewarm(cols) {
  const q = cols.slice();
  const step = () => {
    const c = q.shift();
    if (c === undefined) return;
    riderKit(c);
    (window.requestIdleCallback || requestAnimationFrame)(step);
  };
  (window.requestIdleCallback || requestAnimationFrame)(step);
}

/* grab tuning, live-settable via FL.dbg.grab.
   poleSign: which side the front elbow breaks toward. It MUST match the sign
     the legs use (+J.front) - measured with -1 the elbow inverted on 100% of
     grab frames (517/517, to 11.2 deg the wrong way) while grounded and
     non-grab air frames were clean, because ikChain displaces the joint about
     cross(pole, to) and flipping the pole flips that side.
   lean: folds the torso toward the board during a grab. Without it the
     shoulder sits at full arm's length from the rail, so ikChain clamps to
     L1+L2-0.004, the elbow locks at ~169 deg interior AND the hand never
     actually reaches the edge it is supposed to be holding. */
const GRAB = { poleSign: 1, lean: 1, tuck: 0.30, dbg: null };

/* ---- secondary motion -------------------------------------------------
   Every pose term above this is an INSTANTANEOUS function of edge, crouch,
   speed and balance, so the rider snaps between correct-looking static poses
   and reads as a puppet. What makes a body look alive is what LAGS and what
   is driven by RATES rather than positions:
     - the shoulders resist the hips instead of yawing further than them
       (measured: chest twist ran -0.36*edge, pelvis -0.13*edge, i.e. the
        torso over-rotated INTO the turn - the opposite of counter-rotation),
     - the arms swing from turn RATE, not from a canned sine,
     - the spine leans against real centrifugal load (speed x yaw rate), so
       the same edge angle at 30 m/s reads heavier than at 10 m/s,
     - a landing compresses and rebounds as a damped spring instead of
       arriving at its static crouch,
     - an ollie charge shows as anticipation before the pop.
   `amt` scales the whole block and 0 makes the pose bit-identical to the
   pre-R5 build, so this is one knob to A/B or to disable. Filter constants
   are rates (1-exp(-k*dt)) so a slow frame cannot overshoot them. */
let RUT_K = 0.92;   // how far into its own rut the board sits (live: FL.dbg.rutK)
const SEC = {
  amt: 1,          // master gate; 0 == shipped pose exactly
  omK: 7.0,        // body inertia: how fast the torso catches the board's turn
  latK: 4.5,       // slower still - load builds over the arc
  /* MEASURED over a scripted slalom (974 grounded frames): |omega| p50 0.76,
     p90 1.09, max 1.42 rad/s; lateral load p50 0.98, p90 2.20, max 3.66 g.
     Both drivers are therefore soft-saturated (tanh) rather than clamped - a
     hard clamp would flat-top half of all frames and turn a continuous term
     into a step, which is the same mistake as a threshold inside an identity
     formula. tanh is linear near zero and never exceeds 1. */
  omN: 1.15,       // rad/s that maps to ~0.76 of full swing
  latN: 1.80,      // g that maps to ~0.66 of full lean
  cr: 0.30,        // counter-rotation, rad at full turn
  arm: 0.34,       // arm swing from turn rate
  lat: 0.26,       // spine lean from centrifugal load
  head: 0.26,      // head leads into the turn
  /* landing: a velocity impulse into a damped spring, so peak compression is
     v0/omega_d * exp(-zeta*omega_n*t_peak). omega_n 7.5, zeta 0.60 puts the
     bottom of the absorption 0.155 s after touchdown, which is about how long
     a real rider takes to soak a drop; 128/12.4 bottomed out in 67 ms and read
     as a flinch. MEASURED depth/settle: 4 m/s 3.5cm/0.40s, 8 m/s 7.0cm/0.43s,
     11 m/s 9.5cm/0.75s, 16 m/s 13.9cm/0.82s; worst-case full tuck + 16 m/s
     leaves the knee at 43 deg and the boot still pinned to its binding. */
  land: 0.15,      // impulse (m/s of spring velocity) per m/s of impact
  landK: 56,       // stiffness (omega_n 7.48 rad/s)
  landD: 9.0,      // damping (zeta 0.60)
  landMax: 0.15,   // safety net only (m): impact is clamped at 16 m/s, which
                   // folds 13.9cm, so this never engages in play
  ant: 0.16,       // ollie anticipation from charge
  dbg: null
};
/* ---- wipeout pose (R3) -------------------------------------------------
   The shipped 'down' pose was the RIDING pose driven to two extremes at once
   - crouch pinned to 1 AND balance 0 - and those two stack into a fetal
   ball. MEASURED against the riding pose: knees 55/69 deg (riding 136/165),
   crouch pinned at its 0.235 max clamp, hands 41cm from the head, and a
   bone bbox 20% SMALLER than riding. It is also a STATUE: every term is a
   constant of the state, so the only thing that moves for the whole 2.5s of
   'down' is the root spin, which reads as a rigid object rolling.
   A wipeout is the opposite shape: the limbs are thrown OUT and they move.
   So this block extends the body and drives it from the tumble angle the
   root spin already advances, with three mutually prime rates so arms, legs
   and spine are never in phase (in phase reads as calisthenics, not a
   crash). The boots stay IK-pinned to the bindings, so the legs are
   extended by DROPPING THE BOARD away from the hips - the same lever as the
   grab tuck, inverted - rather than by fighting the leg IK.
   `amt` 0 restores the shipped ball exactly, which keeps the review surface
   of this change to one rider state. */
const CRASH = {
  amt: 1,
  crouch: 0.42,    // fraction of the full crouch range (shipped: a hard 1)
  crAmp: 0.26,     // legs pump as the body rolls
  board: -0.11,    // drop the deck away from the hips so the legs extend (m)
  boardAmp: 0.05,
  out: 0.92,       // arm abduction - thrown wide (riding runs 0.17-0.57)
  outAmp: 0.30,
  elbow: 0.46,     // forearm fold, rad (shipped 1.71 = tucked to the chest)
  elbAmp: 0.34,
  flail: 0.62,     // arm pitch swing
  arch: 0.42,      // spine arch back
  twist: 0.44,     // spine twist
  head: 0.50,      // head thrown around
  w1: 5.3, w2: 3.1, w3: 2.2,   // out-of-phase rates on the tumble angle
  dbg: null
};
const DOWN_V = new THREE.Vector3(0, -1, 0);
const _rq1 = new THREE.Quaternion(), _rq2 = new THREE.Quaternion();
const _rv1 = new THREE.Vector3(), _rv2 = new THREE.Vector3(), _rv3 = new THREE.Vector3();
const _rs1 = new THREE.Vector3(), _rs2 = new THREE.Vector3(), _rs3 = new THREE.Vector3(),
  _rs4 = new THREE.Vector3();
/* numeric guard: a partial rider object (bots, ghosts) must never put an
   undefined through a quaternion as NaN */
const fin = (v, d) => (Number.isFinite(v) ? v : d);
const BODY_R = 0.138;      // scarf keeps this far off the spine axis

class Poser {
  constructor(bone) {
    this.b = bone;
    this.bindQ = bone.quaternion.clone();
    const inv = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.ax = V3(1, 0, 0).applyQuaternion(inv);     // across the board
    this.ay = V3(0, 1, 0).applyQuaternion(inv);     // up
    this.az = V3(0, 0, 1).applyQuaternion(inv);     // along the board
    this.q = new THREE.Quaternion();
  }
  /* pitch: lean along the board, bank: roll across it, twist: yaw.
     The three args are remembered so a later block can BLEND against the
     pose already written this frame (CRASH does; a Poser is write-only
     otherwise, so reading .b.quaternion back would mean undoing bindQ). */
  set(pitch, bank, twist) {
    this.p = pitch; this.k = bank; this.t = twist;
    const q = this.q.identity();
    if (bank) q.multiply(_rq1.setFromAxisAngle(this.az, bank));
    if (pitch) q.multiply(_rq1.setFromAxisAngle(this.ax, pitch));
    if (twist) q.multiply(_rq1.setFromAxisAngle(this.ay, twist));
    this.b.quaternion.copy(q).multiply(this.bindQ);
  }
}

/* aim a bone's local -Y along a world direction */
function aimBone(bone, dirWorld) {
  bone.parent.getWorldQuaternion(_rq2).invert();
  _rq1.setFromUnitVectors(DOWN_V, dirWorld);
  bone.quaternion.copy(_rq2).multiply(_rq1);
}
/* two-bone IK: put the end of (a -> b -> end) on target, knee toward pole */
function ikChain(a, b, L1, L2, target, pole) {
  a.updateMatrixWorld(true);
  const hip = a.getWorldPosition(_rv1);
  const to = _rv2.subVectors(target, hip);
  const d = clamp(to.length(), Math.abs(L1 - L2) + 0.02, L1 + L2 - 0.004);
  to.normalize();
  // interior knee angle, then the thigh's offset from the hip->target line.
  // (the offset needs the joint's deviation from straight, pi - bend, so the
  //  cosine term is subtracted - with + the chain never closes on the target)
  const bend = Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
  const off = Math.atan2(L2 * Math.sin(bend), L1 - L2 * Math.cos(bend));
  const axis = _rv3.crossVectors(pole, to);
  if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0); else axis.normalize();
  const dirA = to.clone().applyAxisAngle(axis, off);
  aimBone(a, dirA);
  a.updateMatrixWorld(true);
  const knee = b.getWorldPosition(_rv1);
  aimBone(b, _rv2.subVectors(target, knee).normalize());
  b.updateMatrixWorld(true);
}

/* ---- generated clips: code-authored poses -> keyframes -> crossfadeable ----
   Poses are authored in the same (pitch, bank, twist) space the procedural
   poser uses, then sampled into quaternion tracks, so a clip and the
   procedural pose are interchangeable on any bone. */
function makeClips(rig) {
  const posers = {};
  const pv = (name, pitch, bank, twist) => {
    const p = posers[name] || (posers[name] = new Poser(rig.B[name]));
    p.set(pitch, bank, twist);
    const q = p.b.quaternion;
    return [q.x, q.y, q.z, q.w];
  };
  const track = (bone, times, poses) =>
    new THREE.QuaternionKeyframeTrack(bone + '.quaternion', times,
      poses.map(p => pv(bone, p[0], p[1], p[2])).flat());
  const clips = {};
  // shoulder check: look back up the hill and drop the trailing hand
  clips.check = new THREE.AnimationClip('check', 1.0, [
    track('head', [0, 0.34, 0.7, 1.0], [[0.05, 0, 0], [0.02, 0.05, -1.15], [0.02, 0.05, -1.05], [0.05, 0, 0]]),
    track('chest', [0, 0.34, 0.7, 1.0], [[0, 0, 0], [-0.06, 0, -0.30], [-0.06, 0, -0.26], [0, 0, 0]]),
    track('upperB', [0, 0.34, 0.7, 1.0], [[-0.10, 0.26, 0], [0.34, 0.10, 0], [0.30, 0.10, 0], [-0.10, 0.26, 0]]),
  ]);
  // ollie: load the tail, snap the shoulders up, reset
  clips.pop = new THREE.AnimationClip('pop', 0.62, [
    track('upperF', [0, 0.10, 0.26, 0.62], [[-0.25, -0.32, 0], [-0.85, -0.42, 0], [0.75, -0.55, 0], [-0.25, -0.32, 0]]),
    track('upperB', [0, 0.10, 0.26, 0.62], [[-0.12, 0.28, 0], [-0.70, 0.36, 0], [0.62, 0.50, 0], [-0.12, 0.28, 0]]),
    track('spine2', [0, 0.12, 0.30, 0.62], [[0, 0, 0], [0.22, 0, 0], [-0.30, 0, 0], [0, 0, 0]]),
  ]);
  return clips;
}

class RiderBody {
  constructor(scene, jacket, ghost) {
    this.ghost = !!ghost;
    if (typeof G !== 'undefined' && G.dbg) {
      G.dbg.grab = GRAB;
      G.dbg.SEC = SEC;
      /* always pass an explicit amount - a bare toggle is how you silently
         measure the wrong config twice in a row */
      G.dbg.sec = (amt, ov) => {
        if (typeof amt === 'number') SEC.amt = amt;
        if (ov) Object.assign(SEC, ov);
        return Object.assign({}, SEC, { dbg: !!SEC.dbg });
      };
      G.dbg.rutK = v => { if (typeof v === 'number') RUT_K = v; return RUT_K; };
      G.dbg.CRASH = CRASH;
      G.dbg.crash = (amt, ov) => {
        if (typeof amt === 'number') CRASH.amt = amt;
        if (ov) Object.assign(CRASH, ov);
        return Object.assign({}, CRASH, { dbg: !!CRASH.dbg });
      };
    }
    const K = riderKit(jacket);
    const rig = buildSkeleton();
    this.rig = rig; this.pal = K.pal; this.kit = K;

    this.root = new THREE.Group();
    this.root.add(rig.B.root);
    this.skeleton = new THREE.Skeleton(rig.list);
    this.meshes = [];
    for (const [g, mat] of [[K.gSoft, K.matSoft], [K.gHard, K.matHard]]) {
      const m = new THREE.SkinnedMesh(g, mat);
      this.root.add(m);
      m.bind(this.skeleton, new THREE.Matrix4());
      this.meshes.push(m);
    }

    // posers for everything animated procedurally
    const B = rig.B;
    this.P = {};
    for (const n of ['pelvis', 'spine1', 'spine2', 'chest', 'neck', 'head',
      'clavF', 'clavB', 'upperF', 'upperB', 'foreF', 'foreB', 'handF', 'handB',
      'scarf0', 'scarf1', 'scarf2']) if (B[n]) this.P[n] = new Poser(B[n]);
    this.B = B;
    this.bindPelvisY = B.pelvis.position.y;
    this.boardBindQ = B.board.quaternion.clone();
    const L = (a, b) => rig.bind[a].distanceTo(rig.bind[b]);
    this.LL = {
      thigh: L('thighF', 'shinF'), shin: L('shinF', 'footF'),
      thighB: L('thighB', 'shinB'), shinB: L('shinB', 'footB'),
      upper: L('upperF', 'foreF'), fore: L('foreF', 'handF'),
    };
    // foot targets in board space, and the boot's bind orientation on the deck
    this.footLocal = {};
    B.board.updateMatrixWorld(true);
    const binv = new THREE.Matrix4().copy(B.board.matrixWorld).invert();
    for (const f of ['footF', 'footB']) this.footLocal[f] = rig.bind[f].clone().applyMatrix4(binv);
    this.footQLocal = {
      footF: B.footF.getWorldQuaternion(new THREE.Quaternion()),
      footB: B.footB.getWorldQuaternion(new THREE.Quaternion()),
    };
    const bq = B.board.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.footQLocal.footF.premultiply(bq); this.footQLocal.footB.premultiply(bq.clone());
    this.poleF = rig.J.front.clone().normalize();

    /* scarf verlet: anchored at the scarf0 BONE (the ribbon's root under the
       collar) - each particle is the END of one bone */
    const scTip = rig.bind.scarf2.clone()
      .addScaledVector(_rv1.subVectors(rig.bind.scarf2, rig.bind.scarf1), 0.85);
    const scPts = [rig.bind.scarf1, rig.bind.scarf2, scTip];
    this.sc = scPts.map(v => ({ p: v.clone(), o: v.clone(), len: 0 }));
    for (let i = 0; i < this.sc.length; i++)
      this.sc[i].len = scPts[i].distanceTo(i ? scPts[i - 1] : rig.bind.scarf0);
    this.mixer = new THREE.AnimationMixer(this.root);
    this.clips = makeClips(rig);
    this.action = null;

    /* The player casts a real sun-aligned shadow (its own tight 512 map - a
       cascade texel is far too coarse for the hero board shadow). Bots and net
       players used to get a painted blob quad, which read as a sticker lying on
       the snow now that the terrain and the trees cast real shadows. They cast
       into the CASCADES instead: enabling CSC_LAYER *adds* the caster layer
       without clearing layer 0, so they still draw normally in the main pass. */
    this.cast = false;
    if (this.ghost && G.csc) {
      this.cast = true; this._castOn = true;
      for (const m of this.meshes) G.csc.add(m);
    } else if (this.ghost || !G.sh) {
      this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false, toneMapped: false }));
      this.shadow.matrixAutoUpdate = false;
      this.shadow.renderOrder = 2;
      this._sm = new THREE.Matrix4();
      this._sx = new THREE.Vector3(); this._sy = new THREE.Vector3(); this._sz = new THREE.Vector3();
      scene.add(this.shadow);
    }
    if (this.ghost || !G.sh) scene.add(this.root); else G.sh.add(this.root);
    this.wob = 0; this.wobV = 0; this.popT = 0; this.tumble = 0;
    /* secondary motion state (see SEC): filtered drivers + landing spring */
    this.sOm = 0; this.sLat = 0; this.landX = 0; this.landV = 0; this._wasAir = false;
    this.poseT = 0;                        // pose budget accumulator (ghost LOD)
    this._q = new THREE.Quaternion(); this._m = new THREE.Matrix4();
    this._up = new THREE.Vector3(); this._f = new THREE.Vector3(); this._r = new THREE.Vector3();
  }

  popAnim() { this.popT = 1; this.play('pop'); }
  stumble(sev) { this.wobV += sev * 9 * (Math.random() < 0.5 ? -1 : 1); }
  stats() { return this.kit.stats; }

  /* one-shot: fades in over the procedural pose, then hands control back */
  play(name, fade = 0.18) {
    if (!this.clips[name]) return;
    const a = this.mixer.clipAction(this.clips[name]);
    a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false;
    a.fadeIn(fade);
    if (this.action && this.action !== a) this.action.fadeOut(fade);
    a.play();
    this.action = a;
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    if (this.shadow && this.shadow.parent) this.shadow.parent.remove(this.shadow);
    if (this.cast && G.csc) for (const m of this.meshes) G.csc.remove(m);
    this.skeleton.dispose();
  }

  update(r, dt) {
    const p = r.p;
    const air = !r.grounded;
    // orientation basis: up blends to world-up in the air
    const upBlend = clamp(1 - r.airT * 1.8, 0, 1);
    this._up.set(r.n.x * upBlend, lerp(1, r.n.y, upBlend), r.n.z * upBlend).normalize();
    this._f.set(Math.sin(r.yaw), 0, Math.cos(r.yaw));
    const d = this._f.dot(this._up);
    this._f.addScaledVector(this._up, -d).normalize();
    this._r.crossVectors(this._up, this._f).normalize();
    this._m.makeBasis(this._r, this._up, this._f);
    this._q.setFromRotationMatrix(this._m);
    this.root.quaternion.copy(this._q);
    /* PB10 flip: post-multiplying by a LOCAL-X rotation turns the body about its
       OWN lateral axis (the `_r` that went into makeBasis above), which is pitch
       along the long way of the board - a front/back flip. Post- not pre-multiply,
       so it composes on top of the terrain-derived frame rather than replacing it.
       Guarded on a falsy pitch, which covers three cases at once: a rider who
       never flips, every bot, and any network peer from a client that does not
       send the field (undefined is falsy). That last one matters - see the
       `.shadow` landmine in this same file, where a property present on only one
       branch crashed the peer path. */
    if (r.pitch) {
      this.root.quaternion.multiply(_flipQ.setFromAxisAngle(_FLIPAX, r.pitch));
      /* Rotate about the rider's CENTRE OF MASS, not the root. The root sits at
         the board, so a bare rotation swings the head through an arc of radius
         ~1.7 m and buries it under the snow near touchdown - at 180 deg the whole
         body ended up below the surface and the rider all but disappeared.
         Holding the local point (0, FLIP_COM, 0) fixed is what a real flip does
         (rotation about the hips) and it keeps the body inside its own footprint.
         Derivation: the child at local c is at pos + base*flip*c, and we want it
         to stay at pos + base*c, so translate by base*(c - flip*c). */
      _flipC.set(0, FLIP_COM, 0).applyQuaternion(_flipQ);
      _flipD.set(0, FLIP_COM, 0).sub(_flipC).applyQuaternion(this._q);
    } else _flipD.set(0, 0, 0);
    this.root.position.set(p.x, p.y - r.sink * 0.5 - (r.rut || 0) * RUT_K + 0.045, p.z);
    /* AFTER the set, or it is overwritten. Zero unless a flip is in progress. */
    if (_flipD.x || _flipD.y || _flipD.z) this.root.position.add(_flipD);

    // wobble spring for stumbles
    this.wobV += (-this.wob * 42 - this.wobV * 6.5) * dt;
    this.wob += this.wobV * dt;
    this.popT = Math.max(0, this.popT - dt * 4);

    const down = r.state === 'down';
    if (down) {
      this.tumble += dt * (3 + r.speed * 0.25);
      this.root.rotateX(this.tumble * 0.5);
      this.root.rotateZ(this.tumble * 0.33);
    } else this.tumble = 0;

    /* ghost riders pose at a lower rate the further away they are: the root
       transform still moves every frame, so travel stays smooth */
    this.poseT += dt;
    let step = this.poseT;
    if (this.ghost) {
      const dist = G.cam ? G.cam.position.distanceTo(this.root.position) : 0;
      /* only pay for a ghost's shadow while it is inside the near cascade */
      if (this.cast) {
        const on = dist < 125;
        if (on !== this._castOn) {
          this._castOn = on;
          for (const m of this.meshes) on ? m.layers.enable(CSC_LAYER) : m.layers.disable(CSC_LAYER);
        }
      }
      const hz = dist > 130 ? 8 : dist > 45 ? 20 : 60;
      if (this.poseT < 1 / hz) { this.postPose(p); return; }
    }
    this.poseT = 0;
    this.pose(r, step, air, down);
    this.postPose(p);
  }

  /* procedural pose: everything below reads only rider state, so it stays
     continuous with speed, edge and crouch instead of blending canned takes */
  pose(r, dt, air, down) {
    const B = this.B, P = this.P;
    const edge = down ? 0 : clamp(r.edge, -1.3, 1.3);
    const cr = down ? 1 : r.crouch, sp = clamp(r.speed / 30, 0, 1.2), t = r.runT;
    const wob = this.wob;
    const bal = down ? 0 : clamp(r.balance - Math.abs(wob) * 0.35, 0, 1);

    /* a grab pulls the BOARD up to the hand - the arm cannot stretch down to a
       board hanging at full leg extension (measured: shoulder 1.63x arm length
       from the rail, hand floating 27.6cm off it). Eased so the board does not
       pop on the press or the release; the legs follow for free because the
       boots are IK-pinned to the bindings. */
    const grab = !down && r.input && r.input.grab && air;
    this.grabT = clamp((this.grabT || 0) + (grab ? dt / 0.14 : -dt / 0.11), 0, 1);
    const gt = this.grabT * this.grabT * (3 - 2 * this.grabT);

    /* ---- secondary motion drivers (see SEC) ----
       Bots and network ghosts carry a partial rider object, so every field
       read here is guarded: an undefined omega would otherwise reach a
       quaternion as NaN and the whole body would vanish. */
    const sa = down ? 0 : SEC.amt;
    const om = fin(r.omega, 0), spRaw = fin(r.speed, 0);
    const kOm = 1 - Math.exp(-SEC.omK * dt), kLat = 1 - Math.exp(-SEC.latK * dt);
    this.sOm += (om - this.sOm) * kOm;
    this.sLat += (om * spRaw - this.sLat) * kLat;
    const turn = Math.tanh(this.sOm / SEC.omN);           // normalised turn rate
    const latG = Math.tanh(this.sLat / (9.81 * SEC.latN)); // normalised load
    /* landing spring: kicked by the impact speed the sim already measured,
       then left to ring down. Driving CROUCH means the knees fold through the
       boot IK for free, exactly like the grab tuck. */
    if (this._wasAir && !air && !down) {
      const imp = Math.min(fin(r.landImp, fin(r.bump, 0) / 0.09), 16);
      this.landV -= imp * SEC.land;
    }
    this._wasAir = air;
    this.landV += (-this.landX * SEC.landK - this.landV * SEC.landD) * dt;
    this.landX += this.landV * dt;
    if (this.landX < -SEC.landMax) { this.landX = -SEC.landMax; this.landV = 0; }
    else if (this.landX > SEC.landMax * 0.45) { this.landX = SEC.landMax * 0.45; this.landV = 0; }
    const landC = -this.landX * sa;                       // >0 = compressed
    const ant = SEC.ant * clamp(fin(r.charge, 0), 0, 1) * sa * (air ? 0 : 1);
    /* counter-rotation, centrifugal bank and arm swing, distributed below */
    const cnt = SEC.cr * turn * sa, bnk = -SEC.lat * latG * sa;
    const asw = SEC.arm * turn * sa;
    if (SEC.dbg) SEC.dbg = { turn, latG, landC, ant, cnt, bnk, om, sp: spRaw };

    /* board: edge roll + a touch of lift on the tail under load */
    B.board.quaternion.copy(this.boardBindQ);
    B.board.rotation.z = -edge * 0.62;
    B.board.rotation.x = -sp * 0.02 * (air ? 0 : 1);
    B.board.position.y = Math.abs(edge) * 0.03 + GRAB.tuck * gt;

    /* hips: drop into the crouch, bank into the turn */
    const crouchAmt = clamp(cr * 0.235 + (air ? 0.085 : 0) - this.popT * 0.05, 0, 0.235)
      + landC;                              // landing spring rides on top
    B.pelvis.position.y = this.bindPelvisY - crouchAmt;
    const wb = Math.sin(t * 5.3) * 0.012 * (1 - bal) + wob * 0.05;
    P.pelvis.set(0.06 + cr * 0.16 + sp * 0.05, -edge * 0.30 + wb, -edge * 0.13);
    /* spine: split the lean and the counter-rotation over three joints */
    const lean = -0.02 - sp * 0.12 - cr * 0.22 + (air ? -0.06 : 0) + (down ? 0.5 : 0)
      - ant * 0.9 - landC * 1.3;
    P.spine1.set(lean * 0.34, -edge * 0.10 + wob * 0.03 + bnk * 0.34, -edge * 0.07 + cnt * 0.22);
    P.spine2.set(lean * 0.36, -edge * 0.09 + wob * 0.03 + bnk * 0.33, -edge * 0.06 + cnt * 0.30);
    P.chest.set(lean * 0.30 + Math.sin(t * 1.7) * 0.008, -edge * 0.08 + bnk * 0.33,
      -edge * 0.10 + cnt * 0.48);
    /* head: look down the hill, lead the turn a little */
    const hl = SEC.head * turn * sa;
    P.neck.set(0.10 + sp * 0.05, edge * 0.05 - bnk * 0.30, edge * 0.10 + hl * 0.35);
    P.head.set(0.06 + sp * 0.06 - cr * 0.10 + landC * 0.8, edge * 0.04 - bnk * 0.34,
      edge * 0.30 + Math.sin(t * 0.9) * 0.02 + hl * 0.65);

    /* arms: procedural balance pose (a grab overrides it with IK below) */
    const swing = Math.sin(t * 2.1) * 0.06;
    if (!grab) {
      const out = 0.17 + Math.abs(edge) * 0.22 + (1 - bal) * 0.40 + Math.abs(turn) * 0.10 * sa;
      P.clavF.set(0.04 + (1 - bal) * 0.12, -0.05, 0);
      P.clavB.set(0.02, 0.05, 0);
      P.upperF.set(-0.22 - sp * 0.30 + swing - (1 - bal) * 0.5 + wob * 0.16
        - asw * 0.55 - landC * 1.9 + ant * 0.45, -out, -0.12 - edge * 0.10);
      P.upperB.set(-0.10 - sp * 0.14 - swing - wob * 0.16
        + asw * 0.42 - landC * 1.2 + ant * 0.30, out * 0.86, 0.10 - edge * 0.08);
      P.foreF.set(-0.66 - cr * 0.55 - (1 - bal) * 0.5, -0.14, 0);
      P.foreB.set(-0.52 - cr * 0.45, 0.14, 0);
      P.handF.set(0.12, 0, 0); P.handB.set(0.10, 0, 0);
    } else {
      /* fold the torso down toward the rail so the front arm is not asked to
         span more than it has (see GRAB.lean) - the spine lines above ran
         before we knew a grab was active, so they are re-set here. */
      const gl = GRAB.lean * gt;
      P.spine1.set(lean * 0.34 + 0.26 * gl, -edge * 0.10 - 0.13 * gl + bnk * 0.34, -edge * 0.07 + cnt * 0.22);
      P.spine2.set(lean * 0.36 + 0.30 * gl, -edge * 0.09 - 0.15 * gl + bnk * 0.33, -edge * 0.06 + cnt * 0.30);
      P.chest.set(lean * 0.30 + 0.22 * gl, -edge * 0.08 - 0.10 * gl + bnk * 0.33, -edge * 0.10 + cnt * 0.48);
      P.clavF.set(0.18, -0.12, 0);
      P.clavB.set(-0.10, 0.16, 0);
      P.upperB.set(-1.05, -0.55, 0.2);
      P.foreB.set(-0.55, 0, 0);
      P.handF.set(0.3, 0, 0); P.handB.set(0.10, 0, 0);
    }

    /* wipeout: replace the fetal statue with a thrown-out, moving body.
       Runs LAST so it overrides whatever the riding terms wrote, and blends
       against them through `amt` so 0 is the shipped pose exactly. */
    if (down && CRASH.amt > 0) {
      const C = CRASH, a = clamp(C.amt, 0, 1), ph = this.tumble;
      const s1 = Math.sin(ph * C.w1), s2 = Math.sin(ph * C.w2 + 2.1),
        s3 = Math.sin(ph * C.w3 + 4.2), c1 = Math.cos(ph * C.w1 * 0.7 + 1.1);
      const L = (was, now) => lerp(fin(was, 0), now, a);
      const S = (n, pi, bk, tw) => P[n] && P[n].set(L(P[n].p, pi), L(P[n].k, bk), L(P[n].t, tw));
      /* legs: partly extended and pumping - never the fetal 55 deg. The
         boots are pinned to the bindings, so extension comes from dropping
         the deck away from the hips, not from fighting the leg IK. */
      const ca = clamp(0.235 * (C.crouch + C.crAmp * s1), 0, 0.235);
      B.pelvis.position.y = this.bindPelvisY - lerp(crouchAmt, ca, a);
      B.board.position.y = lerp(B.board.position.y, C.board + C.boardAmp * s2, a);
      /* hips and spine: arch back and twist, out of phase with the arms */
      const arch = C.arch * (0.45 + 0.55 * s3), tw = C.twist * s2;
      S('pelvis', 0.10 + 0.22 * s2, 0.30 * s3, 0.26 * s1);
      S('spine1', -arch * 0.50, tw * 0.30, 0.30 * s1);
      S('spine2', -arch * 0.60, tw * 0.34, 0.26 * c1);
      S('chest', -arch * 0.50, tw * 0.36, 0.20 * s2);
      S('neck', -C.head * 0.50, C.head * 0.50 * s3, C.head * 0.40 * s1);
      S('head', -C.head * 0.60, C.head * 0.40 * s2, C.head * 0.50 * c1);
      /* arms: thrown wide, elbows open, each limb on its own phase */
      const o1 = C.out + C.outAmp * s1, o2 = C.out + C.outAmp * s3;
      S('clavF', 0.16 * s2, -0.14, 0);
      S('clavB', 0.16 * s3, 0.14, 0);
      S('upperF', -0.30 + C.flail * s2, -o1, 0.30 * s1);
      S('upperB', -0.30 - C.flail * s3, o2, -0.30 * c1);
      S('foreF', -(C.elbow + C.elbAmp * s3), -0.10, 0);
      S('foreB', -(C.elbow + C.elbAmp * s1), 0.10, 0);
      S('handF', 0.20 * s1, 0, 0);
      S('handB', 0.20 * s3, 0, 0);
      if (C.dbg) C.dbg = { ph: +ph.toFixed(2), ca: +ca.toFixed(3), s1: +s1.toFixed(2), s2: +s2.toFixed(2) };
    }

    /* one-shot generated clips overwrite only the bones they animate */
    if (this.mixer) this.mixer.update(dt);
    /* world matrices must be current before any IK reads them */
    this.root.updateMatrixWorld(true);

    /* legs: pin the boots to the bindings, wherever the board went */
    const boardM = B.board.matrixWorld;
    for (const [th, sh, ft, l1, l2] of [
      ['thighF', 'shinF', 'footF', this.LL.thigh, this.LL.shin],
      ['thighB', 'shinB', 'footB', this.LL.thighB, this.LL.shinB]]) {
      const target = _rs1.copy(this.footLocal[ft]).applyMatrix4(boardM).clone();
      ikChain(B[th], B[sh], l1, l2, target, this.poleF);
      // boot stays flat on the deck: reapply its bind orientation in board space
      const wq = B.board.getWorldQuaternion(_rq2).multiply(this.footQLocal[ft]);
      B[ft].parent.getWorldQuaternion(_rq1).invert();
      B[ft].quaternion.copy(_rq1).multiply(wq);
      B[ft].updateMatrixWorld(true);
    }

    /* grab: the front hand reaches an actual point on the board rail, so it
       lands on the edge at any bank angle instead of floating near it */
    if (grab) {
      const tgt = _rv3.set(0.115, 0.03, 0.17).applyMatrix4(boardM).clone();
      const reach = this.LL.upper + this.LL.fore;
      const need = GRAB.dbg ? B.upperF.getWorldPosition(_rs2).distanceTo(tgt) : 0;
      ikChain(B.upperF, B.foreF, this.LL.upper, this.LL.fore, tgt,
        _rv2.copy(this.rig.J.front).multiplyScalar(GRAB.poleSign).normalize().clone());
      if (GRAB.dbg) {
        const d = GRAB.dbg;
        d.n = (d.n || 0) + 1;
        d.reach = reach;
        d.need = need;                                   // shoulder -> rail
        d.ratio = need / reach;                          // >1 = cannot reach
        d.handErr = B.handF.getWorldPosition(_rs3).distanceTo(tgt);
      }
    }

    /* scarf: verlet chain hanging off the neck, blown by the apparent wind */
    const anchor = B.scarf0.getWorldPosition(_rv1).clone();
    const windZ = -r.speed * 0.034 - 0.15;
    const g = -7.5;
    let prev = anchor;
    for (let i = 0; i < this.sc.length; i++) {
      const s = this.sc[i];
      const vx = (s.p.x - s.o.x), vy = (s.p.y - s.o.y), vz = (s.p.z - s.o.z);
      s.o.copy(s.p);
      s.p.x += vx * 0.86 + (Math.sin(t * 7 + i) * 0.02) * dt;
      s.p.y += vy * 0.86 + g * dt * dt;
      s.p.z += vz * 0.86 + windZ * dt * dt * 9;
      _rv2.subVectors(s.p, prev);
      const dl = _rv2.length() || 1e-5;
      s.p.copy(prev).addScaledVector(_rv2, s.len / dl);
      // keep it off the body: push out of a capsule along pelvis -> neck
      B.pelvis.getWorldPosition(_rs1); B.neck.getWorldPosition(_rs2);
      _rs3.subVectors(_rs2, _rs1);
      const L2 = _rs3.lengthSq() || 1e-6;
      const u = clamp(_rs4.subVectors(s.p, _rs1).dot(_rs3) / L2, 0, 1);
      _rs4.copy(_rs1).addScaledVector(_rs3, u);
      _rs4.subVectors(s.p, _rs4);
      const dr = _rs4.length() || 1e-5;
      if (dr < BODY_R) s.p.addScaledVector(_rs4, (BODY_R - dr) / dr);
      prev = s.p;
    }
    prev = anchor;
    for (let i = 0; i < this.sc.length; i++) {
      const b = B['scarf' + i];
      aimBone(b, _rv2.subVectors(this.sc[i].p, prev).normalize());
      b.updateMatrixWorld(true);
      prev = this.sc[i].p;
    }
    B.scarf2.updateMatrixWorld(true);
  }

  /* blob shadow for ghosts: offset away from the sun, stretched along its
     azimuth and laid in the slope plane */
  postPose(p) {
    const sh = this.shadow;
    if (!sh) return;
    const sun = WU.uSun.value;
    const sl = Math.hypot(sun.x, sun.z) || 1;
    const hgt = clamp(p.y - terrainH(p.x, p.z), 0, 30);
    const off = hgt * sl / Math.max(sun.y, 0.15);
    const sx = p.x - sun.x / sl * off, sz = p.z - sun.z / sl * off;
    const gy = terrainH(sx, sz);
    const sc = 1 - clamp(hgt / 18, 0, 0.6);
    const wid = 1.9 * sc, len = (2.0 + sl / Math.max(sun.y, 0.2) * 0.7) * sc;
    const nr = terrainNormal(sx, sz, 1.6);
    const SY = this._sy.set(nr.x, nr.y, nr.z).normalize();
    const SZ = this._sz.set(-sun.x / sl, 0, -sun.z / sl);
    SZ.addScaledVector(SY, -SZ.dot(SY)).normalize();
    const SX = this._sx.crossVectors(SY, SZ).normalize();
    const M = this._sm;
    M.makeBasis(SX.multiplyScalar(wid), SY, SZ.multiplyScalar(len));
    M.setPosition(sx + nr.x * 0.09, gy + 0.09, sz + nr.z * 0.09);
    sh.matrix.copy(M);
    sh.material.opacity = 0.6 * sc * sc;
  }
}

/* PB10 flip scratch. Deliberately NOT the shared _rq1/_rq2 the bone poser uses -
   those are reused inside the same update() and aliasing them would corrupt a
   pose. Module-level const is initialised when the bundle loads, long before any
   update() call, so declaring it after the class is safe. */
const _flipQ = new THREE.Quaternion(), _FLIPAX = new THREE.Vector3(1, 0, 0);
const _flipC = new THREE.Vector3(), _flipD = new THREE.Vector3();
/* Approx hip height of the rider model in metres - the flip pivot. */
const FLIP_COM = 0.95;
