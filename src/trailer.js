/* ------------------------------------------------- trailer renderer (offline, frame by frame) */
const TR = { on: false, W: 1280, H: 720, fps: 30, video: null, wav: null, tl: [], cv: null, cx: null, prog: 0 };

/* ---------- camera rigs ---------- */
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
function camLook(px, py, pz, tx, ty, tz, fov) {
  G.cam.position.set(px, py, pz);
  G.cam.lookAt(tx, ty, tz);
  if (fov && Math.abs(G.cam.fov - fov) > 0.01) { G.cam.fov = fov; G.cam.updateProjectionMatrix(); }
}
function riderFwd() {
  const r = G.rider;
  const l = Math.hypot(r.v.x, r.v.z) || 1;
  return { x: r.v.x / l, z: r.v.z / l };
}
/* chase: behind and above, smoothed by the shot's own state */
const CH = { x: 0, y: 0, z: 0, init: false };
function chaseCam(dt, dist, hgt, side, lead, fov) {
  const r = G.rider, f = riderFwd();
  const rx = f.z, rz = -f.x;
  const wx = r.p.x - f.x * dist + rx * (side || 0);
  const wz = r.p.z - f.z * dist + rz * (side || 0);
  const gy = terrainH(wx, wz);
  const wy = Math.max(r.p.y + hgt, gy + 1.3);
  if (!CH.init) { CH.x = wx; CH.y = wy; CH.z = wz; CH.init = true; }
  const k = 1 - Math.exp(-13.0 * dt);
  CH.x += (wx - CH.x) * k; CH.y += (wy - CH.y) * k; CH.z += (wz - CH.z) * k;
  camLook(CH.x, CH.y, CH.z,
    r.p.x + f.x * (lead || 8), r.p.y + 1.1, r.p.z + f.z * (lead || 8), fov || 62);
}

/* ---------- shot list ---------- */
function trailerShots() {
  const S = [];
  S.push({
    name: 'drop', dur: 4.0, warp: 1420, txt: [{ t: 0.7, d: 3.0, big: 'FLOWLINE', sub: 'one endless mountain' }],
    cam: (t, dt) => chaseCam(dt, 3.9 + t * 0.22, 1.55, 0.8, 4, 58)
  });
  /* og / share card only: close and low, rider large with the horizon behind */
  S.push({
    name: 'hero', still: true, dur: 0,
    cam: (t, dt) => {
      const r = G.rider, f = riderFwd();
      const rx = f.z, rz = -f.x;
      const dist = 3.1, side = 2.5;
      const px = r.p.x - f.x * dist + rx * side, pz = r.p.z - f.z * dist + rz * side;
      const py = Math.max(r.p.y + 0.92, terrainH(px, pz) + 0.8);
      camLook(px, py, pz, r.p.x + f.x * 1.4, r.p.y + 0.82, r.p.z + f.z * 1.4, 50);
    }
  });
  S.push({
    name: 'carve', dur: 4.2, txt: [{ t: 0.6, d: 2.6, small: 'hold an edge · stay perfect' }],
    cam: (t, dt) => {
      const r = G.rider, f = riderFwd();
      const rx = f.z, rz = -f.x;
      const side = 4.2 * (t < 2.1 ? 1 : -1);
      const ahead = 5.2;
      const px = r.p.x + f.x * ahead + rx * side, pz = r.p.z + f.z * ahead + rz * side;
      camLook(px, Math.max(r.p.y + 1.25, terrainH(px, pz) + 0.9), pz, r.p.x, r.p.y + 0.85, r.p.z, 44);
    }
  });
  S.push({
    name: 'trees', dur: 3.6, txt: [{ t: 0.4, d: 2.3, small: 'trees at your shoulder' }],
    cam: (t, dt) => chaseCam(dt, 3.5, 1.05, 1.6, 3.5, 76)
  });
  S.push({
    name: 'air', dur: 4.2, warp: 'park', txt: [{ t: 1.3, d: 2.4, small: 'send it' }],
    cam: (t, dt) => {
      const r = G.rider, f = riderFwd();
      const d = 8.5, sd = 4.2;
      const px = r.p.x + f.x * d - f.z * sd, pz = r.p.z + f.z * d + f.x * sd;
      const py = Math.max(r.p.y + 0.6, terrainH(px, pz) + 1.6);
      camLook(px, py, pz, r.p.x, r.p.y + 0.9, r.p.z, 46);
    }
  });
  S.push({
    name: 'riders', dur: 4.6, warp: 2460,
    txt: [{ t: 0.5, d: 2.8, small: 'the mountain is never empty' }],
    pre: () => {
      BOTS.reset();
      const safe = b => { b.k = Object.assign({}, b.k, { fall: 0 }); return b; };
      safe(BOTS.place('carver', 10, 6.5, 25));
      safe(BOTS.place('trick', 16, -5, 26));
      safe(BOTS.place('sniper', 23, -11, 28));
      safe(BOTS.place('powder', 8, 14, 24));
      safe(BOTS.place('carver', -7, -8, 27));
    },
    cam: (t, dt) => chaseCam(dt, 6.2 + t * 0.3, 2.05, -2.4, 14, 64)
  });
  S.push({
    name: 'snow', dur: 4.4, warp: 3880,
    txt: [{ t: 0.6, d: 2.8, small: 'ride into the weather' }],
    pre: () => { G.wx.wx = 0.2; },
    cam: (t, dt) => chaseCam(dt, 5.0 + t * 0.3, 1.5, 2.4, 7, 66)
  });
  S.push({
    name: 'speed', dur: 4.0, txt: [{ t: 0.5, d: 2.6, small: 'flow raises your ceiling' }],
    cam: (t, dt) => chaseCam(dt, 3.6, 1.0, 0, 4, 74)
  });
  S.push({
    name: 'vista', dur: 5.0,
    txt: [{ t: 1.4, d: 3.5, big: 'FLOWLINE', sub: 'flowline.games.bu.app' }],
    cam: (t, dt) => {
      const r = G.rider, f = riderFwd();
      const u = t / 5.0;
      const d = 5.5 + u * 10.5, h = 1.6 + u * 4.2, sd = 1.5 + u * 5.5;
      const px = r.p.x - f.x * d - f.z * sd, pz = r.p.z - f.z * d + f.x * sd;
      camLook(px, r.p.y + h, pz, r.p.x + f.x * 5, r.p.y + 0.7, r.p.z + f.z * 5, 55 + u * 7);
    }
  });
  return S;
}

