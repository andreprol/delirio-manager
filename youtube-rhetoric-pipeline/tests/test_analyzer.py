import pytest
import json
from unittest.mock import patch, MagicMock
from pipeline.analyzer import analyze_rhetoric

SEGMENTS = [
    {"start": 0.0, "end": 5.0, "text": "Sabe qual é o poder da repetição?"},
    {"start": 5.0, "end": 12.0, "text": "Quando você repete uma ideia três vezes, ela vira verdade na mente do ouvinte."},
]


def _segment(start, end, narration="Marçal usa repetição deliberada."):
    return {
        "clip_start": start,
        "clip_end": end,
        "techniques": ["repetição", "ancoragem"],
        "narration_script": narration,
        "segment_title": "A arma da repetição",
        "short_title": "Como Marçal usa repetição",
        "short_description": "Análise da técnica de repetição.",
    }


MOCK_RESPONSE_JSON = {
    "video_title": "As 4 técnicas de persuasão de Pablo Marçal",
    "video_description": "Análise completa de 4 momentos retóricos.",
    "tags": ["retórica", "persuasão", "Marçal"],
    "segments": [_segment(120.0, 200.0), _segment(10.0, 90.0)],
}


def _mock_claude(text: str):
    mock_cls = patch("pipeline.analyzer.anthropic.Anthropic").start()
    mock_client = MagicMock()
    mock_cls.return_value = mock_client
    mock_message = MagicMock()
    mock_message.content[0].text = text
    mock_client.messages.create.return_value = mock_message
    return mock_client


@pytest.fixture(autouse=True)
def stop_patches():
    yield
    patch.stopall()


def _analyze(**kwargs):
    defaults = dict(
        segments=SEGMENTS,
        api_key="fake-key",
        prompt_template="Analise {segments_wanted} trechos: {transcription}",
        max_narration_chars=600,
    )
    defaults.update(kwargs)
    return analyze_rhetoric(**defaults)


def test_returns_video_metadata_and_segments():
    _mock_claude(json.dumps(MOCK_RESPONSE_JSON))
    result = _analyze()
    assert result["video_title"].startswith("As 4 técnicas")
    assert result["tags"] == ["retórica", "persuasão", "Marçal"]
    assert len(result["segments"]) == 2


def test_segments_come_back_in_chronological_order():
    _mock_claude(json.dumps(MOCK_RESPONSE_JSON))
    result = _analyze()
    starts = [s["clip_start"] for s in result["segments"]]
    assert starts == sorted(starts)


def test_short_segment_is_extended_to_minimum():
    payload = dict(MOCK_RESPONSE_JSON, segments=[_segment(10.0, 25.0)])
    _mock_claude(json.dumps(payload))
    result = _analyze()
    segment = result["segments"][0]
    assert segment["clip_end"] - segment["clip_start"] == 60.0


def test_narration_is_truncated_to_limit():
    payload = dict(MOCK_RESPONSE_JSON, segments=[_segment(10.0, 90.0, "x" * 5000)])
    _mock_claude(json.dumps(payload))
    result = _analyze(max_narration_chars=600)
    assert len(result["segments"][0]["narration_script"]) == 600


def test_strips_markdown_code_fence():
    _mock_claude("```json\n" + json.dumps(MOCK_RESPONSE_JSON) + "\n```")
    result = _analyze()
    assert len(result["segments"]) == 2


def test_discards_overlapping_segments():
    """Sobreposição repetiria o mesmo trecho dentro do vídeo longo."""
    payload = dict(MOCK_RESPONSE_JSON, segments=[
        _segment(10.0, 90.0),
        _segment(50.0, 130.0),   # começa dentro do anterior
        _segment(200.0, 280.0),
    ])
    _mock_claude(json.dumps(payload))
    result = _analyze(segments_wanted=4)
    assert [s["clip_start"] for s in result["segments"]] == [10.0, 200.0]


def test_conflict_keeps_the_longer_original_segment():
    """
    Um stub de 10s esticado pelo safety net não pode matar um segmento
    legítimo de 80s só por vir antes na linha do tempo.
    """
    payload = dict(MOCK_RESPONSE_JSON, segments=[
        _segment(10.0, 20.0),    # 10s reais, estendido para 70.0
        _segment(40.0, 120.0),   # 80s reais, colide com o estendido
    ])
    _mock_claude(json.dumps(payload))
    result = _analyze(segments_wanted=4)
    assert len(result["segments"]) == 1
    assert result["segments"][0]["clip_start"] == 40.0
    assert result["segments"][0]["clip_end"] == 120.0


def test_discards_segment_beyond_source_duration():
    """Timestamp alucinado além do fim geraria clipe vazio sem erro do ffmpeg."""
    payload = dict(MOCK_RESPONSE_JSON, segments=[
        _segment(10.0, 90.0),
        _segment(5000.0, 5080.0),
    ])
    _mock_claude(json.dumps(payload))
    result = _analyze(segments_wanted=4, source_duration=600.0)
    assert [s["clip_start"] for s in result["segments"]] == [10.0]


def test_clamps_segment_that_overruns_the_end():
    payload = dict(MOCK_RESPONSE_JSON, segments=[_segment(500.0, 700.0)])
    _mock_claude(json.dumps(payload))
    result = _analyze(segments_wanted=4, source_duration=600.0)
    assert result["segments"][0]["clip_end"] == 600.0


def test_discards_segment_too_close_to_the_end():
    """Sobra menor que o mínimo de 60s não vira segmento."""
    payload = dict(MOCK_RESPONSE_JSON, segments=[
        _segment(10.0, 90.0),
        _segment(580.0, 660.0),
    ])
    _mock_claude(json.dumps(payload))
    result = _analyze(segments_wanted=4, source_duration=600.0)
    assert [s["clip_start"] for s in result["segments"]] == [10.0]


def test_rejects_null_narration_script():
    payload = dict(MOCK_RESPONSE_JSON, segments=[
        {"clip_start": 10.0, "clip_end": 90.0, "narration_script": None},
    ])
    _mock_claude(json.dumps(payload))
    with pytest.raises(ValueError, match="narration_script"):
        _analyze()


def test_no_raw_duration_leaks_into_output():
    _mock_claude(json.dumps(MOCK_RESPONSE_JSON))
    result = _analyze()
    assert all("raw_duration" not in s for s in result["segments"])


def test_caps_segments_at_requested_count():
    """10 segmentos = 20 encodes ffmpeg; o teto protege o tempo de run."""
    payload = dict(MOCK_RESPONSE_JSON, segments=[
        _segment(start, start + 80.0) for start in range(0, 1000, 100)
    ])
    _mock_claude(json.dumps(payload))
    result = _analyze(segments_wanted=4)
    assert len(result["segments"]) == 4


def test_raises_on_invalid_json():
    _mock_claude("não é json")
    with pytest.raises(ValueError, match="Invalid JSON"):
        _analyze()


def test_raises_when_segments_missing():
    _mock_claude(json.dumps({"video_title": "T", "tags": []}))
    with pytest.raises(ValueError, match="segments"):
        _analyze()


def test_raises_when_segment_incomplete():
    payload = dict(MOCK_RESPONSE_JSON, segments=[{"clip_start": 10.0}])
    _mock_claude(json.dumps(payload))
    with pytest.raises(ValueError, match="clip_end"):
        _analyze()


def test_prompt_receives_segments_wanted():
    client = _mock_claude(json.dumps(MOCK_RESPONSE_JSON))
    _analyze(segments_wanted=4)
    sent = client.messages.create.call_args.kwargs["messages"][0]["content"]
    assert "Analise 4 trechos" in sent
