from pathlib import Path
import whisper


def transcribe(video_path: str, model_size: str = "medium") -> list[dict]:
    path = Path(video_path)
    if not path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")
    model = whisper.load_model(model_size)
    result = model.transcribe(str(path), language="pt", verbose=False)
    return [
        {"start": seg["start"], "end": seg["end"], "text": seg["text"].strip()}
        for seg in result["segments"]
    ]
