"""
Baixa vídeos públicos do Instagram e prepara para upload no YouTube.
Usa yt-dlp para download — não requer login para contas públicas.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from datetime import datetime


def _ensure_ytdlp():
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "yt-dlp", "-q"])


def fetch_profile_videos(handle: str, max_videos: int = 10) -> list[dict]:
    """
    Busca metadados dos vídeos mais recentes de um perfil público do Instagram.
    Retorna lista de dicts com: id, url, title, description, timestamp, duration.
    """
    _ensure_ytdlp()
    import yt_dlp

    profile_url = f"https://www.instagram.com/{handle.lstrip('@')}/"

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "playlistend": max_videos,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(profile_url, download=False)

    entries = info.get("entries", []) if info else []
    videos = []
    for e in entries:
        if not e:
            continue
        videos.append({
            "instagram_id": e.get("id", ""),
            "url": e.get("url") or e.get("webpage_url") or f"https://www.instagram.com/p/{e.get('id')}/",
            "title": e.get("title", ""),
            "description": e.get("description") or e.get("title", ""),
            "timestamp": e.get("timestamp"),
            "duration": e.get("duration"),
        })
    return videos


def download_video(instagram_url: str, output_dir: Path) -> Path:
    """
    Baixa um vídeo do Instagram para output_dir.
    Retorna o caminho do arquivo baixado.
    """
    _ensure_ytdlp()
    import yt_dlp

    output_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(output_dir / "%(id)s.%(ext)s")

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "outtmpl": output_template,
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(instagram_url, download=True)
        filename = ydl.prepare_filename(info)

    path = Path(filename)
    if not path.exists():
        path = path.with_suffix(".mp4")
    return path


def caption_to_youtube_title(caption: str, max_len: int = 80) -> str:
    """Converte a legenda do Instagram em título para o YouTube."""
    first_line = caption.strip().split("\n")[0].strip()
    # Remove hashtags e emojis do título
    import re
    clean = re.sub(r"#\w+", "", first_line).strip()
    clean = re.sub(r"\s+", " ", clean).strip()
    if not clean:
        clean = first_line[:max_len]
    return clean[:max_len] if len(clean) > max_len else clean


def build_youtube_description(caption: str, instagram_url: str) -> str:
    """Monta descrição do YouTube a partir da legenda do Instagram."""
    desc = caption.strip()
    desc += f"\n\n📸 Original no Instagram: {instagram_url}"
    return desc
