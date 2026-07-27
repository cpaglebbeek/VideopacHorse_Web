<?php
/**
 * VideopacHorse Pairing + Controller API — v0.4.0 Videopac-Pioneer
 *
 * (1) WebRTC P2P multiplayer signaling voor 🎭 Samen spelen.
 *     Twee gebruikers pairen via 6-tekens code, WebRTC handshake via signal-queue,
 *     daarna gaat alle media P2P (canvas-stream host → gast, gast-input via DataChannel).
 *     Server ziet ALLEEN SDP/ICE (geen media-content).
 * (2) Telefoon-als-joystick over internet ("controllers"): een telefoon joint met
 *     dezelfde 6-tekens code en krijgt een slot (0 = speler 1, 1 = speler 2). De
 *     host pollt de laatst bekende maskers. Geen media, alleen 5 bits per speler.
 *
 * Endpoints (POST JSON):
 *   pair-create       -> {code, host_token, expires_at}; sessie 4 uur
 *   pair-join {code}  -> {guest_token, expires_at}; MAX ÉÉN gast per sessie
 *                        (code blijft geldig: controllers gebruiken 'm ook);
 *                        409 als speler 2 al door een telefoon-joystick bezet is
 *   pair-end {token=host} -> {ok}; sessie + controllers direct opruimen
 *   rtc-signal-send {token, type, payload} -> {ok}
 *   rtc-signal-poll {token} -> {signals: [{type, payload}]}; delete after delivery
 *   ctrl-join  {code}          -> {ctrl_token, slot, expires_at}; max 2, anders 409
 *   ctrl-input {token, mask}   -> {ok}; mask 0..31 (bit0 UP .. bit4 FIRE == G7K_JOY_*)
 *   ctrl-poll  {token=host}    -> {controllers:[{slot, mask, age_ms}]}; alleen de host
 *   ctrl-leave {token}         -> {ok}; slot vrijgeven
 *
 * Storage: SQLite op /var/lib/videopac/pairing.db (buiten webroot).
 * GC: getrotteld (max 1×/60 s, marker in meta) — TTL cleanup + orphan removal (BUG-007).
 * Anti-spam: max 50 pending signals per target_token.
 * Schrijf-hygiëne: ALLE schrijfacties via withRetry() — ook die in gc() (v0.4.0-Rusch:
 * die stonden er buiten en gaven bij SQLITE_BUSY een fatale 500); slot-toewijzing in
 * BEGIN IMMEDIATE; ctrl-input doet UPDATE (geen INSERT-groei); ctrl-poll schrijft niets.
 */
declare(strict_types=1);

const DB_PATH = '/var/lib/videopac/pairing.db';
const TTL_CODE_MINUTES = 10;           // Code geldig 10 minuten
const TTL_SESSION_HOURS = 4;           // Sessie 4 uur
const RTC_SIGNAL_LIMIT = 32768;        // Max 32 KB per signal (SDP ~4-8KB)
const RTC_QUEUE_MAX = 50;              // Max pending signals per target
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';  // 34 chars
const CODE_LEN = 6;
const CTRL_MAX = 2;                    // Max 2 joysticks per sessie (slot 0/1)
const CTRL_TTL_SECONDS = 60;           // Controller zonder input ⇒ opruimen
const CTRL_MASK_MAX = 31;              // 5 bits: UP|DOWN|LEFT|RIGHT|FIRE

// CORS + Content-Type
header('Access-Control-Allow-Origin: *');
header('Vary: Origin');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
    http_response_code(204);
    exit;
}

function fail(string $msg, int $http = 400): void {
    http_response_code($http);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $msg]);
    exit;
}

function ok(array $data): void {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data);
    exit;
}

