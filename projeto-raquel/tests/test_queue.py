import os
import pytest
import tempfile

os.environ["DB_PATH"] = ":memory:"


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    db_file = str(tmp_path / "test.db")
    monkeypatch.setenv("DB_PATH", db_file)
    from pipeline import queue as q
    # Force reload connection with new path
    import importlib
    importlib.reload(q)
    q.init_db()
    yield q


def test_add_and_get_brief(fresh_db):
    q = fresh_db
    brief_id = q.add_brief(
        content_type="review",
        raw_notes="Que drama lindo",
        drama_title="My Love from the Star",
        platform="Viki",
    )
    assert brief_id > 0
    brief = q.get_brief(brief_id)
    assert brief["drama_title"] == "My Love from the Star"
    assert brief["status"] == "pending"


def test_get_pending_briefs(fresh_db):
    q = fresh_db
    q.add_brief(content_type="review", raw_notes="Nota 1", drama_title="Drama A")
    q.add_brief(content_type="fanmeeting", raw_notes="Nota 2", event_name="Evento B")
    pending = q.get_pending_briefs()
    assert len(pending) == 2


def test_mark_brief_scripted(fresh_db):
    q = fresh_db
    brief_id = q.add_brief(content_type="review", raw_notes="notas")
    q.mark_brief_scripted(brief_id)
    brief = q.get_brief(brief_id)
    assert brief["status"] == "scripted"


def test_enqueue_upload(fresh_db):
    q = fresh_db
    brief_id = q.add_brief(content_type="review", raw_notes="notas", drama_title="Drama X")
    script_data = {
        "youtube_title": "Review: Drama X",
        "description": "Uma review incrível",
        "tags": ["kdrama", "review"],
        "chapters": [{"time": "0:00", "title": "Intro"}],
        "thumbnail_text": "Vale a pena?",
        "script": "Texto do roteiro aqui...",
        "shorts_hooks": [{"hook": "Você precisa assistir!", "topic": "review", "duration_sec": 60}],
        "blog_keywords": ["review drama x", "kdrama"],
    }
    queue_id = q.enqueue_upload(brief_id, script_data)
    assert queue_id > 0
    items = q.get_all_queue()
    assert len(items) == 1
    assert items[0]["title"] == "Review: Drama X"


def test_schedule_and_get_due(fresh_db):
    q = fresh_db
    brief_id = q.add_brief(content_type="review", raw_notes="notas")
    queue_id = q.enqueue_upload(brief_id, {"youtube_title": "Vídeo Teste"})

    from datetime import datetime, timedelta
    past_time = (datetime.utcnow() - timedelta(hours=1)).isoformat()[:16] + ":00"
    q.schedule_upload(queue_id, past_time)

    due = q.get_due_uploads()
    assert len(due) == 1
    assert due[0]["id"] == queue_id


def test_mark_uploaded(fresh_db):
    q = fresh_db
    brief_id = q.add_brief(content_type="review", raw_notes="notas")
    queue_id = q.enqueue_upload(brief_id, {"youtube_title": "Vídeo"})
    q.mark_uploaded(queue_id, "ytVideoId123")
    items = q.get_all_queue()
    assert items[0]["youtube_video_id"] == "ytVideoId123"
    assert items[0]["status"] == "done"
