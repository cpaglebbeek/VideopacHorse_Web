#!/bin/zsh
# build.sh — bouwt de WASM-core en kopieert artefacten naar web/
set -e
core_dir="$(dirname "$0")/../VideopacHorse_Core"
web_dir="$(dirname "$0")/web"
ver=$(python3 -c "import json;print(json.load(open('$(dirname "$0")/version.json'))['version'])")
make -C "$core_dir" wasm
cp "$core_dir/build/wasm/g7000.js" "$core_dir/build/wasm/g7000.wasm" "$web_dir/"
# cache-busters gelijktrekken met version.json (proxy's cachen wasm immutable).
# Alle drie de pagina's meenemen: /videopac/ (netplay, de gewone versie),
# /videopac/stream/ (gearchiveerd) en /videopac/2/ (doorverwijzing). Vergeet je er
# een, dan draait die met een oude wasm terwijl de andere vernieuwt — en juist bij
# netplay moeten beide kanten gegarandeerd dezelfde core hebben.
sed -i '' -E "s/\?v=[0-9.]+/?v=$ver/g" \
  "$web_dir/index.html" "$web_dir/stream/index.html" "$web_dir/2/index.html"
sed -i '' -E "s/const BUILD_V = '[0-9.]+'/const BUILD_V = '$ver'/" "$web_dir/app.js"
# Documentatie renderen naar web/docs/ en de architectuurplaat publiceren. Dit is een
# build-artefact zoals de wasm: de markdown in de repo is de bron, de HTML is de leesbare
# kant ervan. Handmatig bijhouden zou een tweede kopie opleveren die uit de pas loopt.
python3 "$(dirname "$0")/tools/render_docs.py"
mkdir -p "$web_dir/architectuur"
# De viewer draagt een @VERSION@-marker; die vullen we hier in, zodat de gepubliceerde
# plaat altijd de versie toont die erbij hoort en niemand dat met de hand hoeft bij te werken.
codename=$(python3 -c "import json;d=json.load(open('$(dirname "$0")/version.json'));print(d['version']+'-'+d['codename'])")
sed "s/@VERSION@/$codename/g" "$(dirname "$0")/architectuur/VideopacHorse_Web_viewer.html" \
  > "$web_dir/architectuur/index.html"
cp "$(dirname "$0")/architectuur/VideopacHorse_Web_archdsl.dsl" "$web_dir/architectuur/"

echo "OK: web/g7000.{js,wasm} + web/docs/ + web/architectuur/ bijgewerkt, cache-buster ?v=$ver ($(date +%F))"
