import csv
import io
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from collections import deque
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Iterator
from urllib.parse import urlsplit

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse

from .db import (
    canonical_hash, connect, default_db_path, hash_secret, initialize, iso, issue_activation_code, new_id,
    password_hash, password_matches, password_needs_upgrade, utcnow,
)
from .schemas import (
    ActivationRequest, CompanyPatch, DeviceTokenRequest, IngestBatch, LoginRequest,
    MachineCreateRequest, METRICS, OnboardingPatch, PasswordChangeRequest,
    RecoveryCodeRequest, RecoveryRequest, RegisterRequest, SourcePatch, SourceReviewRequest, UserCreateRequest,
)
from .seed import DEMO_ACCOUNT, DEMO_EVENT_IDS, DemoSeedConflictError, seed_demo

SESSION_COOKIE = "itles_session"
FRESH_TTL = timedelta(hours=2)
MAX_INGEST_BYTES = 512 * 1024
MAX_ACCOUNT_BYTES = 16 * 1024
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LOGIN_LIMIT = 5
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_LOCK_SECONDS = 15 * 60
LOGIN_TRACKED_ACCOUNTS = 1024
AUTH_GLOBAL_LIMIT = 120
AUTH_GLOBAL_WINDOW_SECONDS = 15 * 60
DEMO_LOGIN_LIMIT = 20
DEMO_LOGIN_WINDOW_SECONDS = 10 * 60
DEMO_SESSION_CAP = 128
DEMO_SESSION_SECONDS = 3600
USER_SESSION_SECONDS = 7 * 86400
RECOVERY_CODE_TTL = timedelta(days=30)
DUMMY_PASSWORD_HASH = "pbkdf2_sha256$9e347f8194a6f1de7b8ce4477dceff8a$7f293bd9efbc9f3cd24f5a75a8ad099bd1d2f8ae283e550cbfc6d68d4ba6653f"


class LoginLimiter:
    """Process-local, bounded account-code throttle; it intentionally stores no IP addresses."""

    def __init__(self):
        self._records: dict[str, tuple[int, float, float]] = {}
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        self._records = {key: value for key, value in self._records.items() if value[2] > now or value[1] > now - LOGIN_WINDOW_SECONDS}
        if len(self._records) > LOGIN_TRACKED_ACCOUNTS:
            oldest = sorted(self._records, key=lambda key: self._records[key][1])[:len(self._records) - LOGIN_TRACKED_ACCOUNTS]
            for key in oldest:
                self._records.pop(key, None)

    def allowed(self, account: str) -> bool:
        now = time.monotonic()
        with self._lock:
            self._prune(now)
            record = self._records.get(hash_secret(account))
            return not record or record[2] <= now

    def failed(self, account: str) -> None:
        now = time.monotonic()
        key = hash_secret(account)
        with self._lock:
            self._prune(now)
            previous = self._records.get(key)
            failures = previous[0] + 1 if previous and previous[1] > now - LOGIN_WINDOW_SECONDS else 1
            blocked_until = now + LOGIN_LOCK_SECONDS if failures >= LOGIN_LIMIT else 0.0
            self._records[key] = (failures, now, blocked_until)

    def succeeded(self, account: str) -> None:
        with self._lock:
            self._records.pop(hash_secret(account), None)


class DemoLoginLimiter:
    """Global process-local limit for an intentionally public demo endpoint."""

    def __init__(self):
        self._attempts: deque[float] = deque()
        self._lock = threading.Lock()

    def allowed(self) -> bool:
        now = time.monotonic()
        with self._lock:
            while self._attempts and self._attempts[0] <= now - DEMO_LOGIN_WINDOW_SECONDS:
                self._attempts.popleft()
            if len(self._attempts) >= DEMO_LOGIN_LIMIT:
                return False
            self._attempts.append(now)
            return True


LOGIN_LIMITER = LoginLimiter()
REGISTRATION_LIMITER = LoginLimiter()
ACTIVATION_LIMITER = LoginLimiter()
RECOVERY_LIMITER = LoginLimiter()
REAUTH_LIMITER = LoginLimiter()
DEMO_LOGIN_LIMITER = DemoLoginLimiter()


class AuthBudget:
    """Bound total authentication work so identifier spraying cannot grow unbounded."""

    def __init__(self):
        self._attempts: deque[float] = deque()
        self._lock = threading.Lock()

    def allowed(self) -> bool:
        now = time.monotonic()
        with self._lock:
            while self._attempts and self._attempts[0] <= now - AUTH_GLOBAL_WINDOW_SECONDS:
                self._attempts.popleft()
            if len(self._attempts) >= AUTH_GLOBAL_LIMIT:
                return False
            self._attempts.append(now)
            return True


AUTH_BUDGET = AuthBudget()


def _demo_enabled() -> bool:
    return os.getenv("ITLES_DEMO_ENABLED", "0").lower() in {"1", "true", "yes"}


def _registration_enabled() -> bool:
    return os.getenv("ITLES_REGISTRATION_ENABLED", "1").lower() in {"1", "true", "yes"}


