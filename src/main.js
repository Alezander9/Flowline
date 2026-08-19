/* ------------------------------------------------- boot & main loop */
const QS = new URLSearchParams(location.search);
if (QS.has('seed')) SEED = hashStr(QS.get('seed'));
const LQ = QS.has('lq');
const PREVIEW = QS.has('preview');
const START_Z = +(QS.get('z') || 0);

const G = {
  ren: null, scene: null, cam: null, sky: null, terr: null, world: null, rider: null, fx: null,
  t: 0, dt: 0, acc: 0, frames: 0, fpsT: 0, fps: 60, paused: false, started: false,
  /* BOOT TIER. This literal is deliberately NOT QLEVELS[n] - it used to sit at
     lvl 2 with px 1.00, i.e. FULL pixel ratio (up to 2x DPR) plus 1024/2048
     shadow cascades, from the very first frame, and only autoQuality could walk
     it back. On a weak iGPU that is the heaviest the game ever gets served at
     the exact moment it is also running its one-off startup bakes, and
     autoQuality cannot rescue it in time (see the qCool arithmetic below), so a
     freeze ~1s in was the first thing such a machine ever showed the player.
     Booting at tier-1 pixel ratio costs a good machine ~4s of slightly softer
     image before the existing promote path takes it up, and costs a weak one
     nothing at all. The other caps stay below QLEVELS[1] so this is still the
     cheapest start we have ever shipped. */
  /* deform: 1 here even though QLEVELS[1].deform is 0, for the same reason this
     literal already carries detail: 1 against QLEVELS[1].detail 0 - setQuality()
     is NOT called at boot (see the note above initRender), so this object IS the
     shipped opening tier, and the board has to leave a trail in the first second
     of the first run. A machine that cannot afford it reaches tier 0 or 1 via the
     emergency demote within a frame or two and loses deform there. Anything
     gated on G.q.deform must therefore tolerate this being 1 at lvl 1. */
  q: { lvl: 1, trees: true, px: 0.75, aa: !LQ, detail: 1, deform: 1, capNear: 420, capFar: 1100, nearD: 150, dust: 130 },
  /* ctxLost: the GL context is gone right now, so rendering is a no-op and the
     sim must not advance. gpuReset: it has been lost at least once this run, so
     never promote back up again. qPin: null = the autoQuality ladder is in
     charge; a number = the player pinned that tier in settings. */
  ctxLost: false, gpuReset: false, qPin: null,
  keys: {}, dbg: {}
};

