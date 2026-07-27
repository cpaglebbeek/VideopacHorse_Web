# ARCHITECTURE.md — VideopacHorse_Web

## Componenten

| Component | Bestand | Verantwoordelijkheid |
|---|---|---|
| Pagina/UI | `web/index.html` | **netplay-pagina** — sinds v0.5.1 de gewone versie op `/videopac/`: layout, file-pickers (BIOS/ROM), status, hulp |
| App-glue | `web/app.js` | WASM-module laden, frame-loop (requestAnimationFrame), canvas-blit, WebAudio-pump, input-mapping, IndexedDB-opslag |
| Telefoon-joystick (internet) | `web/app.js` (module `ctrlPad`) | Host pollt `ctrl-poll` zolang hij een pairplay-sessie heeft; slot 0/1 → `S.joyCtrl[0/1]`; dubbele failsafe (`age_ms > 3000` én watchdog op de poll-route zelf) ⇒ mask 0; statusregel `#ctrlStatus` |
| Engine | `web/g7000.js` + `web/g7000.wasm` | build-artefact uit VideopacHorse_Core (`make wasm`) |
| Stijl | `web/style.css` | gedeeld door beide pagina's; CSS-variabelen zijn het configuratiepaneel (DESIGN_TOKENS.md) |
| Netplay-module | `web/netplay.js` | lockstep-emulatie aan beide kanten i.p.v. videostream; levert dezelfde vorm als `pairPlay` zodat app.js ongewijzigd blijft |
| Archief: streamversie | `web/stream/{index.html,pairplay.js}` | de oude 🎭 Samen spelen-variant op `/videopac/stream/`; hergebruikt `../app.js` en `../g7000.*` via `window.VPH_BASE`/`VPH_API` |
| Doorverwijzing | `web/2/index.html` | `/videopac/2/` → `/videopac/`; netplay is verhuisd, maar die URL staat in docs en bladwijzers |
| Build | `build.sh` | core bouwen + artefacten kopiëren + cache-busters van BEIDE pagina's |
| Tests | `tests/run.sh` | wegwerpserver + API-suite + twee browsersuites (`tests/README.md`) |
| Architectuurplaat | `architectuur/VideopacHorse_Web_viewer.html` | standalone viewer met 5 views (Conceptueel/Logisch/Fysiek/Transacties/Journeys), animatie op de twee scenario's, ArchiMate ↔ Dragon1-switch; bron-DSL ernaast als `VideopacHorse_Web_archdsl.dsl` |
| Vastlegging | `docs/PRINCIPLES.md`, `docs/DEPENDENCIES.md`, `docs/DUPLICATES.md`, `docs/screens/`, `CHANGELOG.md` | het waarom, de oorzaak-gevolgketen, geregistreerde duplicatie, schermreferenties en de releasehistorie |

## Data-flow

file-picker → ArrayBuffer → IndexedDB (persist) → `g7k_load_bios/cart` (WASM-heap) →
per rAF-tick `g7k_run_frame` → framebuffer (HEAPU32) → `putImageData`/canvas →
`g7k_audio_read` → WebAudio ringbuffer. Input: keydown/keyup + Gamepad API →
`g7k_joystick_set`/`g7k_key_set`.

Telefoon-joystick: geen Bluetooth meer. De telefoon is een gewone HTTPS-client van
de pairing-API en koppelt met een **joystickcode**; de host haalt de maskers op met
`ctrl-poll`. Zie "Controller-protocol" hieronder.

## Drie codes per sessie (v0.5.0)

`pair-create` levert er drie, elk voor precies één plek:

| Code | Endpoint | Wie | Max |
|---|---|---|---|
| `code` (gastcode) | `pair-join` | medespeler op afstand (WebRTC) — speler 2 | 1 |
| `ctrl_code_p1` | `ctrl-join` | telefoon op speler 1, host-kant | 1 |
| `ctrl_code_p2` | `ctrl-join` | telefoon op speler 2, host-kant | 1 |
| `ctrl_code_guest` | `ctrl-join` | telefoon aan de **gast-kant** (v0.6.0) — pas uitgeleverd bij `pair-join` | 1 |

