"""
Projeto Raquel — Pipeline de conteúdo YouTube
Canal: Raquel Pires (@raquelpires)

Uso:
  python main.py status                    Mostra todos os itens na fila
  python main.py sync-instagram [N]        Baixa vídeos do Instagram e faz upload no YouTube (padrão: 10)
  python main.py add-review               Adiciona review de drama (interativo)
  python main.py add-fanmeeting           Adiciona vlog de fan meeting (interativo)
  python main.py add-instagram <url>      Importa post do Instagram (cola a legenda)
  python main.py generate [id]            Gera script(s) pendentes via Claude
  python main.py seo <id> <youtube_url>   Gera artigo de blog para um item
  python main.py schedule <id>            Agenda upload de um item
  python main.py upload                   Faz upload dos vídeos agendados para hoje
"""

import json
import os
import sys
import logging
from pathlib import Path
from dotenv import load_dotenv

from pipeline.queue import (
    init_db, add_brief, get_pending_briefs, get_brief,
    get_all_queue, mark_brief_scripted, mark_brief_done,
    enqueue_upload, enqueue_instagram_video, schedule_upload,
    get_due_uploads, get_ready_uploads,
    mark_uploaded, mark_instagram_synced, is_instagram_synced,
    next_upload_slot, set_blog_article,
)
from pipeline.content_intake import (
    parse_instagram_post, create_manual_brief, detect_content_type,
)
from pipeline.instagram_sync import (
    fetch_profile_videos, download_video,
    caption_to_youtube_title, build_youtube_description as build_ig_description,
)
from pipeline.script_generator import generate_script
from pipeline.seo_optimizer import generate_blog_article, build_youtube_description
from pipeline.blog_publisher import publish_article
from pipeline.uploader import upload_video

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

CHANNEL_FILE = Path("config/channel.json")
SCHEDULE_FILE = Path("config/schedule.json")


def _load_channel():
    return json.loads(CHANNEL_FILE.read_text())


def _load_schedule():
    return json.loads(SCHEDULE_FILE.read_text())


# ─── COMMANDS ────────────────────────────────────────────────────────────────

def cmd_status():
    items = get_all_queue()
    if not items:
        print("Fila vazia. Use 'add-review' ou 'add-fanmeeting' para adicionar conteúdo.")
        return

    print(f"\n{'ID':<4} {'TIPO':<12} {'TÍTULO':<45} {'STATUS':<12} {'AGENDADO'}")
    print("─" * 100)
    for item in items:
        title = (item.get("title") or item.get("drama_title") or item.get("event_name") or "—")[:44]
        brief_type = item.get("brief_type", "—")
        status = item.get("status", "—")
        scheduled = item.get("scheduled_time", "—")[:16] if item.get("scheduled_time") else "—"
        print(f"{item['id']:<4} {brief_type:<12} {title:<45} {status:<12} {scheduled}")
    print()


def cmd_sync_instagram(max_videos: int = None):
    channel = _load_channel()
    handle = channel.get("instagram_handle", "@raquelpiiires")
    secrets_file = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json")
    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp"))

    label = f"até {max_videos}" if max_videos else "todos os"
    print(f"\nBuscando {label} vídeos de {handle}...")
    try:
        videos = fetch_profile_videos(handle, max_videos=max_videos)
    except Exception as e:
        print(f"Erro ao buscar vídeos do Instagram: {e}")
        return

    if not videos:
        print("Nenhum vídeo encontrado.")
        return

    new_count = 0
    for video in videos:
        ig_id = video["instagram_id"]
        if is_instagram_synced(ig_id):
            print(f"  [já sincronizado] {ig_id}")
            continue

        title = caption_to_youtube_title(video["description"] or video["title"])
        description = build_ig_description(video["description"] or video["title"], video["url"])
        tags = channel.get("branding", {}).get("default_hashtags", [])

        print(f"\n→ Baixando: {title[:60]}...")
        try:
            video_path = download_video(video["url"], temp_dir)
        except Exception as e:
            print(f"  Erro ao baixar {ig_id}: {e}")
            continue

        queue_id = enqueue_instagram_video(ig_id, title, description, tags, str(video_path))
        print(f"  ✓ Enfileirado (#{queue_id}): {title[:60]}")

        print(f"  Fazendo upload no YouTube...")
        try:
            from pipeline.uploader import upload_video
            yt_id = upload_video(
                file_path=str(video_path),
                title=title,
                description=description,
                tags=[t.lstrip("#") for t in tags],
                secrets_file=secrets_file,
            )
            mark_instagram_synced(ig_id, yt_id)
            print(f"  ✓ Publicado: https://youtu.be/{yt_id}")
            new_count += 1
        except Exception as e:
            print(f"  Erro no upload: {e}")
            mark_instagram_synced(ig_id)

    print(f"\nSincronização concluída. {new_count} vídeo(s) publicado(s).")


