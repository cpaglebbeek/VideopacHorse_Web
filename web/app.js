/*
 * app.js — VideopacHorse_Web glue: WASM-core laden, frame-loop, canvas-blit,
 * WebAudio, input, IndexedDB-opslag (BIOS/ROM blijven client-side) en het
 * config-paneel (CSS-vars + localStorage; zie DESIGN_TOKENS.md).
 */
'use strict';

/* Build-versie — build.sh houdt dit gelijk aan version.json; wordt als
 * ?v=-cache-buster aan g7000.wasm gehangen (proxy's cachen 'm immutable). */
const BUILD_V = '0.4.0';

/* ---------------- config-paneel ---------------- */
const CFG_KEY = 'videopachorse.cfg.v1';
const cfgInputs = () => document.querySelectorAll('[data-cssvar], [data-cfg]');

function cfgDefaults() {
  const d = { theme: 'dark', vars: {} };
  document.querySelectorAll('[data-cssvar]').forEach(el => {
    d.vars[el.dataset.cssvar] = getComputedStyle(document.documentElement)
      .getPropertyValue(el.dataset.cssvar).trim();
  });
  return d;
}
let CFG_DEFAULTS = null;

function cfgApply(cfg) {
  document.documentElement.dataset.theme = cfg.theme || 'dark';
  document.getElementById('cfgTheme').value = cfg.theme || 'dark';
  for (const [k, v] of Object.entries(cfg.vars || {})) {
    document.documentElement.style.setProperty(k, v);
    const el = document.querySelector(`[data-cssvar="${k}"]`);
    if (!el) continue;
    if (el.type === 'color') el.value = toHexColor(v);
    else if (el.type === 'range') el.value = parseFloat(v);
    else el.value = v;
  }
  applyCanvasScale();
}
function cfgCollect() {
  const cfg = { theme: document.getElementById('cfgTheme').value, vars: {} };
  document.querySelectorAll('[data-cssvar]').forEach(el => {
    const unit = el.dataset.unit || '';
    cfg.vars[el.dataset.cssvar] = el.type === 'range' ? el.value + unit : el.value;
  });
  return cfg;
}
function cfgSave() { localStorage.setItem(CFG_KEY, JSON.stringify(cfgCollect())); }
function toHexColor(v) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = v.trim() || '#000000';
  return c.fillStyle;
}
function applyCanvasScale() {
  const s = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--canvas-scale')) || 3;
  const cv = document.getElementById('screen');
  cv.style.width = (cv.width * s) + 'px';
}

