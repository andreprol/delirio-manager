"""
Generates short animated video clips from a static thumbnail using image-to-video models.
Each clip has a different motion prompt to create varied loop content.
"""
import base64
import time
import requests
import replicate
from pathlib import Path

CLIP_MOTIONS = [
    (
        "DJ moves hands rhythmically on Pioneer CDJ-3000 turntables, head nodding to music, "
        "platinum blonde hair swaying naturally, crowd dancing energetically in background"
    ),
    (
        "slow cinematic camera push in toward DJ, crowd raises both hands and dances, "
        "colorful laser beams sweep across the venue, DJ smiling confidently"
    ),
    (
        "DJ turns slightly looking at camera with a warm smile, "
        "crowd cheering and dancing behind her, laser lights and strobes flashing"
    ),
    (
        "wide establishing shot, DJ performing at CDJ setup, "
        "colorful laser beams and strobe lights pierce through crowd, crowd bouncing in sync"
    ),
    (
        "DJ leans forward enthusiastically adjusting track, arms moving expressively, "
        "crowd jumping and dancing to the beat in background, atmosphere electric"
    ),
]


def _save_video(output, path: Path):
    if hasattr(output, "read"):
        path.write_bytes(output.read())
    elif hasattr(output, "url"):
        path.write_bytes(requests.get(output.url, timeout=120).content)
    elif isinstance(output, str) and output.startswith("http"):
        path.write_bytes(requests.get(output, timeout=120).content)
    elif isinstance(output, bytes):
        path.write_bytes(output)
    else:
        first = list(output)[0]
        _save_video(first, path)


def generate_clips(
    thumbnail_path: Path,
    output_dir: Path,
    video_id: str,
    model: str = "minimax/video-01",
    n_clips: int = 5,
) -> list[Path]:
    """
    Animate thumbnail into N short video clips with different motion prompts.
    Returns list of clip paths in output_dir.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    with open(thumbnail_path, "rb") as f:
        b64_image = f"data:image/jpeg;base64,{base64.b64encode(f.read()).decode()}"

    clips: list[Path] = []
    motions = CLIP_MOTIONS[:n_clips]

    for i, motion in enumerate(motions):
        clip_path = output_dir / f"clip_{i:02d}.mp4"

        output = replicate.run(
            model,
            input={
                "prompt": motion,
                "first_frame_image": b64_image,
            },
        )
        _save_video(output, clip_path)
        clips.append(clip_path)

        # rate limit between requests
        if i < len(motions) - 1:
            time.sleep(8)

    return clips
