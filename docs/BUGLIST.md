# BUGLIST — VideopacHorse_Web

Conventie: kleurcode (Groen fysiek / Geel logisch / Rood conceptueel) + RCA op drie niveaus
(functioneel / technisch / architectonisch) + preventieregel. Zie `Meta_Master/templates/BUGLIST_TEMPLATE.md`.

## BUG-002 — Nieuwe engine-versie kwam niet aan bij de gebruiker (Geel, closed 2026-07-26)

- **Symptoom:** na deploy van v0.1.1 bleef de badge 0.1.0 tonen, ook in incognito.
- **RCA functioneel:** gebruiker speelde met oude, buggy engine terwijl de fix live stond.
- **RCA technisch:** `g7000.wasm` werd met `Cache-Control: immutable` geserveerd; een proxy
  op het netwerk van de gebruiker cachete het bestand — incognito omzeilt alleen de
  browsercache, niet de proxy.
- **RCA architectonisch:** deploy-keten had geen content-versioning; alleen headers.
- **Fix:** `?v=<versie>`-cache-busters op js/wasm (`locateFile`), `build.sh` synct de buster
  met `version.json`.
- **Preventie:** elke release krijgt automatisch verse URL's; nooit vertrouwen op
  cache-headers alleen bij artefacten die de gebruiker moet ontvangen.

## BUG-003 — Alle WebRTC-signalen tussen host en gast verdwenen (Geel, closed 2026-07-27)

- **Symptoom:** `rtc-signal-send` gaf `{"ok":true}`, maar de peer pollde altijd een lege lijst.
- **RCA functioneel:** pairen liep vast op "wacht op gast".
- **RCA technisch:** de GC verwijderde signalen waarvan sender/target niet in `sessions.token`
  stond; `sessions.token` bevat alleen het **host**-token, dus élk gast-signaal werd bij het
  eerstvolgende request gewist.
- **RCA architectonisch:** twee rollen (host/gast) gemodelleerd in één rij met één token-kolom.
- **Fix:** GC beschouwt `host_token` én `guest_token` als levende tokens.
- **Preventie:** bij rol-gebonden tokens altijd de volledige token-verzameling gebruiken in GC
  én lookups (zie ook BUG-003b).

## BUG-003b — Gast-token werd niet herkend (Geel, closed 2026-07-27)

- **Symptoom:** gast kreeg "sessie verlopen of onbekend" (HTTP 401) direct na join.
- **RCA technisch:** `requireSessionByToken` zocht alleen op `sessions.token`; peer-bepaling
  in `rtc-signal-send` vergeleek de rij met zichzelf (altijd "host"). Client gaf bovendien het
  host-token aan de gast mee.
- **Fix:** lookup op `token OR guest_token`; peer bepaald op basis van de **aanroeper**;
  `pair-join` geeft geen host-token meer terug en de client kiest zijn token per rol.
- **Preventie:** een token is een identiteit — nooit tokens van een andere rol uitdelen.

## BUG-004 — Geen beeld/geluid en geen DataChannel na verbinden (Geel, closed 2026-07-27)

- **RCA technisch:** de gast was offerer maar vroeg geen media aan (offer zonder m-lines) en
  de host maakte het DataChannel; daardoor konden host-tracks nooit beantwoord worden.
- **Fix:** gast = offerer met `addTransceiver('video'/'audio', recvonly)` + eigen DataChannel;
  host antwoordt met zijn canvas/audio-tracks.
- **Preventie:** rolverdeling (wie biedt aan, wie antwoordt) expliciet in ARCHITECTURE.md.

## BUG-005 — Gast keek naar zijn eigen lege scherm (Groen, closed 2026-07-27)

- **Fix:** remote `<video>` wordt op de plek van het canvas gezet (canvas verborgen), met
  herstel bij stoppen van de sessie.

## BUG-006 — Vroege ICE-kandidaten werden weggegooid (Groen, closed 2026-07-27)

- **RCA technisch:** kandidaten die vóór `setRemoteDescription` binnenkwamen faalden en
  werden alleen gelogd; verbinding kwam alleen tot stand dankzij latere kandidaten.
- **Fix:** kandidaten queuen in `pendingICE` en flushen na `setRemoteDescription`.

## BUG-007 — "database is locked" tijdens pairen (Geel, closed 2026-07-27)

