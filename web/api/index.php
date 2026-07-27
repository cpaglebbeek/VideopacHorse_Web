<?php
/**
 * VideopacHorse Pairing API — v0.3.0 Videopac-Pioneer
 *
 * WebRTC P2P multiplayer signaling voor 🎭 Samen spelen.
 * Twee gebruikers pairen via 6-tekens code, WebRTC handshake via signal-queue,
 * daarna gaat alle media P2P (canvas-stream host → gast, gast-input via DataChannel).
 * Server ziet ALLEEN SDP/ICE (geen media-content).
 *
 * Endpoints (POST JSON):
 *   pair-create       -> {code, host_token}; TTL 10 min code, 4 uur sessie
 *   pair-join {code}  -> {guest_token}; code single-use
 *   rtc-signal-send {token, type, payload} -> {ok}
 *   rtc-signal-poll {token} -> {signals: [{type, payload}]}; delete after delivery
 *
 * Storage: SQLite op /var/lib/videopac/pairing.db (buiten webroot).
 * GC: opportunistisch per request (TTL cleanup + orphan removal).
 * Anti-spam: max 50 pending signals per target_token.
 */
declare(strict_types=1);

const DB_PATH = '/var/lib/videopac/pairing.db';
const TTL_CODE_MINUTES = 10;           // Code geldig 10 minuten
const TTL_SESSION_HOURS = 4;           // Sessie 4 uur
const RTC_SIGNAL_LIMIT = 32768;        // Max 32 KB per signal (SDP ~4-8KB)
const RTC_QUEUE_MAX = 50;              // Max pending signals per target
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';  // 34 chars
const CODE_LEN = 6;

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
    db()->prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
        ->execute(['last_gc', $now]);
    // Verwijder verlopen sessies
    db()->prepare('DELETE FROM sessions WHERE expires_at < ?')->execute([$now]);
    // Verwijder signals waarvan target/sender niet meer leeft
    /* Levende tokens = host_token EN guest_token (niet alleen sessions.token,
     * anders wist de GC elk gast-signaal direct — BUG-003). */
    db()->exec("DELETE FROM rtc_signals WHERE sender_token NOT IN
                   (SELECT host_token FROM sessions
                    UNION SELECT guest_token FROM sessions WHERE guest_token IS NOT NULL)
               OR target_token NOT IN
                   (SELECT host_token FROM sessions
                    UNION SELECT guest_token FROM sessions WHERE guest_token IS NOT NULL)");
}

function newCode(): string {
    $alphabet = CODE_ALPHABET;
    $len = strlen($alphabet);

    for ($attempt = 0; $attempt < 12; $attempt++) {
        $code = '';
        for ($i = 0; $i < CODE_LEN; $i++) {
            $code .= $alphabet[random_int(0, $len - 1)];
        }

        // Check unique + not expired
        $st = db()->prepare('SELECT 1 FROM sessions WHERE code=? AND expires_at>?');
        $st->execute([$code, time()]);
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
 * 25 pogingen x ~40 ms = max ~1 s, daarna nette 503 i.p.v. fatale fout. */
function withRetry(callable $fn) {
    $last = null;
    for ($i = 0; $i < 25; $i++) {
        try {
            return $fn();
        } catch (PDOException $e) {
            $msg = $e->getMessage();
            if (stripos($msg, 'locked') === false && stripos($msg, 'busy') === false) {
                throw $e;
            }
            $last = $e;
            usleep(40000);
        }
    }
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
    $code = $in['code'] ?? '';
    if (!is_string($code) || strlen($code) !== CODE_LEN) {
        fail('ongeldige code');
    }

    $st = db()->prepare('SELECT * FROM sessions WHERE code=? AND expires_at>?');
    $st->execute([$code, time()]);
    $sess = $st->fetch(PDO::FETCH_ASSOC);

    if (!$sess) {
        fail('code verlopen of onbekend');
    }

    if (!empty($sess['guest_token'])) {
        fail('deze sessie is al bezet');
    }

    // Creëer guest-sessie met dezelfde TTL
    $guestToken = newToken();
    withRetry(function () use ($guestToken, $sess) {
        db()->prepare('UPDATE sessions SET guest_token=?, code=NULL WHERE token=?')
            ->execute([$guestToken, $sess['token']]);
        return true;
    });

    ok([
        'guest_token' => $guestToken,
        'expires_at' => (int)$sess['expires_at'],
    ]);
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

default:
    fail('onbekende actie', 400);

}
