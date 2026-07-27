#!/usr/bin/env python3
"""
render_docs.py — zet de markdown-documentatie om naar HTML onder web/docs/.

Waarom een script en geen handwerk: gerenderde HTML naast markdown is een kopie, en
kopieën lopen uit de pas (docs/PRINCIPLES.md, P-4). Door dit vanuit build.sh te draaien
is de markdown de enige bron en is de HTML een build-artefact — net als g7000.wasm.

Geen externe afhankelijkheden: een kleine markdown-omzetting die precies dekt wat deze
documenten gebruiken (koppen, tabellen, lijsten, code, links, nadruk). Pandoc zou meer
kunnen, maar dan hangt de build aan een tool die op HC55 niet staat.

De opmaak hergebruikt web/style.css, zodat de documentatie dezelfde tokens en hetzelfde
thema volgt als de emulator zelf — inclusief de licht/donker-instelling.
"""
import html
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "docs"

# (bronbestand, uitvoernaam, titel, korte omschrijving voor de index)
DOCS = [
    ("ARCHITECTURE.md", "architecture.html", "Architectuur",
     "Componenten, dataflow, de drie codes, netplay en het archief."),
    ("docs/PRINCIPLES.md", "principles.html", "Principes",
     "Twaalf ontwerpprincipes mét het waarom — elk herleidbaar naar een beslissing of een fout."),
    ("docs/DEPENDENCIES.md", "dependencies.html", "Afhankelijkheden",
     "Per onderdeel: waar hangt het van af, en vooral: wat breekt er als het wijzigt."),
    ("DESIGN_TOKENS.md", "design-tokens.html", "Ontwerp-tokens",
     "Alle kleuren, maten en componenten, en hoe het configuratiepaneel eraan gekoppeld is."),
    ("docs/BUGLIST.md", "buglist.html", "Buglijst",
     "Elke bug met oorzaakanalyse op drie niveaus en de preventieregel die eruit volgde."),
    ("docs/DUPLICATES.md", "duplicates.html", "Duplicatie-register",
     "Waar code bewust dubbel staat, waarom, en wat het alternatief zou kosten."),
    ("CHANGELOG.md", "changelog.html", "Wijzigingen",
     "Alle releases met versie, codenaam en datum."),
    ("tests/README.md", "tests.html", "Tests",
     "Drie suites, wat ze bewijzen, en twee valkuilen die ze bewust vermijden."),
    ("docs/screens/README.md", "screens.html", "Schermen",
     "Doel, doelgroep en boodschap per scherm, met visuele referentie."),
    ("README.md", "readme.html", "Overzicht",
     "Wat dit project is en hoe je het bouwt."),
]


