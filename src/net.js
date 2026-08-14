/* ------------------------------------------------- multiplayer */
const JACKETS = [0xff7a33, 0x4ec9f0, 0xf7d354, 0x9be86a, 0xff6fa5, 0xa98cff, 0xff9d5c, 0x63e0c0];
function labelTex(name, col) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d');
  x.font = '800 34px ui-rounded, system-ui, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.lineWidth = 7; x.strokeStyle = 'rgba(10,26,40,.55)';
  x.strokeText(name, 128, 34);
  x.fillStyle = '#' + col.toString(16).padStart(6, '0');
  x.fillText(name, 128, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class Peer {
  constructor(id, name, colIdx) {
    this.id = id; this.name = name || 'rider';
    this.col = JACKETS[colIdx % JACKETS.length];
    this.buf = [];
    this.dist = 0; this.flow = 0; this.state = 'ride';
    this.body = null; this.label = null;
    this.last = nowMs();
    this.r = { p: new THREE.Vector3(), v: new THREE.Vector3(), n: new THREE.Vector3(0, 1, 0), yaw: 0, edge: 0, speed: 0, crouch: 0, skid: 0, flow: 0, balance: 1, airT: 0, grounded: true, state: 'ride', input: { grab: false }, sink: 0, runT: 0, omega: 0, pitch: 0 };
  }
  ensureBody() {
    if (this.body) return;
    this.body = new RiderBody(G.scene, this.col, true);
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex(this.name, this.col), transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    this.label.scale.set(4.2, 1.05, 1);
    this.label.renderOrder = 20;
    G.scene.add(this.label);
  }
  hide() {
    if (!this.body) return;
    /* this.body.shadow only EXISTS for a ghost built when G.csc was absent: with
       the cascades present, rider_body.js takes the `cast` branch and never makes
       the blob quad (see rider_body.js ~405). Peers are always ghosts and G.csc
       always exists in a normal boot, so the unguarded version of this line threw
       on EVERY peer, EVERY frame - it is the frame-loop exception that froze the
       picture while the sim and audio carried on. */
    this.body.root.visible = false;
    if (this.body.shadow) this.body.shadow.visible = false;
    this.label.visible = false;
  }
  destroy() {
    if (!this.body) return;
    this.body.dispose(); G.scene.remove(this.label);
    this.body = null;
  }
  onSnap(d) {
    /* d[9] is PB10 pitch. `|| 0` is load bearing: a client on the previous build
       sends a 9-element packet, so this must degrade to "not flipping" rather
       than to undefined, which would poison the lerp below into NaN and hand the
       body a NaN quaternion (that makes the whole ghost vanish - see the NaN
       note in rider_body.js). */
    this.buf.push({ t: nowMs(), x: d[0], y: d[1], z: d[2], yaw: d[3], edge: d[4], air: d[5], st: d[6], pitch: d[9] || 0 });
    if (this.buf.length > 6) this.buf.shift();
    this.dist = d[7]; this.flow = d[8];
    this.state = d[6] === 1 ? 'down' : 'ride';
    this.last = nowMs();
  }
  render(dt) {
    const tRender = nowMs() - 130;
    const b = this.buf;
    if (!b.length) return;
    let a = b[0], c = b[b.length - 1];
    for (let i = 0; i < b.length - 1; i++) { if (b[i].t <= tRender && b[i + 1].t >= tRender) { a = b[i]; c = b[i + 1]; break; } }
    const span = Math.max(1, c.t - a.t);
    const u = clamp((tRender - a.t) / span, 0, 1.6);
    const r = this.r;
    const px = lerp(a.x, c.x, u), py = lerp(a.y, c.y, u), pz = lerp(a.z, c.z, u);
    const far = Math.abs(pz - G.rider.p.z) > 330 || Math.hypot(px - G.rider.p.x, pz - G.rider.p.z) > 340;
    if (far) { this.hide(); return; }
    this.ensureBody();
    this.body.root.visible = true;
    if (this.body.shadow) this.body.shadow.visible = true;   // absent when the ghost casts into the cascades
    this.label.visible = true;
    r.v.set(px - r.p.x, py - r.p.y, pz - r.p.z).multiplyScalar(1 / Math.max(dt, 0.001));
    r.p.set(px, py, pz);
    r.speed = r.v.length();
    r.yaw += wrapAngle(lerp(a.yaw, a.yaw + wrapAngle(c.yaw - a.yaw), u) - r.yaw) * Math.min(1, dt * 14);
    r.edge = lerp(r.edge, a.edge, Math.min(1, dt * 12));
    /* Same shortest-arc chase as yaw. Pitch is transmitted already wrapped, which
       is lossless for orientation because a quaternion is 2*PI periodic - a 720
       looks identical to a 0. Two peers who never flip both hold pitch at
       exactly 0 here, so the body's flip branch stays unentered for them. */
    r.pitch += wrapAngle(lerp(a.pitch, a.pitch + wrapAngle(c.pitch - a.pitch), u) - r.pitch) * Math.min(1, dt * 14);
    r.airT = a.air ? 0.4 : 0;
    r.grounded = !a.air;
    r.state = this.state;
    r.runT = G.t;
    const nn = terrainNormal(px, pz, 1.2);
    r.n.set(nn.x, nn.y, nn.z);
    this.body.update(r, dt);
    this.label.position.set(px, py + 2.5, pz);
  }
}

class Net {
  constructor(name) {
    this.peers = new Map();
    this.name = name;
    this.id = null;
    this.ws = null;
    this.top = [];
    this.sendT = 0;
    this.connected = false;
    this.colIdx = Math.floor(Math.random() * JACKETS.length);
    this.room = (location.hash.match(/room=([a-zA-Z0-9_-]{1,24})/) || [])[1] || ('mountain-' + SEED);
    this.connect();
  }
  connect() {
    if (!/^https?:/.test(location.protocol)) return;
    try {
      /* The relay only exists on the games.bu.app origin. A MIRROR (GitHub
         Pages, a local http server, anywhere else) has no /ws/ path of its own,
         so deriving the host from location.host there dialled a socket that can
         never open: a 4 s retry loop forever, plus an empty all-time board
         because `top` arrives in the welcome frame. Falling back to the absolute
         host also puts every mirror in the SAME rooms as prod - one mountain,
         not a second empty world. VERIFIED the relay accepts cross-origin.
         *** INERT ON games.bu.app: same host, same protocol as before. *** */
      const same = /(^|\.)games\.bu\.app$/.test(location.hostname);
      const proto = (same && location.protocol !== 'https:') ? 'ws' : 'wss';
      const host = same ? location.host : 'flowline.games.bu.app';
      const ws = new WebSocket(`${proto}://${host}/ws/${this.room}`);
      this.ws = ws;
      ws.onopen = () => { this.connected = true; UI.net(true); this.hello(); };
      ws.onclose = () => { this.connected = false; UI.net(false); setTimeout(() => this.connect(), 4000); };
      ws.onerror = () => { };
      ws.onmessage = e => this.onMsg(JSON.parse(e.data));
    } catch (e) { }
  }
  hello(to) {
    const m = { type: 'msg', data: { t: 'hi', n: this.name, c: this.colIdx } };
    if (to) m.to = to;
    this.send(m);
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  onMsg(m) {
    if (m.type === 'welcome') {
      this.id = m.id;
      if (m.state && m.state.top) this.top = m.state.top;
      UI.allTime(this.top);
    } else if (m.type === 'join') {
      this.hello(m.id);
    } else if (m.type === 'leave') {
      const p = this.peers.get(m.id);
      if (p) { p.destroy(); this.peers.delete(m.id); }
    } else if (m.type === 'msg') {
      const d = m.data;
      if (!d) return;
      if (d.t === 'hi') {
        let p = this.peers.get(m.from);
        if (!p) { p = new Peer(m.from, d.n, d.c); this.peers.set(m.from, p); this.hello(m.from); }
        else { p.name = d.n; }
      } else if (d.t === 's') {
        let p = this.peers.get(m.from);
        if (!p) { p = new Peer(m.from, 'rider', 0); this.peers.set(m.from, p); this.hello(m.from); }
        p.onSnap(d.d);
      }
    } else if (m.type === 'set' && m.key === 'top') {
      this.top = m.value || []; UI.allTime(this.top);
    }
  }
  tick(t) {
    const r = G.rider;
    if (this.connected && t - this.sendT > 0.075) {
      this.sendT = t;
      this.send({
        type: 'msg', data: {
          t: 's', d: [
            +r.p.x.toFixed(2), +r.p.y.toFixed(2), +r.p.z.toFixed(2), +r.yaw.toFixed(2),
            +r.edge.toFixed(2), r.grounded ? 0 : 1, r.state === 'down' ? 1 : 0,
            Math.round(r.dist), +r.flow.toFixed(2),
            +wrapAngle(r.pitch).toFixed(2)          // d[9] PB10, wrapped: see onSnap
          ]
        }
      });
    }
    const dt = G.dt;
    for (const [id, p] of this.peers) {
      if (nowMs() - p.last > 12000) { p.destroy(); this.peers.delete(id); continue; }
      p.render(dt);
    }
  }
  wipeout() { this.submit(G.rider.dist); }
  respawn() { }
  submit(d) {
    d = Math.round(d);
    if (d < 150) return;
    const top = (this.top || []).slice();
    top.push({ n: this.name, d });
    top.sort((a, b) => b.d - a.d);
    // one entry per name
    const seen = new Set(), out = [];
    for (const e of top) { if (seen.has(e.n)) continue; seen.add(e.n); out.push(e); if (out.length >= 8) break; }
    this.top = out;
    UI.allTime(out);
    if (this.connected) this.send({ type: 'set', key: 'top', value: out });
  }
  board() {
    const list = [{ n: this.name, d: G.rider.dist, me: 1, col: 0xffe08a, st: G.rider.state }];
    for (const [, p] of this.peers) list.push({ n: p.name, d: p.dist, col: p.col, st: p.state });
    list.sort((a, b) => b.d - a.d);
    return list;
  }
}
