"""Create and verify a consistent SQLite backup without replacing an existing file."""

import argparse
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path


def verify(path: Path) -> None:
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as conn:
        if conn.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite integrity check failed")
        if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("SQLite foreign key check failed")


def backup(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise ValueError("Source database does not exist")
    if destination.exists() or destination.is_symlink():
        raise ValueError("Destination already exists; choose a new path")
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".itles-backup-", suffix=".sqlite3", dir=destination.parent)
    os.close(fd)
    try:
        with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as origin:
            with closing(sqlite3.connect(temporary)) as target:
                origin.backup(target)
                target.execute("PRAGMA journal_mode=DELETE")
        verify(Path(temporary))
        with open(temporary, "rb") as handle:
            os.fsync(handle.fileno())
        # Linking is atomic and cannot overwrite a concurrently created destination.
        os.link(temporary, destination)
        directory = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path, nargs="?")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    try:
        if args.verify_only:
            verify(args.source)
        elif args.destination is None:
            parser.error("destination is required unless --verify-only is used")
        else:
            backup(args.source, args.destination)
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"FAIL: backup/verification not completed ({type(error).__name__}). Check paths, permissions and database integrity.")
        return 1
    print("PASS: consistent SQLite copy verified" if not args.verify_only else "PASS: SQLite integrity and foreign keys verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