Sinds v0.6.0 hebben controllers een `owner` (`host` of `guest`) en pollt elke kant alleen
zijn eigen telefoons. Slot 1 kan daardoor twee rijen hebben — één per kant — en dat is geen
dubbele bezetting maar hetzelfde OR-model: beide dragen bij aan speler 2. De gast-joystick
werkt alleen in netplay; in de gearchiveerde streamversie draait bij de gast geen machine om
die invoer op toe te passen.

De rol zit dus in de code; de server wijst niets meer toe. Daarmee vervalt de
kruisvalidatie tussen `pair-join` en `ctrl-join` die in v0.4.0 nodig was (BUG-009):
er valt niets dubbel te bezetten. Wat overblijft is één afspraak, en die is dezelfde
als voor toetsenbord en gamepad: **bronnen op dezelfde speler worden ge-OR'd.** Gast
en telefoon-P2 sluiten elkaar niet uit maar tellen op. `guestOwnsPlayer2()` — de
functie die de gast exclusief maakte — is daarmee verdwenen.

Migratie: sessies uit v0.4.x houden lege joystickcodes en verlopen vanzelf; hun
telefoons kunnen niet opnieuw koppelen. De DB-migratie is idempotent en draait bij
het eerste verzoek na de deploy (`PRAGMA table_info` + `ALTER TABLE`).

## Netplay — /videopac/ (v0.5.0, hoofdversie sinds v0.5.1)

Samen spelen gaat sinds v0.5.1 standaard via netplay; de streamversie is gearchiveerd
op `/videopac/stream/` en krijgt geen nieuwe functies meer. Het verschil:

| | `/videopac/stream/` (archief) | `/videopac/` (nu) |
|---|---|---|
| Wie emuleert | alleen de host | **beide kanten** |
| Over de lijn | H.264-videostream + audio (~1-3 Mbit/s) | invoer per frame (~50 byte/s) |
| Beeld bij de gast | gecomprimeerde video | eigen framebuffer, scherp |
| Geluid bij de gast | stream van de host | eigen emulatie |
| Kosten van hapering | beeld schokt/blokt | beeld staat stil tot de invoer er is |

Werking: bij het verbinden stuurt de host een handshake met core-versie, regio en de
CRC's van BIOS en cartridge. De gast haalt die bestanden **zelf** op (IndexedDB-cache
of dezelfde archive.org-bron als de GAMES-lijst) — er gaan geen ROM-bytes over de
lijn, tenzij de host een bestand speelt dat nergens publiek staat; dan biedt hij het
aan met een expliciete melding in beeld.

Daarna delay-based lockstep: elke kant plant zijn invoer `delay` frames vooruit
(start 4, past zich aan de gemeten RTT aan, gaat alleen omhoog — omlaag zou invoer
plannen op een frame dat de ander al draaide). Invoer gaat over een **onbetrouwbaar**
DataChannel (`ordered:false, maxRetransmits:0`) met de laatste 10 frames als
redundantie; besturingsverkeer, savestates en hashes over een betrouwbaar kanaal.
Beide kanten rekenen speler 1 = host-bijdrage en speler 2 = host-bijdrage | gast-
bijdrage, dus een telefoon op de P2-joystickcode werkt bij de gast net zo goed door.

Onderbrekingen: browsers bevriezen `requestAnimationFrame` in een tabblad dat niet
zichtbaar is. De emulatie van die kant staat dan stil en de lockstep laat de ander
netjes meewachten — technisch precies goed, maar zonder uitleg leest een stilstaand
beeld als een vastloper. Daarom meldt elke kant zijn zichtbaarheid (`away`) en
verschijnt na 1,5 s wachten "wachten op je medespeler…". Bij terugkeer loopt het door
zonder resync: niemand is doorgelopen, dus er is niets in te halen.

Framesnelheid: de teller in beeld toont tijdens netplay de gemeten **emulatie**snelheid,
niet het aantal rAF-ticks. Die twee lopen uiteen omdat één tick meerdere frames mag
inhalen (tot `MAX_CATCHUP`, met een klem van 100 ms op de accumulator). Gemeten op HC55
met twee losse browsers: 44-49 van de 50 PAL-frames per seconde.

