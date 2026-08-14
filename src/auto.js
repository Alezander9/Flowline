/* ------------------------------------------------- autopilot: demo rider / test driver */
const AUTO = { on: false, amp: 0.62, per: 0, style: 1, popT: 0, t: 0 };

function autoDrive(r, dt) {
  AUTO.t += dt;
  const p = r.p;
  const s = sample(p.x, p.z);
  const cw = Math.max(s.cw, 8), lat = s.lat;
  /* rhythmic S-turns down the fall line, wavelength scales with speed */
  const per = AUTO.per || (58 + r.speed * 3.1);
  const amp = cw * AUTO.amp * (0.55 + 0.45 * Math.sin(p.z * 0.0021 + 1.3));
  const tgt = Math.sin(p.z / per * TAU) * amp;

  /* look ahead for trees / rocks and steer around them */
  let avoid = 0;
  const obs = G.world.obs, n = G.world.obsN;
  const look = 12 + r.speed * 1.25;
  for (let i = 0; i < n; i++) {
    const o = i * OBS_S;
    const dz = obs[o + 1] - p.z;
    if (dz < 1.5 || dz > look) continue;
    const dx = obs[o] - p.x;
    const rad = obs[o + 2] + 2.6;
    if (Math.abs(dx) > rad + 5) continue;
    const urg = (1 - dz / look);
    avoid += (dx > 0 ? -1 : 1) * urg * urg * 3.4;
  }

  /* heading control: aim across the fall line, never point uphill */
  let yaw = r.yaw % TAU; if (yaw > Math.PI) yaw -= TAU; if (yaw < -Math.PI) yaw += TAU;
  const latErr = clamp((tgt - lat) / Math.max(cw, 8), -1, 1);
  const yawWant = clamp(latErr * 0.72 + avoid * 0.22, -0.80, 0.80);
  let st = clamp((yawWant - yaw) * 2.6 + avoid * 0.55, -1, 1);
  if (Math.abs(lat) > cw * 0.95) st = clamp(st + (lat > 0 ? -0.9 : 0.9), -1, 1);
  r.input.steer = st;

  /* tuck when running straight, stand up in the turn */
  const near = Math.abs(lat - tgt) < cw * 0.3;
  r.input.tuck = (near && Math.abs(r.edge) < 0.55) ? 1 : 0;

  /* pop off a rise: sample the slope ahead, jump at the lip */
  AUTO.popT -= dt;
  if (r.grounded && AUTO.popT <= 0) {
    const ahead = 5 + r.speed * 0.42;
    const h0 = terrainH(p.x, p.z);
    const h1 = terrainH(p.x, p.z + ahead * 0.5);
    const h2 = terrainH(p.x, p.z + ahead);
    const lip = (h1 - h0) - (h2 - h1);          // convex = a lip
    if (lip > 0.55 && r.speed > 12) { r.input.pop = true; AUTO.popT = 1.1; }
  }
  /* grab when high in the air */
  r.input.grab = (!r.grounded && r.airT > 0.34) ? 1 : 0;
}

