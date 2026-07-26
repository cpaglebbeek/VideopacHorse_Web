# VideopacHorse_Web

Web-frontend (WASM) van de VideopacHorse G7000-emulator.
LIVE-doel: **https://horsecloud55.ddns.net/videopac/**

- Engine: zusterrepo [VideopacHorse_Core](https://github.com/cpaglebbeek/VideopacHorse_Core) — `make wasm` levert `g7000.{js,wasm}`
- UI: statische single-page app (`web/`) — canvas + WebAudio + toetsenbord/gamepad
- **BIOS en game-ROMs upload je zelf** via de file-picker; ze blijven in je browser
  (IndexedDB) en worden **nooit** naar de server gestuurd. Deze repo en de server
  bevatten geen ROMs.

## Bouwen

```bash
./build.sh   # bouwt de core (make wasm in ../VideopacHorse_Core) en kopieert naar web/
```

Deploy naar HC55 volgens `Meta_Master/SHARED_INFRASTRUCTURE.md` (statisch, snippet-patroon).
