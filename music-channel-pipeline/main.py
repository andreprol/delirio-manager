import json
import os
import sys
import shutil
import logging
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

import replicate
from pipeline.queue import (
    init_db, get_next_theme, get_next_composition,
    mark_theme_used, mark_composition_used,
    next_upload_slot, enqueue_video, get_due_uploads, mark_uploaded,
)
from pipeline.image_gen import generate_thumbnail
from pipeline.video_builder import build_video
from pipeline.uploader import upload_video

CHANNEL_FILE  = Path("config/channel.json")
THEMES_FILE   = Path("config/themes.json")
SCHEDULE_FILE = Path("config/schedule.json")


def _load_config():
    channel  = json.loads(CHANNEL_FILE.read_text())
    themes   = json.loads(THEMES_FILE.read_text())
    schedule = json.loads(SCHEDULE_FILE.read_text())
    return channel, themes, schedule


def _make_title(channel: dict, theme: dict) -> str:
    year = datetime.now().year
    return f"{theme['name']} Mix {year} | Dark Tech House | 1 Hour DJ Set"


def _make_description(channel: dict, theme: dict) -> str:
    return (
        f"🌊 {theme['location']} vibes — 1 hour of pure Dark Tech House.\n"
        f"Let the music transport you to {theme['name']}.\n\n"
        f"🎧 AI-generated Dark Tech House mix\n"
        f"📍 {theme['name']}\n\n"
        f"#{theme['id'].replace('-','').title()}Mix #DarkTechHouse #TechHouse "
        f"#IBizaMix #ElectronicMusic #DJSet #1HourMix"
    )


def _make_tags(theme: dict) -> list[str]:
    return [
        "dark tech house", "tech house", "electronic music", "dj set",
        "1 hour mix", theme["name"].lower(), f"{theme['name'].lower()} mix",
        "ibiza", "beach party", "sunset mix", "ai music",
    ]


def run_generate():
    init_db()
    channel, themes, schedule = _load_config()

    os.environ["REPLICATE_API_TOKEN"] = os.environ.get(
        "REPLICATE_API_TOKEN", channel.get("replicate_token", "")
    )

    # Audio: scan pending folder
    audio_dir = Path(os.getenv("AUDIO_PENDING_DIR", "data/audio/pending"))
    all_audio = sorted(audio_dir.glob("*.mp3")) + sorted(audio_dir.glob("*.wav"))
    if not all_audio:
        log.warning("Nenhum áudio em %s — coloque arquivos MP3 do Suno e rode novamente.", audio_dir)
        sys.exit(0)

    tracks_per_video = int(channel.get("tracks_per_video", 5))
    audio_files = all_audio[:tracks_per_video]
    if len(audio_files) < tracks_per_video:
        log.warning("Apenas %d track(s) disponível — ideal ter %d. Continuando.", len(audio_files), tracks_per_video)
    log.info("Usando %d track(s): %s", len(audio_files), [f.name for f in audio_files])

    theme = get_next_theme(themes)
    comp_id, comp_desc = get_next_composition()
    log.info("Tema: %s | Composição: %s", theme["name"], comp_id)

    # Unique ID for this video
    video_id = f"{theme['id']}_{comp_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp")) / video_id
    temp_dir.mkdir(parents=True, exist_ok=True)

    # Generate thumbnail
    canonical = Path(channel["canonical_face"])
    img_path = temp_dir / "thumbnail.jpg"
    log.info("Gerando thumbnail via Flux...")
    generate_thumbnail(
        theme=theme,
        composition_id=comp_id,
        composition_desc=comp_desc,
        output_path=img_path,
        canonical_face_path=canonical,
        model=channel["replicate_model"],
        safety_tolerance=channel["safety_tolerance"],
        prompt_strength=channel["prompt_strength"],
    )
    log.info("Thumbnail: %s", img_path)

    # Build video
    log.info("Montando vídeo %d min...", channel["video_duration_minutes"])
    video_path = build_video(
        image_path=img_path,
        audio_files=audio_files,
        output_dir=temp_dir,
        video_id=video_id,
        target_minutes=channel["video_duration_minutes"],
    )
    log.info("Vídeo: %s", video_path)

    # Metadata
    title       = _make_title(channel, theme)
    description = _make_description(channel, theme)
    tags        = _make_tags(theme)
    slot        = next_upload_slot(schedule["upload_slots_brt"])

    # Queue
    enqueue_video(
        theme_id=theme["id"],
        composition_id=comp_id,
        audio_filename="|".join(f.name for f in audio_files),
        video_path=str(video_path),
        title=title,
        description=description,
        tags=json.dumps(tags),
        scheduled_at=slot,
    )
    mark_theme_used(theme["id"])
    mark_composition_used(comp_id)

    log.info("Enfileirado para upload: %s | slot: %s", title, slot)


def run_upload():
    init_db()
    channel, _, _ = _load_config()

    due = get_due_uploads()
    if not due:
        log.info("Nenhum vídeo pendente de upload.")
        return

    secrets_file = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json")
    used_dir = Path(os.getenv("AUDIO_USED_DIR", "data/audio/used"))
    used_dir.mkdir(parents=True, exist_ok=True)

    for item in due:
        log.info("Fazendo upload: %s", item["title"])
        try:
            yt_id = upload_video(
                file_path=item["video_path"],
                title=item["title"],
                description=item["description"],
                tags=json.loads(item["tags"]),
                secrets_file=secrets_file,
            )
            mark_uploaded(item["id"], yt_id)
            log.info("Uploaded → https://youtube.com/watch?v=%s", yt_id)

            # Move audio to used/
            for fname in item["audio_filename"].split("|"):
                src = Path(os.getenv("AUDIO_PENDING_DIR", "data/audio/pending")) / fname
                if src.exists():
                    shutil.move(str(src), used_dir / fname)

        except Exception as e:
            log.error("Upload falhou: %s", e)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "generate"
    if cmd == "upload":
        run_upload()
    else:
        run_generate()
