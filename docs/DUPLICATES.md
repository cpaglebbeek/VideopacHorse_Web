# DUPLICATES.md — VideopacHorse_Web

Register van bewuste duplicatie. Regel: geen duplicaat tenzij (1) er een expliciete reden is,
(2) die aan cpaglebbeek gemeld is en (3) hij ermee akkoord ging. Alles zonder akkoord-datum is
**nog niet goedgekeurd** en staat hier om die beslissing af te dwingen, niet om hem te omzeilen.

**Meting 2026-07-28** (`jscpd --min-lines 6 --min-tokens 50`, `g7000.js` uitgesloten als
build-artefact): 7 hits, 72 van 5723 regels (1,3%). Vóór de refactor van deze ronde: 7 hits,
120 regels (2,2%) — de grootste hit van 53 regels is weggewerkt, zie DUP-001.

## DUP-001 — configuratiepaneel · OPGELOST, niet geregistreerd

| Veld | Waarde |
|---|---|
| was | `web/index.html:120-172` ↔ `web/stream/index.html:122-174` (53 regels) + 3 kleinere blokken |
| status | **weggerefactord in v0.5.1** — geen registratie nodig |
| hoe | `buildConfigPanel()` in `web/app.js` bouwt het paneel op uit `CFG_COLORS` / `CFG_RANGES` / `CFG_FONTS`; beide pagina's houden alleen `<details id="configCard"></details>` over |
| winst | een instelling toevoegen is nu één regel in `app.js` en verschijnt op beide pagina's; bijvangst: `--btn-primary-text` was in het handmatige paneel vergeten en is nu meegenomen (dekking 16/16) |

## DUP-002 — transactie-boilerplate in de API · OPGELOST, niet geregistreerd

| Veld | Waarde |
|---|---|
| was | `web/api/index.php:448-459` ↔ `:639-650` (12 regels) — identiek `BEGIN IMMEDIATE` + try/catch/ROLLBACK in `pair-join` en `ctrl-join` |
| status | **weggerefactord in v0.5.1** naar `inImmediateTransaction()` |
| restant | 8 regels (`:466-473` ↔ `:648-655`) blijven over: de afsluitende `if (isset($res['err'])) fail(...)` + `ok(...)` per endpoint. Zie DUP-003 |

## DUP-003 — afhandeling van endpoint-resultaten · ⚠ akkoord gevraagd

| Veld | Waarde |
|---|---|
| id | DUP-003 |
| bestand-A | `web/api/index.php:466-473` (`pair-join`) |
| bestand-B | `web/api/index.php:648-655` (`ctrl-join`) |
| regels | 8 |
| similarity | ~85% |
| reden | Het patroon "fout uit de transactie → `fail()`, anders `ok()` met endpoint-eigen velden" is per endpoint nét anders (`guest_token` vs `ctrl_token`+`slot`). Abstraheren zou een callback-voor-de-succesvorm vereisen en maakt het antwoordcontract indirect — precies het deel dat je bij een API het snelst wilt kunnen lézen |
| alternatief-overwogen | Een `respondOrFail($res, callable $shape)`-helper. Kost meer leesbaarheid dan hij oplevert bij twee gevallen |
| akkoord-door | — |
| akkoord-datum | — |
| review-vervaldatum | bij een derde endpoint met ditzelfde patroon opnieuw wegen |

## DUP-004 — gedeelde paginastructuur netplay ↔ archief · ⚠ akkoord gevraagd

| Veld | Waarde |
|---|---|
| id | DUP-004 |
| bestand-A | `web/index.html:13-31`, `:89-107`, `:110-119`, `:120-128` |
| bestand-B | `web/stream/index.html:20-38`, `:39-57`, `:110-119`, `:122-130` |
| regels | 57 verdeeld over 4 blokken |
| similarity | ~90% |
| wat | emulatorkaart (canvas + knoppenrij + consoletoetsenbord), bestandenkaart (BIOS/ROM-pickers), GAMES-kaart, footer |
| reden | Beide pagina's tónen dezelfde bouwstenen, maar met eigen teksten, eigen volgorde en een eigen kaart ertussen (netplay-paneel vs pairplay-paneel). De element-id's zijn bovendien het contract met `app.js`; die generen betekent dat je het contract niet meer in de pagina kunt lézen. Het archief is bevroren — het is de kant die *niet* meer meebeweegt, dus de klassieke drift-vrees speelt hier minder |
| alternatief-overwogen | Kaarten genereren vanuit `app.js` zoals het configuratiepaneel. Afgewogen en niet gedaan: bij het configuratiepaneel is de inhoud pure data (tokenlijst), hier is het inhoudelijke tekst per pagina. Een template-engine of build-stap zou een bouwstap toevoegen aan een repo die bewust volledig statisch is (zie `docs/PRINCIPLES.md` P-1) |
| akkoord-door | — |
| akkoord-datum | — |
| review-vervaldatum | zodra `/videopac/stream/` wordt opgeruimd (staat in ACTIONS) vervalt deze duplicatie vanzelf |

## DUP-005 — WASM-cwrap-binding · ⚠ akkoord gevraagd

| Veld | Waarde |
|---|---|
| id | DUP-005 |
| bestand-A | `web/app.js:298-304` |
| bestand-B | `web/netplay.js:368-373` |
| regels | 7 |
| similarity | ~85% |
| wat | `cwrap`-aanroepen: `app.js` bindt de speel-API, `netplay.js` bindt daarnaast `g7k_state_size/_save/_load` |
| reden | `app.js` heeft de savestate-functies niet nodig en `netplay.js` mag `S.api` niet uitbreiden (dat zou de streamversie beïnvloeden). De overeenkomst is de vórm van een `cwrap`-aanroep, niet gedeelde logica |
| alternatief-overwogen | De savestate-cwraps aan `S.api` toevoegen in `app.js`. Verworpen: dan draagt de gearchiveerde pagina code mee die zij nooit gebruikt |
| akkoord-door | — |
| akkoord-datum | — |

## DUP-006 — blob-verzending in netplay · ⚠ akkoord gevraagd

| Veld | Waarde |
|---|---|
| id | DUP-006 |
| bestand-A | `web/netplay.js:592-598` |
| bestand-B | `web/netplay.js:707-711` |
| regels | 7 |
| similarity | ~80% |
| wat | het klaarzetten en versturen van respectievelijk een asset-blob en een savestate-blob |
| reden | Kandidaat voor echte samenvoeging — beide roepen al `sendBlob()` aan; wat overblijft is het ophalen van de bytes. Dit is de enige hit in dit register die vermoedelijk beter wél wordt opgeruimd |
| alternatief-overwogen | Samenvoegen tot één `sendAsset(kind)`-functie |
| akkoord-door | — |
| akkoord-datum | — |
| voorstel | opruimen bij de eerstvolgende wijziging in `netplay.js` |
