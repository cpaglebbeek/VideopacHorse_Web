/*
 * app.js — VideopacHorse_Web glue: WASM-core laden, frame-loop, canvas-blit,
 * WebAudio, input, IndexedDB-opslag (BIOS/ROM blijven client-side) en het
 * config-paneel (CSS-vars + localStorage; zie DESIGN_TOKENS.md).
 */
'use strict';

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
  joy: [0, 0],
};

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
  S.mod = await createG7000();
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
  if (k in KEYMAP1) { S.joy[0] = down ? S.joy[0] | KEYMAP1[k] : S.joy[0] & ~KEYMAP1[k]; hit = true; }
  if (k in KEYMAP2) { S.joy[1] = down ? S.joy[1] | KEYMAP2[k] : S.joy[1] & ~KEYMAP2[k]; hit = true; }
  if (S.api && hit) { S.api.joy(S.sys, 0, S.joy[0]); S.api.joy(S.sys, 1, S.joy[1]); }
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
  for (let p = 0; p < 2; p++) {
    const gp = gps[p];
    if (!gp) continue;
    let m = 0;
    if (gp.axes[1] < -0.5 || (gp.buttons[12] && gp.buttons[12].pressed)) m |= JOY.UP;
    if (gp.axes[1] > 0.5 || (gp.buttons[13] && gp.buttons[13].pressed)) m |= JOY.DOWN;
    if (gp.axes[0] < -0.5 || (gp.buttons[14] && gp.buttons[14].pressed)) m |= JOY.LEFT;
    if (gp.axes[0] > 0.5 || (gp.buttons[15] && gp.buttons[15].pressed)) m |= JOY.RIGHT;
    if (gp.buttons[0] && gp.buttons[0].pressed) m |= JOY.FIRE;
    if (m !== S.joy[p]) { S.joy[p] = m; S.api.joy(S.sys, p, m); }
  }
}

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

cfgInit();
bindUi();
bindInput();
buildKbd();
loadCore();
