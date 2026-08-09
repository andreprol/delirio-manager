import pytest
from unittest.mock import patch, MagicMock
from pipeline.transcriber import transcribe

MOCK_WHISPER_RESULT = {
    "segments": [
        {"start": 0.0, "end": 5.2, "text": "Olha, vou te contar uma coisa."},
        {"start": 5.2, "end": 12.0, "text": "Quando você domina a retórica, domina as pessoas."},
    ]
}

def test_transcribe_returns_segments(tmp_path):
    fake_video = tmp_path / "video.mp4"
    fake_video.touch()
    with patch("pipeline.transcriber.whisper.load_model") as mock_load:
        mock_model = MagicMock()
        mock_load.return_value = mock_model
        mock_model.transcribe.return_value = MOCK_WHISPER_RESULT
        result = transcribe(str(fake_video), model_size="small")
    assert len(result) == 2
    assert result[0]["start"] == 0.0
    assert result[0]["text"] == "Olha, vou te contar uma coisa."

def test_transcribe_raises_on_missing_file():
    with pytest.raises(FileNotFoundError):
        transcribe("/nonexistent/video.mp4", model_size="small")
