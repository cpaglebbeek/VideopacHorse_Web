# DESIGN_TOKENS.md — VideopacHorse_Web

Config-laag: `<details id="configCard">` in `web/index.html`; bindings via `data-cssvar`;
persistentie in `localStorage` onder sleutel **`videopachorse.cfg.v1`**; knoppen
Exporteer/Importeer (.json-roundtrip) en Reset (removeItem + defaults). Thema's via
`:root[data-theme="dark|light"]`.

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
