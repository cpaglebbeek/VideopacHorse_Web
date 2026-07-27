/*
 * netplay.js — VideopacHorse netplay (/videopac/), v0.5.1
 *
 * Het verschil met de gearchiveerde streamversie (/videopac/stream/): daar draait
 * ALLEEN de host de emulator en gaat er een videostream naar de gast. Hier draaien beide kanten
 * dezelfde emulatie en gaat er alleen invoer over de lijn (~50 byte/s). De gast
 * ziet dus geen gecomprimeerd videobeeld maar zijn eigen, scherpe framebuffer,
 * en hoort zijn eigen geluid.
 *
 * Waarom dat kan (getoetst aan VideopacHorse_Core):
 *  - `g7k_run_frame` is volledig deterministisch: geen floats in cpu8048.c/sys.c,
 *    geen tijd- of randombronnen. Zelfde BIOS + zelfde cartridge + zelfde regio +
 *    zelfde invoer per frame ⇒ bit-identieke machine aan beide kanten.
 *  - Audio ontstaat in dezelfde VDC-scanlijnlus, dus die komt gratis mee.
 *  - `g7k_state_save/_load` bestaan al en zijn geëxporteerd naar WASM; die
 *    gebruiken we voor desync-detectie (hash) en herstel (resync).
 *
 * Model: delay-based lockstep. Wat je nú indrukt geldt pas over `delay` frames,
 * zodat de invoer van de ander op tijd binnen is. Elke kant plant zijn eigen
 * invoer vooruit en stuurt die, met de laatste 10 frames als redundantie over een
 * ONBETROUWBAAR kanaal — één verloren pakket mag geen stotter geven.
 *
 * Rolverdeling per speler is dezelfde als op /videopac/: alle bronnen worden
 * ge-OR'd. Host levert speler 1 (toetsenbord/gamepad/telefoon-P1) én zijn deel van
 * speler 2 (WASD/telefoon-P2), de gast levert zijn deel van speler 2. Beide kanten
 * rekenen met exact dezelfde optelling, dus beide zien hetzelfde spel.
 *
 * ROM's: deze site host en proxyt nog steeds geen ROM-bytes. De gast haalt BIOS en
 * cartridge bij voorkeur ZELF op (IndexedDB-cache of dezelfde archive.org-bron uit
 * games.json, herkend aan de CRC uit de handshake). Alleen als dat onmogelijk is —
 * de host speelt een zelf-geladen bestand dat nergens in de catalogus staat — biedt
 * de host het bestand over de P2P-verbinding aan, met een expliciete melding.
 */
'use strict';

