# CLAUDE.md — VideopacHorse_Web

WASM-frontend van VideopacHorse (zie `Meta_VideopacHorse/CLAUDE.md` voor familie-regels:
lock-step versies, codenaam-thema Videopac-pioniers, geen ROMs in git, WhatIf, prompts/).

Repo-specifiek:
1. **Alles statisch** — geen backend, geen cookies, geen analytics. ROMs blijven client-side (IndexedDB); dat is een productbelofte, geen detail.
2. **Core nooit hier patchen** — engine-gedrag hoort in VideopacHorse_Core; deze repo bevat alleen UI/glue. `web/g7000.{js,wasm}` zijn build-artefacten uit de Core (`./build.sh`), niet met de hand wijzigen.
3. **Deploy HC55** = gedeelde infra: `/var/www/videopac/` + snippet `videopac-locations.conf`, backup vóór nginx-wijziging, all-location-blocks-verify (SHARED_INFRASTRUCTURE.md).
4. Browser-doelen: recente Chrome/Firefox/Safari, incl. Steam Deck-browser en Android-Chrome (touch-controls).