function db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;

    // Zorg dat directory bestaat (deploy moet dit doen, maar failsafe)
    $dir = dirname(DB_PATH);
    if (!is_dir($dir)) {
        mkdir($dir, 0700, true);
    }

    $pdo = new PDO('sqlite:' . DB_PATH);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA journal_mode=WAL');
    $pdo->exec('PRAGMA busy_timeout=10000');
    $pdo->exec('PRAGMA synchronous=NORMAL');

    // Schema: idempotent
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS sessions (
            token           TEXT PRIMARY KEY,
            code            TEXT UNIQUE,               -- NULL na join (single-use)
            host_token      TEXT,
            guest_token     TEXT,
            created_at      INTEGER NOT NULL,
            expires_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(code);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

        CREATE TABLE IF NOT EXISTS rtc_signals (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_token    TEXT NOT NULL,
            target_token    TEXT NOT NULL,
            type            TEXT NOT NULL,
            payload         TEXT NOT NULL,
            ts_ms           INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rtc_target ON rtc_signals(target_token, id);

        /* Telefoon-joysticks over internet. updated_at = epoch in MILLIseconden
         * (age_ms in ctrl-poll moet fijner zijn dan een seconde: de failsafe van
         * de host schakelt al bij 2000 ms uit). Eén rij per controller; ctrl-input
         * UPDATE't die rij, er groeit dus niets (BUG-007-les). */
        CREATE TABLE IF NOT EXISTS controllers (
            token           TEXT PRIMARY KEY,
            session_token   TEXT NOT NULL,
            slot            INTEGER NOT NULL,
            mask            INTEGER NOT NULL DEFAULT 0,
            updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_controllers_session ON controllers(session_token);

        CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER);
    ");

    @chmod(DB_PATH, 0600);
    return $pdo;
}

function gc(): void {
    $now = time();
    /* BUG-007: GC deed 2 DELETE's bij ELK verzoek; met twee peers die elke
     * 500 ms pollen gaf dat permanente write-locks ("database is locked").
     * Nu hoogstens eens per 60 s, bijgehouden in een meta-tabel. */
    $st = db()->prepare('SELECT v FROM meta WHERE k=?');
    $st->execute(['last_gc']);
    $last = (int)($st->fetchColumn() ?: 0);
    if ($now - $last < 60) {
        return;
    }

    /* BUG-008 (v0.4.0-Rusch), deel 1: het GC-venster wordt ATOMAIR geclaimd.
     * De lees-check hierboven is alleen de goedkope voorfilter; de UPDATE
     * hieronder slaagt bij precies één verzoek, want de DO UPDATE-WHERE eist
     * dat de marker nog oud is. Verzoeken die tegelijk het 60 s-venster
     * passeren draaien dus niet allemaal het volledige schrijfblok.
     *
     * BUG-008, deel 2: élke schrijfactie loopt via withRetry(). Met $fatal=false
     * geeft die bij aanhoudende SQLITE_BUSY netjes null terug in plaats van een
     * 503 — opruimen is huishouding, dat mag een legitiem verzoek nooit laten
     * mislukken. Vóór deze fix stonden alle vijf schrijfacties buiten withRetry()
     * en was elke SQLITE_BUSY hier een ongevangen PDOException ⇒ HTTP 500. */
    $claimed = withRetry(function () use ($now) {
        $st = db()->prepare(
            'INSERT INTO meta(k,v) VALUES(:k,:now)
             ON CONFLICT(k) DO UPDATE SET v=excluded.v WHERE meta.v <= :cutoff'
        );
        $st->execute([':k' => 'last_gc', ':now' => $now, ':cutoff' => $now - 60]);
        return $st->rowCount() > 0;
    }, false);
    if (!$claimed) {
        return;   /* andere request doet de GC, of db bezet: volgende ronde */
    }

    // Verwijder verlopen sessies
    withRetry(function () use ($now) {
        db()->prepare('DELETE FROM sessions WHERE expires_at < ?')->execute([$now]);
        return true;
    }, false);
    // Verwijder signals waarvan target/sender niet meer leeft
    /* Levende tokens = host_token EN guest_token (niet alleen sessions.token,
     * anders wist de GC elk gast-signaal direct — BUG-003). */
    withRetry(function () {
        db()->exec("DELETE FROM rtc_signals WHERE sender_token NOT IN
                       (SELECT host_token FROM sessions
                        UNION SELECT guest_token FROM sessions WHERE guest_token IS NOT NULL)
                   OR target_token NOT IN
                       (SELECT host_token FROM sessions
                        UNION SELECT guest_token FROM sessions WHERE guest_token IS NOT NULL)");
        return true;
    }, false);
    /* Controllers: stille telefoons (>60 s geen ctrl-input) en wezen van een
     * opgeruimde sessie. Blijft binnen dezelfde 60 s-throttle — geen extra
     * schrijfdruk per verzoek. */
    withRetry(function () {
        db()->prepare('DELETE FROM controllers WHERE updated_at < ?')
            ->execute([nowMs() - (CTRL_TTL_SECONDS * 1000)]);
        return true;
    }, false);
    withRetry(function () {
        db()->exec('DELETE FROM controllers WHERE session_token NOT IN (SELECT token FROM sessions)');
        return true;
    }, false);
}

function nowMs(): int {
    return (int)round(microtime(true) * 1000);
}

/* 48 hex tekens — zelfde vorm voor host-, gast- én controller-tokens. */
function requireTokenShape($token): string {
    if (!is_string($token) || !preg_match('/^[a-f0-9]{48}$/', $token)) {
        fail('ongeldig token', 401);
    }
    return $token;
}

/* Sessiecode zoals newCode() 'm maakt: 6 tekens uit A-Z2-9. */
function requireCodeShape($code): string {
    if (!is_string($code) || !preg_match('/^[A-Z2-9]{' . CODE_LEN . '}$/', $code)) {
        fail('ongeldige code');
    }
    return $code;
}

function newCode(): string {
    $alphabet = CODE_ALPHABET;
    $len = strlen($alphabet);

    for ($attempt = 0; $attempt < 12; $attempt++) {
        $code = '';
        for ($i = 0; $i < CODE_LEN; $i++) {
            $code .= $alphabet[random_int(0, $len - 1)];
        }

        /* Botsingscheck over ÁLLE rijen, niet alleen de niet-verlopen: sinds
         * v0.4.0 blijft `code` staan (controllers joinen er ook mee), dus een
         * verlopen-maar-nog-niet-opgeruimde rij houdt de UNIQUE-index bezet. */
        $st = db()->prepare('SELECT 1 FROM sessions WHERE code=?');
        $st->execute([$code]);
        if (!$st->fetchColumn()) {
            return $code;
        }
    }
    fail('kon geen unieke code genereren', 503);
}

function newToken(): string {
    return bin2hex(random_bytes(24));  // 48 hex chars
}

function inputJson(): array {
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > RTC_SIGNAL_LIMIT + 2048) {
        fail('request te groot', 413);
    }
    $d = json_decode($raw, true);
    if (!is_array($d)) {
        fail('ongeldige JSON');
    }
    return $d;
}

/* Schrijfacties opnieuw proberen bij SQLITE_BUSY. WAL laat één schrijver toe;
 * onder twee pollers (2 Hz) + ICE-bursts botsen verzoeken af en toe en blijkt
 * PRAGMA busy_timeout in PHP-FPM niet altijd te wachten (BUG-007). Bounded:
 * 25 pogingen x ~40 ms = max ~1 s, daarna nette 503 i.p.v. fatale fout.
 *
 * $fatal=false: geef null terug in plaats van te falen. Alleen voor huishouding
 * (gc()) — het antwoord van de gebruiker mag daar niet van afhangen. */
function withRetry(callable $fn, bool $fatal = true) {
    $last = null;
    for ($i = 0; $i < 25; $i++) {
        try {
            return $fn();
        } catch (PDOException $e) {
            $msg = $e->getMessage();
            if (stripos($msg, 'locked') === false && stripos($msg, 'busy') === false) {
                if (!$fatal) return null;
                throw $e;
            }
            $last = $e;
            usleep(40000);
        }
    }
    if (!$fatal) return null;
    fail('database bezet, probeer opnieuw', 503);
    throw $last;
}

function requireSessionByToken(?string $token): array {
    if (!is_string($token) || !preg_match('/^[a-f0-9]{48}$/', $token)) {
        fail('ongeldig token', 401);
    }
    /* token = host_token (= sessions.token) OF guest_token */
    $st = db()->prepare('SELECT * FROM sessions WHERE (token=? OR guest_token=?) AND expires_at>?');
    $st->execute([$token, $token, time()]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        fail('sessie verlopen of onbekend', 401);
    }
    return $row;
}

// -------- bootstrap --------
gc();
db();

$in = inputJson();
$action = $in['action'] ?? '';

switch ($action) {

case 'pair-create': {
    // HOST: maak nieuwe pairing-sessie aan
    $code = newCode();
    $hostToken = newToken();
    $now = time();
    $expiresAt = $now + (TTL_SESSION_HOURS * 3600);

    withRetry(function () use ($hostToken, $code, $now, $expiresAt) {
        db()->prepare('INSERT INTO sessions(token, code, host_token, created_at, expires_at) VALUES(?,?,?,?,?)')
            ->execute([$hostToken, $code, $hostToken, $now, $expiresAt]);
        return true;
    });

    ok([
        'code' => $code,
        'host_token' => $hostToken,
        'expires_at' => $expiresAt,
    ]);
}

case 'pair-join': {
    // GAST: join via code
    $code = requireCodeShape($in['code'] ?? '');

    /* Goedkope voorcontrole (read-only) — pas daarna het schrijfslot nemen. */
    $st = db()->prepare('SELECT token, expires_at FROM sessions WHERE code=? AND expires_at>?');
    $st->execute([$code, time()]);
    $pre = $st->fetch(PDO::FETCH_ASSOC);
    if (!$pre) {
        fail('code verlopen of onbekend');
    }

    /* v0.4.0: de code wordt NIET meer op NULL gezet. Hij blijft geldig omdat
     * telefoon-joysticks (ctrl-join) dezelfde code gebruiken.
     *
     * BUG-009 (v0.4.0-Rusch): de cap is nu SYMMETRISCH. ctrl-join telde de gast
     * al mee als speler 2, maar pair-join keek alleen naar guest_token en negeerde
     * bezette controller-slots — een telefoon in slot 1 raakte daardoor stil
     * dubbel bezet (server, host-UI en telefoon vertelden drie verhalen).
     * Regel: maximaal 2 spelers per sessie; de gast IS speler 2, dus slot 1 moet
     * vrij zijn. Alles binnen BEGIN IMMEDIATE, zodat een ctrl-join er niet
     * tussendoor kan glippen (zelfde venster-regel als bij ctrl-join zelf).
     * fail() mag hier niet: dat doet exit() en zou de transactie open laten. */
    $guestToken = newToken();
    $res = withRetry(function () use ($guestToken, $code) {
        db()->exec('BEGIN IMMEDIATE');
        try {
            $st = db()->prepare('SELECT token, guest_token, expires_at FROM sessions WHERE code=? AND expires_at>?');
            $st->execute([$code, time()]);
            $sess = $st->fetch(PDO::FETCH_ASSOC);
            if (!$sess) {
                db()->exec('ROLLBACK');
                return ['err' => ['code verlopen of onbekend', 400]];
            }
            if (!empty($sess['guest_token'])) {
                db()->exec('ROLLBACK');
                return ['err' => ['deze sessie is al bezet', 400]];
            }

            $q = db()->prepare('SELECT slot FROM controllers WHERE session_token=?');
            $q->execute([$sess['token']]);
            $slots = array_map('intval', $q->fetchAll(PDO::FETCH_COLUMN));
            if (in_array(1, $slots, true) || count($slots) >= CTRL_MAX) {
                db()->exec('ROLLBACK');
                return ['err' => ['speler 2 is bezet door een telefoon-joystick', 409]];
            }

            $st = db()->prepare("UPDATE sessions SET guest_token=?
                                 WHERE token=? AND (guest_token IS NULL OR guest_token='')");
            $st->execute([$guestToken, $sess['token']]);
            if ($st->rowCount() < 1) {
                db()->exec('ROLLBACK');
                return ['err' => ['deze sessie is al bezet', 400]];
            }
            db()->exec('COMMIT');
            return ['expires_at' => (int)$sess['expires_at']];
        } catch (Throwable $e) {
            try { db()->exec('ROLLBACK'); } catch (Throwable $e2) { }
            throw $e;
        }
    });

    if (isset($res['err'])) {
        fail($res['err'][0], $res['err'][1]);
    }

    ok([
        'guest_token' => $guestToken,
        'expires_at' => $res['expires_at'],
    ]);
}

case 'pair-end': {
    /* HOST stopt de sessie (⏹ Stop sessie). Zonder dit endpoint bleef de sessie
     * server-side nog tot 4 uur leven: telefoons bleven input posten die niemand
     * ophaalde, en de zichtbare code bleef al die tijd een geldig toegangsbewijs.
     * Alleen het host-token mag dit; controllers en signalen gaan mee weg. */
    $token = requireTokenShape($in['token'] ?? '');
    $st = db()->prepare('SELECT token FROM sessions WHERE token=?');
    $st->execute([$token]);
    if (!$st->fetchColumn()) {
        fail('alleen de host mag de sessie stoppen', 401);
    }
    withRetry(function () use ($token) {
        db()->prepare('DELETE FROM controllers WHERE session_token=?')->execute([$token]);
        db()->prepare('DELETE FROM rtc_signals WHERE sender_token=? OR target_token=?')
            ->execute([$token, $token]);
        db()->prepare('DELETE FROM sessions WHERE token=?')->execute([$token]);
        return true;
    });
    ok(['ok' => true]);
}

case 'rtc-signal-send': {
    // Verzend SDP/ICE-signal naar peer
    $token = $in['token'] ?? '';
    $type = $in['type'] ?? '';
    $payload = $in['payload'] ?? '';

    if (!in_array($type, ['offer', 'answer', 'ice', 'bye'], true)) {
        fail('ongeldig signal type');
    }

    if (!is_string($payload) || strlen($payload) > RTC_SIGNAL_LIMIT) {
        fail('payload te groot');
    }

    $sess = requireSessionByToken($token);

    // Bepaal peer op basis van de AANROEPER (token), niet van de rij zelf
    $isHost = hash_equals((string)$sess['host_token'], (string)$token);
    $targetToken = $isHost ? $sess['guest_token'] : $sess['host_token'];

    if (empty($targetToken)) {
        fail('peer nog niet verbonden');
    }

    // Anti-spam: check pending count
    $st = db()->prepare('SELECT COUNT(*) FROM rtc_signals WHERE target_token=?');
    $st->execute([$targetToken]);
    $pending = (int)$st->fetchColumn();
    if ($pending >= RTC_QUEUE_MAX) {
        fail('signaal-wachtrij vol (peer traag)', 429);
    }

    $now = time();
    $nowMs = (int)($now * 1000);
    withRetry(function () use ($token, $targetToken, $type, $payload, $nowMs) {
        db()->prepare('INSERT INTO rtc_signals(sender_token, target_token, type, payload, ts_ms) VALUES(?,?,?,?,?)')
            ->execute([$token, $targetToken, $type, $payload, $nowMs]);
        return true;
    });

    ok(['ok' => true]);
}

case 'rtc-signal-poll': {
    // Ontvang wachtende signalen (poll-and-delete)
    $token = $in['token'] ?? '';

    $sess = requireSessionByToken($token);

    /* poll-and-delete in ÉÉN transactie met ÉÉN delete (BUG-007) */
    /* BEGIN IMMEDIATE: schrijfslot meteen nemen. Met een gewone (deferred)
     * transactie upgradet SQLite pas bij de DELETE van lees- naar schrijfslot;
     * twee gelijktijdige pollers geven dan direct "database is locked" en
     * busy_timeout kan die upgrade niet afwachten (BUG-007). */
    /* BUG-009: de poll nam ELKE 500 ms een schrijfslot, ook als er niets stond.
     * Met host-poll + ctrl-poll + een joinende gast botsten die sloten en gaf
     * withRetry uiteindelijk 503 ("database bezet") midden in het pairen.
     * Nu eerst read-only kijken; alleen bij werk het schrijfslot nemen. */
    $chk = db()->prepare('SELECT COUNT(*) FROM rtc_signals WHERE target_token=?');
    $chk->execute([$token]);
    if ((int)$chk->fetchColumn() === 0) {
        ok(['signals' => []]);
    }

    $result = withRetry(function () use ($token) {
    db()->exec('BEGIN IMMEDIATE');
    try {
        $st = db()->prepare('SELECT id, type, payload FROM rtc_signals WHERE target_token=? ORDER BY id ASC');
        $st->execute([$token]);
        $signals = $st->fetchAll(PDO::FETCH_ASSOC);

        $result = [];
        $maxId = 0;
        foreach ($signals as $sig) {
            $result[] = ['type' => $sig['type'], 'payload' => $sig['payload']];
            $maxId = max($maxId, (int)$sig['id']);
        }
        if ($maxId > 0) {
            db()->prepare('DELETE FROM rtc_signals WHERE target_token=? AND id<=?')
                ->execute([$token, $maxId]);
        }
        db()->exec('COMMIT');
        return $result;
    } catch (Throwable $e) {
        try { db()->exec('ROLLBACK'); } catch (Throwable $e2) { }
        throw $e;
    }
    });

    ok(['signals' => $result]);
}

/* ---------------- telefoon-joysticks (controllers) ---------------- */

case 'ctrl-join': {
    /* Telefoon joint met dezelfde sessiecode als de "Samen spelen"-gast en
     * krijgt het laagste vrije slot (0 = speler 1, 1 = speler 2). */
    $code = requireCodeShape($in['code'] ?? '');

    /* Eerst read-only vaststellen dát de code bestaat; pas daarna het schrijfslot
     * nemen. Vóór v0.4.0-Rusch opende élk verzoek met een willekeurige geldig
     * gevormde code eerst BEGIN IMMEDIATE en nam zo het enige schrijfslot van de
     * gedeelde SQLite-db, om vervolgens 400 te geven. */
    $st = db()->prepare('SELECT 1 FROM sessions WHERE code=? AND expires_at>?');
    $st->execute([$code, time()]);
    if (!$st->fetchColumn()) {
        fail('code verlopen of onbekend');
    }

    $ctrlToken = newToken();
    $nowMs = nowMs();

    /* Slot-toewijzing atomair: twee telefoons kunnen tegelijk joinen. Met
     * BEGIN IMMEDIATE ligt het schrijfslot er meteen, dus de SELECT die de
     * bezette slots bepaalt en de INSERT zitten in hetzelfde venster —
     * niemand kan er tussen glippen (zelfde reden als BUG-007). Fouten
     * worden als waarde teruggegeven, niet als fail(): fail() doet exit en
     * zou de transactie open laten staan. */
    $res = withRetry(function () use ($code, $ctrlToken, $nowMs) {
        db()->exec('BEGIN IMMEDIATE');
        try {
            $st = db()->prepare('SELECT token, guest_token, expires_at FROM sessions WHERE code=? AND expires_at>?');
            $st->execute([$code, time()]);
            $sess = $st->fetch(PDO::FETCH_ASSOC);
            if (!$sess) {
                db()->exec('ROLLBACK');
                return ['err' => ['code verlopen of onbekend', 400]];
            }

            /* Bezet = bestaande controller-rijen + slot 1 als er een
             * "Samen spelen"-gast hangt (die ís speler 2, zie
             * guestOwnsPlayer2() in web/app.js). */
            $taken = [];
            if (!empty($sess['guest_token'])) {
                $taken[1] = true;
            }
            $q = db()->prepare('SELECT slot FROM controllers WHERE session_token=?');
            $q->execute([$sess['token']]);
            foreach ($q->fetchAll(PDO::FETCH_COLUMN) as $s) {
                $taken[(int)$s] = true;
            }

            $slot = null;
            for ($i = 0; $i < CTRL_MAX; $i++) {
                if (empty($taken[$i])) { $slot = $i; break; }
            }
            if ($slot === null) {
                db()->exec('ROLLBACK');
                return ['err' => ['maximaal 2 joysticks', 409]];
            }

            db()->prepare('INSERT INTO controllers(token, session_token, slot, mask, updated_at) VALUES(?,?,?,0,?)')
                ->execute([$ctrlToken, $sess['token'], $slot, $nowMs]);
            db()->exec('COMMIT');
            return ['slot' => $slot, 'expires_at' => (int)$sess['expires_at']];
        } catch (Throwable $e) {
            try { db()->exec('ROLLBACK'); } catch (Throwable $e2) { }
            throw $e;
        }
    });

    if (isset($res['err'])) {
        fail($res['err'][0], $res['err'][1]);
    }

    ok([
        'ctrl_token' => $ctrlToken,
        'slot' => $res['slot'],
        'expires_at' => $res['expires_at'],
    ]);
}

case 'ctrl-input': {
    /* Telefoon stuurt bij elke maskverandering + heartbeat elke 500 ms.
     * Altijd één UPDATE van de bestaande rij — de tabel groeit dus niet mee
     * met de invoerfrequentie (BUG-007-les). */
    $token = requireTokenShape($in['token'] ?? '');
    $mask = $in['mask'] ?? null;
    if (is_string($mask) && ctype_digit($mask)) {
        $mask = (int)$mask;
    }
    if (!is_int($mask) || $mask < 0 || $mask > CTRL_MASK_MAX) {
        fail('ongeldig mask');
    }

    $st = db()->prepare('SELECT c.slot FROM controllers c
                         JOIN sessions s ON s.token = c.session_token
                         WHERE c.token=? AND s.expires_at>?');
    $st->execute([$token, time()]);
    if ($st->fetchColumn() === false) {
        fail('controller onbekend of verlopen', 401);
    }

    $nowMs = nowMs();
    withRetry(function () use ($mask, $nowMs, $token) {
        db()->prepare('UPDATE controllers SET mask=?, updated_at=? WHERE token=?')
            ->execute([$mask, $nowMs, $token]);
        return true;
    });

    ok(['ok' => true]);
}

case 'ctrl-poll': {
    /* Alleen de HOST mag pollen: sessions.token IS het host-token; een gast-
     * of controller-token matcht deze query niet. Volledig read-only, dus 10 Hz
     * pollen levert geen schrijfdruk op. */
    $token = requireTokenShape($in['token'] ?? '');
    $st = db()->prepare('SELECT token FROM sessions WHERE token=? AND expires_at>?');
    $st->execute([$token, time()]);
    if (!$st->fetchColumn()) {
        fail('alleen de host mag pollen', 401);
    }

    $nowMs = nowMs();
    $q = db()->prepare('SELECT slot, mask, updated_at FROM controllers WHERE session_token=? ORDER BY slot');
    $q->execute([$token]);

    $controllers = [];
    foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $controllers[] = [
            'slot' => (int)$row['slot'],
            'mask' => (int)$row['mask'],
            'age_ms' => max(0, $nowMs - (int)$row['updated_at']),
        ];
    }

    ok(['controllers' => $controllers]);
}

case 'ctrl-leave': {
    // Slot vrijgeven (app naar achtergrond / gebruiker stopt).
    $token = requireTokenShape($in['token'] ?? '');
    withRetry(function () use ($token) {
        db()->prepare('DELETE FROM controllers WHERE token=?')->execute([$token]);
        return true;
    });
    ok(['ok' => true]);
}

default:
    fail('onbekende actie', 400);

}
