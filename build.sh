#!/bin/zsh
# build.sh — bouwt de WASM-core en kopieert artefacten naar web/
set -e
core_dir="$(dirname "$0")/../VideopacHorse_Core"
web_dir="$(dirname "$0")/web"
ver=$(python3 -c "import json;print(json.load(open('$(dirname "$0")/version.json'))['version'])")
make -C "$core_dir" wasm
cp "$core_dir/build/wasm/g7000.js" "$core_dir/build/wasm/g7000.wasm" "$web_dir/"
# cache-busters gelijktrekken met version.json (proxy's cachen wasm immutable)
sed -i '' -E "s/\?v=[0-9.]+/?v=$ver/g" "$web_dir/index.html"
sed -i '' -E "s/const BUILD_V = '[0-9.]+'/const BUILD_V = '$ver'/" "$web_dir/app.js"
echo "OK: web/g7000.{js,wasm} bijgewerkt, cache-buster ?v=$ver ($(date +%F))"
