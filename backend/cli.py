import argparse
import getpass
import re
import secrets
import sqlite3
import sys

from .db import connect, default_db_path, hash_secret, initialize, issue_activation_code, new_id, password_hash, iso, utcnow


CODE_PATTERN = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
EMAIL_PATTERN = re.compile(r"\b[^\s@]+@[^\s@]+\.[^\s@]+\b")


def validate_label(parser: argparse.ArgumentParser, value: str | None, field: str) -> None:
    if value is None:
        return
    if not 1 <= len(value) <= 160 or any(ord(char) < 32 for char in value):
        parser.error(f"{field} must contain 1–160 printable characters")
    if EMAIL_PATTERN.search(value):
        print(f"warning: {field} looks like contact data; do not store personal data in labels", file=sys.stderr)


def issue_admin_access(conn: sqlite3.Connection, account: str, login: str, *, legacy: bool) -> tuple[str, str]:
    """Called only by a trusted operator after independent ownership verification."""
    conn.execute("BEGIN IMMEDIATE")
    organization = conn.execute("SELECT * FROM organizations WHERE account=? AND is_demo=0", (account,)).fetchone()
    if not organization:
        raise ValueError("company does not exist")
    org_id = organization["id"]
    user = conn.execute("SELECT * FROM users WHERE organization_id=? AND login=?", (org_id, login)).fetchone()
    if legacy:
        if not organization["password_hash"]:
            raise ValueError("company does not have a legacy credential; use reset-admin-access for an existing administrator")
        if conn.execute("SELECT 1 FROM users WHERE organization_id=? AND role='admin' AND status IN ('active','pending')", (org_id,)).fetchone():
            raise ValueError("company already has an administrator; ownership cannot be reassigned here")
        if user and not (user["id"] == f"legacy-admin-{org_id}" and user["status"] == "revoked"):
            raise ValueError("login is already assigned; choose a different administrator login")
        user_id = user["id"] if user else new_id()
        if not user:
            conn.execute(
                "INSERT INTO users(id,organization_id,login,role,status,created_at) VALUES(?,?,?,'admin','pending',?)",
                (user_id, org_id, login, iso(utcnow())),
            )
        conn.execute("DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE organization_id=? AND legacy_access=1)", (org_id,))
        conn.execute("UPDATE users SET status='revoked',password_hash=NULL WHERE organization_id=? AND legacy_access=1", (org_id,))
        conn.execute("DELETE FROM sessions WHERE organization_id=?", (org_id,))
        conn.execute("UPDATE organizations SET password_hash=NULL WHERE id=?", (org_id,))
    else:
        if not user or user["role"] != "admin" or user["legacy_access"]:
            raise ValueError("an individual administrator with this login is required")
        user_id = user["id"]
    conn.execute("UPDATE users SET status='pending',password_hash=NULL,must_change_password=0,legacy_access=0 WHERE id=?", (user_id,))
    conn.execute("DELETE FROM user_sessions WHERE user_id=?", (user_id,))
    conn.execute("DELETE FROM recovery_codes WHERE user_id=?", (user_id,))
    result = issue_activation_code(conn, user_id)
    conn.commit()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="ITles local provisioning; do not use personal identifiers.")
    parser.add_argument("--db", default=default_db_path())
    commands = parser.add_subparsers(dest="command", required=True)
    org = commands.add_parser("create-organization")
    org.add_argument("--account", required=True)
    org.add_argument("--name", required=True)
    org.add_argument("--password")
    machine = commands.add_parser("create-machine")
    machine.add_argument("--organization-id", required=True)
    machine.add_argument("--id", required=True)
    machine.add_argument("--name", required=True)
    machine.add_argument("--model")
    machine.add_argument("--head")
    machine.add_argument("--computer")
    for command in ("issue-legacy-admin", "reset-admin-access"):
        admin = commands.add_parser(command, help="operator-only activation after independent ownership verification")
        admin.add_argument("--account", required=True)
        admin.add_argument("--login", required=True)
        admin.add_argument("--owner-verified", action="store_true", required=True)
    args = parser.parse_args()
    conn = connect(args.db)
    initialize(conn)
    try:
        if args.command == "create-organization":
            if not 2 <= len(args.account) <= 80 or not CODE_PATTERN.fullmatch(args.account):
                parser.error("account must be a 2–80 character organization code")
            validate_label(parser, args.name, "name")
            password = args.password or getpass.getpass("Administrator password: ")
            if not 12 <= len(password) <= 128:
                parser.error("password must be 12–128 characters")
            if conn.execute("SELECT 1 FROM organizations WHERE account=? COLLATE NOCASE", (args.account,)).fetchone():
                parser.error("account is already in use")
            org_id = new_id()
            conn.execute(
                "INSERT INTO organizations(id,name,account,password_hash,is_demo) VALUES(?,?,?,?,0)",
                (org_id, args.name, args.account, None),
            )
            conn.execute(
                """INSERT INTO users(id,organization_id,login,role,password_hash,status,created_at,must_change_password)
                   VALUES(?,?,?,'admin',?,'active',?,0)""",
                (new_id(), org_id, "admin", password_hash(password), iso(utcnow())),
            )
            conn.commit()
            print(f"organization_id={org_id}")
        elif args.command in {"issue-legacy-admin", "reset-admin-access"}:
            if not 2 <= len(args.login) <= 80 or not CODE_PATTERN.fullmatch(args.login):
                parser.error("login must be a 2–80 character technical identifier")
            code, expires_at = issue_admin_access(conn, args.account, args.login, legacy=args.command == "issue-legacy-admin")
            print(f"activation_code={code}\nexpires_at={expires_at}")
        else:
            if not conn.execute("SELECT 1 FROM organizations WHERE id=?", (args.organization_id,)).fetchone():
                parser.error("organization_id does not exist")
            if not 2 <= len(args.id) <= 80 or not re.fullmatch(r"[a-z0-9]+(?:[_-][a-z0-9]+)*", args.id):
                parser.error("id must be a 2–80 character machine code")
            validate_label(parser, args.name, "name")
            validate_label(parser, args.model, "model")
            validate_label(parser, args.head, "head")
            validate_label(parser, args.computer, "computer")
            token = secrets.token_urlsafe(32)
            conn.execute("INSERT INTO machines VALUES(?,?,?,?,?,?)", (args.id, args.organization_id, args.name, args.model, args.head, args.computer))
            conn.execute("INSERT INTO device_tokens VALUES(?,?,?,?)", (hash_secret(token), args.organization_id, args.id, iso(utcnow())))
            conn.execute(
                "INSERT INTO device_token_metadata(token_hash,id,created_at) VALUES(?,?,?)",
                (hash_secret(token), new_id(), iso(utcnow())),
            )
            conn.commit()
            print(f"device_token={token}")  # Deliberately the only time a device credential is revealed.
    except ValueError as error:
        conn.rollback()
        parser.error(str(error))
    except sqlite3.IntegrityError:
        conn.rollback()
        parser.error("identifier already exists or its company is unavailable")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
