"""Gera e guarda em disco o acervo de imagens paradisíacas de cada local.

Substitui o avatar animado do Kling como fundo do vídeo (decisão de 29/08/2026:
o movimento da DJ ficou ruim). Aqui não entra a DJ — o rosto canônico continua
existindo só na thumbnail, que é o que aparece na busca do YouTube.

Duas regras que valem dinheiro:

- **As imagens são pagas e ficam fora de `data/temp/`.** `data/scenery/<tema>/`
  é acervo permanente: gera uma vez por local (~$1,80) e todas as rotações
  futuras reusam. Nada aqui pode ser apagado por rotina de limpeza.
- **Retomada é obrigatória.** Se o lote de 30 quebrar na imagem 22, rodar de
  novo só paga as 8 que faltam. Arquivo que já existe nunca é regerado.
"""
import json
import logging
import time
from pathlib import Path

import replicate
import requests
from replicate.exceptions import ReplicateError

log = logging.getLogger(__name__)

SCENERY_ROOT = Path("data/scenery")
MANIFEST_NAME = "manifest.json"
SEGMENT_NAME = "loop_segment.mp4"

MAX_ATTEMPTS = 5
RATE_LIMIT_BASE_WAIT = 15
# O Replicate derruba o rate limit para 1 request/burst quando o saldo cai
# abaixo de $5. A pausa entre imagens é o que impede o lote de virar 429 em
# cascata quando a recarga automática ainda não entrou.
SLEEP_BETWEEN_IMAGES = 12

# Sobe a cada mudança em STYLE/NEGATIVE/SCENES. Fica gravado por imagem no
# manifesto, que é o único jeito de saber depois quais arquivos de um acervo
# misto vieram de qual versão do prompt.
STYLE_VERSION = 2

# Look comum a todas as cenas — o mesmo grade quente/cinematográfico das
# thumbnails, para o acervo não destoar da identidade do canal.
#
# "award-winning" saiu na v2: empurrava o Flux para o registro de print de
# galeria e ele assinava a foto. Duas das 30 do Hawaii vieram com assinatura
# falsa de fotógrafo ("R kaui PHOTOGRAPHY" e "MAUAII") — num canal monetizado
# isso passa a impressão de banco de imagens pirateado.
STYLE = (
    "RAW photo, professional travel photography, hyperrealistic, "
    "warm cinematic color grade, Kodak Portra 400 film emulation, "
    "razor sharp, deep depth of field, natural unedited landscape photograph"
)
# Gente gerada por IA em segundo plano é onde aparecem rostos derretidos e
# mãos com seis dedos. O acervo é de paisagem: sem pessoas, ponto.
NEGATIVE = (
    "no people, no person, no crowd, "
    "no text, no watermark, no logo, no signature, no photographer credit, "
    "no caption, no lettering, no border, no frame"
)