/* ---------- overlay text drawn into the video frame ---------- */
function trailerOverlay(cx, shot, t, W, H, gt, total) {
  // subtle vignette + top/bottom filmic bars fade at the very start/end
  const fadeIn = clamp(gt / 0.7, 0, 1);
  const fadeOut = clamp((total - gt) / 0.9, 0, 1);
  for (const b of (shot.txt || [])) {
    const lt = t - b.t;
    if (lt < 0 || lt > b.d) continue;
    const a = Math.min(1, Math.min(lt / 0.45, (b.d - lt) / 0.5));
    cx.save();
    cx.globalAlpha = a * 0.96;
    cx.textAlign = 'center';
    cx.shadowColor = 'rgba(255,255,255,.85)'; cx.shadowBlur = Math.round(H * 0.03); cx.shadowOffsetY = 0;
    if (b.big) {
      const fs = Math.round(H * 0.135);
      cx.font = '800 ' + fs + 'px ui-rounded, system-ui, sans-serif';
      cx.fillStyle = '#0f2b3f';
      const sp = Math.round(fs * 0.13);
      drawSpaced(cx, b.big, W / 2, H * 0.42, sp);
      drawSpaced(cx, b.big, W / 2, H * 0.42, sp);
      cx.font = '700 ' + Math.round(H * 0.036) + 'px ui-rounded, system-ui, sans-serif';
      cx.fillStyle = '#b4560d';
      drawSpaced(cx, b.sub || '', W / 2, H * 0.50, Math.round(H * 0.012));
      drawSpaced(cx, b.sub || '', W / 2, H * 0.50, Math.round(H * 0.012));
    } else if (b.small) {
      cx.font = '800 ' + Math.round(H * 0.044) + 'px ui-rounded, system-ui, sans-serif';
      cx.fillStyle = '#12324a';
      drawSpaced(cx, b.small.toUpperCase(), W / 2, H * 0.88, Math.round(H * 0.010));
      drawSpaced(cx, b.small.toUpperCase(), W / 2, H * 0.88, Math.round(H * 0.010));
    }
    cx.restore();
  }
  const f = Math.min(fadeIn, fadeOut);
  if (f < 1) { cx.fillStyle = 'rgba(6,16,26,' + (1 - f).toFixed(3) + ')'; cx.fillRect(0, 0, W, H); }
}
function drawSpaced(cx, s, cxp, y, sp) {
  if (!s) return;
  let w = 0;
  for (const ch of s) w += cx.measureText(ch).width + sp;
  w -= sp;
  let x = cxp - w / 2;
  for (const ch of s) { cx.fillText(ch, x + cx.measureText(ch).width / 2, y); x += cx.measureText(ch).width + sp; }
}