- **Symptoom:** willekeurige HTTP 500's op `/videopac/api/`; gast bleef hangen op
  "wacht op answer van host…".
- **RCA functioneel:** sessies kwamen soms niet tot stand.
- **RCA technisch:** drie oorzaken bovenop elkaar — (1) GC draaide twee DELETE's bij
  *elk* verzoek terwijl beide peers 2×/s pollen; (2) `CREATE TABLE IF NOT EXISTS meta`
  stond in de GC en nam per verzoek een schrijfslot; (3) poll-and-delete draaide in een
  *deferred* transactie die pas bij de DELETE moest upgraden van lees- naar schrijfslot —
  precies het geval waarin `PRAGMA busy_timeout` niet kan wachten.
- **RCA architectonisch:** een polling-protocol op SQLite is schrijf-intensief; dat was
  niet in het ontwerp meegewogen (het clipboard-bouwblok heeft minder verkeer).
- **Fix:** GC hoogstens 1×/60 s (marker in `meta`), meta-tabel naar het eenmalige schema,
  `BEGIN IMMEDIATE` voor poll-and-delete (één DELETE i.p.v. per rij), `busy_timeout=10000`
  + `synchronous=NORMAL`, en een `withRetry()`-helper (25×40 ms) om alle schrijfacties;
  bij aanhoudende druk een nette 503 in plaats van een fatale fout.
- **Bewijs:** 90 parallelle API-calls → 0 fatale fouten (was 6 op 60).
- **Preventie:** bij poll-gebaseerde protocollen op SQLite altijd `BEGIN IMMEDIATE`,
  getrottelde GC en een retry-helper; stresstest vóór livegang.

## BUG-008 — GC kon een verzoek met HTTP 500 laten klappen (Geel, closed 2026-07-27)

- **Symptoom (latent, niet in het veld gezien):** willekeurige 500's op `/videopac/api/`
  onder gelijktijdige schrijvers, precies waar elders een nette 503 verschijnt.
- **RCA functioneel:** een telefoon-joystick of pairende gast krijgt een harde fout op een
  verzoek dat inhoudelijk correct is — en de fout komt uit huishouding, niet uit zijn actie.
- **RCA technisch:** `gc()` deed vijf schrijfacties (`INSERT meta`, 3× `DELETE`, `exec`)
  **buiten** `withRetry()`. Een SQLITE_BUSY daar was dus een ongevangen `PDOException` ⇒
  fatale PHP-fout. Dat SQLITE_BUSY echt optreedt is gemeten: 150 s spec-cadans gaf 3×
  `503` op het withRetry-plafond (1131/1170/1236 ms). Bovendien was het GC-blok niet
  geserialiseerd: élk verzoek dat het 60 s-venster tegelijk passeerde draaide het volledige
  schrijfblok.
- **RCA architectonisch:** de schrijf-hygiëne-regel uit BUG-007 stond wel in ARCHITECTURE.md
  ("alle schrijfacties lopen via `withRetry()`") maar was nergens afdwingbaar; de GC viel
  buiten het beeld omdat hij geen "endpoint" is.
- **Fix:** alle vijf schrijfacties via `withRetry(..., $fatal: false)` (huishouding mag een
  legitiem verzoek niet laten falen — bij aanhoudende druk slaat de GC de ronde over) +
  het GC-venster atomair claimen met `INSERT … ON CONFLICT DO UPDATE … WHERE meta.v <= cutoff`.
- **Bewijs:** 95 s belasting met spec-cadans (2 controllers @2 Hz + host-poll), 1085
  verzoeken inclusief een GC-ronde: 0 × 5xx, 1083 × 200, 2 × 503 (0,18%).
- **Preventie:** "alle schrijfacties via de retry-helper" telt óók voor code die geen
  endpoint is; bij een throttle-marker altijd de claim zelf atomair maken, anders is de
  throttle alleen een gemiddelde en geen garantie.

## BUG-009 — Speler 2 kon dubbel bezet raken (gast + telefoon) (Geel, closed 2026-07-27)

- **Symptoom:** met een telefoon in slot 1 gaf `pair-join` gewoon 200; daarna toonde de
  pagina "📱 Speler 2 → verbonden" en de telefoon "Verbonden", terwijl zijn invoer nergens
  aankwam. Omgekeerd kreeg een legitieme telefoon `409 "maximaal 2 joysticks"` terwijl er
  maar één joystick hing (de gast bezette slot 1).
