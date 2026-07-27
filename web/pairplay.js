/*
 * pairplay.js — VideopacHorse 🎭 Samen spelen (v0.4.0)
 *
 * WebRTC P2P multiplayer: twee bezoekers pairen via 6-tekens code.
 * Host draait emulator + streamt canvas (50fps) + WebAudio-tap naar gast.
 * Gast ontvangt stream via WebRTC, input (toetsenbord/gamepad) gaat via DataChannel
 * naar host → speler 2.
 *
 * De sessie is sinds v0.4.0 méér dan "Samen spelen": dezelfde code koppelt ook
 * telefoon-joysticks (zie ctrlPad in app.js). Een sessie zonder gast is dus een
 * volstrekt normale, gewenste situatie en mag NOOIT automatisch worden
 * afgebroken — alleen de host stopt hem, met ⏹ Stop sessie.
 *
 * Storage: localStorage voor sessie-tokens; de host-sessie wordt bij herladen
 * van de pagina hersteld, zodat een F5 de gekoppelde telefoons niet sloopt.
 * Signaling: api.php poll-en-delete (500ms interval).
 * STUN: Google public (STUN-only, geen TURN).
 */
'use strict';

const pairPlay = (() => {
  const API = 'api/';
  const SIGNAL_POLL_MS = 500;
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  const LS_HOST_KEY = 'videopachorse.pairplay.host.v1';
  const LS_GUEST_KEY = 'videopachorse.pairplay.guest.v1';
  /* Na zoveel wachten verandert alleen de MELDING (niet de sessie): het is dan
   * duidelijk dat er geen "Samen spelen"-gast meer komt. */
  const GUEST_WAIT_NOTICE_MS = 10 * 60 * 1000;

  let state = {
    mode: null,           // 'host' | 'guest' | null
    hostToken: null,
    guestToken: null,
    code: null,
    expiresAt: 0,         // epoch-seconden van de serversessie (4 uur)
    pc: null,             // RTCPeerConnection
    localStream: null,    // Host's canvas-stream
    remoteStream: null,   // Guest's received stream
    dataChannel: null,    // For guest input → host
    pollTimer: null,
    offerSent: false,
    readyFired: false,
    graceTimer: null,
    iceRestarted: false,
    pendingICE: [],
    status: 'stopped',
  };

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, kind) {
    const el = $('pairplayStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'badge ' + (kind ? kind : '');
  }

  function apiCall(action, body) {
    body = body || {};
    body.action = action;

    // Voeg token toe als aanwezig
    /* token per ROL: gast authenticeert nooit met een host-token */
    if (state.mode === 'guest' && state.guestToken) body.token = state.guestToken;
    else if (state.hostToken) body.token = state.hostToken;

    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => {
      return r.json().then(j => {
        if (!r.ok) {
          const err = new Error(j.error || ('HTTP ' + r.status));
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }

  function loadHostSession() {
    try {
      const stored = JSON.parse(localStorage.getItem(LS_HOST_KEY));
      if (stored && stored.hostToken) return stored;
    } catch (e) { }
    return null;
  }

  function saveHostSession(code, hostToken, expiresAt) {
    const sess = { code, hostToken, expiresAt, startedAt: Date.now() };
    localStorage.setItem(LS_HOST_KEY, JSON.stringify(sess));
    return sess;
  }

  function clearHostSession() {
    localStorage.removeItem(LS_HOST_KEY);
    state.hostToken = null;
    state.code = null;
  }

  function saveGuestSession(guestToken, expiresAt) {
    const sess = { guestToken, expiresAt, startedAt: Date.now() };
    localStorage.setItem(LS_GUEST_KEY, JSON.stringify(sess));
    return sess;
  }

  function clearGuestSession() {
    localStorage.removeItem(LS_GUEST_KEY);
    state.guestToken = null;
  }

  // ----- WebRTC lifecycle -----

  /* Herstelmechanisme bij tijdelijke haperingen (BUG-010). */
  function clearGrace() {
    if (state.graceTimer) { clearTimeout(state.graceTimer); state.graceTimer = null; }
  }

  function scheduleGrace() {
    if (state.graceTimer) return;
    state.graceTimer = setTimeout(() => {
      state.graceTimer = null;
      if (!state.pc) return;
      const st = state.pc.connectionState;
      if (st === 'connected') return;                 /* vanzelf hersteld */
      if (state.mode === 'host') {
        rearmHost('gast verbroken — sessie blijft actief');
      } else if (!state.iceRestarted) {
        tryIceRestart();
      } else {
        setStatus('verbinding verbroken', 'err');
        teardown();
      }
    }, 8000);
  }

  /* Gast is de offerer: opnieuw onderhandelen met iceRestart i.p.v. opgeven. */
  function tryIceRestart() {
    if (state.mode !== 'guest' || !state.pc || state.iceRestarted) return;
    state.iceRestarted = true;
    setStatus('verbinding herstellen…', 'warn');
    state.pc.createOffer({ iceRestart: true })
      .then(o => state.pc.setLocalDescription(o))
      .then(() => apiCall('rtc-signal-send', {
        type: 'offer', payload: state.pc.localDescription.sdp
      }))
      .then(() => {
        setTimeout(() => {
          if (state.pc && state.pc.connectionState !== 'connected') {
            setStatus('verbinding verbroken', 'err');
            teardown();
          }
        }, 10000);
      })
      .catch(e => { setStatus('herstel mislukt: ' + e.message, 'err'); teardown(); });
  }

  function createPeerConnection(isInitiator) {
    if (state.pc) {
      /* Handlers eerst losknippen: close() vuurt anders zelf een
       * connectionstatechange 'closed' en dat zou onze eigen opruiming als
       * "verbinding verbroken" interpreteren. */
      detachPeer(state.pc);
      try { state.pc.close(); } catch (e) { }
      state.pc = null;
    }

    state.pc = new RTCPeerConnection(RTC_CONFIG);
    state.pendingICE = [];
    state.offerSent = false;
    state.readyFired = false;

    // ICE candidate → signal send
    state.pc.onicecandidate = ev => {
      if (ev.candidate) {
        apiCall('rtc-signal-send', {
          type: 'ice',
          payload: JSON.stringify(ev.candidate)
        }).catch(e => console.warn('[pairplay] ICE send failed:', e.message));
      }
    };

    // Remote track (guest side)
    state.pc.ontrack = ev => {
      if (!state.remoteStream) {
        state.remoteStream = new MediaStream();
        const video = $('pairplayRemoteVideo');
        if (video) {
          video.srcObject = state.remoteStream;
          video.autoplay = true;
          video.playsInline = true;
          /* BUG-005: het gastbeeld hoort op de plek van het emulatorscherm,
           * niet onderaan de pagina — anders kijkt de gast naar zijn eigen
           * (lege) canvas. Canvas verbergen, video ernaast zetten. */
          const canvas = $('screen');
          if (canvas && canvas.parentNode) {
            canvas.style.display = 'none';
            canvas.parentNode.insertBefore(video, canvas);
            video.style.cssText =
              'display:block;margin:0 auto;image-rendering:pixelated;' +
              'border:2px solid var(--canvas-border);border-radius:6px;' +
              'background:var(--canvas-bg);width:' + canvas.style.width + ';max-width:100%';
          } else {
            video.style.display = 'block';
          }
          video.play().catch(() => { });
        }
      }
      ev.streams[0].getTracks().forEach(t => {
        state.remoteStream.addTrack(t);
      });
      setStatus('stream ontvangen van host', 'ok');
    };

    // Connection state changes
    state.pc.onconnectionstatechange = () => {
      if (!state.pc) return;
      const st = state.pc.connectionState;
      if (st === 'disconnected') {
        /* BUG-010: 'disconnected' is TIJDELIJK. Bij het starten van een spel
         * piekt de CPU (emulator 50 Hz + video-encoder + audio) en meldt WebRTC
         * even 'disconnected'; dat werd hiervoor als definitief einde behandeld,
         * waardoor de gast afbrak en zijn eigen (zwarte) canvas terugkreeg.
         * Nu: herstelperiode van 8 s, beeld blijft staan. */
        setStatus('verbinding hapert — even geduld…', 'warn');
        scheduleGrace();
      } else if (st === 'failed' || st === 'closed') {
        clearGrace();
        if (state.mode === 'host') {
          rearmHost('gast verbroken — sessie blijft actief');
        } else if (st === 'failed' && !state.iceRestarted) {
          tryIceRestart();
        } else {
          setStatus('verbinding verbroken', 'err');
          teardown();
        }
      } else if (st === 'connected') {
        clearGrace();
        state.iceRestarted = false;
        if (state.mode === 'host') {
          setStatus('gast verbonden — gast is speler 2', 'ok');
          /* Schone start voor beide spelers zodra de sessie staat. */
          if (!state.readyFired && typeof onPairSessionReady === 'function') {
            state.readyFired = true;
            setTimeout(() => { try { onPairSessionReady(); } catch (e) { console.warn(e); } }, 300);
          }
        } else {
          setStatus('verbonden — jij bent speler 2 (WASD of pijltjes)', 'ok');
          state.readyFired = true;
        }
      }
    };

    // DataChannel (input, host-initiated voor guest)
    if (isInitiator) {
      state.dataChannel = state.pc.createDataChannel('input', { ordered: true });
      setupDataChannel();
    } else {
      state.pc.ondatachannel = ev => {
        state.dataChannel = ev.channel;
        setupDataChannel();
      };
    }

    return state.pc;
  }

  function setupDataChannel() {
    if (!state.dataChannel) return;

    state.dataChannel.onopen = () => {
      console.log('[pairplay] DataChannel open');
      setStatus('DataChannel actief', 'ok');
    };

    state.dataChannel.onclose = () => {
      console.log('[pairplay] DataChannel closed');
      // Failsafe: reset peer-input mask (host: speler 2 los laten)
      if (state.mode === 'host' && typeof S !== 'undefined') {
        S.joyPeer[1] = 0;
        if (typeof pushJoy !== 'undefined') pushJoy(1);
      }
      state.dataChannel = null;
    };

    state.dataChannel.onmessage = ev => {
      // Host ontvangt guest-input op DataChannel (speler 2)
      if (state.mode === 'host' && typeof S !== 'undefined') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'input' && typeof msg.mask === 'number') {
            // Voer guest-input in als speler 2 via joyPeer
            S.joyPeer[1] = msg.mask;
            if (typeof pushJoy !== 'undefined') pushJoy(1);
          }
        } catch (e) {
          console.warn('[pairplay] DataChannel parse error:', e);
        }
      }
    };

    state.dataChannel.onerror = ev => {
      console.error('[pairplay] DataChannel error:', ev.error);
    };
  }

  function startSignalPoll() {
    if (state.pollTimer) return;

    const token = state.hostToken || state.guestToken;
    if (!token) return;

    state.pollTimer = setInterval(() => {
      apiCall('rtc-signal-poll', {})
        .then(data => handleSignals(data.signals || []))
        .catch(e => console.warn('[pairplay] signal poll error:', e.message));
    }, SIGNAL_POLL_MS);
  }

  function stopSignalPoll() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function handleSignals(signals) {
    if (!state.pc) return;

    signals.forEach(sig => {
      try {
        if (sig.type === 'offer' || sig.type === 'answer') {
          const desc = new RTCSessionDescription({
            type: sig.type,
            sdp: sig.payload
          });
          state.pc.setRemoteDescription(desc)
            .then(() => {
              /* gequeuede ICE-kandidaten alsnog toevoegen (BUG-006) */
              const q = state.pendingICE.splice(0, state.pendingICE.length);
              q.forEach(c => state.pc.addIceCandidate(c)
                .catch(e => console.warn('[pairplay] ICE (queue) afgewezen:', e.message)));
            })
            .then(() => {
              if (sig.type === 'offer' && state.mode === 'host') {
                // Host ontvangt offer van guest → send answer
                return state.pc.createAnswer().then(ans => state.pc.setLocalDescription(ans));
              }
            })
            .then(() => {
              if (sig.type === 'offer' && state.mode === 'host') {
                apiCall('rtc-signal-send', {
                  type: 'answer',
                  payload: state.pc.localDescription.sdp
                }).catch(e => console.warn('[pairplay] answer send failed:', e.message));
              }
            })
            .catch(e => console.error('[pairplay] SDP error:', e));
        } else if (sig.type === 'ice') {
          /* BUG-006: kandidaten die vóór de remote description binnenkomen
           * werden weggegooid; nu queuen en na setRemoteDescription flushen. */
          const cand = new RTCIceCandidate(JSON.parse(sig.payload));
          if (!state.pc.remoteDescription) {
            state.pendingICE.push(cand);
          } else {
            state.pc.addIceCandidate(cand)
              .catch(e => console.warn('[pairplay] ICE afgewezen:', e.message));
          }
        } else if (sig.type === 'bye') {
          /* Gast stopt: voor de host is dat geen einde-sessie (zie
           * onconnectionstatechange) — de code en de telefoons blijven. */
          if (state.mode === 'host') rearmHost('gast heeft de sessie verlaten');
          else teardown();
        }
      } catch (e) {
        console.error('[pairplay] signal handling error:', e);
      }
    });
  }

  function sendInputToHost(mask) {
    if (state.dataChannel && state.dataChannel.readyState === 'open') {
      try {
        state.dataChannel.send(JSON.stringify({ type: 'input', mask }));
      } catch (e) {
        console.warn('[pairplay] input send failed:', e);
      }
    }
  }

  function setupCanvasCapture() {
    // Host: capture canvas @ 50fps + add WebAudio tap
    if (state.mode !== 'host') return;

    const canvas = $('screen');
    if (!canvas) return;

    try {
      state.localStream = canvas.captureStream(50);

      /* WebAudio-tap: extra MediaStreamDestination NAAST de gewone uitgang,
       * zodat de gast het spel ook hoort. De "Start sessie"-klik is een
       * user-gesture, dus we mogen de audioketen hier alvast opstarten. */
      try {
        if (typeof audioStart === 'function') audioStart();
        if (typeof S !== 'undefined' && S.audioCtx && S.audioNode) {
          const dest = S.audioCtx.createMediaStreamDestination();
          S.audioNode.connect(dest);          /* tap; speaker-route blijft */
          const at = dest.stream.getAudioTracks()[0];
          if (at) state.localStream.addTrack(at);
          state.audioDest = dest;
        }
      } catch (e) {
        console.warn('[pairplay] audio-tap niet beschikbaar:', e);
      }

      // Voeg canvas-stream (video) toe aan peer
      state.localStream.getTracks().forEach(track => {
        state.pc.addTrack(track, state.localStream);
      });

      console.log('[pairplay] canvas capture started (50fps)');
      setStatus('canvas capture actief', 'ok');
    } catch (e) {
      console.error('[pairplay] canvas capture failed:', e);
      setStatus('canvas capture mislukt: ' + e.message, 'err');
    }
  }

  function restoreLocalScreen() {
    const canvas = $('screen'), video = $('pairplayRemoteVideo');
    if (canvas) canvas.style.display = '';
    if (video) { video.style.display = 'none'; video.srcObject = null; }
  }

  /* Alle callbacks van een RTCPeerConnection losknippen, zodat opruimen niet als
   * een gebeurtenis terugkomt. */
  function detachPeer(pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.ondatachannel = null;
  }

  /* Alleen de WebRTC-helft afbreken; sessie, code en telefoon-joysticks blijven. */
  function closePeer() {
    restoreLocalScreen();
    if (typeof S !== 'undefined') {
      S.joyPeer[1] = 0;                       /* failsafe: speler 2 loslaten */
      if (typeof pushJoy !== 'undefined') pushJoy(1);
    }
    if (state.dataChannel) {
      try { state.dataChannel.close(); } catch (e) { }
      state.dataChannel = null;
    }
    if (state.pc) {
      detachPeer(state.pc);
      try { state.pc.close(); } catch (e) { }
      state.pc = null;
    }
    if (state.localStream) {
      state.localStream.getTracks().forEach(t => t.stop());
      state.localStream = null;
    }
    state.offerSent = false;
    state.readyFired = false;
    state.pendingICE = [];
    state.remoteStream = null;
  }

  /* Host: peer opnieuw opzetten en verder wachten op (een nieuwe) gast. De
   * sessie zelf blijft ononderbroken bestaan — telefoon-joysticks merken hier
   * niets van. */
  function rearmHost(reason) {
    if (state.mode !== 'host') return;
    closePeer();
    createPeerConnection(false);
    setupCanvasCapture();
    setStatus((reason ? reason + ' — ' : '') + 'code: ' + state.code + ' (wacht op gast…)', '');
    if (el('pairplayCodeCard')) el('pairplayCodeCard').hidden = false;
  }

  function el(id) { return document.getElementById(id); }

  /* Volledig stoppen. Voor de host betekent dat óók de serversessie opruimen
   * (pair-end): anders bleef de sessie nog tot 4 uur leven, bleven telefoons
   * input posten die niemand ophaalt, en bleef de (mogelijk op een stream of
   * screenshot zichtbare) code een geldig toegangsbewijs. */
  function teardown() {
    const wasHost = state.mode === 'host';
    const hostToken = state.hostToken;

    stopSignalPoll();
    closePeer();

    if (wasHost && hostToken) {
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pair-end', token: hostToken }),
      }).catch(() => { /* best effort: server ruimt na TTL alsnog op */ });
    }

    state.mode = null;
    state.code = null;
    state.expiresAt = 0;
    clearHostSession();
    clearGuestSession();
    setStatus('gestopt', '');

    // Zet UI terug
    if (el('pairplayCodeCard')) el('pairplayCodeCard').hidden = true;
    if (el('pairplayRemoteVideo')) el('pairplayRemoteVideo').style.display = 'none';
    if (el('pairplayBtnStop')) el('pairplayBtnStop').disabled = true;
  }

  // ----- Public API -----

  return {
    startHost: async function() {
      if (state.mode) {
        setStatus('sessie al actief', 'err');
        return;
      }

      setStatus('code genereren…', 'busy');

      try {
        const resp = await apiCall('pair-create', {});
        const { code, host_token: hostToken, expires_at: expiresAt } = resp;

        state.mode = 'host';
        state.hostToken = hostToken;
        state.code = code;
        state.expiresAt = expiresAt | 0;
        saveHostSession(code, hostToken, expiresAt);

        /* Rolverdeling (BUG-004): de GAST is offerer (vraagt media recvonly aan
         * en maakt het DataChannel); de HOST antwoordt met zijn canvas/audio-
         * tracks. Host luistert dus naar het inkomende DataChannel. */
        createPeerConnection(false);
        setupCanvasCapture();

        // Host wacht tot gast join
        setStatus('code: ' + code + ' (wacht op gast…)', 'busy');
        $('pairplayCode').textContent = code;
        $('pairplayCodeCard').hidden = false;

        /* BUG-010 (v0.4.0-Rusch): hier stond een setTimeout van 10 minuten die
         * teardown() deed als er dan nog geen WebRTC-gast verbonden was. Sinds
         * v0.4.0 is "geen gast" het HOOFDscenario — een telefoon als joystick
         * gebruikt dezelfde sessie zonder ooit een gast te worden. Die timer
         * sloopte dus na exact 10 minuten elke telefoon-joystick, zonder enig
         * signaal aan de telefoon (die 4 uur lang 200 OK bleef krijgen).
         * Nu verloopt alleen de MELDING "wacht op gast"; de sessie blijft leven
         * tot de host zelf op ⏹ Stop sessie drukt (of tot de server-TTL). */
        const waitStartedAt = Date.now();
        const checkJoin = setInterval(() => {
          if (state.mode !== 'host') { clearInterval(checkJoin); return; }
          if (state.pc && state.pc.connectionState === 'connected') {
            clearInterval(checkJoin);
            setStatus('gast verbonden — gast is speler 2', 'ok');
            return;
          }
          if (Date.now() - waitStartedAt > GUEST_WAIT_NOTICE_MS) {
            clearInterval(checkJoin);
            setStatus('code: ' + state.code +
              ' (nog geen gast — sessie blijft actief voor telefoon-joysticks)', '');
          }
        }, 2000);

        startSignalPoll();

      } catch (e) {
        state.mode = null;
        state.hostToken = null;
        setStatus('fout: ' + e.message, 'err');
      }
    },

    joinGuest: async function(codeInput) {
      if (state.mode) {
        setStatus('sessie al actief', 'err');
        return;
      }

      const code = (codeInput || '').toUpperCase().trim();
      if (!code || code.length !== 6) {
        setStatus('code moet 6 tekens zijn', 'err');
        return;
      }

      setStatus('verbinden…', 'busy');

      try {
        const resp = await apiCall('pair-join', { code });
        const { guest_token: guestToken, expires_at: expiresAt } = resp;

        state.mode = 'guest';
        state.guestToken = guestToken;
        state.hostToken = null;
        state.expiresAt = expiresAt | 0;
        saveGuestSession(guestToken, expiresAt);

        // Setup RTC — gast is offerer en maakt het DataChannel (BUG-004)
        createPeerConnection(true);

        /* Vraag expliciet om beeld + geluid van de host; zonder deze
         * recvonly-transceivers bevat de offer geen media-m-lines en kan de
         * host zijn canvas-stream nooit beantwoorden. */
        state.pc.addTransceiver('video', { direction: 'recvonly' });
        state.pc.addTransceiver('audio', { direction: 'recvonly' });

        // Guest initiates offer
        const offer = await state.pc.createOffer();
        await state.pc.setLocalDescription(offer);
        state.offerSent = true;

        await apiCall('rtc-signal-send', {
          type: 'offer',
          payload: state.pc.localDescription.sdp
        });

        setStatus('wacht op answer van host…', 'busy');
        startSignalPoll();

      } catch (e) {
        state.mode = null;
        state.guestToken = null;
        setStatus('join mislukt: ' + e.message, 'err');
      }
    },

    /* Host-sessie hervatten na een herlaad van de pagina (F5, tab-herstel).
     * Zonder dit verloor de host zijn token en stopte ctrl-poll, terwijl de
     * telefoons met een geldig token 4 uur lang bleven doorsturen — de
     * gebruiker moest dan "Start sessie" drukken, kreeg een NIEUWE code en
     * moest alle telefoons opnieuw koppelen. De opgeslagen sessie werd wél
     * weggeschreven maar nooit teruggelezen (dode code). */
    /* Verse pagina = verse sessie (gebruikerswens 27-07): een herlaadbeurt
     * hervat NIETS meer. De oude sessie wordt lokaal vergeten; de host start
     * gewoon een nieuwe met een nieuwe code. */
    restore: function() {
      localStorage.removeItem(LS_HOST_KEY);
      localStorage.removeItem(LS_GUEST_KEY);
      state.mode = null; state.hostToken = null; state.guestToken = null; state.code = null;
    },

    // Gast stuurt input naar host
    sendGuestInput: function(mask) {
      if (state.mode === 'guest') {
        sendInputToHost(mask);
      }
    },

    stop: teardown,

    getStatus: function() {
      return {
        mode: state.mode,
        code: state.code,
        /* actief = er is een sessie (met of zonder WebRTC-gast). De Stop-knop
         * hangt hieraan, niet aan `connected`: een sessie met alléén
         * telefoon-joysticks moet je ook kunnen stoppen. */
        active: state.mode !== null,
        connected: state.pc ? state.pc.connectionState === 'connected' : false,
        /* Host-token alleen als we ook echt host zijn — app.js heeft het nodig
         * om ctrl-poll te doen (telefoon-joysticks over internet). Een gast
         * krijgt hier nooit een host-token te zien (BUG-003b: een token is een
         * identiteit). */
        hostToken: state.mode === 'host' ? state.hostToken : null,
      };
    }
  };
})();
