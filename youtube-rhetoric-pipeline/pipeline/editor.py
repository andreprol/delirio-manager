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
    clipped = out / f"{video_id}_clip.mp4"
    duration = clip_end - clip_start
    _run([
        "ffmpeg", "-y", "-ss", str(clip_start), "-i", source_path,
        "-t", str(duration), "-c:v", "libx264", "-c:a", "aac",
        "-preset", "ultrafast", str(clipped),
    ])
    narrated = out / f"{video_id}_narrated.mp4"
    _run([
        "ffmpeg", "-y", "-i", str(clipped), "-i", narration_path,
        "-map", "0:v", "-map", "1:a", "-c:v", "copy",
        "-shortest", str(narrated),
    ])
    parts = []
    if intro_path:
        parts.append(intro_path)
    parts.append(str(narrated))
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
