import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
from pipeline.narrator import synthesize_speech

def test_synthesize_speech_writes_mp3(tmp_path):
    fake_audio = b"fake-mp3-bytes"
    with patch("pipeline.narrator.ElevenLabs") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.text_to_speech.convert.return_value = iter([fake_audio])
        out_path = synthesize_speech(
            text="Marçal usa ethos para ganhar credibilidade.",
            voice_id="abc-voice",
            api_key="fake-key",
            output_dir=str(tmp_path),
            filename="narration",
        )
    assert out_path == tmp_path / "narration.mp3"
    assert out_path.read_bytes() == fake_audio

def test_synthesize_speech_raises_on_empty_text(tmp_path):
    with pytest.raises(ValueError, match="empty"):
        synthesize_speech(
            text="",
            voice_id="abc",
            api_key="fake",
            output_dir=str(tmp_path),
            filename="narration",
        )