function cfgInit() {
  CFG_DEFAULTS = cfgDefaults();
  const stored = localStorage.getItem(CFG_KEY);
  if (stored) { try { cfgApply(JSON.parse(stored)); } catch (e) { /* corrupte cfg negeren */ } }
  cfgInputs().forEach(el => el.addEventListener('input', () => {
    if (el.dataset.cssvar) {
      const unit = el.dataset.unit || '';
      document.documentElement.style.setProperty(el.dataset.cssvar,
        el.type === 'range' ? el.value + unit : el.value);
      if (el.dataset.kind === 'scale') applyCanvasScale();
    }
    if (el.dataset.cfg === 'theme') document.documentElement.dataset.theme = el.value;
    cfgSave();
  }));
  document.getElementById('cfgExport').onclick = () => {
    const blob = new Blob([JSON.stringify(cfgCollect(), null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'),
      { href: URL.createObjectURL(blob), download: 'videopachorse-config.json' });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  document.getElementById('cfgImport').addEventListener('change', async ev => {
    const f = ev.target.files[0];
    if (!f) return;
    try { cfgApply(JSON.parse(await f.text())); cfgSave(); }
    catch (e) { alert('Ongeldig config-bestand'); }
  });
  document.getElementById('cfgReset').onclick = () => {
    localStorage.removeItem(CFG_KEY);
    document.documentElement.removeAttribute('style');
    cfgApply(CFG_DEFAULTS);
  };
  applyCanvasScale();
}

/* ---------------- IndexedDB (BIOS/ROM lokaal bewaren) ---------------- */
const DB_NAME = 'videopachorse', STORE = 'files';
function idb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbPut(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const rq = db.transaction(STORE).objectStore(STORE).get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

/* ---------------- emulator ---------------- */
const S = {
  mod: null, api: null, sys: 0,
  bios: null, rom: null,
  running: false, raf: 0,
  fbPtr: 0, fbW: 320, fbH: 240,
  audioCtx: null, audioNode: null, audioBufPtr: 0,
  ring: new Float32Array(32768), ringR: 0, ringW: 0,
  frames: 0, lastFpsT: 0,
  joy: [0, 0],                       /* gecombineerd mask zoals aan de core doorgegeven */
  /* per bron; pushJoy OR't ze — joyCtrl = telefoon-joystick via de API (ctrl-poll) */
  joyKb: [0, 0], joyGp: [0, 0], joyPeer: [0, 0], joyCtrl: [0, 0],
};

/* Combineer per speler alle input-bronnen (toetsenbord | gamepad | telefoon-joystick |
 * peer/DataChannel) en geef alleen bij échte verandering door aan de core. Zo wist de
 * 500 ms-heartbeat van een telefoon geen toetsenbord-input en vecht een gamepad niet per
 * frame met de telefoon. Peer-input (joyPeer) komt via WebRTC DataChannel van medespeler. */
function guestOwnsPlayer2() {
  /* Zodra een pairplay-sessie staat, is de GAST speler 2: lokale bronnen op
   * slot 2 (WASD, gamepad 2, BLE-telefoon op speler 2) worden gedempt zodat
   * twee mensen echt tegen elkaar spelen i.p.v. dezelfde stick te delen. */
  if (typeof pairPlay === 'undefined') return false;
  const st = pairPlay.getStatus();
  return st.mode === 'host' && st.connected;
}

function pushJoy(p) {
  if (p === 1 && guestOwnsPlayer2()) {
    /* Gast bezit speler 2 exclusief: alleen zijn DataChannel-mask telt.
     * De server geeft slot 1 niet uit zolang sessions.guest_token gevuld is,
     * dus S.joyCtrl[1] hoort dan 0 te zijn. Eén randgeval blijft over: een
     * telefoon die slot 1 pakte VÓÓR de gast joinde. Dan wint hier de gast
     * (zijn slot is exclusief) en wordt de telefoon-invoer genegeerd tot die
     * telefoon zijn slot vrijgeeft (ctrl-leave of 60 s stilte ⇒ server-GC). */
    const g = S.joyPeer[1] & 0x1f;
    if (g === S.joy[1]) return;
    S.joy[1] = g;
    if (S.api) S.api.joy(S.sys, 1, g);
    return;
  }
  const m = (S.joyKb[p] | S.joyGp[p] | S.joyPeer[p] | S.joyCtrl[p]) & 0x1f;
  if (m === S.joy[p]) return;
  S.joy[p] = m;
  if (S.api) S.api.joy(S.sys, p, m);
}

const JOY = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, FIRE: 16 };
const KEYMAP1 = { ArrowUp: JOY.UP, ArrowDown: JOY.DOWN, ArrowLeft: JOY.LEFT, ArrowRight: JOY.RIGHT, ' ': JOY.FIRE };
const KEYMAP2 = { w: JOY.UP, s: JOY.DOWN, a: JOY.LEFT, d: JOY.RIGHT, f: JOY.FIRE };

function $(id) { return document.getElementById(id); }
function setBadge(id, ok, txtOk, txtErr) {
  const b = $(id);
  b.className = 'badge ' + (ok ? 'ok' : 'err');
  b.textContent = ok ? txtOk : txtErr;
}

async function loadCore() {
  if (typeof createG7000 !== 'function') {
    setBadge('verBadge', false, '', 'g7000.js ontbreekt — draai build.sh');
    return;
  }
  S.mod = await createG7000({ locateFile: f => f + '?v=' + BUILD_V });
  const cw = S.mod.cwrap;
  S.api = {
    create: cw('g7k_create', 'number', []),
    destroy: cw('g7k_destroy', null, ['number']),
    loadBios: cw('g7k_load_bios', 'number', ['number', 'number', 'number']),
    loadCart: cw('g7k_load_cart', 'number', ['number', 'number', 'number']),
    reset: cw('g7k_reset', null, ['number', 'number']),
    setRegion: cw('g7k_set_region', null, ['number', 'number']),
    runFrame: cw('g7k_run_frame', null, ['number']),
    fb: cw('g7k_framebuffer', 'number', ['number']),
    fbW: cw('g7k_fb_width', 'number', ['number']),
    fbH: cw('g7k_fb_height', 'number', ['number']),
    audioRead: cw('g7k_audio_read', 'number', ['number', 'number', 'number']),
    audioRate: cw('g7k_audio_sample_rate', 'number', ['number']),
    joy: cw('g7k_joystick_set', null, ['number', 'number', 'number']),
    keySet: cw('g7k_key_set', null, ['number', 'number', 'number']),
    keyFromChar: cw('g7k_key_from_char', 'number', ['number']),
    version: cw('g7k_version', 'string', []),
  };
  S.sys = S.api.create();
  S.fbW = S.api.fbW(S.sys);
  S.fbH = S.api.fbH(S.sys);
  const cv = $('screen');
  cv.width = S.fbW; cv.height = S.fbH;
  applyCanvasScale();
  S.audioBufPtr = S.mod._malloc(8192 * 2);
  setBadge('verBadge', true, 'core ' + S.api.version(), '');
  $('verFoot').textContent = S.api.version();
  await restoreFiles();
  updateButtons();
}

function pushBytes(bytes) {
  const ptr = S.mod._malloc(bytes.length);
  S.mod.HEAPU8.set(bytes, ptr);
  return ptr;
}

async function restoreFiles() {
  const bios = await idbGet('bios'), rom = await idbGet('rom');
  if (bios) applyBios(new Uint8Array(bios), false);
  if (rom) applyRom(new Uint8Array(rom), false);
}
function applyBios(bytes, persist) {
  const ptr = pushBytes(bytes);
  const rc = S.api.loadBios(S.sys, ptr, bytes.length);
  S.mod._free(ptr);
  S.bios = rc === 0 ? bytes : null;
  setBadge('biosBadge', rc === 0, 'geladen (' + bytes.length + ' B)',
    bytes.length !== 1024 ? 'moet exact 1024 bytes zijn' : 'laden mislukt');
  if (rc === 0 && persist) idbPut('bios', bytes.buffer.slice(0));
  updateButtons();
}
function applyRom(bytes, persist) {
  const ptr = pushBytes(bytes);
  const rc = S.api.loadCart(S.sys, ptr, bytes.length);
  S.mod._free(ptr);
  S.rom = rc === 0 ? bytes : null;
  setBadge('romBadge', rc === 0, 'geladen (' + (bytes.length / 1024) + ' KB)', 'ongeldige ROM-grootte');
  if (rc === 0 && persist) idbPut('rom', bytes.buffer.slice(0));
  updateButtons();
}
function updateButtons() {
  const ready = S.api && S.bios && S.rom;
  $('btnStart').disabled = !ready || S.running;
  $('btnPause').disabled = !S.running;
  $('btnReset').disabled = !ready;
  $('btnColdReset').disabled = !ready;
}

/* Power-cycle + (indien nodig) de emulator laten lopen. Wordt ook automatisch
 * aangeroepen zodra een "Samen spelen"-sessie tot stand komt, zodat beide
 * spelers bij hetzelfde beginscherm starten. */
function coldStart() {
  if (!S.api) return;
  S.api.reset(S.sys, 1);
  if (S.bios) applyBios(S.bios, false);
  if (S.rom) applyRom(S.rom, false);
  S.joyKb = [0, 0]; S.joyGp = [0, 0]; S.joyPeer = [0, 0]; S.joyCtrl = [0, 0];
  pushJoy(0); pushJoy(1);
  if (!S.running && S.bios && S.rom) $('btnStart').click();
}

/* Hook voor pairplay.js: sessie staat → schone start voor twee spelers. */
function onPairSessionReady() {
  coldStart();
}

/* ---------------- audio ---------------- */
function audioStart() {
  if (S.audioCtx) { S.audioCtx.resume(); return; }
  S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const node = S.audioCtx.createScriptProcessor(2048, 0, 1);
  node.onaudioprocess = e => {
    const out = e.outputBuffer.getChannelData(0);
    for (let i = 0; i < out.length; i++)
      out[i] = S.ringR !== S.ringW ? S.ring[S.ringR++ & (S.ring.length - 1)] : 0;
  };
  node.connect(S.audioCtx.destination);
  S.audioNode = node;
}
function pumpAudio() {
  if (!S.audioCtx) return;
  const n = S.api.audioRead(S.sys, S.audioBufPtr, 8192);
  if (n <= 0) return;
  const src = new Int16Array(S.mod.HEAPU8.buffer, S.audioBufPtr, n);
  const ratio = S.api.audioRate(S.sys) / S.audioCtx.sampleRate;
  /* simpele lineaire resampler naar de context-rate */
  for (let t = 0; t < n / ratio; t++) {
    const s = src[Math.min(n - 1, Math.floor(t * ratio))] / 32768;
    S.ring[S.ringW++ & (S.ring.length - 1)] = s;
  }
}

/* ---------------- frame-loop ---------------- */
function frame(ts) {
  if (!S.running) return;
  S.api.runFrame(S.sys);
  const ptr = S.api.fb(S.sys);
  const img = new ImageData(
    new Uint8ClampedArray(S.mod.HEAPU8.buffer, ptr, S.fbW * S.fbH * 4), S.fbW, S.fbH);
  $('screen').getContext('2d').putImageData(img, 0, 0);
  pumpAudio();
  pollGamepads();
  S.frames++;
  if (ts - S.lastFpsT > 1000) {
    $('fps').textContent = S.frames + ' fps';
    S.frames = 0; S.lastFpsT = ts;
  }
  S.raf = requestAnimationFrame(frame);
}

/* ---------------- input ---------------- */
function bindInput() {
  addEventListener('keydown', ev => handleKey(ev, true));
  addEventListener('keyup', ev => handleKey(ev, false));
}
function handleKey(ev, down) {
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  let hit = false;

  // Gast-mode: KEYMAP2-input (speler 2) gaat via DataChannel naar host, niet lokaal
  if (typeof pairPlay !== 'undefined' && pairPlay.getStatus().mode === 'guest' &&
      (k in KEYMAP2 || k in KEYMAP1)) {
    const mask = (k in KEYMAP2) ? KEYMAP2[k] : KEYMAP1[k];   /* gast: WASD én pijltjes */
    if (down) {
      S.joyKb[1] |= mask;
    } else {
      S.joyKb[1] &= ~mask;
    }
    pairPlay.sendGuestInput(S.joyKb[1]);
    ev.preventDefault();
    return;
  }

  if (k in KEYMAP1) { S.joyKb[0] = down ? S.joyKb[0] | KEYMAP1[k] : S.joyKb[0] & ~KEYMAP1[k]; pushJoy(0); hit = true; }
  if (k in KEYMAP2) { S.joyKb[1] = down ? S.joyKb[1] | KEYMAP2[k] : S.joyKb[1] & ~KEYMAP2[k]; pushJoy(1); hit = true; }
  if (S.api && !hit && ev.key.length === 1) {
    const code = S.api.keyFromChar(ev.key.toUpperCase().charCodeAt(0));
    if (code !== 0xFF) { S.api.keySet(S.sys, code, down ? 1 : 0); hit = true; }
  }
  if (S.api && !hit && (ev.key === 'Enter' || ev.key === 'Backspace')) {
    const code = S.api.keyFromChar(ev.key === 'Enter' ? 10 : 8);
    if (code !== 0xFF) { S.api.keySet(S.sys, code, down ? 1 : 0); hit = true; }
  }
  if (hit) ev.preventDefault();
}
function pollGamepads() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  const isGuestMode = (typeof pairPlay !== 'undefined' && pairPlay.getStatus().mode === 'guest');

  for (let p = 0; p < 2; p++) {
    const gp = gps[p];
    if (!gp) continue;
    let m = 0;
    if (gp.axes[1] < -0.5 || (gp.buttons[12] && gp.buttons[12].pressed)) m |= JOY.UP;
    if (gp.axes[1] > 0.5 || (gp.buttons[13] && gp.buttons[13].pressed)) m |= JOY.DOWN;
    if (gp.axes[0] < -0.5 || (gp.buttons[14] && gp.buttons[14].pressed)) m |= JOY.LEFT;
    if (gp.axes[0] > 0.5 || (gp.buttons[15] && gp.buttons[15].pressed)) m |= JOY.RIGHT;
    if (gp.buttons[0] && gp.buttons[0].pressed) m |= JOY.FIRE;

    // Gast-mode: speler 2 gamepad-input via DataChannel naar host
    if (isGuestMode && p === 1 && m !== S.joyGp[1]) {
      S.joyGp[1] = m;
      pairPlay.sendGuestInput(S.joyKb[1] | S.joyGp[1]);
    } else if (!isGuestMode && m !== S.joyGp[p]) {
      S.joyGp[p] = m;
      pushJoy(p);
    }
  }
}

/* ---------------- ctrlPad: telefoon-joystick over internet ----------------
 * Derde inputbron naast toetsenbord/gamepad (en de peer-DataChannel).
 * Protocol (bindend, gedeeld met VideopacHorse_Joystick en de API v0.4.0):
 *   ctrl-join  {code}        -> {ctrl_token, slot: 0|1, expires_at}; 3e = HTTP 409
 *   ctrl-input {token, mask} -> {ok}; mask bit0=UP..bit4=FIRE (== G7K_JOY_*),
 *                               telefoon stuurt bij elke verandering + 500 ms-heartbeat
 *   ctrl-poll  {host_token}  -> {controllers:[{slot, mask, age_ms}]}
 *   ctrl-leave {token}       -> {ok}
 * Alleen de HOST pollt en alleen zolang hij een pairplay-sessie heeft
 * (host-token uit pairPlay.getStatus()). Slot 0 = speler 1, slot 1 = speler 2.
 *
 * Cadans: de timer vuurt 10×/s, maar er loopt nooit meer dan één verzoek
 * tegelijk, dus de échte frequentie is 1/(RTT + 100 ms) — over internet gemeten
 * 4-5 Hz bij een RTT van ~120 ms. Dat is bewust: een wachtrij van polls zou de
 * latentie juist verhogen. Geen 10 Hz beloven waar het er 4,4 zijn.
 *
 * Failsafe (twee lagen, want een joystick die "ingedrukt blijft hangen" is het
 * ergste faalgedrag dat dit ding heeft):
 *  1. age_ms > CTRL_STALE_MS ⇒ dat slot op mask 0 (telefoon stil).
 *  2. gaat het POLLEN zelf stuk (HTTP 401/503, netwerkuitval, onleesbaar
 *     antwoord), dan zet de watchdog na CTRL_STALE_MS ALLE controller-maskers
 *     op 0 en verschijnt de storing in de statusregel. Vóór v0.4.0-Rusch werd
 *     de HTTP-status niet eens gelezen en bleef de laatst bekende mask staan
 *     zolang de storing duurde. */

const CTRL_API = 'api/';
const CTRL_POLL_MS = 100;
/* 3000 ms i.p.v. de 2000 van de oude BLE-watchdog. Onderbouwing: die 2 s gold
 * voor een lokale BLE-link (~10 ms). Nu loopt de heartbeat (500 ms) over
 * internet: één gemiste of ge-503'de heartbeat geeft al 2 × (500 + RTT) — met
 * een mobiele RTT van 300-500 ms is dat 1600-2000 ms en zou 2000 ms dus midden
 * in het spel de stick loslaten. 3000 ms dekt één gemiste heartbeat plus
 * RTT-jitter en blijft ruim onder de 4 s waarop een mens een hangende stick
 * echt hinderlijk vindt. De server ruimt een stille controller pas na 60 s op,
 * dus deze marge kost geen slot. */
const CTRL_STALE_MS = 3000;
const CTRL_ERR_BACKOFF_MS = 1000;   /* na een mislukte poll niet op 10 Hz blijven rammen */

const ctrlPad = {
  slots: [null, null],   /* per slot {mask, ageMs, stale} of null (niet gekoppeld) */
  inFlight: false,
  sig: '',               /* laatst gerenderde statusregel — voorkomt DOM-werk op 10 Hz */
  lastOkAt: 0,           /* tijdstip van de laatste GESLAAGDE ctrl-poll (watchdog) */
  errCount: 0,
  retryAt: 0,
  linkErr: '',           /* niet-leeg = storing; wordt in de statusregel getoond */

  /* Host-token, of null als deze pagina geen host is. */
  hostToken() {
    if (typeof pairPlay === 'undefined') return null;
    const st = pairPlay.getStatus();
    return (st && st.mode === 'host' && st.hostToken) ? st.hostToken : null;
  },

  /* Alle controller-maskers los + slots vergeten. Idempotent. */
  releaseAll() {
    let changed = false;
    for (let p = 0; p < 2; p++) {
      if (this.slots[p]) { this.slots[p] = null; changed = true; }
      if (S.joyCtrl[p] !== 0) { S.joyCtrl[p] = 0; pushJoy(p); changed = true; }
    }
    if (changed) this.render();
  },

  tick() {
    const token = this.hostToken();
    if (!token) {
      if (this.slots[0] || this.slots[1] || this.linkErr) {
        this.linkErr = '';
        this.releaseAll();                                 /* sessie weg ⇒ alles los */
      }
      this.lastOkAt = 0; this.errCount = 0; this.retryAt = 0;
      return;
    }
    const now = Date.now();
    if (!this.lastOkAt) this.lastOkAt = now;               /* startpunt watchdog */
    /* Watchdog: geen geslaagde poll binnen de failsafe-marge ⇒ stick los. */
    if (now - this.lastOkAt > CTRL_STALE_MS) this.releaseAll();
    /* Geen overlappende verzoeken: bij een trage verbinding zou 10 Hz anders
     * een wachtrij opbouwen (en de API onnodig belasten). */
    if (this.inFlight || now < this.retryAt) return;
    this.inFlight = true;
    fetch(CTRL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ctrl-poll', token }),
    })
      .then(r => r.json().catch(() => null).then(j => ({ ok: r.ok, status: r.status, j })))
      .then(res => {
        if (!res.ok || !res.j || !Array.isArray(res.j.controllers)) {
          this.onFail(res.status, (res.j && res.j.error) || '');
          return;
        }
        this.lastOkAt = Date.now();
        this.errCount = 0;
        if (this.linkErr) { this.linkErr = ''; this.sig = ''; }
        this.apply(res.j.controllers);
      })
      .catch(() => this.onFail(0, ''))   /* netwerk-hik / offline */
      .then(() => { this.inFlight = false; });
  },

  /* Mislukte poll: nooit stilzwijgend. Backoff + (na een tweede fout, of meteen
   * bij een definitieve 401) een zichtbare melding. De maskers worden door de
   * watchdog in tick() losgelaten — niet hier, zodat één enkele hik van 200 ms
   * de besturing niet onderbreekt. */
  onFail(status, msg) {
    this.errCount++;
    this.retryAt = Date.now() + CTRL_ERR_BACKOFF_MS;
    const txt =
      status === 401 ? 'sessie niet meer geldig — start een nieuwe sessie'
        : status === 503 ? 'server bezet — opnieuw proberen…'
          : status ? ('serverfout ' + status + (msg ? ' (' + msg + ')' : ''))
            : 'geen verbinding met de server';
    if ((this.errCount >= 2 || status === 401) && this.linkErr !== txt) {
      this.linkErr = txt;
      this.render();
    }
  },

  apply(list) {
    const seen = [false, false];
    list.forEach(c => {
      const slot = c.slot | 0;
      if (slot !== 0 && slot !== 1) return;
      const ageMs = c.age_ms | 0;
      const stale = ageMs > CTRL_STALE_MS;
      const mask = stale ? 0 : ((c.mask | 0) & 0x1f);   /* failsafe */
      seen[slot] = true;
      this.slots[slot] = { mask: (c.mask | 0) & 0x1f, ageMs, stale };
      if (S.joyCtrl[slot] !== mask) { S.joyCtrl[slot] = mask; pushJoy(slot); }
    });
    for (let p = 0; p < 2; p++) {
      if (seen[p] || !this.slots[p]) continue;
      this.slots[p] = null;                              /* controller weg (ctrl-leave/GC) */
      if (S.joyCtrl[p] !== 0) { S.joyCtrl[p] = 0; pushJoy(p); }
    }
    this.render();
  },

  render() {
    const host = $('ctrlStatus');
    if (!host) return;
    const rows = [];
    for (let p = 0; p < 2; p++) {
      if (!this.slots[p]) continue;
      rows.push({
        label: '📱 Speler ' + (p + 1) + ' →',
        txt: this.slots[p].stale ? 'stil (geen heartbeat)' : 'verbonden',
        kind: this.slots[p].stale ? '' : 'ok',
      });
    }
    /* Storing op de poll-route zelf: altijd tonen, ook als er (daardoor) geen
     * enkele controller meer in beeld is. */
    if (this.linkErr) {
      rows.push({ label: '📱 Telefoon-joystick →', txt: this.linkErr, kind: 'err' });
    }
    const sig = rows.map(r => r.label + ':' + r.txt).join('|');
    if (sig === this.sig) return;      /* niets veranderd ⇒ geen DOM-werk */
    this.sig = sig;
    host.hidden = rows.length === 0;
    host.textContent = '';
    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'blerow';
      const name = document.createElement('span');
      name.textContent = r.label;
      const st = document.createElement('span');
      st.className = 'badge ' + r.kind;
      st.textContent = r.txt;
      row.append(name, st);
      host.appendChild(row);
    });
  },

  init() {
    setInterval(() => this.tick(), CTRL_POLL_MS);
  },
};

