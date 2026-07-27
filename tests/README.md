# tests — VideopacHorse_Web

Drie suites, één commando:

```zsh
VPH_ROMDIR=~/pad/naar/roms ./tests/run.sh
```

`run.sh` zet een wegwerpkopie van `web/` neer met een eigen SQLite-database en start
daar `php -S` op. De productie-database (`/var/lib/videopac/pairing.db` op HC55) wordt
dus nooit aangeraakt — een test mag geen lopende sessie van iemand anders slopen.

| Suite | Bestand | Wat het bewijst |
|---|---|---|
| API | `api_test.sh` | drie codes per sessie, rol per code (gastcode ≠ joystickcode), één telefoon per plek, gast kan joinen mét twee telefoons, `pair-end` maakt alle drie de codes dood, en 6 gelijktijdige `ctrl-join`-verzoeken op dezelfde code leveren precies één winnaar |
| /videopac/ | `pairplay_e2e.py` | twee echte browsers: gast verbindt terwijl beide joystickplekken bezet zijn, en de host ziet op speler 2 de **gecombineerde** stand 24 = 8 (telefoon) \| 16 (gast) |
| /videopac/2/ | `netplay_e2e.py` | netplay tussen twee browsers: gast haalt de cartridge zélf op (CRC gelijk, niets over de lijn), consoletoets en FIRE van de host lopen mee, en de **state-hash bij hetzelfde framenummer** is aan beide kanten gelijk |

## ROM's

Staan bewust niet in deze repo. `VPH_ROMDIR` moet `o2rom.bin` (1024 B, md5
`562d5ebf…`) en `cart14.bin` bevatten — Videopac nr 14 *Gunfighter*, CRC `abe368bf`,
dezelfde bron als de GAMES-lijst. Zonder die map draait alleen de API-suite; de
browsersuites melden dat ze overgeslagen zijn (ze slagen niet stilzwijgend).

## Twee valkuilen die deze tests bewust vermijden

1. **Twee lege canvassen zijn ook "gelijk".** `netplay_e2e.py` eist eerst dat het beeld
   bij de host beweegt; pas daarna telt een gelijk resultaat als bewijs. Een emulator
   die stilstaat kan geen groen vinkje meer halen.
2. **Gelijk op de klok ≠ gelijk in de emulatie.** Host en gast mogen enkele frames uit
   elkaar lopen; hun canvassen op hetzelfde moment vergelijken geeft dus valse alarmen
   én valse zekerheid. De test vergelijkt de state-hash bij hetzelfde *framenummer*,
   uitgelezen via `netplay.debug()`.

Voor de emulatiekern zelf (determinisme, desync-detectie, savestate-herstel) is de gate
`make netcheck` in `VideopacHorse_Core`.