def cmd_add_review():
    print("\n=== Novo Review de Drama ===")
    drama_title = input("Nome do drama: ").strip()
    platform = input("Plataforma (Netflix/Viki/Kocowa/outro): ").strip() or None
    print("Suas notas (o que achou, pontos fortes, fracos — aperte Enter duas vezes para finalizar):")
    lines = []
    while True:
        line = input()
        if line == "" and lines and lines[-1] == "":
            break
        lines.append(line)
    notes = "\n".join(lines).strip()

    brief = create_manual_brief(
        content_type="review",
        notes=notes,
        drama_title=drama_title,
        platform=platform,
    )
    brief_id = add_brief(**{k: v for k, v in brief.items() if k != "source"}, source=brief["source"])
    print(f"\n✓ Brief #{brief_id} criado. Use 'python main.py generate {brief_id}' para gerar o script.")


def cmd_add_fanmeeting():
    print("\n=== Novo Vlog de Fan Meeting ===")
    event_name = input("Nome do evento/fan meeting: ").strip()
    artists = input("Artista(s): ").strip() or None
    event_date = input("Data do evento (ex: 2026-08-15): ").strip() or None
    event_location = input("Local (cidade/venue): ").strip() or None
    ticket_price = input("Preço do ingresso (ex: R$ 350): ").strip() or None
    print("Suas notas sobre o evento (aperte Enter duas vezes para finalizar):")
    lines = []
    while True:
        line = input()
        if line == "" and lines and lines[-1] == "":
            break
        lines.append(line)
    notes = "\n".join(lines).strip()

    brief = create_manual_brief(
        content_type="fanmeeting",
        notes=notes,
        event_name=event_name,
        artists=artists,
        event_date=event_date,
        event_location=event_location,
        ticket_price=ticket_price,
    )
    brief_id = add_brief(**{k: v for k, v in brief.items() if k != "source"}, source=brief["source"])
    print(f"\n✓ Brief #{brief_id} criado. Use 'python main.py generate {brief_id}' para gerar o script.")


def cmd_add_instagram():
    print("\n=== Importar Post do Instagram ===")
    url = input("URL do post (opcional): ").strip() or None
    print("Cole a legenda do post (aperte Enter duas vezes para finalizar):")
    lines = []
    while True:
        line = input()
        if line == "" and lines and lines[-1] == "":
            break
        lines.append(line)
    caption = "\n".join(lines).strip()

    brief = parse_instagram_post(caption, post_url=url)
    content_type = brief["type"]
    print(f"\nTipo detectado: {content_type}")

    brief_id = add_brief(
        content_type=brief["type"],
        raw_notes=brief["raw_notes"],
        source=brief["source"],
        source_ref=brief.get("source_ref"),
        drama_title=brief.get("drama_title"),
        event_name=brief.get("event_name"),
        platform=brief.get("platform"),
    )
    print(f"✓ Brief #{brief_id} criado. Use 'python main.py generate {brief_id}' para gerar o script.")


def cmd_generate(brief_id: int = None):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERRO: ANTHROPIC_API_KEY não configurada no .env")
        sys.exit(1)

    if brief_id:
        briefs = [get_brief(brief_id)]
        if not briefs[0]:
            print(f"Brief #{brief_id} não encontrado.")
            sys.exit(1)
    else:
        briefs = get_pending_briefs()
        if not briefs:
            print("Nenhum brief pendente.")
            return

    channel = _load_channel()

    for brief in briefs:
        bid = brief["id"]
        subject = brief.get("drama_title") or brief.get("event_name") or f"Brief #{bid}"
        print(f"\nGerando script para: {subject} (tipo: {brief['type']})...")

        try:
            script_data = generate_script(brief, api_key)

            # Monta descrição final com capítulos e hashtags
            script_data["description"] = build_youtube_description(script_data, channel)

            queue_id = enqueue_upload(bid, script_data, video_type="long")
            mark_brief_scripted(bid)

            print(f"  ✓ Script gerado. Item na fila: #{queue_id}")
            print(f"  Título YouTube: {script_data.get('youtube_title')}")
            print(f"  Shorts planejados: {len(script_data.get('shorts_hooks', []))}")

            # Salva script em data/scripts/ para revisão
            scripts_dir = Path("data/scripts")
            scripts_dir.mkdir(parents=True, exist_ok=True)
            slug = script_data.get("youtube_title", f"brief-{bid}")[:50].replace(" ", "-").lower()
            script_path = scripts_dir / f"{bid}-{slug}.json"
            script_path.write_text(json.dumps(script_data, ensure_ascii=False, indent=2))
            print(f"  Script salvo em: {script_path}")

        except Exception as e:
            log.error(f"Erro ao gerar script para brief #{bid}: {e}")