function initRender() {
  const canvas = document.createElement('canvas');
  document.body.insertBefore(canvas, document.getElementById('ui'));
  const ren = new THREE.WebGLRenderer({ canvas, antialias: G.q.aa, powerPreference: 'high-performance', stencil: false });
  ren.setPixelRatio(Math.min(devicePixelRatio || 1, 2) * G.q.px);
  ren.setSize(innerWidth, innerHeight);
  ren.outputColorSpace = THREE.LinearSRGBColorSpace;
  ren.toneMapping = THREE.NoToneMapping;
  ren.setClearColor(0x9ec8e8, 1);
  G.ren = ren;

  /* ---------------------------------------------- WEBGL CONTEXT LOSS
     On Windows the driver watchdog (TDR) resets the GPU when a single draw
     takes longer than ~2s, and a weak integrated GPU can reach that on our
     startup bakes. WITHOUT THESE TWO HANDLERS THAT LOSS IS SILENT AND FATAL:
     ren.render() quietly becomes a no-op, but requestAnimationFrame keeps
     firing, Web Audio keeps playing on its own thread and the fixed-step sim
     keeps integrating - so the canvas composites the LAST GOOD FRAME FOR EVER
     while the speed and distance readouts carry on climbing. That is exactly
     the "picture freezes but the sound and the distance keep going, sometimes
     it comes back and sometimes it never does" report.
     preventDefault() is what makes the context restorable AT ALL: without it
     the browser never fires webglcontextrestored, which is the "never does"
     half of that sentence. */
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    G.ctxLost = true;
    const el = document.getElementById('gpuLost');
    if (el) el.classList.add('on');
  }, false);
  canvas.addEventListener('webglcontextrestored', () => {
    G.ctxLost = false;
    /* Always come back at the CHEAPEST tier: whatever we were drawing when the
       driver gave up is by definition too heavy for this GPU. Pin it so the
       promote path cannot walk straight back into a second reset - the player
       can still raise it by hand from the pause menu if they want to gamble. */
    G.gpuReset = true;
    /* Unconditional now, pin or no pin: the tier that just cost this player their
       GL context is not a tier to restore them into. The pin survives as a
       ceiling, and G.gpuReset keeps the promote path shut for the rest of the run
       anyway, so this cannot walk back up. */
    setQuality(0);
    const el = document.getElementById('gpuLost');
    if (el) el.classList.remove('on');
  }, false);
  G.scene = new THREE.Scene();
  G.cam = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.4, 9000);

  WU = {
    /* Low raking sun (~16 deg), strongly across the fall line. The old 35 deg
       near-frontal sun was the flattest light possible: it put almost no shadow
       on the piste, which is why the snow read as a white sheet at any exposure.
       Grazing light rakes every drift and throws tree shadows across the run. */
    uSun: { value: new THREE.Vector3(0.70, 0.22, 0.68).normalize() },
    /* a 16 deg sun has travelled through much more atmosphere: warmer, dimmer */
    uSunCol: { value: new THREE.Color(1.68, 1.16, 0.72) },
    uSkyCol: { value: new THREE.Color(0.28, 0.40, 0.70) },
    uGndCol: { value: new THREE.Color(0.42, 0.40, 0.40) },
    uFogA: { value: new THREE.Color(0.62, 0.64, 0.86) },
    uFogB: { value: new THREE.Color(1.14, 0.90, 0.68) },
    /* the baked sky, so applyFog()'s far clamp can fade the far field into the
       actual backdrop instead of a constant. Filled in right after `new Sky`
       below; every material shallow-copies WU, so they share this {value}
       object by reference and see the assignment. */
    uSkyMap: { value: null },
    /* Clear-air extinction. This was 0.0014 (an e-folding distance of only 714 m,
       i.e. 43% fog at 400 m) which is a HAZY day, not the bluebird day the sky
       bake depicts - and it was the single dominant cause of the washed-out
       look. MEASURED on an Apple M5 Pro over 763 trees at 200-600 m, real
       framebuffer pixels: the forest band's median sRGB went 185 -> 109 as this
       went 0.0014 -> 0.0003, while the snow behind it barely moved (p95 213 ->
       193). Photographic reference (uploads/mountain_render.jpeg) has its
       forested bands at median 105, so 0.0003 is matched to a real photo rather
       than picked by eye. NOTE this dwarfs vertex-colour work at distance: at
       0.0014, swapping the far tree LOD between near-white and near-black moved
       the same median by 4 (185 -> 181), because 60-70% of every distant pixel
       WAS fog. Fix atmosphere before grading any distant asset.
       The far ranges do NOT depend on this - applyFog() clamps with
       max(f, smoothstep(1150, 2350, dist)), so the horizon still melts into the
       sky. Squalls compensate via a bigger multiplier in weather.js. */
    uFogD: { value: 0.0003 },
    uTime: { value: 0 }
  };
  /* shared by reference, so one write regrades sky + snow + props together */
  Object.assign(WU, TONE);
  /* TIME OF DAY - resolved and applied HERE, which is why it is free. The sky
     bakes exactly once inside the Sky ctor off this same uSun (shared by
     reference); the tree impostor atlas bakes once inside `new World` below; and
     Weather captures uSunCol/uSkyCol/uFogA as its clear-air BASELINE at its own
     construction. Setting the sun before all three costs nothing at all: no
     relight, no second atlas bake, no baseline fixup. Doing it even one line
     later costs all three - see setTod() in ui.js, which has to pay them. */
  G.tod = todResolve();
  G.todSun = applySun(WU, G.tod.hour);
  G.sky = new Sky(G.scene, ren, WU);
  WU.uSkyMap.value = G.sky.rt.texture;   // see applyFog(); survives Sky.relight()
  G.sh = new SunShadow(G.scene);
  /* world sun shadows. Created BEFORE the terrain and the world so their
     materials pick the cascade uniforms up through WU / this.uni. */
  G.csc = new SunCascades(G.scene, CSC_SPEC.map(s => Object.assign({}, s)));
  Object.assign(WU, G.csc.uni);
  /* setQuality() is not called at boot (only on a tier change, or ?lq), so the
     starting tier would otherwise inherit the 2048^2 CSC_SPEC default no matter
     how weak the device. Cascade size must follow the declared tier from frame 1. */
  if (QLEVELS[G.q.lvl] && QLEVELS[G.q.lvl].csc) {
    G.csc.setSize(0, QLEVELS[G.q.lvl].csc[0]);
    G.csc.setSize(1, QLEVELS[G.q.lvl].csc[1]);
  }
  /* Deformation cascade (phase 5). Like SunCascades it must exist BEFORE the
     terrain and the world, so every snow material picks its uniforms up by
     reference through WU / this.uni. */
  G.df = new DeformCascade(ren, THREE);
  Object.assign(WU, G.df.uni);
  G.terr = new TerrainMesh(G.scene);
  /* The drawn mountain now carries a HOLE where the 0.25 m fine patch sits, so
     the sun cascades must cast from the unholed proxy - it shares every vertex
     attribute but keeps the FULL index - instead of from the drawn mesh. */
  G.csc.addProxy(G.terr.shadowProxy);      // the mountain self-shadows
  Object.assign(G.terr.uni, {}); // terrain has its own copies below
  for (const k of ['uSun', 'uSunCol', 'uSkyCol', 'uGndCol', 'uFogA', 'uFogB', 'uFogD', 'uTime', 'uTM', 'uExp', 'uSkyMap']) {
    G.terr.uni[k] = WU[k];
  }
  G.terr.mesh.material.uniforms = G.terr.uni;
  G.terr.uni.uDetail.value = G.q.detail;
  /* Share the wind-relief uniforms OUT of the terrain into WU, by reference, so
     the carve trail gets the same wind relief from the same numbers. Must happen
     before Wake is constructed - its material snapshots the keys of WU. */
  for (const k of ['uPxK', 'uWind', 'uSast', 'uDetail']) WU[k] = G.terr.uni[k];
  /* 0.25 m fine patch (phase 2a), built AFTER the uniform plumbing above: its
     material takes a SHALLOW copy of terr.uni, so the shared WU objects must
     already be in place or the patch would shade from stale private copies. */
  G.terr.fine = new FinePatch(G.scene, G.terr);
  /* Radial far skirt (PB8): the core clipmap's width grows along the FALL LINE
     only, so a yawed view runs out of ground at ~78 m laterally and silhouettes
     a pale shelf against the dome. Built after the plumbing for the same reason
     the fine patch is - it shallow-copies terr.uni. */
  /* Guarded on the class EXISTING, so terrain_skirt.js can be held out of
     build.py's ORDER without this line throwing and taking the whole boot with
     it. It is currently held out: the PB8 far skirt is written and its geometry
     verified, but its seam-pixel and perf gates need the M5, and prod is the only
     origin. Every consumer below already tests G.terr.skirt, so absence is a
     supported state rather than a special case. */
  if (typeof TerrainSkirt !== 'undefined') G.terr.skirt = new TerrainSkirt(G.scene, G.terr);
  G.world = new World(G.scene, G.q, ren);
  G.wx = new Weather(G.scene, WU);

  addEventListener('resize', () => {
    G.ren.setSize(innerWidth, innerHeight);
    G.cam.aspect = innerWidth / innerHeight;
    G.cam.updateProjectionMatrix();
  });
}

/* ---------------- preview camera (debug) ---------------- */
const PV = { z: 20, x: 0 };
function previewCam(dt) {
  PV.z += 22 * dt;
  PV.x = pisteC(PV.z);
  const y = terrainH(PV.x, PV.z);
  G.cam.position.set(PV.x - 6, y + 4.5, PV.z - 9);
  G.cam.lookAt(pisteC(PV.z + 40), terrainH(pisteC(PV.z + 40), PV.z + 40) + 1.5, PV.z + 40);
}

