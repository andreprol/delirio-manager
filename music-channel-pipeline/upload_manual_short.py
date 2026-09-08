"""Upload manual e pontual de um Short cortado fora do pipeline principal.

Uso único: F:\\Temp\\short_back_v2_hooktest.mp4 (hook variation do ângulo
"de trás" do Saint-Tropez, 08/09/2026). Não é parte do fluxo automatizado —
por isso um script solto em vez de um comando em main.py.
"""
import logging
from pipeline.uploader import upload_video

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

TITLE = "Saint-Tropez After Dark \U0001F30A #Shorts"
DESCRIPTION = (
    "\U0001F30A Saint-Tropez France vibes \u2014 Dark Tech House.\n"
    "Catch the full 1-hour DJ set on Umbra Sessions.\n\n"
    "\U0001F3A7 AI-generated Dark Tech House mix\n"
    "\U0001F4CD Saint-Tropez\n\n"
    "#Shorts #DarkTechHouse #Sttropez #TechHouse #ElectronicMusic"
)
TAGS = [
    "dark tech house", "tech house", "electronic music", "dj set",
    "saint-tropez", "saint-tropez mix", "beach party", "sunset mix",
    "ai music", "underground techno", "techno music", "house music",
    "dj mix", "party mix", "dance music", "driving techno",
    "hypnotic techno", "melodic techno", "deep house", "club music",
    "afterhours", "ibiza", "techno 2026", "dark techno", "shorts",
]

video_id, thumb_error = upload_video(
    file_path=r"F:\Temp\short_back_v2_hooktest.mp4",
    title=TITLE,
    description=DESCRIPTION,
    tags=TAGS,
    secrets_file="config/client_secrets.json",
    thumbnail_path=None,
)

print(f"Uploaded: https://youtube.com/watch?v={video_id}")
if thumb_error:
    print(f"Thumbnail: {thumb_error}")
