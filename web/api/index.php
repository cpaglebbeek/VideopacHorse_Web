<?php
/**
 * VideopacHorse Pairing + Controller API — v0.5.0 Videopac-Pioneer
 *
 * (1) WebRTC P2P multiplayer signaling voor 🎭 Samen spelen.
 *     Twee gebruikers pairen via 6-tekens code, WebRTC handshake via signal-queue,
 *     daarna gaat alles P2P: op /videopac/ een canvas-stream host → gast, op
 *     /videopac/2/ (netplay) alléén een DataChannel met input per frame.
 *     Server ziet ALLEEN SDP/ICE (geen media-content, geen ROM-bytes).
 * (2) Telefoon-als-joystick over internet ("controllers").
 *
 * DRIE CODES per sessie (v0.5.0, gebruikerswens 27-07). Vóór deze versie deelden
 * gast en telefoons één code en moest de SERVER raden wie welke plek kreeg; dat
 * gaf structureel drie verhalen over dezelfde bezetting (zie BUG-009). Nu bepáált
 * de code de rol — er valt niets meer toe te wijzen:
 *   - `code`          -> 🎭 gastcode: max één gast (WebRTC-peer, speler 2)
 *   - `ctrl_code_p1`  -> 🎮 joystickcode speler 1 (host-kant): max één telefoon
 *   - `ctrl_code_p2`  -> 🎮 joystickcode speler 2 (host-kant): max één telefoon
 *   - `ctrl_code_guest` -> 🎮 joystickcode van de GAST (v0.5.3): max één telefoon,
 *                        pas uitgeleverd bij pair-join want vóór die tijd is er geen gast
 * Gast en telefoon-P2 sturen allebei speler 2 aan; die twee worden in de client
 * ge-OR'd, precies zoals toetsenbord en gamepad dat al deden (pushJoy in app.js).
 * Er is dus GEEN exclusiviteit meer en geen kruisvalidatie tussen de endpoints.
 *
 * Endpoints (POST JSON):
 *   pair-create       -> {code, ctrl_code_p1, ctrl_code_p2, host_token, expires_at}
 *                        sessie 4 uur
 *   pair-join {code}  -> {guest_token, expires_at}; alleen de GASTCODE; max één gast
 *   pair-end {token=host} -> {ok}; sessie + controllers direct opruimen
 *   rtc-signal-send {token, type, payload} -> {ok}
 *   rtc-signal-poll {token} -> {signals: [{type, payload}]}; delete after delivery
 *   ctrl-join  {code}          -> {ctrl_token, slot, expires_at}; een JOYSTICKCODE;
 *                                 het slot volgt uit de code (p1 -> 0, p2 -> 1);
 *                                 409 als die plek al door een levende telefoon bezet is
 *   ctrl-input {token, mask}   -> {ok}; mask 0..31 (bit0 UP .. bit4 FIRE == G7K_JOY_*)
 *   ctrl-poll  {token}         -> {controllers:[{slot, mask, age_ms}], owner}; host-token
 *                                 geeft de telefoons aan de host-kant, gast-token die aan
 *                                 de gast-kant (v0.5.3)
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
/* Twee plekken, want de console heeft twee joystickpoorten. Sinds v0.5.0 volgt
 * de plek uit de code (p1 -> 0, p2 -> 1) en is dit geen teller meer maar de
 * grens waarbinnen een slotnummer geldig is. */
