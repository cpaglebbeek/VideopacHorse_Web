# VideopacHorse_Web

Web-frontend (WASM) van de VideopacHorse G7000-emulator.
LIVE-doel: **https://horsecloud55.ddns.net/videopac/**

- Engine: zusterrepo [VideopacHorse_Core](https://github.com/cpaglebbeek/VideopacHorse_Core) — `make wasm` levert `g7000.{js,wasm}`
- UI: statische single-page app (`web/`) — canvas + WebAudio + toetsenbord/gamepad
- Twee varianten die dezelfde `app.js` en dezelfde wasm delen:
  - `/videopac/` — 🎭 Samen spelen: de host streamt zijn scherm naar de gast
  - `/videopac/2/` — netplay: **beide kanten emuleren zelf**, alleen invoer gaat over de
    lijn (~50 byte/s). Scherper beeld, eigen geluid; hapert de lijn, dan staat het beeld
    even stil in plaats van te blokken.
- Eén sessie geeft **drie codes**: een gastcode en een joystickcode per speler. De rol zit
  in de code; bronnen op dezelfde speler tellen bij elkaar op.
- **BIOS en game-ROMs upload je zelf** via de file-picker; ze blijven in je browser
  (IndexedDB) en worden **nooit** naar de server gestuurd. Deze repo en de server
  bevatten geen ROMs.

## Bouwen

```bash
./build.sh                       # bouwt de core en kopieert naar web/ (beide pagina's)
VPH_ROMDIR=~/roms ./tests/run.sh # API-suite + twee browsersuites (tests/README.md)
```

Deploy naar HC55 volgens `Meta_Master/SHARED_INFRASTRUCTURE.md` (statisch, snippet-patroon).