def cmd_seo(queue_id: int, youtube_url: str):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERRO: ANTHROPIC_API_KEY não configurada no .env")
        sys.exit(1)

    items = get_all_queue()
    item = next((i for i in items if i["id"] == queue_id), None)
    if not item:
        print(f"Item #{queue_id} não encontrado na fila.")
        sys.exit(1)

    brief = get_brief(item["brief_id"])
    if not brief:
        print(f"Brief #{item['brief_id']} não encontrado.")
        sys.exit(1)

    script_data = {
        "script": item.get("script"),
        "blog_keywords": json.loads(item.get("blog_keywords") or "[]"),
        "youtube_title": item.get("title"),
    }

    print(f"Gerando artigo SEO para: {item.get('title')}...")
    try:
        article = generate_blog_article(brief, script_data, youtube_url, api_key)
        article_json = json.dumps(article, ensure_ascii=False, indent=2)
        set_blog_article(queue_id, article_json)

        published = publish_article(article)
        if published:
            print(f"  ✓ Artigo publicado no blog: {article.get('slug')}")
        else:
            print(f"  ✓ Artigo salvo localmente (Soro IA não configurada)")
            print(f"  Meta title: {article.get('meta_title')}")
    except Exception as e:
        log.error(f"Erro ao gerar artigo SEO: {e}")


def cmd_schedule(queue_id: int):
    schedule = _load_schedule()
    try:
        slot = next_upload_slot(
            schedule["upload_slots_brt"],
            max_per_day=schedule.get("max_uploads_per_day", 1),
        )
        schedule_upload(queue_id, slot)
        print(f"✓ Item #{queue_id} agendado para: {slot} UTC")
    except RuntimeError as e:
        print(f"ERRO: {e}")


def cmd_upload():
    due = get_due_uploads()
    if not due:
        print("Nenhum upload agendado para agora.")
        return

    secrets_file = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json")
    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp"))

    for item in due:
        title = item.get("title", "Sem título")
        print(f"Fazendo upload: {title}")
        video_path = temp_dir / f"{item['id']}_final.mp4"

        if not video_path.exists():
            print(f"  AVISO: arquivo de vídeo não encontrado em {video_path}. Pulando.")
            continue

        try:
            tags = json.loads(item.get("tags") or "[]")
            yt_id = upload_video(
                file_path=str(video_path),
                title=title,
                description=item.get("description", ""),
                tags=tags,
                secrets_file=secrets_file,
            )
            mark_uploaded(item["id"], yt_id)
            mark_brief_done(item["brief_id"])
            print(f"  ✓ Publicado: https://youtu.be/{yt_id}")
        except Exception as e:
            log.error(f"Erro no upload do item #{item['id']}: {e}")


# ─── ENTRYPOINT ──────────────────────────────────────────────────────────────

def main():
    init_db()

    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    cmd = args[0]

    if cmd == "status":
        cmd_status()

    elif cmd == "sync-instagram":
        max_videos = int(args[1]) if len(args) > 1 else None
        cmd_sync_instagram(max_videos)

    elif cmd == "add-review":
        cmd_add_review()

    elif cmd == "add-fanmeeting":
        cmd_add_fanmeeting()

    elif cmd == "add-instagram":
        cmd_add_instagram()

    elif cmd == "generate":
        brief_id = int(args[1]) if len(args) > 1 else None
        cmd_generate(brief_id)

    elif cmd == "seo":
        if len(args) < 3:
            print("Uso: python main.py seo <queue_id> <youtube_url>")
            sys.exit(1)
        cmd_seo(int(args[1]), args[2])

    elif cmd == "schedule":
        if len(args) < 2:
            print("Uso: python main.py schedule <queue_id>")
            sys.exit(1)
        cmd_schedule(int(args[1]))

    elif cmd == "upload":
        cmd_upload()

    else:
        print(f"Comando desconhecido: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
