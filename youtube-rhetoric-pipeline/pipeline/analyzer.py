import json
import anthropic


def analyze_rhetoric(segments: list[dict], api_key: str,
                     prompt_template: str, max_narration_chars: int) -> dict:
    transcription = "\n".join(
        f"[{s['start']:.1f}s-{s['end']:.1f}s] {s['text']}" for s in segments
    )
    prompt = prompt_template.replace("{transcription}", transcription)
    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = message.content[0].text.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON from Claude: {e}\nRaw: {raw}") from e
    if len(data.get("narration_script", "")) > max_narration_chars:
        data["narration_script"] = data["narration_script"][:max_narration_chars]
    return data
