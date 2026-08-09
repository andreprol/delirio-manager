import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
from pipeline.downloader import download_video

def test_download_video_returns_path(tmp_path):
    with patch("pipeline.downloader.yt_dlp.YoutubeDL") as mock_ydl_cls:
        mock_ydl = MagicMock()
        mock_ydl_cls.return_value.__enter__.return_value = mock_ydl
        fake_path = tmp_path / "abc123.mp4"
        fake_path.touch()
        mock_ydl.prepare_filename.return_value = str(fake_path)
        result = download_video("abc123", output_dir=str(tmp_path))
    assert result == fake_path

def test_download_video_raises_on_failure(tmp_path):
    with patch("pipeline.downloader.yt_dlp.YoutubeDL") as mock_ydl_cls:
        mock_ydl = MagicMock()
        mock_ydl_cls.return_value.__enter__.return_value = mock_ydl
        mock_ydl.download.side_effect = Exception("Network error")
        mock_ydl.extract_info.side_effect = Exception("Network error")
        with pytest.raises(RuntimeError, match="Download failed"):
            download_video("abc123", output_dir=str(tmp_path))
