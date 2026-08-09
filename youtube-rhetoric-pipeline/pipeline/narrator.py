from pathlib import Path
from elevenlabs.client import ElevenLabs


def synthesize_speech(text: str, voice_id: str, api_key: str,
                      output_dir: str, filename: str) -> Path:
    if not text.strip():
        raise ValueError("narration text is empty")
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{filename}.mp3"
    client = ElevenLabs(api_key=api_key)
    chunks = client.text_to_speech.convert(
        text=text,
        voice_id=voice_id,
        model_id="eleven_multilingual_v2",
        output_format="mp3_44100_128",
    )
    with open(out_path, "wb") as f:
        for chunk in chunks:
            f.write(chunk)
    return out_path
