#!/bin/zsh
# build.sh — bouwt de WASM-core en kopieert artefacten naar web/
set -e
core_dir="$(dirname "$0")/../VideopacHorse_Core"
make -C "$core_dir" wasm
cp "$core_dir/build/wasm/g7000.js" "$core_dir/build/wasm/g7000.wasm" "$(dirname "$0")/web/"
echo "OK: web/g7000.js + web/g7000.wasm bijgewerkt ($(date +%F))"
