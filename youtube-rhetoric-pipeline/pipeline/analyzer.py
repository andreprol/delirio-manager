import json
import anthropic

MIN_SEGMENT_SECONDS = 60.0


def _strip_code_fence(raw: str) -> str:
    if not raw.startswith("```"):
        return raw
    raw = raw.split("```", 2)[1]
    if raw.startswith("json"):
        raw = raw[4:]
    return raw.strip().rstrip("`").strip()


def _validate_segments(data: dict, max_narration_chars: int, segments_wanted: int,
                       source_duration: float | None = None) -> list[dict]:
    segments = data.get("segments")
    if not isinstance(segments, list) or not segments:
        raise ValueError(f"Resposta sem lista 'segments': {data}")

    parsed = []
    for index, segment in enumerate(segments):
        for field in ("clip_start", "clip_end"):
            if not isinstance(segment.get(field), (int, float)):
                raise ValueError(f"Segmento {index} sem '{field}' numérico: {segment}")
        if not isinstance(segment.get("narration_script"), str) or not segment["narration_script"].strip():
            raise ValueError(f"Segmento {index} sem 'narration_script': {segment}")

        clip_start = float(segment["clip_start"])
        clip_end = float(segment["clip_end"])
        # Safety net: o prompt pede 60s, mas o modelo às vezes devolve menos.
        raw_duration = clip_end - clip_start
        if raw_duration < MIN_SEGMENT_SECONDS:
            clip_end = clip_start + MIN_SEGMENT_SECONDS

        # O modelo alucina timestamps além do fim do vídeo; ffmpeg com -ss depois
        # do EOF devolve segmento vazio e o concat aceita sem erro.
        if source_duration is not None:
            if clip_start >= source_duration:
                continue
            clip_end = min(clip_end, source_duration)
            if clip_end - clip_start < MIN_SEGMENT_SECONDS:
                continue

        parsed.append({
            "raw_duration": raw_duration,
            "clip_start": clip_start,
            "clip_end": clip_end,
            "techniques": segment.get("techniques", []),
            "narration_script": segment["narration_script"][:max_narration_chars],
            "segment_title": segment.get("segment_title", ""),
            "short_title": segment.get("short_title", segment.get("segment_title", "")),
            "short_description": segment.get("short_description", ""),
        })

    parsed.sort(key=lambda s: s["clip_start"])

    # Sobreposição repetiria o mesmo trecho dentro do vídeo longo — o safety net
    # acima estende clip_end e pode invadir o segmento seguinte. No conflito
    # vence o de maior duração ORIGINAL: descartar por ordem cronológica faria
    # um stub de 10s esticado matar um segmento legítimo de 80s.
    validated = []
    for segment in parsed:
        if validated and segment["clip_start"] < validated[-1]["clip_end"]:
            if segment["raw_duration"] > validated[-1]["raw_duration"]:
                validated[-1] = segment
            continue
        validated.append(segment)

    if not validated:
        raise ValueError("Nenhum segmento válido após descartar sobreposições")

    # Teto: 10 segmentos seriam 20 encodes de ffmpeg por vídeo.
    validated = validated[:segments_wanted]
    for segment in validated:
        segment.pop("raw_duration", None)
    return validated


def analyze_rhetoric(segments: list[dict], api_key: str, prompt_template: str,
                     max_narration_chars: int, segments_wanted: int = 4,
                     source_duration: float | None = None) -> dict:
    """
    Devolve a análise multi-segmento de um vídeo longo:
    {video_title, video_description, tags, segments: [...]}
    """
    transcription = "\n".join(
        f"[{s['start']:.1f}s-{s['end']:.1f}s] {s['text']}" for s in segments
    )
    prompt = (
        prompt_template
        .replace("{transcription}", transcription)
        .replace("{segments_wanted}", str(segments_wanted))
        .replace("{max_narration_chars}", str(max_narration_chars))
    )

    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = _strip_code_fence(message.content[0].text.strip())
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON from Claude: {e}\nRaw: {raw}") from e

    return {
        "video_title": data.get("video_title", ""),
        "video_description": data.get("video_description", ""),
        "tags": data.get("tags", []),
        "segments": _validate_segments(
            data, max_narration_chars, segments_wanted, source_duration
        ),
    }
