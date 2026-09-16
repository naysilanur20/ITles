import importlib
import sqlite3
from contextlib import closing
from datetime import timedelta
from uuid import NAMESPACE_URL, uuid4, uuid5

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.cli import issue_admin_access
from backend.db import connect, hash_secret, initialize, iso, password_hash, password_matches, utcnow
from backend.seed import DEMO_ACCOUNT, DEMO_MACHINE_IDS, DEMO_ORG_ID, DEMO_VERSION


PASSWORD = "synthetic-account-password"


@pytest.fixture
def accounts(tmp_path, monkeypatch):
    monkeypatch.setenv("ITLES_COOKIE_SECURE", "0")
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "1")
    module = importlib.import_module("backend.app")
    for name in ("LOGIN_LIMITER", "REGISTRATION_LIMITER", "ACTIVATION_LIMITER", "RECOVERY_LIMITER", "REAUTH_LIMITER"):
        monkeypatch.setattr(module, name, module.LoginLimiter())
    monkeypatch.setattr(module, "AUTH_BUDGET", module.AuthBudget())
    monkeypatch.setattr(module, "DEMO_LOGIN_LIMITER", module.DemoLoginLimiter())
    path = str(tmp_path / "accounts.sqlite3")
    app = create_app(path)
    return path, lambda: TestClient(app)


def register(client, account="company-a", login="admin", **changes):
    result = client.post("/api/auth/register", json={
        "organization_name": "Синтетическая компания", "account": account,
        "login": login, "password": PASSWORD, **changes,
    })
    assert result.status_code == 200, result.text
    return result.json()


