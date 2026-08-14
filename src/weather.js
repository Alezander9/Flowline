/* ------------------------------------------------- weather: snow squalls
   Long stretches of the mountain sit under falling snow. Intensity is a pure
   function of z, so every rider on the shared mountain gets the same sky.  */

function weatherAt(z) {
  const u = z / 5300 - Math.floor(z / 5300);
  const a = smoothstep(0.60, 0.72, u) * smoothstep(0.95, 0.83, u);
  const v = z / 21700 - Math.floor(z / 21700);                 // rarer whiteout band
  const b = smoothstep(0.30, 0.38, v) * smoothstep(0.52, 0.44, v);
  return clamp(a * 0.85 + b, 0, 1);
}

const FLAKES = 2600;
class Weather {
  constructor(scene, WU) {
    this.wx = 0; this.target = 0;
    this.base = {
      fogD: WU.uFogD.value,
      sun: WU.uSunCol.value.clone(), sky: WU.uSkyCol.value.clone(),
      fogA: WU.uFogA.value.clone(), fogB: WU.uFogB.value.clone(),
      gnd: WU.uGndCol.value.clone()
    };
    this.WU = WU;

    // overcast shell: hides the baked blue dome when it snows
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(3400, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xd8e2ee, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false }));
    this.dome.renderOrder = -9;
    scene.add(this.dome);

    // flakes: a box of points that wraps around the camera
    const pos = new Float32Array(FLAKES * 3), rnd = new Float32Array(FLAKES);
    this.box = new THREE.Vector3(46, 26, 46);
    for (let i = 0; i < FLAKES; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.box.x;
      pos[i * 3 + 1] = (Math.random() - 0.5) * this.box.y;
      pos[i * 3 + 2] = (Math.random() - 0.5) * this.box.z;
      rnd[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    this.uni = { uPix: { value: innerHeight / 2 }, uAmt: { value: 0 }, uT: { value: 0 } };
    this.pts = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.uni, transparent: true, depthWrite: false,
      vertexShader: `attribute float aRnd; uniform float uPix, uT, uAmt; varying float vA, vG;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          float d = -mv.z;
          vA = uAmt * smoothstep(0.8, 4.0, d) * (0.55 + 0.45*aRnd) * (1.0 - smoothstep(30.0, 60.0, d)*0.55);
          vG = 0.78 + 0.22 * aRnd;
          gl_PointSize = max(1.3, (0.085 + 0.13*aRnd) * uPix / max(d, 0.5));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying float vA, vG;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d,d);
          if (r > 0.25) discard;
          vec3 c = mix(vec3(0.80,0.85,0.93), vec3(1.0), vG);
          gl_FragColor = vec4(c, smoothstep(0.25, 0.01, r) * vA);
        }`
    }));
    this.pts.frustumCulled = false;
    this.pts.renderOrder = 6;
    scene.add(this.pts);
    this.origin = null;
  }
  setQuality(q) { this.pts.geometry.setDrawRange(0, Math.round(FLAKES * (q.lvl === 0 ? 0.3 : q.lvl === 1 ? 0.65 : 1))); }
  /* The clear-air palette is captured ONCE at construction, and update() lerps
     away from it every frame. So changing the time of day at runtime must
     refresh it, or the next squall to CLEAR would lerp the whole world back to
     whatever sun the page happened to boot with - a bug that would only surface
     minutes later, in weather, and would look like the time-of-day setting
     silently reverting itself. Call this AFTER applySun (which writes the new
     clear-air values into the uniforms); calling it mid-squall is safe for the
     same reason - it reads what applySun just wrote, not the lerped state. */
  rebase() {
    const U = this.WU, B = this.base;
    B.sun.copy(U.uSunCol.value); B.sky.copy(U.uSkyCol.value);
    B.fogA.copy(U.uFogA.value); B.fogB.copy(U.uFogB.value); B.gnd.copy(U.uGndCol.value);
  }
  update(cam, riderZ, dt, wind) {
    this.target = weatherAt(riderZ);
    this.wx += (this.target - this.wx) * (1 - Math.exp(-0.9 * dt));
    const w = this.wx, B = this.base, U = this.WU;
    // sky and light go flat and grey
    /* The multiplier is large because the CLEAR-AIR baseline is now genuinely
       clear (uFogD 3e-4, see main.js). A squall has to supply essentially all of
       its own extinction rather than deepening an already-hazy baseline: at w=1
       this reaches 4.1e-3, i.e. ~80% fog at 400 m, which is the whiteout the old
       hazy baseline used to reach with only x2.1. */
    U.uFogD.value = B.fogD * (1 + w * 12.7);
    U.uSunCol.value.copy(B.sun).lerp(new THREE.Color(1.16, 1.14, 1.14), w * 0.62);
    U.uSkyCol.value.copy(B.sky).lerp(new THREE.Color(0.55, 0.60, 0.70), w * 0.9);
    U.uFogA.value.copy(B.fogA).lerp(new THREE.Color(0.86, 0.90, 0.95), w * 0.95);
    U.uFogB.value.copy(B.fogB).lerp(new THREE.Color(0.88, 0.91, 0.96), w * 0.95);
    this.dome.position.copy(cam.position);
    this.dome.material.opacity = w * 0.99;
    this.dome.visible = w > 0.01;

    // flake field follows the camera, wrapped, with wind + fall
    this.uni.uAmt.value = w;
    this.uni.uT.value += dt;
    this.pts.visible = w > 0.02;
    if (!this.pts.visible) return;
    const p = this.pts.geometry.attributes.position, r = this.pts.geometry.attributes.aRnd;
    const c = cam.position, bx = this.box;
    if (!this.origin) this.origin = c.clone();
    const fall = -(2.2 + 1.6 * w) * dt, dx = (wind || 3.5) * dt, dz = -1.6 * dt;
    const n = p.count;
    for (let i = 0; i < n; i++) {
      let x = p.array[i * 3] + dx * (0.6 + r.array[i]), y = p.array[i * 3 + 1] + fall * (0.7 + r.array[i]), z = p.array[i * 3 + 2] + dz;
      x -= c.x - this.origin.x; y -= c.y - this.origin.y; z -= c.z - this.origin.z;
      x -= bx.x * Math.round(x / bx.x); y -= bx.y * Math.round(y / bx.y); z -= bx.z * Math.round(z / bx.z);
      p.array[i * 3] = x; p.array[i * 3 + 1] = y; p.array[i * 3 + 2] = z;
    }
    this.origin.copy(c);
    p.needsUpdate = true;
    this.pts.position.copy(c);
  }
}
