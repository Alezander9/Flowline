/* ------------------------------------------------- speedrun timer & splits
   The clock runs on rider.runT (SIM seconds), not wall clock, so a slow
   machine, a paused tab and a 240Hz monitor all produce comparable times.
   Splits are keyed to the SEED: a different mountain is a different category. */
const SPLIT_D = [10000, 25000, 50000, 100000];
const SPLIT_LBL = ['10K', '25K', '50K', '100K'];

function fmtT(t) {
  if (!(t > 0)) return '--:--';
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  const ss = (s < 10 ? '0' : '') + s.toFixed(2);
  if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + ss.slice(0, 5);
  return m + ':' + ss;
}
function fmtD(d) {                       // signed delta vs pb
  const a = Math.abs(d);
  const m = Math.floor(a / 60), s = a % 60;
  const body = m > 0 ? m + ':' + (s < 10 ? '0' : '') + s.toFixed(1) : s.toFixed(1);
  return (d < 0 ? '-' : '+') + body;
}
/* Compact pb for the narrow .dl slot: whole seconds only. A 100K pb is ~55:33.21
   at full precision, which overflows 34px - and hundredths are noise on a target
   you are chasing from kilometres away. */
function fmtTs(t) {
  if (!(t > 0)) return '--:--';
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60);
  const ss = (s < 10 ? '0' : '') + s;
  return h > 0 ? h + ':' + (m < 10 ? '0' : '') + m + ':' + ss : m + ':' + ss;
}

const TIMER = {
  key: 'pb' + SEED,
  pb: null,                              // { '10000': secs, ... } best per split
  cur: [],                               // this run's splits, index-aligned to SPLIT_D
  shown: 0,                              // panel auto-reveal timer
  open: false,
  next: 0,

  init() {
    this.pb = LS.get(this.key, {}) || {};
    this.reset();
    this.render(true);
  },
  reset() {
    this.cur = SPLIT_D.map(() => 0);
    this.next = 0;
    this.render(true);
  },
  /* called every frame from updateHUD */
  update(r) {
    const t = r.runT, d = r.dist;
    // take any splits crossed this frame (a huge dt could cross two)
    while (this.next < SPLIT_D.length && d >= SPLIT_D[this.next]) {
      const i = this.next++;
      this.cur[i] = t;
      const k = String(SPLIT_D[i]);
      const old = this.pb[k] || 0;
      const gain = old > 0 ? t - old : 0;
      if (old === 0 || t < old) { this.pb[k] = t; LS.set(this.key, this.pb); }
      UI.toast(SPLIT_LBL[i] + ' &nbsp;' + fmtT(t),
        old === 0 ? 'first split' : (gain < 0 ? 'personal best ' + fmtD(gain) : fmtD(gain) + ' off pb'));
      this.shown = 4.2;                  // reveal the panel so the split is readable
      this.render(true);
    }
    const el = $('runT');
    if (el) el.textContent = fmtT(t);
    if (this.shown > 0) { this.shown -= G.dt; if (this.shown <= 0) this.render(true); }
    const vis = this.open || this.shown > 0;
    $('splits').classList.toggle('on', vis);
    /* Live distance to the next marker. render() is event-driven (split crossed,
       toggle, reveal expiry), so with the panel held open the number the player
       is staring at would otherwise stay frozen at whatever it was when it
       opened. Patch the one text node rather than re-running innerHTML: that
       would rebuild four rows a frame and restart the panel's CSS transition. */
    if (vis && this._go && this.next < SPLIT_D.length) {
      const m = Math.round(Math.max(0, SPLIT_D[this.next] - d));
      if (m !== this._goM) { this._goM = m; this._go.textContent = fmt(m) + 'm'; }
    }
  },
  toggle() {
    this.open = !this.open;
    this.render(true);
    SFX.ui(this.open);
  },
  render() {
    const el = $('splitRows');
    if (!el) return;
    const r = G.rider;
    el.innerHTML = SPLIT_D.map((d, i) => {
      const t = this.cur[i], pb = this.pb[String(d)] || 0;
      const done = t > 0;
      let right;
      if (done) {
        const dl = pb > 0 && Math.abs(t - pb) > 0.005 && t > pb ? fmtD(t - pb) : null;
        right = `<span class="st">${fmtT(t)}</span>` +
          (dl ? `<span class="dl slow">${dl}</span>` : (pb > 0 && t <= pb ? `<span class="dl fast">PB</span>` : ''));
      } else if (i === this.next && r) {
        /* The row you are actually chasing: live distance AND the pb you are
           chasing it against. The distance text is updated in place every frame
           by update() - render() runs only on split/toggle events, so anything
           written here goes stale the moment the rider moves. */
        const left = Math.max(0, d - r.dist);
        right = `<span class="st pend" id="splitGo">${fmt(Math.round(left))}m</span>` +
          (pb > 0 ? `<span class="dl pb">pb ${fmtTs(pb)}</span>` : '');
      } else {
        right = `<span class="st pend">${pb > 0 ? 'pb ' + fmtT(pb) : '—'}</span>`;
      }
      return `<div class="row ${done ? 'hit' : ''} ${i === this.next ? 'nx' : ''}">` +
        `<span class="nm">${SPLIT_LBL[i]}</span>${right}</div>`;
    }).join('');
    /* The innerHTML write above destroyed the old node, so the per-frame handle
       must be re-taken here - never cached anywhere else. Null once the last
       split is banked, which is what stops update() touching a dead node. */
    this._go = $('splitGo');
    this._goM = -1;
  },
  /* end-of-run summary line for the wipeout card */
  summary(dist) {
    const hits = this.cur.filter(t => t > 0).length;
    if (!hits) return '';
    return ' &nbsp;·&nbsp; ' + SPLIT_LBL[hits - 1] + ' in ' + fmtT(this.cur[hits - 1]);
  }
};
