# CHANGELOG — VideopacHorse_Web

Afgeleid uit de git-historie (release-commits). De familie draait lock-step: dezelfde versie
en codenaam staan in alle zes de repo's. Thema van de codenamen: pioniers en emulator-auteurs
rond de Videopac / Odyssey².

Voor het *waarom* achter een wijziging: `docs/BUGLIST.md` (met RCA op drie niveaus) en de
sessie-verslagen in `Meta_VideopacHorse/prompts/`.

| Versie | Codenaam | Datum | Wat |
|---|---|---|---|
| 0.0.1 | Baer | 2026-07-26 | skeleton VideopacHorse (VideopacHorse_Web) — newp 2026-07-26 |
| 0.1.0 | Averett | 2026-07-26 | WASM-bundel (44KB) + node-smoke OK; klaar voor HC55 /videopac/ |
| 0.1.1 | Palmer | 2026-07-26 | wasm-rebuild met BUG-001-fix |
| 0.1.2 | Boris | 2026-07-26 | wasm met S4-keyboard; buster ?v=0.1.2 |
| 0.2.0 | Gust | 2026-07-27 | BLE-telefoonjoystick (Web Bluetooth) + GAMES-catalogus (65 titels, No-Intro-CRC-verificatie, archive.org /cors/, IndexedDB-cache) + BIOS-laadknop arch |
| 0.3.0 | Guttenbrunner | 2026-07-27 | Samen spelen — code-pairing (PHP+SQLite API) + WebRTC canvas/audio-stream + DataChannel-input (gast = speler 2); 6 bugs gefixt (BUGLIST); clipboard-bo |
| 0.3.1 | Harrison | 2026-07-27 | sessie = auto power-cycle + speler 2 exclusief voor de gast (gast ook met pijltjes); BUG-007 SQLite-lock gefixt (throttled GC, BEGIN IMMEDIATE, retry- |
| 0.4.0 | Rusch | 2026-07-27 | telefoon koppelt via sessiecode (max 2, server-side cap), BLE verwijderd; 13 review-findings + BUG-009 (read-first poll) gefixt |
| 0.4.1 | Jopac | 2026-07-27 | versie-bump voor BUG-010/011 + UI-nazorg (verse start, badges met bron/titel, alleen actief spel gemarkeerd) |
| 0.4.2 | Magnavox | 2026-07-27 | herladen geeft ook een verse SESSIE (host-sessie wordt niet meer hervat) + versie-bump voor de UI-nazorg |
| 0.5.0 | Veiga | 2026-07-27 | drie codes per sessie + netplay-variant op /videopac/2/ |
| 0.5.1 | Kerstens | 2026-07-27 | netplay wordt de gewone versie, streamversie gearchiveerd |

## Niet-release-commits

Tussenliggende commits (bugfixes vóór een bump, doc-updates, deploys) staan in de git-historie
zelf: `git log --oneline`. Dit bestand bevat alleen de momenten waarop de hele familie
mee-bumpte, want dat is wat "een versie" hier betekent.
