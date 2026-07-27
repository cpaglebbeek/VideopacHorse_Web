#!/usr/bin/env python3
"""
e2e-test /videopac/ — twee echte browsers spelen samen via WebRTC-netplay.

Bewijst wat de unit-gate niet kan bewijzen: dat de hele keten werkt (pairing-API,
DataChannels, assets ophalen, lockstep) en dat beide kanten daarna hetzelfde beeld
tonen. Dat laatste meten we door de canvas-inhoud van host en gast te hashen — de
enige controle die niet te vervalsen is met een groen vinkje.
"""
import json, os, re, sys, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("VPH_BASE_URL", "http://127.0.0.1:8099")
BIOS = os.environ.get("VPH_ROMDIR", "").rstrip("/") + "/o2rom.bin"
CART = os.environ.get("VPH_ROMDIR", "").rstrip("/") + "/cart14.bin"

CANVAS_HASH = """() => {
  const cv = document.getElementById('screen');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = (h * 16777619) >>> 0; }
  return h.toString(16);
}"""

STATE = """() => ({
  status: (document.getElementById('netStatus')||{}).textContent,
  notice: (document.getElementById('netNotice')||{}).textContent,
  stats: (document.getElementById('netStats')||{}).textContent,
  running: (typeof netplay !== 'undefined') && netplay.active(),
  bios: (document.getElementById('biosBadge')||{}).textContent,
  rom: (document.getElementById('romBadge')||{}).textContent,
})"""

results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  ok   " if ok else "  FOUT ") + name + ((" — " + detail) if detail else ""), flush=True)

