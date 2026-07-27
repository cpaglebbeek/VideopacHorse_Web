# CLAUDE.md — VideopacHorse_Web

WASM-frontend van VideopacHorse (zie `Meta_VideopacHorse/CLAUDE.md` voor familie-regels:
lock-step versies, codenaam-thema Videopac-pioniers, geen ROMs in git, WhatIf, prompts/).

Repo-specifiek:
1. **Alles statisch** — geen backend, geen cookies, geen analytics. ROMs blijven client-side (IndexedDB); dat is een productbelofte, geen detail.
2. **Core nooit hier patchen** — engine-gedrag hoort in VideopacHorse_Core; deze repo bevat alleen UI/glue. `web/g7000.{js,wasm}` zijn build-artefacten uit de Core (`./build.sh`), niet met de hand wijzigen.
3. **Deploy HC55** = gedeelde infra: `/var/www/videopac/` + snippet `videopac-locations.conf`, backup vóór nginx-wijziging, all-location-blocks-verify (SHARED_INFRASTRUCTURE.md).
4. Browser-doelen: recente Chrome/Firefox/Safari, incl. Steam Deck-browser en Android-Chrome (touch-controls).
5. **Twee pagina's, één app.js.** `/videopac/2/` (netplay) hergebruikt `web/app.js`, `web/style.css` en de wasm één map hoger via `window.VPH_BASE`/`VPH_API`. Nooit kopiëren "omdat het even sneller is" — twee kopieën lopen gegarandeerd uit elkaar, en juist bij netplay moeten beide kanten dezelfde core draaien. `build.sh` zet de cache-buster in béide pagina's.
6. **Determinisme is heilig in `web/2/`.** Alles wat de emulatiestaat raakt (invoer, consoletoetsen, reset, regio, cartridge-wissel) moet via de lockstep en op een frame gepland worden — nooit rechtstreeks naar de core. Wijzig je daar iets, draai dan `make netcheck` in de Core én `tests/run.sh` hier.
7. **Codes horen bij rollen** (v0.5.0): gastcode → `pair-join`, joystickcode P1/P2 → `ctrl-join`. Voeg je een rol toe, geef hem een eigen code; laat endpoints nooit elkaars bezetting bewaken (zie BUG-009 en BUG-012).
