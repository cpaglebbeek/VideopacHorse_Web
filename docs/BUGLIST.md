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

## Terugkerende patronen

1. **Rol-asymmetrie in gedeelde tabellen** (BUG-003/003b/004) — host en gast delen één
   sessierij; elke query moet expliciet zeggen welke rol hij bedoelt.
2. **Artefact bereikt de gebruiker niet** (BUG-002) — content-versioning boven cache-headers.
