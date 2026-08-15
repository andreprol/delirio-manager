"""
Baixa vídeos do Instagram usando curl_cffi Chrome TLS para TUDO
(profile lookup + paginação + download de vídeos).

Fluxo:
  - curl_cffi obtém user_id via web_profile_info (Chrome TLS — sem 429)
  - Mobile API /api/v1/feed/user/{user_id}/ pagina TODOS os posts
  - curl_cffi baixa os arquivos de vídeo
  - Para após MAX_NEW uploads novos (padrão: 5)
  - Para após MAX_CONSECUTIVE posts já sincronizados consecutivos (steady state)

Instaloader é usado APENAS para carregar os cookies da session auth.
Sem instaloader no path crítico → sem rate limit de fingerprint TLS.
"""
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# Em steady state, para após N posts consecutivos já sincronizados.
MAX_ALREADY_SEEN_CONSECUTIVE = 100

# user_id fixo de @raquelpiiires (evita lookup em web_profile_info)
_RAQUEL_USER_ID = 46251461


def _ensure_deps():
    for pkg, import_name in [("instaloader", "instaloader"), ("curl_cffi", "curl_cffi")]:
        try:
            __import__(import_name)
        except ImportError:
            subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "-q"])


def _build_cffi_session() -> object:
    """
    Cria curl_cffi Session Chrome120 com cookies de auth do Instagram.

    Prioridade:
    1. INSTAGRAM_SESSION_ID no .env (Chrome cookies — sempre fresh)
    2. Instaloader session file (fallback — pode expirar em dias)
    """
    from curl_cffi import requests as cffi_requests
    from urllib.parse import unquote

    proxy_url = os.environ.get("INSTAGRAM_PROXY", "").strip()
    proxies = {"https": proxy_url, "http": proxy_url} if proxy_url else None
    s = cffi_requests.Session(impersonate="chrome120", proxies=proxies)
    s.headers.update({"X-IG-App-ID": "936619743392459"})
    if proxy_url:
        print(f"  Proxy ativo: {proxy_url.split('@')[-1]}")

    session_id = os.environ.get("INSTAGRAM_SESSION_ID", "").strip()
    if session_id:
        s.cookies.set("sessionid", unquote(session_id), domain=".instagram.com")
        csrftoken = os.environ.get("INSTAGRAM_CSRFTOKEN", "").strip()
        ds_user_id = os.environ.get("INSTAGRAM_DS_USER_ID", "").strip()
        if csrftoken:
            s.cookies.set("csrftoken", csrftoken, domain=".instagram.com")
        if ds_user_id:
            s.cookies.set("ds_user_id", ds_user_id, domain=".instagram.com")
        print("  Cookies Chrome carregados (INSTAGRAM_SESSION_ID)")
        return s

    # Fallback: instaloader session file
    import instaloader
    ig_username = os.environ.get("INSTAGRAM_USERNAME", "").strip()
    if ig_username:
        try:
            L = instaloader.Instaloader(quiet=True, max_connection_attempts=1)
            L.load_session_from_file(ig_username)
            for cookie in L.context._session.cookies:
                s.cookies.set(cookie.name, cookie.value, domain=".instagram.com")
            print(f"  Cookies instaloader @{ig_username} carregados (fallback)")
        except Exception as e:
            print(f"  Aviso: cookies não carregados ({type(e).__name__}): {e}")

    return s


def _get_user_id(handle: str, session) -> int:
    """
    Retorna user_id do perfil via web_profile_info (curl_cffi Chrome TLS).
    Usa cache fixo para @raquelpiiires para evitar chamada desnecessária.
    """
    username = handle.lstrip("@")
    if username == "raquelpiiires":
        return _RAQUEL_USER_ID

    r = session.get(
        f"https://www.instagram.com/api/v1/users/web_profile_info/?username={username}",
        timeout=15,
    )
    r.raise_for_status()
    uid = r.json()["data"]["user"]["id"]
    return int(uid)


def _iter_posts(user_id: int, session):
    """
    Gera items de posts via mobile API, paginando até o fim do perfil.
    Cada item é o dict bruto da API do Instagram.
    """
    url = f"https://www.instagram.com/api/v1/feed/user/{user_id}/?count=12"
    while url:
        r = session.get(url, timeout=20)
        if r.status_code != 200:
            raise RuntimeError(
                f"Instagram {r.status_code} ao paginar posts. "
                f"{'IP rate-limited. Tente mais tarde.' if r.status_code == 429 else r.text[:120]}"
            )
        data = r.json()
        for item in data.get("items", []):
            yield item
        next_cursor = data.get("next_max_id")
        url = (
            f"https://www.instagram.com/api/v1/feed/user/{user_id}/?count=12&max_id={next_cursor}"
            if next_cursor
            else None
        )


