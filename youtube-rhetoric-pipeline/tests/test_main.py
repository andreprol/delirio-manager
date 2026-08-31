import pytest
from unittest.mock import patch
from main import run_pipeline
from pipeline.queue import next_upload_slot as real_next_upload_slot

ANALYSIS = {
    "video_title": "Título do vídeo longo",
    "video_description": "Descrição SEO",
    "tags": ["tag1"],
    "segments": [
        {
            "clip_start": 10.0, "clip_end": 80.0, "techniques": ["ethos"],
            "narration_script": "Script 1", "segment_title": "Seg 1",
            "short_title": "Short 1", "short_description": "Desc short 1",
        },
        {
            "clip_start": 200.0, "clip_end": 280.0, "techniques": ["logos"],
            "narration_script": "Script 2", "segment_title": "Seg 2",
            "short_title": "Short 2", "short_description": "Desc short 2",
        },
    ],
}


@pytest.fixture(autouse=True)
def stub_probe():
    """probe_duration chama ffprobe de verdade; o vídeo-fonte aqui é mock."""
    with patch("main.probe_duration", return_value=1200.0):
        yield


@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "temp"))
    monkeypatch.setenv("YOUTUBE_API_KEY", "fake-yt-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-anthropic-key")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "fake-el-key")
    from pipeline import queue
    queue.init_db()


def _run(tmp_path, videos=None, **overrides):
    videos = videos if videos is not None else [
        {"id": "vid1", "title": "Test", "published_at": "2026-08-08T12:00:00Z"}
    ]
    patches = {
        "fetch_new_videos": videos,
        "download_video": tmp_path / "vid1.mp4",
        "transcribe": [{"start": 0.0, "end": 10.0, "text": "Texto"}],
        "analyze_rhetoric": ANALYSIS,
        "synthesize_speech": tmp_path / "narration.mp3",
        "build_long_video": str(tmp_path / "vid1_long.mp4"),
        "build_short": str(tmp_path / "vid1_short0.mp4"),
        "next_upload_slot": "2026-08-08T12:00:00",
    }
    patches.update(overrides)
    # None = usar o next_upload_slot real, contra o schedule.json do projeto.
    slot_patch = (
        patch("main.next_upload_slot", wraps=real_next_upload_slot)
        if patches["next_upload_slot"] is None
        else patch("main.next_upload_slot", return_value=patches["next_upload_slot"])
    )

    with (
        slot_patch,
        patch("main.fetch_new_videos", return_value=patches["fetch_new_videos"]),
        patch("main.download_video", return_value=patches["download_video"]),
        patch("main.transcribe", return_value=patches["transcribe"]),
        patch("main.analyze_rhetoric", return_value=patches["analyze_rhetoric"]),
        patch("main.synthesize_speech", return_value=patches["synthesize_speech"]) as mock_tts,
        patch("main.build_long_video", return_value=patches["build_long_video"]) as mock_long,
        patch("main.build_short", return_value=patches["build_short"]) as mock_short,
        patch("main.commit_video_outputs") as mock_enqueue,
        patch("main.send_pipeline_summary") as mock_summary,
    ):
        result = run_pipeline(
            creator_handle="pablomarcall", channel_id="UCbroBIg8zvIH8-F4631wJhA"
        )

    return {
        "result": result, "enqueue": mock_enqueue, "long": mock_long,
        "short": mock_short, "summary": mock_summary, "tts": mock_tts,
    }


def _committed(mocks) -> list[dict]:
    """commit_video_outputs(source_video_id, items) — uma chamada, transacional."""
    mocks["enqueue"].assert_called_once()
    source_video_id, items = mocks["enqueue"].call_args.args
    assert source_video_id == "vid1"
    return items


def test_enqueues_one_long_and_two_shorts(tmp_path):
    items = _committed(_run(tmp_path))

    kinds = [item["kind"] for item in items]
    assert kinds.count("long") == 1
    assert kinds.count("short") == 2


def test_long_upload_gets_the_landscape_file(tmp_path):
    items = _committed(_run(tmp_path))

    long_item = next(i for i in items if i["kind"] == "long")
    assert long_item["file_path"].endswith("_long.mp4")
    assert long_item["title"] == "Título do vídeo longo"


def test_every_output_gets_its_own_slot(tmp_path):
    """
    Os itens só vão para o banco na transação final, então a checagem de
    colisão do next_upload_slot não enxerga o slot recém-escolhido — os dois
    Shorts caíam no mesmo horário.
    """
    items = _committed(_run(tmp_path, next_upload_slot=None))
    slots = [item["scheduled_time"] for item in items]
    assert len(set(slots)) == len(slots)


