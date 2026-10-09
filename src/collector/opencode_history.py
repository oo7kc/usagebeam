"""Read OpenCode usage through a bounded, read-only SQLite connection.

Only projected usage fields enter Python; conversation bodies and credentials
are never selected. The process emits aggregate metadata, never identifiers.
"""

import json
import math
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

MAX_HISTORY_ROWS = 200_000
MAX_SAFE_INTEGER = 2**53 - 1
TOKEN_FIELDS = ("input", "output", "cacheRead", "cacheWrite")


ASSISTANT_USAGE_QUERY = """
    SELECT session_id, time_created,
           json_valid(data),
           json_extract(CASE WHEN json_valid(data) THEN data END, '$.role'),
           json_extract(CASE WHEN json_valid(data) THEN data END, '$.modelID'),
           json_extract(CASE WHEN json_valid(data) THEN data END, '$.tokens.input'),
           json_extract(CASE WHEN json_valid(data) THEN data END, '$.tokens.output'),
           json_extract(CASE WHEN json_valid(data) THEN data END, '$.tokens.reasoning'),
           json_extract(CASE WHEN json_valid(data) THEN data END, '$.tokens.cache.read'),
           json_extract(CASE WHEN json_valid(data) THEN data END, '$.tokens.cache.write'),
           json_type(CASE WHEN json_valid(data) THEN data END, '$.tokens.input') IN ('integer', 'real') AND
           json_type(CASE WHEN json_valid(data) THEN data END, '$.tokens.output') IN ('integer', 'real') AND
           json_type(CASE WHEN json_valid(data) THEN data END, '$.tokens.cache.read') IN ('integer', 'real') AND
           json_type(CASE WHEN json_valid(data) THEN data END, '$.tokens.cache.write') IN ('integer', 'real') AND
           coalesce(json_type(CASE WHEN json_valid(data) THEN data END, '$.tokens.reasoning'), 'integer') IN ('integer', 'real')
      FROM message
     WHERE time_created >= ? AND time_created <= ?
     LIMIT ?
"""


def create_empty_history(status, message):
    return dict(
        status=status,
        message=message,
        updatedAt=None,
        scope="local",
        source="OpenCode local activity",
        period=None,
        days=[],
        models=[],
    )


def parse_token_count(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Unknown token count")
    if (
        not math.isfinite(value)
        or value < 0
        or value > MAX_SAFE_INTEGER
        or value != int(value)
    ):
        raise ValueError("Invalid token count")
    return int(value)


def read_history(path, now, *, max_rows=MAX_HISTORY_ROWS, seconds=15):
    today = datetime.fromtimestamp(now / 1000).date()
    dates = [
        (today - timedelta(days=offset)).isoformat() for offset in range(6, -1, -1)
    ]
    cutoff = int(datetime.fromisoformat(dates[0]).timestamp() * 1000)
    days = {day: dict(date=day, total=0, sessions=0, events=0) for day in dates}
    sessions = {day: set() for day in dates}
    models = {}
    partial = False
    deadline = time.monotonic() + seconds
    connection = sqlite3.connect(
        Path(path).absolute().as_uri() + "?mode=ro", uri=True, timeout=1
    )
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("PRAGMA cache_size=-4096")
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 4 * 1024 * 1024)
        connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        connection.execute("BEGIN")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(message)")}
        if not {"id", "session_id", "time_created", "data"}.issubset(columns):
            return create_empty_history(
                "unsupported", "This OpenCode history format is not supported yet."
            )
        # Current OpenCode v1 assistant messages already sum their step usage.
        # Counting the part table as well would duplicate those tokens.
        for index, row in enumerate(
            connection.execute(ASSISTANT_USAGE_QUERY, (cutoff, now, max_rows + 1))
        ):
            if index >= max_rows or time.monotonic() >= deadline:
                partial = True
                break
            (
                session_id,
                created_at_ms,
                is_valid_json,
                role,
                model,
                input_tokens,
                output_tokens,
                reasoning,
                cache_read_tokens,
                cache_write_tokens,
                has_numeric_tokens,
            ) = row
            if not is_valid_json:
                partial = True
                continue
            if role != "assistant":
                continue
            try:
                if not has_numeric_tokens:
                    raise ValueError("Unknown token count")
                values = dict(
                    input=parse_token_count(input_tokens),
                    output=parse_token_count(output_tokens)
                    + parse_token_count(0 if reasoning is None else reasoning),
                    cacheRead=parse_token_count(cache_read_tokens),
                    cacheWrite=parse_token_count(cache_write_tokens),
                )
                total = parse_token_count(sum(values.values()))
                if not total:
                    continue
                if (
                    not isinstance(model, str)
                    or not model.strip()
                    or len(model) > 160
                    or any(ord(char) < 32 or ord(char) == 127 for char in model)
                ):
                    raise ValueError("Invalid model")
                if (
                    not isinstance(session_id, str)
                    or not session_id
                    or len(session_id) > 2048
                ):
                    raise ValueError("Invalid session")
                date = datetime.fromtimestamp(created_at_ms / 1000).date().isoformat()
                day = days[date]
                bucket = models.get(
                    model, dict(model=model, total=0, **dict.fromkeys(TOKEN_FIELDS, 0))
                )
                updated = {
                    field: parse_token_count(bucket[field] + values[field])
                    for field in TOKEN_FIELDS
                }
                model_total = parse_token_count(bucket["total"] + total)
                day_total = parse_token_count(day["total"] + total)
            except (ValueError, TypeError, OverflowError, KeyError):
                partial = True
                continue
            bucket.update(updated, total=model_total)
            models[model] = bucket
            day["total"] = day_total
            day["events"] += 1
            sessions[date].add(session_id)
        # Fail explicitly if a newer database contains v2 token-bearing events;
        # reporting only its legacy messages would imply complete totals.
        if connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_message'"
        ).fetchone():
            if connection.execute(
                "SELECT 1 FROM session_message WHERE time_created >= ? AND type NOT IN "
                "('agent-switched', 'model-switched') LIMIT 1",
                (cutoff,),
            ).fetchone():
                partial = True
    finally:
        connection.close()
    for date, day in days.items():
        day["sessions"] = len(sessions[date])
    model_rows = sorted(
        models.values(), key=lambda item: (-item["total"], item["model"])
    )
    partial |= len(model_rows) > 128
    return dict(
        status="partial" if partial else "ready",
        message="Some OpenCode activity could not be included. Totals may be incomplete."
        if partial
        else "",
        updatedAt=now,
        scope="local",
        source="OpenCode local activity",
        period=dict(start=dates[0], end=dates[-1]),
        days=list(days.values()),
        models=model_rows[:128],
    )


def main():
    if sys.version_info < (3, 11):
        print(
            json.dumps(
                create_empty_history(
                    "unavailable",
                    "Python 3.11 or newer is required to read OpenCode activity.",
                )
            )
        )
        return
    try:
        now = int(sys.argv[2])
        if now <= 0 or now > MAX_SAFE_INTEGER:
            raise ValueError("Invalid time")
        result = read_history(sys.argv[1], now)
    except (sqlite3.Error, OSError, ValueError, IndexError, OverflowError):
        result = create_empty_history(
            "unavailable",
            "OpenCode activity could not be read. Try refreshing after OpenCode finishes saving.",
        )
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
