import json
import os
import logging
import sys
import traceback
from pathlib import Path
from dotenv import load_dotenv

from pipeline.monitor import fetch_new_videos
from pipeline.downloader import download_video
from pipeline.transcriber import transcribe
from pipeline.analyzer import analyze_rhetoric
from pipeline.narrator import synthesize_speech
from pipeline.editor import build_long_video, build_short, probe_duration
from pipeline.uploader import upload_video
from pipeline.queue import (
    init_db, is_processed, mark_pending, commit_video_outputs,
    get_due_uploads, mark_uploaded, next_upload_slot,
)
from pipeline.notifier import (
    send_slot_summary, send_pipeline_summary, send_pipeline_failure,
    send_upload_failure,
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
    # encoding explícito: o default do Windows é cp1252 e os arquivos têm
    # acentuação UTF-8 — sem isto o run inteiro morre com UnicodeDecodeError.
    creators = json.loads(CREATORS_FILE.read_text(encoding="utf-8"))
    persona = json.loads(PERSONA_FILE.read_text(encoding="utf-8"))
    schedule = json.loads(SCHEDULE_FILE.read_text(encoding="utf-8"))
    prompt = PROMPT_FILE.read_text(encoding="utf-8")
    return creators, persona, schedule, prompt


def _asset(name: str) -> str | None:
    path = ASSETS_DIR / name
    return str(path) if path.exists() else None


def _cleanup_intermediates(work_dir: Path, keep: set[str]) -> None:
    """
    Cada vídeo-fonte deixa o download e ~12 MP4s intermediários em 1080p; um run
    diário encheria o disco em semanas. Só os arquivos que vão para upload ficam.
    """
    for path in work_dir.glob("*"):
        if path.is_file() and str(path.resolve()) not in keep:
            try:
                path.unlink()
            except OSError as e:
                log.warning(f"Não removeu intermediário {path.name}: {e}")


def _render_outputs(video_id: str, vid_path: Path, analysis: dict,
                    schedule: dict, work_dir: Path) -> tuple[str, list[tuple[int, str]]]:
    """Renderiza o vídeo longo e os Shorts. Nada é enfileirado aqui."""
    segments = analysis["segments"]
    long_path = build_long_video(
        source_path=str(vid_path),
        segments=segments,
        output_dir=str(work_dir),
        video_id=video_id,
        intro_path=_asset("intro.mp4"),
        outro_path=_asset("outro.mp4"),
    )

    shorts = []
    shorts_wanted = min(schedule.get("shorts_per_video", 2), len(segments))
    for index in range(shorts_wanted):
        shorts.append((index, build_short(
            source_path=str(vid_path),
            segment=segments[index],
            output_dir=str(work_dir),
            video_id=video_id,
            index=index,
            outro_path=_asset("outro.mp4"),
        )))

    return long_path, shorts


def _process_video(video: dict, persona: dict, schedule: dict,
                   prompt: str, temp_dir: Path) -> dict:
    """
    Produz de um vídeo longo do creator: 1 vídeo 16:9 para monetização e N
    Shorts verticais de divulgação, todos derivados das mesmas narrações.
    """
    video_id = video["id"]
    work_dir = temp_dir / video_id

    vid_path = download_video(video_id, str(work_dir))
    transcript = transcribe(str(vid_path), model_size="base")

    # Duração real do arquivo, não a da API: descarta timestamp alucinado que
    # cairia depois do fim do vídeo e geraria segmento vazio.
    source_duration = probe_duration(str(vid_path)) or video.get("duration_seconds")

    analysis = analyze_rhetoric(
        segments=transcript,
        api_key=os.environ["ANTHROPIC_API_KEY"],
        prompt_template=prompt,
        max_narration_chars=persona["max_narration_chars"],
        segments_wanted=schedule.get("segments_per_video", 4),
        source_duration=source_duration,
    )

    segments = analysis["segments"]
    for index, segment in enumerate(segments):
        segment["narration_path"] = str(synthesize_speech(
            text=segment["narration_script"],
            voice_id=persona["voice_id"],
            api_key=os.environ["ELEVENLABS_API_KEY"],
            output_dir=str(work_dir),
            filename=f"narration_{index}",
        ))

    # Render de tudo antes de qualquer enqueue: enfileirar o longo e depois
    # falhar num Short deixaria o vídeo na fila com o fonte ainda 'pending',
    # e o próximo run publicaria o mesmo longo duas vezes.
    long_path, shorts = _render_outputs(video_id, vid_path, analysis, schedule, work_dir)

    slots = schedule["upload_slots_brt"]
    long_slot = next_upload_slot(slots, kind="long")
    taken = {long_slot}
    items = [{
        "clip_start": segments[0]["clip_start"],
        "clip_end": segments[-1]["clip_end"],
        "title": analysis["video_title"],
        "description": analysis["video_description"],
        "tags": analysis["tags"],
        "scheduled_time": long_slot,
        "kind": "long",
        "file_path": long_path,
    }]

    for index, short_path in shorts:
        segment = segments[index]
        # not_before: o Short divulga o longo, então nunca pode publicar antes
        # dele — rodando o pipeline depois das 12h isso aconteceria.
        short_slot = next_upload_slot(
            slots, kind="short", not_before=long_slot, taken=taken
        )
        taken.add(short_slot)
        items.append({
            "clip_start": segment["clip_start"],
            "clip_end": segment["clip_end"],
            "title": segment["short_title"] or analysis["video_title"],
            "description": segment["short_description"],
            "tags": analysis["tags"],
            "scheduled_time": short_slot,
            "kind": "short",
            "file_path": short_path,
        })
        log.info(f"Short {index} de {video_id} agendado para {short_slot}")

    # Enqueue de tudo + mark_done numa transação: falha parcial não pode deixar
    # o longo na fila com o fonte ainda 'pending'.
    commit_video_outputs(video_id, items)
    log.info(f"Longo 16:9 de {video_id} enfileirado para {long_slot}")

    _cleanup_intermediates(
        work_dir, keep={str(Path(item["file_path"]).resolve()) for item in items}
    )

    return {"title": analysis["video_title"], "shorts": len(shorts), "slot": long_slot}


def run_pipeline(creator_handle: str = None, channel_id: str = None):
    init_db()
    creators, persona, schedule, prompt = _load_config()
    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp"))
    max_per_run = schedule.get("max_videos_per_run", 1)

    active = [c for c in creators if c["active"]]
    if creator_handle:
        active = [c for c in active if c["handle"] == creator_handle]
    if channel_id:
        active = [c for c in active if c["channel_id"] == channel_id]

    produced, errors = [], []

    for creator in active:
        # Antes do fetch: cada chamada de search custa 100 unidades de quota e
        # seria gasta só para descartar tudo no teto logo abaixo.
        if len(produced) >= max_per_run:
            break
        log.info(f"Checking {creator['handle']}")
        videos = fetch_new_videos(
            api_key=os.environ["YOUTUBE_API_KEY"],
            channel_id=creator["channel_id"],
        )

        for video in videos:
            if len(produced) >= max_per_run:
                log.info(f"Teto de {max_per_run} vídeo(s) por run atingido")
                break
            if is_processed(video["id"]):
                log.info(f"Skip {video['id']} — already processed")
                continue

            log.info(f"Processing {video['id']}: {video['title']}")
            mark_pending(video["id"], creator["handle"], video["title"], video["published_at"])

            try:
                produced.append(_process_video(
                    video, persona, schedule, prompt, temp_dir
                ))
            except Exception as e:
                log.error(f"Error processing {video['id']}: {e}")
                errors.append({"source_video_id": video["id"], "error": str(e)})

    send_pipeline_summary(produced, errors)
    return produced, errors


def run_uploads():
    init_db()
    due = get_due_uploads()
    results = []

    if due:
        secrets_file = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json")
        temp_dir = Path(os.getenv("TEMP_DIR", "data/temp"))

        for item in due:
            # Itens antigos não têm file_path; caem no arquivo do formato legado.
            path = item.get("file_path") or str(
                temp_dir / item["source_video_id"] / f"{item['source_video_id']}_landscape.mp4"
            )
            try:
                yt_id = upload_video(
                    file_path=path,
                    title=item["title"],
                    description=item["description"],
                    tags=json.loads(item["tags"]),
                    secrets_file=secrets_file,
                )
                mark_uploaded(item["id"], yt_id)
                log.info(f"Uploaded {item['title']} → {yt_id}")
                results.append({"title": item["title"], "youtube_video_id": yt_id, "error": None})
            except Exception as e:
                log.error(f"Upload failed for queue item {item['id']}: {e}")
                results.append({"title": item["title"], "youtube_video_id": None, "error": str(e)})

    send_slot_summary(results)
    return results


if __name__ == "__main__":
    is_upload = len(sys.argv) > 1 and sys.argv[1] == "upload"
    try:
        if is_upload:
            if any(r["error"] for r in run_uploads()):
                sys.exit(1)
        else:
            _, errors = run_pipeline()
            if errors:
                sys.exit(1)
    except Exception as e:
        # Sem este bloco o crash mata o run antes de qualquer notificação e a
        # task agendada some em silêncio. Vale para os dois caminhos: o upload
        # crasha em OAuth invalid_grant antes de chegar no resumo do slot.
        log.exception("Run falhou")
        if is_upload:
            send_upload_failure(str(e), traceback.format_exc())
        else:
            send_pipeline_failure(str(e), traceback.format_exc())
        sys.exit(1)
