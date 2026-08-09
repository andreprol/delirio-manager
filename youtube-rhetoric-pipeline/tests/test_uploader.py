import pytest
import json
from pathlib import Path
from unittest.mock import patch, MagicMock
from pipeline.uploader import upload_video

def test_upload_video_returns_video_id(tmp_path):
    fake_video = tmp_path / "video.mp4"
    fake_video.write_bytes(b"fake")
    with patch("pipeline.uploader._get_youtube_service") as mock_svc:
        mock_youtube = MagicMock()
        mock_svc.return_value = mock_youtube
        mock_youtube.videos().insert().execute.return_value = {"id": "yt-xyz"}
        video_id = upload_video(
            file_path=str(fake_video),
            title="Marçal usa ethos",
            description="Análise de retórica",
            tags=["retórica", "Marçal"],
            secrets_file="config/client_secrets.json",
        )
    assert video_id == "yt-xyz"

def test_upload_video_raises_on_missing_file():
    with pytest.raises(FileNotFoundError):
        upload_video(
            file_path="/nonexistent.mp4",
            title="T",
            description="D",
            tags=[],
            secrets_file="config/client_secrets.json",
        )