def md_inline(text: str) -> str:
    """Inline-opmaak. Code eerst, zodat opmaak binnen backticks met rust gelaten wordt."""
    placeholders = []

    def stash(m):
        placeholders.append(html.escape(m.group(1)))
        return "\x00%d\x00" % (len(placeholders) - 1)

    text = re.sub(r"`([^`]+)`", stash, text)
    text = html.escape(text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<em>\1</em>", text)
    for i, code in enumerate(placeholders):
        text = text.replace("\x00%d\x00" % i, "<code>%s</code>" % code)
    return text


def md_to_html(md: str) -> str:
    out, lines, i = [], md.split("\n"), 0
    in_list = in_code = False

    def close_list():
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    while i < len(lines):
        line = lines[i]

        if line.startswith("```"):
            close_list()
            out.append("</pre>" if in_code else "<pre>")
            in_code = not in_code
            i += 1
            continue
        if in_code:
            out.append(html.escape(line))
            i += 1
            continue

        # tabel: kopregel + scheidingsregel + rijen
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1]):
            close_list()
            head = [c.strip() for c in line.strip("|").split("|")]
            out.append("<div class='tablewrap'><table><thead><tr>")
            out += ["<th>%s</th>" % md_inline(c) for c in head]
            out.append("</tr></thead><tbody>")
            i += 2
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip("|").split("|")]
                out.append("<tr>" + "".join("<td>%s</td>" % md_inline(c) for c in cells) + "</tr>")
                i += 1
            out.append("</tbody></table></div>")
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            close_list()
            lvl = len(m.group(1))
            out.append("<h%d>%s</h%d>" % (lvl, md_inline(m.group(2)), lvl))
            i += 1
            continue

        if re.match(r"^\s*[-*]\s+", line):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append("<li>%s</li>" % md_inline(re.sub(r"^\s*[-*]\s+", "", line)))
            i += 1
            continue

        if line.startswith(">"):
            close_list()
            out.append("<blockquote>%s</blockquote>" % md_inline(line.lstrip("> ")))
            i += 1
            continue

        if not line.strip():
            close_list()
            i += 1
            continue

        close_list()
        para = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,6}\s|\||\s*[-*]\s|>|```)", lines[i]):
            para.append(lines[i])
            i += 1
        out.append("<p>%s</p>" % md_inline(" ".join(para)))

    close_list()
    return "\n".join(out)


PAGE = """<!DOCTYPE html>
<html lang="nl" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — VideopacHorse</title>
<link rel="stylesheet" href="../style.css?v={ver}">
<style>
.doc {{ max-width: 900px; margin: 0 auto; padding: 18px; }}
.doc h1 {{ font-size: var(--h1-size); border-bottom: 2px solid var(--accent); padding-bottom: 6px; }}
.doc h2 {{ margin-top: 28px; color: var(--accent); }}
.doc h3 {{ margin-top: 20px; }}
.doc table {{ border-collapse: collapse; width: 100%; font-size: .9em; }}
.doc th, .doc td {{ border: 1px solid var(--panel-border); padding: 6px 9px; text-align: left; vertical-align: top; }}
.doc th {{ background: var(--kbd-bg); }}
.doc pre {{ background: var(--kbd-bg); padding: 12px; border-radius: 6px; overflow-x: auto; }}
.doc code {{ background: var(--kbd-bg); padding: 1px 5px; border-radius: 3px; font-size: .9em; }}
.doc pre code {{ background: none; padding: 0; }}
.doc blockquote {{ border-left: 3px solid var(--accent); margin: 12px 0; padding: 4px 14px; color: var(--text-dim); }}
.doc .tablewrap {{ overflow-x: auto; }}
.doc .nav {{ margin-bottom: 18px; font-size: .9em; }}
.doc img {{ max-width: 100%; border-radius: 6px; border: 1px solid var(--panel-border); }}
</style>
</head>
<body>
<div class="doc">
  <p class="nav"><a href="./">📚 Documentatie</a> · <a href="../">🕹 Emulator</a>
     · <a href="../architectuur/">🗺 Architectuurplaat</a></p>
{body}
  <footer style="margin-top:32px">
    VideopacHorse v{ver} · AGPL-3.0 ·
    <a href="https://github.com/cpaglebbeek/VideopacHorse_Web">broncode</a> ·
    gegenereerd uit <code>{src}</code> door <code>tools/render_docs.py</code>
  </footer>
</div>
</body>
</html>
"""

INDEX_BODY = """<h1>Documentatie</h1>
<p>Alles wat over deze emulator is vastgelegd: waarom hij zo in elkaar zit, waar de
onderdelen van afhangen, welke fouten we gemaakt hebben en wat daaruit volgde. Deze
pagina's zijn gegenereerd uit de markdown in de repository — de repo is de bron, dit is
de leesbare kant ervan.</p>
<div class="tablewrap"><table><thead><tr><th>Document</th><th>Waarover</th></tr></thead><tbody>
{rows}
</tbody></table></div>
<h2>Architectuurplaat</h2>
<p><a href="../architectuur/"><strong>Interactieve viewer</strong></a> — vijf gezichtspunten
(conceptueel, logisch, fysiek, transacties, journeys), met afspeelbare scenario's voor het
opzetten van netplay en de weg die host en gast door de schermen afleggen. Wisselbaar tussen
ArchiMate- en Dragon1-notatie; export naar JSON, DSL, .archimate en SVG.</p>
<h2>Schermen</h2>
<p>{screens}</p>
"""


def main() -> int:
    import json
    ver = json.loads((ROOT / "version.json").read_text())["version"]
    OUT.mkdir(parents=True, exist_ok=True)

    made = []
    for src, dest, title, blurb in DOCS:
        p = ROOT / src
        if not p.exists():
            print("  overgeslagen (bestaat niet): %s" % src)
            continue
        body = md_to_html(p.read_text(encoding="utf-8"))
        # verwijzingen tussen documenten laten wijzen naar de gerenderde versies
        for s2, d2, _, _ in DOCS:
            body = body.replace('href="%s"' % s2, 'href="%s"' % d2)
            body = body.replace('href="%s"' % pathlib.Path(s2).name, 'href="%s"' % d2)
        body = body.replace('href="docs/screens/', 'href="../../docs/screens/')
        (OUT / dest).write_text(PAGE.format(title=title, body=body, ver=ver, src=src), encoding="utf-8")
        made.append((dest, title, blurb))
        print("  %-26s -> web/docs/%s" % (src, dest))

    rows = "\n".join(
        '<tr><td><a href="%s"><strong>%s</strong></a></td><td>%s</td></tr>' % (d, t, b)
        for d, t, b in made)
    shots = sorted((ROOT / "docs" / "screens").glob("*.png"))
    screens = " · ".join('<a href="screens/%s">%s</a>' % (s.name, s.stem.replace("_", " ")) for s in shots)
    idx = PAGE.format(title="Documentatie",
                      body=INDEX_BODY.format(rows=rows, screens=screens or "geen"),
                      ver=ver, src="docs/*.md")
    (OUT / "index.html").write_text(idx, encoding="utf-8")
    print("  index                      -> web/docs/index.html (%d documenten)" % len(made))

    # schermafbeeldingen meenemen zodat de verwijzingen werken
    shots_out = OUT / "screens"
    shots_out.mkdir(exist_ok=True)
    for s in shots:
        shots_out.joinpath(s.name).write_bytes(s.read_bytes())
    print("  %d schermafbeeldingen gekopieerd" % len(shots))
    return 0


if __name__ == "__main__":
    sys.exit(main())
