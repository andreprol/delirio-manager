"""
Gera um clipe curto animado a partir do thumbnail, com loop perfeito.

O truque do loop: mandar a MESMA imagem como primeiro e ultimo frame
(`start_image` == `end_image`). O modelo e forcado a criar movimento que
volta ao ponto de partida, entao o clipe emenda consigo mesmo e pode ser
repetido pelas 60 min do video sem corte visivel.

`end_image` so existe no modo pro do Kling v2.1 — em standard nao ha como
fechar o loop. Testado em 2026-08-21: diferenca media entre o primeiro e o
ultimo frame ficou em 1,4/255 (imperceptivel). Seedance rejeita frames
identicos (E006) e Hailuo/Wan nao aceitam ultimo frame.
"""
import logging
import time
from pathlib import Path

import replicate
import requests
from replicate.exceptions import ReplicateError

log = logging.getLogger(__name__)

# Movimento contido: a cena respira e o publico danca, sem coreografia
# marcada. Camera travada é obrigatorio — qualquer movimento de camera
# impede o clipe de voltar ao frame inicial e quebra o loop.
LOOP_MOTION = (
    "The DJ sways gently to the beat behind the decks, subtle head nods, "
    "one hand resting on the mixer, hair moving softly in the breeze. "
    "The crowd in front of the booth dances and raises their hands. "
    "String lights flicker, water shimmers, palm leaves move in the wind. "
    "Locked-off camera, no camera movement, no zoom, no pan, no dolly."
)
LOOP_NEGATIVE = (
    "camera movement, zoom, pan, dolly, morphing face, changing face, "
    "distorted hands, extra limbs, text, watermark, still image, frozen frame"
)

MAX_ATTEMPTS = 5
RATE_LIMIT_BASE_WAIT = 15
CLIP_TIMEOUT_SECONDS = 1200
POLL_INTERVAL_SECONDS = 10


def _save_video(url: str, path: Path):
    path.write_bytes(requests.get(url, timeout=300).content)


def generate_loop_clip(
    thumbnail_path: Path,
    output_path: Path,
    model: str = "kwaivgi/kling-v2.1",
    duration: int = 5,
    mode: str = "pro",
    motion: str = LOOP_MOTION,
) -> Path:
    """Anima o thumbnail num clipe curto que emenda consigo mesmo.

    Sobe a imagem uma vez para a Files API e reusa a mesma URL nos dois
    campos — mandar o binario duas vezes faz alguns modelos recusarem.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(thumbnail_path, "rb") as f:
        image_url = replicate.files.create(f).urls["get"]

    payload = {
        "start_image": image_url,
        "end_image": image_url,
        "prompt": motion,
        "negative_prompt": LOOP_NEGATIVE,
        "duration": duration,
        "mode": mode,
    }

    for attempt in range(MAX_ATTEMPTS):
        try:
            prediction = replicate.predictions.create(model=model, input=payload)
            break
        except ReplicateError as e:
            if "429" in str(e) and attempt < MAX_ATTEMPTS - 1:
                wait = RATE_LIMIT_BASE_WAIT * (2 ** attempt)
                log.warning("Rate limit no clipe, aguardando %ds...", wait)
                time.sleep(wait)
            else:
                raise

    # Polling proprio em vez de replicate.run(): run() segura a conexao ate o
    # modelo terminar e estoura ReadTimeout do httpx quando a fila do Kling
    # demora — a predicao continua rodando e sendo cobrada, mas o pipeline
    # perde a saida. Aconteceu em 22/08/2026 e custou um clipe.
    log.info("Predicao do clipe: %s", prediction.id)
    deadline = time.monotonic() + CLIP_TIMEOUT_SECONDS
    while prediction.status not in ("succeeded", "failed", "canceled"):
        if time.monotonic() > deadline:
            raise TimeoutError(
                f"Clipe nao concluiu em {CLIP_TIMEOUT_SECONDS}s. "
                f"Predicao {prediction.id} pode ainda estar rodando no Replicate."
            )
        time.sleep(POLL_INTERVAL_SECONDS)
        prediction.reload()

    if prediction.status != "succeeded":
        raise RuntimeError(
            f"Clipe {prediction.status}: {prediction.error} (predicao {prediction.id})"
        )

    output = prediction.output
    if isinstance(output, list):
        output = output[0]
    url = output if isinstance(output, str) else str(getattr(output, "url", output))
    _save_video(url, output_path)
    log.info("Clipe de loop gerado: %s", output_path)
    return output_path