/* ---------- find a park segment ahead ---------- */
function findPark(from) {
  for (let z = from; z < from + 4200; z += 12) {
    const s = sampleAt(pisteC(z), z);
    if (s.park) return z - 95;
  }
  return from + 400;
}

/* ---------- main render ---------- */
async function trailerRender(opts) {
  opts = opts || {};
  const W = TR.W = opts.w || 960, H = TR.H = opts.h || 540, fps = TR.fps = opts.fps || 30;
  const allShots = trailerShots().filter(s => !s.still);   // 'hero' is og-only
  let shots = allShots;
  if (opts.only) shots = shots.filter(s => opts.only.indexOf(s.name) >= 0);
  if (opts.scale) { allShots.forEach(s => s.dur = +(s.dur * opts.scale).toFixed(2)); }
  const total = allShots.reduce((a, s) => a + s.dur, 0);
  if (!opts.append) { TR.tl = []; TR.chunks = []; TR.fi = 0; }
  TR.prog = 0;

  // deterministic, top quality, fixed size
  G.dbg.lockQ = 1;
  setQuality(opts.q === undefined ? 3 : opts.q);
  G.ren.setPixelRatio(1);
  G.ren.setSize(W, H, false);
  G.cam.aspect = W / H; G.cam.updateProjectionMatrix();
  document.getElementById('ui').style.visibility = 'hidden';
  if (AU.ctx) AU.master.gain.value = 0;
  AUTO.on = true;
  G.started = true;
  G.paused = false;

  TR.cv = document.createElement('canvas'); TR.cv.width = W; TR.cv.height = H;
  TR.cx = TR.cv.getContext('2d');

  const chunks = TR.chunks;
  const enc = new VideoEncoder({
    output: c => { const b = new Uint8Array(c.byteLength); c.copyTo(b); chunks.push(b); },
    error: e => { TR.err = String(e); }
  });
  enc.configure({
    codec: 'avc1.4D401F', width: W, height: H, framerate: fps,
    bitrate: opts.bitrate || 5000000, avc: { format: 'annexb' }, latencyMode: 'quality'
  });

  TR.on = true;
  const dt = 1 / fps;
  let fi = TR.fi, gt = fi / fps, first = true;
  for (const shot of shots) {
    // position the rider for the shot
    if (shot.warp !== undefined) {
      const zNow = G.rider.p.z;
      G.rider.reset(true);
      G.dbg.warp(shot.warp === 'park' ? findPark(Math.max(zNow, 200) + 60) : shot.warp);
      G.rider.flow = 0.55; G.rider.v.set(0, 0, 23);
      CH.init = false;
      if (shot.pre) shot.pre();
      for (let i = 0; i < 14; i++) { stepWorld(dt); shot.cam(0, dt); present(dt, false); }
    }
    const n = Math.round(shot.dur * fps);
    for (let i = 0; i < n; i++) {
      const st = i / fps;
      stepWorld(dt);
      shot.cam(st, dt);
      present(dt, false);
      // record audio-relevant state
      const r = G.rider;
      TR.tl.push([+r.speed.toFixed(2), +r.flow.toFixed(2), +Math.abs(r.edge).toFixed(2),
        +r.skid.toFixed(2), r.grounded ? 1 : 0, +r.surf.pow.toFixed(2), +r.airT.toFixed(2)]);
      // compose the frame
      TR.cx.drawImage(G.ren.domElement, 0, 0, W, H);
      trailerOverlay(TR.cx, shot, st, W, H, gt, total);
      const vf = new VideoFrame(TR.cv, { timestamp: Math.round(fi * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: first || fi % 45 === 0 }); first = false;
      vf.close();
      fi++; gt += dt;
      TR.prog = gt / total;
      if (fi % 6 === 0) await new Promise(r => setTimeout(r, 0));
    }
  }
  await enc.flush();
  enc.close();
  TR.on = false;
  document.getElementById('ui').style.visibility = '';
  TR.fi = fi;
  let len = 0; for (const c of chunks) len += c.length;
  const all = new Uint8Array(len); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  TR.video = all;
  return { bytes: len, frames: fi, dur: +(fi / fps).toFixed(2), total, err: TR.err || null };
}

/* ---------- offline audio: reuse the music engine with a proxied clock ---------- */
async function trailerAudio(durOverride) {
  const fps = TR.fps, tl = TR.tl;
  const dur = durOverride || (tl.length / fps);
  const SR = 44100;
  const off = new OfflineAudioContext(2, Math.ceil((dur + 1.2) * SR), SR);
  const fake = { t: 0 };
  const proxy = new Proxy(off, {
    get(o, k) {
      if (k === 'currentTime') return fake.t;
      const v = o[k];
      return typeof v === 'function' ? v.bind(o) : v;
    }
  });
  // rebuild the audio graph on the offline context
  const realCtx = AU.ctx, realMaster = AU.master, realMus = AU.musG, realVerb = AU.verb, realSfx = AU.sfxG;
  AU.ctx = proxy;
  AU.master = off.createGain(); AU.master.gain.value = 0.95; AU.master.connect(off.destination);
  AU.musG = off.createGain(); AU.musG.gain.value = 0.62; AU.musG.connect(AU.master);
  AU.sfxG = off.createGain(); AU.sfxG.gain.value = 0.9; AU.sfxG.connect(AU.master);
  AU.verb = off.createConvolver();
  AU.verb.buffer = trImpulseBuf(off, 1.7, 0.6);
  const vg = off.createGain(); vg.gain.value = 0.35; AU.verb.connect(vg); vg.connect(AU.master);

  // music: schedule by stepping the fake clock
  MU.on = false; MU.step = 0;
  startMusic();
  if (MU.timer) { clearInterval(MU.timer); MU.timer = null; }
  const step = 0.05;
  for (let i = 0; i < tl.length; i++) {
    const t = i / fps;
    if (t < fake.t) continue;
    fake.t = t;
    MU.flow = 0.35 + 0.6 * tl[i][1];
    musicTick();
  }
  fake.t = dur;
  for (let k = 0; k < 8; k++) { musicTick(); fake.t += step; }

  // wind + carve bed driven by the recorded timeline
  const noise = off.createBufferSource();
  noise.buffer = trNoiseBuf(off, Math.ceil(dur) + 2);
  noise.loop = true;
  const wF = off.createBiquadFilter(); wF.type = 'lowpass'; wF.frequency.value = 400;
  const wG = off.createGain(); wG.gain.value = 0;
  noise.connect(wF); wF.connect(wG); wG.connect(AU.master);
  const n2 = off.createBufferSource(); n2.buffer = noise.buffer; n2.loop = true;
  const cF = off.createBiquadFilter(); cF.type = 'bandpass'; cF.frequency.value = 900; cF.Q.value = 0.8;
  const cG = off.createGain(); cG.gain.value = 0;
  n2.connect(cF); cF.connect(cG); cG.connect(AU.master);
  const cv = off.createGain(); cv.gain.value = 0.25; cG.connect(AU.verb);
  for (let i = 0; i < tl.length; i += 2) {
    const t = i / fps, e = tl[i];
    const sp = e[0], edge = e[2], skid = e[3], gr = e[4], pow = e[5];
    wF.frequency.setValueAtTime(300 + sp * 26, t);
    wG.gain.setValueAtTime(Math.min(0.30, 0.012 + sp * 0.0075), t);
    cF.frequency.setValueAtTime(620 + edge * 900 + skid * 1500 + pow * 300, t);
    cG.gain.setValueAtTime(gr ? Math.min(0.34, (0.05 + edge * 0.22 + skid * 0.16 + pow * 0.10) * Math.min(1, sp / 14)) : 0.0, t);
  }
  noise.start(0); n2.start(0);
  const buf = await off.startRendering();
  // restore live audio
  AU.ctx = realCtx; AU.master = realMaster; AU.musG = realMus; AU.verb = realVerb; AU.sfxG = realSfx;
  MU.on = false;
  TR.wav = wavBytes(buf);
  return { bytes: TR.wav.length, dur: +buf.duration.toFixed(2) };
}

function trNoiseBuf(ctx, secs) {
  const b = ctx.createBuffer(2, Math.ceil(secs * ctx.sampleRate), ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let l = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; l = l * 0.72 + w * 0.28; d[i] = l * 1.6; }
  }
  return b;
}
function trImpulseBuf(ctx, secs, decay) {
  const n = Math.ceil(secs * ctx.sampleRate);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay * 4.5);
  }
  return b;
}
function wavBytes(buf) {
  const ch = 2, sr = buf.sampleRate, n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const W = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  W(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); W(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true);
  out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  W(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  let o = 44;
  for (let i = 0; i < n; i++) {
    out.setInt16(o, Math.max(-1, Math.min(1, a[i])) * 32767, true); o += 2;
    out.setInt16(o, Math.max(-1, Math.min(1, b[i])) * 32767, true); o += 2;
  }
  return new Uint8Array(out.buffer);
}

/* ---------- transfer helpers ---------- */
function b64slice(arr, from, len) {
  const end = Math.min(arr.length, from + len);
  let s = '';
  const CH = 0x8000;
  for (let i = from; i < end; i += CH) s += String.fromCharCode.apply(null, arr.subarray(i, Math.min(end, i + CH)));
  return btoa(s);
}

/* ---------- one high-resolution still (og image) ---------- */
async function stillRender(opts) {
  opts = opts || {};
  const W = opts.w || 2400, H = opts.h || 1260;
  G.dbg.lockQ = 1;
  setQuality(opts.q === undefined ? 3 : opts.q);
  G.ren.setPixelRatio(1);
  G.ren.setSize(W, H, false);
  G.cam.aspect = W / H; G.cam.updateProjectionMatrix();
  document.getElementById('ui').style.visibility = 'hidden';
  if (AU.ctx) AU.master.gain.value = 0;
  AUTO.on = true; G.started = true; G.paused = false;
  if (opts.wx !== undefined) G.dbg.wx(opts.wx);
  TR.on = true;                                  // rAF stops driving the clock
  const dt = 1 / 30;
  if (opts.warp !== undefined) {
    G.rider.reset(true);
    G.dbg.warp(opts.warp === 'park' ? findPark(Math.max(G.rider.p.z, 200) + 60) : opts.warp);
    G.rider.flow = 0.6; G.rider.v.set(0, 0, opts.spd || 24);
    CH.init = false;
  }
  const shot = trailerShots().find(s => s.name === (opts.shot || 'carve')) || trailerShots()[0];
  const n = opts.frames || 90;
  for (let i = 0; i < n; i++) {
    stepWorld(dt);
    if (opts.wx !== undefined && G.wx) { G.wx.target = opts.wx; G.wx.wx = opts.wx; }
    shot.cam(opts.t === undefined ? i / 30 : opts.t, dt);
    present(dt, false);
    if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));
  }
  G.ren.render(G.scene, G.cam);
  let src = G.ren.domElement;
  if (opts.title) {                              // compose the title card on top
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx = cv.getContext('2d');
    cx.drawImage(G.ren.domElement, 0, 0, W, H);
    const g = cx.createLinearGradient(0, H * 0.42, 0, H);
    g.addColorStop(0, 'rgba(10,22,40,0)'); g.addColorStop(1, 'rgba(8,18,34,0.62)');
    cx.fillStyle = g; cx.fillRect(0, 0, W, H);
    const s = W / 1200;
    cx.textBaseline = 'alphabetic';
    cx.fillStyle = '#fff';
    cx.font = `800 ${104 * s}px ui-rounded, system-ui, sans-serif`;
    cx.letterSpacing = `${9 * s}px`;
    cx.shadowColor = 'rgba(6,16,32,.45)'; cx.shadowBlur = 26 * s; cx.shadowOffsetY = 4 * s;
    cx.fillText('FLOWLINE', 74 * s, H - 108 * s);
    cx.shadowBlur = 10 * s;
    cx.font = `600 ${33 * s}px ui-rounded, system-ui, sans-serif`;
    cx.letterSpacing = `${5 * s}px`;
    cx.fillStyle = 'rgba(255,255,255,.9)';
    cx.fillText(opts.title === true ? 'ONE ENDLESS MOUNTAIN · ONE LINE' : opts.title, 78 * s, H - 58 * s);
    src = cv;
  }
  TR.on = false;
  document.getElementById('ui').style.visibility = '';
  const url = src.toDataURL('image/png');
  TR.still = url.slice(url.indexOf(',') + 1);
  return { len: TR.still.length, w: W, h: H };
}
G.dbg.still = o => stillRender(o);
G.dbg.stillB64 = (from, len) => TR.still.substr(from, len);

G.dbg.trailer = o => trailerRender(o);
G.dbg.trailerAudio = () => trailerAudio();
G.dbg.TR = TR;
G.dbg.b64 = (which, from, len) => b64slice(which === 'wav' ? TR.wav : TR.video, from, len);
