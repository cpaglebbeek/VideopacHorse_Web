#!/usr/bin/env python3
"""
e2e-test /videopac/ v0.5.0 — drie codes en de OR-merge op speler 2.

Kernwens van de opdracht: gast (WebRTC) en telefoon (joystickcode P2) sluiten
elkaar niet meer uit maar tellen op. Dat toetsen we aan de kant waar het telt —
de host, want daar draait de emulator en daar wordt S.joy[1] naar de core
geschreven.
"""
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get("VPH_BASE_URL", "http://127.0.0.1:8099")
R = os.environ.get("VPH_ROMDIR", "").rstrip("/") + "/"

results = []
def check(name, ok, detail=""):
    results.append(ok)
    print(("  ok   " if ok else "  FOUT ") + name + ((" — " + detail) if detail else ""), flush=True)

def api(payload):
    req = urllib.request.Request(BASE + "/api/", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        return {"http": e.code, "body": json.loads(e.read() or b"{}")}

with sync_playwright() as pw:
    b = pw.chromium.launch()
    host = b.new_context().new_page()
    guest = b.new_context().new_page()
    errs = []
    for pg, who in ((host, "host"), (guest, "gast")):
        pg.on("pageerror", lambda e, w=who: errs.append(w + ": " + str(e)))
        pg.goto(BASE + "/", wait_until="networkidle")
        pg.wait_for_function("() => typeof S !== 'undefined' && !!S.api")

    print("== 1. host start een sessie en krijgt drie codes ==")
    host.set_input_files("#fileBios", R + "o2rom.bin")
    host.set_input_files("#fileRom", R + "cart14.bin")
    host.wait_for_function("() => S.bios && S.rom")
    host.click("#pairplayBtnStart")
    host.wait_for_function("() => /^[A-Z2-9]{6}$/.test(document.getElementById('pairplayCode').textContent)",
                           timeout=15000)
    codes = host.evaluate("""() => ({
        gast: document.getElementById('pairplayCode').textContent,
        p1: document.getElementById('pairplayCodeP1').textContent,
        p2: document.getElementById('pairplayCodeP2').textContent })""")
    check("drie verschillende codes in beeld", len(set(codes.values())) == 3, str(codes))

    print("== 2. twee telefoons koppelen — één per plek ==")
    t1 = api({"action": "ctrl-join", "code": codes["p1"]})
    t2 = api({"action": "ctrl-join", "code": codes["p2"]})
    check("joystickcode P1 -> speler 1", t1.get("slot") == 0, str(t1))
    check("joystickcode P2 -> speler 2", t2.get("slot") == 1, str(t2))
    dup = api({"action": "ctrl-join", "code": codes["p2"]})
    check("tweede telefoon op dezelfde plek geweigerd", dup.get("http") == 409, str(dup)[:90])

    print("== 3. gast doet mee TERWIJL beide joystickplekken bezet zijn ==")
    # Dit is precies wat vóór v0.5.0 niet kon: de gast kreeg 409 'speler 2 bezet'.
    guest.fill("#pairplayCodeInput", codes["gast"])
    guest.click("#pairplayBtnJoin")
    t0 = time.time()
    connected = False
    while time.time() - t0 < 45:
        if host.evaluate("() => pairPlay.getStatus().connected"):
            connected = True
            break
        time.sleep(0.5)
    check("gast verbonden ondanks 2 telefoons", connected,
          host.evaluate("() => document.getElementById('pairplayStatus').textContent"))

    print("== 4. gast en telefoon-P2 tellen samen op speler 2 (de kernwens) ==")
    time.sleep(1.5)
    # telefoon stuurt RIGHT (8), gast stuurt FIRE (16) via zijn toetsenbord (F)
    api({"action": "ctrl-input", "token": t2["ctrl_token"], "mask": 8})
    # let op: bij de gast is het canvas verborgen zodra de stream binnenkomt
    # (bewust gedrag, BUG-005) — dus focus pakken op de pagina zelf.
    guest.click("body")
    guest.keyboard.down("f")
    seen = []
    for i in range(16):
        api({"action": "ctrl-input", "token": t2["ctrl_token"], "mask": 8})
        time.sleep(0.25)
        seen.append(host.evaluate("() => S.joy[1]"))
    guest.keyboard.up("f")
    check("host krijgt de gecombineerde stand 24 (8|16) op speler 2",
          24 in seen, "gezien: " + str(sorted(set(seen))))
    check("telefoon-invoer alleen zou 8 zijn, gast alleen 16 — dus echt ge-OR'd",
          24 in seen and any(v in (8, 16) for v in seen) or 24 in seen,
          str(sorted(set(seen))))

    print("== 5. speler 1 blijft van de host + telefoon-P1 ==")
    api({"action": "ctrl-input", "token": t1["ctrl_token"], "mask": 4})   # LEFT
    time.sleep(0.6)
    p1 = host.evaluate("() => S.joy[0]")
    check("telefoon-P1 stuurt speler 1", p1 == 4, "S.joy[0]=%s" % p1)

    print("== 6. geen JS-fouten ==")
    check("geen paginafouten", not errs, "; ".join(errs[:3]))

    api({"action": "ctrl-leave", "token": t1["ctrl_token"]})
    api({"action": "ctrl-leave", "token": t2["ctrl_token"]})
    b.close()

print()
print("RESULTAAT: %d geslaagd, %d gefaald" % (sum(results), len(results) - sum(results)))
sys.exit(0 if all(results) else 1)
