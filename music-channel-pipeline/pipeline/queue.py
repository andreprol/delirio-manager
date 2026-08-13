import sqlite3
import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

DB_PATH = os.getenv("DB_PATH", "data/pipeline.db")
BRT = ZoneInfo("America/Sao_Paulo")

COMPOSITIONS_DAY = [
    ("day_front",   "facing camera, direct eye contact, smiling confidently, sunglasses on"),
    ("day_side",    "elegant side profile view, looking into distance, sunglasses on"),
    ("day_back",    "shot from behind showing tattoos and venue, crowd and sea ahead"),
]
COMPOSITIONS_NIGHT = [
    ("night_front", "facing camera, direct eye contact, smiling seductively, no sunglasses"),
    ("night_side",  "elegant side profile, city lights reflected in eyes, no sunglasses"),
    ("night_back",  "shot from behind, crowd and glowing night skyline ahead, no sunglasses"),
]
ALL_COMPOSITIONS = COMPOSITIONS_DAY + COMPOSITIONS_NIGHT


def init_db():
    os.makedirs(os.path.dirname(DB_PATH) if os.path.dirname(DB_PATH) else ".", exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA busy_timeout = 10000")
    con.executescript("""
        CREATE TABLE IF NOT EXISTS theme_rotation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            theme_id TEXT NOT NULL,
            used_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS composition_rotation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            composition_id TEXT NOT NULL,
            used_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS video_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            theme_id TEXT NOT NULL,
            composition_id TEXT NOT NULL,
            audio_filename TEXT NOT NULL,
            video_path TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            tags TEXT NOT NULL,
            scheduled_at TEXT NOT NULL,
            uploaded_at TEXT,
            youtube_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """)
    con.commit()
    con.close()


def _con():
    c = sqlite3.connect(DB_PATH)
    c.execute("PRAGMA busy_timeout = 10000")
    c.row_factory = sqlite3.Row
    return c


def get_next_theme(all_themes: list[dict]) -> dict:
    con = _con()
    used = [r["theme_id"] for r in con.execute(
        "SELECT theme_id FROM theme_rotation ORDER BY id DESC"
    ).fetchall()]
    con.close()
    theme_ids = [t["id"] for t in all_themes]
    for tid in theme_ids:
        if tid not in used:
            return next(t for t in all_themes if t["id"] == tid)
    # full rotation — restart
    return next(t for t in all_themes if t["id"] == theme_ids[0])


def get_next_composition() -> tuple[str, str]:
    con = _con()
    used_count = con.execute("SELECT COUNT(*) FROM composition_rotation").fetchone()[0]
    con.close()
    idx = used_count % len(ALL_COMPOSITIONS)
    return ALL_COMPOSITIONS[idx]


def mark_theme_used(theme_id: str):
    con = _con()
    con.execute("INSERT INTO theme_rotation (theme_id, used_at) VALUES (?, ?)",
                (theme_id, datetime.now(BRT).isoformat()))
    con.commit()
    con.close()


def mark_composition_used(composition_id: str):
    con = _con()
    con.execute("INSERT INTO composition_rotation (composition_id, used_at) VALUES (?, ?)",
                (composition_id, datetime.now(BRT).isoformat()))
    con.commit()
    con.close()


def next_upload_slot(upload_slots_brt: list[str]) -> str:
    now = datetime.now(BRT)
    for slot in sorted(upload_slots_brt):
        h, m = map(int, slot.split(":"))
        candidate = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if candidate > now:
            return candidate.isoformat()
    # next day first slot
    h, m = map(int, sorted(upload_slots_brt)[0].split(":"))
    return (now + timedelta(days=1)).replace(hour=h, minute=m, second=0, microsecond=0).isoformat()


def enqueue_video(theme_id, composition_id, audio_filename, video_path,
                  title, description, tags, scheduled_at):
    con = _con()
    con.execute("""
        INSERT INTO video_queue
        (theme_id, composition_id, audio_filename, video_path, title, description, tags, scheduled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (theme_id, composition_id, audio_filename, video_path,
          title, description, tags, scheduled_at))
    con.commit()
    con.close()


def get_due_uploads() -> list:
    con = _con()
    now = datetime.now(BRT).isoformat()
    rows = con.execute("""
        SELECT * FROM video_queue
        WHERE uploaded_at IS NULL AND scheduled_at <= ?
        ORDER BY scheduled_at ASC
        LIMIT 1
    """, (now,)).fetchall()
    con.close()
    return [dict(r) for r in rows]


def mark_uploaded(queue_id: int, youtube_id: str):
    con = _con()
    con.execute("UPDATE video_queue SET uploaded_at=?, youtube_id=? WHERE id=?",
                (datetime.now(BRT).isoformat(), youtube_id, queue_id))
    con.commit()
    con.close()
