import subprocess
from pathlib import Path


def _run(cmd: list[str]):
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode()}")


def build_video(source_path: str, narration_path: str, intro_path: str | None,
                outro_path: str | None, clip_start: float, clip_end: float,
                output_dir: str, video_id: str) -> dict[str, str]:
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # 1. Narration segment: black screen + ElevenLabs narration audio
    narration_seg = out / f"{video_id}_narration_seg.mp4"
    _run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "color=c=black:size=1920x1080:rate=30",
        "-i", narration_path,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-shortest",
        str(narration_seg),
    ])

    # 2. Clip original source WITH original audio (no audio replacement)
    clipped = out / f"{video_id}_clip.mp4"
    duration = clip_end - clip_start
    _run([
        "ffmpeg", "-y", "-ss", str(clip_start), "-i", source_path,
        "-t", str(duration), "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-c:a", "aac", str(clipped),
    ])

    # 3. Concat: narration_seg → clip → outro (intro dropped — narration IS the intro)
    parts = [str(narration_seg), str(clipped)]
    if outro_path:
        parts.append(outro_path)

    concat_list = out / f"{video_id}_concat.txt"
    abs_parts = [str(Path(p).resolve()) for p in parts]
    concat_list.write_text("\n".join(f"file '{p}'" for p in abs_parts))

    landscape = out / f"{video_id}_landscape.mp4"
    _run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(concat_list), "-c", "copy", str(landscape),
    ])

    portrait = out / f"{video_id}_portrait.mp4"
    _run([
        "ffmpeg", "-y", "-i", str(landscape),
        "-vf", "crop=ih*9/16:ih,scale=1080:1920",
        "-c:a", "copy", str(portrait),
    ])

    return {"landscape": str(landscape), "portrait": str(portrait)}
