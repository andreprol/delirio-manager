import subprocess
import os
from pathlib import Path


def _get_audio_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def _concat_audio(audio_files: list[Path], output: Path) -> Path:
    concat_list = output.parent / "concat_list.txt"
    concat_list.write_text(
        "\n".join(f"file '{p.resolve()}'" for p in audio_files),
        encoding="utf-8"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
         "-i", str(concat_list), "-c", "copy", str(output)],
        check=True, capture_output=True,
    )
    return output


def _loop_audio_to_duration(audio: Path, target_seconds: float, output: Path) -> Path:
    duration = _get_audio_duration(audio)
    loops = int(target_seconds / duration) + 1
    concat_list = output.parent / "loop_list.txt"
    concat_list.write_text(
        "\n".join(f"file '{audio.resolve()}'" for _ in range(loops)),
        encoding="utf-8"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
         "-i", str(concat_list), "-t", str(target_seconds),
         "-c", "copy", str(output)],
        check=True, capture_output=True,
    )
    return output


def _prepare_audio(audio_files: list[Path], output_dir: Path,
                   video_id: str, target_seconds: float) -> Path:
    """Concatena as tracks e repete o resultado até cobrir target_seconds."""
    if len(audio_files) == 1:
        raw_audio = audio_files[0]
    else:
        raw_audio = output_dir / f"{video_id}_concat.mp3"
        _concat_audio(audio_files, raw_audio)

    if _get_audio_duration(raw_audio) < target_seconds:
        final_audio = output_dir / f"{video_id}_looped.mp3"
        return _loop_audio_to_duration(raw_audio, target_seconds, final_audio)
    return raw_audio


def _normalize_loop_unit(clip_path: Path, output: Path) -> Path:
    """Reencoda o clipe para 1920x1080 exato com GOP fechado.

    Os modelos devolvem dimensões próprias (o Kling entrega 1904x1088), e o
    loop por cópia de stream só produz vídeo válido se cada repetição começar
    num keyframe — daí `-g` fixo e `-sc_threshold 0`.
    """
    subprocess.run([
        "ffmpeg", "-y", "-i", str(clip_path),
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,"
               "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
        "-c:v", "libx264", "-preset", "slow", "-crf", "20",
        "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
        "-an", str(output),
    ], check=True, capture_output=True)
    return output


def build_video_from_loop_clip(
    clip_path: Path,
    audio_files: list[Path],
    output_dir: Path,
    video_id: str,
    target_minutes: int = 60,
    already_normalized: bool = False,
) -> Path:
    """Monta o vídeo de 60 min repetindo um clipe que emenda consigo mesmo.

    O clipe é normalizado uma vez e depois repetido com `-c:v copy`, sem
    reencodar as 60 min — 1h de 1080p sai em ~1min30 em vez de dezenas de
    minutos.

    `already_normalized` pula a normalização para quem já entrega 1920×1080 com
    GOP fechado — é o caso do segmento de slideshow, que sai assim do
    `slideshow.py`. Reencodar 9 min à toa em todo slot é desperdício, e a
    segunda passada só degradaria a imagem.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    target_seconds = target_minutes * 60

    loop_unit = clip_path if already_normalized else _normalize_loop_unit(
        clip_path, output_dir / f"{video_id}_loop_unit.mp4")
    final_audio = _prepare_audio(audio_files, output_dir, video_id, target_seconds)

    output_path = output_dir / f"{video_id}.mp4"
    subprocess.run([
        "ffmpeg", "-y",
        "-stream_loop", "-1", "-i", str(loop_unit),
        "-i", str(final_audio),
        "-t", str(int(target_seconds)),
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "256k",
        "-shortest", "-movflags", "+faststart",
        str(output_path),
    ], check=True, capture_output=True)

    return output_path


def build_video(
    image_path: Path,
    audio_files: list[Path],
    output_dir: Path,
    video_id: str,
    target_minutes: int = 60,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    target_seconds = target_minutes * 60

    # Consolidate audio
    if len(audio_files) == 1:
        raw_audio = audio_files[0]
    else:
        raw_audio = output_dir / f"{video_id}_concat.mp3"
        _concat_audio(audio_files, raw_audio)

    # Loop if total duration < target
    duration = _get_audio_duration(raw_audio)
    if duration < target_seconds:
        final_audio = output_dir / f"{video_id}_looped.mp3"
        _loop_audio_to_duration(raw_audio, target_seconds, final_audio)
    else:
        final_audio = raw_audio

    # Build final video: image loop + audio
    output_path = output_dir / f"{video_id}.mp4"
    cmd = [
        "ffmpeg", "-y",
        "-loop", "1", "-framerate", "1",
        "-i", str(image_path),
        "-i", str(final_audio),
        "-t", str(min(_get_audio_duration(final_audio), target_seconds)),
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,"
               "pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
        "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "256k",
        "-shortest",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return output_path
