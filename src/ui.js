/* ------------------------------------------------- UI, input, HUD */
const $ = id => document.getElementById(id);
const LS = {
  get(k, d) { try { const v = localStorage.getItem('flowline_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('flowline_' + k, JSON.stringify(v)); } catch (e) { } }
};
/* Volume is stored as a 0..1 gain per bus and the old on/off booleans are
   DERIVED from it (vol > 0), so every existing `OPT.music` / `OPT.sfx` check and
   the M key keep working while the user gets a real fader. Legacy saves that
   only have the booleans fall back to 0.7 / 1.0. */
const OPT = {
  musVol: LS.get('musVol', LS.get('music', true) ? 0.7 : 0),
  sfxVol: LS.get('sfxVol', LS.get('sfx', true) ? 1.0 : 0),
  camZoom: LS.get('camZoom', 0.6),      // chase-camera scale, see CAMZ in util.js (1 = the old rig)
  /* `high` is gone. It was a second graphics control that fought the first: this
     file set G.q.detail/G.q.trees from it and then called setQuality, whose
     Object.assign(G.q, QLEVELS[lvl]) overwrote both - so HIGH DETAIL was a dead
     switch at every pinned tier, and QLEVELS carries trees: true on all four
     tiers, so it could never have turned trees off anyway. The stored key is left
     unread rather than migrated; GRAPHICS alone decides now. */
  inv: LS.get('inv', false),
  /* 'auto' follows the player's own clock; a number pins that hour. See sunFor
     in util.js for the arc and why 7 and 17 are the two ends. DEFAULT IS 7
     (MORNING), not 'auto': that is the most polished light (Alexander,
     2026-08-03), and a first-time player should not land on whatever hour
     their clock happens to read. 'auto' is still one click away, and ?hour=
     still outranks this (todResolve in util.js). */
  tod: LS.get('tod', 7),
  /* 'auto' = the existing autoQuality ladder. A number PINS that tier and stops
     autoQuality voting at all, which is the real answer to "let me turn GPU
     acceleration off": a web page cannot do that (WebGL is always on the GPU;
     the only fallback is a software rasteriser that is far slower), but it CAN
     stop asking the GPU for so much. Pinning also survives a reload, so a
     machine that freezes at AUTO has a permanent way out. */
  gfx: LS.get('gfx', 'auto'),
  get music() { return this.musVol > 0; }, set music(v) { this.musVol = v ? (this._mm || 0.7) : (this._mm = this.musVol, 0); },
  get sfx() { return this.sfxVol > 0; }, set sfx(v) { this.sfxVol = v ? (this._ms || 1.0) : (this._ms = this.sfxVol, 0); }
};

/* what the pause-menu LIGHT button cycles through */
const TOD_STEPS = [['auto', 'AUTO'], [7, 'MORNING'], [12, 'MIDDAY'], [17, 'EVENING']];
/* THE single graphics control. Three manual steps, not four: LOW is tier 0 - the
   genuinely cheap one, with no deformable snow - because offering both LOWEST and
   LOW made the player choose between two settings that differed only in degree
   while neither actually switched the expensive system off. MEDIUM is 2 and HIGH
   is 3. Tier 1 is still reachable, but only by the AUTO ladder, which wants the
   extra rung to adapt smoothly; a human picking from a list does not.
   Values are QLEVELS indices, so they must stay valid indices. */
const GFX_STEPS = [['auto', 'AUTO'], [0, 'LOW'], [2, 'MEDIUM'], [3, 'HIGH']];
/* Every INTERNAL tier needs a name, including rung 1, because AUTO reports the
   tier it has settled on and a pin reports where the safety net has landed. */
const TIER_NAME = ['LOW', 'MID', 'MEDIUM', 'HIGH'];
/* A build from before the merge could have stored gfx: 1, which is no longer an
   offered step. Left alone it would pin tier 1 while the button displayed AUTO,
   so the control would lie about what it was doing. */
if (OPT.gfx !== 'auto' && !GFX_STEPS.some(s => s[0] === +OPT.gfx)) OPT.gfx = 'auto';

/* Change the time of day at RUNTIME. This is the expensive path, and it is
   expensive only because three things are BAKED under the sun rather than lit by
   it per frame: the sky dome, the far-tree impostor atlas, and the weather's
   clear-air baseline. At boot all three are free (main.js sets the sun before it
   builds any of them); here all three have to be paid. Measured together this is
   a handful of ms, which is fine for a deliberate menu action - but it is why
   this must never be put on a per-frame or autoQuality path. */
function setTod(hour) {
  if (!G.sky) return null;
  /* An explicit argument wins over ?hour=: once the player has touched the
     control, honouring a stale URL override would make the button look dead. */
  G.tod = hour === undefined ? todResolve() : { hour, src: 'set' };
  G.todSun = applySun(WU, G.tod.hour);
  if (G.wx) G.wx.rebase();                 // else a clearing squall reverts the sun
  G.sky.relight(G.ren);                    // painted glare and cast shadows stay in step
  if (G.world) G.world.rebakeImpostor();   // the distant forest is baked, not lit
  return G.todSun;
}

const UI = {
  lastSeg: -99, toastT: 0, boardT: 0, warnT: 0, compact: false,
  toast(big, small) {
    const el = document.createElement('div');
    el.className = 'pop';
    el.innerHTML = big + (small ? '<i>' + small + '</i>' : '');
    $('toast').appendChild(el);
    setTimeout(() => el.remove(), 1600);
    SFX.chime(Math.floor(Math.random() * 5) * 2);
  },
  warn(msg) {
    if (nowMs() - this.warnT < 900) return;
    this.warnT = nowMs();
    const b = $('balTxt');
    b.textContent = msg.toUpperCase();
    b.style.opacity = 1;
    clearTimeout(this._wt);
    this._wt = setTimeout(() => b.style.opacity = 0, 1100);
  },
  net(on) {
    $('netdot').classList.toggle('off', !on);
    $('netTxt').textContent = on ? 'LIVE' : 'SOLO';
  },
  wipeout(dist, why) {
    $('wipeDist').innerHTML = fmt(dist) + ' m' + (why ? ' — ' + why : '') + TIMER.summary(dist);
    $('wipe').classList.add('on');
  },
  respawn() { $('wipe').classList.remove('on'); TIMER.reset(); },
  allTime(top) {
    const el = $('atRows');
    if (!top || !top.length) { el.innerHTML = '<div style="opacity:.5;font-size:11px;font-weight:600">no lines yet</div>'; return; }
    el.innerHTML = top.slice(0, 5).map((e, i) =>
      `<div class="row"><span style="opacity:.5;width:12px">${i + 1}</span><span class="nm">${esc(e.n)}</span><span class="ds">${fmt(e.d)}m</span></div>`).join('');
  }
};
const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/* ---------------- input ---------------- */
/* flipF/flipB are deliberately absent from the touch block below and from
   pollPad: PB10 flips are keyboard-only by design, so mobile gains no button. */
const IN = { left: 0, right: 0, tuck: 0, grab: 0, pop: false, touchSteer: 0, flipF: 0, flipB: 0 };
function initUI() {
  if (G.dbg) G.dbg.resp = RESP;   // R4: live response tuning
  /* live camera zoom, bypassing the slider and persistence - for measurement.
     Reads back the value in force so a null result cannot be mistaken for a
     dead knob. */
  if (G.dbg) G.dbg.zoom = v => { if (typeof v === 'number') CAMZ.zoom = v; return CAMZ.zoom; };
  const canType = e => e.target && /input|textarea/i.test(e.target.tagName);
  addEventListener('keydown', e => {
    if (canType(e)) { if (e.key === 'Enter') $('go').click(); return; }
    const k = e.key.toLowerCase();
    if (k === 'a' || k === 'arrowleft') IN.left = 1;
    else if (k === 'd' || k === 'arrowright') IN.right = 1;
    else if (k === 's' || k === 'arrowdown') IN.tuck = 1;
    else if (k === ' ' || k === 'w' || k === 'arrowup') { IN.pop = true; G.rider.input.pop = true; }
    else if (k === 'shift') IN.grab = 1;
    else if (k === 'e') IN.flipF = 1;          // PB10: front flip (nose down)
    else if (k === 'q') IN.flipB = 1;          // PB10: back flip (nose up)
    else if (k === '?' || k === '/') flowSheet(true);
    else if (k === 'p' || k === 'escape') { if (flowOpen) flowSheet(false); else togglePause(); }
    else if (k === 'r') { if (G.started && G.rider.state === 'ride') { G.rider.wipeout('restarted'); } }
    else if (k === 'm') { OPT.music = !OPT.music; applyOpt(); }
    else if (k === 't') { TIMER.toggle(); }
    else if (k === 'f') { G.dbg.fps(); }
    else return;
    e.preventDefault();
  });
  addEventListener('keyup', e => {
    if (canType(e)) return;
    const k = e.key.toLowerCase();
    if (k === 'a' || k === 'arrowleft') IN.left = 0;
    else if (k === 'd' || k === 'arrowright') IN.right = 0;
    else if (k === 's' || k === 'arrowdown') IN.tuck = 0;
    else if (k === 'shift') IN.grab = 0;
    else if (k === 'e') IN.flipF = 0;
    else if (k === 'q') IN.flipB = 0;
  });
  addEventListener('blur', () => { IN.left = IN.right = IN.tuck = IN.grab = IN.flipF = IN.flipB = 0; });

  // a thumb lands on this by accident far too easily, so touch gets a confirm tap
  let armT = 0;
  $('endRun').onclick = () => {
    if (!(G.started && G.rider.state === 'ride')) return;
    if (document.body.classList.contains('touch') && nowMs() - armT > 2600) {
      armT = nowMs();
      $('endTxt').textContent = 'SURE?';
      $('endRun').classList.add('arm');
      SFX.ui(false);
      setTimeout(() => {
        if (nowMs() - armT < 2500) return;
        $('endTxt').textContent = 'END RUN'; $('endRun').classList.remove('arm');
      }, 2600);
      return;
    }
    armT = 0;
    $('endTxt').textContent = 'END RUN'; $('endRun').classList.remove('arm');
    G.rider.wipeout('run ended'); SFX.ui(false);
  };
  // --- start
  const nameIn = $('nameIn');
  nameIn.value = LS.get('name', '') || '';
  $('go').onclick = () => {
    let nm = (nameIn.value || '').trim().slice(0, 12);
    if (!nm) nm = 'rider' + (100 + Math.floor(Math.random() * 899));
    LS.set('name', nm);
    startGame(nm);
  };
  // --- pause switches
  const sw = (id, key) => {
    const el = $(id);
    el.classList.toggle('on', !!OPT[key]);
    el.onclick = () => { OPT[key] = !OPT[key]; el.classList.toggle('on', OPT[key]); applyOpt(); SFX.ui(OPT[key]); };
  };
  sw('swInv', 'inv');
  // --- volume faders (0 = muted, so they replace the old on/off switches)
  const fader = (id, key) => {
    const el = $(id), num = $(id + 'N');
    const show = () => { el.value = Math.round(OPT[key] * 100); num.textContent = el.value; };
    show();
    el.oninput = () => { OPT[key] = (+el.value) / 100; num.textContent = el.value; applyOpt(); };
    el.onchange = () => SFX.ui(OPT[key] > 0);
    UI['show_' + id] = show;      // the M key changes the value behind the slider
  };
  fader('volMusic', 'musVol'); fader('volSfx', 'sfxVol');
  fader('camZoom', 'camZoom');
  // --- time of day: AUTO (player's clock) / MORNING / MIDDAY / EVENING
  const cyc = $('cycTod');
  if (cyc) {
    const show = () => {
      const s = TOD_STEPS.find(x => String(x[0]) === String(OPT.tod)) || TOD_STEPS[0];
      /* The label must describe the light that is ACTUALLY in force, never the
         stored preference, or the control lies. ?hour= outranks OPT (todResolve),
         so while a URL override is live say so - otherwise a player with
         MORNING saved and ?hour=12 in the address bar sees a midday mountain
         under a button reading MORNING. One click takes the override back,
         because setTod's explicit argument beats the URL. */
      const url = G.tod && G.tod.src === 'url';
      /* AUTO shows the hour it actually resolved to, so a player at 23:00 can see
         that they are being given the 17:00 look rather than wondering why the
         setting appears to do nothing. */
      cyc.textContent = url ? 'URL · ' + todHM(G.tod.hour)
        : OPT.tod === 'auto' ? 'AUTO · ' + todHM(G.todSun ? G.todSun.hour : todClock())
        : s[1];
    };
      cyc.onclick = () => {
      const i = TOD_STEPS.findIndex(x => String(x[0]) === String(OPT.tod));
      OPT.tod = TOD_STEPS[(i + 1) % TOD_STEPS.length][0];
      setTod(OPT.tod === 'auto' ? todClock() : +OPT.tod);
      show(); applyOpt(); SFX.ui(true);
    };
    show();
    UI.show_cycTod = show;
  }
  // --- graphics: AUTO (the autoQuality ladder) or a pinned tier
  const cg = $('cycGfx');
  if (cg) {
    const show = () => {
      const s = GFX_STEPS.find(x => String(x[0]) === String(OPT.gfx)) || GFX_STEPS[0];
      /* Same rule as the LIGHT button: report what is ACTUALLY in force. On AUTO
         the ladder moves on its own, so show the tier it has settled on rather
         than just the word AUTO - otherwise a player whose machine has quietly
         demoted itself has no way to see that, and no way to tell whether the
         setting did anything. ?lq pins tier 0 via dbg.lockQ and outranks this. */
      cg.textContent = G.dbg.lockQ ? 'LOW · LOCKED'
        : OPT.gfx === 'auto' ? 'AUTO · ' + (TIER_NAME[G.q.lvl] || '?')
        /* A pin is a ceiling, so the safety net can be holding us BELOW it. Say
           so, for the same reason AUTO reports its settled tier: the player opens
           this control to find out what is actually being drawn. */
        : G.q.lvl < +OPT.gfx ? s[1] + ' · ' + (TIER_NAME[G.q.lvl] || '?')
        : s[1];
    };
    cg.onclick = () => {
      const i = GFX_STEPS.findIndex(x => String(x[0]) === String(OPT.gfx));
      OPT.gfx = GFX_STEPS[(i + 1) % GFX_STEPS.length][0];
      show(); applyOpt(); SFX.ui(true);
    };
    show();
    UI.show_cycGfx = show;
  }
  $('resume').onclick = () => togglePause(false);
  $('shareBtn').onclick = () => {
    const d = Math.round(Math.max(G.rider.dist, LS.get('best', 0)));
    const txt = `I rode ${fmt(d)}m down FLOWLINE — one endless mountain, everyone on it at once. ${location.origin}${location.pathname}`;
    open('https://x.com/intent/post?text=' + encodeURIComponent(txt), '_blank');
  };
  $('pauseBtn').onclick = () => { togglePause(); SFX.ui(true); };
  // --- flow explainer: ring badge mid-run, title card, pause menu
  $('flowQ').onclick = () => flowSheet(true);
  $('flowLink').onclick = () => flowSheet(true);
  $('flowBtn').onclick = () => flowSheet(true);
  $('flowClose').onclick = () => flowSheet(false);
  $('flowSheet').addEventListener('pointerdown', e => { if (e.target.id === 'flowSheet') flowSheet(false); });
  // --- touch
  if (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) {
    $('touch').classList.add('on');
    document.body.classList.add('touch');
    const hold = (id, on, off) => {
      const el = $(id);
      el.addEventListener('touchstart', e => { e.preventDefault(); on(); }, { passive: false });
      el.addEventListener('touchend', e => { e.preventDefault(); off && off(); }, { passive: false });
      el.addEventListener('touchcancel', e => { off && off(); });
    };
    hold('ta1', () => IN.left = 1, () => IN.left = 0);
    hold('ta2', () => IN.right = 1, () => IN.right = 0);
    hold('tjump', () => { IN.pop = true; G.rider.input.pop = true; }, () => { });
    hold('ttuck', () => IN.tuck = 1, () => IN.tuck = 0);
    hold('tl', () => IN.left = 1, () => IN.left = 0);
    hold('tr', () => IN.right = 1, () => IN.right = 0);
  }
  document.addEventListener('visibilitychange', () => {
    if (AU.ctx) AU.master.gain.setTargetAtTime(document.hidden ? 0 : AU.MASTER, AU.ctx.currentTime, 0.1);
  });
  applyOpt();
  TIMER.init();
  UI.allTime([]);
  const best = LS.get('best', 0);
  if (best > 0) $('best').textContent = 'BEST ' + fmt(best) + ' m';
  const cmq = matchMedia('(max-width:900px),(max-height:560px)');
  const readCmp = () => { UI.compact = cmq.matches; };
  readCmp();
  cmq.addEventListener ? cmq.addEventListener('change', readCmp) : addEventListener('resize', readCmp);
}

function applyOpt() {
  AU.music = OPT.music; AU.sfx = OPT.sfx;
  if (AU.ctx) {
    /* 0.55 and 0.9 stay the reference mix; the faders scale it, so 70% music /
       100% sound reproduces the tuned balance exactly. */
    AU.musG.gain.setTargetAtTime(G.started ? 0.55 * OPT.musVol : 0.0, AU.ctx.currentTime, 0.4);
    AU.sfxG.gain.setTargetAtTime(0.9 * OPT.sfxVol, AU.ctx.currentTime, 0.1);
  }
  if (UI.show_volMusic) { UI.show_volMusic(); UI.show_volSfx(); }
  if (UI.show_camZoom) UI.show_camZoom();
  CAMZ.zoom = OPT.camZoom;
  LS.set('musVol', OPT.musVol); LS.set('sfxVol', OPT.sfxVol);
  LS.set('camZoom', OPT.camZoom);
  LS.set('music', OPT.music); LS.set('sfx', OPT.sfx);      // kept for older builds
  LS.set('inv', OPT.inv); LS.set('tod', OPT.tod);
  LS.set('gfx', OPT.gfx);
  /* GRAPHICS goes LAST because setQuality owns px/caps/lod/cascades/detail/deform
     outright and must not be undone by anything above it. There is no longer a
     competing detail line here to lose that race against.
     G.qPin is now a CEILING rather than a lock: autoQuality will still demote
     below it and the emergency demote in frame() ignores it entirely, so a pin
     the machine cannot hold no longer strands the player on a frozen tier.
     Guarded on G.ren because applyOpt also runs from initUI before boot finishes. */
  G.qPin = OPT.gfx === 'auto' ? null : +OPT.gfx;
  if (G.ren && G.qPin !== null && !G.dbg.lockQ) setQuality(G.qPin);
  if (UI.show_cycGfx) UI.show_cycGfx();
}

function togglePause(force) {
  const p = force === undefined ? !G.paused : force;
  if (!G.started) return;
  G.paused = p;
  $('pause').classList.toggle('on', p);
  document.body.classList.toggle('paused', p);   // touch pads must not eat the menu
  if (AU.ctx) AU.master.gain.setTargetAtTime(p ? 0 : AU.MASTER, AU.ctx.currentTime, 0.12);
}

/* --- the flow explainer: opt-in, and it holds the run so you can actually read it --- */
let flowOpen = false;
function flowSheet(open) {
  if (open === flowOpen) return;
  flowOpen = open;
  $('flowSheet').classList.toggle('on', open);
  document.body.classList.toggle('paused', open || $('pause').classList.contains('on'));
  if (G.started) G.paused = open || $('pause').classList.contains('on');
  if (AU.ctx) AU.master.gain.setTargetAtTime(G.paused ? 0 : AU.MASTER, AU.ctx.currentTime, 0.12);
  if (open) $('flowCard').scrollTop = 0;
  SFX.ui(open);
}

function startGame(name) {
  G.started = true;
  initAudio();
  applyOpt();
  SFX.drop();
  $('start').classList.add('gone');
  $('hud').classList.add('on');
  setTimeout(() => { const s = $('start'); if (s) s.style.display = 'none'; }, 900);
  G.rider.reset();
  TIMER.reset();
  BOTS.reset();
  if (START_Z > 0) G.dbg.warp(START_Z);
  camCut();                                // title camera was orbiting; cut, don't fly
  G.net = new Net(name);
  UI.net(false);
}

/* ---------------- gamepad ---------------- */
function pollPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;
    const ax = p.axes[0] || 0;
    if (Math.abs(ax) > 0.12) IN.touchSteer = ax;
    if (p.buttons[0] && p.buttons[0].pressed) { if (!IN._pa) { G.rider.input.pop = true; IN._pa = 1; } } else IN._pa = 0;
    IN.tuck = (p.buttons[1] && p.buttons[1].pressed) || (p.buttons[7] && p.buttons[7].value > 0.4) ? 1 : IN.tuck;
    IN.grab = (p.buttons[2] && p.buttons[2].pressed) ? 1 : IN.grab;
    return;
  }
}

/* ---------------- per-frame HUD ---------------- */
let steerSm = 0;
function readInput(dt) {
  pollPad();
  let s = (IN.left - IN.right) - IN.touchSteer;
  IN.touchSteer = 0;
  if (OPT.inv) s = -s;
  steerSm += (clamp(s, -1, 1) - steerSm) * (1 - Math.exp(-RESP.steerK * dt));
  const inp = G.rider.input;
  inp.steer = steerSm;
  inp.tuck = IN.tuck;
  inp.grab = IN.grab;
  /* -1/0/+1, and exactly 0 unless a key is physically held, which is what keeps
     the rider's flip branch unentered for everyone who ignores the feature. */
  inp.flip = IN.flipF - IN.flipB;
}

let stuckT = 0;
function updateHUD() {
  const r = G.rider;
  // stuck helper: slow for a while on the ground -> highlight the end run button
  if (r.state === 'ride' && r.grounded && r.speed < 3.2) stuckT += 1 / 60; else stuckT = 0;
  $('endRun').classList.toggle('warn', stuckT > 2.2);
  $('spd').innerHTML = Math.round(r.speed * 3.6) + '<small>KM/H</small>';
  const d = Math.round(r.dist);
  $('dist').innerHTML = fmt(d) + '<span>m</span>';
  const ring = $('ringFill');
  ring.setAttribute('stroke-dasharray', (r.flow * 245).toFixed(1) + ' 400');
  const hot = r.flow > 0.88;
  ring.setAttribute('stroke', hot ? '#fff2c0' : (r.flow > 0.6 ? '#ffb347' : '#ffc65e'));
  $('flowLabel').textContent = hot ? 'IN FLOW' : 'FLOW';
  $('flowLabel').style.color = hot ? '#fff2c0' : '';
  const bw = $('balWrap');
  bw.classList.toggle('on', r.balance < 0.985);
  $('bal').style.transform = 'scaleX(' + clamp(r.balance, 0, 1) + ')';
  $('bal').style.background = r.balance < 0.4 ? 'linear-gradient(90deg,#ff8f6a,#ff5c5c)' : 'linear-gradient(90deg,#ffd36e,#ffa03c)';
  // zone
  let z = 'GROOMED';
  if (!r.grounded) z = 'AIR';
  else if (r.grinding) z = 'RAIL';
  else if (r.surf.solid) z = 'PARK';
  else if (r.surf.ice > 0.35) z = 'ICE';
  else if (r.surf.groom < 0.35) z = r.surf.kind === 2 ? 'GULLY' : (r.surf.dEdge > 30 ? 'OFF PISTE' : 'POWDER');
  else if (r.surf.park) z = 'PARK';
  if (G.wx && G.wx.wx > 0.5 && r.grounded && !r.grinding) z = 'SNOWING';
  $('zoneTxt').textContent = z;
  // best
  const best = LS.get('best', 0);
  if (d > best + 5) { LS.set('best', d); $('best').textContent = 'BEST ' + fmt(d) + ' m'; }
  // segment announce
  const seg = Math.floor((r.p.z + 120) / SEG);
  if (seg !== UI.lastSeg) {
    UI.lastSeg = seg;
    const lab = getSeg(seg).label;
    if (lab && r.dist > 60) UI.toast(lab, 'ahead');
  }
  // leaderboard
  if (nowMs() - UI.boardT > 220) {
    UI.boardT = nowMs();
    const list = G.net ? G.net.board() : [{ n: 'you', d: r.dist, me: 1 }];
    $('riderCount').textContent = list.length > 1 ? list.length + ' LIVE' : '';
    $('boardEmpty').style.display = list.length > 1 ? 'none' : '';
    // small screens: the board collapses to the other riders, and vanishes when solo
    document.body.classList.toggle('solo', list.length <= 1);
    $('rows').innerHTML = list.slice(0, UI.compact ? 4 : 9).map((e, i) => {
      const c = e.me ? '#ffe08a' : '#' + (e.col || 0x8fd0ff).toString(16).padStart(6, '0');
      return `<div class="row ${e.me ? 'me' : ''}"><span class="dot" style="background:${c}"></span>` +
        `<span class="nm">${esc(e.n)}</span><span class="ds">${fmt(e.d)}m</span></div>`;
    }).join('');
  }
  TIMER.update(r);
  MU.flow = OPT.music ? r.flow : 0;
  SFX.update(r, G.dt);
}