/* ---------------- title camera: a slow drift over the drop-in ---------------- */
function cineCam(dt) {
  const t = G.t;
  const r = G.rider;
  const a = t * 0.075;
  // portrait keeps the wide title framing (the rider is scenery behind the card);
  // only a short landscape viewport needs the camera pulled in
  const vf = viewFit();
  const rad = (13 + Math.sin(t * 0.11) * 2.5) * (1 - 0.20 * vf.s);
  const cx = r.p.x + Math.sin(a) * rad, cz = r.p.z - 4 + Math.cos(a) * rad * 0.7;
  const gy = terrainH(cx, cz);
  G.cam.position.set(cx, Math.max(r.p.y + 4.6 * (1 - 0.20 * vf.s) + Math.sin(t * 0.15) * 0.8, gy + 2.2), cz);
  G.cam.lookAt(r.p.x, r.p.y + 1.3, r.p.z + 1.5);
  const tf = 60 - 5 * vf.s;
  if (Math.abs(G.cam.fov - tf) > 0.2) { G.cam.fov = approach(G.cam.fov, tf, 1.5, dt); G.cam.updateProjectionMatrix(); }
  r.body.update(r, dt);
}

/* ---------------- loop ---------------- */
const FIXED = 1 / 120;
let lastT = 0;
const LOUD = { s: [], t: null };

/* simulation only (input -> physics). used by the loop and by the trailer */
function stepWorld(dt) {
  G.t += dt; G.dt = dt;
  WU.uTime.value = G.t;
  readInput(dt);
  if (AUTO.on) autoDrive(G.rider, dt);
  G.acc += dt;
  let steps = 0;
  while (G.acc >= FIXED && steps < 8) { G.rider.step(FIXED); G.acc -= FIXED; steps++; }
  if (steps === 8) G.acc = 0;
  G.rider.postStep(dt);
  BOTS.update(Math.min(dt, 0.05));
}

/* streaming + draw. camUpdate=false lets a caller drive the camera itself */
function present(dt, camUpdate) {
  if (camUpdate !== false) updateCamera(dt);
  const cp = G.cam.position;
  G.terr.update(G.rider.p.x, G.rider.p.z, false);
  if (G.terr.skirt) G.terr.skirt.update(G.rider.p.x, G.rider.p.z);
  G.terr.setView(G.cam, G.ren);
  G.world.update(G.rider.p.x, G.rider.p.z, G.t);
  G.sky.update(G.cam, G.t, G.ren);
  if (G.wx) G.wx.update(G.cam, G.rider.p.z, dt, 3.5);
  if (G.fx) G.fx.update(dt);
  if (G.wake) G.wake.update(G.rider.onPlat ? null : G.rider, G.t);   // PB4: no trench under the house
  if (G.df) G.df.update(G.stamps, G.rider.p.x, G.rider.p.z);        // after the wake: this frame's stamps are in
  G.csc.render(G.ren, G.rider.p, WU.uSun.value);
  G.sh.render(G.ren, G.rider.p, WU.uSun.value);
  G.ren.render(G.scene, G.cam);
}

/* WHY frame() IS WRAPPED. requestAnimationFrame(frame) is deliberately the FIRST
   statement, so the loop survives anything that goes wrong later in the same
   frame - but that also means a throw between the sim and the final
   G.ren.render() re-arms the loop and repeats for ever, in total silence. The
   reported symptom is exact and worth recording: sound keeps playing and the
   distance readout keeps climbing (stepWorld already ran), the picture is frozen
   (the render at the end of the frame never happens), and pausing yields exactly
   ONE fresh frame - because the paused branch renders and returns BEFORE reaching
   whatever is throwing. Note this is NOT the context-loss signature: that path
   halts the sim too, on purpose, so a climbing distance readout rules it out.
   Catching here cannot fix the underlying throw, but it turns an invisible freeze
   into a console error with a stack and a visible banner, which is the difference
   between a bug report and a diagnosis. G.dbg.frameErr() reads it back. */
let frameErrN = 0, frameErrMsg = '', frameErrStack = '';
function frame(now) {
  requestAnimationFrame(frame);
  try { frameBody(now); } catch (e) {
    frameErrN++;
    frameErrMsg = (e && e.message) || String(e);
    if (frameErrN === 1) {
      frameErrStack = (e && e.stack) || '';
      console.error('[flowline] frame() threw - the picture would have frozen here while the sim kept running:', e);
      if (typeof UI !== 'undefined' && UI.warn) UI.warn('graphics error - see console');
    }
    /* RECOVERY DRAW. This is what actually cures the reported symptom rather than
       just labelling it: whatever threw, the scene graph is still a drawable
       scene, so present it. A frame that is one subsystem out of date beats a
       canvas holding the same image for ever while the speed and distance
       readouts climb - and it is exactly what the paused branch was accidentally
       proving was possible, since pausing returned ONE good frame from this same
       renderer. Wrapped again because if the renderer itself is the thing
       throwing, this must not turn one broken frame into an unhandled error. */
    try { G.ren.render(G.scene, G.cam); } catch (e2) { }
  }
}
/* Read the throw back out of a running session without needing the console
   history - "has the frame loop been failing, how often, and where". n stays 0 on
   a healthy build, so this is also the check to run before blaming a freeze on
   anything else. */
