/* ------------------------------------------------- synthesized audio */
const AU = { ctx: null, on: false, music: true, sfx: true, ready: false };

function noiseBuf(ctx, secs, kind) {
  const n = Math.floor(ctx.sampleRate * secs);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'pink') { last = (last * 0.94 + w * 0.06); d[i] = last * 6; }
    else d[i] = w;
  }
  return b;
}
function irBuf(ctx, secs, decay) {
  const n = Math.floor(ctx.sampleRate * secs);
  const b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < 60 ? i / 60 : 1);
    }
  }
  return b;
}

function initAudio() {
  if (AU.ctx) return;
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return;
  const ctx = new C();
  AU.ctx = ctx;
  /* MEASURED: 0.9 is right, and a lift is NOT the answer. Raising this to 1.7 to
     "reclaim the headroom the wind cut freed" was tuned at a quiet moment (61 km/h,
     -31 dBFS RMS) and clipped hard once actually riding: 79 km/h through a carve
     gave -10.3 dBFS RMS and +2.75 dBFS PEAK. Under real load the mix is ~15 dB
     hotter than at a cruise, so the level was never the problem - only the wind
     balance was. Tune this against FL.dbg.loud() WHILE RIDING HARD, never idling. */
  AU.MASTER = 0.9;
  const master = ctx.createGain(); master.gain.value = AU.MASTER;
  master.connect(ctx.destination);
  AU.master = master;
  /* Loudness meter on the master bus (post-compressor, i.e. what you actually
     hear). Mixing snow/wind noise by ear is unreliable - broadband noise reads
     far louder than its peak level suggests - so measure instead: mute a source,
     read dBFS, unmute, compare. Costs one analyser and no per-frame work. */
  AU.an = ctx.createAnalyser(); AU.an.fftSize = 2048; AU.an.smoothingTimeConstant = 0;
  master.connect(AU.an);
  AU._mb = new Float32Array(AU.an.fftSize);
  AU.meter = () => {
    AU.an.getFloatTimeDomainData(AU._mb);
    let sum = 0, pk = 0;
    for (let i = 0; i < AU._mb.length; i++) { const v = AU._mb[i]; sum += v*v; if (Math.abs(v) > pk) pk = Math.abs(v); }
    return { rms: Math.sqrt(sum / AU._mb.length), peak: pk };
  };
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 20; comp.ratio.value = 4;
  comp.attack.value = 0.004; comp.release.value = 0.22;
  comp.connect(master);
  AU.bus = comp;

  // reverb
  const conv = ctx.createConvolver();
  conv.buffer = irBuf(ctx, 2.2, 3.2);
  const wet = ctx.createGain(); wet.gain.value = 0.30;
  conv.connect(wet); wet.connect(comp);
  AU.verb = conv;

  AU.sfxG = ctx.createGain(); AU.sfxG.gain.value = 0.9; AU.sfxG.connect(comp);
  AU.musG = ctx.createGain(); AU.musG.gain.value = 0.0; AU.musG.connect(comp);
  const mv = ctx.createGain(); mv.gain.value = 0.5; AU.musG.connect(conv);

  AU.white = noiseBuf(ctx, 2.5, 'white');
  AU.pink = noiseBuf(ctx, 2.5, 'pink');

  /* ---- continuous ride layers ---- */
  const layer = (buf, type, freq, q, gain, dest) => {
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(dest || AU.sfxG);
    src.start(Math.random() * 2);
    return { src, f, g };
  };
  AU.carve = layer(AU.white, 'bandpass', 900, 2.2, 0);
  AU.carve2 = layer(AU.white, 'highpass', 2600, 0.7, 0);
  AU.crunch = layer(AU.pink, 'bandpass', 680, 3.4, 0);
  AU.crunchH = layer(AU.white, 'bandpass', 1650, 5.5, 0);
  AU.skid = layer(AU.white, 'bandpass', 2200, 0.8, 0);
  AU.powd = layer(AU.pink, 'lowpass', 700, 1.0, 0);
  AU.wind = layer(AU.pink, 'lowpass', 420, 0.9, 0);
  AU.windH = layer(AU.white, 'bandpass', 1500, 0.6, 0);
  AU.grind = layer(AU.white, 'bandpass', 3400, 9, 0);
  const gp = ctx.createBiquadFilter(); gp.type = 'peaking'; gp.frequency.value = 5200; gp.gain.value = 8;
  AU.ready = true;
  AU.on = true;
  startMusic();
}

