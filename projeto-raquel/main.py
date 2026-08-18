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

  Fluxo 16:9 (vídeo longo — gera horas de exibição para monetização):
  python main.py fetch [N]                Baixa N Reels para o pool, sem publicar
  python main.py compile [N]              Monta compilados 16:9 de 10-15 min do pool
  python main.py publish                  Sobe os compilados prontos para o YouTube
  python main.py pool                     Mostra o estado do pool e dos compilados
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
    mark_uploaded, mark_instagram_synced, is_instagram_synced, get_all_synced_instagram_ids,
    next_upload_slot, set_blog_article,
    add_clip_to_pool, get_pool_ids, get_available_clips,
    create_compilation, get_pending_compilations, mark_compilation_uploaded,
    next_compilation_number,
)
from pipeline.content_intake import (
    parse_instagram_post, create_manual_brief, detect_content_type,
)
from pipeline.instagram_sync import (
    fetch_and_download_profile,
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


def cmd_sync_instagram(max_videos: int = 5):
    channel = _load_channel()
    handle = channel.get("instagram_handle", "@raquelpiiires")
    secrets_file = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json")
    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp"))

    print(f"\nBuscando vídeos de {handle} (máx {max_videos} novos por rodada)...")

    synced_ids = get_all_synced_instagram_ids()
    print(f"  {len(synced_ids)} posts já sincronizados no banco\n")

    try:
        videos = fetch_and_download_profile(
            handle, temp_dir,
            already_synced_ids=synced_ids,
            max_new=max_videos,
        )
    except Exception as e:
        print(f"Erro ao buscar vídeos do Instagram: {e}")
        return

    if not videos:
        print("Nenhum vídeo novo recente. Buscando no backlog histórico do perfil...")
        try:
            videos = fetch_and_download_profile(
                handle, temp_dir,
                already_synced_ids=synced_ids,
                max_new=max_videos,
                max_consecutive_seen=60,
            )
        except Exception as e:
            print(f"Erro ao buscar backlog histórico: {e}")
            return

    if not videos:
        print("Nenhum vídeo encontrado (novo ou backlog).")
        return

    tags = channel.get("branding", {}).get("default_hashtags", [])
    new_count = 0

    for video in videos:
        ig_id = video["instagram_id"]
        if is_instagram_synced(ig_id):
            print(f"  [já no YouTube] {ig_id}")
            continue

        title = caption_to_youtube_title(video["caption"])
        description = build_ig_description(video["caption"], video["url"])

        print(f"→ Upload: {title[:60]}...")
        enqueue_instagram_video(ig_id, title, description, tags, video["file_path"])

        try:
            yt_id = upload_video(
                file_path=video["file_path"],
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


# ─── FLUXO 16:9 (VÍDEO LONGO) ────────────────────────────────────────────────

def cmd_fetch(max_videos: int = 20):
    """Baixa Reels para o pool de compilação. Não publica nada."""
    from pipeline.compiler import probe_duration

    channel = _load_channel()
    handle = channel.get("instagram_handle", "@raquelpiiires")
    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp"))

    # Ignora o que já foi publicado E o que já está esperando compilação.
    known = get_all_synced_instagram_ids() | get_pool_ids()
    print(f"\nBuscando até {max_videos} Reels novos de {handle} ({len(known)} já conhecidos)...")

    try:
        videos = fetch_and_download_profile(
            handle, temp_dir, already_synced_ids=known, max_new=max_videos,
        )
    except Exception as e:
        # Formato reconhecido por deploy/notify_result.py para classificar 401/429.
        print(f"Erro ao buscar vídeos do Instagram: {e}")
        return

    if not videos:
        print("Nenhum Reel novo encontrado.")
        return

    for v in videos:
        dur = probe_duration(v["file_path"])
        if dur <= 0:
            print(f"  ignorando {Path(v['file_path']).name}: vídeo ilegível")
            continue
        add_clip_to_pool(v["instagram_id"], v["file_path"], v["caption"], dur, v["timestamp"])

    total = sum(c["duration"] for c in get_available_clips())
    print(f"\n{len(videos)} Reel(s) no pool. Disponível para compilar: {total/60:.1f} min.")


def _compilation_title(group: list[dict], index: int) -> str:
    """
    Título do compilado, a partir do que o grupo realmente tem em comum
    (um evento numa data, ou um assunto recorrente). Usa Claude se houver chave.
    """
    from pipeline.compiler import _clip_label, _day

    topic = group[0].get("_topic")
    labels = [_clip_label(c.get("caption", ""), i) for i, c in enumerate(group, 1)]
    api_key = os.environ.get("ANTHROPIC_API_KEY")

    if api_key:
        try:
            import anthropic
            joined = "\n".join(f"- {l}" for l in labels[:20])
            if topic:
                context = f"Todos falam do mesmo assunto: '{topic}'."
            else:
                context = f"Todos são do mesmo evento, gravados em {_day(group[0])}."

            msg = anthropic.Anthropic(api_key=api_key).messages.create(
                model="claude-sonnet-5",
                max_tokens=100,
                messages=[{
                    "role": "user",
                    "content": (
                        "Canal da Raquel Pires, sobre K-dramas, C-dramas e fan meetings. "
                        f"{context}\n\nTrechos que compõem o vídeo:\n{joined}\n\n"
                        "Escreva UM título de YouTube em português do Brasil que descreva "
                        "esse vídeo específico. Máximo 70 caracteres, sem aspas, sem emoji, "
                        "sem numeração. Responda apenas com o título."
                    ),
                }],
            )
            title = msg.content[0].text.strip().strip('"')
            if title:
                return title[:90]
        except Exception as e:
            log.warning(f"Título via Claude falhou ({e}); usando padrão.")

    if topic:
        return f"Tudo sobre {topic.capitalize()} — Raquel Pires"
    return f"Cobertura completa — {_day(group[0])}"


def cmd_compile(max_compilations: int = None):
    """Agrupa o pool em compilados 16:9 de 10-15 min e renderiza cada um."""
    from pipeline.compiler import build_compilation, build_description, group_clips

    clips = get_available_clips()
    if not clips:
        print("Pool vazio. Rode 'python main.py fetch 20' primeiro.")
        return

    groups, leftover = group_clips(clips)
    leftover_min = sum(c["duration"] for c in leftover) / 60
    if not groups:
        print(
            f"Nenhum evento ou tema com material suficiente ({len(leftover)} clipe(s) "
            f"avulsos, {leftover_min:.1f} min no pool).\n"
            f"Clipes soltos não são colados a esmo — ficam esperando outros do mesmo "
            f"assunto. Rode 'python main.py fetch' para acumular mais."
        )
        return

    if max_compilations:
        groups = groups[:max_compilations]

    out_dir = Path("data/compilations")
    work_dir = Path(os.getenv("TEMP_DIR", "data/temp")) / "_build"

    print(f"\n{len(groups)} compilado(s) a montar ({leftover_min:.1f} min sobram no pool).\n")

    for n, group in enumerate(groups, start=1):
        total_min = sum(c["duration"] for c in group) / 60
        number = next_compilation_number()
        title = _compilation_title(group, number)
        out_path = out_dir / f"comp_{number:03d}.mp4"

        print(f"[{n}/{len(groups)}] {title}")
        print(f"  {len(group)} clipes · {total_min:.1f} min")

        try:
            result = build_compilation(group, out_path, title, work_dir)
        except Exception as e:
            log.error(f"Falha ao montar compilado '{title}': {e}")
            continue

        description = build_description(result["chapters"])
        comp_id = create_compilation(
            title, description, result["path"], result["duration"], result["clips"],
        )
        print(f"  ✓ #{comp_id} pronto: {result['path']} ({result['duration']/60:.1f} min)\n")

    print("Compilados prontos. Rode 'python main.py publish' para enviar ao YouTube.")


def cmd_publish():
    """Sobe os compilados já montados para o YouTube."""
    channel = _load_channel()
    tags = [t.lstrip("#") for t in channel.get("branding", {}).get("default_hashtags", [])]
    secrets_file = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json")

    pending = get_pending_compilations()
    if not pending:
        print("Nenhum compilado pendente. Rode 'python main.py compile' primeiro.")
        return

    ok = 0
    for comp in pending:
        path = Path(comp["file_path"])
        if not path.exists():
            log.error(f"Compilado #{comp['id']}: arquivo sumiu ({path}). Pulando.")
            continue

        print(f"→ Upload #{comp['id']}: {comp['title']}")
        try:
            yt_id = upload_video(
                file_path=str(path),
                title=comp["title"],
                description=comp["description"] or "",
                tags=tags,
                secrets_file=secrets_file,
            )
        except Exception as e:
            log.error(f"Erro no upload do compilado #{comp['id']}: {e}")
            continue

        mark_compilation_uploaded(comp["id"], yt_id)
        print(f"  ✓ Publicado: https://youtu.be/{yt_id}\n")
        ok += 1

    print(f"{ok} compilado(s) publicado(s).")


def cmd_pool():
    """Estado do pool de clipes e dos compilados."""
    clips = get_available_clips()
    total_min = sum(c["duration"] for c in clips) / 60
    pending = get_pending_compilations()

    print(f"\nPool: {len(clips)} clipe(s) livres · {total_min:.1f} min")
    print(f"Rende aproximadamente {int(total_min // 12)} compilado(s) de ~12 min")
    print(f"Compilados montados aguardando upload: {len(pending)}")
    for comp in pending:
        print(f"  #{comp['id']:<4} {comp['title'][:60]:<62} {(comp['duration'] or 0)/60:.1f} min")
    print()


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
        if len(args) > 1:
            cmd_sync_instagram(int(args[1]))
        else:
            cmd_sync_instagram()

    elif cmd == "fetch":
        cmd_fetch(int(args[1]) if len(args) > 1 else 20)

    elif cmd == "compile":
        cmd_compile(int(args[1]) if len(args) > 1 else None)

    elif cmd == "publish":
        cmd_publish()

    elif cmd == "pool":
        cmd_pool()

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
