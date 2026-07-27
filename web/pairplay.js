/*
 * pairplay.js — VideopacHorse 🎭 Samen spelen (v0.3.0)
 *
 * WebRTC P2P multiplayer: twee bezoekers pairen via 6-tekens code.
 * Host draait emulator + streamt canvas (50fps) + WebAudio-tap naar gast.
 * Gast ontvangt stream via WebRTC, input (toetsenbord/gamepad/BLE) gaat via DataChannel
 * naar host → speler 2.
 *
 * Storage: localStorage voor sessie-tokens.
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

  let state = {
    mode: null,           // 'host' | 'guest' | null
    hostToken: null,
    guestToken: null,
    code: null,
    pc: null,             // RTCPeerConnection
    localStream: null,    // Host's canvas-stream
    remoteStream: null,   // Guest's received stream
    dataChannel: null,    // For guest input → host
    pollTimer: null,
    offerSent: false,
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

  function loadGuestSession() {
    try {
      const stored = JSON.parse(localStorage.getItem(LS_GUEST_KEY));
      if (stored && stored.guestToken) return stored;
    } catch (e) { }
    return null;
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

  function createPeerConnection(isInitiator) {
    if (state.pc) {
      try { state.pc.close(); } catch (e) { }
      state.pc = null;
    }

    state.pc = new RTCPeerConnection(RTC_CONFIG);
    state.pendingICE = [];
    state.offerSent = false;

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
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        setStatus('verbinding verbroken', 'err');
        teardown();
      } else if (st === 'connected') {
        setStatus('peer connected (P2P actief)', 'ok');
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
              if (sig.type === 'offer' && !state.offerSent) {
                // Host ontvangt offer van guest → send answer
                return state.pc.createAnswer().then(ans => state.pc.setLocalDescription(ans));
              }
            })
            .then(() => {
              if (sig.type === 'offer' && !state.offerSent) {
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
          teardown();
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

  function teardown() {
    restoreLocalScreen();
    stopSignalPoll();

    // Failsafe: reset peer-input (host: speler 2 los laten)
    if (state.mode === 'host' && typeof S !== 'undefined') {
      S.joyPeer[1] = 0;
      if (typeof pushJoy !== 'undefined') pushJoy(1);
    }

    if (state.pc) {
      try { state.pc.close(); } catch (e) { }
      state.pc = null;
    }

    if (state.localStream) {
      state.localStream.getTracks().forEach(t => t.stop());
      state.localStream = null;
    }

    if (state.dataChannel) {
      try { state.dataChannel.close(); } catch (e) { }
      state.dataChannel = null;
    }

    state.mode = null;
    state.offerSent = false;
    state.pendingICE = [];
    state.remoteStream = null;
    setStatus('gestopt', '');

    // Zet UI terug
    const el = (id) => document.getElementById(id);
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

        // Polling voor gast-join
        const checkJoin = setInterval(async () => {
          try {
            // Simpele check: fetch sessie-status (zou via API moeten, maar API geeft geen join-event)
            // Interim: vertrouw op RTCPeerConnection.connectionStateChange
            if (state.pc && state.pc.connectionState === 'connected') {
              clearInterval(checkJoin);
              setStatus('gast verbonden!', 'ok');
            }
          } catch (e) { }
        }, 2000);

        // Timeout na 10 min
        setTimeout(() => {
          clearInterval(checkJoin);
          if (state.mode === 'host' && state.pc && state.pc.connectionState !== 'connected') {
            setStatus('sessie verlopen (geen gast)', 'err');
            teardown();
          }
        }, 10 * 60 * 1000);

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
        connected: state.pc ? state.pc.connectionState === 'connected' : false,
      };
    }
  };
})();