- **RCA functioneel:** drie partijen (server, host-UI, telefoon) vertelden drie verschillende
  verhalen over wie speler 2 is; de gebruiker ziet "verbonden" en krijgt niets.
- **RCA technisch:** de cap was asymmetrisch — `ctrl-join` telde `sessions.guest_token` mee
  als bezet slot 1, maar `pair-join` deed geen enkele query op `controllers`.
- **RCA architectonisch:** "wie is speler 2" was op twee plaatsen gemodelleerd (een kolom in
  `sessions` en rijen in `controllers`) zonder één plek die de invariant bewaakt.
- **Fix:** `pair-join` draait nu in `BEGIN IMMEDIATE` en weigert met `409 "speler 2 is bezet
  door een telefoon-joystick"` als slot 1 bezet is of beide slots vol zijn. Maximaal 2
  spelers per sessie, ongeacht de mix. Client-commentaar en ARCHITECTURE.md die het
  rand-geval "accepteerden" zijn vervangen door de regel zelf.
- **Bewijs (live):** controller in slot 1 → `pair-join` = `409`; na `ctrl-leave` → `200`;
  2 controllers → `pair-join` = `409`; gast + controller slot 0 → 3e join = `409`.
- **Preventie:** een capaciteitsregel hoort aan **beide** kanten van de deur te hangen; een
  gedocumenteerd "rand-geval" dat drie componenten laat tegenspreken is een bug, geen keuze.

## BUG-010 — Telefoon-joystick viel na exact 10 minuten stil (Rood, closed 2026-07-27)

- **Symptoom:** speel je solo met de telefoon als joystick, dan reageerde de stick na tien
  minuten nergens meer op — terwijl de telefoon "Verbonden — je input gaat live naar de
  Videopac-pagina" bleef tonen en de server elke POST met `200 {"ok":true}` beantwoordde.
- **RCA functioneel:** het hoofdscenario van v0.4.0 (telefoon = joystick, zonder gast) werd
  door de sessie zelf afgebroken, zonder enig signaal aan de gebruiker.
- **RCA technisch:** `startHost()` zette een `setTimeout` van 10 min die `teardown()` deed
  als de WebRTC-`connectionState` dan niet `connected` was. Zonder gast blijft die op `new`,
  dus de timer vuurde altijd. `teardown()` zette `state.mode = null` ⇒ `ctrlPad.hostToken()`
  null ⇒ host stopte met pollen. De serversessie leefde intussen 4 uur door.
- **RCA architectonisch:** v0.3.x kende maar één reden voor een sessie ("Samen spelen"), dus
  "geen gast" = "mislukt". v0.4.0 gaf diezelfde sessie een tweede rol (telefoon-joysticks)
  zonder die aanname te herzien — een levensduur-regel die stilzwijgend van betekenis
  veranderde.
- **Fix:** de timer verloopt alleen nog de **melding**; de sessie blijft leven. Wegvallen van
  de gast ruimt alleen de WebRTC-helft op (`closePeer` + `rearmHost`). De host stopt zelf met
  ⏹ Stop sessie — die knop is nu actief zodra er een sessie is (`getStatus().active`) in
  plaats van pas bij een verbonden gast, en roept `pair-end` aan zodat ook de serversessie,
  de controllers en de code meteen verdwijnen. Een herlaad van de hostpagina herstelt de
  sessie uit `localStorage` (`pairPlay.restore()`) in plaats van de telefoons te slopen.
- **Preventie:** time-outs die iets **beëindigen** moeten benoemen wat er precies verloopt
  (hier: het wachten op een gast, niet de sessie). Krijgt een bestaand mechanisme een tweede
  gebruiker, dan is de levensduur-aanname onderdeel van de impact-check.

## BUG-011 — Stick bleef "ingedrukt" als het pollen zelf faalde (Geel, closed 2026-07-27)

- **Symptoom:** bij een netwerkhik, een `503` of een verlopen sessie bleef de laatst
  ontvangen richting aan de emulator doorgegeven — bij een 401 permanent, want dan slaagde
  geen enkele poll meer. Op het scherm bleef "verbonden" staan.
