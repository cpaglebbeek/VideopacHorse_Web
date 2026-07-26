# ARCHITECTURE.md — VideopacHorse_Web

## Componenten

| Component | Bestand | Verantwoordelijkheid |
|---|---|---|
| Pagina/UI | `web/index.html` | layout, file-pickers (BIOS/ROM), status, hulp |
| App-glue | `web/app.js` | WASM-module laden, frame-loop (requestAnimationFrame), canvas-blit, WebAudio-pump, input-mapping, IndexedDB-opslag |
| Engine | `web/g7000.js` + `web/g7000.wasm` | build-artefact uit VideopacHorse_Core (`make wasm`) |
| Build | `build.sh` | core bouwen + artefacten kopiëren |

## Data-flow

file-picker → ArrayBuffer → IndexedDB (persist) → `g7k_load_bios/cart` (WASM-heap) →
per rAF-tick `g7k_run_frame` → framebuffer (HEAPU32) → `putImageData`/canvas →
`g7k_audio_read` → WebAudio ringbuffer. Input: keydown/keyup + Gamepad API →
`g7k_joystick_set`/`g7k_key_set`.

## Ontwerpbeslissingen

1. **Geen server-side component** — juridisch schoon (ROMs verlaten de browser niet) en HC55-deploy blijft triviaal statisch.
2. **rAF-gedreven met audio-klok als meester** zodra audio actief is (drift-correctie door frame te skippen/dubbelen), PAL 50Hz vs NTSC 60Hz volgt `g7k_set_region`.
3. **Zusterpad-build** (`../VideopacHorse_Core`) i.p.v. submodule — conform familie-conventie.
