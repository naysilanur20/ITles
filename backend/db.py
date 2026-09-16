import hashlib
import json
import os
import secrets
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path


PASSWORD_ITERATIONS = 600_000
LEGACY_PASSWORD_ITERATIONS = 310_000
ACCOUNT_SCHEMA_VERSION = 3
ACTIVATION_CODE_TTL = timedelta(hours=72)


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def connect(path: str) -> sqlite3.Connection:
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = FULL")
    if path != ":memory:" and not path.startswith("file:"):
        os.chmod(path, 0o600)
    return conn


def initialize(conn: sqlite3.Connection) -> None:
    try:
        _initialize(conn)
    except BaseException:
        conn.rollback()
        raise


def _initialize(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, account TEXT NOT NULL UNIQUE,
          password_hash TEXT, is_demo INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS machines (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          name TEXT NOT NULL, model TEXT, head TEXT, computer TEXT
        );
        CREATE TABLE IF NOT EXISTS device_tokens (
          token_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          machine_id TEXT NOT NULL REFERENCES machines(id), created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ingest_batches (
          organization_id TEXT NOT NULL, machine_id TEXT NOT NULL, batch_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL, received_at TEXT NOT NULL,
          PRIMARY KEY (organization_id, machine_id, batch_id)
        );
        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, machine_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL, kind TEXT NOT NULL, payload_hash TEXT NOT NULL,
          canonical_payload TEXT NOT NULL, received_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS measurements (
          event_id TEXT NOT NULL REFERENCES events(event_id), machine_id TEXT NOT NULL,
          metric_key TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL, observed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS measurements_latest ON measurements(machine_id, metric_key, observed_at DESC);
        CREATE TABLE IF NOT EXISTS positions (
          event_id TEXT PRIMARY KEY REFERENCES events(event_id), machine_id TEXT NOT NULL,
          latitude REAL NOT NULL, longitude REAL NOT NULL, observed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS positions_track ON positions(machine_id, observed_at);
        CREATE TABLE IF NOT EXISTS production (
          event_id TEXT PRIMARY KEY REFERENCES events(event_id), machine_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL, volume_micro_m3 INTEGER NOT NULL, basis TEXT NOT NULL,
          source TEXT NOT NULL, method TEXT NOT NULL, method_version TEXT NOT NULL,
          calibration_ref TEXT
        );
        CREATE INDEX IF NOT EXISTS production_period ON production(machine_id, occurred_at);
        CREATE TABLE IF NOT EXISTS ingest_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, machine_id TEXT,
          received_at TEXT NOT NULL, status TEXT NOT NULL, reason TEXT
        );
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          login TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')),
          password_hash TEXT, status TEXT NOT NULL CHECK(status IN ('active','pending','revoked')),
          created_at TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0,
          legacy_access INTEGER NOT NULL DEFAULT 0,
          UNIQUE(organization_id,login)
        );
        CREATE INDEX IF NOT EXISTS users_organization ON users(organization_id,login);
        CREATE TABLE IF NOT EXISTS user_sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
          organization_id TEXT NOT NULL REFERENCES organizations(id), expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS user_sessions_user ON user_sessions(user_id,expires_at);
        CREATE TABLE IF NOT EXISTS activation_codes (
          user_id TEXT PRIMARY KEY REFERENCES users(id), code_hash TEXT NOT NULL,
          expires_at TEXT NOT NULL, issued_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS recovery_codes (
          user_id TEXT PRIMARY KEY REFERENCES users(id), code_hash TEXT NOT NULL,
          expires_at TEXT NOT NULL, issued_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS onboarding (
          organization_id TEXT PRIMARY KEY REFERENCES organizations(id), step TEXT NOT NULL,
          users_configured INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS machine_sources (
          machine_id TEXT PRIMARY KEY REFERENCES machines(id),
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          model TEXT, computer TEXT, software_version TEXT,
          source_kind TEXT NOT NULL CHECK(source_kind IN ('unconfigured','normalized_json','unsupported')),
          export_description TEXT, permission_confirmed INTEGER NOT NULL DEFAULT 0,
          reviewed_at TEXT, saved_at TEXT NOT NULL, reviewed_event_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS machine_sources_organization ON machine_sources(organization_id);
        CREATE TABLE IF NOT EXISTS device_token_metadata (
          token_hash TEXT PRIMARY KEY REFERENCES device_tokens(token_hash) ON DELETE CASCADE,
          id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
        );
        """
    )
    production_columns = {row["name"] for row in conn.execute("PRAGMA table_info(production)")}
    if "method_version" not in production_columns:
        conn.execute("ALTER TABLE production ADD COLUMN method_version TEXT NOT NULL DEFAULT 'unknown'")
    if "calibration_ref" not in production_columns:
        conn.execute("ALTER TABLE production ADD COLUMN calibration_ref TEXT")
    user_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
    if "legacy_access" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN legacy_access INTEGER NOT NULL DEFAULT 0")
    source_columns = {row["name"] for row in conn.execute("PRAGMA table_info(machine_sources)")}
    if "reviewed_event_count" not in source_columns:
        conn.execute("ALTER TABLE machine_sources ADD COLUMN reviewed_event_count INTEGER NOT NULL DEFAULT 0")
    # Fixed precision keeps chronological TEXT ordering valid across old and new rows.
    for table, columns in {
        "device_tokens": ("created_at",), "sessions": ("expires_at",),
        "user_sessions": ("expires_at",), "activation_codes": ("expires_at", "issued_at"),
        "recovery_codes": ("expires_at", "issued_at"), "onboarding": ("updated_at",),
        "machine_sources": ("reviewed_at", "saved_at"), "device_token_metadata": ("created_at",),
        "ingest_batches": ("received_at",), "events": ("occurred_at", "received_at"),
        "measurements": ("observed_at",), "positions": ("observed_at",),
        "production": ("occurred_at",), "ingest_audit": ("received_at",),
    }.items():
        for column in columns:
            conn.execute(f"UPDATE {table} SET {column}=substr({column},1,19)||'.000000Z' WHERE length({column})=20 AND {column} LIKE '%Z'")

    # A shared company password cannot establish who owns administrative rights.
    migration = conn.execute("SELECT 1 FROM schema_migrations WHERE version=?", (ACCOUNT_SCHEMA_VERSION,)).fetchone()
    if not migration:
        conn.execute("DELETE FROM sessions WHERE organization_id IN (SELECT id FROM organizations WHERE is_demo=0)")
        provisional_admins = "SELECT id FROM users WHERE id='legacy-admin-' || organization_id"
        for table in ("user_sessions", "activation_codes", "recovery_codes"):
            conn.execute(f"DELETE FROM {table} WHERE user_id IN ({provisional_admins})")
        conn.execute(f"UPDATE users SET status='revoked',password_hash=NULL WHERE id IN ({provisional_admins})")
        conn.execute(
            "INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
            (ACCOUNT_SCHEMA_VERSION, iso(utcnow())),
        )
    conn.execute(
        """INSERT OR IGNORE INTO users(id,organization_id,login,role,password_hash,status,created_at,legacy_access)
           SELECT 'legacy-reader-' || id,id,'legacy','user',password_hash,'active',?,1
           FROM organizations WHERE is_demo=0 AND password_hash IS NOT NULL""",
        (iso(utcnow()),),
    )
    # Old device tokens remain valid and scoped to their original machine. A
    # separate random public id lets the UI list a revocable token without ever
    # exposing its bearer value or stored hash.
    for token in conn.execute("SELECT token_hash,created_at FROM device_tokens"):
        conn.execute(
            "INSERT OR IGNORE INTO device_token_metadata(token_hash,id,created_at) VALUES(?,?,?)",
            (token["token_hash"], new_id(), token["created_at"]),
        )
    conn.commit()


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def password_hash(password: str, salt: str | None = None, *, iterations: int = PASSWORD_ITERATIONS) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations)
    return f"pbkdf2_sha256${iterations}${salt}${digest.hex()}"


def password_matches(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        parts = stored.split("$")
        if len(parts) == 4:
            algorithm, iterations_raw, salt, digest = parts
            iterations = int(iterations_raw)
        elif len(parts) == 3:
            # Pre-account databases used this unversioned 310k format.
            algorithm, salt, digest = parts
            iterations = LEGACY_PASSWORD_ITERATIONS
        else:
            return False
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256" or iterations < LEGACY_PASSWORD_ITERATIONS or iterations > 2_000_000:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations).hex()
    return secrets.compare_digest(actual, digest)


def password_needs_upgrade(stored: str | None) -> bool:
    """Whether a successful login should replace a legacy PBKDF2 work factor."""

    if not stored:
        return True
    parts = stored.split("$")
    if len(parts) == 3:
        return True
    if len(parts) != 4:
        return True
    try:
        return int(parts[1]) < PASSWORD_ITERATIONS
    except ValueError:
        return True


def canonical_hash(value: object) -> tuple[str, str]:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest(), canonical


def new_id() -> str:
    return secrets.token_urlsafe(18)


def issue_activation_code(conn: sqlite3.Connection, user_id: str) -> tuple[str, str]:
    code = secrets.token_urlsafe(24)
    now = utcnow()
    expires_at = iso(now + ACTIVATION_CODE_TTL)
    conn.execute("DELETE FROM activation_codes WHERE user_id=?", (user_id,))
    conn.execute(
        "INSERT INTO activation_codes(user_id,code_hash,expires_at,issued_at) VALUES(?,?,?,?)",
        (user_id, hash_secret(code), expires_at, iso(now)),
    )
    return code, expires_at


def default_db_path() -> str:
    return os.getenv("ITLES_DB_PATH", ".local/itles.sqlite3")