- **RCA functioneel:** het ergste faalgedrag dat een joystick kan hebben (blijven duwen)
  trad juist op bij storing, precies wanneer de speler er niets aan kan doen.
- **RCA technisch:** `ctrlPad.tick()` deed `.then(r => r.json())` zonder `r.ok` te testen en
  slikte alle fouten (`.catch(() => {})`). Bij een fout werd `apply()` niet aangeroepen,
  dus `S.joyCtrl` bleef staan. De enige failsafe (`age_ms > 2000`) leest een veld uit het
  antwoord en werkt dus alleen als de poll slaagt — geen tegenhanger van de watchdog die de
  oude BLE-route wél had.
- **RCA architectonisch:** de failsafe was gemodelleerd op de bron (telefoon stil) en niet op
  het transport (route stuk), terwijl het transport er in de nieuwe opzet bij is gekomen.
- **Fix:** HTTP-status én vorm van het antwoord worden gecontroleerd; een watchdog op de
  laatste **geslaagde** poll zet na `CTRL_STALE_MS` alle controller-maskers op 0; de storing
  komt met een eigen tekst in `#ctrlStatus` (401/503/geen verbinding) en na een fout geldt
  1000 ms backoff. `CTRL_STALE_MS` van 2000 → 3000 ms, omdat 500 ms heartbeat + mobiele RTT
  al 1600-2000 ms per gemiste heartbeat oplevert (onderbouwing in ARCHITECTURE.md).
- **Preventie:** elke failsafe die op data uit een antwoord leunt, heeft een tweede nodig die
  op het uitblijven van dat antwoord leunt; fouten nooit stil slikken in een besturingspad.

## BUG-009 — Sessie viel weg vlak na verbinden/spelkeuze (Geel, closed 2026-07-27)

- **Symptoom (melding gebruiker):** sessie tot stand gekomen, power-cycle gedraaid, spel
  gekozen met "1" → sessie verbroken. Gereproduceerd als: gast krijgt
  `503 "database bezet, probeer opnieuw"` bij `pair-join`.
- **RCA functioneel:** samen spelen brak af op willekeurige momenten.
- **RCA technisch:** `rtc-signal-poll` nam **elke 500 ms een schrijfslot**
  (`BEGIN IMMEDIATE`) ook als er niets te verwijderen was. Samen met de nieuwe
  `ctrl-poll` (4-5 Hz), de GC en een gelijktijdig joinende gast liep de
  `withRetry()`-budget (25×40 ms) af → 503 midden in de pairing-flow.
- **RCA architectonisch:** een poll-protocol is lees-zwaar; het ontwerp behandelde
  elke poll als schrijfoperatie (BUG-007 loste de lock-fatals op, niet de oorzaak).
- **Fix:** poll doet eerst een read-only telling; alleen als er signalen klaarstaan
  wordt het schrijfslot genomen. Daarmee verdwijnt ~95% van de schrijfsloten.
- **Bewijs:** drie volledige e2e-runs (verbinden → auto power-cycle → spel starten met
  "1" → 12 s doorspelen): 3/3 zonder breuk, gaststream 15 s doorlopend. Vóór de fix:
  breuk binnen 1 s.
- **Preventie:** in poll-protocollen altijd read-first; schrijfslot pas als er werk is.

## BUG-010/011 — Zwart beeld bij de gast, sessie effectief weg (Geel, closed 2026-07-27)

- **Symptoom (melding gebruiker, 2×):** vlak na het kiezen van een spel zwart beeld bij
  de gast en de sessie feitelijk verdwenen.
- **RCA — twee onafhankelijke oorzaken, beide gefixt:**
  1. **Tijdelijke hapering werd definitief einde.** `connectionState === 'disconnected'`
     werd gelijkgesteld aan `failed`/`closed` en gaf meteen `teardown()`. Bij het starten
     van een spel piekt de CPU (emulatie 50 Hz + video-encoder + audio) en meldt WebRTC
     routinematig even `disconnected`. De gast brak dan af en viel terug op zijn eigen
     lege canvas — vandaar het zwarte beeld. **Fix:** herstelperiode van 8 s met zichtbare
     status, ICE-restart bij `failed`, pas daarna opgeven; beeld blijft staan.
  2. **`database is locked` bij `pair-join` (503).** Niet door contentie: PDO-SQLite hield
     een **niet-uitgelezen SELECT-cursor** open, waardoor een schrijfactie op dezelfde
     verbinding blokkeerde — geen enkele retry hielp, want de cursor bleef het hele
     verzoek open. **Fix:** alle enkelvoudige leesacties via `fetchRow()`/`fetchVal()`,
     die de cursor sluiten. Aanvullend: poll doet read-first en gebruikt geen expliciete
     transactie meer in het hete pad.
