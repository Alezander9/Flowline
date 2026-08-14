/* ------------------------------------------------- flow-reactive music */
const MU = { step: 0, next: 0, timer: null, chord: 0, lead: 0, flow: 0, on: false };
const mf = m => 440 * Math.pow(2, (m - 69) / 12);
const BPM = 96, S16 = 60 / BPM / 4;
const PROG = [
  { ch: [57, 61, 64, 68], bass: 45, pent: [57, 61, 64, 66, 69] },   // Amaj7
  { ch: [56, 59, 64, 66], bass: 40, pent: [56, 59, 64, 66, 71] },   // E
  { ch: [54, 57, 61, 64], bass: 42, pent: [54, 57, 61, 64, 66] },   // F#m7
  { ch: [50, 54, 57, 61], bass: 38, pent: [50, 54, 57, 61, 64] }    // Dmaj7
];

function startMusic() {
  if (MU.on || !AU.ctx) return;
  MU.on = true;
  MU.next = AU.ctx.currentTime + 0.15;
  // pad chain
  const ctx = AU.ctx;
  AU.padF = ctx.createBiquadFilter(); AU.padF.type = 'lowpass'; AU.padF.frequency.value = 900; AU.padF.Q.value = 0.7;
  AU.padG = ctx.createGain(); AU.padG.gain.value = 0.9;
  AU.padF.connect(AU.padG); AU.padG.connect(AU.musG);
  const pv = ctx.createGain(); pv.gain.value = 0.8; AU.padG.connect(AU.verb);
  // delay for the lead
  AU.dly = ctx.createDelay(1.0); AU.dly.delayTime.value = 60 / BPM * 0.75;
  AU.dlyG = ctx.createGain(); AU.dlyG.gain.value = 0.34;
  AU.dly.connect(AU.dlyG); AU.dlyG.connect(AU.dly); AU.dlyG.connect(AU.musG);
  MU.timer = setInterval(musicTick, 55);
}

function musicNote(m, t, dur, type, vol, dest, det) {
  const ctx = AU.ctx;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = mf(m) * (det || 1);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.02, dur * 0.15));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(dest);
  o.start(t); o.stop(t + dur + 0.05);
}

function musicTick() {
  if (!AU.ctx || !MU.on) return;
  const t0 = AU.ctx.currentTime;
  const flow = MU.flow;
  const L1 = smoothstep(0.10, 0.34, flow);   // drums
  const L2 = smoothstep(0.26, 0.52, flow);   // bass
  const L3 = smoothstep(0.44, 0.70, flow);   // plucks
  const L4 = smoothstep(0.68, 0.92, flow);   // lead
  AU.padF.frequency.setTargetAtTime(700 + flow * 2100, t0, 0.4);
  while (MU.next < t0 + 0.4) {
    const t = MU.next, s = MU.step;
    const bar32 = s % 32, ci = Math.floor(s / 32) % 4;
    const P = PROG[ci];
    // --- pad on chord change
    if (bar32 === 0) {
      for (let i = 0; i < P.ch.length; i++) {
        const m = P.ch[i] - 12;
        for (const det of [0.997, 1.003]) {
          const ctx = AU.ctx;
          const o = ctx.createOscillator(); o.type = i === 0 ? 'sawtooth' : 'triangle';
          o.frequency.value = mf(m) * det;
          const g = ctx.createGain();
          const dur = S16 * 32;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(0.055 * (i === 0 ? 1 : 0.7), t + 0.9);
          g.gain.linearRampToValueAtTime(0.045 * (i === 0 ? 1 : 0.7), t + dur * 0.8);
          g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.35);
          o.connect(g); g.connect(AU.padF);
          o.start(t); o.stop(t + dur + 0.5);
        }
      }
    }
    // --- kick
    if (L1 > 0.02 && (bar32 % 16 === 0 || bar32 % 16 === 10)) {
      const o = AU.ctx.createOscillator(), g = AU.ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(115, t);
      o.frequency.exponentialRampToValueAtTime(44, t + 0.14);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.34 * L1, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g); g.connect(AU.musG);
      o.start(t); o.stop(t + 0.3);
    }
    // --- hats
    if (L1 > 0.05 && bar32 % 2 === 0) {
      const acc = (bar32 % 8 === 4) ? 1.5 : 1;
      noise(t, 0.045, 0.028 * L1 * acc, 'highpass', 7200, 0.8, AU.musG);
    }
    // --- soft clap
    if (L1 > 0.3 && (bar32 === 8 || bar32 === 24)) {
      noise(t, 0.13, 0.10 * L1, 'bandpass', 1700, 1.1, AU.musG);
      noise(t + 0.012, 0.1, 0.06 * L1, 'bandpass', 2400, 1.4, AU.verb);
    }
    // --- bass
    if (L2 > 0.03) {
      if (bar32 === 0) musicNote(P.bass, t, S16 * 7, 'triangle', 0.16 * L2, AU.musG);
      if (bar32 === 12) musicNote(P.bass, t, S16 * 3, 'triangle', 0.11 * L2, AU.musG);
      if (bar32 === 16) musicNote(P.bass + 12, t, S16 * 4, 'triangle', 0.09 * L2, AU.musG);
      if (bar32 === 22) musicNote(P.bass + 7, t, S16 * 5, 'triangle', 0.10 * L2, AU.musG);
    }
    // --- plucks
    if (L3 > 0.03 && bar32 % 2 === 0) {
      const seq = [0, 2, 1, 3, 2, 3, 1, 2, 0, 1, 2, 3, 2, 1, 3, 2];
      const n = P.ch[seq[(bar32 / 2) | 0] % P.ch.length] + (bar32 % 8 === 6 ? 12 : 0);
      musicNote(n, t, 0.30, 'triangle', 0.075 * L3, AU.musG);
      musicNote(n + 12, t, 0.16, 'sine', 0.028 * L3, AU.verb);
    }
    // --- lead
    if (L4 > 0.05 && bar32 % 8 === 0) {
      if (Math.random() < 0.8) {
        MU.lead = (MU.lead + (Math.random() < 0.5 ? 1 : -1) + 5) % 5;
        const n = P.pent[MU.lead] + 12;
        musicNote(n, t, 0.55, 'sine', 0.085 * L4, AU.musG);
        musicNote(n, t, 0.5, 'triangle', 0.03 * L4, AU.dly);
      }
    }
    MU.step++; MU.next += S16;
  }
}
