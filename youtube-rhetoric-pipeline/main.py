import json
import os
import logging
from pathlib import Path
from dotenv import load_dotenv

from pipeline.monitor import fetch_new_videos
from pipeline.downloader import download_video
from pipeline.transcriber import transcribe
from pipeline.analyzer import analyze_rhetoric
from pipeline.narrator import synthesize_speech
from pipeline.editor import build_video
from pipeline.uploader import upload_video
from pipeline.queue import (
    init_db, is_processed, mark_pending, mark_done,
    enqueue_output, get_due_uploads, mark_uploaded, next_upload_slot,
)

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

CREATORS_FILE = Path("config/creators.json")
PERSONA_FILE = Path("config/persona.json")
SCHEDULE_FILE = Path("config/schedule.json")
PROMPT_FILE = Path("prompts/rhetoric_analysis.txt")
ASSETS_DIR = Path("assets")


def _load_config():
    creators = json.loads(CREATORS_FILE.read_text())
    persona = json.loads(PERSONA_FILE.read_text())
    schedule = json.loads(SCHEDULE_FILE.read_text())
    prompt = PROMPT_FILE.read_text()
    return creators, persona, schedule, prompt


def run_pipeline(creator_handle: str = None, channel_id: str = None):
    init_db()
    creators, persona, schedule, prompt = _load_config()
    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp"))

    active = [c for c in creators if c["active"]]
    if creator_handle:
        active = [c for c in active if c["handle"] == creator_handle]
    if channel_id:
        active = [c for c in active if c["channel_id"] == channel_id]

    for creator in active:
        log.info(f"Checking {creator['handle']}")
        videos = fetch_new_videos(
            api_key=os.environ["YOUTUBE_API_KEY"],
            channel_id=creator["channel_id"],
        )

        for video in videos:
            if is_processed(video["id"]):
                log.info(f"Skip {video['id']} — already processed")
                continue

            log.info(f"Processing {video['id']}: {video['title']}")
            mark_pending(video["id"], creator["handle"], video["title"], video["published_at"])

            try:
                vid_path = download_video(video["id"], str(temp_dir / video["id"]))
                segments = transcribe(str(vid_path), model_size="base")
                analysis = analyze_rhetoric(
                    segments=segments,
                    api_key=os.environ["ANTHROPIC_API_KEY"],
                    prompt_template=prompt,
                    max_narration_chars=persona["max_narration_chars"],
                )
                clip_duration = analysis["clip_end"] - analysis["clip_start"]
                if clip_duration < 60.0:
                    log.warning(
                        f"Clip {clip_duration:.1f}s < 60s mínimo — estendendo clip_end para 60s"
                    )
                    analysis["clip_end"] = analysis["clip_start"] + 60.0
                narration_path = synthesize_speech(
                    text=analysis["narration_script"],
                    voice_id=persona["voice_id"],
                    api_key=os.environ["ELEVENLABS_API_KEY"],
                    output_dir=str(temp_dir / video["id"]),
                    filename="narration",
                )
                intro = str(ASSETS_DIR / "intro.mp4") if (ASSETS_DIR / "intro.mp4").exists() else None
                outro = str(ASSETS_DIR / "outro.mp4") if (ASSETS_DIR / "outro.mp4").exists() else None
                build_video(
                    source_path=str(vid_path),
                    narration_path=str(narration_path),
                    intro_path=intro,
                    outro_path=outro,
                    clip_start=analysis["clip_start"],
                    clip_end=analysis["clip_end"],
                    output_dir=str(temp_dir / video["id"]),
                    video_id=video["id"],
                )
                slot = next_upload_slot(schedule["upload_slots_brt"])
                enqueue_output(
                    source_video_id=video["id"],
                    clip_start=analysis["clip_start"],
                    clip_end=analysis["clip_end"],
                    title=analysis["title"],
                    description=analysis["description"],
                    tags=analysis["tags"],
                    scheduled_time=slot,
                )
                mark_done(video["id"])
                log.info(f"Queued {video['id']} for {slot}")

            except Exception as e:
                log.error(f"Error processing {video['id']}: {e}")


def run_uploads():
    init_db()
    due = get_due_uploads()
    if not due:
        return

    secrets_file = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json")
    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp"))

    for item in due:
        landscape = str(temp_dir / item["source_video_id"] / f"{item['source_video_id']}_landscape.mp4")
        try:
            yt_id = upload_video(
                file_path=landscape,
                title=item["title"],
                description=item["description"],
                tags=json.loads(item["tags"]),
                secrets_file=secrets_file,
            )
            mark_uploaded(item["id"], yt_id)
            log.info(f"Uploaded {item['title']} → {yt_id}")
        except Exception as e:
            log.error(f"Upload failed for queue item {item['id']}: {e}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "upload":
        run_uploads()
    else:
        run_pipeline()
