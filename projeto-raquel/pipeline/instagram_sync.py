"""
Baixa vídeos públicos do Instagram usando instaloader.
Suporta session autenticada via INSTAGRAM_USERNAME no .env para evitar rate limit.

Usa curl_cffi para imitar TLS fingerprint do Chrome — contorna o 429 do Instagram
que é causado pelo fingerprint TLS do Python/requests (não pelo IP).
"""
import os
import re
import subprocess
import sys
from pathlib import Path
from datetime import datetime

# Para de varrer o perfil após N posts consecutivos já sincronizados.
# Reduz chamadas API de ~50 para ~3-5 por sync diário.
MAX_ALREADY_SEEN_CONSECUTIVE = 3


def _ensure_deps():
    for pkg, import_name in [("instaloader", "instaloader"), ("curl_cffi", "curl_cffi")]:
        try:
            __import__(import_name)
        except ImportError:
            subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "-q"])


def _get_cffi_session(L):
    """
    Cria uma curl_cffi.Session com TLS Chrome120, copiando cookies e UA do instaloader.
    Retorna a sessão para uso direto nas chamadas de API Instagram.
    """
    from curl_cffi import requests as cffi_requests

    old = L.context._session
    cookies = dict(old.cookies)
    ua = old.headers.get("User-Agent", "")

    s = cffi_requests.Session(impersonate="chrome120")
    for name, value in cookies.items():
        s.cookies.set(name, value, domain=".instagram.com")
    if ua:
        s.headers.update({"User-Agent": ua})
    s.headers.update({"X-IG-App-ID": "936619743392459"})
    return s


def _fetch_user_id(handle: str, cffi_session) -> str:
    """Busca user_id de um perfil público via curl_cffi (Chrome TLS)."""
    r = cffi_session.get(
        f"https://www.instagram.com/api/v1/users/web_profile_info/?username={handle}",
        timeout=15,
    )
    if r.status_code == 429:
        raise RuntimeError(f"Instagram 429 Too Many Requests — IP rate-limited. Tente novamente mais tarde.")
    if r.status_code != 200:
        raise RuntimeError(f"Instagram {r.status_code} ao buscar user_id de @{handle}: {r.text[:200]}")
    return r.json()["data"]["user"]["id"]


def _fetch_recent_posts(username: str, cffi_session) -> list[dict]:
    """
    Busca posts recentes do perfil via web_profile_info (retorna ~12 mais recentes).
    Suficiente para sync diário — perfis não postam 12+ vídeos por dia.
    """
    r = cffi_session.get(
        f"https://www.instagram.com/api/v1/users/web_profile_info/?username={username}",
        timeout=15,
    )
    if r.status_code == 429:
        raise RuntimeError(f"Instagram 429 Too Many Requests — IP rate-limited. Tente novamente mais tarde.")
    if r.status_code != 200:
        raise RuntimeError(f"Instagram {r.status_code} ao buscar posts de @{username}: {r.text[:200]}")
    user = r.json().get("data", {}).get("user", {})
    edges = user.get("edge_owner_to_timeline_media", {}).get("edges", [])
    return [e["node"] for e in edges]


def _download_video(url: str, dest: Path, cffi_session) -> bool:
    """Baixa arquivo de vídeo da CDN do Instagram."""
    try:
        r = cffi_session.get(url, stream=True, timeout=60)
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


def fetch_and_download_profile(handle: str, output_dir: Path, already_synced_ids: set | None = None) -> list[dict]:
    """
    Baixa vídeos/reels novos de um perfil do Instagram.
    Para de iterar após MAX_ALREADY_SEEN_CONSECUTIVE posts já vistos consecutivos.
    Retorna lista de dicts com: instagram_id, file_path, caption, timestamp.

    Usa curl_cffi com Chrome TLS fingerprint para contornar 429 do Instagram.
    O sessionid do @andreprol (via instaloader session file) é usado para auth.
    """
    _ensure_deps()
    import instaloader
    from datetime import timezone

    username = handle.lstrip("@")
    output_dir.mkdir(parents=True, exist_ok=True)
    already_synced_ids = already_synced_ids or set()

    # Criar sessão curl_cffi com Chrome TLS
    # Tenta carregar cookies do instaloader para auth; fallback anônimo se falhar
    from curl_cffi import requests as cffi_requests

    cffi_session = None
    ig_username = os.environ.get("INSTAGRAM_USERNAME", "").strip()
    if ig_username:
        try:
            L = instaloader.Instaloader(quiet=True)
            L.load_session_from_file(ig_username)
            print(f"  Session Instagram carregada para @{ig_username}")
            cffi_session = _get_cffi_session(L)
            print("  TLS Chrome impersonation ativado (curl_cffi + cookies auth)")
        except Exception as e:
            print(f"  Aviso: session auth falhou ({type(e).__name__}): {e}")

    if cffi_session is None:
        cffi_session = cffi_requests.Session(impersonate="chrome120")
        cffi_session.headers.update({"X-IG-App-ID": "936619743392459"})
        print("  TLS Chrome impersonation ativado (curl_cffi anônimo)")

    # Buscar posts recentes do perfil
    try:
        nodes = _fetch_recent_posts(username, cffi_session)
    except Exception as e:
        raise RuntimeError(f"Erro ao buscar vídeos do Instagram: {e}")

    results = []
    consecutive_seen = 0
    profile_dir = output_dir / username
    profile_dir.mkdir(parents=True, exist_ok=True)

    for node in nodes:
        # Suporte a posts simples e carrosséis com vídeo
        is_video = node.get("is_video", False)
        children = node.get("edge_sidecar_to_children", {}).get("edges", [])
        video_nodes = []
        if is_video:
            video_nodes = [node]
        elif children:
            video_nodes = [e["node"] for e in children if e["node"].get("is_video")]

        if not video_nodes:
            continue

        for vnode in video_nodes:
            media_id = str(vnode.get("id") or node.get("id"))
            shortcode = vnode.get("shortcode") or node.get("shortcode", "")

            if media_id in already_synced_ids:
                consecutive_seen += 1
                if consecutive_seen >= MAX_ALREADY_SEEN_CONSECUTIVE:
                    print(f"  {MAX_ALREADY_SEEN_CONSECUTIVE} posts consecutivos já sincronizados — parando")
                    return results
                continue

            consecutive_seen = 0

            video_url = vnode.get("video_url")
            if not video_url:
                continue

            timestamp_raw = node.get("taken_at_timestamp", 0)
            timestamp = datetime.fromtimestamp(timestamp_raw, tz=timezone.utc)
            caption_edges = node.get("edge_media_to_caption", {}).get("edges", [])
            caption = caption_edges[0]["node"]["text"] if caption_edges else ""

            date_str = timestamp.strftime("%Y%m%d")
            dest = profile_dir / f"{date_str}_{media_id}.mp4"

            if not dest.exists():
                print(f"  Baixando {dest.name}...")
                if not _download_video(video_url, dest, cffi_session):
                    continue

            results.append({
                "instagram_id": media_id,
                "file_path": str(dest),
                "caption": caption,
                "timestamp": timestamp.isoformat(),
                "url": f"https://www.instagram.com/p/{shortcode}/",
            })

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