const now = () => AU.ctx.currentTime;
function env(g, t0, peak, a, d, s) {
  g.gain.cancelScheduledValues(t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
}
function tone(freq, t0, dur, type, vol, f2, dest) {
  const ctx = AU.ctx;
  const o = ctx.createOscillator(); o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(f2, 1), t0 + dur);
  const g = ctx.createGain();
  env(g, t0, vol, Math.min(0.012, dur * 0.2), dur);
  o.connect(g); g.connect(dest || AU.sfxG);
  o.start(t0); o.stop(t0 + dur + 0.05);
  return { o, g };
}
function noise(t0, dur, vol, type, freq, q, dest, sweep) {
  const ctx = AU.ctx;
  const s = ctx.createBufferSource(); s.buffer = AU.white;
  s.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter(); f.type = type || 'bandpass';
  f.frequency.setValueAtTime(freq, t0);
  if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(sweep, 40), t0 + dur);
  if (q) f.Q.value = q;
  const g = ctx.createGain();
  env(g, t0, vol, Math.min(0.02, dur * 0.25), dur);
  s.connect(f); f.connect(g); g.connect(dest || AU.sfxG);
  s.start(t0, Math.random() * 1.5); s.stop(t0 + dur + 0.1);
}

const SFX = {
  update(r, dt) {
    if (!AU.ready || !AU.on) return;
    const t = now(), sp = r.speed, air = !r.grounded;
    const gs = AU.sfx ? 1 : 0;
    const set = (node, v, f, tc = 0.06) => {
      node.g.gain.setTargetAtTime(Math.max(0, v) * gs, t, tc);
      if (f) node.f.frequency.setTargetAtTime(f, t, 0.08);
    };
    const spn = clamp(sp / 30, 0, 1.4);
    const onSnow = !air && r.state === 'ride';
    const gr = r.grinding ? 1 : 0;
    const ice = r.surf.ice, pw = r.surf.pow;
    const ae = Math.abs(r.edge || 0);
    const cut = onSnow ? (1 - gr) : 0;
    set(AU.carve, cut * (0.16 + 0.72 * spn) * (0.28 + 0.72 * ae) * (1 - pw * 0.28),
      380 + sp * 48 + ae * 820);
    AU.carve.f.Q.value = 1.6 + ae * 8 + ice * 6;
    set(AU.carve2, cut * (0.08 + 0.30 * spn) * (0.20 + 0.80 * ice), 2100 + sp * 130);
    /* packed-snow crunch bed: mid thumps + high ice crystals */
    set(AU.crunch, cut * (0.10 + 0.48 * spn) * (0.40 + 0.60 * ae) * (0.45 + 0.55 * (1 - pw)),
      520 + sp * 22 + ae * 380);
    AU.crunch.f.Q.value = 2.4 + ae * 4;
    set(AU.crunchH, cut * (0.05 + 0.22 * spn) * (0.25 + 0.75 * ae) * (0.35 + 0.65 * ice),
      1400 + sp * 70 + ae * 600);
    set(AU.skid, onSnow ? clamp(r.skid, 0, 1.3) * 0.50 * (0.4 + 0.6 * spn) * (1 - gr) : 0, 1500 + sp * 40 + r.skid * 900);
    set(AU.powd, onSnow ? pw * (0.16 + 0.62 * spn) * (1 - gr) : 0, 460 + sp * 28);
    /* granular crunch grains — rate tracks speed * edge so a carve chatters */
    this._crT = (this._crT || 0) + dt * cut * (1.6 + spn * 11) * (0.22 + ae);
    while (this._crT > 1) {
      this._crT -= 0.72 + Math.random() * 0.55;
      const gv = (0.07 + 0.16 * spn) * (0.35 + 0.65 * ae) * gs;
      noise(t, 0.045 + Math.random() * 0.04, gv, 'bandpass',
        620 + Math.random() * 1400, 4.5 + Math.random() * 4);
      if (ae > 0.45 && Math.random() < 0.45)
        noise(t, 0.03, gv * 0.7, 'highpass', 2400 + Math.random() * 1800, 3.2);
    }
    if (typeof CLOTH_U !== 'undefined')
      CLOTH_U.value.set(clamp(sp / 28, 0, 1.35), r.edge || 0, air ? 1 : 0);
    /* Wind used to be the loudest thing in the game by a wide margin. It rode
       `spn`, which is clamped at 1.4, on a SQUARED curve: 0.035+0.4*1.96 = 0.82
       on the ground and 1.11 in the air - a full-scale pink-noise bed, which
       also pinned the master compressor and ducked everything else. It now
       saturates on its own normalised speed and tops out around 0.23/0.28
       (about -11 dB at top speed), so going fast still swells but the carve,
       the landings and the music can be heard over it. Measured with
       FL.dbg.loud() - see AU.meter above. */
    const wsp = clamp(sp / 34, 0, 1);
    set(AU.wind, (0.030 + 0.20 * Math.pow(wsp, 1.7)) * (air ? 1.22 : 1), 320 + sp * 26, 0.12);
    set(AU.windH, (air ? 0.10 : 0.032) * wsp, 1100 + sp * 90, 0.12);
    set(AU.grind, gr * 0.28 * (0.3 + 0.7 * spn), 2600 + sp * 90, 0.03);
    // ice chatter clicks
    if (r.chatter > 0.35 && Math.random() < r.chatter * 0.5) noise(t, 0.05, 0.10 * r.chatter * gs, 'bandpass', 3000 + Math.random() * 3000, 7);
  },
  pop(v) { if (!AU.ready || !AU.sfx) return; const t = now(); noise(t, 0.16, 0.22 * v, 'bandpass', 260, 1.2, null, 900); tone(150, t, 0.13, 'sine', 0.16 * v, 60); },
  land(v, pow) {
    if (!AU.ready || !AU.sfx) return; const t = now();
    noise(t, 0.24 + pow * 0.2, 0.34 * v, 'lowpass', 900 + pow * 400, 0.8, null, 200);
    tone(78, t, 0.16, 'sine', 0.30 * v, 40);
    noise(t + 0.01, 0.1, 0.12 * v, 'highpass', 3000, 0.7);
  },
  landClean(v) {
    if (!AU.ready || !AU.sfx) return; const t = now();
    SFX.land(v * 0.9, 0.2);
    tone(880, t + 0.02, 0.10, 'triangle', 0.05, 1320, AU.verb);
  },
  stumble(v) {
    if (!AU.ready || !AU.sfx) return; const t = now();
    noise(t, 0.3, 0.30 * v, 'bandpass', 700, 0.9, null, 180);
    tone(96, t, 0.22, 'triangle', 0.14 * v, 52);
  },
  wipeout() {
    if (!AU.ready || !AU.sfx) return; const t = now();
    noise(t, 0.9, 0.45, 'lowpass', 1800, 0.7, null, 140);
    noise(t + 0.05, 0.5, 0.2, 'bandpass', 400, 1.4, AU.verb, 120);
    tone(150, t, 0.7, 'triangle', 0.18, 38);
    tone(74, t + 0.05, 0.9, 'sine', 0.2, 30);
  },
  whoosh(v) {
    if (!AU.ready || !AU.sfx) return; const t = now();
    noise(t, 0.34, 0.20 * v, 'bandpass', 500, 1.1, null, 2600);
  },
  /* clipping a tree: a woody thud plus a shower of snow off the branches.
     rock hits swap the wood for a hard, brighter crack. */
  treeHit(v, rock) {
    if (!AU.ready || !AU.sfx) return; const t = now();
    const w = clamp(v, 0.25, 1.1);
    if (rock) {
      noise(t, 0.09, 0.34 * w, 'bandpass', 2600, 3.0, null, 900);
      tone(310, t, 0.10, 'square', 0.09 * w, 150);
      tone(1180, t + 0.005, 0.05, 'triangle', 0.07 * w, 700);
      noise(t + 0.03, 0.26, 0.11 * w, 'highpass', 3200, 0.7, AU.verb);
    } else {
      noise(t, 0.10, 0.30 * w, 'lowpass', 620, 1.2, null, 220);   // trunk thud
      tone(132, t, 0.16, 'triangle', 0.16 * w, 62);                // wood body
      tone(196, t + 0.004, 0.09, 'sine', 0.07 * w, 110);
      noise(t + 0.02, 0.42, 0.13 * w, 'highpass', 2400, 0.6, AU.verb);  // needles
      noise(t + 0.06, 0.5, 0.09 * w, 'bandpass', 1500, 0.5, AU.verb, 700); // snow dump
    }
  },
  chime(n) {
    if (!AU.ready || !AU.sfx) return; const t = now();
    const f = 660 * Math.pow(2, (n || 0) / 12);
    tone(f, t, 0.5, 'sine', 0.10, f, AU.verb);
    tone(f * 2, t + 0.01, 0.32, 'triangle', 0.04, f * 2, AU.verb);
  },
  ui(up) {
    if (!AU.ready || !AU.sfx) return; const t = now();
    tone(up ? 620 : 420, t, 0.09, 'triangle', 0.07, up ? 780 : 360);
  },
  drop() {
    if (!AU.ready) return; const t = now();
    tone(220, t, 0.5, 'triangle', 0.10, 440, AU.verb);
    tone(330, t + 0.08, 0.6, 'sine', 0.08, 660, AU.verb);
    noise(t, 0.7, 0.10, 'bandpass', 900, 0.8, AU.verb, 3200);
  }
};