G.dbg.frameErr = () => ({ n: frameErrN, msg: frameErrMsg, stack: frameErrStack });
function frameBody(now) {
  if (TR.on) return;                       // the trailer drives its own clock
  const nowS = now / 1000;
  // dbg.fixdt pins the timestep so a slow test machine still exercises the
  // frame-rate-dependent paths (camera springs) exactly as a 60fps device does
  const raw = nowS - lastT;
  let dt = G.dbg.fixdt || Math.min(Math.max(raw, 0), 0.08);
  if (!lastT) dt = 1 / 60;
  lastT = nowS;
  if (document.hidden) return;
  /* A lost context cannot draw, so DO NOT advance the sim or the audio either -
     that is what turns a recoverable GPU reset into "the picture froze but the
     run carried on without me". Hold everything until the restore handler. */
  if (G.ctxLost) return;
  /* EMERGENCY DEMOTION. autoQuality below only gets a vote once per 0.5s fps
     window and is gated by qCool, which starts at 6: on a machine drawing
     ~0.3fps each window IS one frame, so the first possible demotion is ~18s
     away and then arrives one tier at a time. A machine already spending most
     of a second per frame is a machine about to trip the driver watchdog, so
     react to the SINGLE frame rather than to an average - by the time an
     average exists the context is gone. */
  /* A PIN NO LONGER SUPPRESSES THIS. It used to require G.qPin === null, which
     meant the player who pinned HIGH to see the game at its best was the only
     player with no watchdog protection at all - and because the pin persists in
     localStorage, a machine that could not hold the pinned tier could not boot
     its way out of it either: you need a live frame to reach the pause menu to
     undo it. (?lq is the only escape and no player knows it.) A pin is a CEILING
     now, so this can always pull the tier down; only promotion respects it. */
  /* !document.hidden: a hidden tab is throttled to ~1fps, so EVERY frame in it
     trips this 0.4s test. Without this guard, backgrounding the tab for a moment
     demoted the run to tier 0 and it could only climb back one rung at a time. */
  if (raw > 0.4 && !document.hidden && !G.dbg.fixdt && !G.dbg.lockQ && G.q.lvl > 0) {
    setQuality(raw > 1.0 ? 0 : G.q.lvl - 1);
    qCool = 8; qUp = 0;
  }
  G.frames++;
  if (nowS - G.fpsT > 0.5) { G.fps = G.frames / (nowS - G.fpsT); G.frames = 0; G.fpsT = nowS; autoQuality(); if (G.showFps) fpsHud(); }
  if (G.paused) { G.ren.render(G.scene, G.cam); return; }
  if (PREVIEW) {
    G.t += dt; G.dt = dt; WU.uTime.value = G.t;
    previewCam(dt);
  } else if (!G.started) {
    G.t += dt; G.dt = dt; WU.uTime.value = G.t;
    cineCam(dt);
    BOTS.update(Math.min(dt, 0.05));          // riders drop past the start gate
  } else {
    stepWorld(dt);
    updateCamera(dt);
  }
  const cp = G.cam.position;
  G.terr.update(PREVIEW ? PV.x : G.rider.p.x, PREVIEW ? PV.z : G.rider.p.z, false);
  if (G.terr.skirt) G.terr.skirt.update(PREVIEW ? PV.x : G.rider.p.x, PREVIEW ? PV.z : G.rider.p.z);
  G.terr.setView(G.cam, G.ren);
  G.world.update(PREVIEW ? PV.x : G.rider.p.x, PREVIEW ? PV.z : G.rider.p.z, G.t);
  G.sky.update(G.cam, G.t, G.ren);
  if (G.wx) G.wx.update(G.cam, PREVIEW ? PV.z : G.rider.p.z, G.dt, 3.5);
  if (G.fx) G.fx.update(G.dt);
  if (G.wake) G.wake.update(G.started && !PREVIEW && !G.rider.onPlat ? G.rider : null, G.t);
  if (G.df) G.df.update(G.stamps, PREVIEW ? PV.x : G.rider.p.x, PREVIEW ? PV.z : G.rider.p.z);
  if (G.started) { updateHUD(); if (G.net) G.net.tick(G.t); }
  G.csc.render(G.ren, PREVIEW ? PV : G.rider.p, WU.uSun.value);
  G.sh.render(G.ren, G.rider.p, WU.uSun.value);
  G.ren.render(G.scene, G.cam);
}

/* ONE control owns all of this. `deform` deliberately tracks `detail` rather
   than being a knob of its own: deformable snow is the most expensive optional
   system we have (two render-target passes plus every stamp quad, every frame),
   so the two tiers that already decline surface detail decline it too. That is
   what makes LOW a tier that actually works rather than one that merely looks
   worse - before this, NO tier switched deform off, because QLEVELS had no
   deform field at all and DeformCascade was built and updated unconditionally.
   dust must stay <= FX.dustN (260): the buffer is allocated once at that size
   and a larger draw range reads off the end of it. */
