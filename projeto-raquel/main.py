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
  python main.py fetch [N] [FUNDO]        Baixa N Reels para o pool, sem publicar
                                          FUNDO atravessa N posts ja conhecidos para
                                          alcancar o acervo antigo (so em rodada manual:
                                          na agendada isso varre o perfil 2x/dia e
                                          derrubou a conta anterior)
  python main.py compile [N]              Monta compilados 16:9 de 10-15 min do pool
  python main.py publish                  Sobe os compilados prontos para o YouTube
  python main.py pool                     Mostra o estado do pool e dos compilados
  python main.py reprocess                Devolve Shorts ja publicados ao pool
  python main.py import-dyi <zip> [--apply]
                                          Importa o acervo do zip "Baixar suas
                                          informacoes" do Instagram. Simula por
                                          padrao; --apply grava no pool. E o unico
                                          caminho para o acervo antigo: a mobile
                                          API recusa paginar e o fallback so ve
                                          os 12 posts mais recentes.
"""

import json
import os
import sys
import logging
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

from pipeline.queue import (
    init_db, add_brief, get_pending_briefs, get_brief,
    get_all_queue, mark_brief_scripted, mark_brief_done,
    enqueue_upload, enqueue_instagram_video, schedule_upload,
    get_due_uploads, get_ready_uploads,
    mark_uploaded, mark_instagram_synced, is_instagram_synced, get_all_synced_instagram_ids,
    next_upload_slot, set_blog_article,
    add_clip_to_pool, get_pool_ids, get_available_clips, get_all_pool_clips,
    quarantine_clip, get_exhausted_clip_ids, get_quarantined_clips,
    create_compilation, get_pending_compilations, mark_compilation_uploaded,
    next_compilation_number, set_compilation_title,
    get_original_captions, set_clip_caption,
    get_compilation_clips, set_compilation_description,
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

def cmd_fetch(max_videos: int = 20, max_seen: int = None):
    """
    Baixa Reels para o pool de compilação. Não publica nada.

    `max_seen` atravessa N posts já conhecidos seguidos antes de desistir. O
    padrão (100) serve ao regime diário: o feed começa pelos recentes, então
    100 já cobre qualquer post novo. Valor alto varre o perfil inteiro para
    alcançar o acervo antigo — use só em rodada manual, nunca na agendada.
    """
    from pipeline.compiler import probe_duration, verify_playable

    channel = _load_channel()
    handle = channel.get("instagram_handle", "@raquelpiiires")
    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp"))

    # Ignora o que já foi publicado, o que espera compilação e o que já esgotou
    # as tentativas de download. Quem está em quarentena com tentativas de sobra
    # fica de fora desta lista de propósito: é a chance de baixar de novo.
    known = get_all_synced_instagram_ids() | get_pool_ids() | get_exhausted_clip_ids()
    print(f"\nBuscando até {max_videos} Reels novos de {handle} ({len(known)} já conhecidos)...")

    from pipeline.instagram_sync import MAX_ALREADY_SEEN_CONSECUTIVE
    seen_limit = max_seen or MAX_ALREADY_SEEN_CONSECUTIVE
    if seen_limit > MAX_ALREADY_SEEN_CONSECUTIVE:
        paginas = seen_limit // 12
        print(f"  VARREDURA PROFUNDA: atravessa até {seen_limit} posts conhecidos "
              f"(~{paginas} páginas, ~{paginas * 6.5 / 60:.0f} min de paginação)")

    try:
        videos = fetch_and_download_profile(
            handle, temp_dir, already_synced_ids=known, max_new=max_videos,
            max_consecutive_seen=seen_limit,
        )
    except Exception as e:
        # Formato reconhecido por deploy/notify_result.py para classificar 401/429.
        print(f"Erro ao buscar vídeos do Instagram: {e}")
        return

    if not videos:
        print("Nenhum Reel novo encontrado.")
        return

    added = 0
    for v in videos:
        dur = probe_duration(v["file_path"])
        if dur <= 0:
            print(f"  ignorando {Path(v['file_path']).name}: vídeo ilegível")
            continue
        # probe_duration lê só o cabeçalho: um download interrompido devolve a
        # duração inteira e passa batido. O decode é o que separa vídeo curto de
        # vídeo cortado, e é aqui que ele custa menos — antes de virar render.
        reason = verify_playable(v["file_path"], dur)
        if reason:
            print(f"  em quarentena {Path(v['file_path']).name}: {reason}")
            quarantine_clip(v["instagram_id"], reason, v["file_path"])
            continue
        add_clip_to_pool(v["instagram_id"], v["file_path"], v["caption"], dur, v["timestamp"])
        added += 1

    total = sum(c["duration"] for c in get_available_clips())
    print(f"\n{added} Reel(s) no pool. Disponível para compilar: {total/60:.1f} min.")


def cmd_import_dyi(zip_path: str, apply: bool = False):
    """
    Importa o acervo do zip "Baixar suas informações" do Instagram para o pool.

    Simula por padrão: sem `--apply` nada é gravado. O zip não traz media_id,
    então a deduplicação é por conteúdo e vale a pena olhar o resultado antes.
    """
    from pipeline.compiler import probe_duration, verify_playable
    from pipeline.dyi_import import (
        find_media_entries, normalize_caption, plan_import, _day_of,
    )
    import shutil, zipfile

    path = Path(zip_path)
    if not path.exists():
        print(f"Arquivo não encontrado: {path}")
        return

    print(f"\nLendo {path.name}...")
    entries = find_media_entries(path)
    if not entries:
        print("Nenhum vídeo encontrado no zip.")
        return
    orfaos = sum(1 for e in entries if e.get("orphan"))
    print(f"{len(entries)} vídeo(s) no export" + (f" ({orfaos} sem legenda no JSON)" if orfaos else ""))

    # Impressão digital do que já temos: legendas do pool e as originais dos
    # publicados (recuperadas do upload_queue — é a única pista dos 24 que não
    # têm data nem arquivo em disco).
    known_captions, known_days = {}, set()
    for clip in get_all_pool_clips():
        fp = normalize_caption(clip.get("caption") or "")
        if fp:
            known_captions.setdefault(fp, f"pool/{clip['instagram_id']}")
        day = _day_of(clip.get("taken_at"))
        if day:
            known_days.add(day)
    for ig_id, caption in get_original_captions().items():
        fp = normalize_caption(caption)
        if fp:
            known_captions.setdefault(fp, f"publicado/{ig_id}")

    plano = plan_import(entries, known_captions, known_days)
    print(f"  novos      : {len(plano['novos'])}")
    print(f"  duplicados : {len(plano['duplicados'])} (já no pool ou já publicados)")
    print(f"  ambíguos   : {len(plano['ambiguos'])} (sem legenda, dia já coberto — não entram)")

    for e in plano["ambiguos"][:10]:
        print(f"    ? {Path(e['member']).name}: {e['motivo']}")

    if not apply:
        print("\nSimulação. Rode com --apply para gravar no pool.")
        return

    if not plano["novos"]:
        print("\nNada novo a importar.")
        return

    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp")) / "raquelpiiires"
    temp_dir.mkdir(parents=True, exist_ok=True)

    added = rejeitados = 0
    with zipfile.ZipFile(path) as zf:
        for e in plano["novos"]:
            day = _day_of(e["timestamp"]).replace("-", "") or "00000000"
            dest = temp_dir / f"{day}_{e['instagram_id']}.mp4"

            if not dest.exists():
                with zf.open(e["member"]) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)

            dur = probe_duration(dest)
            if dur <= 0:
                print(f"  ignorando {dest.name}: vídeo ilegível")
                dest.unlink(missing_ok=True)
                rejeitados += 1
                continue

            motivo = verify_playable(dest, dur)
            if motivo:
                print(f"  em quarentena {dest.name}: {motivo}")
                quarantine_clip(e["instagram_id"], motivo, str(dest))
                rejeitados += 1
                continue

            taken_at = (
                datetime.fromtimestamp(e["timestamp"], tz=timezone.utc).isoformat()
                if e["timestamp"] else None
            )
            add_clip_to_pool(e["instagram_id"], str(dest), e["caption"], dur, taken_at)
            added += 1

    total = sum(c["duration"] for c in get_available_clips())
    print(f"\n{added} clipe(s) importado(s), {rejeitados} recusado(s).")
    print(f"Pool: {total/60:.1f} min. Rode 'python main.py compile' para montar.")


def cmd_reprocess():
    """
    Devolve ao pool os Reels que já foram publicados como Shorts, para que
    entrem em compilados 16:9. Os Shorts originais continuam no ar: o id do
    YouTube deles não é sobrescrito (ver mark_compilation_uploaded).
    """
    from pipeline.compiler import probe_duration

    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp")) / "raquelpiiires"
    synced = get_all_synced_instagram_ids()
    in_pool = get_pool_ids()
    # Legenda original da Raquel, recuperada do que foi enviado ao YouTube.
    captions = get_original_captions()

    added, missing = 0, 0
    for path in sorted(temp_dir.glob("*.mp4")):
        parts = path.stem.split("_", 1)
        if len(parts) != 2:
            continue
        date_str, media_id = parts
        if media_id not in synced or media_id in in_pool:
            continue

        dur = probe_duration(path)
        if dur <= 0:
            missing += 1
            continue

        taken = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}" if len(date_str) == 8 else None
        add_clip_to_pool(media_id, str(path), captions.get(media_id, ""), dur, taken)
        added += 1

    # Preenche legenda de clipes que já estavam no pool sem ela.
    backfilled = 0
    for clip in get_available_clips():
        if not clip.get("caption") and captions.get(clip["instagram_id"]):
            set_clip_caption(clip["instagram_id"], captions[clip["instagram_id"]])
            backfilled += 1
    if backfilled:
        print(f"{backfilled} legenda(s) recuperada(s) para clipes já no pool.")

    no_file = len(synced) - added - len(in_pool & synced)
    print(f"\n{added} Short(s) devolvido(s) ao pool para reprocessamento.")
    if missing:
        print(f"{missing} arquivo(s) ilegível(is), ignorado(s).")
    if no_file > 0:
        print(f"{no_file} publicado(s) sem MP4 em disco — não dá para reprocessar.")
    print("\nRode 'python main.py compile' para montar os compilados por evento.")


def _compilation_title(group: list[dict], index: int) -> str:
    """
    Título do compilado, a partir do que o grupo realmente tem em comum
    (um evento numa data, ou um assunto recorrente). Usa Claude se houver chave.
    """
    from pipeline.compiler import _clip_label, _day, title_from_caption

    topic = group[0].get("_topic")

    # Uma legenda só (carrossel) já é o título, escrito pela própria criadora.
    # Passar isso a um modelo só abriria espaço para ele inventar contexto que a
    # legenda não tem — o canal é dela e o assunto não é nosso.
    distinct = {(c.get("caption") or "").strip() for c in group if (c.get("caption") or "").strip()}
    if len(distinct) == 1:
        direct = title_from_caption(distinct.pop())
        if direct:
            return direct
    # Carrossel: os N vídeos de um mesmo post repetem a legenda. Deduplica para
    # não mandar a mesma linha 13 vezes ao modelo.
    labels, seen = [], set()
    for i, clip in enumerate(group, 1):
        label = _clip_label(clip.get("caption", ""), i)
        if label not in seen:
            seen.add(label)
            labels.append(label)

    api_key = os.environ.get("ANTHROPIC_API_KEY")

    if api_key:
        try:
            import anthropic
            joined = "\n".join(f"- {l}" for l in labels[:20])
            if topic:
                context = f"Todas falam do mesmo assunto: '{topic}'."
            else:
                context = f"Todas são do mesmo evento, gravado em {_day(group[0])}."

            msg = anthropic.Anthropic(api_key=api_key).messages.create(
                model="claude-sonnet-5",
                # Folga para o bloco de raciocínio: com 100 o texto vinha vazio.
                max_tokens=1024,
                messages=[{
                    "role": "user",
                    "content": (
                        "Abaixo estão as legendas escritas pela autora dos vídeos que "
                        f"compõem um vídeo único. {context}\n\nLegendas:\n{joined}\n\n"
                        "Escreva UM título de YouTube em português do Brasil usando "
                        "SOMENTE informação presente nas legendas acima. Não acrescente "
                        "nome de artista, evento, gênero ou lugar que não esteja escrito "
                        "nelas — se a legenda não diz, o título não pode dizer. Isso vale "
                        "também para estrutura: não invente 'Parte N', 'Episódio N', "
                        "'Vol. N', 'Dia N' nem qualquer numeração de série que não esteja "
                        "escrita nas legendas — o modelo já produziu 'Parte 5' a partir de "
                        "uma legenda que só dizia 'kit Vip 3'. Prefira "
                        "reaproveitar as palavras da autora. Máximo 70 caracteres, sem "
                        "aspas, sem numeração. Responda apenas com o título."
                    ),
                }],
            )
            # A resposta pode vir com bloco de raciocínio antes do texto.
            text = next((b.text for b in msg.content if getattr(b, "text", None)), "")
            title = text.strip().strip('"')
            if title:
                return title[:90]
        except Exception as e:
            log.warning(f"Título via Claude falhou ({e}); usando padrão.")

    if topic:
        return f"Tudo sobre {topic.capitalize()} — Raquel Pires"
    return f"Cobertura completa — {_day(group[0])}"


def cmd_compile(max_compilations: int = None):
    """Agrupa o pool em compilados 16:9 de 10-15 min e renderiza cada um."""
    from pipeline.compiler import (
        CompilationError, build_compilation, build_description, group_clips,
    )

    def _quarantine(rejected: list[dict]):
        for r in rejected:
            quarantine_clip(r["instagram_id"], r["reason"], r.get("file_path"))
            log.warning(f"Clipe {r['instagram_id']} em quarentena: {r['reason']}")

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
        except CompilationError as e:
            # Quarentena antes do continue: se os clipes ruins ficarem no pool,
            # a mesma falha volta na próxima rodada agendada, para sempre.
            _quarantine(e.rejected)
            log.error(f"Falha ao montar compilado '{title}': {e}")
            continue
        except Exception as e:
            log.error(f"Falha ao montar compilado '{title}': {e}")
            continue

        _quarantine(result.get("rejected", []))
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


def cmd_retitle(comp_id: int, title: str = None):
    """
    Renomeia um compilado. Sem título explícito, regenera a partir das legendas
    originais da Raquel — clipes reprocessados entram no pool sem legenda, e ela
    é recuperada do que foi enviado ao YouTube na época.
    """
    from pipeline.compiler import build_chapters, build_description

    if title is None:
        clips = get_compilation_clips(comp_id)
        if not clips:
            print(f"Compilado #{comp_id} não encontrado.")
            return

        captions = get_original_captions()
        for clip in clips:
            if not clip.get("caption"):
                clip["caption"] = captions.get(clip["instagram_id"], "")

        with_caption = sum(1 for c in clips if c.get("caption"))
        if not with_caption:
            print(f"Nenhuma legenda disponível para o compilado #{comp_id}.")
            return

        print(f"{with_caption}/{len(clips)} clipes com legenda original.")
        title = _compilation_title(clips, comp_id)

        # A descrição abre com a legenda que a própria autora escreveu.
        distinct = []
        for clip in clips:
            text = (clip.get("caption") or "").strip()
            if text and text not in distinct:
                distinct.append(text)
        intro = "\n\n".join(distinct) if distinct else None

        set_compilation_description(
            comp_id,
            build_description(build_chapters(clips), intro_line=intro)
            if intro else build_description(build_chapters(clips)),
        )

    if set_compilation_title(comp_id, title):
        print(f"✓ Compilado #{comp_id}: {title}")
    else:
        print(f"Compilado #{comp_id} não encontrado ou já publicado.")


def cmd_pool():
    """Estado do pool de clipes e dos compilados."""
    from pipeline.compiler import group_clips

    clips = get_available_clips()
    total_min = sum(c["duration"] for c in clips) / 60
    pending = get_pending_compilations()
    groups, leftover = group_clips(list(clips))

    print(f"\nPool: {len(clips)} clipe(s) livres · {total_min:.1f} min")
    print(f"Prontos para virar vídeo agora: {len(groups)} evento(s)/tema(s)")
    if leftover:
        print(f"Aguardando par: {len(leftover)} avulso(s) sem evento nem tema em comum")
    print(f"Compilados montados aguardando upload: {len(pending)}")
    for comp in pending:
        print(f"  #{comp['id']:<4} {comp['title'][:60]:<62} {(comp['duration'] or 0)/60:.1f} min")

    quarantined = get_quarantined_clips()
    if quarantined:
        print(f"\nEm quarentena (ilegíveis): {len(quarantined)}")
        for q in quarantined:
            print(f"  {q['instagram_id']}  tentativas={q['attempts']}  {q['reason'][:70]}")
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
        cmd_fetch(
            int(args[1]) if len(args) > 1 else 20,
            int(args[2]) if len(args) > 2 else None,
        )

    elif cmd == "import-dyi":
        if len(args) < 2:
            print("Uso: python main.py import-dyi <arquivo.zip> [--apply]")
            sys.exit(1)
        cmd_import_dyi(args[1], apply="--apply" in args)

    elif cmd == "compile":
        cmd_compile(int(args[1]) if len(args) > 1 else None)

    elif cmd == "publish":
        cmd_publish()

    elif cmd == "pool":
        cmd_pool()

    elif cmd == "reprocess":
        cmd_reprocess()

    elif cmd == "retitle":
        if len(args) < 2:
            print('Uso: python main.py retitle <id> ["novo titulo"]')
            sys.exit(1)
        cmd_retitle(int(args[1]), " ".join(args[2:]) if len(args) > 2 else None)

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