Desync-bewaking: elke 60 frames hasht elke kant zijn volledige savestate (FNV-1a).
De gast stuurt die naar de host; bij verschil stuurt de host zijn savestate terug en
zet de gast zichzelf bij. Bewijs dat het model klopt: `VideopacHorse_Core` heeft
`make netcheck` (`tools/g7k_netplay_check.c`) — determinisme, detectie én herstel,
getest via dezelfde API-aanroepen die de frontend doet.

**Verwijderd in v0.4.0-Rusch:** de Web-Bluetooth-route (`bleJoy`, knop
`#btnBleJoy`, statusblok `#bleStatus`, service `7a0b1000-…`). De tegenhanger
bestaat niet meer — `VideopacHorse_Joystick` 0.4.0 heeft `BleJoystickServer.kt`
en alle Bluetooth-permissies laten vallen — dus die ~200 regels waren onbereikbare
code die als levend contract gedocumenteerd stond. Bijkomend voordeel: de
telefoon-joystick werkt nu in élke browser, niet alleen Chromium.

## pairPlay — 🎭 Samen spelen (v0.3.0)

| Onderdeel | Bestand | Rol |
|---|---|---|
| Pairing/signaling-API | `web/api/index.php` | PHP 8.3 + SQLite (`/var/lib/videopac/pairing.db`, WAL, buiten webroot): `pair-create` (6-tekens code A-Z2-9) / `pair-join` / `rtc-signal-send` / `rtc-signal-poll` (poll-and-delete, anti-spam 50/doel, sessie-TTL 4 uur, getrottelde GC). Sinds v0.4.0 ook de controller-endpoints (zie hieronder). Patroon: iCt_Horse clipboard-api (eigen bouwblok). |
| WebRTC-module | `web/pairplay.js` | Host: `canvas.captureStream(50)` + WebAudio-tap (`createMediaStreamDestination` naast de speaker-route) + DataChannel "input"; gast: fullscreen `<video>` + input → DataChannel. STUN-only (Google), ICE-trickle met queue, bye/disconnect → failsafe mask 0. |
| Input-route | `web/app.js` | Gast-input (WASD/gamepad) gaat via DataChannel; host ontvangt in `S.joyPeer[1]` en OR-t mee in `pushJoy` (bronnen overschrijven elkaar nooit). |

Bij verbinden (v0.3.1): de host doet automatisch een **power-cycle** en start de emulator,
zodat beide spelers bij hetzelfde beginscherm beginnen; zolang de sessie staat is **speler 2
exclusief van de gast** (`guestOwnsPlayer2()` dempt lokale WASD/gamepad-2 op de
host) en de gast mag zowel WASD als de pijltjes gebruiken.

**Levensduur van een sessie (v0.4.0-Rusch, gewijzigd).** Een sessie is niet langer
"pairen of niets": dezelfde code koppelt telefoon-joysticks, dus een sessie **zonder**
WebRTC-gast is het hoofdscenario. Daarom:
- er is **geen automatische afbraak** meer. Na 10 minuten zonder gast verandert alleen
  de melding ("nog geen gast — sessie blijft actief voor telefoon-joysticks");
- valt de gast weg (`connectionState` failed/disconnected/closed of een `bye`), dan wordt
  alléén de WebRTC-helft opgeruimd (`closePeer`) en staat de host meteen weer klaar voor
  een nieuwe gast (`rearmHost`) — de code en de telefoons blijven ongemoeid;
- de host beëindigt de sessie zelf met **⏹ Stop sessie**. Die knop is actief zodra er een
  sessie is (`getStatus().active`), niet pas bij een verbonden gast;
- stoppen roept `pair-end` aan: de serversessie, de controllers en de signalen gaan weg.
  Zonder dat endpoint bleef de sessie tot 4 uur leven — telefoons bleven input posten die
  niemand ophaalde en de zichtbare code bleef al die tijd een geldig toegangsbewijs;
