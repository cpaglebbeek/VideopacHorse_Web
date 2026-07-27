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

## Terugkerende patronen

1. **Rol-asymmetrie in gedeelde tabellen** (BUG-003/003b/004) — host en gast delen één
   sessierij; elke query moet expliciet zeggen welke rol hij bedoelt.
2. **Artefact bereikt de gebruiker niet** (BUG-002) — content-versioning boven cache-headers.
3. **Schrijfdruk op SQLite** (BUG-007) — pollen vermenigvuldigt writes; throttle GC,
   neem schrijfsloten direct en maak schrijfacties herhaalbaar.