def load_local_files(page, bios, cart):
    """BIOS en cartridge via de normale bestandsvelden inladen (de echte route)."""
    page.set_input_files("#fileBios", bios)
    page.set_input_files("#fileRom", cart)

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    host_ctx = browser.new_context()
    guest_ctx = browser.new_context()
    host = host_ctx.new_page()
    guest = guest_ctx.new_page()
    errs = {"host": [], "guest": []}
    host.on("pageerror", lambda e: errs["host"].append(str(e)))
    guest.on("pageerror", lambda e: errs["guest"].append(str(e)))
    host.on("console", lambda m: errs["host"].append("console:" + m.text) if m.type == "error" else None)
    guest.on("console", lambda m: errs["guest"].append("console:" + m.text) if m.type == "error" else None)

    print("== 1. pagina laadt en core start ==")
    host.goto(BASE + "/", wait_until="networkidle")
    guest.goto(BASE + "/", wait_until="networkidle")
    host.wait_for_function("() => typeof S !== 'undefined' && !!S.api", timeout=15000)
    guest.wait_for_function("() => typeof S !== 'undefined' && !!S.api", timeout=15000)
    ver = host.evaluate("() => S.api.version()")
    check("core geladen in beide tabs", bool(ver), "versie " + str(ver))
    check("netplay-module aanwezig", host.evaluate("() => typeof netplay === 'object'"))
    for who in ("host", "guest"):
        if errs[who]:
            print("   %s-fouten bij laden: %s" % (who, errs[who][:3]))
    check("hoofdpagina gebruikt de eigen map", host.evaluate("() => VPH_BASE === '' && VPH_API === 'api/'"))

    print("== 2. host laadt BIOS + cartridge en start een sessie ==")
    load_local_files(host, BIOS, CART)
    host.wait_for_function("() => S.bios && S.rom", timeout=10000)
    host.click("#netBtnStart")
    host.wait_for_function("() => /^[A-Z2-9]{6}$/.test(document.getElementById('netCode').textContent)", timeout=15000)
    codes = host.evaluate("""() => ({
      gast: document.getElementById('netCode').textContent,
      p1: document.getElementById('netCodeP1').textContent,
      p2: document.getElementById('netCodeP2').textContent })""")
    check("drie codes zichtbaar", len({codes['gast'], codes['p1'], codes['p2']}) == 3, str(codes))

    print("== 3. gast doet mee met de gastcode (heeft zelf niets geladen) ==")
    guest.fill("#netCodeInput", codes["gast"])
    guest.click("#netBtnJoin")

    # wachten tot beide kanten in lockstep draaien
    t0 = time.time()
    ok_run = False
    while time.time() - t0 < 60:
        hs, gs = host.evaluate(STATE), guest.evaluate(STATE)
        if hs["running"] and gs["running"]:
            ok_run = True
            break
        time.sleep(0.5)
    hs, gs = host.evaluate(STATE), guest.evaluate(STATE)
    check("beide kanten in netplay", ok_run, "host=%r gast=%r" % (hs["status"], gs["status"]))
    if not ok_run:
        print("   host:", hs); print("   gast:", gs)

    print("== 4. gast heeft dezelfde cartridge zélf opgehaald ==")
    same_rom = guest.evaluate("() => S.rom ? crc32(S.rom) : null")
    host_rom = host.evaluate("() => S.rom ? crc32(S.rom) : null")
    check("cartridge-CRC gelijk", same_rom == host_rom and same_rom is not None,
          "host=%s gast=%s" % (host_rom, same_rom))
    check("gast kreeg de ROM NIET over de lijn", "medespeler" not in (gs["notice"] or ""),
          gs["notice"] or "(geen melding)")

    print("== 5. host start het spel; toets en FIRE moeten bij de gast meelopen ==")
    host.click("#screen")
    host.keyboard.down("1"); time.sleep(0.35); host.keyboard.up("1")   # spelkeuze (consoletoets)
    time.sleep(1.0)
    host.keyboard.down(" "); time.sleep(0.35); host.keyboard.up(" ")   # FIRE start de ronde
    time.sleep(1.0)

    # Nu LOOPT het spel: het beeld hoort te bewegen. Zonder deze controle zou een
    # stilstaande emulator ook "gelijk" scoren bij de vergelijking hieronder.
    moving = []
    for i in range(5):
        moving.append(host.evaluate(CANVAS_HASH))
        time.sleep(0.35)
    check("host toont bewegend beeld", len(set(moving)) > 1, " ".join(moving))

    print("== 5b. samen spelen ==")
    for i in range(15):
        host.keyboard.down("ArrowRight"); guest.keyboard.down("d")
        time.sleep(0.12)
        host.keyboard.up("ArrowRight"); guest.keyboard.up("d")
        time.sleep(0.12)
    time.sleep(1.5)

    print("== 5c. bij HETZELFDE frame dezelfde machinestaat ==")
    # De juiste vergelijking: niet twee canvassen op hetzelfde klokmoment (de
    # machines mogen frames uit elkaar lopen), maar de state-hash bij hetzelfde
    # framenummer. Die hash dekt RAM, VDC en CPU — niet alleen wat je ziet.
    matched = None
    for attempt in range(40):
        hd = host.evaluate("() => netplay.debug()")
        gd = guest.evaluate("() => netplay.debug()")
        hh, gh = hd.get("lastHash"), gd.get("lastHash")
        if hh and gh and hh["frame"] == gh["frame"] and hh["frame"] >= 180:
            matched = (hh, gh)
            break
        time.sleep(0.25)
    if matched:
        hh, gh = matched
        check("state-hash gelijk op frame %d" % hh["frame"], hh["h"] == gh["h"],
              "host=%s gast=%s" % (hh["h"], gh["h"]))
    else:
        check("state-hash op gelijk frame gemeten", False, "host=%s gast=%s" % (
              host.evaluate("() => JSON.stringify(netplay.debug().lastHash)"),
              guest.evaluate("() => JSON.stringify(netplay.debug().lastHash)")))

    hd = host.evaluate("() => netplay.debug()")
    gd = guest.evaluate("() => netplay.debug()")
    print("   host: frame=%(frame)s stalls=%(stalls)s rtt=%(rtt)s delay=%(delay)s desync=%(desyncs)s resync=%(resyncs)s" % hd)
    print("   gast: frame=%(frame)s stalls=%(stalls)s rtt=%(rtt)s delay=%(delay)s desync=%(desyncs)s resync=%(resyncs)s" % gd)
    check("geen desync gemeld", hd["desyncs"] == 0 and gd["desyncs"] == 0,
          "host=%d gast=%d" % (hd["desyncs"], gd["desyncs"]))
    check("beide machines lopen door", hd["frame"] > 150 and gd["frame"] > 150,
          "host=%d gast=%d" % (hd["frame"], gd["frame"]))


    print("== 6b. telefoon-joystick op joystickcode P2 werkt door tot bij de gast ==")
    # Dit is de kernwens: gast en telefoon delen speler 2 en tellen bij elkaar op.
    # De 'telefoon' is hier de kale API, precies wat de Android-app ook doet.
    import urllib.request
    def api(payload):
        req = urllib.request.Request(BASE + "/api/", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req).read())
    join = api({"action": "ctrl-join", "code": codes["p2"]})
    check("telefoon krijgt speler 2", join.get("slot") == 1, str(join))
    seen_host, seen_guest = [], []
    for i in range(14):
        api({"action": "ctrl-input", "token": join["ctrl_token"], "mask": 8})   # RIGHT
        time.sleep(0.25)
        seen_host.append(host.evaluate("() => netplay.debug().joySources.ctrl[1]"))
        gl = guest.evaluate("() => netplay.debug().lastRemote")
        if gl: seen_guest.append(gl.get("p2", 0))
    check("host ziet de telefoon op speler 2", 8 in seen_host, str(seen_host[:6]))
    check("gast krijgt die invoer via de lockstep", 8 in seen_guest, str(seen_guest[:6]))
    api({"action": "ctrl-leave", "token": join["ctrl_token"]})


    print("== 6c. onderbrekingen worden uitgelegd, niet stil bevroren ==")
    # Browsers bevriezen requestAnimationFrame in een tabblad dat niet zichtbaar
    # is; de lockstep laat de ander dan meewachten. Dat is functioneel goed, maar
    # een stilstaand beeld zonder tekst leest als een vastloper.
    HIDE = ("() => { Object.defineProperty(document, 'hidden', {value: true, configurable: true});"
            "        document.dispatchEvent(new Event('visibilitychange')); }")
    SHOW = ("() => { Object.defineProperty(document, 'hidden', {value: false, configurable: true});"
            "        document.dispatchEvent(new Event('visibilitychange')); }")
    status = lambda pg: pg.evaluate("() => document.getElementById('netStatus').textContent")

    guest.evaluate(HIDE); time.sleep(1.3)
    check("host meldt dat de medespeler weg is", "weggeklikt" in status(host), status(host))
    guest.evaluate(SHOW); time.sleep(1.3)
    check("melding verdwijnt bij terugkeer", "weggeklikt" not in status(host), status(host))

    guest.evaluate("() => { S.running = false; }")          # emulatielus van de gast stil
    time.sleep(2.5)
    check("host meldt het wachten", "wachten" in status(host), status(host))

    # Herstel meten in plaats van er een vaste pauze voor nemen: gemeten duurt het
    # 0,2-0,3 s (de wachtende kant is zelf ook gestopt, dus er is maar `delay`
    # frames in te halen). Een ruime bovengrens houdt de test eerlijk zonder hem
    # afhankelijk te maken van de toevallige snelheid van de testmachine.
    guest.evaluate("() => { S.running = true; requestAnimationFrame(frame); }")
    t_rec = time.time()
    recovered = None
    while time.time() - t_rec < 15:
        if "wachten" not in status(host):
            recovered = time.time() - t_rec
            break
        time.sleep(0.1)
    f_after = host.evaluate("() => netplay.debug()")
    check("loopt weer door zonder uit de pas te raken",
          recovered is not None and f_after["desyncs"] == 0,
          "hersteld in %s, desync=%d" % (
              ("%.1f s" % recovered) if recovered is not None else "niet binnen 15 s",
              f_after["desyncs"]))

    print("== 7. geen JS-fouten ==")
    check("host zonder fouten", not errs["host"], "; ".join(errs["host"][:3]))
    check("gast zonder fouten", not errs["guest"], "; ".join(errs["guest"][:3]))

    browser.close()

print()
bad = [r for r in results if not r[1]]
print("RESULTAAT: %d geslaagd, %d gefaald" % (len(results) - len(bad), len(bad)))
sys.exit(1 if bad else 0)
