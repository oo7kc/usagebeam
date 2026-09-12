"""Synthetic SQLite accuracy, privacy, concurrency and resource-bound checks."""

import importlib.util
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "src/collector/opencode_history.py"
spec = importlib.util.spec_from_file_location("opencode_history", SCRIPT)
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)
NOW = int(datetime(2026, 9, 12, 12).timestamp() * 1000)


class OpenCodeHistoryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="usagebeam-opencode-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "opencode.db"
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
            CREATE TABLE session_message(id TEXT PRIMARY KEY, type TEXT, time_created INTEGER, data TEXT);
            CREATE TABLE part(id TEXT PRIMARY KEY, data TEXT);
        """)

    def insert(
        self,
        id="message-1",
        *,
        session="private-session",
        created=NOW - 1000,
        tokens=None,
        **extra,
    ):
        data = dict(
            role="assistant",
            modelID="synthetic-model",
            tokens=tokens
            if tokens is not None
            else dict(input=100, output=20, reasoning=10, cache=dict(read=40, write=5)),
            content="PRIVATE_SENTINEL",
        )
        data.update(extra)
        self.db.execute(
            "INSERT OR REPLACE INTO message VALUES (?,?,?,?)",
            (id, session, created, json.dumps(data)),
        )
        self.db.commit()

    def read(self, **options):
        return history.read_history(self.path, NOW, **options)

    def test_normalized_tokens_include_reasoning_once_and_exclude_step_duplicates(self):
        self.insert()
        self.db.execute(
            "INSERT INTO part VALUES ('step', ?)",
            (json.dumps(dict(type="step-finish", tokens=dict(input=100))),),
        )
        self.db.commit()
        actual = self.read()
        self.assertEqual(actual["status"], "ready")
        self.assertEqual(
            actual["models"][0],
            dict(
                model="synthetic-model",
                total=175,
                input=100,
                output=30,
                cacheRead=40,
                cacheWrite=5,
            ),
        )
        self.assertEqual(sum(day["total"] for day in actual["days"]), 175)
        self.assertEqual(self.read(), actual)
        self.assertNotIn("private-session", json.dumps(actual))
        self.assertNotIn("PRIVATE_SENTINEL", json.dumps(actual))

    def test_message_updates_replace_usage_and_sessions_are_counted_once_per_day(self):
        self.insert()
        self.insert("message-2", modelID="second-model")
        self.assertEqual(self.read()["days"][-1]["sessions"], 1)
        self.insert(
            tokens=dict(input=200, output=30, reasoning=0, cache=dict(read=0, write=0))
        )
        self.assertEqual(self.read()["days"][-1]["total"], 405)

    def test_daily_buckets_exclude_old_future_and_user_records(self):
        self.insert()
        self.insert("old", created=NOW - 8 * 86400000)
        self.insert("future", created=NOW + 86400000)
        self.insert("user", role="user")
        cutoff = int(datetime(2026, 9, 6).timestamp() * 1000)
        self.insert("midnight", created=cutoff)
        self.insert("outside", created=cutoff - 1)
        actual = self.read()
        self.assertEqual(
            [day["total"] for day in actual["days"]], [175, 0, 0, 0, 0, 0, 175]
        )

    def test_unknown_fractional_boolean_negative_and_unsafe_tokens_stay_partial(self):
        self.insert()
        for index, value in enumerate([None, False, -1, "10", 0.5, 2**54]):
            self.insert(
                f"invalid-{index}",
                tokens=dict(input=value, output=0, cache=dict(read=0, write=0)),
            )
        actual = self.read()
        self.assertEqual(actual["status"], "partial")
        self.assertEqual(actual["days"][-1]["total"], 175)

    def test_malformed_json_preserves_readable_activity(self):
        self.insert()
        self.db.execute("INSERT INTO message VALUES ('bad', 's', ?, '{')", (NOW,))
        self.db.commit()
        self.assertEqual(self.read()["status"], "partial")
        self.assertEqual(self.read()["days"][-1]["total"], 175)

    def test_wal_reads_do_not_include_uncommitted_data_or_modify_source(self):
        self.insert()
        before = (self.path.read_bytes(), Path(str(self.path) + "-wal").read_bytes())
        self.db.execute("INSERT INTO message VALUES ('pending', 's', ?, '{}')", (NOW,))
        self.assertEqual(self.read()["status"], "ready")
        self.assertEqual(
            before, (self.path.read_bytes(), Path(str(self.path) + "-wal").read_bytes())
        )

    def test_new_formats_and_row_budget_are_explicit(self):
        self.insert()
        self.insert("second")
        self.assertEqual(self.read(max_rows=1)["status"], "partial")
        self.db.execute(
            "INSERT INTO session_message VALUES ('new', 'unverified-usage', ?, '{}')",
            (NOW,),
        )
        self.db.commit()
        self.assertEqual(self.read()["status"], "partial")
        self.db.execute("DROP TABLE message")
        self.assertEqual(self.read()["status"], "unsupported")

    def test_expired_deadline_stops_collection_with_partial_status(self):
        self.insert()
        self.db.executemany(
            "INSERT INTO message VALUES (?, 's', ?, '{}')",
            ((f"row-{index}", NOW) for index in range(2000)),
        )
        self.db.commit()
        self.assertEqual(self.read(seconds=-1)["status"], "partial")

    def test_missing_database_is_never_created(self):
        missing = self.path.parent / "missing.db"
        with self.assertRaises(sqlite3.OperationalError):
            history.read_history(missing, NOW)
        self.assertFalse(missing.exists())


if __name__ == "__main__":
    unittest.main()
