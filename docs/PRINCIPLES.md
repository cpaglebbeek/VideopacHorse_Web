# PRINCIPLES.md — VideopacHorse_Web

Ontwerp- en architectuurprincipes van deze frontend, mét het *waarom*. Elk principe is
herleidbaar naar een concrete beslissing of een fout die we een keer gemaakt hebben; er staat
hier niets dat alleen maar mooi klinkt.

## P-1 · Geen backend voor de emulator zelf

De emulator draait volledig client-side: WASM-core, canvas, WebAudio, IndexedDB. De enige
server-component is de pairing-API, en die ziet uitsluitend SDP/ICE-signalen en 5 bits
joystick-invoer.

**Waarom:** het bepaalt wat we kúnnen beloven. "Je ROM's blijven in je browser" is geen
marketingzin maar een eigenschap van de architectuur — er is domweg geen pad waarlangs ze de
server bereiken. Zou de emulatie server-side draaien, dan was die belofte onhoudbaar.

## P-2 · Deze site host of proxyt geen ROM-bytes

`games.json` bevat metadata (nummer, titel, grootte, CRC32) en een **externe** URL. De browser
haalt de ROM rechtstreeks bij archive.org op via het `/cors/`-pad, verifieert de CRC en cachet
lokaal in IndexedDB.

**Waarom:** distributie van copyrighted materiaal is een andere handeling dan ernaar verwijzen.
Eén uitzondering, sinds v0.5.0 en alleen in netplay: als de host een cartridge speelt die
nergens publiek staat, biedt hij het bestand peer-to-peer aan zijn medespeler aan — verkeer
tussen twee mensen, niet via onze server, en met een expliciete melding in beeld.

## P-3 · Engine-gedrag hoort in de Core, niet hier

`web/g7000.{js,wasm}` zijn build-artefacten uit `VideopacHorse_Core` (`./build.sh`). Ze worden
nooit met de hand aangepast. Deze repo bevat alleen UI en glue.

**Waarom:** drie frontends (web, Android, Steam Deck) delen één engine. Een fix die hier wordt
"even snel" toegepast bestaat op de andere twee platforms niet, en de volgende `build.sh`
gooit hem weg.

## P-4 · Eén bestand, één gedrag — geen tweede kopie

`/videopac/` (netplay) en `/videopac/stream/` (archief) delen `app.js`, `style.css`, de wasm,
`games.json` en de API. De archiefpagina wijst met `window.VPH_BASE`/`VPH_API` een map omhoog.
Het configuratiepaneel wordt door `app.js` opgebouwd uit `CFG_COLORS`/`CFG_RANGES`, niet in
HTML herhaald.

**Waarom:** twee kopieën lopen uit elkaar — dat is geen risico maar een kwestie van tijd. Bij
netplay is het bovendien fataal: beide kanten moeten aantoonbaar dezelfde core draaien, anders
lopen de machines uit de pas. In v0.5.1 stond het configuratiepaneel korte tijd wél dubbel
(≈100 regels); dat is weggerefactord zodra de duplicatiescan het aanwees.

## P-5 · Alles wat de emulatiestaat raakt, gaat onder netplay via de lockstep

Invoer, consoletoetsen, reset en cartridge-wissels worden ingepland op een frame en aan beide
kanten identiek uitgevoerd. Nooit rechtstreeks naar de core.

**Waarom:** determinisme is het enige dat netplay laat werken. Eén handeling die maar aan één
kant plaatsvindt, en de twee machines zijn onherstelbaar uiteen. De regiokeuze ligt daarom
tijdens een sessie vast en de reset is host-only.

## P-6 · Invoerbronnen tellen op, ze sluiten elkaar niet uit

Toetsenbord, gamepad, telefoon-joystick en de invoer van een medespeler worden per speler
ge-OR'd (`pushJoy`).

**Waarom:** dit was ooit anders — de gast bezat speler 2 exclusief en een telefoon werd
gedempt. Dat vergde kruisvalidatie tussen twee API-endpoints, en juist daar ontstond BUG-009.
De schaarste bleek kunstmatig: de console heeft twee poorten, maar niets verbiedt twee bronnen
op één poort. Toetsenbord en gamepad deelden er allang een zonder enig probleem.

## P-7 · Elke rol krijgt een eigen sleutel

Sinds v0.5.0 levert `pair-create` drie codes: gastcode, joystickcode speler 1, joystickcode
speler 2. De code bepáált de rol; de server wijst niets meer toe.

**Waarom:** zodra twee endpoints elkaars bezetting moeten bewaken, is de sleutel te grof. Dat
kostte ons BUG-009 én BUG-012. Een nieuwe rol krijgt een nieuwe code — geen extra bewaking.

## P-8 · Een failsafe hoort op de route, niet alleen op de bron

Een telefoon-joystick die stil valt, wordt losgelaten op twee manieren: `age_ms` boven de
drempel én een watchdog op de poll-route zelf.

**Waarom:** vóór v0.4.0-Rusch werd de HTTP-status niet gelezen. Bij een storing bleef de
laatst bekende stand staan — een joystick die "ingedrukt blijft hangen" is het ergste
faalgedrag dat dit ding heeft.

## P-9 · Cache-busting boven cache-headers

`build.sh` zet `?v=<versie>` op js/wasm in alle drie de pagina's, gelijk aan `version.json`.

**Waarom:** BUG-002. Een proxy in het netwerk van de gebruiker cachete de wasm als
`immutable`; incognito omzeilt de browsercache maar niet die proxy. Een verse URL is het enige
dat gegarandeerd aankomt.

## P-10 · Een stilstaand beeld moet zichzelf verklaren

Hapert netplay, dan bevriest het beeld — dat is correct gedrag (de lockstep wacht). De pagina
meldt daarom wát er aan de hand is: "wachten op je medespeler…" of "je medespeler heeft het
tabblad weggeklikt".

**Waarom:** technisch juist gedrag dat er kapot uitziet, wordt gemeld als bug. En browsers
bevriezen `requestAnimationFrame` in een onzichtbaar tabblad, dus dit gebeurt vaker dan je zou
denken.

## P-11 · Herstelmechanismen worden gemeten, niet beredeneerd

Zie `docs/BUGLIST.md`, "Geprobeerd en teruggedraaid": de host een savestate laten sturen bij
lang wachten klonk logisch en maakte het aantoonbaar slechter (herstel 8,6-9,0 s in plaats van
0,2-0,3 s).

**Waarom:** de aanname "de ander loopt achter" was precies verkeerd. Wie stalt is zelf de kant
die niet verder kan. Meet eerst wat er werkelijk gebeurt.

## P-12 · Een test die niet kan falen bewijst niets

`make netcheck` in de Core toetst determinisme én of de detectie aanslaat bij een opzettelijke
verstoring. De browsertests eisen eerst bewegend beeld voordat "host en gast tonen hetzelfde"
als bewijs telt.

**Waarom:** twee lege canvassen zijn ook gelijk. Een groen vinkje op een stilstaande emulator
is erger dan geen test, want het geeft ongegrond vertrouwen.
