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
#
# v3 → v4 (07/09/2026): André reclamou de 2 problemas nos vídeos de terça-a-
# domingo (modo scenery): (1) imagem de noite misturada com as de dia, (2)
# imagem genérica sem nada a ver com o destino ("uma ponte simples"). Causa:
# SCENES só usava {landmark} em 3 das 30 cenas — o resto era arquétipo de
# praia genérico (píer, cachoeira, dunas) que serve pra qualquer lugar
# tropical e não amarra com o tema. Reescrito pra maioria das cenas
# referenciar {landmark}/{location} e removidas as cenas de noite/escuro
# (mantido nascer/pôr do sol e golden hour — ainda é luz de dia, decisão do
# André). SCENES_LANDMARK não mudou: Eiffel/Coliseu/Burj Khalifa são famosos
# pela iluminação noturna, travar em dia contrariaria o próprio tema.
STYLE_VERSION = 4

# Look comum a todas as cenas.
#
# v1 → v2: "award-winning" saiu. Empurrava o Flux para o registro de print de
# galeria e ele assinava a foto — 2 das 30 do Hawaii vieram com assinatura falsa
# de fotógrafo ("R kaui PHOTOGRAPHY", "MAUAII").
#
# v2 → v3: o acervo inteiro tinha cara de IA (turquesa brilhando, luz perfeita
# demais, cartão-postal). Saíram "hyperrealistic", "cinematic color grade" e
# "Kodak Portra 400" — justamente o que estilizava. O que funcionou num teste
# de 8 imagens foi o oposto: descrever uma foto banal de turista.
#
# Cuidado ao mexer: a variante "authentic travel photograph" testada junto
# parecia igualmente boa e trouxe de volta um "©Mauji Autharkio/USA" no canto.
# Qualquer palavra que sugira autoria profissional convida a assinatura.
STYLE = (
    "authentic amateur travel snapshot, natural lighting, "
    "no filter, no post-processing, true colors, slight atmospheric haze, "
    "ordinary everyday photograph, imperfect casual composition"
)
# Gente gerada por IA em segundo plano é onde aparecem rostos derretidos e
# mãos com seis dedos. O acervo é de paisagem: sem pessoas, ponto.
NEGATIVE = (
    "no people, no person, no crowd, "
    "no text, no watermark, no logo, no signature, no photographer credit, "
    "no copyright notice, no copyright symbol, no date stamp, "
    "no caption, no lettering, no border, no frame"
)

# 30 ângulos, reescritos em 07/09/2026 pra maioria amarrar em {landmark} —
# só variando o enquadramento/hora do dia, nunca o destino. `{location}`,
# `{landmark}` e `{sea}` vêm do tema em config/themes.json. Sem noite/escuro
# (só nascer/pôr do sol e golden hour, que ainda é luz de dia).
SCENES = [
    "{landmark} seen from the beach at sunrise, soft pastel sky, gentle waves washing over the sand",
    "aerial drone view of the coastline near {landmark}, turquoise shallows fading into deep blue water",
    "tall palm trees framing a distant view of {landmark}, warm midday light over {sea}",
    "{landmark} seen from a distance in warm early morning light",
    "dramatic sea cliffs meeting {sea}, white spray from crashing waves, {landmark} visible in the distance",
    "wooden boardwalk leading toward {landmark}, calm water at golden hour",
    "lush tropical vegetation framing a view of {landmark} across the water",
    "top-down aerial view of {sea} meeting the shoreline near {landmark}",
    "panoramic view from a high viewpoint over {location}, {landmark} prominent in the scene",
    "close view of local flora native to {location}, {landmark} softly visible in the background",
    "panoramic view from a high viewpoint over the bay of {location}, {landmark} on the horizon",
    "sailboats and white yachts anchored near {landmark}, {sea} sparkling in the sun",
    "sunbeams filtering through palm fronds, {landmark} framed in the distance",
    "moody dramatic storm clouds over {sea}, {landmark} silhouetted against the sky",
    "empty terrace overlooking {sea} at golden hour, {landmark} visible in the distance",
    "narrow coastal road winding along the cliffs above {sea}, {landmark} in view",
    "close low view of gentle waves rolling onto wet sand near {location}, sky reflected",
    "sweeping view of the coastline at first light, {landmark} emerging through the morning haze",
    "steep green hills dropping into {sea} near {location}, morning mist in the valleys",
    "solitary rock formation standing in {sea} at sunrise, {landmark} visible in the distance",
    "calm shallow lagoon at midday near {landmark}, impossibly clear water, sandy bottom visible",
    "stone terrace with hanging bougainvillea overlooking {location} at golden hour, {landmark} in view",
    "aerial view of the curving shoreline near {landmark}, waves drawing long white lines on the sand",
    "sunset reflected on wet sand at low tide, {landmark} silhouetted in the distance, long shadows",
    "dense tropical foliage and exotic flowers in the foreground, {landmark} visible through the greenery",
    "wide view of {location} from the water, {landmark} rising along the shoreline in warm daylight",
    "{landmark} at golden hour, dramatic side lighting",
    "windswept dunes and beach grass in late afternoon light, {landmark} visible on the horizon",
    "aerial view of rugged rocky terrain meeting {sea} near {landmark}",
    "wide vista at first light, low mist over the water, {landmark} on the horizon",
]

