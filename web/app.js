/*
 * app.js — VideopacHorse_Web glue: WASM-core laden, frame-loop, canvas-blit,
 * WebAudio, input, IndexedDB-opslag (BIOS/ROM blijven client-side) en het
 * config-paneel (CSS-vars + localStorage; zie DESIGN_TOKENS.md).
 */
'use strict';

/* Build-versie — build.sh houdt dit gelijk aan version.json; wordt als
 * ?v=-cache-buster aan g7000.wasm gehangen (proxy's cachen 'm immutable). */
const BUILD_V = '0.3.0';

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
  joyKb: [0, 0], joyGp: [0, 0], joyBle: [0, 0], joyPeer: [0, 0],   /* per bron; pushJoy OR't ze */
};

/* Combineer per speler alle input-bronnen (toetsenbord | gamepad | BLE-telefoon | peer/DataChannel)
 * en geef alleen bij échte verandering door aan de core. Zo wist een
 * BLE-heartbeat geen toetsenbord-input en vecht een gamepad niet per frame
 * met de telefoon. Peer-input (joyPeer) komt via WebRTC DataChannel van medespeler. */
function pushJoy(p) {
  const m = (S.joyKb[p] | S.joyGp[p] | S.joyBle[p] | S.joyPeer[p]) & 0x1f;
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
  if (typeof pairPlay !== 'undefined' && pairPlay.getStatus().mode === 'guest' && k in KEYMAP2) {
    const mask = KEYMAP2[k];
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

/* ---------------- bleJoy: telefoon als joystick via Web Bluetooth ----------------
 * Protocol (bindend, gedeeld met de Android-app VideopacHorse_Joystick):
 *  - service   7a0b1000-56e1-4d2a-9f0a-c0de00000001
 *  - char "joy" 7a0b1000-56e1-4d2a-9f0a-c0de00000002 (NOTIFY + READ)
 *  - payload exact 9 bytes: byte 0-7 = stabiel apparaat-ID (eerste 8 bytes van
 *    SHA-256 over ANDROID_ID), byte 8 = bitmask bit0=UP bit1=DOWN bit2=LEFT
 *    bit3=RIGHT bit4=FIRE (identiek aan G7K_JOY_* in g7000.h).
 *  - telefoon notify't bij elke maskverandering + heartbeat elke 500 ms;
 *    blijft het hier >2 s stil dan zetten we het BLE-mask op 0 (failsafe:
 *    stick los; toetsenbord/gamepad-input van die speler blijft staan).
 *  - naam in de UI is altijd 'VPH-<laatste 4 hex van het ID>' — gelijk aan wat
 *    de app op het telefoonscherm toont. De browser-chooser kan wel de kale
 *    OS-naam tonen (Android kent geen per-advertentie local name; zie
 *    VideopacHorse_Joystick/README).
 *  - speler-mapping is botsingsvrij: opgeslagen voorkeur geldt zolang die
 *    speler niet door een andere actieve telefoon bezet is; derde telefoon
 *    wordt geparkeerd (geen speler) tot de gebruiker wisselt; wisselen naar
 *    een bezette speler swapt beide telefoons.
 * Web Bluetooth is Chromium-only; de knop verschijnt alleen na feature-detect. */

const BLE_SERVICE = '7a0b1000-56e1-4d2a-9f0a-c0de00000001';
const BLE_CHAR_JOY = '7a0b1000-56e1-4d2a-9f0a-c0de00000002';
const BLE_LS_KEY = 'videopachorse.blejoy.v1';
const BLE_HB_TIMEOUT = 2000;   /* ms zonder notificatie ⇒ failsafe mask 0 */
const BLE_RECONNECT_MAX = 3;

/* Pure payload-parser (DOM-loos, apart testbaar): Uint8Array(9) → {idHex, mask}
 * of null bij foute lengte. Bits >4 van het mask worden defensief gestript. */
function bleParsePayload(u8) {
  if (!u8 || u8.length !== 9) return null;
  let idHex = '';
  for (let i = 0; i < 8; i++) idHex += u8[i].toString(16).padStart(2, '0');
  return { idHex, mask: u8[8] & 0x1f };
}

const bleJoy = {
  phones: new Map(),       /* idHex → {device, idHex, player, status, watchdog, name} */
  byDevice: new WeakMap(), /* BluetoothDevice → idHex (weak: geen lek bij weggevallen devices) */
  listened: new WeakSet(), /* characteristics met notify-listener — Chromium cachet het
                            * characteristic-object per device, dus max 1 listener per object
                            * ook na n reconnects */

  loadMap() {
    try { return JSON.parse(localStorage.getItem(BLE_LS_KEY)) || {}; }
    catch (e) { return {}; }
  },
  saveMap(m) { localStorage.setItem(BLE_LS_KEY, JSON.stringify(m)); },

  /* spelers die op dit moment door een ándere actieve telefoon bezet zijn */
  activePlayers(exceptIdHex) {
    const taken = new Set();
    for (const ph of this.phones.values())
      if (ph.idHex !== exceptIdHex && ph.player !== null) taken.add(ph.player);
    return taken;
  },

  /* Botsingsvrij: de opgeslagen voorkeur (localStorage) geldt zolang die
   * speler niet al door een andere actieve telefoon bezet is; anders de
   * eerste vrije speler; beide bezet ⇒ null (geparkeerd — input wordt
   * genegeerd tot de gebruiker via de badge wisselt). Zo voeden nooit twee
   * bronnen stilzwijgend dezelfde speler. */
  assignPlayer(idHex) {
    const map = this.loadMap();
    const taken = this.activePlayers(idHex);
    if (idHex in map && !taken.has(map[idHex])) return map[idHex];
    const player = !taken.has(0) ? 0 : (!taken.has(1) ? 1 : null);
    if (player !== null) { map[idHex] = player; this.saveMap(map); }
    return player;
  },

  /* Wisselen van speler; is de doelspeler bezet door een andere telefoon dan
   * wisselen beide van plaats (swap) — nooit een stil dubbel-bezette speler. */
  togglePlayer(idHex) {
    const ph = this.phones.get(idHex);
    if (!ph) return;
    const target = ph.player === 0 ? 1 : 0;
    const map = this.loadMap();
    for (const other of this.phones.values()) {
      if (other.idHex !== idHex && other.player === target) {
        this.applyMask(other.idHex, 0);   /* doelpositie eerst loslaten */
        other.player = ph.player;         /* kan null zijn: other geparkeerd */
        if (other.player === null) delete map[other.idHex];
        else map[other.idHex] = other.player;
      }
    }
    this.applyMask(idHex, 0);   /* oude spelerpositie loslaten */
    ph.player = target;
    map[idHex] = target;
    this.saveMap(map);
    this.render();
  },

  applyMask(idHex, mask) {
    const ph = this.phones.get(idHex);
    if (!ph || ph.player === null) return;   /* geparkeerd: input negeren */
    S.joyBle[ph.player] = mask;
    pushJoy(ph.player);
  },

  armWatchdog(idHex) {
    const ph = this.phones.get(idHex);
    if (!ph) return;
    clearTimeout(ph.watchdog);
    ph.watchdog = setTimeout(() => {
      this.applyMask(idHex, 0);   /* failsafe: telefoon stil ⇒ stick los */
      ph.status = 'stil (geen heartbeat)';
      this.render();
    }, BLE_HB_TIMEOUT);
  },

  register(device, idHex) {
    const ph = {
      device, idHex,
      player: this.assignPlayer(idHex),
      status: 'verbonden',
      watchdog: 0,
      /* Altijd de uit het ID afgeleide naam — identiek aan wat de app op het
       * telefoonscherm toont (DeviceId.shortName). device.name is de kale
       * OS-naam van de telefoon en dus onbruikbaar om twee toestellen uit
       * elkaar te houden. */
      name: 'VPH-' + idHex.slice(12).toUpperCase(),
    };
    this.phones.set(idHex, ph);
    this.byDevice.set(device, idHex);
    return ph;
  },

  onNotify(device, dv) {
    const p = bleParsePayload(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    if (!p) return;
    let ph = this.phones.get(p.idHex);
    const isNew = !ph;
    if (!ph) ph = this.register(device, p.idHex);
    const statusChanged = ph.status !== 'verbonden';
    ph.status = 'verbonden';
    /* BLE-bronmask bijwerken; pushJoy geeft alleen échte veranderingen door
     * aan de core, dus de 500 ms-heartbeat wist geen toetsenbord-input */
    this.applyMask(p.idHex, p.mask);
    this.armWatchdog(p.idHex);
    if (isNew || statusChanged) this.render();
  },

  async addPhone() {
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE_SERVICE] }],
      });
      await this.connect(device);
    } catch (e) { /* chooser geannuleerd of verbinden mislukt — geen UI-fout */ }
  },

  async connect(device) {
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(BLE_SERVICE);
    const ch = await svc.getCharacteristic(BLE_CHAR_JOY);
    /* max 1 listener per characteristic-object, ook na reconnects */
    if (!this.listened.has(ch)) {
      ch.addEventListener('characteristicvaluechanged',
        ev => this.onNotify(device, ev.target.value));
      this.listened.add(ch);
    }
    await ch.startNotifications();
    device.addEventListener('gattserverdisconnected',
      () => this.onDisconnect(device), { once: true });
    /* char is ook READ: ID meteen ophalen zodat de badge direct verschijnt */
    try { this.onNotify(device, await ch.readValue()); }
    catch (e) { /* eerste notify levert het ID alsnog */ }
  },

  async onDisconnect(device) {
    const idHex = this.byDevice.get(device);
    const ph = idHex ? this.phones.get(idHex) : null;
    if (ph) {
      clearTimeout(ph.watchdog);
      this.applyMask(idHex, 0);   /* stick los bij wegvallen */
      ph.status = 'verbroken';
      this.render();
    }
    for (let i = 1; i <= BLE_RECONNECT_MAX; i++) {
      if (ph) { ph.status = 'herverbinden ' + i + '/' + BLE_RECONNECT_MAX + '…'; this.render(); }
      try {
        await new Promise(r => setTimeout(r, 1000 * i));
        await this.connect(device);
        return;   /* onNotify zet status weer op 'verbonden' */
      } catch (e) { /* volgende poging */ }
    }
    if (ph) { ph.status = 'verbroken'; this.render(); }
  },

  render() {
    const host = $('bleStatus');
    if (!host) return;
    host.hidden = this.phones.size === 0;
    host.textContent = '';
    for (const ph of this.phones.values()) {
      const row = document.createElement('div');
      row.className = 'blerow';
      const name = document.createElement('span');
      name.textContent = ph.name + ' →';
      const btn = document.createElement('button');
      btn.className = 'bleplayer';
      btn.textContent = ph.player === null ? 'Geen speler (bezet)' : 'Speler ' + (ph.player + 1);
      btn.title = ph.player === null
        ? 'Beide spelers bezet — klik om deze telefoon speler 1 te maken (swap)'
        : 'Klik om van speler te wisselen';
      btn.onclick = () => this.togglePlayer(ph.idHex);
      const st = document.createElement('span');
      const ok = ph.status === 'verbonden';
      st.className = 'badge ' + (ok ? 'ok' : (ph.status === 'verbroken' ? 'err' : ''));
      st.textContent = ph.status;
      row.append(name, btn, st);
      host.appendChild(row);
    }
  },

  init() {
    if (!('bluetooth' in navigator)) {
      /* Web Bluetooth ontbreekt (Firefox/Safari): knop blijft verborgen,
       * note in de hulptekst zichtbaar maken */
      $('bleNoSupport').hidden = false;
      return;
    }
    const btn = $('btnBleJoy');
    btn.hidden = false;
    btn.onclick = () => this.addPhone();
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
  $('btnColdReset').onclick = () => {
    S.api.reset(S.sys, 1);
    if (S.bios) applyBios(S.bios, false);
    if (S.rom) applyRom(S.rom, false);
  };
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
bleJoy.init();
gamesInit();
loadCore();
