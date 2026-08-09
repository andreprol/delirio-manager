import pytest
from unittest.mock import patch, MagicMock
from main import run_pipeline

@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "temp"))
    monkeypatch.setenv("YOUTUBE_API_KEY", "fake-yt-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-anthropic-key")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "fake-el-key")
    from pipeline import queue
    queue.init_db()

def test_run_pipeline_processes_new_video(tmp_path):
    with (
        patch("main.fetch_new_videos", return_value=[
            {"id": "vid1", "title": "Test", "published_at": "2026-08-08T12:00:00Z"}
        ]),
        patch("main.download_video", return_value=tmp_path / "vid1.mp4"),
        patch("main.transcribe", return_value=[{"start": 0.0, "end": 10.0, "text": "Texto"}]),
        patch("main.analyze_rhetoric", return_value={
            "clip_start": 0.0, "clip_end": 10.0,
            "techniques": ["ethos"],
            "narration_script": "Script de narração",
            "title": "Título do vídeo",
            "description": "Descrição",
            "tags": ["tag1"],
        }),
        patch("main.synthesize_speech", return_value=tmp_path / "narration.mp3"),
        patch("main.build_video", return_value={
            "landscape": str(tmp_path / "landscape.mp4"),
            "portrait": str(tmp_path / "portrait.mp4"),
        }),
        patch("main.enqueue_output") as mock_enqueue,
        patch("main.next_upload_slot", return_value="2026-08-08T12:00:00"),
    ):
        run_pipeline(creator_handle="pablomarcall", channel_id="UCbroBIg8zvIH8-F4631wJhA")

    assert mock_enqueue.called

def test_run_pipeline_skips_processed_video(tmp_path):
    from pipeline.queue import mark_pending, mark_done
    mark_pending("vid1", "pablomarcall", "T", "2026-08-08T12:00:00Z")
    mark_done("vid1")

    with (
        patch("main.fetch_new_videos", return_value=[
            {"id": "vid1", "title": "Test", "published_at": "2026-08-08T12:00:00Z"}
        ]),
        patch("main.download_video") as mock_dl,
    ):
        run_pipeline(creator_handle="pablomarcall", channel_id="UCbroBIg8zvIH8-F4631wJhA")

    mock_dl.assert_not_called()