# Catálogos alternativos para temas fora do arquétipo praia/paraíso — usados
# quando `theme["category"]` não é "beach" (default). `{location}`, `{landmark}`
# e `{sea}` continuam vindo do tema, mas em temas de venue o campo `sea` guarda
# uma cláusula de ambiente (ex: "haze de máquina de fumaça sob luz azul"), não
# um corpo d'água — funciona porque é sempre interpolado como frase solta.
SCENES_NIGHTLIFE = [
    "empty tunnel corridor stretching into darkness, dim overhead lighting, {sea}",
    "close view of {landmark}, condensation and worn textures under moody light",
    "wide angle of the venue interior, empty dance floor, colored lights sweeping across the walls",
    "low angle looking up at {landmark}, dramatic shadows and light beams",
    "narrow doorway entrance glowing with colored light spilling into the corridor",
    "empty bar counter, rows of bottles backlit, {sea}",
    "overhead view of an empty dance floor, geometric light patterns projected on the ground",
    "steam and fog drifting low across the floor, laser beams cutting through the haze",
    "close detail of exposed pipework and worn brick texture, dim colored uplighting",
    "wide shot of {location} at night, glowing signage reflected on wet pavement",
    "empty DJ booth bathed in blue and purple stage light, {sea}",
    "long exposure of light trails through the empty space, motion blur streaks",
    "arched ceiling detail lit from below, dramatic shadow play across the stonework",
    "distant view down a long corridor toward a glowing doorway, {sea}",
    "close view of a worn wooden or metal surface catching a single spotlight",
    "empty stairwell descending into the venue, warm light glowing from below",
    "wide shot of {landmark}, atmospheric haze softening the far corners of the room",
    "detail of a neon sign reflected in a puddle or polished floor, {sea}",
    "empty seating area glowing under low ambient light, textures and shadows in focus",
    "panoramic view of the empty venue from the entrance, {sea}",
]

# Sem noite/escuro desde 07/09/2026 (mesma regra do SCENES de praia) — exceto
# o tema "Amazon Night" (config/themes.json), cujo landmark/sea já descrevem
# escuridão/tocha por definição; forçar dia nesse tema específico geraria
# prompt contraditório. Não há como excluir 1 tema do catálogo compartilhado
# sem lógica nova — sinalizado, não resolvido (ver sessão 07/09/2026).
SCENES_JUNGLE = [
    "dense jungle canopy at dawn, shafts of light breaking through the leaves",
    "{landmark} seen through thick tropical foliage, {sea}",
    "aerial view over the endless rainforest canopy near {landmark}, mist rising at first light",
    "close view of giant tropical leaves and vines near {landmark}, dappled sunlight filtering through",
    "wide view of the river cutting through dense jungle toward {landmark}, {sea}",
    "sunlit jungle clearing near {landmark}, butterflies and dappled light among the trees",
    "moss-covered ancient trees and tangled roots near {landmark}, soft filtered light",
    "distant view of {landmark}, thick humid haze hanging over the canopy",
    "close-up of exotic flowers and foliage near {landmark}, dew drops catching the light",
    "misty jungle valley at first light near {landmark}, layers of green fading into the distance",
    "wide aerial shot of a winding jungle river toward {landmark}, {sea}",
    "silhouette of tall jungle trees near {landmark} against a dramatic sunset sky",
    "hidden jungle clearing bathed in soft golden light, {landmark} visible through the trees, {sea}",
    "close view of water droplets on broad leaves after rain near {landmark}, soft diffused light",
    "sunlight breaking through a gap in the dense jungle canopy near {landmark}",
]

SCENES_LANDMARK = [
    "{landmark} at golden hour, dramatic warm side lighting",
    "wide panoramic view of {location} skyline with {landmark} prominent",
    "close architectural detail of {landmark}, textures and materials in sharp focus",
    "{landmark} illuminated at night, {sea}",
    "aerial view looking down over {location}, {landmark} visible among the rooftops",
    "low angle looking up at {landmark}, dramatic perspective against the sky",
    "reflection of {landmark} in still water or glass, {sea}",
    "wide shot of the plaza or terrace surrounding {landmark} at dusk",
    "distant view of {landmark} across the skyline, warm haze softening the horizon",
    "close detail of the structure's lighting design at night, glowing accents",
    "empty terrace or rooftop with {landmark} as the backdrop, {sea}",
    "{landmark} seen from below at night, dramatic uplighting",
    "wide establishing shot of {location} at blue hour, {landmark} lit against the darkening sky",
    "silhouette of {landmark} against a vivid sunset sky",
    "panoramic night view of {location}, {landmark} glowing among city lights",
]

# theme["category"] -> catálogo de cenas. "beach" (ou ausente) cai no SCENES
# original — é o default de todo tema antigo, sem precisar tocar em cada um.
CATEGORY_SCENES = {
    "beach": SCENES,
    "nightlife": SCENES_NIGHTLIFE,
    "jungle": SCENES_JUNGLE,
    "landmark": SCENES_LANDMARK,
}

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


def scenes_for(theme: dict) -> list[str]:
    return CATEGORY_SCENES.get(theme.get("category", "beach"), SCENES)


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

    catalog = scenes_for(theme)
    scenes = catalog[:limit] if limit else catalog
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
