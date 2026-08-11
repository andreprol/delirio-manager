"""
Baixa vídeos públicos do Instagram usando instaloader.
Funciona sem login para perfis públicos.
"""
import re
import subprocess
import sys
from pathlib import Path
from datetime import datetime


def _ensure_instaloader():
    try:
        import instaloader  # noqa: F401
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "instaloader", "-q"])


def fetch_and_download_profile(handle: str, output_dir: Path) -> list[dict]:
    """
    Baixa todos os vídeos/reels de um perfil público do Instagram.
    Retorna lista de dicts com: instagram_id, file_path, caption, timestamp.
    Pula posts que já existem na pasta (instaloader faz isso nativamente).
    """
    _ensure_instaloader()
    import instaloader

    username = handle.lstrip("@")
    output_dir.mkdir(parents=True, exist_ok=True)

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

    profile = instaloader.Profile.from_username(L.context, username)
    results = []

    for post in profile.get_posts():
        if not post.is_video:
            continue

        media_id = str(post.mediaid)
        timestamp = post.date_utc

        # Verifica se já foi baixado
        profile_dir = output_dir / username
        existing = list(profile_dir.glob(f"*_{media_id}.mp4")) if profile_dir.exists() else []

        if not existing:
            try:
                L.download_post(post, target=str(profile_dir))
            except Exception as e:
                print(f"  Erro ao baixar post {media_id}: {e}")
                continue

        # Encontra o arquivo baixado
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
