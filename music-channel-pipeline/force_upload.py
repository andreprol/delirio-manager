"""Upload manual de um item específico da fila, ignorando o slot agendado.

Uso:
    python force_upload.py            # lista os itens pendentes
    python force_upload.py <queue_id> # sobe o item indicado agora

Existe porque `main.py upload` só pega o pendente mais antigo cujo slot já venceu.
Quando um dia falha (sem internet, API fora), a fila acumula e é preciso escolher
qual item subir.
"""

import json
import os
import shutil
import sys
import logging
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

from pipeline.queue import _con, init_db, mark_uploaded
from pipeline.uploader import upload_video


def list_pending():
    con = _con()
    rows = con.execute("""
        SELECT id, theme_id, title, scheduled_at, video_path
        FROM video_queue
        WHERE uploaded_at IS NULL
        ORDER BY scheduled_at ASC
    """).fetchall()
    con.close()
    return [dict(r) for r in rows]


def get_item(queue_id: int):
    con = _con()
    row = con.execute("SELECT * FROM video_queue WHERE id=?", (queue_id,)).fetchone()
    con.close()
    return dict(row) if row else None


def main():
    init_db()

    if len(sys.argv) < 2:
        pending = list_pending()
        if not pending:
            log.info("Nenhum vídeo pendente.")
            return
        for p in pending:
            log.info("id=%s | %s | slot %s", p["id"], p["title"], p["scheduled_at"])
        return

    queue_id = int(sys.argv[1])
    item = get_item(queue_id)
    if not item:
        log.error("Item %s não existe na fila.", queue_id)
        sys.exit(1)
    if item["uploaded_at"]:
        log.error("Item %s já foi enviado em %s (youtube_id=%s).",
                  queue_id, item["uploaded_at"], item["youtube_id"])
        sys.exit(1)

    video_path = Path(item["video_path"])
    if not video_path.exists():
        log.error("Arquivo não encontrado: %s", video_path)
        sys.exit(1)

    secrets_file = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json")
    log.info("Fazendo upload: %s (%.1f MB)", item["title"],
             video_path.stat().st_size / 1024 / 1024)

    yt_id = upload_video(
        file_path=str(video_path),
        title=item["title"],
        description=item["description"],
        tags=json.loads(item["tags"]),
        secrets_file=secrets_file,
    )
    mark_uploaded(item["id"], yt_id)
    log.info("Uploaded → https://youtube.com/watch?v=%s", yt_id)

    used_dir = Path(os.getenv("AUDIO_USED_DIR", "data/audio/used"))
    used_dir.mkdir(parents=True, exist_ok=True)
    pending_dir = Path(os.getenv("AUDIO_PENDING_DIR", "data/audio/pending"))
    for fname in item["audio_filename"].split("|"):
        src = pending_dir / fname
        if src.exists():
            shutil.move(str(src), used_dir / fname)


if __name__ == "__main__":
    main()