- **RCA architectonisch:** onze eigen tests keken naar "verbonden ja/nee" op één moment;
  ze dekten een hapering-onder-belasting niet af.
- **Bewijs:** volledige e2e (verbinden → auto power-cycle → spel starten met "1" →
  doorspelen) **3/3 zonder breuk**, gaststream ~15 s doorlopend. Vóór de fix 2 van de 4.
- **Preventie:** (a) `disconnected` nooit als eindtoestand behandelen; (b) bij PDO altijd
  `closeCursor()` na een enkelvoudige fetch — vastgelegd als patroon hieronder.

## Terugkerende patronen

1. **Rol-asymmetrie in gedeelde tabellen** (BUG-003/003b/004) — host en gast delen één
   sessierij; elke query moet expliciet zeggen welke rol hij bedoelt.
2. **Artefact bereikt de gebruiker niet** (BUG-002) — content-versioning boven cache-headers.
3. **Openstaande PDO-cursor blokkeert eigen schrijfactie** (BUG-011) — na elke
   enkelvoudige `fetch()`/`fetchColumn()` de cursor sluiten; retries helpen niet.
4. **Schrijfdruk op SQLite** (BUG-007/008) — pollen vermenigvuldigt writes; throttle GC,
   neem schrijfsloten direct, maak schrijfacties herhaalbaar — en controleer of de regel
   ook geldt voor code die geen endpoint is.
4. **Aanname die van betekenis verandert** (BUG-009/010) — v0.4.0 gaf de sessie een tweede
   rol (telefoon-joysticks). Elke regel die "sessie" of "speler 2" definieert moest opnieuw
   langs: levensduur (BUG-010) en capaciteit (BUG-009) waren stilzwijgend nog v0.3.x.
5. **Failsafe alleen op de bron** (BUG-011) — bij een netwerkprotocol hoort naast "de bron
   is stil" ook "de route is stuk"; anders bevriest de laatste waarde precies bij storing.

## BUG-012 — Gast kon niet meedoen zodra er twee telefoons hingen (Rood, closed 2026-07-27)

- **Symptoom:** met twee gekoppelde telefoon-joysticks gaf `pair-join` 409 "speler 2 is
  bezet door een telefoon-joystick"; de gast stond buiten en moest wachten tot iemand
  zijn telefoon losmaakte.
- **RCA functioneel:** één code voor drie rollen. Wie hem intikte, bepaalde niet wát hij
  werd — dat besliste de server, op volgorde van binnenkomst.
- **RCA technisch:** `ctrl-join` zocht het laagste vrije slot en telde de gast mee als
  speler 2; `pair-join` moest daar spiegelbeeldig naar kijken (de BUG-009-fix). Twee
  endpoints die elkaars boekhouding moesten kennen — elke uitbreiding brak die weer.
