"""Playwright-owned server; never opens the developer or deployment database."""

import os
from pathlib import Path
import signal
import sys
from tempfile import TemporaryDirectory

import uvicorn


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

if __name__ == "__main__":
    def exit_cleanly(signum, frame):
        raise SystemExit(0)

    # Uvicorn restores and replays signals after its graceful shutdown.
    signal.signal(signal.SIGTERM, exit_cleanly)
    signal.signal(signal.SIGINT, exit_cleanly)
    with TemporaryDirectory(prefix="itles-e2e-") as directory:
        os.environ.update(
            ITLES_DB_PATH=str(Path(directory) / "test.sqlite3"),
            ITLES_DEMO_ENABLED="1",
            ITLES_REGISTRATION_ENABLED="1",
            ITLES_COOKIE_SECURE="0",
        )
        uvicorn.run("server:app", host="127.0.0.1", port=3100, access_log=False)
