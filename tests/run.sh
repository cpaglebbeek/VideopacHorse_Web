#!/bin/zsh
# run.sh — zet een wegwerp-testomgeving op en draait alle drie de suites.
#
# Waarom een eigen server: de API schrijft naar /var/lib/videopac/pairing.db en
# dat pad hoort bij de productie-installatie op HC55. Hier draaien we een kopie
# met een eigen database, zodat een test nooit een lopende sessie van iemand
# anders kan raken.
#
# ROM's zitten NIET in deze repo (en horen daar ook niet). Zet VPH_ROMDIR naar een
# map met je eigen o2rom.bin en cart14.bin (Videopac nr 14, CRC abe368bf), of laat
# hem leeg: dan draait alleen de API-suite.
#
#   VPH_ROMDIR=~/roms ./tests/run.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
web="$here/.."
work="${TMPDIR:-/tmp}/vph-test-$$"
port="${VPH_PORT:-8099}"

mkdir -p "$work"
cp -R "$web/web/"* "$work/"
sed -i '' "s#const DB_PATH = '/var/lib/videopac/pairing.db';#const DB_PATH = '$work/pairing.db';#" "$work/api/index.php"

php -S "127.0.0.1:$port" -t "$work" > "$work/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; rm -rf "$work"' EXIT
sleep 1

fails=0
print "\n### API-suite (drie codes, rollen, gelijktijdigheid)"
VPH_API_URL="http://127.0.0.1:$port/api/" zsh "$here/api_test.sh" || fails=$((fails+1))

if [[ -n "${VPH_ROMDIR:-}" && -f "$VPH_ROMDIR/o2rom.bin" ]]; then
  print "\n### /videopac/stream/ (gearchiveerd) — drie codes + OR-merge op speler 2"
  VPH_BASE_URL="http://127.0.0.1:$port" python3 "$here/pairplay_e2e.py" || fails=$((fails+1))
  print "\n### /videopac/ — netplay tussen twee browsers"
  VPH_BASE_URL="http://127.0.0.1:$port" python3 "$here/netplay_e2e.py" || fails=$((fails+1))
else
  print "\n(browsertests overgeslagen: zet VPH_ROMDIR naar een map met o2rom.bin + cart14.bin)"
fi

print "\n=== $fails suite(s) gefaald ==="
exit $fails