/* console-toetsenbord (48 toetsen van de G7000-membraan) */
const CONSOLE_KEYS = '0123456789+-*/=YNC E ABCDEFGHIJKLMNOPQRSTUVWXYZ.?';
function buildKbd() {
  const host = $('consoleKbd');
  for (const ch of CONSOLE_KEYS) {
    if (ch === ' ') continue;
    const b = document.createElement('button');
    b.textContent = ch;
    b.onpointerdown = () => sendChar(ch, true);
    b.onpointerup = () => sendChar(ch, false);
    host.appendChild(b);
  }
  const enter = document.createElement('button');
  enter.textContent = 'ENT';
  enter.onpointerdown = () => sendChar('\n', true);
  enter.onpointerup = () => sendChar('\n', false);
  host.appendChild(enter);
}
function sendChar(ch, down) {
  if (!S.api) return;
  const code = S.api.keyFromChar(ch.charCodeAt(0));
  if (code !== 0xFF) S.api.keySet(S.sys, code, down ? 1 : 0);
}

/* ---------------- UI-wiring ---------------- */
function bindUi() {
  $('fileBios').addEventListener('change', async ev => {
    const f = ev.target.files[0];
    if (f) applyBios(new Uint8Array(await f.arrayBuffer()), true);
  });
  $('fileRom').addEventListener('change', async ev => {
    const f = ev.target.files[0];
    if (f) applyRom(new Uint8Array(await f.arrayBuffer()), true);
  });
  $('btnStart').onclick = () => {
    audioStart();
    S.running = true;
    updateButtons();
    S.raf = requestAnimationFrame(frame);
  };
  $('btnPause').onclick = () => {
    S.running = false;
    cancelAnimationFrame(S.raf);
    updateButtons();
  };
  $('btnReset').onclick = () => S.api.reset(S.sys, 0);
  $('btnColdReset').onclick = () => coldStart();
  $('chkNtsc').onchange = ev => S.api.setRegion(S.sys, ev.target.checked ? 1 : 0);
  $('btnKbd').onclick = () => { const k = $('consoleKbd'); k.hidden = !k.hidden; };
  $('btnFullscreen').onclick = () => $('screen').requestFullscreen && $('screen').requestFullscreen();
}

