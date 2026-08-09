import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
from pipeline.editor import build_video

def test_build_video_calls_ffmpeg_and_returns_paths(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    narration = tmp_path / "narration.mp3"
    narration.touch()
    intro = tmp_path / "intro.mp4"
    intro.touch()
    outro = tmp_path / "outro.mp4"
    outro.touch()
    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0)
        result = build_video(
            source_path=str(source),
            narration_path=str(narration),
            intro_path=str(intro),
            outro_path=str(outro),
            clip_start=10.0,
            clip_end=70.0,
            output_dir=str(tmp_path),
            video_id="abc123",
        )
    assert mock_run.called
    assert "landscape" in result
    assert "portrait" in result

def test_build_video_raises_on_ffmpeg_failure(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    narration = tmp_path / "narration.mp3"
    narration.touch()
    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1, stderr=b"error")
        with pytest.raises(RuntimeError, match="ffmpeg failed"):
            build_video(
                source_path=str(source),
                narration_path=str(narration),
                intro_path=None,
                outro_path=None,
                clip_start=10.0,
                clip_end=70.0,
                output_dir=str(tmp_path),
                video_id="abc123",
            )
