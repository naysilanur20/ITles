"""Cold ASGI process restarts and SQLite restore, without a TCP/TLS server."""

import json
import os
from contextlib import closing
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

from scripts.backup_db import backup, verify


WORKER = r'''
import json, secrets, sys
from datetime import UTC, datetime
from uuid import uuid4
from fastapi.testclient import TestClient
from server import app

state = json.load(sys.stdin)
mode = state.pop("mode")
with TestClient(app, base_url="https://testserver") as client:
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.post("/api/auth/demo").status_code == 404
    if mode == "create":
        state = {"account": "synthetic-restart", "login": "admin", "password": secrets.token_urlsafe(24)}
        response = client.post("/api/auth/register", json={**state, "organization_name": "Synthetic restart company"})
        assert response.status_code == 200
        state["organization"] = response.json()["organization"]
        response = client.post("/api/admin/machines", json={"name": "Synthetic machine", "model": "Test model"})
        assert response.status_code == 200
        state["machine"] = response.json()["machine"]["id"]
        path = "/api/admin/machines/" + state["machine"]
        source = {"source_kind": "normalized_json", "permission_confirmed": True,
                  "model": "Test model", "computer": "Synthetic sender", "software_version": "test-1"}
        assert client.put(path + "/source", json=source).status_code == 200
        token = client.post(path + "/tokens", json={"password": state["password"]})
        assert token.status_code == 200
        state["device_token"] = token.json()["token"]
        timestamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        state["day"] = timestamp[:10]
        event = {"machine_id": state["machine"], "occurred_at": timestamp}
        state["batch"] = {"schema_version": 1, "batch_id": str(uuid4()), "events": [
            {**event, "event_id": str(uuid4()), "kind": "production", "volume_m3": "1.250000",
             "basis": "under_bark", "source": "accounting_import", "method": "manual_ledger", "method_version": "synthetic-1"},
            {**event, "event_id": str(uuid4()), "kind": "telemetry",
             "measurements": [{"key": "engine_rpm", "value": 0, "unit": "rpm"}]}]}
        accepted = client.post("/api/ingest", json=state["batch"], headers={"Authorization": "Bearer " + state["device_token"]})
        assert accepted.status_code == 200 and accepted.json()["accepted"] == 2
        assert client.post(path + "/review", json={"message_count": 2}).status_code == 200
        assert client.post("/api/admin/users", json={"login": "reader"}).status_code == 200
        assert client.patch("/api/admin/onboarding", json={"step": "complete", "users_configured": True}).status_code == 200
    else:
        client.cookies.set("itles_session", state["session"], domain="testserver.local", path="/")
        me = client.get("/api/auth/me")
        assert me.status_code == 200 and me.json()["organization"] == state["organization"]
        assert client.post("/api/auth/logout").status_code == 200
        assert client.get("/api/auth/me").status_code == 401
        login = client.post("/api/auth/login", json={key: state[key] for key in ("account", "login", "password")})
        assert login.status_code == 200
    state["session"] = client.cookies.get("itles_session")
    source = client.get("/api/admin/machines/" + state["machine"] + "/source").json()
    assert source["source"]["software_version"] == "test-1"
    assert source["connection"]["message_count"] == 2
    assert source["connection"]["state"] == "message_received"
    assert source["onboarding"]["completed"] is True and source["onboarding"]["step"] == "complete"
    users = client.get("/api/admin/users").json()["users"]
    assert [(u["login"], u["status"]) for u in users] == [("admin", "active"), ("reader", "pending")]
    csv = client.get("/api/exports/ledger.csv", params={"start": state["day"], "end": state["day"]})
    assert csv.status_code == 200 and len(csv.text.strip().splitlines()) == 2
    if "csv" in state:
        assert csv.text == state["csv"]
    state["csv"] = csv.text
    repeated = client.post("/api/ingest", json=state["batch"], headers={"Authorization": "Bearer " + state["device_token"]})
    assert repeated.status_code == 200 and repeated.json()["accepted"] == 0 and repeated.json()["duplicates"] == 2
print(json.dumps(state))
'''


class PrivateState(dict):
    def __repr__(self):
        return "<redacted synthetic restart state>"


def run_worker(database, mode, state):
    __tracebackhide__ = True
    env = dict(os.environ, ITLES_DB_PATH=str(database), ITLES_COOKIE_SECURE="1",
               ITLES_DEMO_ENABLED="0", ITLES_REGISTRATION_ENABLED="1")
    try:
        result = subprocess.run(
            [sys.executable, "-c", WORKER], input=json.dumps({**state, "mode": mode}),
            capture_output=True, text=True, env=env, cwd=Path(__file__).resolve().parents[1], timeout=30,
        )
    except subprocess.TimeoutExpired:
        pytest.fail(f"ASGI restart worker timed out during {mode}", pytrace=False)
    # Child output can contain credentials or response bodies; never echo it on failure.
    if result.returncode:
        pytest.fail(f"ASGI restart worker failed during {mode} (exit {result.returncode})", pytrace=False)
    try:
        return PrivateState(json.loads(result.stdout))
    except (ValueError, TypeError):
        pytest.fail(f"ASGI restart worker returned invalid state during {mode}", pytrace=False)


def test_full_server_restart_and_backup_restore(tmp_path):
    database, snapshot, restored = [tmp_path / name for name in ("live.sqlite3", "snapshot.sqlite3", "restored.sqlite3")]
    state = run_worker(database, "create", {})
    state = run_worker(database, "check", state)
    tables = ("organizations", "users", "machines", "events", "production", "machine_sources")
    with closing(sqlite3.connect(database)) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        expected = [conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables]
        assert expected == [1, 2, 1, 2, 1, 1]
        backup(database, snapshot)
        verify(snapshot)
        conn.execute("UPDATE organizations SET name='Post-backup mutation'")
        conn.commit()
    backup(snapshot, restored)
    verify(restored)
    state = run_worker(restored, "check", state)
    run_worker(restored, "check", state)
    with closing(sqlite3.connect(restored)) as conn:
        assert [conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables] == expected
    verify(restored)
    assert snapshot.stat().st_mode & 0o777 == 0o600