- **herladen van de hostpagina** (F5) herstelt de sessie uit `localStorage`
  (`pairPlay.restore()`), zodat gekoppelde telefoons blijven werken. Vóór v0.4.0-Rusch werd
  die sessie wél weggeschreven maar nooit teruggelezen (dode code) en moest de gebruiker
  opnieuw starten — met een nieuwe code en dus opnieuw koppelen van elke telefoon.

Beperkingen (bewust, gedocumenteerd): STUN-only (geen TURN — corporate NAT kan falen); gast-invoer is altijd speler 2; er gaat nooit ROM/BIOS over de lijn, alleen beeld/geluid/input; een gast die zijn pagina herlaadt kan niet terugkomen op dezelfde sessie (zijn gast-slot blijft geclaimd) — de host stopt en start dan opnieuw.

## Controller-protocol — telefoon-joystick over internet (API v0.4.0, bindend)

Dezelfde 6-tekens sessiecode als 🎭 Samen spelen; een telefoon (`VideopacHorse_Joystick`)
joint als **controller** en levert 5 bits per speler. Geen WebRTC, geen media — alleen HTTP
POST/JSON op `https://horsecloud55.ddns.net/videopac/api/`.

| Endpoint | Verzoek | Antwoord | Fouten |
|---|---|---|---|
| `ctrl-join` | `{action, code}` | `{ctrl_token (48 hex), slot: 0\|1, expires_at}` | `400` code verlopen/onbekend of vormfout; **`409 {"error":"maximaal 2 joysticks"}`** als beide slots bezet |
| `ctrl-input` | `{action, token, mask: 0..31}` | `{ok:true}` | `400` ongeldig mask; `401` controller onbekend/verlopen |
| `ctrl-poll` | `{action, token}` — **host-token** | `{controllers:[{slot, mask, age_ms}]}` | `401` als het token geen host-token van een levende sessie is |
| `ctrl-leave` | `{action, token}` | `{ok:true}` | — |
| `pair-join` | `{action, code}` | `{guest_token, expires_at}` | `400` code onbekend/al bezet; **`409 {"error":"speler 2 is bezet door een telefoon-joystick"}`** |
| `pair-end` | `{action, token}` — **host-token** | `{ok:true}` | `401` als het token geen host-token is |

`mask`-bits: bit0=UP bit1=DOWN bit2=LEFT bit3=RIGHT bit4=FIRE — identiek aan `G7K_JOY_*`
in `g7000.h`. De app stuurt bij **elke maskverandering**
plus een **heartbeat elke 500 ms**; de server bewaart alleen het laatste mask per controller.

**Slot-regels (server is de enige autoriteit):**
1. slot 0 = speler 1, slot 1 = speler 2; `ctrl-join` krijgt altijd het **laagste vrije** slot.
2. Bezet = bestaande `controllers`-rijen **plus** slot 1 wanneer `sessions.guest_token`
   gevuld is — een "Samen spelen"-gast *ís* speler 2 (zie `guestOwnsPlayer2()`).
   Die cap is sinds v0.4.0-Rusch **symmetrisch**: ook `pair-join` telt de controllers mee en
   weigert met `409` als slot 1 al door een telefoon bezet is (of als beide slots vol zijn).
   Maximaal 2 spelers per sessie, ongeacht de mix telefoon/gast.
3. Toewijzing gebeurt binnen `BEGIN IMMEDIATE` (SELECT bezet + INSERT in één schrijfvenster),
   zodat twee telefoons die tegelijk joinen nooit hetzelfde slot krijgen. Geverifieerd:
   6 gelijktijdige `ctrl-join`s → precies één slot 0, één slot 1, vier keer `409`.
4. `ctrl-leave` (of 60 s stilte ⇒ GC, of `pair-end`) geeft het slot vrij; de volgende join
   krijgt het weer.
5. `ctrl-join` controleert **read-only** of de code bestaat vóórdat het `BEGIN IMMEDIATE`
   opent — een willekeurige, geldig gevormde code neemt zo niet eerst het enige schrijfslot
   van de gedeelde SQLite-db om daarna alsnog `400` te krijgen.