- **RCA architectonisch:** de schaarste was kunstmatig. De console heeft twee poorten, maar
  niets dwingt af dat maar één bron per poort mag sturen; toetsenbord en gamepad deelden er
  al één zonder enig probleem (`pushJoy` OR't ze).
- **Fix (v0.5.0):** drie codes per sessie — gastcode, joystickcode P1, joystickcode P2. De
  rol volgt uit de code, dus de server wijst niets meer toe en de kruisvalidatie tussen de
  twee endpoints is vervallen. Gast en telefoon-P2 worden ge-OR'd, net als alle andere
  bronnen; `guestOwnsPlayer2()` is verwijderd.
- **Preventie:** als twee endpoints elkaars capaciteit moeten bewaken, is de sleutel te grof.
  Geef elke rol een eigen sleutel voordat je de bewaking uitbreidt.

## BUG-013 — Versie van de joystick-app liep stil uit de pas (Groen, closed 2026-07-27)

- **Symptoom:** `app/build.gradle.kts` bouwde `0.4.0-Rusch` terwijl de repo op `0.4.2-Magnavox`
  stond. Een APK zei dus iets anders dan de release waar hij bij hoorde.
- **RCA functioneel:** bij een klacht is de eerste vraag "welke versie draai je" — en dat
  antwoord was fout.
- **RCA technisch:** de versie stond hardcoded in het buildbestand, náást `version.json`.
- **RCA architectonisch:** lock-step is een familieafspraak, maar één repo las hem niet.
- **Fix:** `build.gradle.kts` leest `version.json` (`JsonSlurper`) en faalt als het veld mist.
- **Preventie:** een lock-step-versie hoort nergens tweemaal te staan; een tweede plek is
  geen kopie maar een toekomstig verschil.

## Bevindingen uit de testronde v0.5.0 (geen bugs in de app)

- **`test_M7_real_rom_vp01pl` stond sinds de start op SKIP.** Zonder `G7K_ROMDIR` slaat de
  test zichzelf stil over, en dat was altijd zo — de suite meldde 85 pass, 1 skip en zag er
  groen uit. Met de juiste ROM erbij (Videopac nr 1 "plus", 8 KB, CRC `EE3EE642`) draait hij
  wél: 86/86. Aandachtspunt voor later: de test geeft FAIL zowel bij een kapotte emulator als
  bij een verkeerd bestand met de juiste naam — die twee horen te verschillen.
- **Twee lege canvassen zijn ook "gelijk".** De eerste versie van `netplay_e2e.py` zei groen
  op twee stilstaande emulators. De test eist nu eerst beweging vóór hij gelijkheid als bewijs
  aanvaardt.
- **Gelijk op de klok is niet gelijk in de emulatie.** Host en gast lopen frames uit elkaar;
  hun canvassen op hetzelfde moment vergelijken geeft valse alarmen. De juiste maat is de
  state-hash bij hetzelfde framenummer.

## Geprobeerd en teruggedraaid — savestate sturen bij lang wachten (27-07)

Bij het verhuizen van netplay naar `/videopac/` leek het slim om de host na 2 s
wachten een savestate te laten sturen: "de ander loopt achter, zet hem bij". Gemeten
resultaat: host bleef op **frame 15** steken met 8 resyncs in 20 s.

- **RCA:** de aanname klopte niet. Wie stalt is juist de kant die niet vérder kan —
  hij wacht op invoer. De ander loopt dus vóór, en een savestate van de wachtende
  kant zet die vooruitlopende medespeler terug. Bij het opstarten (host wacht normaal
  even op een ladende gast) ging dat meteen in herhaling.
- **Werkelijk gedrag:** inhalen kost hooguit `delay` frames, want de wachtende kant
  is zélf ook gestopt. Gemeten hersteltijd na 2,5 s én na 6 s bevriezing: **0,2-0,3 s**.
- **Les:** een herstelmechanisme mag niet op een vermoeden over "wie loopt achter"
  worden gebouwd; meet eerst wat er werkelijk gebeurt. Savestates blijven voor waar ze
  voor zijn: een echte desync (ongelijke state-hash).

## Afgewogen en niet gefixt (bewust)

- **Code = bearer-credential (4 uur).** `sessions.code` blijft sinds v0.4.0 geldig omdat
  controllers hem nodig hebben; wie hem ziet kan een joystick-slot pakken. Geen tweede
  factor, geen rate limiting. Geaccepteerd: het geeft uitsluitend 5 bits joystick-invoer
  (geen data, geen ROM's, geen account). Blootstelling wel begrensd: ⏹ Stop sessie roept
  `pair-end` aan en maakt de code direct ongeldig (was: tot 4 uur). Zie ARCHITECTURE.md,
  "Restrisico".
- **Effectieve pollfrequentie 4-5 Hz i.p.v. 10 Hz.** De `inFlight`-gate blijft: parallelle
  polls zouden een wachtrij en dus méér latentie geven. Niet de code aangepast maar de
  claim: code, ARCHITECTURE.md en CLAUDE.md noemen nu de gemeten waarde.
- **Gast kan na een herlaad niet terugkeren** op dezelfde sessie (zijn `guest_token` blijft
  geclaimd). Herstellen zou WebRTC-renegotiatie op een halfdode peer vragen; de host start
  eenvoudig opnieuw. Gedocumenteerd bij "Beperkingen".
