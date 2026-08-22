import pytest
import json
from pathlib import Path
from pipeline.queue import init_db, is_processed, mark_pending, mark_done, enqueue_output, get_due_uploads, mark_uploaded, next_upload_slot

@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    init_db()

def test_is_processed_returns_false_for_new_video():
    assert is_processed("vid123") is False

def test_mark_pending_then_done_marks_processed():
    mark_pending("vid123", "pablomarcall", "Test Title", "2026-08-08T12:00:00")
    assert is_processed("vid123") is False
    mark_done("vid123")
    assert is_processed("vid123") is True

def test_mark_pending_idempotent():
    mark_pending("vid123", "pablomarcall", "Title", "2026-08-08T12:00:00")
    mark_pending("vid123", "pablomarcall", "Title", "2026-08-08T12:00:00")  # no exception
    assert is_processed("vid123") is False

def test_enqueue_output_and_get_due_uploads():
    enqueue_output("vid123", 10.5, 70.0, "Título", "Desc", ["tag1"], "2000-01-01T12:00:00")
    due = get_due_uploads()
    assert len(due) == 1
    assert due[0]["title"] == "Título"
    assert due[0]["clip_start"] == 10.5
    assert json.loads(due[0]["tags"]) == ["tag1"]

def test_get_due_uploads_excludes_future():
    enqueue_output("vid123", 0.0, 60.0, "T", "D", [], "2099-12-31T23:59:00")
    assert get_due_uploads() == []

def test_mark_uploaded():
    enqueue_output("vid123", 0.0, 60.0, "T", "D", [], "2000-01-01T12:00:00")
    due = get_due_uploads()
    mark_uploaded(due[0]["id"], "yt-abc123")
    assert get_due_uploads() == []

def test_next_upload_slot_returns_first_free():
    schedule = ["12:00", "18:00", "21:00"]
    slot = next_upload_slot(schedule)
    assert "12:00" in slot or "18:00" in slot or "21:00" in slot

def test_next_upload_slot_skips_taken():
    schedule = ["12:00", "18:00", "21:00"]
    slot1 = next_upload_slot(schedule)
    enqueue_output("v1", 0, 60, "T", "D", [], slot1)
    slot2 = next_upload_slot(schedule)
    assert slot2 != slot1


KIND_SCHEDULE = [
    {"time": "12:00", "kind": "long"},
    {"time": "18:00", "kind": "short"},
    {"time": "21:00", "kind": "short"},
]


def test_next_upload_slot_filters_by_kind():
    assert "12:00" in next_upload_slot(KIND_SCHEDULE, kind="long")
    short_slot = next_upload_slot(KIND_SCHEDULE, kind="short")
    assert "18:00" in short_slot or "21:00" in short_slot


def test_next_upload_slot_raises_for_unknown_kind():
    with pytest.raises(RuntimeError, match="kind='live'"):
        next_upload_slot(KIND_SCHEDULE, kind="live")


def test_enqueue_output_stores_kind_and_file_path():
    enqueue_output(
        "vid123", 10.0, 80.0, "Título", "Desc", ["tag"], "2000-01-01T12:00:00",
        kind="long", file_path="C:/temp/vid123_long.mp4",
    )
    item = get_due_uploads()[0]
    assert item["kind"] == "long"
    assert item["file_path"] == "C:/temp/vid123_long.mp4"


def test_enqueue_output_defaults_to_short():
    enqueue_output("vid123", 0.0, 60.0, "T", "D", [], "2000-01-01T12:00:00")
    assert get_due_uploads()[0]["kind"] == "short"


def test_init_db_is_idempotent_on_existing_db():
    """Migração roda em banco já criado sem duplicar coluna."""
    init_db()
    init_db()
    enqueue_output("v1", 0.0, 60.0, "T", "D", [], "2000-01-01T12:00:00", kind="long")
    assert get_due_uploads()[0]["kind"] == "long"


LEGACY_SCHEMA = """
    CREATE TABLE output_queue (
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
"""


def test_migrates_legacy_table_without_kind_and_file_path(tmp_path, monkeypatch):
    """Caminho real da migração: o banco de produção tem o schema antigo."""
    import sqlite3
    db = tmp_path / "legacy.db"
    monkeypatch.setenv("DB_PATH", str(db))

    con = sqlite3.connect(db)
    con.executescript(LEGACY_SCHEMA)
    con.execute(
        "INSERT INTO output_queue (source_video_id, title, scheduled_time, status)"
        " VALUES ('velho', 'Vídeo antigo', '2000-01-01T12:00:00', 'queued')"
    )
    con.commit()
    con.close()

    init_db()

    item = get_due_uploads()[0]
    assert item["title"] == "Vídeo antigo"
    assert item["kind"] == "short"
    assert item["file_path"] is None
