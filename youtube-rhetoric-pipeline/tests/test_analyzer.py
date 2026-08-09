import pytest
import json
from unittest.mock import patch, MagicMock
from pipeline.analyzer import analyze_rhetoric

SEGMENTS = [
    {"start": 0.0, "end": 5.0, "text": "Sabe qual é o poder da repetição?"},
    {"start": 5.0, "end": 12.0, "text": "Quando você repete uma ideia três vezes, ela vira verdade na mente do ouvinte."},
]

MOCK_RESPONSE_JSON = {
    "clip_start": 0.0,
    "clip_end": 12.0,
    "techniques": ["repetição", "ancoragem"],
    "narration_script": "Marçal demonstra aqui a técnica de repetição deliberada.",
    "title": "Como Marçal usa repetição para persuadir",
    "description": "Análise da técnica retórica de repetição usada por Marçal.",
    "tags": ["retórica", "persuasão", "Marçal", "comunicação", "oratória"],
}

def test_analyze_rhetoric_returns_parsed_dict():
    with patch("pipeline.analyzer.anthropic.Anthropic") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_message = MagicMock()
        mock_message.content[0].text = json.dumps(MOCK_RESPONSE_JSON)
        mock_client.messages.create.return_value = mock_message
        result = analyze_rhetoric(
            segments=SEGMENTS,
            api_key="fake-key",
            prompt_template="Analise: {transcription}",
            max_narration_chars=800,
        )
    assert result["clip_start"] == 0.0
    assert result["clip_end"] == 12.0
    assert "repetição" in result["techniques"]
    assert len(result["narration_script"]) <= 800

def test_analyze_rhetoric_raises_on_invalid_json():
    with patch("pipeline.analyzer.anthropic.Anthropic") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_message = MagicMock()
        mock_message.content[0].text = "não é json"
        mock_client.messages.create.return_value = mock_message
        with pytest.raises(ValueError, match="Invalid JSON"):
            analyze_rhetoric(
                segments=SEGMENTS,
                api_key="fake-key",
                prompt_template="Analise: {transcription}",
                max_narration_chars=800,
            )
