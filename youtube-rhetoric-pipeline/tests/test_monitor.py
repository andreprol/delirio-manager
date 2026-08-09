import pytest
from unittest.mock import MagicMock, patch
from pipeline.monitor import fetch_new_videos

MOCK_RESPONSE = {
    "items": [
        {
            "id": {"videoId": "abc123"},
            "snippet": {
                "title": "Como Marçal usa gatilhos mentais",
                "publishedAt": "2026-08-08T10:00:00Z",
            },
        },
        {
            "id": {"videoId": "def456"},
            "snippet": {
                "title": "Técnica de oratória explicada",
                "publishedAt": "2026-08-07T18:00:00Z",
            },
        },
    ]
}

def test_fetch_new_videos_returns_list():
    with patch("pipeline.monitor.build") as mock_build:
        mock_service = MagicMock()
        mock_build.return_value = mock_service
        mock_service.search().list().execute.return_value = MOCK_RESPONSE
        videos = fetch_new_videos(
            api_key="fake-key",
            channel_id="UCbroBIg8zvIH8-F4631wJhA",
            max_results=5,
        )
    assert len(videos) == 2
    assert videos[0]["id"] == "abc123"
    assert videos[0]["title"] == "Como Marçal usa gatilhos mentais"
    assert videos[0]["published_at"] == "2026-08-08T10:00:00Z"

def test_fetch_new_videos_empty_channel():
    with patch("pipeline.monitor.build") as mock_build:
        mock_service = MagicMock()
        mock_build.return_value = mock_service
        mock_service.search().list().execute.return_value = {"items": []}
        videos = fetch_new_videos(api_key="fake-key", channel_id="UCxxx", max_results=5)
    assert videos == []
