# Schermreferenties — VideopacHorse_Web

Visuele referentie per scherm, gemaakt met Playwright tegen de echte pagina's (v0.5.1).
Doel, doelgroep en boodschap per scherm staan hieronder; het beeld is het bewijs dat de
beschrijving klopt.

Opnieuw maken: draai `tests/run.sh` zodat er een wegwerpserver staat, en gebruik het
screenshot-blok uit de sessie-MD (`Meta_VideopacHorse/prompts/2026-07-27_v050_*.md`).

| Bestand | Scherm | Doel | Doelgroep | Kernboodschap / CTA |
|---|---|---|---|---|
| `01_netplay_hoofdpagina.png` | `/videopac/` | de emulator draaien en samen spelen via netplay | bezoeker met een eigen BIOS-dump, of iemand die een spel uit de GAMES-lijst kiest | "Start sessie" → drie codes; jullie draaien allebei dezelfde machine |
| `02_archief_streamversie.png` | `/videopac/stream/` | de oude streamvariant beschikbaar houden om te kunnen vergelijken | wie de vorige manier van samen spelen wil zien | badge "gearchiveerd" + verwijzing naar de opvolger |
| `03_configuratiepaneel.png` | onderdeel van beide pagina's | kleuren, typografie en layout instelbaar maken; export/import/reset | iedereen die de weergave wil aanpassen | 16 kleuren, 6 maten, thema donker/licht — opgebouwd uit één bron in `app.js` |
| `04_doorverwijzing.png` | `/videopac/2/` | oude links en bladwijzers naar de netplay-variant levend houden | wie `/videopac/2/` nog heeft opgeslagen | stuurt automatisch door naar `/videopac/` |

## Wat je op `01` moet kunnen zien

- Het emulatorscherm mét een lopend spel (Gunfighter, nr 14) — niet een leeg canvas.
- De drie codes onder elkaar: gastcode, joystickcode speler 1, joystickcode speler 2, met de
  code links groot en de rol plus uitleg ernaast.
- De teller onder de knoppen: frame, invoervertraging in frames, heen-en-terugtijd,
  wachtbeurten en het aantal keer uit de pas (met herstelteller).
- Rechtsboven de badge met de core-versie — die hoort gelijk te zijn aan `version.json`.
