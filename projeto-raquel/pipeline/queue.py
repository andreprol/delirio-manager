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
        CREATE TABLE IF NOT EXISTS content_briefs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            source_ref TEXT,
            drama_title TEXT,
            event_name TEXT,
            artists TEXT,
            event_date TEXT,
            event_location TEXT,
            ticket_price TEXT,
            platform TEXT,
            raw_notes TEXT,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
        );

        CREATE TABLE IF NOT EXISTS instagram_synced (
            instagram_id TEXT PRIMARY KEY,
            synced_at TEXT NOT NULL,
            youtube_video_id TEXT
        );

        CREATE TABLE IF NOT EXISTS upload_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            brief_id INTEGER NOT NULL,
            video_type TEXT NOT NULL DEFAULT 'long',
            title TEXT,
            description TEXT,
            tags TEXT,
            chapters TEXT,
            thumbnail_text TEXT,
            script TEXT,
            shorts_hooks TEXT,
            blog_keywords TEXT,
            blog_article TEXT,
            scheduled_time TEXT,
            uploaded_at TEXT,
            youtube_video_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            FOREIGN KEY (brief_id) REFERENCES content_briefs(id)
        );
    """)
    con.commit()
    con.close()


def add_brief(
    content_type: str,
    raw_notes: str,
    source: str = "manual",
    source_ref: str = None,
    drama_title: str = None,
    event_name: str = None,
    artists: str = None,
    event_date: str = None,
    event_location: str = None,
    ticket_price: str = None,
    platform: str = None,
) -> int:
    con = _conn()
    cur = con.execute(
        """INSERT INTO content_briefs
           (type, source, source_ref, drama_title, event_name, artists,
            event_date, event_location, ticket_price, platform, raw_notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            content_type, source, source_ref, drama_title, event_name, artists,
            event_date, event_location, ticket_price, platform,
            raw_notes, datetime.utcnow().isoformat(),
        ),
    )
    brief_id = cur.lastrowid
    con.commit()
    con.close()
    return brief_id


