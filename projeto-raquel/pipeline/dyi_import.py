"""
Importa o acervo do Instagram a partir do zip de "Baixar suas informações".

Motivo: a mobile API `/api/v1/feed/user/` recusa paginar esta sessão (401
require_login já na segunda página, e o backoff de 11 minutos não destrava).
O fallback `web_profile_info` devolve só os 12 posts mais recentes e não pagina,
então o acervo antigo é inalcançável por API. O export oficial não depende de
endpoint nenhum e traz tudo de uma vez.

O zip NÃO traz o media_id do Instagram, que é a chave primária de todo o
pipeline. Por isso cada entrada recebe um id sintético derivado do caminho
dentro do zip (estável entre reimportações) e a deduplicação é feita por
conteúdo, não por id — ver `plan_import`.
"""
import hashlib
import json
import re
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path

# Nomes de arquivo JSON onde o export lista os posts, em versões diferentes do
# formato. O export mudou de layout ao menos duas vezes; varremos por sufixo.
_POST_JSON_HINTS = ("posts_", "reels", "stories", "igtv", "content/posts")

_VIDEO_SUFFIXES = (".mp4", ".mov")


def _fix_mojibake(text: str) -> str:
    """
    O export grava texto UTF-8 relido como latin-1: "não" vira "nÃ£o". Como as
    legendas são a única fonte permitida para título e descrição, deixar passar
    corromperia exatamente o dado que mais importa.
    """
    if not text:
        return ""
    try:
        return text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        # Já estava correto (ou tem caractere fora do latin-1): usar como veio.
        return text


def _member_digest(zf: zipfile.ZipFile, member: str) -> str:
    """
    Impressão digital do conteúdo de um membro do zip, lida em blocos para não
    carregar um vídeo inteiro na memória.
    """
    h = hashlib.sha1()
    with zf.open(member) as fh:
        for bloco in iter(lambda: fh.read(1 << 20), b""):
            h.update(bloco)
    return h.hexdigest()


def _walk_media(obj):
    """
    Rende dicts de mídia de qualquer um dos formatos de JSON do export.
    Os layouts variam (lista na raiz, {"ig_reels_media": [...]}, etc.), então
    percorremos a árvore em vez de assumir um esquema.
    """
    if isinstance(obj, dict):
        if "uri" in obj and isinstance(obj.get("uri"), str):
            yield obj
        for value in obj.values():
            yield from _walk_media(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from _walk_media(value)


def _entry_caption(media: dict, parent_title: str) -> str:
    """
    A legenda ora está no item de mídia, ora no post que o contém (carrossel:
    uma legenda para N vídeos). Preferimos a do item; caímos na do post.
    """
    for key in ("title", "caption"):
        text = media.get(key)
        if isinstance(text, str) and text.strip():
            return _fix_mojibake(text)
    return _fix_mojibake(parent_title or "")


def find_media_entries(zip_path) -> list[dict]:
    """
    Lê o zip e devolve uma entrada por vídeo: caminho interno, timestamp e
    legenda. Fotos são ignoradas — o pipeline monta compilado de vídeo.
    """
    entries, seen_uris = [], set()

    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        json_names = [
            n for n in names
            if n.endswith(".json") and any(h in n for h in _POST_JSON_HINTS)
        ]
        # Caminhos dos vídeos que realmente existem no zip, para casar com as
        # uris do JSON (que às vezes vêm com prefixo diferente).
        video_members = {n for n in names if n.lower().endswith(_VIDEO_SUFFIXES)}
        by_tail = {Path(n).name: n for n in video_members}

        for jn in json_names:
            try:
                data = json.loads(zf.read(jn).decode("utf-8", errors="replace"))
            except (json.JSONDecodeError, KeyError):
                continue

            for post in (data if isinstance(data, list) else [data]):
                parent_title = post.get("title", "") if isinstance(post, dict) else ""
                for media in _walk_media(post):
                    uri = media.get("uri", "")
                    if not uri.lower().endswith(_VIDEO_SUFFIXES):
                        continue

                    member = uri if uri in video_members else by_tail.get(Path(uri).name)
                    if not member or member in seen_uris:
                        continue
                    seen_uris.add(member)

                    ts = media.get("creation_timestamp") or (
                        post.get("creation_timestamp") if isinstance(post, dict) else None
                    )
                    entries.append({
                        "member": member,
                        "timestamp": int(ts) if ts else 0,
                        "caption": _entry_caption(media, parent_title),
                        # Id sintético: o zip não traz o media_id do Instagram.
                        # Derivar do caminho mantém o mesmo id se o zip for
                        # reimportado, evitando duplicata por reimportação.
                        "instagram_id": "dyi_" + hashlib.sha1(
                            member.encode("utf-8")
                        ).hexdigest()[:16],
                    })

        # Vídeos presentes no zip que nenhum JSON referenciou (layouts antigos
        # deixam mídia órfã). Entram sem legenda em vez de sumir em silêncio —
        # mas só se o conteúdo já não tiver entrado por um caminho referenciado:
        # o mesmo vídeo aparece no zip sob dois nomes, e o id sintético é
        # derivado do caminho, então sem esta checagem viraria duplicata.
        referenciados = {_member_digest(zf, m) for m in seen_uris}
        for member in sorted(video_members - seen_uris):
            if _member_digest(zf, member) in referenciados:
                continue
            entries.append({
                "member": member,
                "timestamp": 0,
                "caption": "",
                "instagram_id": "dyi_" + hashlib.sha1(member.encode("utf-8")).hexdigest()[:16],
                "orphan": True,
            })

    entries.sort(key=lambda e: e["timestamp"])
    return entries


def normalize_caption(text: str) -> str:
    """Impressão digital da legenda: sem acento, sem pontuação, sem caixa."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _day_of(value) -> str:
    """Data (YYYY-MM-DD) de um ISO completo, de uma data solta ou de um epoch."""
    if isinstance(value, (int, float)) and value:
        return datetime.fromtimestamp(value, tz=timezone.utc).strftime("%Y-%m-%d")
    if isinstance(value, str) and len(value) >= 10:
        return value[:10]
    return ""


def plan_import(entries: list[dict], known_captions: dict, known_days: set) -> dict:
    """
    Separa as entradas em novas, duplicadas e ambíguas.

    O zip não tem media_id, então "já temos este post" é decidido por conteúdo:

    1. Legenda idêntica (normalizada) a de um post já conhecido — inclui os 24
       publicados que não têm data nenhuma no banco, cuja legenda original é
       recuperável do upload_queue.
    2. Sem legenda para comparar, mas caindo num dia em que já temos post:
       ambíguo. Não entra sozinho — subir duplicata no canal é pior que deixar
       um clipe de fora, e o operador decide.

    Devolve dict com as três listas.
    """
    novos, duplicados, ambiguos = [], [], []

    for e in entries:
        fingerprint = normalize_caption(e["caption"])
        day = _day_of(e["timestamp"])

        if fingerprint and fingerprint in known_captions:
            e["motivo"] = f"legenda igual a {known_captions[fingerprint]}"
            duplicados.append(e)
        elif not fingerprint and day and day in known_days:
            e["motivo"] = f"sem legenda e já existe post de {day}"
            ambiguos.append(e)
        else:
            novos.append(e)

    return {"novos": novos, "duplicados": duplicados, "ambiguos": ambiguos}