const QLEVELS = [
  { px: 0.55, capNear: 200, capFar: 340, nearD: 90, farD: 430, dust: 60, detail: 0, deform: 0, trees: true, lod: 1.0, csc: [512, 512] },
  { px: 0.75, capNear: 420, capFar: 1100, nearD: 150, farD: 620, dust: 130, detail: 0, deform: 0, trees: true, lod: 1.5, csc: [1024, 1024] },
  { px: 1.00, capNear: 1200, capFar: 3200, nearD: 300, farD: 1000, dust: 260, detail: 1, deform: 1, trees: true, lod: 2.4, csc: [1024, 2048] },
  { px: 1.00, capNear: 3200, capFar: 6000, nearD: 470, farD: 1500, dust: 260, detail: 1, deform: 1, trees: true, lod: 3.2, csc: [2048, 2048] }
];
function setQuality(lvl) {
  lvl = clamp(lvl, 0, 3);
  G.q.lvl = lvl;
  Object.assign(G.q, QLEVELS[lvl]);
  G.ren.setPixelRatio(Math.min(devicePixelRatio || 1, 2) * G.q.px);
  if (G.terr) G.terr.uni.uDetail.value = G.q.detail;
  /* Deformable snow, owned outright by the tier. Both halves matter: setAmount(0)
     is what makes every snow shader skip its cascade sampling, and it is ALSO
     what makes DeformCascade.update() bail before its two render-target passes
     (see the early-out in deform.js). Without that early-out this line would
     have hidden the feature while still paying for all of it.
     uDfSh is the self-shadow / sky-occlusion pair, whose shader branches read the
     same cascade, so they go off and come back WITH it - otherwise LOW would keep
     shading ruts it is no longer drawing. */
  if (G.df) {
    const on = G.q.deform ? 1 : 0;
    G.df.setAmount(on);
    G.df.uni.uDfSh.value.set(on, on);
  }
  if (G.sh) G.sh.enable(true);
  if (G.csc && G.q.csc) { G.csc.setSize(0, G.q.csc[0]); G.csc.setSize(1, G.q.csc[1]); }
  setLod(G.q.lod || 1);
  if (G.terr) G.terr.update(G.rider ? G.rider.p.x : 0, G.rider ? G.rider.p.z : 0, true);
  if (G.terr && G.terr.skirt) G.terr.skirt.update(G.rider ? G.rider.p.x : 0, G.rider ? G.rider.p.z : 0);
  document.body.classList.toggle('noblur', lvl < 2);
  if (G.wx) G.wx.setQuality(G.q);
  /* Re-place trees/rocks for the new caps and LOD sizes, but START the pass and
     let update()'s existing 3 ms slicer finish it - do NOT run it synchronously.
     MEASURED: the synchronous full pass is 9.7-21.6 ms and it made a tier change
     the single worst frame of an entire run (46.4 ms at the tier 2->3 promotion
     that fires ~6.5 s into EVERY boot). That is backwards for a mechanism whose
     whole job is smoothness, and on a weak device the demote path is triggered
     BY slow frames and then produces the slowest frame of all. The world is
     double-buffered, so the previous placement stays on screen until the new
     pass commits - i.e. for a few frames after a flip, trees keep the old
     tier's LOD, which is exactly what happens during any ordinary pass. */
  if (G.world && G.rider) G.world.beginPlace(G.rider.p.x, G.rider.p.z);
  /* On AUTO the GRAPHICS button reports the tier actually in force, so it has to
     be refreshed from HERE - the ladder and the emergency demote move the tier
     without anyone touching the settings menu. MEASURED before this line: a boot
     that demoted 1->0 left the button reading LOW while the game ran at LOWEST,
     i.e. the control lied about the very thing a player opens it to check. */
  if (typeof UI !== 'undefined' && UI.show_cycGfx) UI.show_cycGfx();
}
let qCool = 6, qUp = 0, qBoot = 0;
function autoQuality() {
  /* A BACKGROUND TAB IS NOT A SLOW GPU. requestAnimationFrame is throttled to
     ~1fps in a hidden tab, so every fps-based verdict here is meaningless while
     hidden - and acting on it is actively harmful: a boot in a background tab
     read as a hopeless machine, demoted to tier 0, and because promotion then
     climbs one rung at a time the player who switched to the tab got a
     permanently degraded run. MEASURED on an Intel Arc laptop that holds tier 3
     at a locked 60fps. Do nothing until we can actually see the frames. */
  if (document.hidden) return;
  /* ONE-SHOT JUMP TO HIGH. The BOOT TIER literal is deliberately cheap because
     full pixel ratio DURING the one-off startup bakes froze weak iGPUs ~1s in.
     That protection only ever needed to cover the bakes - but the promote ladder
     below then took ~28s to reach tier 3 (qCool 14 windows = 7s, plus qUp, per
     rung), so a machine that can hold HIGH at 60fps spent its first half-minute
     at 0.75 pixel ratio with no deform and no surface detail. This takes it to
     HIGH in one step instead, after 4 fps windows (~2s), by which point the
     bakes are done and G.fps finally means something. A machine that is NOT
     coping fails the fps test, never takes the jump, and is left to the ladder
     and the emergency demote exactly as before - so this cannot brick a weak
     device, it only stops punishing a strong one. */
  if (qBoot < 9 && ++qBoot === 4) {
    qBoot = 9;
    if (G.fps > 45 && G.q.lvl < 3 && !G.gpuReset && !G.dbg.lockQ && G.qPin === null) {
      setQuality(3); qCool = 8; qUp = 0; return;
    }
  }
  qCool--;
  if (qCool > 0 || G.dbg.lockQ) return;
  /* A pinned tier is a CEILING, not a lock: demotion stays available at every
     pin, promotion never crosses it. `ceil` is also why pinning LOW is a true
     floor-and-ceiling - lvl 0 with ceil 0 can neither rise nor fall. */
  const ceil = G.qPin === null ? 3 : G.qPin;
  if (G.fps < 30 && G.q.lvl > 0) { setQuality(G.q.lvl - 1); qCool = 8; qUp = 0; }
  /* G.gpuReset: this GPU has already had its driver reset out from under it, so
     never promote back into whatever caused that.
     The old OPT.high term is gone with the switch itself: promotion is what AUTO
     MEANS, and gating it on a separate control was half of why the two settings
     contradicted each other. */
  else if (G.fps > 57 && G.q.lvl < ceil && !G.gpuReset) { if (++qUp > (G.q.lvl === 2 ? 8 : 5)) { setQuality(G.q.lvl + 1); qCool = 14; qUp = 0; } }
}
G.dbg.auto = on => { AUTO.on = on === undefined ? !AUTO.on : !!on; return AUTO.on; };
G.dbg.sample = (x, z) => Object.assign({}, sample(x, z));
G.dbg.terrainH = terrainH;
G.dbg.terrainNormal = terrainNormal;
G.dbg.AUTO = AUTO;
G.dbg.orbit = null;
G.dbg.fixdt = 0;
G.dbg.placeBudget = 0;              // 0 = the shipped 3 ms slice; 1e9 = synchronous (replay)
/* Deterministic start line for the LOD-pop replay: a full rider state reset
   (warp alone leaves yaw/edge/flow/air from wherever the rider was, which made
   two replays of the same build diverge) plus warp, bots off, timestep pinned
   and placement synchronous. */