# 30 ângulos. `{location}`, `{landmark}` e `{sea}` vêm do tema em
# config/themes.json, então o mesmo catálogo serve os 12 destinos.
SCENES = [
    "empty beach at sunrise, soft pastel sky, gentle waves washing over golden sand",
    "aerial drone view of the coastline, turquoise shallows fading into deep blue water",
    "tall palm trees silhouetted against a burning orange sunset over {sea}",
    "{landmark} seen from a distance in warm early morning light",
    "dramatic sea cliffs meeting the water, white spray from crashing waves",
    "long wooden pier stretching out over calm water at golden hour",
    "lush tropical vegetation framing a hidden cove with clear water",
    "top-down overhead view of turquoise water meeting white sand, natural patterns",
    "blue hour after sunset, first stars appearing, calm sea, distant warm lights",
    "tropical waterfall falling into a natural pool surrounded by green foliage",
    "panoramic view from a high viewpoint over the bay of {location}",
    "sailboats and white yachts anchored in a sheltered turquoise bay",
    "sunbeams filtering through palm fronds, dappled light on warm sand",
    "moody dramatic storm clouds over {sea}, shafts of light breaking through",
    "empty infinity pool terrace overlooking {sea} at dusk, glowing water",
    "narrow coastal road winding along the cliffs high above the water",
    "close low view of gentle waves rolling onto wet sand, sky reflected",
    "night sky full of stars and the milky way over the dark ocean",
    "steep green hills dropping into {sea}, morning mist in the valleys",
    "solitary rock formation standing in the water at sunset, dark silhouette",
    "calm shallow lagoon at midday, impossibly clear water, sandy bottom visible",
    "stone terrace with hanging bougainvillea overlooking the coastline at golden hour",
    "aerial view of the curving shoreline, waves drawing long white lines on the sand",
    "sunset reflected on wet sand at low tide, mirror effect, long shadows",
    "dense tropical foliage and exotic flowers in the foreground, {sea} behind",
    "distant town lights glowing warm along the dark shore at night",
    "{landmark} at golden hour, dramatic side lighting",
    "windswept dunes and beach grass in late afternoon light",
    "aerial view of rugged rocky terrain meeting brilliant turquoise water",
    "wide vista at first light, low mist over the water, {landmark} on the horizon",
]

SCENERY_COUNT = len(SCENES)


def scenery_dir(theme_id: str) -> Path:
    return SCENERY_ROOT / theme_id


def segment_path(theme_id: str) -> Path:
    return scenery_dir(theme_id) / SEGMENT_NAME


def ensure_segment(theme: dict, images: list[Path], force: bool = False) -> Path:
    """Garante o segmento de loop do tema em disco e devolve o caminho.

    Fica junto das imagens porque é acervo pela mesma razão: montar custa
    minutos de ffmpeg e o resultado é idêntico toda vez. O slot das 10:00 só
    encontra pronto.
    """
    # Import local: `slideshow` é ffmpeg puro e não conhece temas nem pastas.
    # A dependência é de mão única (acervo → renderizador) e fica explícita aqui.
    from pipeline.slideshow import build_loop_segment, measure_loop_seam

    out = segment_path(theme["id"])
    if out.exists() and out.stat().st_size > 0 and not force:
        log.info("[%s] segmento já existe: %s", theme["id"], out)
        return out

    # Montar em .part e só então renomear. Uma montagem interrompida no meio da
    # escrita deixaria um mp4 truncado — não-vazio, portanto aceito para sempre
    # pela checagem acima, e o vídeo do dia sairia com um fundo cortado.
    work = scenery_dir(theme["id"]) / "_slides"
    partial = out.with_suffix(".part.mp4")
    build_loop_segment(images, partial, work_dir=work)
    log.info("[%s] emenda do loop: %.2f/255", theme["id"], measure_loop_seam(partial, work))
    partial.replace(out)

    # Os slides intermediários somam centenas de MB e não servem para mais nada
    # depois do segmento montado. As imagens, que são o que custou dinheiro,
    # ficam.
    for leftover in work.glob("*"):
        leftover.unlink()
    work.rmdir()
    return out


def _build_prompt(theme: dict, scene: str) -> str:
    scene = scene.format(
        location=theme["location"],
        landmark=theme["landmark"],
        sea=theme["sea"],
    )
    return f"{STYLE}, {scene}, {theme['location']}, {NEGATIVE}"


def _download(url: str, path: Path):
    # Escrever em .part e só então renomear: um download cortado no meio não
    # pode deixar um JPEG truncado que a retomada aceita como "já existe".
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(requests.get(url, timeout=120).content)
    tmp.replace(path)


def _extract_url(output) -> str:
    if isinstance(output, list):
        output = output[0]
    if isinstance(output, str):
        return output
    url = getattr(output, "url", None)
    if url:
        return url
    raise RuntimeError(f"Saída do modelo em formato inesperado: {type(output)!r}")