class ApiRequestGuardMiddleware:
    """Check browser mutation origin and bounds before FastAPI parses JSON bodies."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/") or scope["method"] in {"GET", "HEAD", "OPTIONS"}:
            await self.app(scope, receive, send)
            return

        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        is_ingest = scope["path"] == "/api/ingest"
        if not is_ingest:
            origin = headers.get("origin")
            host = headers.get("host", "")
            try:
                parsed_origin = urlsplit(origin) if origin else None
                foreign_origin = parsed_origin is not None and (
                    parsed_origin.scheme not in {"http", "https"} or parsed_origin.netloc != host
                    or bool(parsed_origin.path or parsed_origin.query or parsed_origin.fragment)
                )
            except ValueError:
                foreign_origin = True
            if headers.get("sec-fetch-site") == "cross-site" or foreign_origin:
                await JSONResponse({"detail": "cross-origin mutation is not allowed"}, status_code=403)(scope, receive, send)
                return
        try:
            declared_size = int(headers.get("content-length", "0"))
        except ValueError:
            await JSONResponse({"detail": "invalid request body length"}, status_code=400)(scope, receive, send)
            return
        maximum = MAX_INGEST_BYTES if is_ingest else MAX_ACCOUNT_BYTES
        if declared_size < 0 or declared_size > maximum:
            await JSONResponse({"detail": "request body is too large"}, status_code=413)(scope, receive, send)
            return
        messages = []
        size = 0
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] == "http.request":
                size += len(message.get("body", b""))
                if size > maximum:
                    await JSONResponse({"detail": "request body is too large"}, status_code=413)(scope, receive, send)
                    return
                if not message.get("more_body", False):
                    break
            elif message["type"] == "http.disconnect":
                break

        content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
        # Content-Length is advisory. Check the buffered byte count too so a
        # chunked or malformed request cannot bypass the JSON boundary.
        if (is_ingest or size) and content_type != "application/json":
            await JSONResponse({"detail": "JSON content type is required"}, status_code=415)(scope, receive, send)
            return

        index = 0

        async def replay():
            nonlocal index
            if index < len(messages):
                message = messages[index]
                index += 1
                return message
            return {"type": "http.disconnect"}

        await self.app(scope, replay, send)


def _date_range(start: str | None, end: str | None) -> tuple[date, date]:
    try:
        if (start is not None and not DATE_PATTERN.fullmatch(start)) or (end is not None and not DATE_PATTERN.fullmatch(end)):
            raise ValueError
        start_date = date.fromisoformat(start) if start else utcnow().date()
        end_date = date.fromisoformat(end) if end else start_date
    except ValueError as exc:
        raise HTTPException(422, "start and end must be YYYY-MM-DD") from exc
    if end_date < start_date or (end_date - start_date).days > 3660:
        raise HTTPException(422, "invalid date range")
    return start_date, end_date


def _bounds(start: date, end: date) -> tuple[str, str]:
    if end == date.max:
        raise HTTPException(422, "end date is outside the supported range")
    begin = datetime.combine(start, datetime.min.time(), UTC)
    finish = datetime.combine(end + timedelta(days=1), datetime.min.time(), UTC)
    return iso(begin), iso(finish)


def _decimal(micro: int) -> str:
    return format(Decimal(micro) / Decimal(1_000_000), ".6f")


def _metric_value(row: sqlite3.Row | None, key: str) -> dict:
    label, unit, _, _ = METRICS[key]
    if row is None:
        return {"key": key, "label": label, "value": None, "unit": unit, "observed_at": None,
                "status": "missing", "source": "telemetry", "explanation": "Показатель не поступал.",
                "norm": None}
    observed = datetime.fromisoformat(row["observed_at"].replace("Z", "+00:00"))
    status = "fresh" if utcnow() - observed <= FRESH_TTL else "stale"
    return {"key": key, "label": label, "value": row["value"], "unit": row["unit"],
            "observed_at": row["observed_at"], "status": status, "source": "telemetry",
            "explanation": "Норматив не задан: он зависит от конкретной машины, узла и документации.",
            "norm": None}


def _machine_payload(conn: sqlite3.Connection, organization_id: str, machine: sqlite3.Row) -> dict:
    latest: dict[str, sqlite3.Row] = {}
    for row in conn.execute(
        "SELECT * FROM measurements WHERE machine_id=? ORDER BY observed_at DESC, event_id DESC",
        (machine["id"],),
    ):
        latest.setdefault(row["metric_key"], row)
    position = conn.execute("SELECT * FROM positions WHERE machine_id=? ORDER BY observed_at DESC LIMIT 1", (machine["id"],)).fetchone()
    message_times = conn.execute(
        "SELECT MAX(occurred_at) observed,MAX(received_at) received FROM events WHERE organization_id=? AND machine_id=?",
        (organization_id, machine["id"]),
    ).fetchone()
    seen = message_times["observed"]
    received = conn.execute(
        "SELECT MAX(received_at) FROM ingest_audit WHERE organization_id=? AND machine_id=? AND status IN ('accepted','duplicates')",
        (organization_id, machine["id"]),
    ).fetchone()[0] or message_times["received"]
    position_payload = None
    if position:
        observed = datetime.fromisoformat(position["observed_at"].replace("Z", "+00:00"))
        position_payload = {"latitude": position["latitude"], "longitude": position["longitude"],
                            "observed_at": position["observed_at"], "status": "fresh" if utcnow() - observed <= FRESH_TTL else "stale"}
    connection_status = "fresh" if seen and utcnow() - datetime.fromisoformat(seen.replace("Z", "+00:00")) <= FRESH_TTL else ("stale" if seen else "missing")
    return {"id": machine["id"], "name": machine["name"], "model": machine["model"], "head": machine["head"],
            "computer": machine["computer"], "connection_status": connection_status,
            "metrics": [_metric_value(latest.get(key), key) for key in METRICS], "position": position_payload,
            "last_seen": seen, "last_received_at": received}


def _totals(conn: sqlite3.Connection, organization_id: str, start: date, end: date, machine_id: str | None = None) -> list[dict]:
    begin, finish = _bounds(start, end)
    where = "e.organization_id=? AND p.occurred_at>=? AND p.occurred_at<?"
    values: list[str] = [organization_id, begin, finish]
    if machine_id:
        where += " AND p.machine_id=?"
        values.append(machine_id)
    rows = conn.execute(f"""SELECT p.basis, COALESCE(SUM(p.volume_micro_m3),0) volume, COUNT(*) records,
                                   GROUP_CONCAT(DISTINCT p.source) sources,
                                   GROUP_CONCAT(DISTINCT p.method) methods,
                                   GROUP_CONCAT(DISTINCT p.method_version) method_versions,
                                   GROUP_CONCAT(DISTINCT p.calibration_ref) calibration_refs
                            FROM production p JOIN events e ON e.event_id=p.event_id
                            WHERE {where} GROUP BY p.basis ORDER BY p.basis""", values).fetchall()
    results = []
    for row in rows:
        provenance = {
            "sources": sorted((row["sources"] or "").split(",") if row["sources"] else []),
            "methods": sorted((row["methods"] or "").split(",") if row["methods"] else []),
            "method_versions": sorted((row["method_versions"] or "").split(",") if row["method_versions"] else []),
            "calibration_refs": sorted((row["calibration_refs"] or "").split(",") if row["calibration_refs"] else []),
        }
        warnings = []
        if "unknown" in provenance["method_versions"]:
            warnings.append("Есть записи с неизвестной версией метода; они не подтверждают физическую точность объёма.")
        if len(provenance["methods"]) > 1 or len(provenance["method_versions"]) > 1:
            warnings.append("В итоге смешаны методы или версии расчёта. Сумма арифметическая; сопоставимость методик не подтверждена.")
        if len(provenance["sources"]) > 1:
            warnings.append("В итоге смешаны источники. Требуется сверка, чтобы исключить повторный учёт одной выработки.")
        results.append({"basis": row["basis"], "volume_m3": _decimal(row["volume"]), "records": row["records"],
                        "provenance": provenance, "warnings": warnings})
    return results


def _engine_hours_for_period(conn: sqlite3.Connection, machine_id: str, start: date, end: date) -> float | None:
    begin, finish = _bounds(start, end)
    rows = conn.execute(
        """SELECT value FROM measurements WHERE machine_id=? AND metric_key='engine_hours_total'
           AND observed_at>=? AND observed_at<? ORDER BY observed_at, event_id""",
        (machine_id, begin, finish),
    ).fetchall()
    if len(rows) < 2:
        return None
    values = [float(row["value"]) for row in rows]
    if any(current < previous for previous, current in zip(values, values[1:])):
        return None
    return values[-1] - values[0]


def _has_engine_hour_reset(conn: sqlite3.Connection, organization_id: str) -> bool:
    rows = conn.execute(
        """SELECT m.machine_id,m.value FROM measurements m JOIN machines machine ON machine.id=m.machine_id
           WHERE machine.organization_id=? AND m.metric_key='engine_hours_total'
           ORDER BY m.machine_id,m.observed_at,m.event_id""",
        (organization_id,),
    ).fetchall()
    latest_by_machine: dict[str, float] = {}
    for row in rows:
        previous = latest_by_machine.get(row["machine_id"])
        current = float(row["value"])
        if previous is not None and current < previous:
            return True
        latest_by_machine[row["machine_id"]] = current
    return False


def _machine_identity(machine: sqlite3.Row) -> dict:
    return {
        "id": machine["id"], "name": machine["name"], "model": machine["model"],
        "head": machine["head"], "computer": machine["computer"],
    }


def _onboarding_payload(conn: sqlite3.Connection, organization_id: str) -> dict:
    machine_added = conn.execute(
        "SELECT 1 FROM machines WHERE organization_id=? LIMIT 1", (organization_id,)
    ).fetchone() is not None
    source_configured = conn.execute(
        """SELECT 1 FROM machine_sources source JOIN machines machine ON machine.id=source.machine_id
           WHERE source.organization_id=? AND machine.organization_id=?
             AND source.source_kind='normalized_json' AND source.permission_confirmed=1
             AND EXISTS (SELECT 1 FROM device_tokens token WHERE token.machine_id=source.machine_id
                         AND token.organization_id=source.organization_id) LIMIT 1""",
        (organization_id, organization_id),
    ).fetchone() is not None
    data_received = conn.execute(
        "SELECT 1 FROM events WHERE organization_id=? LIMIT 1", (organization_id,),
    ).fetchone() is not None
    data_reviewed = conn.execute(
        "SELECT 1 FROM machine_sources WHERE organization_id=? AND reviewed_at IS NOT NULL AND reviewed_event_count>0 LIMIT 1",
        (organization_id,),
    ).fetchone() is not None
    first_machine_ready = conn.execute(
        """SELECT 1 FROM machine_sources source WHERE organization_id=?
           AND source_kind='normalized_json' AND permission_confirmed=1 AND reviewed_event_count>0
           AND EXISTS (SELECT 1 FROM device_tokens token WHERE token.machine_id=source.machine_id
                       AND token.organization_id=source.organization_id) LIMIT 1""", (organization_id,),
    ).fetchone() is not None
    saved = conn.execute(
        "SELECT step,users_configured FROM onboarding WHERE organization_id=?", (organization_id,)
    ).fetchone()
    users_configured = bool(saved["users_configured"]) if saved else False
    if saved:
        step = saved["step"]
    elif not machine_added:
        step = "machine"
    elif not users_configured:
        step = "users"
    elif not source_configured:
        step = "source"
    else:
        step = "complete"
    return {
        "completed": users_configured and first_machine_ready,
        "step": step,
        "machine_added": machine_added,
        "users_configured": users_configured,
        "source_configured": source_configured,
        "data_received": data_received,
        "data_reviewed": data_reviewed,
    }


def _source_payload(conn: sqlite3.Connection, organization_id: str, machine: sqlite3.Row) -> dict:
    source = conn.execute(
        "SELECT * FROM machine_sources WHERE machine_id=? AND organization_id=?",
        (machine["id"], organization_id),
    ).fetchone()
    # Metadata is separate from bearer-token hashes. It is backfilled here for
    # a token created by a pre-v2 CLI without ever returning that credential.
    tokens = []
    for token in conn.execute(
        """SELECT token.token_hash,token.created_at,metadata.id FROM device_tokens token
           LEFT JOIN device_token_metadata metadata ON metadata.token_hash=token.token_hash
           WHERE token.organization_id=? AND token.machine_id=? ORDER BY token.created_at DESC""",
        (organization_id, machine["id"]),
    ):
        token_id = token["id"]
        if not token_id:
            token_id = new_id()
            conn.execute(
                "INSERT OR IGNORE INTO device_token_metadata(token_hash,id,created_at) VALUES(?,?,?)",
                (token["token_hash"], token_id, token["created_at"]),
            )
        tokens.append({"id": token_id, "created_at": token["created_at"]})

    facts = conn.execute(
        """SELECT COUNT(*) message_count,MAX(received_at) last_received_at,MAX(occurred_at) last_observed_at
           FROM events WHERE organization_id=? AND machine_id=?""",
        (organization_id, machine["id"]),
    ).fetchone()
    last_position = conn.execute(
        "SELECT MAX(observed_at) value FROM positions WHERE machine_id=?", (machine["id"],)
    ).fetchone()["value"]
    message_count = facts["message_count"]
    last_received = facts["last_received_at"]
    last_received = conn.execute(
        "SELECT MAX(received_at) FROM ingest_audit WHERE organization_id=? AND machine_id=? AND status IN ('accepted','duplicates')",
        (organization_id, machine["id"]),
    ).fetchone()[0] or last_received
    last_observed = facts["last_observed_at"]
    reviewed_at = source["reviewed_at"] if source else None
    source_kind = source["source_kind"] if source else "unconfigured"

    def stale(value: str | None) -> bool:
        if not value:
            return False
        try:
            return utcnow() - datetime.fromisoformat(value.replace("Z", "+00:00")) > FRESH_TTL
        except ValueError:
            return True

    if not source:
        state = "added"
    elif source_kind != "normalized_json" or not source["permission_confirmed"]:
        state = "source_unconfigured"
    elif not message_count and not tokens:
        state = "source_unconfigured"
    elif not message_count:
        state = "awaiting_message"
    elif stale(last_observed) or stale(last_received):
        # A recently delivered file can still contain stale observations.
        state = "stale"
    elif not reviewed_at or source["reviewed_event_count"] < message_count:
        state = "review_required"
    else:
        state = "message_received"

    return {
        "machine": _machine_identity(machine),
        "onboarding": _onboarding_payload(conn, organization_id),
        "source": {
            "model": source["model"] if source else machine["model"],
            "computer": source["computer"] if source else machine["computer"],
            "software_version": source["software_version"] if source else None,
            "source_kind": source_kind,
            "export_description": source["export_description"] if source else None,
            "permission_confirmed": bool(source["permission_confirmed"]) if source else False,
        },
        "connection": {
            "state": state, "last_received_at": last_received, "last_observed_at": last_observed,
            "last_position_at": last_position, "reviewed_at": reviewed_at, "message_count": message_count,
        },
        "tokens": tokens,
    }


def create_app(db_path: str | None = None) -> FastAPI:
    app = FastAPI(title="ITles telemetry API", version="2.0", docs_url=None, redoc_url=None)
    app.add_middleware(ApiRequestGuardMiddleware)
    app.state.db_path = db_path or default_db_path()
    init_lock = threading.Lock()
    initialized = False

    @contextmanager
    def db() -> Iterator[sqlite3.Connection]:
        nonlocal initialized
        with init_lock:
            if not initialized:
                connection = connect(app.state.db_path)
                try:
                    initialize(connection)
                finally:
                    connection.close()
                initialized = True
        current = connect(app.state.db_path)
        try:
            yield current
            current.commit()
        except Exception:
            current.rollback()
            raise
        finally:
            current.close()

    def audit(conn: sqlite3.Connection, org: str, machine: str | None, status: str, reason: str | None = None) -> None:
        conn.execute("INSERT INTO ingest_audit(organization_id,machine_id,received_at,status,reason) VALUES(?,?,?,?,?)",
                     (org, machine, iso(utcnow()), status, reason))

    @app.middleware("http")
    async def api_diagnostics(request: Request, call_next):
        request_id = secrets.token_urlsafe(12)
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        response.headers["X-ITles-Version"] = app.version
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(sqlite3.OperationalError)
    async def database_unavailable(_request: Request, _exc: sqlite3.OperationalError):
        return JSONResponse({"detail": "service temporarily unavailable", "code": "database_unavailable"}, status_code=503)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, _exc: RequestValidationError):
        # Never echo rejected payloads: they may contain data that must not be retained or exposed.
        if request.url.path == "/api/ingest":
            authorization = request.headers.get("authorization", "")
            if authorization.startswith("Bearer "):
                token = authorization.removeprefix("Bearer ").strip()
                if token and len(token) <= 512:
                    with db() as conn:
                        identity = conn.execute(
                            "SELECT organization_id,machine_id FROM device_tokens WHERE token_hash=?",
                            (hash_secret(token),),
                        ).fetchone()
                        if identity:
                            audit(conn, identity["organization_id"], identity["machine_id"], "rejected", "invalid_schema")
            return JSONResponse({"detail": "invalid ingest schema"}, status_code=422)
        return JSONResponse({"detail": "invalid request"}, status_code=422)

    def permit_auth_attempt(limiter: LoginLimiter, identifier: str) -> None:
        if not limiter.allowed(identifier) or not AUTH_BUDGET.allowed():
            raise HTTPException(429, "too many authentication attempts; try again later")

    def current_session(itles_session: str | None = Cookie(default=None)) -> dict:
        if not itles_session:
            raise HTTPException(401, "authentication required")
        token_hash = hash_secret(itles_session)
        now = iso(utcnow())
        with db() as conn:
            row = conn.execute(
                """SELECT o.id,o.name,o.account,o.is_demo,session.expires_at,
                          user.id user_id,user.login,user.role,user.must_change_password,user.legacy_access
                   FROM user_sessions session JOIN users user ON user.id=session.user_id
                   JOIN organizations o ON o.id=session.organization_id
                   WHERE session.token_hash=? AND session.expires_at>? AND o.is_demo=0
                     AND user.status='active' AND user.organization_id=session.organization_id""",
                (token_hash, now),
            ).fetchone()
            if row:
                return dict(row)
            # v1 organization sessions are never principals for real companies.
            # They are retained only for anonymous, read-only demo admission.
            demo = conn.execute(
                """SELECT o.id,o.name,o.account,o.is_demo,session.expires_at,
                          NULL user_id,NULL login,NULL role,0 must_change_password
                   FROM sessions session JOIN organizations o ON o.id=session.organization_id
                   WHERE session.token_hash=? AND session.expires_at>? AND o.is_demo=1""",
                (token_hash, now),
            ).fetchone()
            if demo:
                return dict(demo)
        raise HTTPException(401, "authentication required")

    def require_admin(session: dict = Depends(current_session)) -> dict:
        if session.get("is_demo") or session.get("role") != "admin":
            raise HTTPException(403, "administrator access required")
        return session

    def require_sensitive_admin(session: dict = Depends(require_admin)) -> dict:
        if session.get("must_change_password"):
            raise HTTPException(403, "password change required before this action")
        return session

    def device_identity(authorization: str | None = Header(default=None)) -> dict:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "device bearer token required")
        token = authorization.removeprefix("Bearer ").strip()
        if not token or len(token) > 512:
            raise HTTPException(401, "device bearer token required")
        with db() as conn:
            row = conn.execute("SELECT organization_id,machine_id FROM device_tokens WHERE token_hash=?", (hash_secret(token),)).fetchone()
            if not row:
                raise HTTPException(401, "invalid device token")
            return dict(row) | {"token_hash": hash_secret(token)}

    def set_session_cookie(response: Response, token: str, lifetime: int) -> None:
        response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="strict",
                            secure=os.getenv("ITLES_COOKIE_SECURE", "1") == "1", max_age=lifetime, path="/")

    def create_user_session(conn: sqlite3.Connection, user_id: str, organization_id: str) -> str:
        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO user_sessions(token_hash,user_id,organization_id,expires_at) VALUES(?,?,?,?)",
            (hash_secret(token), user_id, organization_id, iso(utcnow() + timedelta(seconds=USER_SESSION_SECONDS))),
        )
        return token

    def issue_recovery_code(conn: sqlite3.Connection, user_id: str) -> str:
        code = secrets.token_urlsafe(24)
        now = utcnow()
        conn.execute("DELETE FROM recovery_codes WHERE user_id=?", (user_id,))
        conn.execute(
            "INSERT INTO recovery_codes(user_id,code_hash,expires_at,issued_at) VALUES(?,?,?,?)",
            (user_id, hash_secret(code), iso(now + RECOVERY_CODE_TTL), iso(now)),
        )
        return code

    def session_payload(row: dict | sqlite3.Row) -> dict:
        result = {
            "organization": {"id": row["id"], "name": row["name"], "account": row["account"]},
            "user": None,
            "demo": bool(row["is_demo"]),
        }
        if row["is_demo"]:
            with db() as conn:
                period = conn.execute("SELECT MIN(occurred_at) first,MAX(occurred_at) last FROM events WHERE organization_id=?", (row["id"],)).fetchone()
            if period["first"]:
                result["data_period"] = {"start": period["first"][:10], "end": period["last"][:10]}
        else:
            result["user"] = {
                "id": row["user_id"], "login": row["login"], "role": row["role"],
                "must_change_password": bool(row["must_change_password"]),
                "legacy_access": bool(dict(row).get("legacy_access", False)),
            }
            with db() as conn:
                progress = _onboarding_payload(conn, row["id"])
            result["onboarding"] = {"completed": progress["completed"], "step": progress["step"]}
        return result

    @app.get("/api/health")
    def health():
        with db() as conn:
            conn.execute("SELECT 1").fetchone()
        return {"status": "ok"}

    @app.get("/api/auth/options")
    def auth_options():
        return {"demo_enabled": _demo_enabled(), "registration_enabled": _registration_enabled()}

    @app.post("/api/auth/register")
    def register(payload: RegisterRequest, response: Response):
        if not _registration_enabled():
            raise HTTPException(403, "registration is disabled")
        permit_auth_attempt(REGISTRATION_LIMITER, payload.account)
        if payload.account == DEMO_ACCOUNT:
            REGISTRATION_LIMITER.failed(payload.account)
            raise HTTPException(409, "account is already in use")
        encoded_password = password_hash(payload.password)
        organization_id = new_id()
        user_id = new_id()
        try:
            with db() as conn:
                conn.execute("BEGIN IMMEDIATE")
                if conn.execute("SELECT 1 FROM organizations WHERE account=? COLLATE NOCASE", (payload.account,)).fetchone():
                    REGISTRATION_LIMITER.failed(payload.account)
                    raise HTTPException(409, "account is already in use")
                now = iso(utcnow())
                conn.execute(
                    "INSERT INTO organizations(id,name,account,password_hash,is_demo) VALUES(?,?,?,?,0)",
                    (organization_id, payload.organization_name, payload.account, None),
                )
                conn.execute(
                    """INSERT INTO users(id,organization_id,login,role,password_hash,status,created_at,must_change_password)
                       VALUES(?,?,?,'admin',?,'active',?,0)""",
                    (user_id, organization_id, payload.login, encoded_password, now),
                )
                recovery_code = issue_recovery_code(conn, user_id)
                token = create_user_session(conn, user_id, organization_id)
                row = {
                    "id": organization_id, "name": payload.organization_name, "account": payload.account,
                    "is_demo": 0, "user_id": user_id, "login": payload.login, "role": "admin",
                    "must_change_password": 0,
                }
        except sqlite3.IntegrityError as exc:
            REGISTRATION_LIMITER.failed(payload.account)
            raise HTTPException(409, "account or login is already in use") from exc
        REGISTRATION_LIMITER.succeeded(payload.account)
        set_session_cookie(response, token, USER_SESSION_SECONDS)
        return session_payload(row) | {"recovery_code": recovery_code}

    @app.post("/api/auth/login")
    def login(payload: LoginRequest, response: Response):
        login_name = payload.login or "legacy"
        identifier = f"{payload.account}:{login_name}"
        permit_auth_attempt(LOGIN_LIMITER, identifier)
        legacy_only = " AND user.legacy_access=1" if payload.login is None else ""
        with db() as conn:
            row = conn.execute(
                """SELECT o.id,o.name,o.account,o.is_demo,user.id user_id,user.login,user.role,
                          user.password_hash,user.status,user.must_change_password,user.legacy_access
                   FROM users user JOIN organizations o ON o.id=user.organization_id
                   WHERE o.account=? AND o.is_demo=0 AND user.login=?""" + legacy_only,
                (payload.account, login_name),
            ).fetchone()
        # An unknown account gets the same expensive password operation as a known one.
        valid_password = password_matches(payload.password, row["password_hash"] if row else DUMMY_PASSWORD_HASH)
        if not row or row["status"] != "active" or not valid_password:
            LOGIN_LIMITER.failed(identifier)
            raise HTTPException(401, "invalid account, login, or password")
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute(
                """SELECT o.id,o.name,o.account,o.is_demo,user.id user_id,user.login,user.role,
                          user.password_hash,user.status,user.must_change_password,user.legacy_access
                   FROM users user JOIN organizations o ON o.id=user.organization_id
                   WHERE user.id=? AND user.status='active' AND o.is_demo=0""",
                (row["user_id"],),
            ).fetchone()
            if not current or not password_matches(payload.password, current["password_hash"]):
                LOGIN_LIMITER.failed(identifier)
                raise HTTPException(401, "invalid account, login, or password")
            if password_needs_upgrade(current["password_hash"]):
                conn.execute("UPDATE users SET password_hash=? WHERE id=?", (password_hash(payload.password), current["user_id"]))
                current = dict(current) | {"password_hash": None}
            token = create_user_session(conn, current["user_id"], current["id"])
        LOGIN_LIMITER.succeeded(identifier)
        set_session_cookie(response, token, USER_SESSION_SECONDS)
        return session_payload(current)

    @app.post("/api/auth/demo")
    def demo_login(response: Response, itles_session: str | None = Cookie(default=None)):
        if not _demo_enabled():
            raise HTTPException(404, "demo is disabled")
        if itles_session:
            with db() as conn:
                current = conn.execute(
                    """SELECT o.id,o.name,o.account,o.is_demo,session.expires_at,
                              NULL user_id,NULL login,NULL role,0 must_change_password
                       FROM sessions session JOIN organizations o ON o.id=session.organization_id
                       WHERE session.token_hash=? AND session.expires_at>? AND o.is_demo=1""",
                    (hash_secret(itles_session), iso(utcnow())),
                ).fetchone()
            if current:
                return session_payload(current)
        if not DEMO_LOGIN_LIMITER.allowed():
            raise HTTPException(429, "demo session limit reached; try again later")
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                org_id = seed_demo(conn)
            except (DemoSeedConflictError, sqlite3.IntegrityError):
                return JSONResponse(
                    {"detail": "demo temporarily unavailable", "code": "demo_unavailable"}, status_code=503,
                )
            row = conn.execute("SELECT id,name,account,is_demo FROM organizations WHERE id=?", (org_id,)).fetchone()
            now = utcnow()
            conn.execute("DELETE FROM sessions WHERE expires_at<=?", (iso(now),))
            at_capacity = conn.execute(
                "SELECT COUNT(*) count FROM sessions WHERE organization_id=?", (org_id,)
            ).fetchone()["count"] >= DEMO_SESSION_CAP
            if not at_capacity:
                token = secrets.token_urlsafe(32)
                conn.execute(
                    "INSERT INTO sessions(token_hash,organization_id,expires_at) VALUES(?,?,?)",
                    (hash_secret(token), org_id, iso(now + timedelta(seconds=DEMO_SESSION_SECONDS))),
                )
        if at_capacity:
            raise HTTPException(429, "demo session capacity reached; try again later")
        set_session_cookie(response, token, DEMO_SESSION_SECONDS)
        return session_payload(row)

    @app.get("/api/auth/me")
    def me(session: dict = Depends(current_session)):
        return session_payload(session)

    @app.post("/api/auth/logout")
    def logout(response: Response, itles_session: str | None = Cookie(default=None)):
        if itles_session:
            with db() as conn:
                conn.execute("DELETE FROM sessions WHERE token_hash=?", (hash_secret(itles_session),))
                conn.execute("DELETE FROM user_sessions WHERE token_hash=?", (hash_secret(itles_session),))
        response.delete_cookie(SESSION_COOKIE, path="/")
        return {"ok": True}

    @app.post("/api/auth/logout-all")
    def logout_all(response: Response, itles_session: str | None = Cookie(default=None), session: dict = Depends(current_session)):
        with db() as conn:
            if session.get("user_id"):
                conn.execute("DELETE FROM user_sessions WHERE user_id=?", (session["user_id"],))
            elif itles_session:
                conn.execute("DELETE FROM sessions WHERE token_hash=?", (hash_secret(itles_session),))
        response.delete_cookie(SESSION_COOKIE, path="/")
        return {"ok": True}

    @app.post("/api/auth/password")
    def change_password(payload: PasswordChangeRequest, response: Response, session: dict = Depends(current_session)):
        if session.get("is_demo") or not session.get("user_id") or session.get("legacy_access"):
            raise HTTPException(403, "a company account is required")
        permit_auth_attempt(REAUTH_LIMITER, session["user_id"])
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            user = conn.execute("SELECT password_hash,status FROM users WHERE id=?", (session["user_id"],)).fetchone()
            if not user or user["status"] != "active" or not password_matches(payload.current_password, user["password_hash"]):
                REAUTH_LIMITER.failed(session["user_id"])
                raise HTTPException(401, "current password is invalid")
            conn.execute(
                "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
                (password_hash(payload.new_password), session["user_id"]),
            )
            conn.execute("DELETE FROM user_sessions WHERE user_id=?", (session["user_id"],))
        REAUTH_LIMITER.succeeded(session["user_id"])
        response.delete_cookie(SESSION_COOKIE, path="/")
        return {"ok": True}

    @app.post("/api/auth/recovery-code")
    def replace_recovery_code(payload: RecoveryCodeRequest, session: dict = Depends(require_sensitive_admin)):
        permit_auth_attempt(REAUTH_LIMITER, session["user_id"])
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            user = conn.execute("SELECT password_hash,status FROM users WHERE id=?", (session["user_id"],)).fetchone()
            if not user or user["status"] != "active" or not password_matches(payload.password, user["password_hash"]):
                REAUTH_LIMITER.failed(session["user_id"])
                raise HTTPException(401, "current password is invalid")
            recovery_code = issue_recovery_code(conn, session["user_id"])
        REAUTH_LIMITER.succeeded(session["user_id"])
        return {"recovery_code": recovery_code}

    @app.post("/api/auth/activate")
    def activate(payload: ActivationRequest, response: Response):
        identifier = f"{payload.account}:{payload.login}"
        permit_auth_attempt(ACTIVATION_LIMITER, identifier)
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """SELECT o.id,o.name,o.account,o.is_demo,user.id user_id,user.login,user.role,user.status,
                          user.must_change_password,code.code_hash,code.expires_at
                   FROM users user JOIN organizations o ON o.id=user.organization_id
                   LEFT JOIN activation_codes code ON code.user_id=user.id
                   WHERE o.account=? AND o.is_demo=0 AND user.login=? AND user.legacy_access=0""",
                (payload.account, payload.login),
            ).fetchone()
            valid = bool(row and row["status"] == "pending" and row["expires_at"] and row["expires_at"] > iso(utcnow())
                         and secrets.compare_digest(hash_secret(payload.code), row["code_hash"]))
            if not valid:
                ACTIVATION_LIMITER.failed(identifier)
                raise HTTPException(401, "invalid activation data")
            conn.execute(
                "UPDATE users SET password_hash=?,status='active',must_change_password=0 WHERE id=?",
                (password_hash(payload.password), row["user_id"]),
            )
            conn.execute("DELETE FROM activation_codes WHERE user_id=?", (row["user_id"],))
            conn.execute("DELETE FROM user_sessions WHERE user_id=?", (row["user_id"],))
            token = create_user_session(conn, row["user_id"], row["id"])
            recovery_code = issue_recovery_code(conn, row["user_id"]) if row["role"] == "admin" else None
        ACTIVATION_LIMITER.succeeded(identifier)
        set_session_cookie(response, token, USER_SESSION_SECONDS)
        result = session_payload(dict(row) | {"must_change_password": 0})
        return result | {"recovery_code": recovery_code} if recovery_code else result

    @app.post("/api/auth/recover")
    def recover(payload: RecoveryRequest, response: Response):
        identifier = f"{payload.account}:{payload.login}"
        permit_auth_attempt(RECOVERY_LIMITER, identifier)
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """SELECT o.id,o.name,o.account,o.is_demo,user.id user_id,user.login,user.role,user.status,
                          user.must_change_password,code.code_hash,code.expires_at
                   FROM users user JOIN organizations o ON o.id=user.organization_id
                   LEFT JOIN recovery_codes code ON code.user_id=user.id
                   WHERE o.account=? AND o.is_demo=0 AND user.login=? AND user.role='admin'""",
                (payload.account, payload.login),
            ).fetchone()
            valid = bool(row and row["status"] == "active" and row["expires_at"] and row["expires_at"] > iso(utcnow())
                         and secrets.compare_digest(hash_secret(payload.recovery_code), row["code_hash"]))
            if not valid:
                RECOVERY_LIMITER.failed(identifier)
                raise HTTPException(401, "invalid recovery data")
            conn.execute(
                "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
                (password_hash(payload.password), row["user_id"]),
            )
            recovery_code = issue_recovery_code(conn, row["user_id"])
            conn.execute("DELETE FROM user_sessions WHERE user_id=?", (row["user_id"],))
            token = create_user_session(conn, row["user_id"], row["id"])
        RECOVERY_LIMITER.succeeded(identifier)
        set_session_cookie(response, token, USER_SESSION_SECONDS)
        return session_payload(dict(row) | {"must_change_password": 0}) | {"recovery_code": recovery_code}

    def own_machine(conn: sqlite3.Connection, organization_id: str, machine_id: str) -> sqlite3.Row:
        machine = conn.execute(
            "SELECT * FROM machines WHERE id=? AND organization_id=?", (machine_id, organization_id)
        ).fetchone()
        if not machine:
            raise HTTPException(404, "machine not found")
        return machine

    def user_payload(user: sqlite3.Row) -> dict:
        return {
            "id": user["id"], "login": user["login"], "role": user["role"],
            "status": user["status"], "created_at": user["created_at"],
            "legacy_access": bool(dict(user).get("legacy_access", False)),
        }

    @app.get("/api/admin/onboarding")
    def get_onboarding(session: dict = Depends(require_admin)):
        with db() as conn:
            return _onboarding_payload(conn, session["id"])

    @app.patch("/api/admin/onboarding")
    def save_onboarding(payload: OnboardingPatch, session: dict = Depends(require_sensitive_admin)):
        if payload.step is None and payload.users_configured is None:
            raise HTTPException(422, "at least one onboarding field is required")
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = _onboarding_payload(conn, session["id"])
            existing = conn.execute(
                "SELECT users_configured FROM onboarding WHERE organization_id=?", (session["id"],)
            ).fetchone()
            users_configured = bool(existing["users_configured"]) if existing else False
            if payload.users_configured is not None:
                users_configured = payload.users_configured
            conn.execute(
                """INSERT INTO onboarding(organization_id,step,users_configured,updated_at) VALUES(?,?,?,?)
                   ON CONFLICT(organization_id) DO UPDATE SET step=excluded.step,
                     users_configured=excluded.users_configured,updated_at=excluded.updated_at""",
                (session["id"], payload.step or current["step"], int(users_configured), iso(utcnow())),
            )
            return _onboarding_payload(conn, session["id"])

    @app.patch("/api/admin/company")
    def update_company(payload: CompanyPatch, session: dict = Depends(require_sensitive_admin)):
        with db() as conn:
            conn.execute("UPDATE organizations SET name=? WHERE id=? AND is_demo=0", (payload.name, session["id"]))
            row = conn.execute("SELECT id,name,account FROM organizations WHERE id=?", (session["id"],)).fetchone()
        return {"organization": dict(row)}

    @app.get("/api/admin/users")
    def list_users(session: dict = Depends(require_admin)):
        with db() as conn:
            rows = conn.execute(
                """SELECT id,login,role,status,created_at,legacy_access FROM users WHERE organization_id=?
                   ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END,login""",
                (session["id"],),
            ).fetchall()
        return {"users": [user_payload(row) for row in rows]}

    @app.post("/api/admin/users")
    def create_user(payload: UserCreateRequest, session: dict = Depends(require_sensitive_admin)):
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute(
                "SELECT 1 FROM users WHERE organization_id=? AND login=?", (session["id"], payload.login)
            ).fetchone():
                raise HTTPException(409, "login is already in use")
            user_id = new_id()
            created_at = iso(utcnow())
            conn.execute(
                """INSERT INTO users(id,organization_id,login,role,password_hash,status,created_at,must_change_password)
                   VALUES(?,?,?,'user',NULL,'pending',?,0)""",
                (user_id, session["id"], payload.login, created_at),
            )
            activation_code, expires_at = issue_activation_code(conn, user_id)
            current = _onboarding_payload(conn, session["id"])
            conn.execute(
                """INSERT INTO onboarding(organization_id,step,users_configured,updated_at) VALUES(?,?,1,?)
                   ON CONFLICT(organization_id) DO UPDATE SET users_configured=1,updated_at=excluded.updated_at""",
                (session["id"], current["step"], iso(utcnow())),
            )
            user = conn.execute(
                "SELECT id,login,role,status,created_at FROM users WHERE id=?", (user_id,)
            ).fetchone()
        return {"user": user_payload(user), "activation_code": activation_code, "expires_at": expires_at}

    @app.post("/api/admin/users/{user_id}/reissue")
    def reissue_user(user_id: str, session: dict = Depends(require_sensitive_admin)):
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            user = conn.execute(
                """SELECT id,login,role,status,created_at FROM users
                   WHERE id=? AND organization_id=? AND role='user' AND legacy_access=0""",
                (user_id, session["id"]),
            ).fetchone()
            if not user:
                raise HTTPException(404, "user not found")
            # Reissue deliberately requires a new personal password and makes
            # any old activation material and sessions unusable.
            conn.execute("UPDATE users SET status='pending',password_hash=NULL WHERE id=?", (user_id,))
            conn.execute("DELETE FROM user_sessions WHERE user_id=?", (user_id,))
            activation_code, expires_at = issue_activation_code(conn, user_id)
            user = conn.execute(
                "SELECT id,login,role,status,created_at FROM users WHERE id=?", (user_id,)
            ).fetchone()
        return {"user": user_payload(user), "activation_code": activation_code, "expires_at": expires_at}

    @app.delete("/api/admin/users/{user_id}")
    def revoke_user(user_id: str, session: dict = Depends(require_sensitive_admin)):
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            user = conn.execute(
                "SELECT id,role FROM users WHERE id=? AND organization_id=?", (user_id, session["id"])
            ).fetchone()
            if not user:
                raise HTTPException(404, "user not found")
            if user["role"] != "user":
                raise HTTPException(409, "the company administrator cannot be revoked here")
            conn.execute("UPDATE users SET status='revoked',password_hash=NULL WHERE id=?", (user_id,))
            conn.execute("DELETE FROM activation_codes WHERE user_id=?", (user_id,))
            conn.execute("DELETE FROM recovery_codes WHERE user_id=?", (user_id,))
            conn.execute("DELETE FROM user_sessions WHERE user_id=?", (user_id,))
        return {"ok": True}

    @app.post("/api/admin/users/{user_id}/sessions/revoke")
    def revoke_user_sessions(user_id: str, session: dict = Depends(require_sensitive_admin)):
        with db() as conn:
            user = conn.execute(
                "SELECT id FROM users WHERE id=? AND organization_id=? AND role='user'", (user_id, session["id"])
            ).fetchone()
            if not user:
                raise HTTPException(404, "user not found")
            conn.execute("DELETE FROM user_sessions WHERE user_id=?", (user_id,))
        return {"ok": True}

    @app.post("/api/admin/machines")
    def create_machine(payload: MachineCreateRequest, session: dict = Depends(require_sensitive_admin)):
        machine_id = new_id()
        with db() as conn:
            conn.execute(
                "INSERT INTO machines(id,organization_id,name,model,head,computer) VALUES(?,?,?,?,?,?)",
                (machine_id, session["id"], payload.name, payload.model, payload.head, payload.computer),
            )
            machine = own_machine(conn, session["id"], machine_id)
        return {"machine": _machine_identity(machine)}

    @app.get("/api/admin/machines/{machine_id}/source")
    def get_machine_source(machine_id: str, session: dict = Depends(require_admin)):
        with db() as conn:
            conn.execute("BEGIN")
            machine = own_machine(conn, session["id"], machine_id)
            return _source_payload(conn, session["id"], machine)

    @app.put("/api/admin/machines/{machine_id}/source")
    def save_machine_source(machine_id: str, payload: SourcePatch, session: dict = Depends(require_sensitive_admin)):
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            machine = own_machine(conn, session["id"], machine_id)
            conn.execute(
                """INSERT INTO machine_sources(machine_id,organization_id,model,computer,software_version,source_kind,
                                                   export_description,permission_confirmed,reviewed_at,saved_at)
                   VALUES(?,?,?,?,?,?,?,?,NULL,?)
                   ON CONFLICT(machine_id) DO UPDATE SET model=excluded.model,computer=excluded.computer,
                     software_version=excluded.software_version,source_kind=excluded.source_kind,
                     export_description=excluded.export_description,permission_confirmed=excluded.permission_confirmed,
                     reviewed_at=NULL,reviewed_event_count=0,saved_at=excluded.saved_at""",
                (machine_id, session["id"], payload.model, payload.computer, payload.software_version,
                 payload.source_kind, payload.export_description, int(payload.permission_confirmed), iso(utcnow())),
            )
            conn.execute(
                "UPDATE machines SET model=?,computer=? WHERE id=? AND organization_id=?",
                (payload.model, payload.computer, machine_id, session["id"]),
            )
            machine = own_machine(conn, session["id"], machine_id)
            if payload.source_kind != "normalized_json" or not payload.permission_confirmed:
                conn.execute("DELETE FROM device_tokens WHERE organization_id=? AND machine_id=?", (session["id"], machine_id))
            return _source_payload(conn, session["id"], machine)

    @app.post("/api/admin/machines/{machine_id}/tokens")
    def issue_device_token(machine_id: str, payload: DeviceTokenRequest, session: dict = Depends(require_sensitive_admin)):
        permit_auth_attempt(REAUTH_LIMITER, session["user_id"])
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            machine = own_machine(conn, session["id"], machine_id)
            source = conn.execute(
                "SELECT source_kind,permission_confirmed FROM machine_sources WHERE machine_id=? AND organization_id=?",
                (machine_id, session["id"]),
            ).fetchone()
            if not source or source["source_kind"] != "normalized_json" or not source["permission_confirmed"]:
                raise HTTPException(409, "configure normalized_json source and confirm permission before issuing a token")
            user = conn.execute("SELECT password_hash,status FROM users WHERE id=?", (session["user_id"],)).fetchone()
            if not user or user["status"] != "active" or not password_matches(payload.password, user["password_hash"]):
                REAUTH_LIMITER.failed(session["user_id"])
                raise HTTPException(401, "current password is invalid")
            token = secrets.token_urlsafe(32)
            created_at = iso(utcnow())
            conn.execute("DELETE FROM device_tokens WHERE organization_id=? AND machine_id=?", (session["id"], machine_id))
            conn.execute(
                "INSERT INTO device_tokens(token_hash,organization_id,machine_id,created_at) VALUES(?,?,?,?)",
                (hash_secret(token), session["id"], machine["id"], created_at),
            )
            conn.execute(
                "INSERT INTO device_token_metadata(token_hash,id,created_at) VALUES(?,?,?)",
                (hash_secret(token), new_id(), created_at),
            )
        REAUTH_LIMITER.succeeded(session["user_id"])
        return {"token": token, "created_at": created_at}

    @app.delete("/api/admin/machines/{machine_id}/tokens")
    def revoke_device_tokens(machine_id: str, session: dict = Depends(require_sensitive_admin)):
        with db() as conn:
            own_machine(conn, session["id"], machine_id)
            conn.execute("DELETE FROM device_tokens WHERE organization_id=? AND machine_id=?", (session["id"], machine_id))
        return {"ok": True}

    @app.post("/api/admin/machines/{machine_id}/review")
    def review_machine_source(machine_id: str, payload: SourceReviewRequest, session: dict = Depends(require_sensitive_admin)):
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            machine = own_machine(conn, session["id"], machine_id)
            source = conn.execute(
                "SELECT source_kind,permission_confirmed FROM machine_sources WHERE machine_id=? AND organization_id=?", (machine_id, session["id"])
            ).fetchone()
            accepted = conn.execute(
                "SELECT COUNT(*) FROM events WHERE organization_id=? AND machine_id=?", (session["id"], machine_id)
            ).fetchone()[0]
            if not source or source["source_kind"] != "normalized_json" or not source["permission_confirmed"] or not accepted:
                raise HTTPException(409, "a configured source and accepted data are required before review")
            if payload.message_count != accepted:
                raise HTTPException(409, "new data arrived; refresh and compare before review")
            conn.execute("UPDATE machine_sources SET reviewed_at=?,reviewed_event_count=? WHERE machine_id=?", (iso(utcnow()), accepted, machine_id))
            return _source_payload(conn, session["id"], machine)

    @app.get("/api/machines")
    def machines(session: dict = Depends(current_session)):
        with db() as conn:
            conn.execute("BEGIN")
            rows = conn.execute("SELECT * FROM machines WHERE organization_id=? ORDER BY name", (session["id"],)).fetchall()
            return {"machines": [_machine_payload(conn, session["id"], row) for row in rows], "demo": bool(session["is_demo"])}

    @app.get("/api/fleet")
    def fleet(start: str | None = Query(None), end: str | None = Query(None), session: dict = Depends(current_session)):
        start_date, end_date = _date_range(start, end)
        begin, finish = _bounds(start_date, end_date)
        with db() as conn:
            conn.execute("BEGIN")
            machine_rows = conn.execute("SELECT * FROM machines WHERE organization_id=? ORDER BY name", (session["id"],)).fetchall()
            data = []
            for row in machine_rows:
                data.append({"id": row["id"], "name": row["name"], "totals": _totals(conn, session["id"], start_date, end_date, row["id"]),
                             "engine_hours": _engine_hours_for_period(conn, row["id"], start_date, end_date)})
            count = conn.execute("""SELECT COUNT(*) value FROM production p JOIN events e ON e.event_id=p.event_id
                                   WHERE e.organization_id=? AND p.occurred_at>=? AND p.occurred_at<?""", (session["id"], begin, finish)).fetchone()["value"]
            return {"period": {"start": start_date.isoformat(), "end": end_date.isoformat()}, "totals": _totals(conn, session["id"], start_date, end_date),
                    "machines": data, "record_count": count}

    @app.get("/api/machines/{machine_id}")
    def machine(machine_id: str, start: str | None = Query(None), end: str | None = Query(None), session: dict = Depends(current_session)):
        start_date, end_date = _date_range(start, end)
        begin, finish = _bounds(start_date, end_date)
        with db() as conn:
            conn.execute("BEGIN")
            row = conn.execute("SELECT * FROM machines WHERE id=? AND organization_id=?", (machine_id, session["id"])).fetchone()
            if not row:
                raise HTTPException(404, "machine not found")
            result = _machine_payload(conn, session["id"], row)
            production = conn.execute("""SELECT p.* FROM production p JOIN events e ON e.event_id=p.event_id WHERE e.organization_id=?
                                      AND p.machine_id=? AND p.occurred_at>=? AND p.occurred_at<? ORDER BY p.occurred_at""", (session["id"], machine_id, begin, finish)).fetchall()
            track = conn.execute("SELECT latitude,longitude,observed_at FROM positions WHERE machine_id=? AND observed_at>=? AND observed_at<? ORDER BY observed_at", (machine_id, begin, finish)).fetchall()
            result.update({"production": [{"event_id": x["event_id"], "occurred_at": x["occurred_at"], "volume_m3": _decimal(x["volume_micro_m3"]), "basis": x["basis"], "source": x["source"], "method": x["method"], "method_version": x["method_version"], "calibration_ref": x["calibration_ref"]} for x in production],
                           "totals": _totals(conn, session["id"], start_date, end_date, machine_id), "track": [dict(x) for x in track],
                           "engine_hours": _engine_hours_for_period(conn, machine_id, start_date, end_date)})
            return result

    @app.post("/api/ingest")
    def ingest(batch: IngestBatch, identity: dict = Depends(device_identity)):
        # Pydantic already rejects unrecognized fields before any data reaches storage.
        if any(event.machine_id != identity["machine_id"] for event in batch.events):
            with db() as conn:
                audit(conn, identity["organization_id"], identity["machine_id"], "rejected", "token_machine_mismatch")
            raise HTTPException(403, "device token is scoped to one machine")
        normalized = batch.model_dump(mode="json")
        batch_hash, _ = canonical_hash(normalized)
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if not conn.execute(
                "SELECT 1 FROM device_tokens WHERE token_hash=? AND organization_id=? AND machine_id=?",
                (identity["token_hash"], identity["organization_id"], identity["machine_id"]),
            ).fetchone():
                raise HTTPException(401, "invalid device token")
            batch_row = conn.execute("SELECT payload_hash FROM ingest_batches WHERE organization_id=? AND machine_id=? AND batch_id=?", (identity["organization_id"], identity["machine_id"], str(batch.batch_id))).fetchone()
            if batch_row:
                if batch_row["payload_hash"] != batch_hash:
                    audit(conn, identity["organization_id"], identity["machine_id"], "rejected", "batch_id_conflict")
                    return JSONResponse({"detail": "batch_id was already submitted with a different payload"}, status_code=409)
                audit(conn, identity["organization_id"], identity["machine_id"], "duplicates", "repeat_batch")
                return {"batch_id": str(batch.batch_id), "accepted": 0, "duplicates": len(batch.events), "rejected": 0}
            event_hashes = [(event, *canonical_hash(event.model_dump(mode="json"))) for event in batch.events]
            for event, digest, _ in event_hashes:
                prior = conn.execute("SELECT organization_id,payload_hash FROM events WHERE event_id=?", (str(event.event_id),)).fetchone()
                # Fixture IDs stay reserved before the first demo admission too.
                if str(event.event_id) in DEMO_EVENT_IDS or (prior and prior["organization_id"] != identity["organization_id"]):
                    audit(conn, identity["organization_id"], identity["machine_id"], "rejected", "event_id_unavailable")
                    return JSONResponse({"detail": "event_id is unavailable"}, status_code=409)
                if prior and prior["payload_hash"] != digest:
                    audit(conn, identity["organization_id"], identity["machine_id"], "rejected", "event_id_conflict")
                    return JSONResponse({"detail": "event_id was already submitted with a different payload"}, status_code=409)
            accepted = 0
            duplicates = 0
            for event, digest, canonical in event_hashes:
                if conn.execute("SELECT 1 FROM events WHERE event_id=?", (str(event.event_id),)).fetchone():
                    duplicates += 1
                    continue
                event_id = str(event.event_id)
                occurred = iso(event.occurred_at)
                conn.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)", (event_id, identity["organization_id"], event.machine_id, occurred, event.kind, digest, canonical, iso(utcnow())))
                if event.kind == "telemetry":
                    conn.executemany("INSERT INTO measurements VALUES(?,?,?,?,?,?)", [(event_id, event.machine_id, item.key, float(item.value), item.unit, occurred) for item in event.measurements])
                    if event.position:
                        conn.execute("INSERT INTO positions VALUES(?,?,?,?,?)", (event_id, event.machine_id, event.position.latitude, event.position.longitude, occurred))
                else:
                    micro = int(event.volume_m3 * Decimal(1_000_000))
                    conn.execute(
                        "INSERT INTO production VALUES(?,?,?,?,?,?,?,?,?)",
                        (event_id, event.machine_id, occurred, micro, event.basis, event.source, event.method,
                         event.method_version, event.calibration_ref),
                    )
                accepted += 1
            conn.execute("INSERT INTO ingest_batches VALUES(?,?,?,?,?)", (identity["organization_id"], identity["machine_id"], str(batch.batch_id), batch_hash, iso(utcnow())))
            audit(conn, identity["organization_id"], identity["machine_id"], "accepted" if accepted else "duplicates", None)
            return {"batch_id": str(batch.batch_id), "accepted": accepted, "duplicates": duplicates, "rejected": 0}

    @app.get("/api/exports/ledger.csv")
    def ledger(start: str | None = Query(None), end: str | None = Query(None), session: dict = Depends(current_session)):
        start_date, end_date = _date_range(start, end)
        begin, finish = _bounds(start_date, end_date)
        with db() as conn:
            rows = conn.execute("""SELECT p.event_id,p.machine_id,p.occurred_at,p.volume_micro_m3,p.basis,p.source,p.method,p.method_version,p.calibration_ref FROM production p
                JOIN events e ON e.event_id=p.event_id WHERE e.organization_id=? AND p.occurred_at>=? AND p.occurred_at<? ORDER BY p.occurred_at""", (session["id"], begin, finish)).fetchall()
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(["event_id", "machine_id", "occurred_at_utc", "volume_m3", "basis", "source", "method", "method_version", "calibration_ref"])
        for row in rows:
            writer.writerow([row["event_id"], row["machine_id"], row["occurred_at"], _decimal(row["volume_micro_m3"]), row["basis"], row["source"], row["method"], row["method_version"], row["calibration_ref"] or ""])
        return StreamingResponse(iter([output.getvalue()]), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": "attachment; filename=itles-ledger.csv"})

    @app.get("/api/quality")
    def quality(session: dict = Depends(current_session)):
        with db() as conn:
            rows = conn.execute("SELECT status,COUNT(*) count FROM ingest_audit WHERE organization_id=? GROUP BY status", (session["id"],)).fetchall()
            counts = {"accepted": 0, "duplicates": 0, "rejected": 0}
            counts.update({r["status"]: r["count"] for r in rows})
            recent = conn.execute("SELECT received_at,status,reason,machine_id FROM ingest_audit WHERE organization_id=? ORDER BY id DESC LIMIT 50", (session["id"],)).fetchall()
            has_engine_hour_reset = _has_engine_hour_reset(conn, session["id"])
        limitations = [
            "Приём данных не подтверждает исправность штатных датчиков или достоверность первичного измерения.",
            "Объём хранится как дельта события и не заменяет сверку с приёмкой и калибровкой машины.",
            "Класс метода не является расчётной формулой: для физических выводов обязательна известная версия метода; unknown исключает такие утверждения.",
            "CSV — нормализованный журнал, а не заявленная интеграция с конкретной конфигурацией 1С.",
        ]
        if has_engine_hour_reset:
            limitations.append("Зафиксировано уменьшение счётчика моточасов: наработка за затронутый период показана как недоступная до проверки сброса или замены счётчика.")
        return {"counts": counts, "recent": [dict(row) for row in recent], "limitations": limitations}

    @app.get("/api/methodology")
    def methodology(session: dict = Depends(current_session)):
        return {"production": {"model": "per_item_delta", "storage": "integer micro m³", "bases": ["under_bark", "over_bark", "unknown"],
                               "provenance_categories": {"source": ["onboard_measurement", "operator_export", "accounting_import"], "method": ["harvester_onboard", "merchantable_log", "manual_ledger"]},
                               "method_version": "Обязательный технический идентификатор версии расчёта или конфигурации. Класс method не является формулой; unknown допустим, но не поддерживает физические заявления о точности.",
                               "limitations": "Метод и источник — только категории происхождения данных, не версия OEM-методики и не подтверждение калибровки. Точность определяется документацией, калибровкой и полевой сверкой конкретной машины."},
                "telemetry": {"out_of_order": "Поздние события сохраняются в журнале, но последние значения выбираются по времени наблюдения.",
                              "norms": "Универсальные нормы не задаются без подтверждённой документации модели и узла."}}

    return app