G.dbg.replayStart = (z, dt = 1 / 60) => {
  G.paused = false; G.dbg.fixdt = dt; G.dbg.placeBudget = 1e9;
  BOTS.on = false; BOTS.reset();
  /* the LOD hysteresis memory persists across passes, so a replay would inherit
     the previous run's tiers and stop being bit-exact */
  if (G.dbg.tierMemClear) G.dbg.tierMemClear();
  /* the deformation store is world state that survives reset() and warp(), so a
     replay would otherwise ride over the previous run's ruts */
  if (G.stamps) G.stamps.clear();
  /* the fixed-step accumulator survives reset() and warp(): its leftover
     fraction decides whether a later frame takes 2 or 3 sub-steps, which is
     enough to drift the path ~0.1 m and move a pass trigger */
  G.acc = 0;
  /* camera shake phase also persists, and shake moves the camera enough to
     shift the ~21 deg "turned" test that triggers a placement pass */
  CAM.shakeT = 0; CAM.roll = 0;
  G.rider.reset();
  /* the autopilot carries a jump cooldown and a clock: a pending popT skips the
     first lip and forks the whole descent, which is why the FIRST replay after a
     boot did not match later ones */
  AUTO.on = true; AUTO.t = 0; AUTO.popT = 0;
  const I = G.rider.input;
  if (I) { I.steer = 0; I.tuck = 0; I.grab = 0; I.pop = false; I.flip = 0; }
  G.dbg.warp(z);
  return { z: G.rider.p.z, x: +G.rider.p.x.toFixed(4), yaw: G.rider.yaw, flow: G.rider.flow };
};
G.dbg.replayEnd = () => { G.dbg.fixdt = 0; G.dbg.placeBudget = 0; BOTS.on = true; return 1; };
G.dbg.noSnap = false;
G.dbg.CAM = () => CAM;
G.dbg.BOTS = BOTS;
G.dbg.wxAt = weatherAt;
G.dbg.wx = v => { if (v === undefined) return G.wx.wx; G.wx.target = v; G.wx.wx = v; G.wx.lock = 1; return v; };
G.dbg.bots = on => { BOTS.on = on === undefined ? !BOTS.on : !!on; if (!BOTS.on) BOTS.reset(); return BOTS.list.length; };
G.dbg.seg = s => getSeg(s);
G.dbg.sfx = SFX;
G.dbg.AU = AU;      // audio graph, for measuring the mix (see dbg.loud)
G.dbg.poach = (n = 40) => { const o = []; for (let s = 1; s < n; s++) for (const pl of (getSeg(s).po || [])) o.push({ z0: Math.round(pl.z0), len: Math.round(pl.len), side: pl.side, amp: Math.round(pl.amp), w: +pl.w.toFixed(1) }); return o; };
/* live regrade: tone(0) = ACES, tone(1) = AgX; second arg is exposure */
G.dbg.tone = (tm, exp) => {
  if (tm !== undefined) TONE.uTM.value = tm ? 1 : 0;
  if (exp !== undefined) TONE.uExp.value = exp;
  return { tm: TONE.uTM.value, exp: TONE.uExp.value };
};
/* objective mix tuning: FL.dbg.loud(ms) samples the master bus, FL.dbg.loudRead()
   returns dBFS RMS/peak. Mute a source between two runs to get its contribution. */
G.dbg.loud = (ms = 1500) => { LOUD.s = []; clearInterval(LOUD.t);
  LOUD.t = setInterval(() => { const m = AU.meter && AU.meter(); if (m) LOUD.s.push(m); }, 20);
  setTimeout(() => clearInterval(LOUD.t), ms); return 'sampling ' + ms + 'ms'; };
G.dbg.loudRead = () => { const s = LOUD.s; if (!s.length) return null;
  const rms = Math.sqrt(s.reduce((a, b) => a + b.rms * b.rms, 0) / s.length);
  return { n: s.length, dbRms: +(20 * Math.log10(rms + 1e-9)).toFixed(2),
           dbPeak: +(20 * Math.log10(Math.max(...s.map(x => x.peak)) + 1e-9)).toFixed(2) }; };
/* PHASE 6: there is no ribbon to hide any more, so the historical meaning of
   this hook - "is the board's trail drawn" - is now the deformation amount.
   Still a single uniform, so it is still an exact same-frame A/B. */
G.dbg.wake = on => { const u = G.df.uni.uDfP.value; const v = on === undefined ? !(u.z > 0.5) : !!on; G.df.setAmount(v ? 1 : 0); return v; };
G.dbg.plats = () => { const r = []; for (const [sg, e] of G.world.segGroups) for (const o of e.plats)
  r.push({ seg: sg, name: o.name, x: +o.position.x.toFixed(2), y: +o.position.y.toFixed(2), z: +o.position.z.toFixed(2),
    ry: +o.rotation.y.toFixed(3), ridge: +(o.position.y + o.userData.plat.base + o.userData.plat.rise).toFixed(2),
    eave: +(o.position.y + o.userData.plat.base).toFixed(2), hx: +o.userData.plat.hx.toFixed(2), hz: +o.userData.plat.hz.toFixed(2) });
  return r; };
G.dbg.platAt = (x, z, y) => { const q = { h: 0, nx: 0, ny: 1, nz: 0, o: null };
  const r = G.world.platAt(x, z, y === undefined ? 1e9 : y, 0.30, q); return r ? { h: +q.h.toFixed(3), n: [+q.nx.toFixed(3), +q.ny.toFixed(3), +q.nz.toFixed(3)] } : null; };
/* PB9: what is solid right now, and a point probe. `cols()` lists every live
   collider with its kind and part count; `colAt(x,z,y)` reports the hit the
   rider would get at that point, so a test can assert solidity without having
   to actually drive into something. */
G.dbg.cols = () => { const r = []; for (const [sg, e] of G.world.segGroups) for (const o of e.cols)
  r.push({ seg: sg, kind: o.userData.col.kind, parts: o.userData.col.parts.length,
    x: +o.position.x.toFixed(2), y: +o.position.y.toFixed(2), z: +o.position.z.toFixed(2),
    ry: +o.rotation.y.toFixed(3), reach: +o.userData.col.reach.toFixed(2) });
  return r; };
G.dbg.colAt = (x, z, y) => { const q = { nx: 0, nz: 0, pen: 0, C: null, o: null };
  const r = G.world.propHit(x, z, y === undefined ? -1e9 : y, 0.42, q);
  return r ? { kind: q.C.kind, why: q.C.why, pen: +q.pen.toFixed(3),
    n: [+q.nx.toFixed(3), +q.nz.toFixed(3)], sevAt20: +(q.C.sev0 + 20 * q.C.sevK).toFixed(2) } : null; };
/* PHASE 6: retired with the ribbon. The min(trueDepth, groundDepth) clamp existed
   only to keep a sunken decal from being swallowed by the terrain solid; the trail
   IS the terrain now. Kept as a warning so an old harness call does not throw. */