def _generate_one(model: str, prompt: str, aspect_ratio: str,
                  safety_tolerance: int, raw: bool, path: Path):
    payload = {
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "output_format": "jpg",
        "safety_tolerance": safety_tolerance,
    }
    if raw:
        payload["raw"] = True

    for attempt in range(MAX_ATTEMPTS):
        try:
            output = replicate.run(model, input=payload)
            break
        except ReplicateError as e:
            if "429" in str(e) and attempt < MAX_ATTEMPTS - 1:
                wait = RATE_LIMIT_BASE_WAIT * (2 ** attempt)
                log.warning("Rate limit na imagem, aguardando %ds...", wait)
                time.sleep(wait)
            else:
                raise
    else:
        raise RuntimeError("Esgotou as tentativas de gerar a imagem.")

    _download(_extract_url(output), path)


def ensure_scenery(
    theme: dict,
    model: str = "black-forest-labs/flux-1.1-pro-ultra",
    aspect_ratio: str = "16:9",
    safety_tolerance: int = 2,
    raw: bool = True,
    limit: int = None,
) -> list[Path]:
    """Garante as 30 imagens do tema em disco e devolve os caminhos em ordem.

    Só paga pelo que falta. Devolver a lista em ordem estável é o que faz o
    slideshow ser reproduzível — a emenda do loop depende de a imagem 01 ser
    sempre a mesma.
    """
    out_dir = scenery_dir(theme["id"])
    out_dir.mkdir(parents=True, exist_ok=True)

    scenes = SCENES[:limit] if limit else SCENES
    paths, generated = [], 0

    for idx, scene in enumerate(scenes, start=1):
        path = out_dir / f"{idx:02d}.jpg"
        paths.append(path)
        if path.exists() and path.stat().st_size > 0:
            continue

        if generated:
            time.sleep(SLEEP_BETWEEN_IMAGES)
        prompt = _build_prompt(theme, scene)
        log.info("[%s] imagem %02d/%d — gerando...", theme["id"], idx, len(scenes))
        _generate_one(model, prompt, aspect_ratio, safety_tolerance, raw, path)
        # Gravar o manifesto por imagem, e não em lote no fim: um lote que
        # quebra na 22 tem que deixar registrado o que as 21 anteriores usaram.
        _record_in_manifest(out_dir, theme, path.name, prompt, model)
        generated += 1

    log.info("[%s] acervo pronto: %d imagens (%d novas nesta execução)",
             theme["id"], len(paths), generated)
    return paths


def _record_in_manifest(out_dir: Path, theme: dict, filename: str,
                        prompt: str, model: str):
    """Anota prompt, modelo e versão de estilo da imagem recém-gerada.

    Lê-altera-grava em vez de reescrever tudo. Um acervo pode ser misto — no
    Hawaii, 28 imagens da v1 e 2 refeitas na v2 — e um manifesto regravado
    inteiro afirmaria que as 30 vieram do prompt atual. Documento que mente
    sobre o que está em disco é pior que documento nenhum.
    """
    path = out_dir / MANIFEST_NAME
    if path.exists():
        manifest = json.loads(path.read_text(encoding="utf-8"))
    else:
        manifest = {"theme_id": theme["id"], "theme_name": theme["name"],
                    "images": {}}

    # Manifesto v1 guardava só a string do prompt por imagem. Converter para o
    # formato atual marcando `style_version: 1` — que é o que essas imagens
    # realmente são. Sem isto o arquivo fica com dois formatos misturados e
    # quebra quem for lê-lo.
    legacy_model = manifest.pop("model", None)
    for name, value in list(manifest["images"].items()):
        if isinstance(value, str):
            manifest["images"][name] = {
                "prompt": value, "model": legacy_model, "style_version": 1,
            }

    manifest["images"][filename] = {
        "prompt": prompt,
        "model": model,
        "style_version": STYLE_VERSION,
    }
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                    encoding="utf-8")
