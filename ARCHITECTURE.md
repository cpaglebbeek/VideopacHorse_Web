# ARCHITECTURE.md — VideopacHorse_Web

## Componenten

| Component | Bestand | Verantwoordelijkheid |
|---|---|---|
| Pagina/UI | `web/index.html` | layout, file-pickers (BIOS/ROM), status, hulp |
| App-glue | `web/app.js` | WASM-module laden, frame-loop (requestAnimationFrame), canvas-blit, WebAudio-pump, input-mapping, IndexedDB-opslag |
| BLE-joystick | `web/app.js` (module `bleJoy`) | Web Bluetooth GATT-client voor telefoon-joysticks (Android-app VideopacHorse_Joystick): notificaties parsen (9-byte payload), speler-toewijzing (localStorage `videopachorse.blejoy.v1`), statusblok, reconnect + heartbeat-failsafe |
| Engine | `web/g7000.js` + `web/g7000.wasm` | build-artefact uit VideopacHorse_Core (`make wasm`) |
| Build | `build.sh` | core bouwen + artefacten kopiëren |

## Data-flow

file-picker → ArrayBuffer → IndexedDB (persist) → `g7k_load_bios/cart` (WASM-heap) →
per rAF-tick `g7k_run_frame` → framebuffer (HEAPU32) → `putImageData`/canvas →
`g7k_audio_read` → WebAudio ringbuffer. Input: keydown/keyup + Gamepad API →
`g7k_joystick_set`/`g7k_key_set`.

BLE-joystick: telefoon adverteert service `7a0b1000-56e1-4d2a-9f0a-c0de00000001`
→ `requestDevice` (filter op service) → GATT connect → char `…c0de00000002`
(NOTIFY+READ) `startNotifications` → payload exact 9 bytes (`bleParsePayload`:
byte 0-7 apparaat-ID = SHA-256-prefix van ANDROID_ID, byte 8 joystick-bitmask ==
`G7K_JOY_*`) → speler-mapping → `pushJoy` → `g7k_joystick_set`. De UI-naam is
altijd `VPH-<laatste 4 hex van ID>`, afgeleid uit de payload (gelijk aan wat de
app op het telefoonscherm toont); de browser-chooser kan de kale OS-naam tonen —
platformbeperking van Android-advertising, zie VideopacHorse_Joystick/README.
Speler-mapping (persistent in localStorage `videopachorse.blejoy.v1`) is
botsingsvrij: de opgeslagen voorkeur geldt zolang die speler niet door een
andere actieve telefoon bezet is, anders de eerste vrije speler; zijn beide
bezet dan wordt een derde telefoon geparkeerd (input genegeerd) tot de
gebruiker wisselt. Badge-klik wisselt van speler; is de doelspeler bezet, dan
swappen beide telefoons — nooit twee bronnen op dezelfde speler. Telefoon
stuurt notify bij elke maskverandering + heartbeat elke 500 ms; >2 s stilte ⇒
BLE-mask 0 (failsafe). `gattserverdisconnected` ⇒ BLE-mask 0 + max 3
reconnect-pogingen; de notify-listener wordt max één keer per (door Chromium
per device gecacht) characteristic-object gezet (`WeakSet`), en device-lookup
loopt via een `WeakMap` — geen listener- of geheugenlek bij reconnects.

## Ontwerpbeslissingen

1. **Geen server-side component** — juridisch schoon (ROMs verlaten de browser niet) en HC55-deploy blijft triviaal statisch.
2. **rAF-gedreven met audio-klok als meester** zodra audio actief is (drift-correctie door frame te skippen/dubbelen), PAL 50Hz vs NTSC 60Hz volgt `g7k_set_region`.
3. **Zusterpad-build** (`../VideopacHorse_Core`) i.p.v. submodule — conform familie-conventie.
4. **Telefoon-joystick via Web Bluetooth, bewust géén HID** — het OS mag niets met de
   input doen; alleen deze pagina consumeert als GATT-client. Beperking: Web Bluetooth
   is Chromium-only (Chrome/Edge; niet Firefox/Safari/iOS-browsers) — de knop verschijnt
   alleen na feature-detect op `navigator.bluetooth`, anders staat een note in de hulptekst.
5. **Input-compositing per speler** — toetsenbord, gamepad en BLE-telefoon houden elk een
   eigen bronmask (`S.joyKb/joyGp/joyBle`); `pushJoy` OR't ze en geeft alleen échte
   veranderingen aan de core door. Zo wist de 500 ms-BLE-heartbeat geen toetsenbord-input
   en vecht een gamepad niet per frame met de telefoon; de watchdog-failsafe zet alleen
   het BLE-deel op 0.
6. **Chooser-naam niet oplosbaar op de webkant (geaccepteerd)** — `watchAdvertisements()`
   (om `VPH-XXXX` uit de scan-response-service-data te lezen vóór het koppelen) is
   experimenteel/vlag-afhankelijk in Chromium en wordt bewust niet gebruikt. Na verbinden
   is de identificatie wél altijd eenduidig via het payload-ID.
7. **Versiebump-conventie** — elke wijziging aan `web/*` bumpt `version.json` + de
   `?v=`-cache-busters + `BUILD_V` (BUG-002: tussenliggende proxy's cachen immutable);
   `build.sh` synct de busters met `version.json`.
