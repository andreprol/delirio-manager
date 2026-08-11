"""
Baixa vídeos públicos do Instagram usando instaloader.
Suporta session autenticada via INSTAGRAM_USERNAME no .env para evitar rate limit.
Suporta proxy via INSTAGRAM_PROXY no .env (ex: socks5://127.0.0.1:1080 para WARP).
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


def _ensure_instaloader():
    try:
        import instaloader  # noqa: F401
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "instaloader", "-q"])


def fetch_and_download_profile(handle: str, output_dir: Path, already_synced_ids: set | None = None) -> list[dict]:
    """
    Baixa vídeos/reels novos de um perfil do Instagram.
    Para de iterar após MAX_ALREADY_SEEN_CONSECUTIVE posts já vistos consecutivos.
    Retorna lista de dicts com: instagram_id, file_path, caption, timestamp.
    """
    _ensure_instaloader()
    import instaloader

    username = handle.lstrip("@")
    output_dir.mkdir(parents=True, exist_ok=True)
    already_synced_ids = already_synced_ids or set()

    L = instaloader.Instaloader(
        download_pictures=False,
        download_videos=True,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=True,
        compress_json=False,
        quiet=True,
        dirname_pattern=str(output_dir / "{profile}"),
        filename_pattern="{date_utc:%Y%m%d}_{mediaid}",
    )
    # Fail fast on 429 — sem retry infinito (padrão dormia 666s por tentativa)
    L.context.max_connection_attempts = 1

    # Proxy WARP (ou qualquer SOCKS5/HTTP) via env INSTAGRAM_PROXY
    proxy = os.environ.get("INSTAGRAM_PROXY", "").strip()
    if proxy:
        L.context._session.proxies.update({"http": proxy, "https": proxy})
        print(f"  Proxy configurado: {proxy}")

    ig_username = os.environ.get("INSTAGRAM_USERNAME", "").strip()
    if ig_username:
        try:
            L.load_session_from_file(ig_username)
            print(f"  Session Instagram carregada para @{ig_username}")
        except Exception as e:
            print(f"  Aviso: session não encontrada para @{ig_username}: {e}")
            print(f"  Rodando sem autenticação. Para autenticar: instaloader --login={ig_username}")

    try:
        profile = instaloader.Profile.from_username(L.context, username)
    except instaloader.exceptions.ConnectionException as e:
        msg = str(e)
        if "429" in msg or "Too Many Requests" in msg:
            raise RuntimeError(f"Instagram 429 Too Many Requests — IP rate-limited. Tente novamente mais tarde.\n{msg}")
        raise

    results = []
    consecutive_seen = 0

    for post in profile.get_posts():
        if not post.is_video:
            continue

        media_id = str(post.mediaid)

        # Early exit: N posts consecutivos já conhecidos → perfil está em dia
        if media_id in already_synced_ids:
            consecutive_seen += 1
            if consecutive_seen >= MAX_ALREADY_SEEN_CONSECUTIVE:
                print(f"  {MAX_ALREADY_SEEN_CONSECUTIVE} posts já sincronizados consecutivos — parando varredura")
                break
            continue

        consecutive_seen = 0
        timestamp = post.date_utc
        profile_dir = output_dir / username

        existing = list(profile_dir.glob(f"*_{media_id}.mp4")) if profile_dir.exists() else []
        if not existing:
            try:
                L.download_post(post, target=str(profile_dir))
            except Exception as e:
                print(f"  Erro ao baixar post {media_id}: {e}")
                continue

        profile_dir.mkdir(parents=True, exist_ok=True)
        video_files = list(profile_dir.glob(f"*_{media_id}.mp4"))
        if not video_files:
            video_files = list(profile_dir.glob(f"*{media_id}*.mp4"))
        if not video_files:
            continue

        results.append({
            "instagram_id": media_id,
            "file_path": str(video_files[0]),
            "caption": post.caption or "",
            "timestamp": timestamp.isoformat(),
            "url": f"https://www.instagram.com/p/{post.shortcode}/",
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
