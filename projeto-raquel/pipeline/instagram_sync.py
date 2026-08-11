"""
Baixa vídeos públicos do Instagram e prepara para upload no YouTube.
Usa yt-dlp via subprocess — evita problemas de import da API Python.
"""
import json
import re
import subprocess
import sys
from pathlib import Path


def _ytdlp_cmd() -> list[str]:
    """Retorna o comando yt-dlp disponível no sistema."""
    for cmd in ["yt-dlp", "yt_dlp", sys.executable + " -m yt_dlp"]:
        try:
            subprocess.run(cmd.split() + ["--version"], capture_output=True, check=True)
            return cmd.split()
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue
    # Fallback: instalar e usar via python -m
    subprocess.check_call([sys.executable, "-m", "pip", "install", "yt-dlp", "-q"])
    return [sys.executable, "-m", "yt_dlp"]


def fetch_profile_videos(handle: str, max_videos: int = None) -> list[dict]:
    """
    Busca metadados dos vídeos de um perfil público do Instagram.
    max_videos=None busca todos. Retorna lista de dicts com id, url, title, description.
    """
    profile_url = f"https://www.instagram.com/{handle.lstrip('@')}/"
    cmd = _ytdlp_cmd()

    args = cmd + [
        "--flat-playlist",
        "--dump-single-json",
        "--no-warnings",
        "--quiet",
        profile_url,
    ]
    if max_videos is not None:
        args += ["--playlist-end", str(max_videos)]

    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp erro: {result.stderr[:300]}")

    info = json.loads(result.stdout)
    entries = info.get("entries", [])

    videos = []
    for e in (entries or []):
        if not e:
            continue
        ig_id = e.get("id", "")
        url = e.get("url") or e.get("webpage_url") or f"https://www.instagram.com/p/{ig_id}/"
        videos.append({
            "instagram_id": ig_id,
            "url": url,
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
    output_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(output_dir / "%(id)s.%(ext)s")
    cmd = _ytdlp_cmd()

    args = cmd + [
        "--no-warnings",
        "--quiet",
        "-o", output_template,
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "--print", "after_move:filepath",
        instagram_url,
    ]

    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp download erro: {result.stderr[:300]}")

    filepath = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""
    if filepath and Path(filepath).exists():
        return Path(filepath)

    # Fallback: encontrar o arquivo pelo ID na pasta
    ig_id = instagram_url.rstrip("/").split("/")[-1]
    matches = list(output_dir.glob(f"{ig_id}.*"))
    if matches:
        return matches[0]

    raise FileNotFoundError(f"Arquivo baixado não encontrado em {output_dir}")


def caption_to_youtube_title(caption: str, max_len: int = 80) -> str:
    """Converte a legenda do Instagram em título para o YouTube."""
    first_line = caption.strip().split("\n")[0].strip()
    clean = re.sub(r"#\w+", "", first_line).strip()
    clean = re.sub(r"\s+", " ", clean).strip()
    if not clean:
        clean = first_line
    return clean[:max_len]


def build_youtube_description(caption: str, instagram_url: str) -> str:
    """Monta descrição do YouTube a partir da legenda do Instagram."""
    desc = caption.strip()
    desc += f"\n\n📸 Original no Instagram: {instagram_url}"
    return desc
