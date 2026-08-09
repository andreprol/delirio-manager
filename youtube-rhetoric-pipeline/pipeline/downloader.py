from pathlib import Path
import yt_dlp


def download_video(video_id: str, output_dir: str) -> Path:
    url = f"https://www.youtube.com/watch?v={video_id}"
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    ydl_opts = {
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]",
        "outtmpl": str(out / f"{video_id}.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "match_filter": yt_dlp.utils.match_filter_func("duration <= 1800"),
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
            return Path(filename)
    except Exception as e:
        raise RuntimeError(f"Download failed for {video_id}: {e}") from e
