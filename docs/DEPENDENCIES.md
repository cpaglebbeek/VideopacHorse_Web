# DEPENDENCIES.md — VideopacHorse_Web

Per eenheid: waar hangt hij van af, en — belangrijker — **wat breekt er als hij wijzigt?**
Dat tweede is waar dit document voor bedoeld is; de eerste kolom is af te lezen uit de code.

## Eenheden

| Eenheid | Hangt af van | Als dit wijzigt, breekt… |
|---|---|---|
| `web/index.html` (netplay, `/videopac/`) | `style.css`, `app.js`, `netplay.js`, `g7000.js`+`.wasm`, `games.json`, `api/` | element-id's zijn het contract met `app.js` én `netplay.js`. Hernoem je `#screen`, `#btnStart`, `#fps`, `#chkNtsc`, `#configCard`, `#gamesList` of `#ctrlStatus`, dan faalt de glue stil (geen exception, wél geen beeld). `#netCode`/`#netCodeP1`/`#netCodeP2` worden door `netplay.showCodes()` gevuld |
| `web/stream/index.html` (archief) | idem, plus `pairplay.js`, met `VPH_BASE`/`VPH_API` naar `../` | dezelfde id-afhankelijkheid. Vergeet je `window.VPH_BASE` te zetten, dan zoekt `app.js` de wasm en `games.json` onder `/stream/` en laadt er niets |
| `web/2/index.html` (doorverwijzing) | `style.css` | niets — puur een redirect. Verwijderen breekt oude links en bladwijzers naar `/videopac/2/` |
| `web/app.js` | `g7000.js` (WASM-module), DOM-id's, `VPH_BASE`/`VPH_API` | **de meest gedeelde eenheid**: raakt beide pagina's tegelijk. `pushJoy()` is het invoerknooppunt (toetsenbord, gamepad, telefoon, peer); `pushKey()` idem voor consoletoetsen. Beide hebben een netplay-tak — verwijder je die, dan gaat invoer rechtstreeks naar de core en lopen de machines uit de pas. `buildConfigPanel()` levert het configuratiepaneel voor beide pagina's |
| `web/netplay.js` | `app.js` (`S`, `crc32`, `idbGet/Put`, `gamesFetchRom`, `applyBios`, `pushBytes`, `setBadge`), `api/`, WASM-savestate-exports | levert een `pairPlay`-vormige API zodat `app.js` niet hoeft te weten welke variant draait. Wijzigt die vorm (`getStatus`, `sendGuestInput`, `restore`, `stop`), dan breken de telefoon-joysticks (`ctrlPad` leest `hostToken` daaruit) |
| `web/stream/pairplay.js` | `app.js`, `api/`, `VPH_API` | zelfde interface-contract als `netplay.js`. Gearchiveerd: alleen onderhoud, geen nieuwe functies |
| `web/style.css` | — | gedeeld door alle drie de pagina's. Een token hernoemen raakt `DESIGN_TOKENS.md` én `CFG_COLORS`/`CFG_RANGES` in `app.js`: het configuratiepaneel bindt op variabelenaam |
| `web/api/index.php` | SQLite op `/var/lib/videopac/pairing.db`, php8.3-fpm | het endpoint-contract is gedeeld met `netplay.js`, `pairplay.js`, `app.js` (`ctrlPad`) **en de Android-app** (`VideopacHorse_Joystick`, `Api.kt`). Een veldnaam wijzigen in `pair-create` of `ctrl-join` breekt een APK die al bij mensen op de telefoon staat |
| `web/games.json` | externe archive.org-URL's | `crc32` is de sleutel: `netplay.js` zoekt de cartridge van de host op CRC. Wijzigt een CRC of valt een URL weg, dan kan de gast het spel niet zelf ophalen en valt hij terug op peer-to-peer-overdracht |
| `web/g7000.{js,wasm}` | `VideopacHorse_Core` (`make wasm`) | build-artefact — nooit met de hand wijzigen. De versiestring in de wasm is bij netplay een **handshake-eis**: verschillen host en gast, dan weigert de sessie |
| `build.sh` | `../VideopacHorse_Core`, `version.json` | zet cache-busters in alle drie de pagina's. Voeg je een vierde pagina toe en vergeet je die hier, dan draait die met een oude wasm — precies wat bij netplay niet mag |
| `tests/` | `web/`, php, Playwright, ROM's via `VPH_ROMDIR` | draait tegen een wegwerpkopie met een eigen database; raakt de productie-DB nooit |

## Gedeelde afspraken die niet in code staan

| Afspraak | Wie houdt zich eraan | Gevolg bij afwijking |
|---|---|---|
| Joystick-mask = 5 bits, bit0=UP … bit4=FIRE | `app.js`, `netplay.js`, `api/index.php`, Android-app, `g7000.h` (`G7K_JOY_*`) | invoer komt op de verkeerde richting uit; geen foutmelding |
| Code = 6 tekens uit `A-Z2-9` | `api/`, beide pagina's, Android-app | een geldige code wordt geweigerd door de invoervalidatie |
| Slot 0 = speler 1, slot 1 = speler 2; `owner` = host of guest | `api/`, `ctrlPad`, Android-app | telefoon bestuurt de verkeerde speler, of de invoer komt aan de verkeerde kant binnen |
| Lock-step versienummer | alle 6 repo's + `g7000.h` + de gedeployde wasm | netplay-handshake weigert; APK meldt een andere versie dan de release |

## Externe afhankelijkheden

| Extern | Gebruikt door | Faalt hij, dan… |
|---|---|---|
| `stun.l.google.com` / `stun1` | WebRTC in beide varianten | komt de P2P-verbinding niet tot stand. Er is **geen TURN**: achter symmetrische NAT werkt samen spelen niet. Gemeten faalgeval: 1 op 5 lokale testruns |
| `archive.org/cors/…` | GAMES-lijst, BIOS-knop, netplay-assets | kan de gast de cartridge niet zelf ophalen; netplay valt terug op peer-to-peer met melding |
| php8.3-fpm + SQLite op HC55 | pairing/signaling | geen nieuwe sessies; lopende WebRTC-verbindingen blijven werken (P2P) |

**Let op bij een API-deploy:** php-fpm draait met `opcache.enable=On` en
`opcache.revalidate_freq=2`. De eerste seconden ná een `rsync` van `api/index.php` kan dus
nog de oude code draaien. Bij v0.6.0 gaf dat een verwarrende meting: de tests waren groen
(nieuwe code, nieuwe kolommen) terwijl een `PRAGMA table_info` vlak na de deploy nog het
oude schema toonde. Onschadelijk omdat de migratie idempotent is en alsnog draait, maar
controleer een schemawijziging pas een paar seconden ná de deploy — of forceer met
`systemctl reload php8.3-fpm`.
