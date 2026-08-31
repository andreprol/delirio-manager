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
    # Sem isto uma escrita concorrente (migração vs slot de upload) devolve
    # SQLITE_BUSY na hora e derruba a task.
    con.execute("PRAGMA busy_timeout = 10000")
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
    existing = {row["name"] for row in con.execute("PRAGMA table_info(output_queue)")}
    if "kind" not in existing:
        con.execute("ALTER TABLE output_queue ADD COLUMN kind TEXT DEFAULT 'short'")
    if "file_path" not in existing:
        con.execute("ALTER TABLE output_queue ADD COLUMN file_path TEXT")
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
    kind: str = "short",
    file_path: str = "",
):
    con = _conn()
    con.execute(
        """INSERT INTO output_queue
           (source_video_id, clip_start, clip_end, title, description, tags,
            scheduled_time, kind, file_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (source_video_id, clip_start, clip_end, title, description, json.dumps(tags),
         scheduled_time, kind, file_path),
    )
    con.commit()
    con.close()


def commit_video_outputs(source_video_id: str, items: list[dict]) -> None:
    """
    Enfileira todas as saídas de um vídeo-fonte e marca o fonte como processado
    numa transação só.

    Enfileirar o longo, falhar num Short e nunca chegar no mark_done deixaria o
    fonte 'pending' com o longo já na fila — o run seguinte re-renderizaria e
    publicaria o mesmo vídeo duas vezes.
    """
    con = _conn()
    try:
        with con:
            for item in items:
                con.execute(
                    """INSERT INTO output_queue
                       (source_video_id, clip_start, clip_end, title, description,
                        tags, scheduled_time, kind, file_path)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (source_video_id, item["clip_start"], item["clip_end"],
                     item["title"], item["description"], json.dumps(item["tags"]),
                     item["scheduled_time"], item["kind"], item["file_path"]),
                )
            con.execute(
                "UPDATE source_videos SET status = 'done', processed_at = ? WHERE id = ?",
                (datetime.utcnow().isoformat(), source_video_id),
            )
    finally:
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


def _slot_times(schedule: list, kind: str | None) -> list[str]:
    """Aceita ["12:00", ...] (formato antigo) ou [{"time","kind"}, ...]."""
    times = []
    for slot in schedule:
        if isinstance(slot, str):
            times.append(slot)
        elif kind is None or slot.get("kind") == kind:
            times.append(slot["time"])
    return times


def next_upload_slot(schedule: list, kind: str | None = None,
                     not_before: str | None = None,
                     taken: set[str] | None = None) -> str:
    """
    taken: slots já reservados nesta rodada mas ainda não gravados. As saídas de
    um vídeo são inseridas numa transação única no fim do processamento, então a
    checagem de colisão no banco não enxerga o slot que acabou de ser escolhido.
    """
    con = _conn()
    slot_times = _slot_times(schedule, kind)
    if not slot_times:
        con.close()
        raise RuntimeError(f"Nenhum slot configurado para kind='{kind}'")

    floor = datetime.utcnow()
    if not_before:
        floor = max(floor, datetime.fromisoformat(not_before))

    for days_ahead in range(7):
        day = (floor + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
        for slot in slot_times:
            scheduled_time = f"{day}T{slot}:00"
            if datetime.fromisoformat(scheduled_time) <= floor:
                continue
            if taken and scheduled_time in taken:
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