def _extract_video_nodes(item: dict) -> list[tuple[str, str, str]]:
    """
    Extrai (media_id, video_url, shortcode) de um item da mobile API.
    media_type: 2=vídeo, 8=carousel, 1=foto (ignorada).
    """
    nodes = []
    mt = item.get("media_type")

    if mt == 2:  # vídeo simples
        vv = item.get("video_versions", [])
        if vv:
            nodes.append((str(item["pk"]), vv[0]["url"], item.get("code", "")))

    elif mt == 8:  # carousel
        for child in item.get("carousel_media", []):
            if child.get("media_type") == 2:
                vv = child.get("video_versions", [])
                if vv:
                    nodes.append((str(child["pk"]), vv[0]["url"], item.get("code", "")))

    return nodes


def _download_video(url: str, dest: Path, session) -> bool:
    """Baixa arquivo de vídeo da CDN do Instagram."""
    try:
        r = session.get(url, stream=True, timeout=60)
        r.raise_for_status()
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
        return True
    except Exception as e:
        print(f"  Erro download {dest.name}: {e}")
        return False


def fetch_and_download_profile(
    handle: str,
    output_dir: Path,
    already_synced_ids: set | None = None,
    max_new: int | None = None,
    max_consecutive_seen: int = MAX_ALREADY_SEEN_CONSECUTIVE,
) -> list[dict]:
    """
    Baixa vídeos/reels de um perfil do Instagram com curl_cffi Chrome TLS.

    - Usa mobile API /api/v1/feed/user/ para paginação (sem web_profile_info rate limit)
    - Para após `max_new` vídeos novos baixados (backlog mode)
    - Para após `max_consecutive_seen` posts já sincronizados consecutivos (steady state)
    - Nunca sobe duplicatas: checa already_synced_ids antes de baixar
    """
    _ensure_deps()

    username = handle.lstrip("@")
    output_dir.mkdir(parents=True, exist_ok=True)
    already_synced_ids = already_synced_ids or set()

    session = _build_cffi_session()

    try:
        user_id = _get_user_id(handle, session)
        print(f"  user_id={user_id}")
    except Exception as e:
        raise RuntimeError(f"Erro ao obter user_id de @{username}: {e}")

    profile_dir = output_dir / username
    profile_dir.mkdir(parents=True, exist_ok=True)

    results = []
    consecutive_seen = 0

    for item in _iter_posts(user_id, session):
        video_nodes = _extract_video_nodes(item)

        if not video_nodes:
            continue

        all_synced = all(mid in already_synced_ids for (mid, _, _) in video_nodes)

        if all_synced:
            consecutive_seen += 1
            if consecutive_seen >= max_consecutive_seen:
                print(f"  {max_consecutive_seen} posts consecutivos já sincronizados — parando")
                break
            continue

        consecutive_seen = 0
        caption_obj = item.get("caption") or {}
        caption = caption_obj.get("text", "") if isinstance(caption_obj, dict) else ""
        taken_at = item.get("taken_at", 0)
        timestamp = datetime.fromtimestamp(taken_at, tz=timezone.utc)

        for (media_id, video_url, shortcode) in video_nodes:
            if media_id in already_synced_ids:
                continue

            date_str = timestamp.strftime("%Y%m%d")
            dest = profile_dir / f"{date_str}_{media_id}.mp4"

            if not dest.exists():
                print(f"  Baixando {dest.name}...")
                if not _download_video(video_url, dest, session):
                    continue

            results.append({
                "instagram_id": media_id,
                "file_path": str(dest),
                "caption": caption,
                "timestamp": timestamp.isoformat(),
                "url": f"https://www.instagram.com/p/{shortcode}/",
            })

            if max_new and len(results) >= max_new:
                print(f"  Limite de {max_new} vídeos novos atingido — parando")
                return results

    return results


def caption_to_youtube_title(caption: str, max_len: int = 80) -> str:
    """Converte a legenda do Instagram em título para o YouTube."""
    first_line = caption.strip().split("\n")[0].strip()
    clean = re.sub(r"#\w+", "", first_line).strip()
    clean = re.sub(r"\s+", " ", clean).strip()
    if not clean:
        clean = first_line
    return clean[:max_len] if clean else "Vídeo"


def build_youtube_description(caption: str, instagram_url: str) -> str:
    """Monta descrição do YouTube a partir da legenda do Instagram."""
    desc = caption.strip()
    desc += f"\n\n📸 Original no Instagram: {instagram_url}"
    return desc
