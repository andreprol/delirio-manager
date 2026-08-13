import sqlite3
import json
import os
from pathlib import Path
from datetime import datetime, timedelta


def _db_path() -> Path:
    return Path(os.getenv("DB_PATH", "data/pipeline.db"))


def _conn():
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    con = _conn()
    con.executescript("""
        CREATE TABLE IF NOT EXISTS source_videos (
            id TEXT PRIMARY KEY,
            creator TEXT NOT NULL,
            title TEXT,
            published_at TEXT,
            processed_at TEXT,
            status TEXT DEFAULT 'pending'
        );
        CREATE TABLE IF NOT EXISTS output_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_video_id TEXT,
            clip_start REAL,
            clip_end REAL,
            title TEXT,
            description TEXT,
            tags TEXT,
            scheduled_time TEXT,
            uploaded_at TEXT,
            youtube_video_id TEXT,
            status TEXT DEFAULT 'queued'
        );
    """)
    con.commit()
    con.close()


def is_processed(video_id: str) -> bool:
    con = _conn()
    row = con.execute(
        "SELECT id FROM source_videos WHERE id = ? AND status = 'done'", (video_id,)
    ).fetchone()
    con.close()
    return row is not None


def mark_pending(video_id: str, creator: str, title: str, published_at: str):
    con = _conn()
    con.execute(
        "INSERT OR IGNORE INTO source_videos (id, creator, title, published_at) VALUES (?, ?, ?, ?)",
        (video_id, creator, title, published_at),
    )
    con.commit()
    con.close()


def mark_done(video_id: str):
    con = _conn()
    con.execute(
        "UPDATE source_videos SET status = 'done', processed_at = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), video_id),
    )
    con.commit()
    con.close()


def enqueue_output(
    source_video_id: str,
    clip_start: float,
    clip_end: float,
    title: str,
    description: str,
    tags: list,
    scheduled_time: str,
):
    con = _conn()
    con.execute(
        """INSERT INTO output_queue
           (source_video_id, clip_start, clip_end, title, description, tags, scheduled_time)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (source_video_id, clip_start, clip_end, title, description, json.dumps(tags), scheduled_time),
    )
    con.commit()
    con.close()


def get_due_uploads() -> list[dict]:
    con = _conn()
    now = datetime.utcnow().isoformat()
    rows = con.execute(
        "SELECT * FROM output_queue WHERE status = 'queued' AND scheduled_time <= ? ORDER BY scheduled_time LIMIT 1",
        (now,),
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def mark_uploaded(queue_id: int, youtube_video_id: str):
    con = _conn()
    con.execute(
        "UPDATE output_queue SET status = 'done', uploaded_at = ?, youtube_video_id = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), youtube_video_id, queue_id),
    )
    con.commit()
    con.close()


def next_upload_slot(schedule: list[str]) -> str:
    con = _conn()
    for days_ahead in range(7):
        day = (datetime.utcnow() + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
        for slot in schedule:
            scheduled_time = f"{day}T{slot}:00"
            if datetime.fromisoformat(scheduled_time) < datetime.utcnow():
                continue
            row = con.execute(
                "SELECT id FROM output_queue WHERE scheduled_time = ? AND status IN ('queued', 'uploading')",
                (scheduled_time,),
            ).fetchone()
            if not row:
                con.close()
                return scheduled_time
    con.close()
    raise RuntimeError("No available upload slot in next 7 days")