G.dbg.decal = () => { console.warn('FL.dbg.decal retired with the wake ribbon (phase 6)'); return null; };
/* wind relief A/B: sast(0,0,0) is the pre-v2 look (drifts only, no exposure),
   sast() reads back. Same-frame toggle, no rebuild. */
G.dbg.sast = (a, r, e) => {
  const u = G.terr.uni.uSast.value;
  if (a !== undefined) u.set(a, r === undefined ? a : r, e === undefined ? a : e);
  return { amp: u.x, ripple: u.y, expo: u.z };
};
/* S2 tiled grain A/B: grain(0,0,0) is the pre-S2 look exactly, grain() reads
   back. Same-frame toggle, no rebuild - this is how the amplitudes were chosen. */
G.dbg.grain = (f, mid, on) => {
  const u = G.terr.uni.uGrainK.value;
  if (f !== undefined) u.x = f;
  if (mid !== undefined) u.y = mid;
  if (on !== undefined) u.z = on;
  return { fine: u.x, mid: u.y, on: u.z };
};
G.dbg.ao = v => { G.terr.uni.uAOAmt.value = v === undefined ? (G.terr.uni.uAOAmt.value > 0 ? 0 : 1) : v; return G.terr.uni.uAOAmt.value; };
/* SUN. az = degrees from the fall line (+z, straight downhill) toward +x, el =
   degrees above the horizon; the shipped sun is az 40.3 / el 16.3. Re-lights the
   baked sky in the same call, so the painted glare and the cast shadows can never
   disagree again (they did for months - see the SUNDIR note in sky.js). */
G.dbg.sun = (azDeg, elDeg) => {
  const s = WU.uSun.value;
  if (azDeg !== undefined) {
    const a = azDeg * Math.PI / 180, e = (elDeg === undefined ? 16.3 : elDeg) * Math.PI / 180;
    s.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).normalize();
    G.sky.relight(G.ren);
  }
  return {
    az: +(Math.atan2(s.x, s.z) * 180 / Math.PI).toFixed(2),
    el: +(Math.asin(s.y) * 180 / Math.PI).toFixed(2),
    dir: [+s.x.toFixed(4), +s.y.toFixed(4), +s.z.toFixed(4)],
    bakeMs: +(G.sky.bakeMs || 0).toFixed(2)
  };
};
/* Time of day. hour is a local clock hour (fractional ok), clamped into [7,17] -
   see sunFor() in util.js for the arc, why those are the ends, and why there is
   no night. This now drives the SHIPPED lighting rather than being a debug-only
   curve, and unlike dbg.sun it moves the sun's COLOUR too, rebases the weather
   and re-bakes the far-tree atlas. Does not persist; use dbg.tod for that. */
G.dbg.sunTime = hour => {
  const s = setTod(hour === undefined ? todClock() : hour);
  return Object.assign({}, s, { bakeMs: +(G.sky.bakeMs || 0).toFixed(2) });
};
/* The shipped setting: 'auto' | 7 | 12 | 17, i.e. exactly what the pause-menu
   LIGHT button cycles. Persists, unlike dbg.sunTime. */
G.dbg.tod = v => {
  if (v !== undefined) { OPT.tod = v; LS.set('tod', v); setTod(v === 'auto' ? todClock() : +v); if (UI.show_cycTod) UI.show_cycTod(); }
  return { opt: OPT.tod, src: G.tod && G.tod.src, sun: G.todSun };
};
G.dbg.csc = on => { G.csc.enable(on === undefined ? !G.csc.on : on); return G.csc.on; };
G.dbg.sh = on => { G.sh.enable(on === undefined ? !G.sh.uni.uShOn.value : on); return G.sh.uni.uShOn.value; };
/* full feature records, not just z0 - scan() cannot tell you a kicker's lat/w */
G.dbg.feats = (n, t) => { const o = []; for (let s = 1; s < (n || 60); s++) for (const f of getSeg(s).ft)
  if (t === undefined || f.t === t) o.push(Object.assign({ seg: s }, f)); return o; };
/* segment PROP records (the pr list), grouped by kind - the counterpart to feats() */
G.dbg.props = (n, k) => { const o = {}; for (let s = 1; s < (n || 60); s++) for (const p of getSeg(s).pr)
  if (k === undefined || p.k === k) (o[p.k] = o[p.k] || []).push(Math.round(p.z)); return o; };
G.dbg.scan = (n, t) => { const o = []; for (let s = 1; s < (n || 60); s++) for (const f of getSeg(s).ft) if (f.t === t) o.push(Math.round(f.z0)); return o; };
G.dbg.small = (w, h) => { G.dbg.lockQ = 1; G.ren.setPixelRatio(1); G.ren.setSize(w || 640, h || 360, false); };
/* setQuality now only STARTS the re-place (see the note there), so the debug hook
   finishes it synchronously - every measurement harness does `dbg.q(3)` and then
   immediately reads instance counts / triangles, which would otherwise be stale. */
G.dbg.q = lvl => { G.dbg.lockQ = 1; setQuality(lvl); if (G.world && G.rider) G.world.place(G.rider.p.x, G.rider.p.z); return G.q.lvl; };
/* ---------------- deformable-snow rearchitecture (phases 1-5) ---------------- */
/* phase 1: the DRAWN surface, read on the CPU, as the single authority */
G.dbg.hAt = (x, z) => G.terr.hAuth(x, z);
G.dbg.strAt = (x, z) => G.terr.strAt(x, z);
G.dbg.str = () => { const k = G.terr.uni.uStrK.value, o = G.terr.uni.uStrO.value;
  return { x0: G.terr.strX0, z0: G.terr.strZ0, nx: k.x, nz: k.y, step: k.z,
           texX0: o.x, texZ0: o.y, orgY: o.z }; };
/* the GLSL blocks, so a gate can compile structH() standalone and compare the
   GPU sampler against strAt() on the same texels (flowline_struct.ts GATE) */
G.dbg.glsl = { STRUCT: GLSL_STRUCT, PROMO: GLSL_PROMO, DEFORM: GLSL_DEFORM };
/* phase 2a: the 0.25 m fine patch over the static hole in the coarse clipmap */
/* each argument is guarded INDEPENDENTLY so skirt(undefined, undefined, cap)
   really applies the cap - a knob that guards the whole set on its first
   argument is a knob that lies, and one of those cost a whole A/B batch once */