/* ---------------- GAMES-catalogus (client-side, geen ROM-hosting) --------
 * web/games.json = alleen metadata (nr/titel/size/crc32/externe cors-URL).
 * Klik → browser fetcht de ROM RECHTSTREEKS bij archive.org (/cors/-pad),
 * CRC32-verificatie tegen de catalogus, daarna IndexedDB-cache ('game:<crc>')
 * zodat het spel offline blijft werken. Deze site host/proxyt nooit ROM-bytes. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

const GAMES = { cat: null, loadedCrc: null };

async function gamesFetchRom(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return new Uint8Array(await resp.arrayBuffer());
}

async function gamesLoad(entry, rowEl) {
  const status = rowEl.querySelector('.badge');
  try {
    let bytes = null;
    const cached = await idbGet('game:' + entry.crc32);
    if (cached) bytes = new Uint8Array(cached);
    if (!bytes) {
      status.className = 'badge'; status.textContent = 'laden…';
      bytes = await gamesFetchRom(entry.url);
      const crc = crc32(bytes);
      if (crc !== entry.crc32.toLowerCase())
        throw new Error('CRC-mismatch (' + crc + ' ≠ ' + entry.crc32 + ')');
      await idbPut('game:' + entry.crc32, bytes.buffer.slice(0));
    }
    applyRom(bytes, true);           /* wordt ook de actieve cartridge      */
    GAMES.loadedCrc = entry.crc32;
    status.className = 'badge ok'; status.textContent = '✓ geladen';
    renderGames($('gamesSearch').value);
  } catch (e) {
    status.className = 'badge err';
    status.textContent = 'mislukt: ' + e.message;
  }
}