def get_pending_briefs() -> list[dict]:
    con = _conn()
    rows = con.execute(
        "SELECT * FROM content_briefs WHERE status = 'pending' ORDER BY created_at"
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def get_brief(brief_id: int) -> dict | None:
    con = _conn()
    row = con.execute("SELECT * FROM content_briefs WHERE id = ?", (brief_id,)).fetchone()
    con.close()
    return dict(row) if row else None


def mark_brief_scripted(brief_id: int):
    con = _conn()
    con.execute(
        "UPDATE content_briefs SET status = 'scripted' WHERE id = ?", (brief_id,)
    )
    con.commit()
    con.close()


def mark_brief_done(brief_id: int):
    con = _conn()
    con.execute(
        "UPDATE content_briefs SET status = 'done' WHERE id = ?", (brief_id,)
    )
    con.commit()
    con.close()


def enqueue_upload(brief_id: int, script_data: dict, video_type: str = "long") -> int:
    con = _conn()
    cur = con.execute(
        """INSERT INTO upload_queue
           (brief_id, video_type, title, description, tags, chapters,
            thumbnail_text, script, shorts_hooks, blog_keywords)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            brief_id,
            video_type,
            script_data.get("youtube_title"),
            script_data.get("description"),
            json.dumps(script_data.get("tags", [])),
            json.dumps(script_data.get("chapters", [])),
            script_data.get("thumbnail_text"),
            script_data.get("script"),
            json.dumps(script_data.get("shorts_hooks", [])),
            json.dumps(script_data.get("blog_keywords", [])),
        ),
    )
    queue_id = cur.lastrowid
    con.commit()
    con.close()
    return queue_id


def set_blog_article(queue_id: int, article_json: str):
    con = _conn()
    con.execute(
        "UPDATE upload_queue SET blog_article = ? WHERE id = ?", (article_json, queue_id)
    )
    con.commit()
    con.close()


def schedule_upload(queue_id: int, scheduled_time: str):
    con = _conn()
    con.execute(
        "UPDATE upload_queue SET scheduled_time = ?, status = 'scheduled' WHERE id = ?",
        (scheduled_time, queue_id),
    )
    con.commit()
    con.close()


def get_due_uploads() -> list[dict]:
    con = _conn()
    now = datetime.utcnow().isoformat()
    rows = con.execute(
        """SELECT * FROM upload_queue
           WHERE status = 'scheduled' AND scheduled_time <= ?
           ORDER BY scheduled_time""",
        (now,),
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def get_all_queue() -> list[dict]:
    con = _conn()
    rows = con.execute(
        """SELECT q.*, b.type as brief_type, b.drama_title, b.event_name
           FROM upload_queue q
           JOIN content_briefs b ON q.brief_id = b.id
           ORDER BY q.id DESC"""
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def mark_uploaded(queue_id: int, youtube_video_id: str):
    con = _conn()
    con.execute(
        "UPDATE upload_queue SET status = 'done', uploaded_at = ?, youtube_video_id = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), youtube_video_id, queue_id),
    )
    con.commit()
    con.close()


def is_instagram_synced(instagram_id: str) -> bool:
    con = _conn()
    row = con.execute(
        "SELECT 1 FROM instagram_synced WHERE instagram_id = ?", (instagram_id,)
    ).fetchone()
    con.close()
    return row is not None


def mark_instagram_synced(instagram_id: str, youtube_video_id: str = None):
    con = _conn()
    con.execute(
        "INSERT OR REPLACE INTO instagram_synced (instagram_id, synced_at, youtube_video_id) VALUES (?, ?, ?)",
        (instagram_id, datetime.utcnow().isoformat(), youtube_video_id),
    )
    con.commit()
    con.close()


def enqueue_instagram_video(instagram_id: str, title: str, description: str, tags: list, video_path: str) -> int:
    """Cria um brief 'instagram' e enfileira o vídeo para upload."""
    con = _conn()
    now = datetime.utcnow().isoformat()
    cur = con.execute(
        """INSERT INTO content_briefs (type, source, source_ref, raw_notes, created_at, status)
           VALUES ('instagram', 'instagram', ?, ?, ?, 'scripted')""",
        (instagram_id, title, now),
    )
    brief_id = cur.lastrowid
    cur2 = con.execute(
        """INSERT INTO upload_queue (brief_id, video_type, title, description, tags, status)
           VALUES (?, 'long', ?, ?, ?, 'ready')""",
        (brief_id, title, description, json.dumps(tags)),
    )
    queue_id = cur2.lastrowid
    con.commit()
    con.close()
    return queue_id


def get_ready_uploads() -> list[dict]:
    """Retorna uploads com status 'ready' (prontos para upload imediato)."""
    con = _conn()
    rows = con.execute(
        """SELECT q.*, b.type as brief_type, b.source_ref as instagram_id
           FROM upload_queue q
           JOIN content_briefs b ON q.brief_id = b.id
           WHERE q.status = 'ready'
           ORDER BY q.id"""
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def next_upload_slot(upload_slots_brt: list[str], max_per_day: int = 1) -> str:
    con = _conn()
    for days_ahead in range(14):
        day = (datetime.utcnow() + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
        day_count = con.execute(
            "SELECT COUNT(*) FROM upload_queue WHERE scheduled_time LIKE ? AND status IN ('scheduled', 'done')",
            (f"{day}%",),
        ).fetchone()[0]
        if day_count >= max_per_day:
            continue
        for slot in upload_slots_brt:
            candidate = f"{day}T{slot}:00"
            if datetime.fromisoformat(candidate) < datetime.utcnow():
                continue
            taken = con.execute(
                "SELECT id FROM upload_queue WHERE scheduled_time = ? AND status IN ('scheduled', 'done')",
                (candidate,),
            ).fetchone()
            if not taken:
                con.close()
                return candidate
    con.close()
    raise RuntimeError("Nenhum slot disponível nos próximos 14 dias")
