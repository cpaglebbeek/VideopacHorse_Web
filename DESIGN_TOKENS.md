# DESIGN_TOKENS.md — VideopacHorse_Web

**Waar de tokens staan (v0.5.1):** alle CSS-variabelen zijn gedefinieerd in
`web/style.css` op `:root` — tot v0.4.2 stond die CSS inline in `index.html`, maar sinds er
twee pagina's zijn (`/videopac/` netplay en `/videopac/stream/` archief) is het één gedeeld
bestand. Twee kopieën zouden gegarandeerd uit elkaar lopen.

**Config-laag:** `<details id="configCard">` — een **lege container** in beide pagina's; de
inhoud wordt opgebouwd door `buildConfigPanel()` in `web/app.js` uit de tabellen
`CFG_COLORS`, `CFG_RANGES` en `CFG_FONTS`. Tot v0.5.1 stond die markup in béide pagina's
(≈100 regels duplicaat); een instelling toevoegen betekent nu één regel in `app.js` en
verschijnt automatisch op beide pagina's. Bindings via `data-cssvar`; persistentie in
`localStorage` onder sleutel **`videopachorse.cfg.v1`**; knoppen Exporteer/Importeer
(.json-roundtrip) en Reset (removeItem + defaults). Thema's via
`:root[data-theme="dark|light"]`.

**Dekking:** 16 van de 16 kleur-tokens en alle 6 maat-tokens zijn instelbaar (100%).
`--btn-primary-text` is in v0.5.1 toegevoegd aan het paneel; die ontbrak.

## Config-keys (alle via config-paneel instelbaar)

| Key (CSS-var) | Default (dark) | Scope | Type |
|---|---|---|---|
| `--accent` | `#f5a623` | globaal | color |
| `--bg` | `#14151c` | globaal | color |
| `--panel-bg` | `#1e2029` | kaarten | color |
| `--panel-border` | `#33364a` | kaarten | color |
| `--text` | `#e8e8ef` | globaal | color |
| `--text-dim` | `#9a9db3` | hulptekst | color |
| `--btn-primary` (+`--btn-primary-text`) | `#f5a623` | Start-knop | color |
| `--btn-secondary` | `#33364a` | overige knoppen | color |
| `--btn-danger` | `#c0392b` | Reset-config-knop | color |
| `--badge-ok` / `--badge-warn` / `--badge-err` | `#27ae60`/`#f39c12`/`#c0392b` | statusbadges | color |
| `--canvas-border` / `--canvas-bg` | `#33364a`/`#000000` | emulatorscherm | color |
| `--kbd-bg` | `#2a2d3d` | console-toetsenbord + kbd-chips | color |
| `--font-family` | systeem-stack | globaal | select (Systeem/Serif/Mono) |
| `--font-size` | `15px` | globaal | range 12-20 |
| `--h1-size` | `26px` | kop | range 18-40 |
| `--container-w` | `980px` | layout | range 640-1400 |
| `--card-radius` | `10px` | kaarten | range 0-24 |
| `--card-pad` | `16px` | kaarten | range 6-32 |
| `--canvas-scale` | `3` | emulatorscherm (CSS-breedte = fb-breedte × schaal) | range 1-4 |
| `theme` (géén CSS-var) | `dark` | root-attribuut | select dark/light |

**Telregel-dekking:** distinct UI-elementen = kaarten, 3 knop-rollen, 3 badge-rollen,
canvas (rand+bg), toetsenbord, tekst (2 rollen), accent, achtergrond → 15 kleur-inputs
op 15 distinct elementen = 100%.

## ctrlPad-statusblok (telefoon-joystick) — geen nieuwe tokens

De klassen `.blestatus` / `.blerow` dragen nog hun oude BLE-naam; het blok zelf is
sinds v0.4.0-Rusch uitsluitend van `#ctrlStatus` (het BLE-statusblok `#bleStatus`
is samen met de Web-Bluetooth-route verwijderd). Per gekoppelde controller één regel
"📱 Speler 1/2 →" (`--text-dim`) met een statusbadge `--badge-ok` (verbonden) of
`--badge-warn` (stil, geen heartbeat > 3 s); bij een storing op de poll-route zelf
(401/503/geen netwerk) één regel "📱 Telefoon-joystick →" met `--badge-err`.
Hergebruikt uitsluitend bestaande tokens: geen extra kleuren, geen extra config-keys —
de telregel hierboven blijft 15/15.

## Typografie

Systeem-stack default; Serif en Mono (retro) als alternatieven. Groottes via
`--font-size` (basis) en `--h1-size` (kop).

## Overige vaste tokens (niet-configureerbaar, bewust)

- `image-rendering: pixelated` op het canvas — pixel-authenticiteit is een productkeuze.
- Badge-radius 99px, knop-radius 7px — vaste micro-stijl.

## Componenten toegevoegd in v0.5.0/v0.5.1 (`web/style.css`)

| Component | Selector | Doel | Tokens |
|---|---|---|---|
| Codekaart | `.codegrid` / `.codebox` | de drie sessiecodes (gast + joystick P1/P2); code links groot, rol en uitleg rechts | `--kbd-bg`, `--text-dim`, `--card-radius` |
| Codewaarde | `.codebox .value` | de over te tikken code — monospace, 1.7em, letterspacing 3px | `--text` |
| Netplay-teller | `.netstats` | frame, invoervertraging, RTT, wachtbeurten, desyncs onder de netplay-kaart | `--text-dim`, `--text` |
| Archiefbadge | `.badge` op de `<h1>` van `/videopac/stream/` | markeert de gearchiveerde streamversie | `--badge-warn` |

`.codebox` schakelt onder 520px naar één kolom (code boven rol boven uitleg) — de enige
media-query in het bestand.

## Waar dit vandaan komt

De configuratielaag volgt de referentie-implementatie `iCt_Horse/edu/noisecanceling/index.html`
(per-element `data-cssvar`-binding, één `CFG_KEY`, export/import/reset).