async function gamesRowState(entry) {
  return (await idbGet('game:' + entry.crc32)) ? '✓' : '';
}

function renderGames(filter) {
  const host = $('gamesList');
  if (!GAMES.cat) return;
  const f = (filter || '').toLowerCase();
  host.textContent = '';
  GAMES.cat.games
    .filter(g => !f || String(g.nr).includes(f) || g.title.toLowerCase().includes(f))
    .forEach(g => {
      const row = document.createElement('div');
      row.className = 'g';
      const active = GAMES.loadedCrc === g.crc32;
      row.innerHTML =
        '<span class="nr">' + (g.nr != null ? 'nr ' + g.nr : '—') + '</span>' +
        '<span>' + g.title + (active ? ' ▶' : '') + '</span>' +
        '<span class="sys">' + g.system + ' · ' + (g.size / 1024) + 'K</span>' +
        '<span class="badge" style="visibility:hidden">…</span>';
      const badge = row.lastElementChild;
      idbGet('game:' + g.crc32).then(hit => {
        if (hit) { badge.style.visibility = ''; badge.className = 'badge ok'; badge.textContent = '✓'; }
      });
      row.onclick = () => { badge.style.visibility = ''; gamesLoad(g, row); };
      host.appendChild(row);
    });
}

async function gamesInit() {
  try {
    const resp = await fetch('games.json?v=' + BUILD_V);
    if (!resp.ok) return;                 /* geen catalogus = sectie blijft weg */
    GAMES.cat = await resp.json();
  } catch (e) { return; }
  $('gamesCard').hidden = false;
  renderGames('');
  $('gamesSearch').addEventListener('input', ev => renderGames(ev.target.value));

  /* BIOS-knop: zelfde principe — rechtstreeks van archive.org, met verificatie */
  const b = GAMES.cat.bios;
  $('btnBiosUrl').onclick = async () => {
    const st = $('biosUrlStatus');
    try {
      st.textContent = 'BIOS laden…';
      const bytes = await gamesFetchRom(b.url);
      if (bytes.length !== b.size) throw new Error('grootte ' + bytes.length + ' ≠ ' + b.size);
      if (b.crc32 && crc32(bytes) !== b.crc32.toLowerCase())
        throw new Error('CRC-mismatch');
      applyBios(bytes, true);
      st.textContent = '✓ BIOS geladen en lokaal opgeslagen';
    } catch (e) {
      st.textContent = 'BIOS laden mislukt: ' + e.message;
    }
  };
}

cfgInit();
bindUi();
bindInput();
buildKbd();
ctrlPad.init();
gamesInit();
loadCore();