G.dbg.skirt = (v, sink, cap) => { const s = G.terr.skirt; if (!s) return null;
  if (v !== undefined) s.mesh.visible = !!v;
  if (sink !== undefined) s.uni.uSkSink.value = sink;
  if (cap !== undefined) s.uni.uSkSinkMax.value = cap;
  return s.info(); };
G.dbg.fine = () => { const f = G.terr.fine; if (!f || !f.mesh) return null;
  return { ok: f.ok, step: f.step, verts: f.verts, tris: f.tris, nx: f.nx, nz: f.nz,
           rows: [FPJ0, FPJ1], holeTris: (G.terr.idxCountFull - G.terr.idxCount) / 3,
           holeOn: G.terr._hole }; };
G.dbg.hole = on => G.terr.setHole(on === undefined ? !G.terr._hole : on);
/* the patch is a pure function of its step, so density is free to sweep live -
   the only honest way to price it (see the phase-2a density table) */
G.dbg.finep = step => { G.terr.fine.build(step, G.scene); return G.dbg.fine(); };
/* phase 3: promoted relief octaves, same-frame A/B */
G.dbg.promo = w => { const u = G.terr.uni.uPromo;
  if (w !== undefined) u.value = w; return u.value; };
/* phase 4: the stamp store */
G.dbg.stamps = () => G.stamps.stats();
G.dbg.stampAt = (x, z) => { const o = {}; return G.stamps.displaceAt(x, z, o) ? o : null; };
G.dbg.disp = (x, z) => { const o = {}; G.stamps.displaceAt(x, z, o); return o; };
G.dbg.stampClear = () => { G.stamps.clear(); return G.stamps.stats(); };
/* phase 5: the deformation cascade. amount 0 makes every snow shader skip the
   fetch entirely, which is the same-frame A/B for the whole feature. */
G.dbg.deform = v => { if (v !== undefined) G.df.setAmount(v); return G.df.uni.uDfP.value.z; };
G.dbg.df = () => ({ amt: G.df.uni.uDfP.value.z, frame: G.df.frame, ok: G.df.ok,
  near: { n: G.df.stats.near, o: G.df.uni.uDfNO.value.toArray() },
  far: { n: G.df.stats.far, o: G.df.uni.uDfFO.value.toArray() },
  drawn: G.df.stats.drawn, clipped: G.df.stats.clipped });
G.dbg.DF = () => G.df;
/* S1 same-frame A/B: dfsh(0,0) is the pre-S1 image exactly, dfsh(1,1) shipped. */
G.dbg.dfsh = (sh, ao) => { const u = G.df.uni.uDfSh.value;
  if (sh !== undefined) u.x = sh; if (ao !== undefined) u.y = ao; return u.toArray(); };

/* S5 same-frame A/B: berm(0,0) is the pre-S5 image exactly, berm(1,1) shipped. */
G.dbg.berm = (amt, gain) => { const u = G.terr.uni.uBrm.value;
  if (amt !== undefined) u.x = amt; if (gain !== undefined) u.y = gain; return u.toArray(); };

G.dbg.warp = z => { const r = G.rider; r.p.z = z; r.p.x = pisteC(z); r.p.y = terrainH(r.p.x, z) + 0.5; r.v.set(0, 0, 6); r.startZ = z; G.terr.update(r.p.x, r.p.z, true); if (G.terr.skirt) { G.terr.skirt.ok = false; G.terr.skirt.building = false; G.terr.skirt.update(r.p.x, r.p.z); } camCut(); G.world.place(r.p.x, r.p.z); G.world.updateSegs(r.p.z); if (G.wake) G.wake.reset(); };

/* A frame-rate readout, so performance can be judged on a real device instead
   of by feel. Toggle with F, or start with ?fps. */
let _fpsEl = null;
function fpsHud() {
  if (!_fpsEl) {
    _fpsEl = document.createElement('div');
    _fpsEl.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:4px;z-index:60;' +
      'font:600 12px/1.35 ui-monospace,Menlo,monospace;color:#eaf4ff;text-align:center;' +
      'background:rgba(11,28,44,.34);padding:4px 9px;border-radius:7px;pointer-events:none;' +
      'text-shadow:0 1px 2px rgba(0,0,0,.5)';
    document.body.appendChild(_fpsEl);
  }
  const fps = G.fps || 0;
  const ms = fps > 0 ? (1000 / fps).toFixed(1) : '-';
  _fpsEl.style.color = fps >= 55 ? '#b9f5c8' : fps >= 40 ? '#ffe08a' : '#ff9c9c';
  _fpsEl.textContent = Math.round(fps) + ' fps  ' + ms + ' ms  q' + G.q.lvl;
}
G.dbg.fps = on => {
  G.showFps = on === undefined ? !G.showFps : !!on;
  if (!G.showFps && _fpsEl) { _fpsEl.remove(); _fpsEl = null; } else if (G.showFps) fpsHud();
  return G.showFps;
};

/* ---------------- start ---------------- */
function boot() {
  initRender();
  if (LQ) { setQuality(0); G.dbg.lockQ = 1; }
  if (QS.has('fps')) G.showFps = true;
  G.fx = new FX(G.scene);
  /* Phase 4: the stamp store is the deformation AUTHORITY. It must exist before
     any Wake, because Wake.push feeds it and each bot constructs its own. */
  G.stamps = new StampStore();
  G.wake = new Wake(G.scene);
  G.rider = new Rider();
  G.rider.reset();
  initUI();
  G.terr.update(G.rider.p.x, G.rider.p.z, true);
  G.world.place(G.rider.p.x, G.rider.p.z);
  G.world.updateSegs(G.rider.p.z);
  // warm up the renderer before revealing
  G.ren.compile(G.scene, G.cam);
  requestAnimationFrame(frame);
  // build the bots' rider geometry while the title screen is up, so the first
  // spawn of each colour does not solve 10k verts of skin weights in a frame
  riderPrewarm(BOT_KINDS.map(k => k.col));
  setTimeout(() => document.getElementById('load').classList.add('gone'), 260);
}
window.FL = G;
boot();


