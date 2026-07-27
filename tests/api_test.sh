#!/bin/zsh
# e2e-test v0.5.0 drie-codes-API tegen de lokale php -S
set -u
api="${VPH_API_URL:-http://127.0.0.1:8099/index.php}"
pass=0; fail=0
call() { curl -s -o /tmp/vph_body -w '%{http_code}' -H 'Content-Type: application/json' -d "$1" "$api"; }
body() { cat /tmp/vph_body; }
check() { # naam, verwacht, gekregen
  if [[ "$2" == "$3" ]]; then print "  ok   $1"; ((pass++)); else print "  FOUT $1 — verwacht '$2', kreeg '$3'"; ((fail++)); fi
}

print "== 1. pair-create geeft drie verschillende codes =="
code=$(call '{"action":"pair-create"}')
check "http 200" 200 "$code"
resp=$(body)
gast=$(print $resp | python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])')
p1=$(print $resp | python3 -c 'import sys,json;print(json.load(sys.stdin)["ctrl_code_p1"])')
p2=$(print $resp | python3 -c 'import sys,json;print(json.load(sys.stdin)["ctrl_code_p2"])')
host=$(print $resp | python3 -c 'import sys,json;print(json.load(sys.stdin)["host_token"])')
print "  gast=$gast p1=$p1 p2=$p2"
check "3 unieke codes" 3 "$(print "$gast\n$p1\n$p2" | sort -u | wc -l | tr -d ' ')"
check "lengte gastcode" 6 ${#gast}

print "== 2. joystickcode P1 geeft slot 0, P2 geeft slot 1 =="
c=$(call "{\"action\":\"ctrl-join\",\"code\":\"$p1\"}")
check "http 200 (p1)" 200 "$c"
slot1=$(body | python3 -c 'import sys,json;print(json.load(sys.stdin)["slot"])')
tok1=$(body | python3 -c 'import sys,json;print(json.load(sys.stdin)["ctrl_token"])')
check "slot van p1-code" 0 "$slot1"
c=$(call "{\"action\":\"ctrl-join\",\"code\":\"$p2\"}")
check "http 200 (p2)" 200 "$c"
slot2=$(body | python3 -c 'import sys,json;print(json.load(sys.stdin)["slot"])')
tok2=$(body | python3 -c 'import sys,json;print(json.load(sys.stdin)["ctrl_token"])')
check "slot van p2-code" 1 "$slot2"

print "== 3. tweede telefoon op dezelfde plek wordt geweigerd =="
c=$(call "{\"action\":\"ctrl-join\",\"code\":\"$p1\"}")
check "http 409 op bezette plek" 409 "$c"

print "== 4. gast kan joinen ONDANKS twee gekoppelde telefoons (kernwens) =="
c=$(call "{\"action\":\"pair-join\",\"code\":\"$gast\"}")
check "http 200 gast-join" 200 "$c"
gtok=$(body | python3 -c 'import sys,json;print(json.load(sys.stdin)["guest_token"])')

print "== 5. rollen zijn niet uitwisselbaar =="
c=$(call "{\"action\":\"pair-join\",\"code\":\"$p1\"}")
check "gast-join met joystickcode faalt" 400 "$c"
c=$(call "{\"action\":\"ctrl-join\",\"code\":\"$gast\"}")
check "ctrl-join met gastcode faalt" 400 "$c"

print "== 6. tweede gast wordt nog steeds geweigerd =="
c=$(call "{\"action\":\"pair-join\",\"code\":\"$gast\"}")
check "http 400 tweede gast" 400 "$c"

print "== 7. input + poll: host ziet beide telefoons =="
call "{\"action\":\"ctrl-input\",\"token\":\"$tok1\",\"mask\":5}" >/dev/null
call "{\"action\":\"ctrl-input\",\"token\":\"$tok2\",\"mask\":16}" >/dev/null
c=$(call "{\"action\":\"ctrl-poll\",\"token\":\"$host\"}")
check "http 200 ctrl-poll" 200 "$c"
masks=$(body | python3 -c 'import sys,json;d=json.load(sys.stdin);print(",".join("%d:%d" % (c["slot"], c["mask"]) for c in d["controllers"]))')
check "maskers per slot" "0:5,1:16" "$masks"
c=$(call "{\"action\":\"ctrl-poll\",\"token\":\"$gtok\"}")
check "gast mag niet pollen" 401 "$c"

print "== 8. ctrl-leave geeft de plek vrij =="
call "{\"action\":\"ctrl-leave\",\"token\":\"$tok1\"}" >/dev/null
c=$(call "{\"action\":\"ctrl-join\",\"code\":\"$p1\"}")
check "opnieuw koppelen na leave" 200 "$c"

print "== 9. pair-end ruimt alles op =="
call "{\"action\":\"pair-end\",\"token\":\"$host\"}" >/dev/null
c=$(call "{\"action\":\"ctrl-join\",\"code\":\"$p1\"}")
check "joystickcode dood na pair-end" 400 "$c"
c=$(call "{\"action\":\"pair-join\",\"code\":\"$gast\"}")
check "gastcode dood na pair-end" 400 "$c"

print "== 10. parallelle ctrl-join op dezelfde code: precies één wint =="
resp=$(call '{"action":"pair-create"}' >/dev/null; body)
np1=$(print $resp | python3 -c 'import sys,json;print(json.load(sys.stdin)["ctrl_code_p1"])')
for i in 1 2 3 4 5 6; do
  (curl -s -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' \
     -d "{\"action\":\"ctrl-join\",\"code\":\"$np1\"}" "$api" >> /tmp/vph_par) &
done
wait
ok=$(grep -c '^200$' /tmp/vph_par); conflict=$(grep -c '^409$' /tmp/vph_par)
rm -f /tmp/vph_par
check "precies 1x 200" 1 "$ok"
check "5x 409" 5 "$conflict"

print ""
print "RESULTAAT: $pass geslaagd, $fail gefaald"
[[ $fail -eq 0 ]]