**Dataflow:** telefoon → `ctrl-input` (UPDATE van één rij) → SQLite `controllers` →
host `ctrl-poll` → `S.joyCtrl[slot]` → `pushJoy(slot)` → OR met `joyKb|joyGp|joyPeer`
→ `g7k_joystick_set`. Een controller die uit de poll verdwijnt (leave/GC) zet zijn slot
op 0. De host pollt **alleen** zolang `pairPlay.getStatus().hostToken` bestaat — geen
verkeer als er geen sessie is.

**Cadans, eerlijk gemeten (was: "@10 Hz").** De timer vuurt 10×/s, maar er loopt nooit meer
dan één poll tegelijk (`inFlight`), dus de effectieve frequentie is `1/(RTT + 100 ms)`.
Gemeten tegen HC55: `ctrl-poll`-RTT mediaan 125 ms, p95 190 ms ⇒ **4-5 Hz**, end-to-end
telefoon→scherm ≈ 250-350 ms. Die gate blijft bewust staan: een wachtrij van polls verhoogt
de latentie juist. De oude claim "@10 Hz" in code, ARCHITECTURE en CLAUDE.md was dus
onjuist en is overal vervangen door de gemeten waarde.

**Failsafe in twee lagen** (een joystick die "ingedrukt" blijft hangen is het ergste
faalgedrag van dit subsysteem):
1. `age_ms > 3000` ⇒ die bron op 0 (telefoon stil). De marge is verhoogd van 2000 ms: die
   2 s kwam van de oude BLE-watchdog over een lokale link (~10 ms). Over internet is de
   cadans 500 ms + RTT; met een mobiele RTT van 300-500 ms komt één gemiste of ge-503'de
   heartbeat al op 1600-2000 ms — precies op de oude drempel. 3000 ms dekt één gemiste
   heartbeat plus jitter en blijft ruim onder de 60 s waarop de server het slot opruimt.
2. Faalt het **pollen zelf** (401, 503, netwerkuitval, onleesbaar antwoord), dan zet een
   watchdog na dezelfde 3000 ms **alle** controller-maskers op 0 en verschijnt de storing
   in `#ctrlStatus` ("sessie niet meer geldig", "server bezet", "geen verbinding").
   Vóór v0.4.0-Rusch werd `r.ok` niet eens gelezen: bij een storing bleef het laatst
   bekende mask staan zolang die storing duurde. Na een fout geldt bovendien een backoff
   van 1000 ms, zodat een 401 niet op 10 Hz wordt herhaald.

**Schrijf-hygiëne (BUG-007-les):** de tabel `controllers` staat in het **eenmalige**
schema-blok van `db()` (geen `CREATE TABLE` per verzoek); `ctrl-input` doet één `UPDATE`
(de tabel groeit dus niet mee met de invoerfrequentie); `ctrl-poll` schrijft niets; de
opruiming van stille controllers (>60 s) en wezen zit in de bestaande, op 60 s getrottelde
`gc()`; **álle** schrijfacties lopen via `withRetry()` — sinds v0.4.0-Rusch ook de vijf
in `gc()` zelf, die er ondanks deze claim buiten stonden (BUG-008: elke SQLITE_BUSY daar
was een ongevangen `PDOException` ⇒ HTTP 500). Die GC-schrijfacties gebruiken
`withRetry(..., $fatal: false)`: huishouding mag nooit het antwoord van een legitiem
verzoek breken, dus bij aanhoudende druk slaat de GC deze ronde over. Het GC-venster wordt
bovendien **atomair geclaimd** (`INSERT … ON CONFLICT DO UPDATE … WHERE meta.v <= cutoff`),
zodat niet elk verzoek dat tegelijk het 60 s-venster passeert het hele schrijfblok draait.
Gemeten op HC55 na de fix (95 s, 2 controllers @2 Hz + host-poll, 1085 verzoeken, inclusief
een GC-ronde): **0 × 5xx**, 1083 × `200`, 2 × `503` (0,18%) — de bedoelde begrensde terugval
uit BUG-007, functioneel onzichtbaar omdat de eerstvolgende heartbeat (500 ms) het mask
alsnog zet, ruim binnen de failsafe van 3000 ms.

