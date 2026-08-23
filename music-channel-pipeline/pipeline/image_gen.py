import base64
import os
import requests
import replicate
from pathlib import Path

# O cabelo precisa ser descrito ATE a testa. Sem isso o Flux inventa franja —
# aconteceu no Rio de 21/08/2026 e descaracterizou a DJ.
DJ_BASE = (
    "same character always: stunning beautiful female DJ, "
    "long straight silky platinum silver blonde hair, "
    "hair parted in the middle and swept back away from the face, "
    "forehead fully visible, no bangs, no fringe across the forehead, "
    "piercing vivid blue eyes, sexy smiling expression, "
    "athletic toned fit body, large detailed flower tattoos on both arms and shoulders, "
    "warm olive skin, high cheekbones, full lips, revealing fitted black outfit"
)


def _build_prompt(theme: dict, composition_desc: str, is_night: bool) -> str:
    sunglasses = "no sunglasses showing blue eyes" if is_night else "wearing black sunglasses"
    lighting = (
        "dramatic nighttime with warm golden artificial lights and city glow"
        if is_night
        else "bright golden hour magic light warm afternoon sun"
    )
    return (
        f"RAW photo, professional event photography, candid documentary style, "
        f"{DJ_BASE}, {sunglasses}, "
        f"{composition_desc}, "
        f"hands on Pioneer CDJ-3000 turntables, "
        f"{theme['party_style']} in {theme['location']}, "
        f"{theme['landmark']} visible in background, "
        f"{theme['sea']}, "
        f"elegant partygoers with champagne glasses clearly visible in focus behind her, "
        f"lively crowd atmosphere, {lighting}, "
        f"Sony A7R IV 35mm f/8, everything razor sharp foreground and background, "
        f"deep depth of field, buildings sea crowd all in crisp focus, "
        f"warm cinematic color grade, Kodak Portra 400 film emulation, "
        f"award-winning editorial event photography, hyperrealistic, no watermark"
    )


def _save_output(output, path: Path):
    if hasattr(output, "read"):
        path.write_bytes(output.read())
    elif hasattr(output, "url"):
        path.write_bytes(requests.get(output.url, timeout=60).content)
    elif isinstance(output, bytes):
        path.write_bytes(output)
    else:
        first = list(output)[0]
        _save_output(first, path)


def generate_thumbnail(
    theme: dict,
    composition_id: str,
    composition_desc: str,
    output_path: Path,
    canonical_face_path: Path,
    model: str,
    safety_tolerance: int,
    prompt_strength: float,
) -> Path:
    is_night = composition_id.startswith("night")
    prompt = _build_prompt(theme, composition_desc, is_night)

    run_input = {
        "prompt": prompt,
        "aspect_ratio": "16:9",
        "output_format": "jpg",
        "output_quality": 95,
        "safety_tolerance": safety_tolerance,
        "prompt_upsampling": True,
    }

    if canonical_face_path.exists():
        with open(canonical_face_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        run_input["image"] = f"data:image/jpeg;base64,{b64}"
        run_input["prompt_strength"] = prompt_strength

    output = replicate.run(model, input=run_input)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _save_output(output, output_path)
    return output_path
