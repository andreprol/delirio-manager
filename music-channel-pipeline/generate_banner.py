"""
Gera banner do canal Umbra Sessions via Flux 1.1 Pro.
Saída: F:/Temp/umbra_banner.jpg (escalar para 2048x1152 via ffmpeg)

Requisitos:
  pip install replicate requests pillow python-dotenv
  REPLICATE_API_TOKEN no .env ou variável de ambiente
"""
import os
import base64
import subprocess
import sys
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent / ".env")

TOKEN = os.getenv("REPLICATE_API_TOKEN", "")
if not TOKEN or TOKEN == "your_replicate_token_here":
    sys.exit("❌  Set REPLICATE_API_TOKEN in .env before running.")

os.environ["REPLICATE_API_TOKEN"] = TOKEN

try:
    import replicate
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "replicate", "requests", "pillow", "python-dotenv"], check=True)
    import replicate

CANONICAL = Path(__file__).parent / "config" / "dj_canonical.jpg"
OUT_DIR = Path("F:/Temp")
OUT_DIR.mkdir(parents=True, exist_ok=True)

DJ_BASE = (
    "same character: stunning beautiful female DJ, "
    "long straight silky platinum silver blonde hair, "
    "piercing vivid blue eyes, sexy smiling expression, "
    "athletic toned fit body, large detailed flower tattoos on both arms and shoulders, "
    "revealing black halter top, warm olive skin"
)

PROMPT = (
    f"RAW photo, professional event photography, ultra-wide cinematic shot, "
    f"{DJ_BASE}, "
    "standing at DJ booth center stage, hands on Pioneer CDJ-3000 turntables, "
    "massive open-air nightclub terrace Ibiza, "
    "huge crowd of thousands dancing below the stage visible and in crisp focus, "
    "luxury yachts lit up in harbor background, Mediterranean sea, "
    "dramatic nighttime stage lighting: blue purple amber beams cutting through darkness, "
    "laser show, fog machine, epic atmosphere, "
    "Sony A7R IV 24mm f/8, everything in crisp focus foreground and background, "
    "deep depth of field, cinematic dark color grade, "
    "hyperrealistic award-winning concert photography, no watermark, no text"
)

print("Gerando banner Umbra Sessions (Flux 1.1 Pro)...")

run_input = {
    "prompt": PROMPT,
    "aspect_ratio": "16:9",
    "output_format": "jpg",
    "output_quality": 98,
    "safety_tolerance": 5,
    "prompt_upsampling": True,
}

if CANONICAL.exists():
    img_b64 = base64.b64encode(CANONICAL.read_bytes()).decode()
    run_input["image"] = f"data:image/jpeg;base64,{img_b64}"
    run_input["prompt_strength"] = 0.85
    print("  Usando face canônica como referência.")
else:
    print("  AVISO: dj_canonical.jpg não encontrado — gerando sem referência de rosto.")

out = replicate.run("black-forest-labs/flux-1.1-pro", input=run_input)

raw_path = OUT_DIR / "umbra_banner_raw.jpg"
if hasattr(out, "read"):
    raw_path.write_bytes(out.read())
elif hasattr(out, "url"):
    raw_path.write_bytes(requests.get(out.url, timeout=60).content)
else:
    raw_path.write_bytes(list(out)[0].read())

print(f"  Raw gerado: {raw_path}  ({raw_path.stat().st_size // 1024} KB)")

# Escalar para 2048x1152 (YouTube banner mínimo recomendado)
final_path = OUT_DIR / "umbra_banner_2048x1152.jpg"
cmd = [
    "ffmpeg", "-y",
    "-i", str(raw_path),
    "-vf", "scale=2048:1152:force_original_aspect_ratio=increase,crop=2048:1152",
    "-q:v", "2",
    str(final_path),
]
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode != 0:
    print(f"  ffmpeg erro: {r.stderr[-200:]}")
    print(f"  Use o raw diretamente: {raw_path}")
else:
    print(f"  Banner final 2048x1152: {final_path}")

print()
print("✅ Pronto! Faça upload em:")
print("   YouTube Studio > Personalização > Imagem do banner > Enviar")
print(f"   Arquivo: {final_path if r.returncode == 0 else raw_path}")
