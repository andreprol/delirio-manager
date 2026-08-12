"""
Re-faz upload dos vídeos que foram baixados mas não enviados ao YouTube
(youtube_video_id = NULL na tabela instagram_synced).
"""
import sqlite3
import json
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from dotenv import load_dotenv
load_dotenv(PROJECT / ".env")

import os
from pipeline.uploader import upload_video
from pipeline.queue import mark_instagram_synced

DB_PATH = PROJECT / "data" / "pipeline.db"
TEMP_DIR = PROJECT / "data" / "temp" / "raquelpiiires"
SECRETS = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json")


def find_video_file(instagram_id: str) -> Path | None:
    for p in TEMP_DIR.glob(f"*_{instagram_id}.mp4"):
        return p
    return None


def main():
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row

    # Buscar todos sem youtube_video_id
    pending = db.execute(
        """SELECT s.instagram_id, q.title, q.description, q.tags
           FROM instagram_synced s
           JOIN content_briefs b ON b.source_ref = s.instagram_id
           JOIN upload_queue q ON q.brief_id = b.id
           WHERE s.youtube_video_id IS NULL
           ORDER BY s.synced_at"""
    ).fetchall()
    db.close()

    if not pending:
        print("Nenhum vídeo pendente de re-upload.")
        return

    print(f"{len(pending)} vídeo(s) para re-upload:\n")
    ok = 0
    fail = 0

    for row in pending:
        ig_id = row["instagram_id"]
        title = row["title"] or "Vídeo"
        description = row["description"] or ""
        tags = json.loads(row["tags"] or "[]")

        video_file = find_video_file(ig_id)
        if not video_file:
            print(f"  ❌ {ig_id}: arquivo MP4 não encontrado em {TEMP_DIR}")
            fail += 1
            continue

        print(f"→ {title[:60]}...")
        print(f"  Arquivo: {video_file.name} ({video_file.stat().st_size // 1024 // 1024} MB)")

        try:
            yt_id = upload_video(
                file_path=str(video_file),
                title=title,
                description=description,
                tags=[t.lstrip("#") for t in tags],
                secrets_file=SECRETS,
            )
            mark_instagram_synced(ig_id, yt_id)
            print(f"  ✓ Publicado: https://youtu.be/{yt_id}\n")
            ok += 1
        except Exception as e:
            print(f"  ❌ Erro: {e}\n")
            fail += 1

    print(f"\nConcluído: {ok} publicados, {fail} falhas.")


if __name__ == "__main__":
    main()