const CTRL_SLOTS = 2;
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
            code            TEXT UNIQUE,               -- gastcode (🎭 Samen spelen)
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

    /* v0.5.0-migratie: twee joystickcodes erbij. SQLite kent geen
     * "ADD COLUMN IF NOT EXISTS", dus eerst kijken wat er al staat — dit draait
     * bij ELK verzoek, dus het moet goedkoop en foutloos herhaalbaar zijn.
     * Bestaande sessies uit v0.4.x houden NULL in beide kolommen: hun
     * joystickcodes bestaan simpelweg niet meer, ze verlopen vanzelf binnen de
     * sessie-TTL. Een UNIQUE-index staat meerdere NULLs toe, dus dat botst niet. */
    $cols = [];
    foreach ($pdo->query("PRAGMA table_info(sessions)") as $c) {
        $cols[$c['name']] = true;
    }
    if (empty($cols['ctrl_code_p1'])) {
        $pdo->exec('ALTER TABLE sessions ADD COLUMN ctrl_code_p1 TEXT');
    }
    if (empty($cols['ctrl_code_p2'])) {
        $pdo->exec('ALTER TABLE sessions ADD COLUMN ctrl_code_p2 TEXT');
    }
    /* v0.5.3: de gast mag zijn eigen telefoon koppelen. Zijn code wordt al bij
     * pair-create gereserveerd (dan is uniciteit gegarandeerd) maar pas bij
     * pair-join uitgeleverd — vóór die tijd is er niemand om hem aan te geven. */
    if (empty($cols['ctrl_code_guest'])) {
        $pdo->exec('ALTER TABLE sessions ADD COLUMN ctrl_code_guest TEXT');
    }
    $ccols = [];
    foreach ($pdo->query("PRAGMA table_info(controllers)") as $c) {
        $ccols[$c['name']] = true;
    }
    if (empty($ccols['owner'])) {
        $pdo->exec("ALTER TABLE controllers ADD COLUMN owner TEXT NOT NULL DEFAULT 'host'");
    }
    $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_cp1 ON sessions(ctrl_code_p1)');
    $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_cp2 ON sessions(ctrl_code_p2)');
    /* Eén telefoon per plek — afgedwongen door de database, niet alleen door de
     * controle in ctrl-join. Kan bij een oude db met dubbele rijen falen; dat mag
     * nooit een 500 op elk verzoek geven, dus de index is hier best-effort. */
    try {
        /* Eén telefoon per plek PER EIGENAAR. Slot 1 (speler 2) kan sinds v0.5.3
         * twee rijen hebben: één telefoon aan de host-kant en één aan de gast-kant.
         * Dat is geen dubbele bezetting maar precies het OR-model — beide dragen bij
         * aan dezelfde speler, net als toetsenbord en gamepad dat al deden. */
        $pdo->exec('DROP INDEX IF EXISTS idx_controllers_slot');
        $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_controllers_slot_owner
                    ON controllers(session_token, slot, owner)');
    } catch (PDOException $e) {
        error_log('[videopac-api] slot-index niet aangemaakt: ' . substr($e->getMessage(), 0, 120));
    }

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
    $last = (int)(fetchVal($st) ?: 0);
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

/* $exclude: codes die in ditzelfde verzoek al zijn uitgedeeld maar nog niet in de
 * database staan (pair-create maakt er drie tegelijk). Zonder dat kunnen twee
 * rollen binnen één sessie dezelfde code krijgen — zeldzaam, maar dan is de rol
 * niet meer af te leiden uit de code, en dát is nu juist het hele ontwerp. */