def legacy_database(path):
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE organizations (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, account TEXT NOT NULL UNIQUE,
          password_hash TEXT, is_demo INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE machines (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          name TEXT NOT NULL, model TEXT, head TEXT, computer TEXT
        );
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          expires_at TEXT NOT NULL
        );
        CREATE TABLE device_tokens (
          token_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          machine_id TEXT NOT NULL REFERENCES machines(id), created_at TEXT NOT NULL
        );
    """)
    encoded = password_hash(PASSWORD, iterations=310_000).split("$")
    legacy_hash = "$".join((encoded[0], encoded[2], encoded[3]))
    conn.execute("INSERT INTO organizations VALUES('old-org','Старая компания','old-company',?,0)", (legacy_hash,))
    conn.execute("INSERT INTO machines VALUES('old-machine','old-org','Сохранённая машина','model',NULL,'computer')")
    conn.execute("INSERT INTO sessions VALUES(?,'old-org',?)", (hash_secret("old-session"), iso(utcnow() + timedelta(days=1))))
    conn.execute("INSERT INTO device_tokens VALUES(?,'old-org','old-machine',?)", (hash_secret("old-device"), iso(utcnow())))
    conn.commit()
    conn.close()
    return legacy_hash


def test_shared_legacy_password_never_becomes_an_administrator(accounts):
    path, client = accounts
    legacy_database(path)
    old = client()
    result = old.post("/api/auth/login", json={"account": "old-company", "password": PASSWORD})
    assert result.status_code == 200
    assert result.json()["user"]["role"] == "user"
    assert result.json()["user"]["legacy_access"] is True
    assert old.get("/api/machines").json()["machines"][0]["id"] == "old-machine"
    assert old.get("/api/admin/users").status_code == 403
    assert old.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": PASSWORD + "-new"}).status_code == 403
    assert old.post("/api/admin/machines", json={"name": "Unauthorized"}).status_code == 403


def test_new_accounts_require_an_individual_login(accounts):
    _, client = accounts
    admin = client()
    register(admin)
    admin.post("/api/auth/logout")
    result = admin.post("/api/auth/login", json={"account": "company-a", "password": PASSWORD})
    assert result.status_code == 401


def test_registration_cannot_reserve_the_demo_account_before_first_demo_login(accounts, monkeypatch):
    path, client = accounts
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "0")
    visitor = client()
    assert visitor.get("/api/health").status_code == 200
    response = visitor.post("/api/auth/register", json={
        "organization_name": "Not the demo", "account": DEMO_ACCOUNT,
        "login": "admin", "password": PASSWORD,
    })
    assert response.status_code == 409
    assert visitor.get("/api/auth/me").status_code == 401
    with closing(connect(path)) as conn:
        assert conn.execute("SELECT COUNT(*) FROM organizations").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    monkeypatch.setenv("ITLES_DEMO_ENABLED", "1")
    demo = visitor.post("/api/auth/demo")
    assert demo.status_code == 200
    assert demo.json()["organization"]["id"] == DEMO_ORG_ID
    assert demo.json()["demo"] is True


@pytest.mark.parametrize("collision", ["account", "organization_id", "machine_id", "event_id"])
def test_demo_seed_conflicts_return_json_without_changing_existing_company(accounts, collision):
    path, client = accounts
    admin = client()
    registered = register(admin)
    org_id = registered["organization"]["id"]
    own_machine = machine(admin)
    with closing(connect(path)) as conn:
        if collision == "account":
            conn.execute("UPDATE organizations SET account=? WHERE id=?", (DEMO_ACCOUNT, org_id))
        elif collision == "organization_id":
            conn.execute(
                "INSERT INTO organizations VALUES(?, 'Existing company', 'existing-company', NULL, 0)",
                (DEMO_ORG_ID,),
            )
        elif collision == "machine_id":
            conn.execute(
                "INSERT INTO machines VALUES(?, ?, 'Existing machine', NULL, NULL, NULL)",
                (DEMO_MACHINE_IDS[0], org_id),
            )
        else:
            conn.execute(
                "INSERT INTO events VALUES(?, ?, ?, ?, 'telemetry', 'existing-hash', '{}', ?)",
                (reserved_demo_event_id(), org_id, own_machine, iso(utcnow()), iso(utcnow())),
            )
        conn.commit()
        snapshot = "\n".join(conn.iterdump())
    visitor = TestClient(create_app(path), raise_server_exceptions=False)
    response = visitor.post("/api/auth/demo")
    assert response.status_code == 503
    assert response.json() == {"detail": "demo temporarily unavailable", "code": "demo_unavailable"}
    assert response.headers.get("x-request-id")
    assert response.headers["cache-control"] == "no-store"
    assert visitor.get("/api/auth/me").status_code == 401
    assert admin.get("/api/auth/me").status_code == 200
    assert any(row["id"] == own_machine for row in admin.get("/api/machines").json()["machines"])
    with closing(connect(path)) as conn:
        assert "\n".join(conn.iterdump()) == snapshot


def reserved_demo_event_id():
    return str(uuid5(NAMESPACE_URL, f"itles:{DEMO_VERSION}:{DEMO_MACHINE_IDS[0]}:telemetry:2026-09-14T06:00:00.000000Z"))


def test_ingest_cannot_reserve_a_demo_event_id_before_first_demo_login(accounts):
    _, client = accounts
    admin = client()
    register(admin)
    machine_id = machine(admin)
    source(admin, machine_id)
    bearer = token(admin, machine_id)
    batch = packet(machine_id)
    batch["events"][0]["event_id"] = reserved_demo_event_id()
    response = ingest(client(), bearer, batch)
    assert response.status_code == 409
    assert response.json() == {"detail": "event_id is unavailable"}
    assert admin.get(f"/api/admin/machines/{machine_id}/source").json()["connection"]["message_count"] == 0
    assert client().post("/api/auth/demo").status_code == 200
    assert admin.get("/api/auth/me").status_code == 200


def test_migration_is_idempotent_and_preserves_legacy_data(accounts):
    path, client = accounts
    original_hash = legacy_database(path)
    for _ in range(2):
        conn = connect(path)
        initialize(conn)
        assert conn.execute("SELECT password_hash FROM organizations WHERE id='old-org'").fetchone()[0] == original_hash
        assert conn.execute("SELECT COUNT(*) FROM machines").fetchone()[0] == 1
        assert conn.execute("SELECT token_hash FROM device_tokens").fetchone()[0] == hash_secret("old-device")
        assert conn.execute("SELECT COUNT(*) FROM users WHERE organization_id='old-org' AND status='active'").fetchone()[0] == 1
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        conn.close()
    old = client()
    old.cookies.set("itles_session", "old-session")
    assert old.get("/api/auth/me").status_code == 401
    response = old.post("/api/auth/login", json={"account": "old-company", "login": "legacy", "password": PASSWORD})
    assert response.status_code == 200
    assert response.json()["user"]["role"] == "user"


def login(client, account="company-a", login="admin", password=PASSWORD):
    return client.post("/api/auth/login", json={"account": account, "login": login, "password": password})


def machine(client, name="Синтетическая машина"):
    response = client.post("/api/admin/machines", json={"name": name, "model": "test-model", "computer": "test-computer"})
    assert response.status_code == 200, response.text
    return response.json()["machine"]["id"]


def source(client, machine_id, **changes):
    return client.put(f"/api/admin/machines/{machine_id}/source", json={
        "model": "test-model", "computer": "test-computer", "software_version": "test-v1",
        "source_kind": "normalized_json", "export_description": "Синтетический JSON, не реальная техника",
        "permission_confirmed": True, **changes,
    })


def token(client, machine_id):
    response = client.post(f"/api/admin/machines/{machine_id}/tokens", json={"password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.json()["token"]


def packet(machine_id, *, occurred_at=None, volume=None):
    event = {"event_id": str(uuid4()), "machine_id": machine_id, "occurred_at": occurred_at or iso(utcnow())}
    if volume is None:
        event.update(kind="telemetry", measurements=[{"key": "fuel_level_pct", "value": 0, "unit": "%"}], position={"latitude": 62.0, "longitude": 33.0})
    else:
        event.update(kind="production", volume_m3=volume, basis="under_bark", source="operator_export", method="manual_ledger", method_version="synthetic-v1")
    return {"schema_version": 1, "batch_id": str(uuid4()), "events": [event]}


def ingest(client, bearer, batch):
    return client.post("/api/ingest", json=batch, headers={"Authorization": f"Bearer {bearer}"})


def grant(admin, reader, account="company-a"):
    issued = admin.post("/api/admin/users", json={"login": "reader"})
    assert issued.status_code == 200
    issued = issued.json()
    activation = {"account": account, "login": "reader", "code": issued["activation_code"], "password": PASSWORD}
    response = reader.post("/api/auth/activate", json=activation)
    assert response.status_code == 200, response.text
    assert response.json()["user"]["role"] == "user"
    assert "recovery_code" not in response.json()
    return issued["user"]["id"], activation


def execute(path, statement, parameters=()):
    with closing(connect(path)) as conn:
        conn.execute(statement, parameters)
        conn.commit()


def test_registration_preserves_identity_and_password_storage(accounts):
    path, client = accounts
    admin = client()
    registered = register(admin)
    assert admin.get("/api/auth/me").json()["user"] == registered["user"]
    assert registered["onboarding"]["completed"] is False
    assert admin.get("/api/machines").json()["machines"] == []
    assert admin.get("/api/fleet").json()["totals"] == []
    assert PASSWORD not in str(registered)
    assert "password_hash" not in str(registered)
    with closing(connect(path)) as conn:
        user = conn.execute("SELECT * FROM users").fetchone()
        assert password_matches(PASSWORD, user["password_hash"])
        assert user["password_hash"].startswith("pbkdf2_sha256$600000$")
        assert PASSWORD not in user["password_hash"]
        assert conn.execute("SELECT password_hash FROM organizations").fetchone()[0] is None
        assert conn.execute("SELECT code_hash FROM recovery_codes").fetchone()[0] == hash_secret(registered["recovery_code"])
    cookie = admin.cookies.get("itles_session")
    admin.post("/api/auth/logout")
    assert admin.get("/api/auth/me").status_code == 401
    assert login(admin).status_code == 200
    assert admin.cookies.get("itles_session") != cookie


def test_duplicate_name_creates_an_isolated_company_and_duplicate_code_does_not_join(accounts):
    _, client = accounts
    first, second = client(), client()
    a = register(first)
    b = register(second, "company-b")
    assert a["organization"]["name"] == b["organization"]["name"]
    assert a["organization"]["id"] != b["organization"]["id"]
    response = second.post("/api/auth/register", json={"organization_name": a["organization"]["name"], "account": "company-a", "login": "attacker", "password": PASSWORD})
    assert response.status_code == 409
    assert second.get("/api/auth/me").json()["organization"]["id"] == b["organization"]["id"]
    assert login(client(), login="attacker").status_code == 401


@pytest.mark.parametrize("changes", [
    {"account": "a"}, {"account": "COMPANY"}, {"account": "company..test"},
    {"login": "person@example.test"}, {"organization_name": "   "},
    {"organization_name": "bad\nname"}, {"password": "too-short"}, {"password": "x" * 129},
    {"role": "admin"}, {"organization_id": "foreign-company"},
])
def test_registration_validates_without_echoing_secrets(accounts, changes):
    _, client = accounts
    response = client().post("/api/auth/register", json={
        "organization_name": "Синтетическая компания", "account": "company-a", "login": "admin", "password": PASSWORD, **changes,
    })
    assert response.status_code == 422
    assert PASSWORD not in response.text


def test_registration_can_be_disabled_without_disabling_existing_logins(accounts, monkeypatch):
    _, client = accounts
    register(client())
    monkeypatch.setenv("ITLES_REGISTRATION_ENABLED", "0")
    assert client().get("/api/auth/options").json()["registration_enabled"] is False
    denied = client().post("/api/auth/register", json={"organization_name": "No", "account": "company-b", "login": "admin", "password": PASSWORD})
    assert denied.status_code == 403
    assert login(client()).status_code == 200


def test_all_administrative_routes_are_server_protected(accounts):
    _, client = accounts
    admin, reader, demo, anonymous = client(), client(), client(), client()
    registered = register(admin)
    machine_id = machine(admin)
    user_id, _ = grant(admin, reader)
    assert demo.post("/api/auth/demo").status_code == 200
    root = f"/api/admin/machines/{machine_id}"
    operations = [
        ("GET", "/api/admin/onboarding", None), ("PATCH", "/api/admin/onboarding", {"step": "source"}),
        ("PATCH", "/api/admin/company", {"name": "Forbidden"}), ("GET", "/api/admin/users", None),
        ("POST", "/api/admin/users", {"login": "unauthorized"}),
        ("POST", f"/api/admin/users/{user_id}/reissue", {}),
        ("DELETE", f"/api/admin/users/{user_id}", None),
        ("POST", f"/api/admin/users/{user_id}/sessions/revoke", {}),
        ("POST", "/api/admin/machines", {"name": "Forbidden"}), ("GET", root + "/source", None),
        ("PUT", root + "/source", {"source_kind": "unconfigured", "permission_confirmed": False}),
        ("POST", root + "/tokens", {"password": PASSWORD}), ("DELETE", root + "/tokens", None),
        ("POST", root + "/review", {"message_count": 1}),
        ("POST", "/api/auth/recovery-code", {"password": PASSWORD}),
    ]
    for caller, expected in ((reader, 403), (demo, 403), (anonymous, 401)):
        for method, path, body in operations:
            response = caller.request(method, path, json=body) if body is not None else caller.request(method, path)
            assert response.status_code == expected, (method, path, response.status_code)
    assert admin.get("/api/auth/me").json()["organization"]["id"] == registered["organization"]["id"]
    assert reader.get("/api/machines").json()["machines"][0]["id"] == machine_id


def test_company_boundaries_hold_for_admin_routes_read_api_and_exports(accounts):
    _, client = accounts
    a, b, reader, device = client(), client(), client(), client()
    register(a)
    register(b, "company-b")
    machine_a, machine_b = machine(a), machine(b)
    user_b, _ = grant(b, client(), "company-b")
    grant(a, reader)
    assert source(a, machine_a).status_code == 200
    assert source(b, machine_b).status_code == 200
    token_a, token_b = token(a, machine_a), token(b, machine_b)
    batch_a, batch_b = packet(machine_a, volume="1.250000"), packet(machine_b, volume="999.000000")
    assert ingest(device, token_a, batch_a).status_code == 200
    assert ingest(device, token_b, batch_b).status_code == 200
    assert ingest(device, token_a, packet(machine_b)).status_code == 403
    assert device.get("/api/machines", headers={"Authorization": f"Bearer {token_a}"}).status_code == 401
    for caller in (a, reader):
        assert [x["id"] for x in caller.get("/api/machines").json()["machines"]] == [machine_a]
        assert caller.get(f"/api/machines/{machine_b}").status_code == 404
        assert caller.get("/api/fleet").json()["totals"][0]["volume_m3"] == "1.250000"
        csv = caller.get("/api/exports/ledger.csv?organization_id=" + b.get("/api/auth/me").json()["organization"]["id"])
        assert csv.status_code == 200
        assert machine_a in csv.text and machine_b not in csv.text
        assert "999.000000" not in csv.text
        assert all(row["machine_id"] == machine_a for row in caller.get("/api/quality").json()["recent"])
    for suffix in ("source", "tokens", "review"):
        if suffix == "source":
            assert a.get(f"/api/admin/machines/{machine_b}/{suffix}").status_code == 404
            assert source(a, machine_b).status_code == 404
        else:
            body = {"password": PASSWORD} if suffix == "tokens" else {"message_count": 1}
            assert a.post(f"/api/admin/machines/{machine_b}/{suffix}", json=body).status_code == 404
    for suffix in ("reissue", "sessions/revoke"):
        assert a.post(f"/api/admin/users/{user_b}/{suffix}", json={}).status_code == 404
    assert a.delete(f"/api/admin/users/{user_b}").status_code == 404
    assert a.delete(f"/api/admin/machines/{machine_b}/tokens").status_code == 404
    assert a.post("/api/admin/users", json={"login": "power", "role": "admin"}).status_code == 422
    assert a.post("/api/admin/machines", json={"name": "Foreign", "organization_id": "company-b"}).status_code == 422


def test_activation_reissue_revocation_and_session_termination(accounts):
    _, client = accounts
    admin, reader, reader_second, colleague = client(), client(), client(), client()
    register(admin)
    user_id, activation = grant(admin, reader)
    assert login(reader_second, login="reader").status_code == 200
    assert client().post("/api/auth/activate", json=activation).status_code == 401
    assert admin.post(f"/api/admin/users/{user_id}/sessions/revoke").status_code == 200
    assert reader.get("/api/auth/me").status_code == 401
    assert reader_second.get("/api/auth/me").status_code == 401
    assert login(reader, login="reader").status_code == 200
    next_code = admin.post(f"/api/admin/users/{user_id}/reissue").json()["activation_code"]
    assert reader.get("/api/auth/me").status_code == 401
    assert login(reader, login="reader").status_code == 401
    assert reader.post("/api/auth/activate", json=activation).status_code == 401
    assert reader.post("/api/auth/activate", json=activation | {"code": next_code}).status_code == 200
    register(colleague, "company-b")
    assert admin.delete(f"/api/admin/users/{user_id}").status_code == 200
    assert reader.get("/api/auth/me").status_code == 401
    assert login(reader, login="reader").status_code == 401
    assert reader.post("/api/auth/activate", json=activation | {"code": next_code}).status_code == 401
    assert colleague.get("/api/auth/me").status_code == 200
    owner_id = admin.get("/api/auth/me").json()["user"]["id"]
    assert admin.delete(f"/api/admin/users/{owner_id}").status_code == 409


def test_expired_activation_does_not_create_a_session(accounts):
    path, client = accounts
    admin = client()
    register(admin)
    issued = admin.post("/api/admin/users", json={"login": "reader"}).json()
    execute(path, "UPDATE activation_codes SET expires_at=?", (iso(utcnow() - timedelta(seconds=1)),))
    reader = client()
    response = reader.post("/api/auth/activate", json={"account": "company-a", "login": "reader", "password": PASSWORD, "code": issued["activation_code"]})
    assert response.status_code == 401
    assert reader.get("/api/auth/me").status_code == 401


def test_recovery_is_single_use_and_revokes_only_its_owners_sessions(accounts):
    _, client = accounts
    admin, second, other, recovered = client(), client(), client(), client()
    registered = register(admin)
    register(other, "company-b")
    assert login(second).status_code == 200
    body = {"account": "company-a", "login": "admin", "recovery_code": registered["recovery_code"], "password": PASSWORD + "-new"}
    result = recovered.post("/api/auth/recover", json=body)
    assert result.status_code == 200
    assert result.json()["recovery_code"] != registered["recovery_code"]
    assert result.json()["user"]["must_change_password"] is False
    assert admin.get("/api/auth/me").status_code == 401
    assert second.get("/api/auth/me").status_code == 401
    assert other.get("/api/auth/me").status_code == 200
    assert recovered.get("/api/auth/me").status_code == 200
    assert client().post("/api/auth/recover", json=body).status_code == 401
    assert login(client()).status_code == 401
    assert login(client(), password=PASSWORD + "-new").status_code == 200


def test_recovery_rotation_and_expiration(accounts):
    path, client = accounts
    admin = client()
    registered = register(admin)
    replacement = admin.post("/api/auth/recovery-code", json={"password": PASSWORD}).json()["recovery_code"]
    body = {"account": "company-a", "login": "admin", "password": PASSWORD + "-new"}
    assert client().post("/api/auth/recover", json=body | {"recovery_code": registered["recovery_code"]}).status_code == 401
    execute(path, "UPDATE recovery_codes SET expires_at=?", (iso(utcnow() - timedelta(seconds=1)),))
    assert client().post("/api/auth/recover", json=body | {"recovery_code": replacement}).status_code == 401
    assert admin.get("/api/auth/me").status_code == 200


def test_password_change_and_logout_all_invalidate_only_the_current_user(accounts):
    _, client = accounts
    admin, second, reader = client(), client(), client()
    register(admin)
    grant(admin, reader)
    assert login(second).status_code == 200
    assert admin.post("/api/auth/password", json={"current_password": "incorrect", "new_password": PASSWORD + "-new"}).status_code == 401
    assert admin.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": PASSWORD + "-new"}).status_code == 200
    for caller in (admin, second):
        assert caller.get("/api/auth/me").status_code == 401
    assert reader.get("/api/auth/me").status_code == 200
    assert login(admin, password=PASSWORD + "-new").status_code == 200
    assert login(second, password=PASSWORD + "-new").status_code == 200
    assert admin.post("/api/auth/logout-all").status_code == 200
    assert second.get("/api/auth/me").status_code == 401
    assert reader.get("/api/auth/me").status_code == 200


def test_connection_flow_is_based_on_receipts_and_comparison_not_a_form(accounts):
    _, client = accounts
    admin, sender = client(), client()
    register(admin)
    machine_id = machine(admin)
    root = f"/api/admin/machines/{machine_id}"
    assert admin.get(root + "/source").json()["connection"]["state"] == "added"
    admin.patch("/api/admin/onboarding", json={"users_configured": True, "step": "source"})
    assert source(admin, machine_id, source_kind="unsupported").json()["connection"]["state"] == "source_unconfigured"
    assert admin.get("/api/admin/onboarding").json()["completed"] is False
    assert admin.post(root + "/tokens", json={"password": PASSWORD}).status_code == 409
    assert source(admin, machine_id, permission_confirmed=False).status_code == 200
    assert admin.post(root + "/tokens", json={"password": PASSWORD}).status_code == 409
    assert source(admin, machine_id, model="updated-model").json()["machine"]["model"] == "updated-model"
    assert admin.get(root + "/source").json()["connection"]["state"] == "source_unconfigured"
    bearer = token(admin, machine_id)
    assert admin.get(root + "/source").json()["connection"]["state"] == "awaiting_message"
    assert admin.get("/api/admin/onboarding").json()["completed"] is False
    assert admin.post(root + "/review", json={"message_count": 1}).status_code == 409
    assert ingest(sender, bearer, packet(machine_id)).json()["accepted"] == 1
    received = admin.get(root + "/source").json()
    assert received["connection"]["state"] == "review_required"
    assert received["connection"]["last_received_at"]
    assert received["connection"]["last_position_at"]
    reviewed = admin.post(root + "/review", json={"message_count": 1})
    assert reviewed.status_code == 200
    assert reviewed.json()["connection"]["state"] == "message_received"
    assert reviewed.json()["onboarding"]["completed"] is True
    assert admin.get("/api/admin/onboarding").json()["completed"] is True
    latest = admin.get("/api/machines").json()["machines"][0]
    assert latest["last_received_at"] == received["connection"]["last_received_at"]
    assert next(x for x in latest["metrics"] if x["key"] == "fuel_level_pct")["value"] == 0
    assert next(x for x in latest["metrics"] if x["key"] == "engine_rpm")["value"] is None
    admin.post("/api/auth/logout")
    assert login(admin).status_code == 200
    assert admin.get(root + "/source").json()["source"]["model"] == "updated-model"
    assert admin.get("/api/admin/onboarding").json()["step"] == "source"


def test_review_cannot_silently_cover_events_arriving_after_the_displayed_snapshot(accounts, monkeypatch):
    _, client = accounts
    admin = client()
    register(admin)
    machine_id = machine(admin)
    source(admin, machine_id)
    bearer = token(admin, machine_id)
    module = importlib.import_module("backend.app")
    instant = utcnow()
    monkeypatch.setattr(module, "utcnow", lambda: instant)
    assert ingest(client(), bearer, packet(machine_id, occurred_at=iso(instant))).status_code == 200
    root = f"/api/admin/machines/{machine_id}"
    assert admin.post(root + "/review", json={"message_count": 1}).status_code == 200
    assert ingest(client(), bearer, packet(machine_id, occurred_at=iso(instant))).status_code == 200
    assert admin.get(root + "/source").json()["connection"]["state"] == "review_required"
    assert admin.post(root + "/review", json={"message_count": 1}).status_code == 409
    assert admin.post(root + "/review", json={"message_count": 2}).status_code == 200


def test_new_arrival_of_old_observations_is_stale(accounts):
    _, client = accounts
    admin = client()
    register(admin)
    machine_id = machine(admin)
    source(admin, machine_id)
    bearer = token(admin, machine_id)
    assert ingest(client(), bearer, packet(machine_id, occurred_at=iso(utcnow() - timedelta(days=2)))).status_code == 200
    state = admin.get(f"/api/admin/machines/{machine_id}/source").json()["connection"]
    assert state["state"] == "stale"
    assert state["last_received_at"] > state["last_observed_at"]


def test_token_rotation_revocation_and_withdrawn_permission_stop_ingest(accounts):
    _, client = accounts
    admin, sender = client(), client()
    register(admin)
    machine_id = machine(admin)
    source(admin, machine_id)
    first = token(admin, machine_id)
    second = token(admin, machine_id)
    assert first != second
    assert ingest(sender, first, packet(machine_id)).status_code == 401
    assert ingest(sender, second, packet(machine_id)).status_code == 200
    listing = admin.get(f"/api/admin/machines/{machine_id}/source").json()
    assert len(listing["tokens"]) == 1
    assert first not in str(listing) and second not in str(listing) and hash_secret(second) not in str(listing)
    assert admin.delete(f"/api/admin/machines/{machine_id}/tokens").status_code == 200
    assert ingest(sender, second, packet(machine_id)).status_code == 401
    third = token(admin, machine_id)
    assert source(admin, machine_id, permission_confirmed=False).status_code == 200
    assert ingest(sender, third, packet(machine_id)).status_code == 401


def test_revoked_token_is_rechecked_inside_the_ingest_transaction(accounts):
    _, client = accounts
    admin, sender = client(), client()
    register(admin)
    machine_id = machine(admin)
    source(admin, machine_id)
    bearer = token(admin, machine_id)
    route = next(route for route in admin.app.routes if getattr(route, "path", "") == "/api/ingest")
    dependency = route.dependant.dependencies[0].call
    previously_authorized = dependency(f"Bearer {bearer}")
    admin.delete(f"/api/admin/machines/{machine_id}/tokens")
    admin.app.dependency_overrides[dependency] = lambda: previously_authorized
    try:
        assert ingest(sender, bearer, packet(machine_id)).status_code == 401
    finally:
        admin.app.dependency_overrides.clear()
    assert admin.get(f"/api/admin/machines/{machine_id}/source").json()["connection"]["message_count"] == 0


@pytest.mark.parametrize("origin", ["https://foreign.test", "null", "http://[", "http://testserver/path"])
def test_browser_mutations_reject_foreign_or_malformed_origins(accounts, origin):
    _, client = accounts
    response = client().post("/api/auth/demo", headers={"Origin": origin}, json={})
    assert response.status_code == 403
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers.get("x-request-id")


def test_authentication_attempts_are_limited_without_locking_other_users(accounts):
    _, client = accounts
    register(client())
    for _ in range(5):
        assert login(client(), password="wrong-password").status_code == 401
    assert login(client()).status_code == 429
    register(client(), "company-b")
    assert login(client(), "company-b").status_code == 200


def test_secure_session_is_not_downgraded_to_fix_http_login(accounts, monkeypatch):
    path, _ = accounts
    monkeypatch.delenv("ITLES_COOKIE_SECURE", raising=False)
    app = create_app(path)
    https = TestClient(app, base_url="https://testserver")
    response = https.post("/api/auth/register", json={"organization_name": "Test", "account": "company-a", "login": "admin", "password": PASSWORD})
    assert response.status_code == 200
    cookie = response.headers["set-cookie"]
    assert "Secure" in cookie and "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert https.get("/api/auth/me").status_code == 200
    http = TestClient(app)
    assert login(http).status_code == 200
    assert http.get("/api/auth/me").status_code == 401


def test_demo_reentry_reuses_only_its_own_session_and_failure_is_json(accounts, monkeypatch):
    path, client = accounts
    admin, demo, other_demo = client(), client(), client()
    register(admin)
    assert demo.post("/api/auth/demo").status_code == 200
    assert other_demo.post("/api/auth/demo").status_code == 200
    cookie = demo.cookies.get("itles_session")
    assert demo.post("/api/auth/demo").status_code == 200
    assert demo.cookies.get("itles_session") == cookie
    with closing(connect(path)) as conn:
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 2
    demo.post("/api/auth/logout")
    assert demo.post("/api/auth/demo").status_code == 200
    assert other_demo.get("/api/auth/me").status_code == 200
    assert admin.get("/api/auth/me").status_code == 200
    demo.post("/api/auth/logout")
    module = importlib.import_module("backend.app")
    def failing_seed(_conn):
        raise sqlite3.OperationalError("sensitive internal database details")
    monkeypatch.setattr(module, "seed_demo", failing_seed)
    response = demo.post("/api/auth/demo")
    assert response.status_code == 503
    assert "sensitive" not in response.text
    assert response.headers.get("x-request-id")
    assert other_demo.get("/api/auth/me").status_code == 200


def test_operator_activation_is_not_a_shared_password_upgrade(accounts):
    path, client = accounts
    legacy_database(path)
    legacy, owner = client(), client()
    assert login(legacy, "old-company", "legacy").status_code == 200
    with closing(connect(path)) as conn:
        code, _ = issue_admin_access(conn, "old-company", "owner", legacy=True)
        initialize(conn)
        assert conn.execute("SELECT password_hash FROM organizations").fetchone()[0] is None
    assert legacy.get("/api/auth/me").status_code == 401
    assert login(client(), "old-company", "legacy").status_code == 401
    result = owner.post("/api/auth/activate", json={"account": "old-company", "login": "owner", "code": code, "password": PASSWORD + "-owner"})
    assert result.status_code == 200
    assert result.json()["user"]["role"] == "admin"
    assert result.json()["recovery_code"]
    assert owner.get("/api/admin/users").status_code == 200
    with closing(connect(path)) as conn:
        with pytest.raises(ValueError):
            issue_admin_access(conn, "old-company", "another-owner", legacy=True)
        conn.rollback()
    assert owner.get("/api/auth/me").status_code == 200


def test_verified_operator_reset_keeps_company_data_and_employee_sessions(accounts):
    path, client = accounts
    admin, reader = client(), client()
    registered = register(admin)
    machine_id = machine(admin)
    grant(admin, reader)
    with closing(connect(path)) as conn:
        code, _ = issue_admin_access(conn, "company-a", "admin", legacy=False)
    assert admin.get("/api/auth/me").status_code == 401
    assert reader.get("/api/auth/me").status_code == 200
    assert reader.get("/api/machines").json()["machines"][0]["id"] == machine_id
    recovered = client()
    result = recovered.post("/api/auth/activate", json={"account": "company-a", "login": "admin", "code": code, "password": PASSWORD + "-new"})
    assert result.status_code == 200
    assert result.json()["organization"]["id"] == registered["organization"]["id"]
    assert result.json()["recovery_code"] != registered["recovery_code"]


def test_account_migration_rolls_back_on_failure(accounts):
    path, _ = accounts
    legacy_database(path)
    class BrokenMigration(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            if "INSERT INTO schema_migrations" in sql:
                raise sqlite3.OperationalError("simulated migration failure")
            return super().execute(sql, parameters)
    conn = sqlite3.connect(path, factory=BrokenMigration)
    conn.row_factory = sqlite3.Row
    try:
        with pytest.raises(sqlite3.OperationalError, match="simulated"):
            initialize(conn)
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM machines").fetchone()[0] == 1
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='users'").fetchone() is None
    finally:
        conn.close()
