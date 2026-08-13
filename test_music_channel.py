"""
Teste do canal de música Dark Tech House.
Gera: thumbnail DJ paradisíaca via Replicate (Flux Schnell) + vídeo 30s de amostra.
Resultado em F:\\Temp\\music_channel_test\\
"""
import os
import subprocess
import sys
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(dotenv_path="F:/RichClub/music-channel-pipeline/.env")
REPLICATE_API_TOKEN = os.getenv("REPLICATE_API_TOKEN", "")
OUTPUT_DIR = Path("F:/Temp/music_channel_test")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

os.environ["REPLICATE_API_TOKEN"] = REPLICATE_API_TOKEN

try:
    import replicate
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "replicate", "requests"], check=True)
    import replicate

THEME = "Ibiza Day — Composição Frente"

DJ_BASE = (
    "same character: stunning beautiful female DJ, "
    "long straight silky platinum silver blonde hair, "
    "piercing vivid blue eyes, sexy smiling expression, "
    "athletic toned fit body, large detailed flower tattoos on both arms and shoulders, "
    "warm olive skin, high cheekbones, full lips"
)

PROMPT = (
    f"RAW photo, professional event photography, {DJ_BASE}, "
    "facing camera direct eye contact smiling, "
    "wearing black sunglasses (daytime outdoor), "
    "revealing fitted black halter top, "
    "hands on Pioneer CDJ-3000 turntables, "
    "luxury open-air beach club terrace Ibiza Spain, "
    "Dalt Vila fortress and white cliffs visible in background, "
    "turquoise Mediterranean sea, harbor yachts, "
    "elegant partygoers with champagne glasses clearly visible in focus behind her, "
    "bright golden afternoon sun, warm light, "
    "Sony A7R IV 35mm f/8, everything sharp foreground and background, "
    "deep depth of field, all background crisp and clear, "
    "warm cinematic color grade, hyperrealistic, no watermark"
)

print(f"[1/3] Gerando imagem — tema: {THEME}")
print(f"      Modelo: flux-1.1-pro (~$0.04)")
print(f"      Prompt: {PROMPT[:80]}...")

import time

VARIANTS = 2
outputs = []
for i in range(VARIANTS):
    if i > 0:
        print(f"      Aguardando 12s (rate limit)...")
        time.sleep(12)
    print(f"      Gerando variante {i+1}/{VARIANTS}...")
    import base64
    canonical_path = OUTPUT_DIR / "dj_canonical_face.jpg"
    img_input = None
    if canonical_path.exists():
        with open(canonical_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode()
        img_input = f"data:image/jpeg;base64,{img_b64}"

    run_input = {
        "prompt": PROMPT,
        "aspect_ratio": "16:9",
        "output_format": "jpg",
        "output_quality": 95,
        "safety_tolerance": 5,
        "prompt_upsampling": True,
    }
    if img_input:
        run_input["image"] = img_input
        run_input["prompt_strength"] = 0.85

    out = replicate.run("black-forest-labs/flux-1.1-pro", input=run_input)
    outputs.append(out)
output = outputs[0]

def save_output(out, path):
    if hasattr(out, "read"):
        path.write_bytes(out.read())
    elif hasattr(out, "url"):
        path.write_bytes(requests.get(out.url, timeout=60).content)
    elif isinstance(out, bytes):
        path.write_bytes(out)
    else:
        first = list(out)[0]
        save_output(first, path)

saved_paths = []
for i, out in enumerate(outputs):
    p = OUTPUT_DIR / f"thumbnail_v{i+1}.jpg"
    save_output(out, p)
    print(f"      Variante {i+1}: {p}  ({p.stat().st_size//1024} KB)")
    saved_paths.append(p)

# Salva face canônica separada para uso como referência futura
canonical = OUTPUT_DIR / "dj_canonical_face.jpg"
import shutil
shutil.copy(saved_paths[0], canonical)
print(f"      Face canônica salva: {canonical}")

img_path = saved_paths[0]

print("[2/3] Montando vídeo 30s com ffmpeg...")
video_path = OUTPUT_DIR / "test_video.mp4"
cmd = [
    "ffmpeg", "-y",
    "-loop", "1", "-framerate", "1",
    "-i", str(img_path),
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "30",
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
    "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-shortest",
    str(video_path),
]
result = subprocess.run(cmd, capture_output=True, text=True)
if result.returncode != 0:
    print(f"      ffmpeg erro: {result.stderr[-300:]}")
    sys.exit(1)
print(f"      Salvo: {video_path}")

print("[3/3] Concluído!")
print()
print(f"  Thumbnails: {[str(p) for p in saved_paths]}")
print(f"  Vídeo 30s : {video_path}")
print()
print("Abra o thumbnail e avalie: qualidade da DJ, paisagem, estética Dark Tech House.")