function newCode(array $exclude = []): string {
    $alphabet = CODE_ALPHABET;
    $len = strlen($alphabet);

    for ($attempt = 0; $attempt < 12; $attempt++) {
        $code = '';
        for ($i = 0; $i < CODE_LEN; $i++) {
            $code .= $alphabet[random_int(0, $len - 1)];
        }
        if (in_array($code, $exclude, true)) {
            continue;
        }

        /* Botsingscheck over ÁLLE rijen én alle DRIE de codekolommen (v0.5.0).
         * Niet alleen de niet-verlopen: de codes blijven staan tot de GC ze
         * opruimt, dus een verlopen-maar-nog-aanwezige rij houdt de UNIQUE-index
         * bezet. En niet alleen `code`: een joystickcode die toevallig gelijk is
         * aan een gastcode van een andere sessie zou de rollen laten kruisen. */
        $st = db()->prepare('SELECT 1 FROM sessions
                             WHERE code=:c OR ctrl_code_p1=:c OR ctrl_code_p2=:c
                                OR ctrl_code_guest=:c');
        $st->execute([':c' => $code]);
        if (!fetchVal($st)) {
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
/* BUG-011: PDO-SQLite houdt een niet-uitgelezen SELECT-cursor open; een
 * schrijfactie op DEZELFDE verbinding krijgt dan "database is locked", en geen
 * enkele retry helpt want de cursor blijft het hele verzoek open. Alle
 * enkelvoudige leesacties lopen daarom via deze helpers, die de cursor sluiten. */
function fetchRow(PDOStatement $st) {
    $row = $st->fetch(PDO::FETCH_ASSOC);
    $st->closeCursor();
    return $row;
}

function fetchVal(PDOStatement $st) {
    $v = $st->fetchColumn();
    $st->closeCursor();
    return $v;
}

function withRetry(callable $fn, bool $fatal = true) {
    $last = null;
    for ($i = 0; $i < 80; $i++) {
        try {
            return $fn();
        } catch (PDOException $e) {
            $msg = $e->getMessage();
            if (stripos($msg, 'locked') === false && stripos($msg, 'busy') === false) {
                if (!$fatal) return null;
                throw $e;
            }
            $last = $e;
            if ($i === 10) {
                error_log('[videopac-api] SQLITE_BUSY aanhoudend: ' . substr($msg, 0, 120));
            }
            usleep(50000);
        }
    }
    if (!$fatal) return null;
    fail('database bezet, probeer opnieuw', 503);
    throw $last;
}

/* Een schrijfactie binnen BEGIN IMMEDIATE, met gegarandeerde ROLLBACK. Zowel
 * pair-join als ctrl-join hadden hier hun eigen identieke try/catch/rollback-blok
 * staan — twaalf regels die twee keer onderhouden moesten worden en waarvan de
 * ene helft stilletjes kon afwijken van de andere. $fn geeft een array terug;
 * een sleutel 'err' betekent "geen fout in de database, maar wel een afwijzing"
 * en rolt netjes terug zonder exceptie. */
function inImmediateTransaction(callable $fn) {
    return withRetry(function () use ($fn) {
        db()->exec('BEGIN IMMEDIATE');
        try {
            $res = $fn();
            if (isset($res['err'])) {
                db()->exec('ROLLBACK');
            } else {
                db()->exec('COMMIT');
            }
            return $res;
        } catch (Throwable $e) {
            try { db()->exec('ROLLBACK'); } catch (Throwable $e2) { }
            throw $e;
        }
    });
}

function requireSessionByToken(?string $token): array {
    if (!is_string($token) || !preg_match('/^[a-f0-9]{48}$/', $token)) {
        fail('ongeldig token', 401);
    }
    /* token = host_token (= sessions.token) OF guest_token */
    $st = db()->prepare('SELECT * FROM sessions WHERE (token=? OR guest_token=?) AND expires_at>?');
    $st->execute([$token, $token, time()]);
    $row = fetchRow($st);
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
    /* HOST: nieuwe sessie met DRIE codes (v0.5.0) — één per rol. */
    $code = newCode();
    $codeP1 = newCode([$code]);
    $codeP2 = newCode([$code, $codeP1]);
    $codeGuest = newCode([$code, $codeP1, $codeP2]);
    $hostToken = newToken();
    $now = time();
    $expiresAt = $now + (TTL_SESSION_HOURS * 3600);

    withRetry(function () use ($hostToken, $code, $codeP1, $codeP2, $codeGuest, $now, $expiresAt) {
        db()->prepare('INSERT INTO sessions(token, code, ctrl_code_p1, ctrl_code_p2,
                                            ctrl_code_guest, host_token, created_at, expires_at)
                       VALUES(?,?,?,?,?,?,?,?)')
            ->execute([$hostToken, $code, $codeP1, $codeP2, $codeGuest, $hostToken, $now, $expiresAt]);
        return true;
    });

    ok([
        'code' => $code,
        'ctrl_code_p1' => $codeP1,
        'ctrl_code_p2' => $codeP2,
        'host_token' => $hostToken,
        'expires_at' => $expiresAt,
    ]);
}

case 'pair-join': {
    /* GAST: join via de GASTCODE. Een joystickcode werkt hier bewust niet —
     * die hoort bij ctrl-join. */
    $code = requireCodeShape($in['code'] ?? '');

    /* Goedkope voorcontrole (read-only) — pas daarna het schrijfslot nemen. */
    $st = db()->prepare('SELECT token, expires_at FROM sessions WHERE code=? AND expires_at>?');
    $st->execute([$code, time()]);
    $pre = fetchRow($st);
    if (!$pre) {
        fail('code verlopen of onbekend');
    }

    /* v0.4.0: de code wordt NIET meer op NULL gezet — de sessie blijft leven
     * zolang de host hem niet stopt.
     *
     * v0.5.0: de controle op bezette controller-slots (de BUG-009-fix) is hier
     * VERVALLEN en dat is geen versoepeling maar een gevolg van het ontwerp: de
     * gastcode geeft alleen toegang tot de gastplek, en gast + telefoon-P2 worden
     * client-side ge-OR'd op speler 2. Er valt niets meer dubbel te bezetten, dus
     * ook niets meer te synchroniseren tussen twee endpoints.
     * fail() mag hier niet: dat doet exit() en zou de transactie open laten. */
    $guestToken = newToken();
    $res = inImmediateTransaction(function () use ($guestToken, $code) {
            $st = db()->prepare('SELECT token, guest_token, ctrl_code_guest, expires_at
                                 FROM sessions WHERE code=? AND expires_at>?');
            $st->execute([$code, time()]);
            $sess = fetchRow($st);
            if (!$sess) {
                return ['err' => ['code verlopen of onbekend', 400]];
            }
            if (!empty($sess['guest_token'])) {
                return ['err' => ['deze sessie is al bezet', 400]];
            }

            $st = db()->prepare("UPDATE sessions SET guest_token=?
                                 WHERE token=? AND (guest_token IS NULL OR guest_token='')");
            $st->execute([$guestToken, $sess['token']]);
            if ($st->rowCount() < 1) {
                return ['err' => ['deze sessie is al bezet', 400]];
            }
            return ['expires_at' => (int)$sess['expires_at'],
                    'ctrl_code_guest' => $sess['ctrl_code_guest']];
    });

    if (isset($res['err'])) {
        fail($res['err'][0], $res['err'][1]);
    }

    ok([
        'guest_token' => $guestToken,
        'expires_at' => $res['expires_at'],
        /* De gast krijgt zijn eigen joystickcode pas hier: vóór het joinen bestaat
         * hij niet en zou de code nergens naartoe kunnen. */
        'ctrl_code_guest' => $res['ctrl_code_guest'],
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
    if (!fetchVal($st)) {
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
    $pending = (int)fetchVal($st);
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
    if ((int)fetchVal($chk) === 0) {
        ok(['signals' => []]);
    }

    /* BUG-010: geen expliciete transactie meer in het hete pad. De SELECT is
     * read-only (geen slot) en de DELETE op exact de gelezen id's is als los
     * statement al atomair — alleen de eigen peer pollt dit target, dus er is
     * niets te serialiseren. Zo verdwijnt BEGIN IMMEDIATE uit de 2 Hz-lus. */
    $st = db()->prepare('SELECT id, type, payload FROM rtc_signals WHERE target_token=? ORDER BY id ASC');
    $st->execute([$token]);
    $rows = $st->fetchAll(PDO::FETCH_ASSOC);

    $result = [];
    $maxId = 0;
    foreach ($rows as $sig) {
        $result[] = ['type' => $sig['type'], 'payload' => $sig['payload']];
        $maxId = max($maxId, (int)$sig['id']);
    }
    if ($maxId > 0) {
        withRetry(function () use ($token, $maxId) {
            db()->prepare('DELETE FROM rtc_signals WHERE target_token=? AND id<=?')
                ->execute([$token, $maxId]);
            return true;
        });
    }

    ok(['signals' => $result]);
}

/* ---------------- telefoon-joysticks (controllers) ---------------- */

case 'ctrl-join': {
    /* Telefoon joint met een JOYSTICKCODE. De code bepaalt de plek:
     * ctrl_code_p1 -> slot 0 (speler 1), ctrl_code_p2 -> slot 1 (speler 2).
     * De server wijst dus niets meer toe en hoeft niet naar de gast te kijken:
     * de gastcode is een andere code, en op speler 2 worden gast en telefoon
     * client-side ge-OR'd. */
    $code = requireCodeShape($in['code'] ?? '');

    /* Eerst read-only vaststellen dát de code bestaat; pas daarna het schrijfslot
     * nemen. Vóór v0.4.0-Rusch opende élk verzoek met een willekeurige geldig
     * gevormde code eerst BEGIN IMMEDIATE en nam zo het enige schrijfslot van de
     * gedeelde SQLite-db, om vervolgens 400 te geven. */
    $st = db()->prepare('SELECT 1 FROM sessions
                         WHERE (ctrl_code_p1=:c OR ctrl_code_p2=:c OR ctrl_code_guest=:c)
                           AND expires_at>:now');
    $st->execute([':c' => $code, ':now' => time()]);
    if (!fetchVal($st)) {
        fail('code verlopen of onbekend');
    }

    $ctrlToken = newToken();
    $nowMs = nowMs();

    /* Atomair binnen BEGIN IMMEDIATE: de controle "is deze plek vrij?" en de
     * INSERT moeten in hetzelfde schrijfvenster zitten, anders koppelen twee
     * telefoons die tegelijk dezelfde code intikken allebei op dezelfde plek
     * (zelfde reden als BUG-007). Fouten worden als waarde teruggegeven, niet
     * als fail(): fail() doet exit en zou de transactie open laten staan. */
    $res = inImmediateTransaction(function () use ($code, $ctrlToken, $nowMs) {
            $st = db()->prepare('SELECT token, ctrl_code_p1, ctrl_code_p2, ctrl_code_guest,
                                        guest_token, expires_at
                                 FROM sessions
                                 WHERE (ctrl_code_p1=:c OR ctrl_code_p2=:c OR ctrl_code_guest=:c)
                                   AND expires_at>:now');
            $st->execute([':c' => $code, ':now' => time()]);
            $sess = fetchRow($st);
            if (!$sess) {
                return ['err' => ['code verlopen of onbekend', 400]];
            }

            /* De code bepaalt zowel de plek als de EIGENAAR. De gastcode geeft
              * slot 1 (de gast ís speler 2) maar aan de gast-kant, zodat hij niet
              * botst met een telefoon die de host op speler 2 heeft hangen. */
            if ($sess['ctrl_code_guest'] === $code) {
                $slot = 1;
                $owner = 'guest';
                if (empty($sess['guest_token'])) {
                    return ['err' => ['er is nog geen gast in deze sessie', 409]];
                }
            } else {
                $slot = ($sess['ctrl_code_p1'] === $code) ? 0 : 1;
                $owner = 'host';
            }

            /* Zit er al een telefoon op deze plek? Dan alleen overnemen als die
             * STIL is (geen ctrl-input binnen de TTL). Zonder die uitzondering
             * moet iemand wiens telefoon crashte of het scherm vergrendelde tot
             * 60 s wachten op de GC voordat hij weer kan koppelen — precies op
             * het moment dat hij snel terug wil in het spel. */
            $q = db()->prepare('SELECT token, updated_at FROM controllers
                                WHERE session_token=? AND slot=? AND owner=?');
            $q->execute([$sess['token'], $slot, $owner]);
            $cur = fetchRow($q);
            if ($cur) {
                if ($nowMs - (int)$cur['updated_at'] < CTRL_TTL_SECONDS * 1000) {
                    return ['err' => ['deze plek is al bezet door een telefoon', 409]];
                }
                db()->prepare('DELETE FROM controllers WHERE token=?')->execute([$cur['token']]);
            }

            db()->prepare('INSERT INTO controllers(token, session_token, slot, mask, updated_at, owner)
                           VALUES(?,?,?,0,?,?)')
                ->execute([$ctrlToken, $sess['token'], $slot, $nowMs, $owner]);
            return ['slot' => $slot, 'owner' => $owner, 'expires_at' => (int)$sess['expires_at']];
    });

    if (isset($res['err'])) {
        fail($res['err'][0], $res['err'][1]);
    }

    ok([
        'ctrl_token' => $ctrlToken,
        'slot' => $res['slot'],
        'owner' => $res['owner'],
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
    if (fetchVal($st) === false) {
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
    /* Host én gast mogen pollen, elk alleen de telefoons aan hun EIGEN kant
     * (v0.5.3). Een host-token levert owner='host', een gast-token owner='guest';
     * een controller-token matcht geen van beide. Volledig read-only, dus 10 Hz
     * pollen levert geen schrijfdruk op. */
    $token = requireTokenShape($in['token'] ?? '');
    $st = db()->prepare('SELECT token, host_token, guest_token FROM sessions
                         WHERE (token=? OR guest_token=?) AND expires_at>?');
    $st->execute([$token, $token, time()]);
    $sess = fetchRow($st);
    if (!$sess) {
        fail('alleen de host of de gast mag pollen', 401);
    }
    $owner = hash_equals((string)$sess['host_token'], $token) ? 'host' : 'guest';

    $nowMs = nowMs();
    $q = db()->prepare('SELECT slot, mask, updated_at FROM controllers
                        WHERE session_token=? AND owner=? AND slot>=0 AND slot<? ORDER BY slot');
    $q->execute([$sess['token'], $owner, CTRL_SLOTS]);

    $controllers = [];
    foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $controllers[] = [
            'slot' => (int)$row['slot'],
            'mask' => (int)$row['mask'],
            'age_ms' => max(0, $nowMs - (int)$row['updated_at']),
        ];
    }

    ok(['controllers' => $controllers, 'owner' => $owner]);
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