**Restrisico (bewust, gedocumenteerd): de code is een bearer-credential.** Sinds v0.4.0
wordt `sessions.code` niet meer op NULL gezet (controllers hebben hem nodig), dus wie de
code ziet (stream, screenshot, meekijken) kan tot het einde van de sessie een joystick-slot
pakken en dat met heartbeats bezet houden. Er is geen tweede factor en geen rate limiting.
Geaccepteerd omdat de code alleen 5 bits joystick-invoer geeft (geen data, geen ROM's, geen
account) en de blootstelling nu begrensd is: ⏹ Stop sessie roept `pair-end` aan en maakt de
code onmiddellijk ongeldig — vóór v0.4.0-Rusch bleef hij nog tot 4 uur werken. Een host die
een ongenode joystick ziet verschijnen, stopt en start opnieuw (nieuwe code).

## Ontwerpbeslissingen

1. **Geen server-side component** — juridisch schoon (ROMs verlaten de browser niet) en HC55-deploy blijft triviaal statisch.
2. **rAF-gedreven met audio-klok als meester** zodra audio actief is (drift-correctie door frame te skippen/dubbelen), PAL 50Hz vs NTSC 60Hz volgt `g7k_set_region`.
3. **Zusterpad-build** (`../VideopacHorse_Core`) i.p.v. submodule — conform familie-conventie.
4. **Telefoon-joystick via de sessiecode, bewust géén Bluetooth en géén HID** (v0.4.0) —
   het OS mag niets met de input doen; alleen deze pagina consumeert hem. De vorige route
   (Web Bluetooth, GATT-peripheral op de telefoon) is verwijderd: hij werkte alleen in
   Chromium, vroeg Bluetooth-permissies op de telefoon en had geen tegenhanger meer in
   `VideopacHorse_Joystick` 0.4.0. Prijs van de nieuwe route: input loopt over internet
   (~250-350 ms) in plaats van lokaal, en er moet een sessie lopen.
5. **Input-compositing per speler** — toetsenbord, gamepad, peer (DataChannel) en
   internet-controller houden elk een eigen bronmask (`S.joyKb/joyGp/joyPeer/joyCtrl`);
   `pushJoy` OR't ze en geeft alleen échte veranderingen aan de core door. Zo wist de
   500 ms-heartbeat van een telefoon geen toetsenbord-input en vecht een gamepad niet per
   frame met de telefoon; een watchdog-failsafe zet alleen het eigen bron-deel op 0. Enige
   uitzondering: staat er een pairplay-sessie, dan is speler 2 exclusief van de gast
   (`guestOwnsPlayer2()`) en telt daar alleen `joyPeer[1]`.
6. **Versiebump-conventie** — elke wijziging aan `web/*` bumpt `version.json` + de
   `?v=`-cache-busters + `BUILD_V` (BUG-002: tussenliggende proxy's cachen immutable);
   `build.sh` synct de busters met `version.json`.

## Architectuurplaat

`architectuur/VideopacHorse_Web_viewer.html` — één bestand, geen externe afhankelijkheden,
werkt via `file://`. Vijf views; Transacties en Journeys hebben een afspeelbaar scenario
(▶/⏸/⏭ met snelheidsregelaar). De notatie-schakelaar wisselt tussen ArchiMate- en
Dragon1-weergave zonder het model te wijzigen; export naar `.json`, `.dsl`, `.archimate` en
`.svg` zit in de werkbalk.

Elk element verwijst naar iets dat werkelijk bestaat — een bestand, een endpoint of een
gedocumenteerde flow uit dit document. Er staat niets in dat "waarschijnlijk zo werkt".
De bron-DSL (`architectuur/VideopacHorse_Web_archdsl.dsl`, 5,2 KB) is DSL-B-compatibel:
PascalCase-types, geen `:type` op relaties.

De viewer heeft één aanpassing ten opzichte van het sjabloon: `fitViewBox()` past de viewBox
na elke render aan de getekende inhoud aan. Zonder dat viel bij de Fysiek- en
Transacties-view de halve plaat buiten beeld, omdat elke view een andere doorsnede van het
model toont en die zelden in de linkerbovenhoek ligt.
