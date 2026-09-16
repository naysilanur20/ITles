import os
import sqlite3
from pathlib import Path

import pytest

from scripts.backup_db import backup, verify


def test_backup_includes_committed_wal_and_restores_to_a_new_database(tmp_path):
    source = tmp_path / "live.sqlite3"
    destination = tmp_path / "backups" / "snapshot.sqlite3"
    with sqlite3.connect(source) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT)")
        conn.execute("INSERT INTO evidence VALUES(1,'synthetic')")
        conn.commit()
        backup(source, destination)
        conn.execute("INSERT INTO evidence VALUES(2,'after-backup')")
        conn.commit()
    assert os.stat(destination).st_mode & 0o777 == 0o600
    restored = tmp_path / "restored.sqlite3"
    backup(destination, restored)
    verify(restored)
    with sqlite3.connect(restored) as conn:
        assert conn.execute("SELECT * FROM evidence").fetchall() == [(1, "synthetic")]
    assert not list(destination.parent.glob(".itles-backup-*"))


def test_backup_never_replaces_existing_destination_or_symlink(tmp_path):
    source = tmp_path / "live.sqlite3"
    with sqlite3.connect(source) as conn:
        conn.execute("CREATE TABLE evidence(id INTEGER)")
    destination = tmp_path / "existing.sqlite3"
    destination.write_text("keep me")
    with pytest.raises(ValueError, match="already exists"):
        backup(source, destination)
    assert destination.read_text() == "keep me"
    link = tmp_path / "link.sqlite3"
    link.symlink_to(tmp_path / "absent.sqlite3")
    with pytest.raises(ValueError, match="already exists"):
        backup(source, link)


def test_failed_backup_does_not_publish_partial_copy(tmp_path):
    source = tmp_path / "broken.sqlite3"
    source.write_text("not a database")
    destination = tmp_path / "snapshot.sqlite3"
    with pytest.raises(sqlite3.DatabaseError):
        backup(source, destination)
    assert not destination.exists()
    assert not list(tmp_path.glob(".itles-backup-*"))
    with pytest.raises(ValueError, match="does not exist"):
        backup(Path("/nonexistent/itles.db"), destination)