const netplay = (() => {
  const API = (typeof window !== 'undefined' && window.VPH_API) || 'api/';
  const SIGNAL_POLL_MS = 500;
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  const CHUNK = 16 * 1024;          /* blob-chunk; ruim onder de SCTP-limiet     */
  const SEND_WINDOW = 10;           /* frames redundant meesturen                */
  const MIN_DELAY = 3, MAX_DELAY = 14;
  const HASH_EVERY = 60;            /* elke ~1,2 s een state-hash vergelijken    */
  /* Max frames per rAF-tick. De browser levert lang niet altijd 60 ticks/s (een
   * achtergrondtab, een trage machine of een tweede tab die meerekent zakt naar
   * 12-16), en dan moet één tick meerdere emulatieframes kunnen inhalen — anders
   * loopt het spel structureel te traag. De rem op wegloop-gedrag is de klem van
   * 100 ms op de accumulator, niet dit getal. */
  const MAX_CATCHUP = 6;
  const PING_MS = 2000;
  const ZERO = { p1: 0, p2: 0, ev: 0, keys: [] };

  const st = {
    mode: null,                 /* 'host' | 'guest' | null                        */
    phase: 'idle',              /* idle|signaling|assets|run|error                */
    hostToken: null, guestToken: null,
    code: null, codeP1: null, codeP2: null, codeGuest: null,
    expiresAt: 0,
    pc: null, ctl: null, inp: null,
    pollTimer: null, pingTimer: null,
    pendingICE: [],
    /* lockstep-toestand */
    frame: 0,                   /* eerstvolgende UIT TE VOEREN frame              */
    planned: -1,                /* hoogste frame waarvoor lokale invoer vaststaat */
    delay: 4,
    local: new Map(), remote: new Map(),
    pendingKeys: [], pendingEv: 0,
    acc: 0, lastT: 0,
    stalls: 0, stalling: false, stallSince: 0,
    peerAway: false,            /* medespeler heeft zijn tabblad weggeklikt      */
    hashes: new Map(),
    lastHash: null,             /* {frame, h} — laatste eigen state-hash          */
    rtt: 0, lastPingAt: 0,
    fps: 0, fpsCount: 0, fpsT: 0,   /* gemeten EMULATIE-snelheid (niet rAF-ticks) */
    desyncs: 0, resyncs: 0, romOverLine: false,
    blob: null,                 /* ontvangst in aanbouw                           */
    stateApi: null,             /* cwraps voor savestate (buiten S.api om)        */
    statePtr: 0, stateCap: 0,
    notice: '',
  };

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, kind) {
    const el = $('netStatus');
    if (el) { el.textContent = msg; el.className = 'badge ' + (kind || ''); }
  }

  function notice(msg) {
    st.notice = msg;
    const el = $('netNotice');
    if (el) { el.textContent = msg; el.hidden = !msg; }
  }

  function showCodes() {
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v || '------'; };
    set('netCode', st.code);
    set('netCodeP1', st.codeP1);
    set('netCodeP2', st.codeP2);
    const card = $('netCodeCard');
    if (card) card.hidden = !st.code;
    /* De gast ziet geen host-codes maar wél zijn eigen joystickcode: daarmee
     * koppelt hij een telefoon aan ZIJN kant, die bij hem op speler 2 optelt. */
    const gcard = $('netGuestCodeCard');
    if (gcard) {
      set('netCodeGuest', st.codeGuest);
      gcard.hidden = !st.codeGuest;
    }
  }

  function renderStats() {
    const el = $('netStats');
    if (!el) return;
    if (st.phase !== 'run') { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML =
      '<span>frame <b>' + st.frame + '</b></span>' +
      '<span>invoervertraging <b>' + st.delay + '</b> frames</span>' +
      '<span>heen en terug <b>' + Math.round(st.rtt) + ' ms</b></span>' +
      '<span>wachtbeurten <b>' + st.stalls + '</b></span>' +
      '<span>uit de pas <b>' + st.desyncs + '</b> (hersteld: ' + st.resyncs + ')</span>' +
      (st.romOverLine ? '<span>⚠ cartridge via de verbinding ontvangen</span>' : '');
  }

  /* ---------------- signaling (dezelfde API als /videopac/) ---------------- */

  function apiCall(action, body) {
    body = body || {};
    body.action = action;
    if (st.mode === 'guest' && st.guestToken) body.token = st.guestToken;
    else if (st.hostToken) body.token = st.hostToken;
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => r.json().then(j => {
      if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
      return j;
    }));
  }

  function startSignalPoll() {
    if (st.pollTimer) return;
    st.pollTimer = setInterval(() => {
      apiCall('rtc-signal-poll', {})
        .then(d => handleSignals(d.signals || []))
        .catch(e => console.warn('[netplay] poll:', e.message));
    }, SIGNAL_POLL_MS);
  }

  function stopSignalPoll() {
    if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
  }

  function handleSignals(signals) {
    if (!st.pc) return;
    signals.forEach(sig => {
      try {
        if (sig.type === 'offer' || sig.type === 'answer') {
          st.pc.setRemoteDescription(new RTCSessionDescription({ type: sig.type, sdp: sig.payload }))
            .then(() => {
              /* ICE-kandidaten die vóór de remote description binnenkwamen alsnog
               * toevoegen — zie BUG-006 op /videopac/. */
              const q = st.pendingICE.splice(0, st.pendingICE.length);
              q.forEach(c => st.pc.addIceCandidate(c).catch(() => { }));
            })
            .then(() => {
              if (sig.type === 'offer' && st.mode === 'host') {
                return st.pc.createAnswer()
                  .then(a => st.pc.setLocalDescription(a))
                  .then(() => apiCall('rtc-signal-send', { type: 'answer', payload: st.pc.localDescription.sdp }));
              }
            })
            .catch(e => console.error('[netplay] SDP:', e));
        } else if (sig.type === 'ice') {
          const c = new RTCIceCandidate(JSON.parse(sig.payload));
          if (!st.pc.remoteDescription) st.pendingICE.push(c);
          else st.pc.addIceCandidate(c).catch(() => { });
        } else if (sig.type === 'bye') {
          if (st.mode === 'host') rearm('medespeler is gestopt');
          else stop();
        }
      } catch (e) { console.error('[netplay] signal:', e); }
    });
  }

  function createPeer(isGuest) {
    if (st.pc) { detach(st.pc); try { st.pc.close(); } catch (e) { } }
    st.pc = new RTCPeerConnection(RTC_CONFIG);
    st.pendingICE = [];

    st.pc.onicecandidate = ev => {
      if (ev.candidate) {
        apiCall('rtc-signal-send', { type: 'ice', payload: JSON.stringify(ev.candidate) })
          .catch(() => { });
      }
    };

    st.pc.onconnectionstatechange = () => {
      if (!st.pc) return;
      const s = st.pc.connectionState;
      if (s === 'connected') setStatus('verbonden', 'ok');
      /* 'disconnected' is tijdelijk (BUG-010 op /videopac/): niet afbreken. De
       * lockstep stalt vanzelf zolang er geen invoer binnenkomt en loopt weer
       * door zodra de verbinding terug is. */
      else if (s === 'disconnected') setStatus('verbinding hapert — even geduld…', 'warn');
      else if (s === 'failed' || s === 'closed') {
        if (st.mode === 'host') rearm('verbinding verbroken');
        else { setStatus('verbinding verbroken', 'err'); stop(); }
      }
    };

    if (isGuest) {
      /* De gast maakt beide kanalen. 'ctl' is betrouwbaar en op volgorde (voor de
       * handshake, savestates en hashes). 'in' is dat juist NIET: invoer die te
       * laat komt is waardeloos, en één hertransmissie zou alle volgende frames
       * ophouden (head-of-line blocking). Verlies vangen we op met redundantie. */
      st.ctl = st.pc.createDataChannel('ctl', { ordered: true });
      st.inp = st.pc.createDataChannel('in', { ordered: false, maxRetransmits: 0 });
      wireChannels();
    } else {
      st.pc.ondatachannel = ev => {
        if (ev.channel.label === 'ctl') st.ctl = ev.channel;
        else st.inp = ev.channel;
        wireChannels();
      };
    }
    return st.pc;
  }

  function detach(pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.ondatachannel = null;
  }

  function wireChannels() {
    if (st.ctl) {
      st.ctl.binaryType = 'arraybuffer';
      st.ctl.onmessage = ev => {
        if (typeof ev.data === 'string') onCtl(JSON.parse(ev.data));
        else onBlobChunk(ev.data);
      };
      st.ctl.onopen = () => {
        setStatus('verbonden — machines gelijkzetten…', 'busy');
        if (st.mode === 'host') sendHello();
        startPing();
        watchVisibility();
      };
      st.ctl.onclose = () => { if (st.phase === 'run') setPhase('assets'); };
    }
    if (st.inp) {
      st.inp.binaryType = 'arraybuffer';
      st.inp.onmessage = ev => onInputPacket(ev.data);
    }
  }

  function ctlSend(obj) {
    if (st.ctl && st.ctl.readyState === 'open') {
      try { st.ctl.send(JSON.stringify(obj)); } catch (e) { console.warn('[netplay] ctl:', e); }
    }
  }

  function startPing() {
    if (st.pingTimer) return;
    st.pingTimer = setInterval(() => {
      st.lastPingAt = performance.now();
      ctlSend({ t: 'ping', ts: st.lastPingAt });
    }, PING_MS);
  }

  /* ---------------- assets: BIOS + cartridge gelijkzetten ---------------- */

  function romMeta() {
    if (!S.bios || !S.rom) return null;
    return {
      core: S.api.version(),
      region: $('chkNtsc') && $('chkNtsc').checked ? 1 : 0,
      bios: { crc: crc32(S.bios), size: S.bios.length },
      rom: { crc: crc32(S.rom), size: S.rom.length, title: S.romTitle || 'onbekend' },
    };
  }

  function sendHello() {
    const meta = romMeta();
    if (!meta) {
      setStatus('laad eerst een BIOS en een spel — dan zet ik de machines gelijk', 'warn');
      return;
    }
    setPhase('assets');
    ctlSend(Object.assign({ t: 'hello' }, meta));
  }

  /* Gast: BIOS/cartridge zoeken die bij de opgegeven CRC horen. Volgorde is
   * bewust: eerst wat al lokaal staat, dan de publieke bron uit games.json, en
   * pas als beide niets opleveren vragen we het de host. */
  async function acquire(kind, want) {
    if (kind === 'bios') {
      const cached = await idbGet('bios');
      if (cached) {
        const b = new Uint8Array(cached);
        if (crc32(b) === want.crc) return { bytes: b, source: 'eigen browser' };
      }
      const cat = GAMES.cat && GAMES.cat.bios;
      if (cat && (!cat.crc32 || cat.crc32.toLowerCase() === want.crc)) {
        const b = await gamesFetchRom(cat.url);
        if (crc32(b) === want.crc) return { bytes: b, source: 'archive.org' };
      }
      return null;
    }
    const cached = await idbGet('game:' + want.crc);
    if (cached) return { bytes: new Uint8Array(cached), source: 'eigen browser' };
    const entry = GAMES.cat && GAMES.cat.games.find(g => g.crc32.toLowerCase() === want.crc);
    if (entry) {
      const b = await gamesFetchRom(entry.url);
      if (crc32(b) === want.crc) {
        await idbPut('game:' + want.crc, b.buffer.slice(0));
        return { bytes: b, source: 'archive.org', title: entry.title, nr: entry.nr };
      }
    }
    return null;
  }

  async function onHello(msg) {
    setPhase('assets');
    if (msg.core !== S.api.version()) {
      setStatus('versies verschillen (host ' + msg.core + ', jij ' + S.api.version() +
                ') — netplay kan alleen tussen identieke cores', 'err');
      st.phase = 'error';
      return;
    }
    S.api.setRegion(S.sys, msg.region | 0);
    if ($('chkNtsc')) $('chkNtsc').checked = !!msg.region;

    const need = [];
    try {
      setStatus('BIOS en spel ophalen…', 'busy');
      const bios = await acquire('bios', msg.bios);
      if (bios) { S.biosSource = bios.source; applyBios(bios.bytes, true); }
      else need.push('bios');

      const rom = await acquire('rom', msg.rom);
      if (rom) {
        S.romTitle = rom.title ? ((rom.nr != null ? 'nr ' + rom.nr + ' ' : '') + rom.title) : msg.rom.title;
        GAMES.loadedCrc = msg.rom.crc;
        applyRomQuiet(rom.bytes);
      } else need.push('rom');
    } catch (e) {
      console.warn('[netplay] ophalen mislukt:', e);
      if (!S.bios || crc32(S.bios) !== msg.bios.crc) need.push('bios');
      if (!S.rom || crc32(S.rom) !== msg.rom.crc) need.push('rom');
    }

    if (need.length) {
      /* Laatste redmiddel: de host stuurt het bestand zelf. Dat is P2P-verkeer
       * tussen twee mensen die samen spelen — geen distributie via deze site —
       * maar het is wél andermans bestand, dus het wordt benoemd in beeld. */
      notice('Ontbrekende bestanden (' + need.join(' + ') + ') worden rechtstreeks van je ' +
             'medespeler ontvangen. Deze site verstuurt of bewaart geen ROM-bytes.');
      ctlSend({ t: 'need', what: need });
      setStatus('bestanden ontvangen van de host…', 'busy');
      return;
    }
    sendReady(msg);
  }

  /* Zelfde als applyRom() uit app.js, maar zonder de netplay-terugmelding: die
   * zou hier een oneindige lus geven (de gast laadt juist ómdat de host dat vroeg). */
  function applyRomQuiet(bytes) {
    const ptr = pushBytes(bytes);
    const rc = S.api.loadCart(S.sys, ptr, bytes.length);
    S.mod._free(ptr);
    S.rom = rc === 0 ? bytes : null;
    setBadge('romBadge', rc === 0, 'geladen — ' + (S.romTitle || 'van medespeler') +
             ' (' + (bytes.length / 1024) + ' KB)', 'ongeldige ROM-grootte');
    if (rc === 0) idbPut('rom', bytes.buffer.slice(0));
    updateButtons();
  }

  function sendReady(msg) {
    const ok = S.bios && S.rom && crc32(S.bios) === msg.bios.crc && crc32(S.rom) === msg.rom.crc;
    if (!ok) {
      setStatus('bestanden komen niet overeen met die van de host', 'err');
      ctlSend({ t: 'mismatch' });
      return;
    }
    setStatus('klaar — wachten op startsein', 'busy');
    ctlSend({ t: 'ready', core: S.api.version(), bios: crc32(S.bios), rom: crc32(S.rom) });
  }

  /* ---------------- blob-overdracht (assets + savestate) ---------------- */

  function sendBlob(kind, bytes, extra) {
    ctlSend(Object.assign({ t: 'blob-begin', kind, size: bytes.length, crc: crc32(bytes) }, extra || {}));
    /* De extra velden gaan óók in blob-end mee: de ontvanger handelt de blob daar
     * af en heeft ze dan pas nodig (bijvoorbeeld het frame van een savestate). */
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const part = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
      /* Kopie: het onderliggende WASM-geheugen kan verplaatsen bij groei, en
       * DataChannel.send() leest de buffer asynchroon uit. */
      try { st.ctl.send(new Uint8Array(part).buffer); }
      catch (e) { console.warn('[netplay] blob-chunk:', e); return; }
    }
    ctlSend(Object.assign({ t: 'blob-end', kind }, extra || {}));
  }

  function onBlobChunk(buf) {
    if (!st.blob) return;
    st.blob.parts.push(new Uint8Array(buf));
    st.blob.got += buf.byteLength;
  }

  function finishBlob() {
    const b = st.blob;
    st.blob = null;
    if (!b) return null;
    const out = new Uint8Array(b.got);
    let off = 0;
    b.parts.forEach(p => { out.set(p, off); off += p.length; });
    if (out.length !== b.size || crc32(out) !== b.crc) {
      setStatus('ontvangen bestand is beschadigd (' + b.kind + ')', 'err');
      return null;
    }
    return out;
  }

  /* ---------------- besturingsberichten ---------------- */

  function onCtl(msg) {
    switch (msg.t) {
      case 'ping': ctlSend({ t: 'pong', ts: msg.ts }); break;
      case 'pong': {
        st.rtt = performance.now() - msg.ts;
        /* Vertraging volgt de gemeten looptijd: halve RTT + een marge, in frames.
         * Alleen omhoog — omlaag zou invoer plannen op een frame dat de ander al
         * heeft uitgevoerd, en dát is precies hoe je de machines uit de pas laat
         * lopen. Bij een rustiger lijn corrigeert de volgende sessie het vanzelf. */
        const period = framePeriod();
        const want = Math.min(MAX_DELAY, Math.max(MIN_DELAY,
          Math.ceil((st.rtt / 2 + 25) / period) + 1));
        if (want > st.delay) st.delay = want;
        break;
      }
      case 'hello': onHello(msg); break;
      case 'need': {
        if (st.mode !== 'host') break;
        notice('Je medespeler heeft het spel niet — het bestand gaat rechtstreeks naar hem toe.');
        if (msg.what.indexOf('bios') >= 0) sendBlob('bios', S.bios);
        if (msg.what.indexOf('rom') >= 0) sendBlob('rom', S.rom, { title: S.romTitle || '' });
        ctlSend(Object.assign({ t: 'hello' }, romMeta()));
        break;
      }
      case 'blob-begin':
        st.blob = { kind: msg.kind, size: msg.size | 0, crc: msg.crc, title: msg.title, parts: [], got: 0 };
        break;
      case 'blob-end': {
        const kind = msg.kind;
        const bytes = finishBlob();
        if (!bytes) break;
        if (kind === 'bios') { S.biosSource = 'medespeler'; applyBios(bytes, true); st.romOverLine = true; }
        else if (kind === 'rom') { S.romTitle = 'van medespeler'; applyRomQuiet(bytes); st.romOverLine = true; }
        else if (kind === 'state') loadResync(bytes, msg.frame | 0);
        break;
      }
      case 'ready': {
        if (st.mode !== 'host') break;
        const meta = romMeta();
        if (!meta || msg.bios !== meta.bios.crc || msg.rom !== meta.rom.crc) {
          setStatus('medespeler heeft andere bestanden — netplay niet gestart', 'err');
          break;
        }
        beginRun(0, true);
        ctlSend({ t: 'start', frame: 0, delay: st.delay, region: meta.region });
        break;
      }
      case 'start':
        S.api.setRegion(S.sys, msg.region | 0);
        st.delay = Math.max(MIN_DELAY, msg.delay | 0);
        beginRun(msg.frame | 0, true);
        break;
      case 'mismatch':
        setStatus('medespeler kon de bestanden niet gelijkkrijgen', 'err');
        break;
      case 'hash': {
        if (st.mode !== 'host') break;
        const mine = st.hashes.get(msg.f);
        if (mine === undefined) break;              /* te oud of nog niet bereikt */
        if (mine !== msg.h) {
          st.desyncs++;
          setStatus('machines liepen uit de pas — bijtrekken…', 'warn');
          sendResync();
        }
        break;
      }
      case 'restart':                                /* gast wil opnieuw gelijk    */
        if (st.mode === 'host') sendHello();
        break;
      case 'away':
        /* Browsers bevriezen requestAnimationFrame in een tabblad dat niet
         * zichtbaar is. De emulatie van die kant staat dan stil en de lockstep
         * laat de ander netjes meewachten — technisch precies goed, maar zonder
         * uitleg lijkt het op een vastloper. Vandaar dit bericht. */
        st.peerAway = !!msg.away;
        if (st.peerAway) setStatus('je medespeler heeft het tabblad weggeklikt — het spel wacht', 'warn');
        else setStatus('netplay actief — jij bent ' + (st.mode === 'host' ? 'speler 1' : 'speler 2'), 'ok');
        break;
    }
    renderStats();
  }

  /* ---------------- savestate: hash + resync ---------------- */

  function stateApi() {
    if (st.stateApi) return st.stateApi;
    const cw = S.mod.cwrap;
    st.stateApi = {
      size: cw('g7k_state_size', 'number', ['number']),
      save: cw('g7k_state_save', 'number', ['number', 'number', 'number']),
      load: cw('g7k_state_load', 'number', ['number', 'number', 'number']),
    };
    return st.stateApi;
  }

  function grabState() {
    const api = stateApi();
    const n = api.size(S.sys);
    if (!n) return null;
    if (st.stateCap < n) {
      if (st.statePtr) S.mod._free(st.statePtr);
      st.statePtr = S.mod._malloc(n);
      st.stateCap = n;
    }
    if (api.save(S.sys, st.statePtr, n) !== 0) return null;
    return new Uint8Array(S.mod.HEAPU8.buffer, st.statePtr, n).slice(0);
  }

  /* FNV-1a over de volledige machinestaat. Niet over de framebuffer: twee
   * machines kunnen hetzelfde beeld tonen en toch verschillende RAM hebben, en
   * dan zie je de desync pas frames later — als het al te laat is. */
  function fnv1a(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function sendResync() {
    const state = grabState();
    if (!state) return;
    /* De state hoort bij "alles t/m frame st.frame-1 is uitgevoerd"; de ontvanger
     * gaat dus verder bij st.frame. */
    sendBlob('state', state, { frame: st.frame });
  }

  function loadResync(bytes, frame) {
    const api = stateApi();
    const ptr = S.mod._malloc(bytes.length);
    S.mod.HEAPU8.set(bytes, ptr);
    const rc = api.load(S.sys, ptr, bytes.length);
    S.mod._free(ptr);
    if (rc !== 0) { setStatus('bijtrekken mislukt', 'err'); return; }
    st.frame = frame;
    st.acc = 0;
    /* De planning moet mee verhuizen. Sprongen we vooruit (we liepen achter), dan
     * staat `planned` nog op een frame dat allang gepasseerd is; zonder deze regel
     * plant planAhead() alleen die oude reeks bij en krijgt de host nooit invoer
     * voor het frame waar hij op wacht — dan blijft hij eeuwig staan wachten.
     * Achteruit springen doen we niet: die invoer is al verstuurd en de host
     * rekent er al mee. */
    if (st.planned < st.frame - 1) st.planned = st.frame - 1;
    prune();
    st.resyncs++;
    setStatus('weer gelijk', 'ok');
  }

  /* ---------------- lockstep ---------------- */

  /* PAL 50 Hz / NTSC 60 Hz. De regio ligt tijdens een sessie vast (handshake),
   * dus beide kanten rekenen met dezelfde framelengte. */
  function framePeriod() {
    const ntsc = $('chkNtsc') && $('chkNtsc').checked;
    return ntsc ? 1000 / 60 : 1000 / 50;
  }

  function setPhase(p) {
    st.phase = p;
    renderStats();
  }

  function beginRun(frame, cold) {
    if (cold) {
      /* Beide kanten doen exact dezelfde koude start: reset, BIOS en cartridge
       * opnieuw inladen. Daarna is de machine aan beide kanten bit-identiek. */
      S.api.reset(S.sys, 1);
      if (S.bios) { const p = pushBytes(S.bios); S.api.loadBios(S.sys, p, S.bios.length); S.mod._free(p); }
      if (S.rom) { const p = pushBytes(S.rom); S.api.loadCart(S.sys, p, S.rom.length); S.mod._free(p); }
    }
    st.frame = frame | 0;
    st.planned = st.frame - 1;
    st.local.clear(); st.remote.clear(); st.hashes.clear();
    st.pendingKeys = []; st.pendingEv = 0;
    st.acc = 0; st.lastT = 0; st.stalls = 0;
    S.joyKb = [0, 0]; S.joyGp = [0, 0]; S.joyPeer = [0, 0]; S.joyCtrl = [0, 0];
    S.joy = [0, 0];
    S.api.joy(S.sys, 0, 0); S.api.joy(S.sys, 1, 0);
    setPhase('run');
    setStatus('netplay actief — jij bent ' + (st.mode === 'host' ? 'speler 1' : 'speler 2'), 'ok');
    if (!S.running && $('btnStart') && !$('btnStart').disabled) $('btnStart').click();
    else if (typeof audioStart === 'function') audioStart();
  }

  function snapshotInput() {
    const e = {
      p1: (S.joyKb[0] | S.joyGp[0] | S.joyPeer[0] | S.joyCtrl[0]) & 0x1f,
      p2: (S.joyKb[1] | S.joyGp[1] | S.joyPeer[1] | S.joyCtrl[1]) & 0x1f,
      ev: st.pendingEv,
      keys: st.pendingKeys,
    };
    st.pendingKeys = [];
    st.pendingEv = 0;
    return e;
  }

  /* Vooruit plannen tot frame + delay. Gaten zijn niet toegestaan: elk frame moet
   * precies één lokale invoer hebben, anders rekent de ander met iets anders. */
  function planAhead() {
    const target = st.frame + st.delay;
    while (st.planned < target) {
      st.planned++;
      st.local.set(st.planned, snapshotInput());
    }
  }

  function prune() {
    const keep = st.frame - 120;
    if (keep < 0) return;
    st.local.forEach((_, f) => { if (f < keep) st.local.delete(f); });
    st.remote.forEach((_, f) => { if (f < keep) st.remote.delete(f); });
    st.hashes.forEach((_, f) => { if (f < st.frame - 600) st.hashes.delete(f); });
  }

  /* Binair invoerpakket — compact genoeg om elke tick de laatste tien frames
   * opnieuw mee te sturen (≈60 byte), zodat verlies op het onbetrouwbare kanaal
   * geen stotter geeft. */
  function sendInput() {
    if (!st.inp || st.inp.readyState !== 'open') return;
    const first = Math.max(st.frame, st.planned - SEND_WINDOW + 1);
    const count = st.planned - first + 1;
    if (count <= 0) return;

    let size = 6;
    for (let f = first; f <= st.planned; f++) {
      const e = st.local.get(f) || ZERO;
      size += 4 + e.keys.length * 2;
    }
    const buf = new ArrayBuffer(size);
    const v = new DataView(buf);
    v.setUint8(0, 0x4e);                    /* 'N' */
    v.setUint8(1, count);
    v.setUint32(2, first, true);
    let o = 6;
    for (let f = first; f <= st.planned; f++) {
      const e = st.local.get(f) || ZERO;
      v.setUint8(o++, e.p1);
      v.setUint8(o++, e.p2);
      v.setUint8(o++, e.ev);
      v.setUint8(o++, e.keys.length);
      for (const k of e.keys) { v.setUint8(o++, k[0]); v.setUint8(o++, k[1] ? 1 : 0); }
    }
    try { st.inp.send(buf); } catch (e) { /* vol of even weg: volgende tick weer */ }
  }

  function onInputPacket(buf) {
    const v = new DataView(buf);
    if (v.byteLength < 6 || v.getUint8(0) !== 0x4e) return;
    const count = v.getUint8(1);
    const first = v.getUint32(2, true);
    let o = 6;
    for (let i = 0; i < count; i++) {
      if (o + 4 > v.byteLength) return;
      const p1 = v.getUint8(o++), p2 = v.getUint8(o++), ev = v.getUint8(o++);
      const nk = v.getUint8(o++);
      const keys = [];
      for (let k = 0; k < nk && o + 1 < v.byteLength; k++) {
        keys.push([v.getUint8(o++), v.getUint8(o++)]);
      }
      const f = first + i;
      if (f >= st.frame && !st.remote.has(f)) st.remote.set(f, { p1, p2, ev, keys });
    }
  }

  function runOneFrame() {
    const f = st.frame;
    const L = st.local.get(f) || ZERO;
    const R = st.remote.get(f) || ZERO;

    /* Alle bronnen bij elkaar opgeteld — dezelfde regel als pushJoy op
     * /videopac/, nu over twee machines heen. */
    S.api.joy(S.sys, 0, (L.p1 | R.p1) & 0x1f);
    S.api.joy(S.sys, 1, (L.p2 | R.p2) & 0x1f);
    for (const k of L.keys) S.api.keySet(S.sys, k[0], k[1]);
    for (const k of R.keys) S.api.keySet(S.sys, k[0], k[1]);

    const ev = L.ev | R.ev;
    if (ev & 1) S.api.reset(S.sys, 0);
    if (ev & 2) {
      S.api.reset(S.sys, 1);
      if (S.bios) { const p = pushBytes(S.bios); S.api.loadBios(S.sys, p, S.bios.length); S.mod._free(p); }
      if (S.rom) { const p = pushBytes(S.rom); S.api.loadCart(S.sys, p, S.rom.length); S.mod._free(p); }
    }

    S.api.runFrame(S.sys);
    st.frame++;

    if (st.frame % HASH_EVERY === 0) {
      const state = grabState();
      if (state) {
        const h = fnv1a(state);
        /* Beide kanten bewaren hun eigen laatste hash mét framenummer. De host
         * heeft hem nodig om de gast te controleren; voor de gast is het de enige
         * manier om van BUITENAF (e2e-test, foutmelding) aan te tonen dat de twee
         * machines op hetzelfde frame identiek waren — twee canvassen op hetzelfde
         * KLOKmoment vergelijken zegt niets, want ze mogen frames uit elkaar lopen. */
        st.lastHash = { frame: st.frame, h };
        if (st.mode === 'host') st.hashes.set(st.frame, h);
        else ctlSend({ t: 'hash', f: st.frame, h });
      }
    }
  }

  /* Wordt vanuit frame() in app.js aangeroepen, één keer per rAF-tick. */
  function step(ts) {
    const now = (typeof ts === 'number' && ts > 0) ? ts : performance.now();
    if (!st.lastT) st.lastT = now;
    /* Na een tabwissel of een lange stall niet honderden frames inhalen: dat zou
     * het spel op absurde snelheid vooruitspoelen. */
    st.acc = Math.min(st.acc + (now - st.lastT), 100);
    st.lastT = now;

    const period = framePeriod();
    let ran = 0;
    while (st.acc >= period && ran < MAX_CATCHUP) {
      if (!st.remote.has(st.frame)) {
        /* Invoer van de ander is er nog niet. Wachten is het enige juiste: een
         * frame draaien met verzonnen invoer zou de machines laten uiteenlopen. */
        if (!st.stalling) { st.stalling = true; st.stalls++; st.stallSince = now; }
        /* Duurt het langer dan een haperingetje, zeg dan wát er aan de hand is —
         * een stilstaand beeld zonder tekst leest als kapot. */
        if (!st.peerAway && now - st.stallSince > 1500) {
          setStatus('wachten op je medespeler…', 'warn');
        }
        /* GEEN savestate sturen omdat het wachten lang duurt — geprobeerd en
         * gemeten (27-07): wie stalt is juist de kant die ACHTERBLIJFT, want hij
         * kan niet verder zonder de invoer van de ander. Zijn savestate zet de
         * vooruitlopende medespeler dus terug, en bij het opstarten (de host
         * wacht dan normaal even op een ladende gast) gaat dat in herhaling:
         * gemeten host op frame 15 met 8 resyncs in 20 s. Inhalen gaat vanzelf en
         * kost hooguit `delay` frames, want de wachtende kant is zelf ook gestopt.
         * Savestates blijven voor waar ze voor bedoeld zijn: een echte desync. */
        break;
      }
      if (st.stalling && !st.peerAway && now - st.stallSince > 1500) {
        setStatus('netplay actief — jij bent ' + (st.mode === 'host' ? 'speler 1' : 'speler 2'), 'ok');
      }
      st.stalling = false;
      runOneFrame();
      st.acc -= period;
      ran++;
    }

    /* Emulatiesnelheid meten: het aantal frames dat de máchine draait, niet het
     * aantal keer dat de browser ons wakker maakt. Die twee lopen hier bewust
     * uiteen (één tick kan meerdere frames inhalen) en alleen de eerste zegt iets
     * over of het spel op snelheid loopt. */
    st.fpsCount += ran;
    if (!st.fpsT) st.fpsT = now;
    if (now - st.fpsT >= 1000) {
      st.fps = Math.round(st.fpsCount * 1000 / (now - st.fpsT));
      st.fpsCount = 0;
      st.fpsT = now;
    }

    planAhead();
    sendInput();
    prune();
    if ((st.frame & 15) === 0) renderStats();
  }

  function rearm(reason) {
    if (st.mode !== 'host') return;
    setPhase('assets');
    st.remote.clear();
    createPeer(false);
    setStatus((reason ? reason + ' — ' : '') + 'gastcode: ' + st.code + ' (wacht op medespeler…)', '');
    showCodes();
  }

  function stop() {
    const wasHost = st.mode === 'host';
    const hostToken = st.hostToken;
    stopSignalPoll();
    if (st.pingTimer) { clearInterval(st.pingTimer); st.pingTimer = null; }
    if (st.ctl) { try { st.ctl.close(); } catch (e) { } st.ctl = null; }
    if (st.inp) { try { st.inp.close(); } catch (e) { } st.inp = null; }
    if (st.pc) { detach(st.pc); try { st.pc.close(); } catch (e) { } st.pc = null; }
    if (wasHost && hostToken) {
      fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pair-end', token: hostToken })
      }).catch(() => { });
    }
    st.mode = null; st.hostToken = null; st.guestToken = null;
    st.code = null; st.codeP1 = null; st.codeP2 = null; st.codeGuest = null;
    st.local.clear(); st.remote.clear();
    setPhase('idle');
    setStatus('gestopt', '');
    notice('');
    showCodes();
    const card = $('netCodeCard');
    if (card) card.hidden = true;
  }

  /* Eén listener per pagina; hij blijft leven zolang de pagina leeft. Zonder de
   * `bound`-vlag zou elke nieuwe sessie er een extra aanhangen. */
  let visibilityBound = false;
  function watchVisibility() {
    if (visibilityBound) return;
    visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (st.phase !== 'run') return;
      ctlSend({ t: 'away', away: document.hidden });
    });
  }

  /* ---------------- publieke kant ---------------- */

  const pub = {
    active() { return st.phase === 'run'; },
    notice,

    /* Gemeten emulatieframes per seconde; app.js toont dit in plaats van de
     * rAF-teller zodra netplay draait. */
    emuFps() { return st.fps; },

    setLocalJoy() {
      /* Bewust leeg. De invoerbronnen (S.joyKb/joyGp/joyPeer/joyCtrl) zijn al
       * bijgewerkt vóór deze aanroep; snapshotInput() leest ze op het moment dat
       * het frame gepland wordt. Een tweede administratie zou alleen maar uit de
       * pas kunnen lopen met de eerste. */
    },

    setLocalKey(code, down) {
      st.pendingKeys.push([code, down ? 1 : 0]);
    },

    requestReset(cold) {
      if (st.mode !== 'host') {
        notice('Alleen de host kan resetten — anders staan de machines meteen verschillend.');
        return;
      }
      st.pendingEv |= cold ? 2 : 1;
    },

    onCartChanged() {
      if (st.mode === 'host') sendHello();
      else ctlSend({ t: 'restart' });   /* gast wisselde: haal de host-cartridge op */
    },

    async startHost() {
      if (st.mode) { setStatus('er loopt al een sessie', 'err'); return; }
      setStatus('codes aanvragen…', 'busy');
      try {
        const r = await apiCall('pair-create', {});
        st.mode = 'host';
        st.hostToken = r.host_token;
        st.code = r.code;
        st.codeP1 = r.ctrl_code_p1;
        st.codeP2 = r.ctrl_code_p2;
        st.expiresAt = r.expires_at | 0;
        setPhase('signaling');
        createPeer(false);
        showCodes();
        setStatus('gastcode: ' + st.code + ' (wacht op medespeler…)', 'busy');
        startSignalPoll();
      } catch (e) {
        st.mode = null;
        setStatus('fout: ' + e.message, 'err');
      }
    },

    async joinGuest(codeInput) {
      if (st.mode) { setStatus('er loopt al een sessie', 'err'); return; }
      const code = (codeInput || '').toUpperCase().trim();
      if (code.length !== 6) { setStatus('code moet 6 tekens zijn', 'err'); return; }
      setStatus('verbinden…', 'busy');
      try {
        const r = await apiCall('pair-join', { code });
        st.mode = 'guest';
        st.guestToken = r.guest_token;
        st.codeGuest = r.ctrl_code_guest || null;
        st.expiresAt = r.expires_at | 0;
        showCodes();
        setPhase('signaling');
        createPeer(true);
        /* Géén media-transceivers: er gaat hier geen beeld of geluid over de lijn.
         * Dat is het hele punt van deze variant. */
        const offer = await st.pc.createOffer();
        await st.pc.setLocalDescription(offer);
        await apiCall('rtc-signal-send', { type: 'offer', payload: st.pc.localDescription.sdp });
        setStatus('wacht op antwoord van de host…', 'busy');
        startSignalPoll();
      } catch (e) {
        st.mode = null;
        setStatus('meedoen mislukt: ' + e.message, 'err');
      }
    },

    stop,
    step,

    /* app.js praat met 'pairPlay'; netplay levert dezelfde vorm zodat de
     * telefoon-joysticks (ctrl-poll) en de gast-invoerroute ongewijzigd werken. */
    getStatus() {
      return {
        mode: st.mode,
        code: st.code,
        active: st.mode !== null,
        connected: st.pc ? st.pc.connectionState === 'connected' : false,
        hostToken: st.mode === 'host' ? st.hostToken : null,
        /* Alleen voor ctrlPad: hiermee pollt de gast zijn eigen telefoons. Een
         * token is een identiteit — de host krijgt dit veld nooit te zien en
         * omgekeerd (BUG-003b). */
        guestToken: st.mode === 'guest' ? st.guestToken : null,
      };
    },

    sendGuestInput() {
      /* Ook leeg, om dezelfde reden: app.js heeft S.joyKb[1]/S.joyGp[1] al gezet.
       * Anders dan op /videopac/ gaat er hier niets direct de lijn op — invoer
       * hoort bij een frame, en dat frame wordt in planAhead() vastgelegd. */
    },

    restore() {
      /* Verse pagina = verse sessie, net als op /videopac/. */
      st.mode = null; st.code = null; st.codeP1 = null; st.codeP2 = null; st.codeGuest = null;
    },

    /* Inzicht in de lockstep zonder de closure open te breken. Gebruikt door de
     * e2e-test en handig bij een klacht als "hij hapert bij mij": je ziet direct
     * of frames wél lopen, of invoer aankomt en welke kant wacht. */
    debug() {
      const l = st.local.get(st.frame - 1) || null;
      const r = st.remote.get(st.frame - 1) || null;
      return {
        phase: st.phase, mode: st.mode, frame: st.frame, planned: st.planned,
        delay: st.delay, stalls: st.stalls, rtt: Math.round(st.rtt),
        localAhead: st.planned - st.frame, remoteAhead: (() => {
          let n = 0;
          while (st.remote.has(st.frame + n)) n++;
          return n;
        })(),
        lastLocal: l, lastRemote: r,
        lastHash: st.lastHash,
        peerAway: st.peerAway,
        fps: st.fps,
        desyncs: st.desyncs, resyncs: st.resyncs,
        joySources: { kb: S.joyKb.slice(), gp: S.joyGp.slice(), ctrl: S.joyCtrl.slice() },
      };
    },
  };

  return pub;
})();

/* app.js verwacht een globale `pairPlay`; op deze pagina is dat netplay zelf. */
const pairPlay = netplay;
