from unittest.mock import MagicMock, patch
from pipeline.monitor import fetch_new_videos

SEARCH_RESPONSE = {
    "items": [
        {"id": {"videoId": "abc123"}},
        {"id": {"videoId": "def456"}},
    ]
}


def _detail(video_id, title, published_at, duration, live="none"):
    return {
        "id": video_id,
        "snippet": {"title": title, "publishedAt": published_at, "liveBroadcastContent": live},
        "contentDetails": {"duration": duration},
    }


DETAILS_RESPONSE = {
    "items": [
        _detail("abc123", "Como Marçal usa gatilhos mentais", "2026-08-08T10:00:00Z", "PT12M30S"),
        _detail("def456", "Técnica de oratória explicada", "2026-08-07T18:00:00Z", "PT8M"),
    ]
}


def _service(search_response=SEARCH_RESPONSE, details_response=DETAILS_RESPONSE):
    """Mock com search() e videos() configurados separadamente."""
    service = MagicMock()
    service.search.return_value.list.return_value.execute.return_value = search_response
    service.videos.return_value.list.return_value.execute.return_value = details_response
    return service


def _fetch(service, **kwargs):
    with patch("pipeline.monitor.build", return_value=service):
        return fetch_new_videos(
            api_key="fake-key", channel_id="UCbroBIg8zvIH8-F4631wJhA", **kwargs
        )


def test_fetch_new_videos_returns_list():
    videos = _fetch(_service(), max_results=5)
    assert len(videos) == 2
    assert videos[0]["id"] == "abc123"
    assert videos[0]["title"] == "Como Marçal usa gatilhos mentais"
    assert videos[0]["published_at"] == "2026-08-08T10:00:00Z"
    assert videos[0]["duration_seconds"] == 750


def test_fetch_new_videos_empty_channel():
    assert _fetch(_service(search_response={"items": []})) == []


def test_rejects_shorts_below_minimum_duration():
    """Vídeo curto vira Short no YouTube e não gera horas para o YPP."""
    details = {"items": [
        _detail("short1", "Corte viral", "2026-08-08T10:00:00Z", "PT58S"),
        _detail("ok1", "Live completa", "2026-08-08T10:00:00Z", "PT10M"),
    ]}
    videos = _fetch(_service(details_response=details))
    assert [v["id"] for v in videos] == ["ok1"]


def test_rejects_videos_above_maximum_duration():
    details = {"items": [_detail("longo", "Live de 2h", "2026-08-08T10:00:00Z", "PT2H")]}
    assert _fetch(_service(details_response=details)) == []


def test_rejects_lives_and_upcoming():
    details = {"items": [
        _detail("live1", "AO VIVO", "2026-08-08T10:00:00Z", "PT10M", live="live"),
        _detail("up1", "Estreia", "2026-08-08T10:00:00Z", "PT10M", live="upcoming"),
    ]}
    assert _fetch(_service(details_response=details)) == []


def test_search_asks_youtube_for_medium_length_videos():
    """videoDuration=medium filtra Shorts no servidor e poupa quota."""
    service = _service()
    _fetch(service)
    kwargs = service.search.return_value.list.call_args.kwargs
    assert kwargs["videoDuration"] == "medium"
    assert kwargs["order"] == "viewCount"
