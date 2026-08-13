"""
Baixa vídeos do Instagram usando instaloader (paginação completa) + curl_cffi (download Chrome TLS).

Fluxo:
  - instaloader.Profile.get_posts() itera TODOS os posts do perfil (mais recente → mais antigo)
  - curl_cffi baixa os arquivos de vídeo com TLS Chrome120 (evita 429 por fingerprint)
  - Para após MAX_NEW uploads novos (padrão: 5)
  - Para após MAX_CONSECUTIVE posts já sincronizados consecutivos (steady state)
"""
import os
import re
import subprocess
import sys
from pathlib import Path
from datetime import datetime

# Em steady state (todo backlog sincronizado), para após N consecutivos vistos.
# Valor alto para não interromper busca em backlog (onde N recentes já estão no banco).
MAX_ALREADY_SEEN_CONSECUTIVE = 20


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


def fetch_and_download_profile(
    handle: str,
    output_dir: Path,
    already_synced_ids: set | None = None,
    max_new: int | None = None,
) -> list[dict]:
    """
    Baixa vídeos/reels de um perfil do Instagram usando paginação completa.

    - Itera TODOS os posts (mais recente → mais antigo) via instaloader Profile.get_posts()
    - Para após `max_new` vídeos novos baixados (backlog mode)
    - Para após MAX_ALREADY_SEEN_CONSECUTIVE posts vistos consecutivos (steady state)
    - Nunca sobe duplicatas: checa already_synced_ids antes de baixar
    - Download via curl_cffi Chrome TLS (evita 429 por fingerprint TLS)
    """
    _ensure_deps()
    import instaloader
    from datetime import timezone
    from curl_cffi import requests as cffi_requests

    username = handle.lstrip("@")
    output_dir.mkdir(parents=True, exist_ok=True)
    already_synced_ids = already_synced_ids or set()

    # --- Setup instaloader (paginação) ---
    # max_connection_attempts=1: falha imediato em 429, sem retry loop de 666s
    L = instaloader.Instaloader(quiet=True, max_connection_attempts=1)
    ig_username = os.environ.get("INSTAGRAM_USERNAME", "").strip()
    if ig_username:
        try:
            L.load_session_from_file(ig_username)
            print(f"  Session Instagram carregada para @{ig_username}")
        except Exception as e:
            print(f"  Aviso: session não carregada ({type(e).__name__}): {e}")

    # --- Setup curl_cffi para download dos arquivos ---
    try:
        cffi_session = _get_cffi_session(L)
        print("  curl_cffi Chrome TLS ativado (cookies auth)")
    except Exception as e:
        print(f"  curl_cffi fallback anônimo ({type(e).__name__}): {e}")
        cffi_session = cffi_requests.Session(impersonate="chrome120")
        cffi_session.headers.update({"X-IG-App-ID": "936619743392459"})

    # --- Iterar posts via instaloader (paginação completa) ---
    try:
        profile = instaloader.Profile.from_username(L.context, username)
    except Exception as e:
        raise RuntimeError(f"Erro ao acessar perfil @{username}: {e}")

    profile_dir = output_dir / username
    profile_dir.mkdir(parents=True, exist_ok=True)

    results = []
    consecutive_seen = 0

    for post in profile.get_posts():
        # Coletar nós de vídeo: post simples ou carousel
        video_nodes: list[tuple[str, str, str]] = []  # (media_id, video_url, shortcode)

        if post.is_video:
            video_nodes = [(str(post.mediaid), post.video_url, post.shortcode)]
        elif post.typename == "GraphSidecar":
            try:
                for node in post.get_sidecar_nodes():
                    if node.is_video:
                        video_nodes.append((str(node.mediaid), node.video_url, node.shortcode))
            except Exception:
                pass

        if not video_nodes:
            continue

        # Verificar se o post pai já foi sincronizado (pelo mediaid do post)
        post_id = str(post.mediaid)
        all_synced = all(mid in already_synced_ids for (mid, _, _) in video_nodes)

        if all_synced:
            consecutive_seen += 1
            if consecutive_seen >= MAX_ALREADY_SEEN_CONSECUTIVE:
                print(f"  {MAX_ALREADY_SEEN_CONSECUTIVE} posts consecutivos já sincronizados — steady state, parando")
                break
            continue

        consecutive_seen = 0
        caption = post.caption or ""
        timestamp = post.date_utc

        for (media_id, video_url, shortcode) in video_nodes:
            if media_id in already_synced_ids:
                continue
            if not video_url:
                continue

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