def test_shorts_never_publish_before_the_long(tmp_path):
    """O Short divulga o longo; publicar antes inverte o funil."""
    mocks = _run(tmp_path, next_upload_slot=None)
    items = _committed(mocks)
    long_slot = next(i["scheduled_time"] for i in items if i["kind"] == "long")
    for short in (i for i in items if i["kind"] == "short"):
        assert short["scheduled_time"] > long_slot


def test_shorts_reuse_the_segment_narration(tmp_path):
    """Short sai da narração já sintetizada — nada de chamada extra ao ElevenLabs."""
    mocks = _run(tmp_path)
    # 2 segmentos = 2 narrações, mesmo produzindo 1 longo + 2 shorts
    assert mocks["tts"].call_count == 2
    assert mocks["short"].call_count == 2


def test_long_video_receives_every_segment(tmp_path):
    mocks = _run(tmp_path)
    segments = mocks["long"].call_args.kwargs["segments"]
    assert len(segments) == 2
    assert all("narration_path" in s for s in segments)


def test_respects_max_videos_per_run(tmp_path):
    videos = [
        {"id": "vid1", "title": "A", "published_at": "2026-08-08T12:00:00Z"},
        {"id": "vid2", "title": "B", "published_at": "2026-08-07T12:00:00Z"},
    ]
    mocks = _run(tmp_path, videos=videos)
    assert mocks["long"].call_count == 1


def test_skips_already_processed_video(tmp_path):
    from pipeline.queue import mark_pending, mark_done
    mark_pending("vid1", "pablomarcall", "T", "2026-08-08T12:00:00Z")
    mark_done("vid1")

    with (
        patch("main.fetch_new_videos", return_value=[
            {"id": "vid1", "title": "Test", "published_at": "2026-08-08T12:00:00Z"}
        ]),
        patch("main.download_video") as mock_dl,
        patch("main.send_pipeline_summary"),
    ):
        run_pipeline(creator_handle="pablomarcall", channel_id="UCbroBIg8zvIH8-F4631wJhA")

    mock_dl.assert_not_called()


def test_failure_is_reported_not_swallowed(tmp_path):
    """Erro em um vídeo vira e-mail e exit code, nunca silêncio."""
    with (
        patch("main.fetch_new_videos", return_value=[
            {"id": "vid1", "title": "Test", "published_at": "2026-08-08T12:00:00Z"}
        ]),
        patch("main.download_video", side_effect=RuntimeError("yt-dlp morreu")),
        patch("main.send_pipeline_summary") as mock_summary,
    ):
        produced, errors = run_pipeline(
            creator_handle="pablomarcall", channel_id="UCbroBIg8zvIH8-F4631wJhA"
        )

    assert produced == []
    assert errors[0]["error"] == "yt-dlp morreu"
    assert mock_summary.call_args.args == ([], errors)


def test_nothing_is_enqueued_when_a_short_fails(tmp_path):
    """
    Enfileirar o longo antes de renderizar os Shorts deixaria o fonte 'pending'
    com o longo já na fila — o run seguinte publicaria o mesmo vídeo de novo.
    """
    with (
        patch("main.fetch_new_videos", return_value=[
            {"id": "vid1", "title": "Test", "published_at": "2026-08-08T12:00:00Z"}
        ]),
        patch("main.download_video", return_value=tmp_path / "vid1.mp4"),
        patch("main.transcribe", return_value=[{"start": 0.0, "end": 10.0, "text": "T"}]),
        patch("main.analyze_rhetoric", return_value=ANALYSIS),
        patch("main.synthesize_speech", return_value=tmp_path / "n.mp3"),
        patch("main.build_long_video", return_value=str(tmp_path / "vid1_long.mp4")),
        patch("main.build_short", side_effect=RuntimeError("ffmpeg falhou")),
        patch("main.next_upload_slot", return_value="2026-08-08T12:00:00"),
        patch("main.commit_video_outputs") as mock_enqueue,
        patch("main.send_pipeline_summary"),
    ):
        produced, errors = run_pipeline(
            creator_handle="pablomarcall", channel_id="UCbroBIg8zvIH8-F4631wJhA"
        )

    mock_enqueue.assert_not_called()
    assert produced == []
    assert errors[0]["source_video_id"] == "vid1"

    from pipeline.queue import is_processed
    assert is_processed("vid1") is False


def test_empty_run_still_notifies(tmp_path):
    with (
        patch("main.fetch_new_videos", return_value=[]),
        patch("main.send_pipeline_summary") as mock_summary,
    ):
        run_pipeline(creator_handle="pablomarcall", channel_id="UCbroBIg8zvIH8-F4631wJhA")

    mock_summary.assert_called_once_with([], [])
