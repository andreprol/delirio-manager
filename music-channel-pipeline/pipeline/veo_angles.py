"""
Gera o video de 5 angulos (Veo 3.1 Fast) com ping-pong + zoom + flash --
modo caro do canal (~$6+/video), reservado pra segunda-feira. Ver
[[project-umbra-sessions]] secoes "Analise competitiva" e "Cadencia semanal".

Cada angulo e um clipe curto (8s, teto da API do Veo -- enum 4/6/8, sem
opcao maior) animado como loop perfeito (mesmo truque start==last_frame do
Kling em clip_gen.py). Ping-pong (toca pra frente e em reverso) fecha a
emenda matematicamente -- e o mesmo frame nas duas pontas, nao depende do
modelo acertar. Zoom sobe no forward e desce no reverse (respiracao),
supersample 2x pra zoom lento nao "pipocar". Flash branco mascara a troca
de angulo, inclusive na volta do ultimo angulo pro primeiro (sequencia
circular, pra repetir a hora toda sem corte seco).
"""
import base64
import subprocess
import time
from pathlib import Path

import httpx
import replicate
import requests
from replicate.exceptions import ReplicateError

from pipeline.image_gen import _build_prompt as _build_thumb_prompt
from pipeline.image_gen import _save_output
from pipeline.clip_gen import LOOP_MOTION, LOOP_NEGATIVE

# 5 angulos da mesma cena -- front leva o dobro de destaque dos outros
# (decisao de Andre, 06/09/2026): 19 ciclos ping-pong (~5:03) contra 8 dos
# demais (~2:08 cada). Uma volta pelos 5 = ~13:34.
ANGLES = [
    {"id": "front", "desc": "facing camera, direct eye contact, smiling seductively, no sunglasses", "cycles": 19},
    {"id": "side", "desc": "elegant side profile, city lights reflected in eyes, no sunglasses", "cycles": 8},
    {"id": "back", "desc": "shot from behind, crowd and glowing night skyline ahead, no sunglasses", "cycles": 8},
    {"id": "wide", "desc": "wide shot from the crowd, DJ small and centered behind the decks, dancing silhouettes filling the foreground, no sunglasses", "cycles": 8},
    {"id": "low", "desc": "low angle close-up from just below deck height, dramatic uplighting on her face, skyline glowing behind her, hair fully swept back off the forehead, no sunglasses", "cycles": 8},
]

VEO_MODEL = "google/veo-3.1-fast"
VEO_DURATION = 8
ZOOM_PCT = 0.06
FLASH_SECONDS = 0.25
FPS = 24
SEED = 4200  # fixo -- mesma semente em todos os 5 angulos mantem cenario parecido

# Descricoes mais especificas que o themes.json generico -- evita o Flux
# reinventar o cenario a cada um dos 5 angulos (testado em 06/09/2026 com
# Phuket: landmark generico fez o cenario variar demais entre angulos).
# So precisa de entrada pros temas ja usados neste modo caro; tema sem
# entrada aqui usa o landmark/sea do themes.json mesmo.
LANDMARK_OVERRIDES = {
    "cabo": {
        "landmark": "El Arco de Cabo San Lucas rock arch clearly visible in "
                    "the distance, red desert rock formations",
        "sea": "deep blue Pacific ocean with waves crashing against the cliffs",
    },
}

VEO_MAX_ATTEMPTS = 5
VEO_RATE_LIMIT_BASE_WAIT = 15
# Alinhado com CLIP_TIMEOUT_SECONDS do Kling em clip_gen.py -- Veo 3.1 em
# 1080p e comparavelmente pesado, 300s era curto demais e abortava geracoes
# saudaveis so lentas.
VEO_CLIP_TIMEOUT_SECONDS = 1200
VEO_POLL_INTERVAL_SECONDS = 10


def _ffprobe_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def _probe_frames(path: Path) -> int:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of",
         "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return int(result.stdout.strip())


def _create_and_poll(predictions_ns, model: str, payload: dict, label: str,
                      max_attempts: int = 5, rate_limit_wait: int = 15,
                      timeout_seconds: int = 1200, poll_interval: int = 10):
    """Cria a predicao e espera terminar. Retry em 429 na criacao (padrao
    de clip_gen.py) E em erro de transporte durante o polling -- um
    httpx.ReadError no meio do polling ja derrubou uma geracao inteira
    neste modulo (06/09/2026, clipe 'low') sem cobertura nenhuma antes
    disso existir."""
    prediction = None
    for attempt in range(max_attempts):
        try:
            prediction = predictions_ns.create(model=model, input=payload)
            break
        except ReplicateError as e:
            if "429" in str(e) and attempt < max_attempts - 1:
                time.sleep(rate_limit_wait * (2 ** attempt))
            else:
                raise

    deadline = time.monotonic() + timeout_seconds
    while prediction.status not in ("succeeded", "failed", "canceled"):
        if time.monotonic() > deadline:
            raise TimeoutError(
                f"{label} nao concluiu em {timeout_seconds}s (predicao {prediction.id})")
        time.sleep(poll_interval)
        for attempt in range(max_attempts):
            try:
                prediction.reload()
                break
            except (httpx.TransportError, httpx.HTTPError) as e:
                if attempt < max_attempts - 1:
                    time.sleep(rate_limit_wait * (2 ** attempt))
                else:
                    raise RuntimeError(
                        f"{label}: erro de rede persistente no polling "
                        f"(predicao {prediction.id}): {e}")

    if prediction.status != "succeeded":
        raise RuntimeError(
            f"{label} {prediction.status}: {prediction.error} (predicao {prediction.id})")
    return prediction


def _download(url: str, out_path: Path, label: str,
               max_attempts: int = 3, timeout: int = 300) -> Path:
    last_exc = None
    for attempt in range(max_attempts):
        try:
            resp = requests.get(url, timeout=timeout)
            resp.raise_for_status()
            out_path.write_bytes(resp.content)
            return out_path
        except (requests.RequestException, httpx.TransportError) as e:
            last_exc = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"{label}: falha ao baixar apos {max_attempts} tentativas: {last_exc}")


def generate_angle_images(theme: dict, canonical_face_path: Path, output_dir: Path,
                           client: "replicate.Client",
                           model: str = "black-forest-labs/flux-1.1-pro",
                           safety_tolerance: int = 5,
                           prompt_strength: float = 0.85) -> dict[str, Path]:
    """Gera as 5 imagens-base (Flux), uma por angulo, com seed fixo pra
    manter o cenario parecido entre elas (mesma cena, camera diferente).
    `theme` deve ter landmark/sea especificos o bastante pra nao deixar o
    Flux reinventar o cenario a cada chamada -- testado em 06/09/2026 com
    Phuket: descricao generica do themes.json faz o cenario variar demais
    entre angulos.

    Pula angulo cujo arquivo ja existe (idempotente) -- um retry apos
    falha parcial (ja aconteceu) nao deve repagar o que ja funcionou."""
    output_dir.mkdir(parents=True, exist_ok=True)
    with open(canonical_face_path, "rb") as f:
        face_data_uri = f"data:image/jpeg;base64,{base64.b64encode(f.read()).decode()}"

    images = {}
    for angle in ANGLES:
        aid = angle["id"]
        img_path = output_dir / f"{aid}.jpg"
        if img_path.exists():
            images[aid] = img_path
            continue

        prompt = _build_thumb_prompt(theme, angle["desc"], is_night=True)
        payload = {
            "prompt": prompt, "aspect_ratio": "16:9", "output_format": "jpg",
            "output_quality": 95, "safety_tolerance": safety_tolerance,
            "prompt_upsampling": True, "image": face_data_uri,
            "prompt_strength": prompt_strength, "seed": SEED,
        }
        # create+poll, nao replicate.run() -- run() segura a conexao ate o
        # modelo terminar e ja estourou ReadTimeout neste projeto com
        # prompt_upsampling=True (mais lento), ver clip_gen.py:88-91.
        prediction = _create_and_poll(
            client.predictions, model, payload, label=f"Imagem {aid}",
            max_attempts=3, timeout_seconds=180, poll_interval=5)
        output = prediction.output
        url = output[0] if isinstance(output, list) else \
            (output if isinstance(output, str) else str(getattr(output, "url", output)))
        _download(url, img_path, label=f"Imagem {aid}")
        images[aid] = img_path
    return images


def generate_angle_clips(images: dict[str, Path], output_dir: Path,
                          client: "replicate.Client") -> dict[str, Path]:
    """Gera 1 clipe Veo por angulo -- loop perfeito via image==last_frame,
    mesmo truque de clip_gen.py. Pula angulo cujo arquivo ja existe
    (idempotente) -- mesma razao de generate_angle_images."""
    output_dir.mkdir(parents=True, exist_ok=True)
    clips = {}
    for angle in ANGLES:
        aid = angle["id"]
        out_path = output_dir / f"{aid}.mp4"
        if out_path.exists():
            clips[aid] = out_path
            continue

        with open(images[aid], "rb") as f:
            image_url = client.files.create(f).urls["get"]

        payload = {
            "image": image_url, "last_frame": image_url,
            "prompt": LOOP_MOTION, "negative_prompt": LOOP_NEGATIVE,
            "duration": VEO_DURATION, "resolution": "1080p",
            "aspect_ratio": "16:9", "generate_audio": False,
        }
        prediction = _create_and_poll(
            client.predictions, VEO_MODEL, payload, label=f"Clipe {aid}",
            max_attempts=VEO_MAX_ATTEMPTS, rate_limit_wait=VEO_RATE_LIMIT_BASE_WAIT,
            timeout_seconds=VEO_CLIP_TIMEOUT_SECONDS, poll_interval=VEO_POLL_INTERVAL_SECONDS)
        output = prediction.output
        url = output if isinstance(output, str) else str(getattr(output, "url", output))
        _download(url, out_path, label=f"Clipe {aid}")
        clips[aid] = out_path
    return clips


def build_pingpong(clip_path: Path, output: Path,
                    zoom_pct: float = ZOOM_PCT, fps: int = FPS) -> Path:
    """Toca o clipe pra frente e em reverso -- fecha o loop matematicamente
    (mesmo frame nas duas pontas). Zoom sobe no forward, desce no reverse
    (respiracao), supersample 2x pra zoom lento nao 'pipocar'."""
    n = _probe_frames(clip_path)
    if n < 2:
        raise ValueError(f"Clipe {clip_path} tem so {n} frame(s), nao da pra fazer ping-pong")
    fwd_zoom = output.parent / f"{output.stem}_fwd.mp4"
    rev = output.parent / f"{output.stem}_rev.mp4"
    rev_zoom = output.parent / f"{output.stem}_revz.mp4"
    concat_file = output.parent / f"{output.stem}_list.txt"

    try:
        zoom_in = f"1+{zoom_pct}*on/{n - 1}"
        subprocess.run([
            "ffmpeg", "-y", "-i", str(clip_path), "-vf",
            f"scale=3840:2160,zoompan=z='{zoom_in}':d=1:"
            f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps={fps}",
            "-an", str(fwd_zoom),
        ], check=True, capture_output=True)

        subprocess.run([
            "ffmpeg", "-y", "-i", str(clip_path), "-vf",
            "reverse,trim=start_frame=1,setpts=PTS-STARTPTS",
            "-an", str(rev),
        ], check=True, capture_output=True)
        n_rev = _probe_frames(rev)
        if n_rev < 1:
            raise ValueError(f"Reverso de {clip_path} ficou sem frames")

        zoom_out = f"{1 + zoom_pct}-{zoom_pct}*on/{max(n_rev - 1, 1)}"
        subprocess.run([
            "ffmpeg", "-y", "-i", str(rev), "-vf",
            f"scale=3840:2160,zoompan=z='{zoom_out}':d=1:"
            f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps={fps}",
            "-an", str(rev_zoom),
        ], check=True, capture_output=True)

        concat_file.write_text(
            f"file '{fwd_zoom.resolve()}'\nfile '{rev_zoom.resolve()}'\n")
        subprocess.run([
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file),
            "-c", "copy", str(output),
        ], check=True, capture_output=True)
    finally:
        for f in (fwd_zoom, rev, rev_zoom, concat_file):
            f.unlink(missing_ok=True)
    return output


def _repeat_clip(clip: Path, times: int, output: Path) -> Path:
    """Repete o MESMO arquivo N vezes -- corte seco aqui e inofensivo porque
    o ping-pong ja fecha loop perfeito por construcao (mesmo frame nas
    pontas)."""
    if times <= 1:
        return clip
    concat_file = output.parent / f"{output.stem}_reps.txt"
    concat_file.write_text(
        "\n".join(f"file '{clip.resolve()}'" for _ in range(times)))
    subprocess.run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-c", "copy", str(output),
    ], check=True, capture_output=True)
    concat_file.unlink(missing_ok=True)
    return output


def build_circular_sequence(pingpong_clips: dict[str, Path], output: Path,
                             flash_seconds: float = FLASH_SECONDS) -> Path:
    """Monta a volta pelos 5 angulos em sequencia CIRCULAR -- flash tambem
    na transicao do ultimo angulo de volta pro primeiro, pra repetir a hora
    toda sem corte seco nessa emenda. Truque: duplica o primeiro clipe no
    fim da cadeia de xfade, renderiza tudo, e corta exatamente no fim da
    ultima transicao (descarta o resto do clipe duplicado) -- o que sobra e
    a sequencia circular pronta pra repetir via -stream_loop."""
    order = [a["id"] for a in ANGLES]
    clips = [pingpong_clips[aid] for aid in order] + [pingpong_clips[order[0]]]
    durs = [_ffprobe_duration(c) for c in clips]

    inputs = []
    for c in clips:
        inputs += ["-i", str(c)]

    filter_parts = []
    cumulative = durs[0]
    trim_duration = None  # capturado ANTES da ultima transicao -- ver abaixo
    prev_label = "0:v"
    for i in range(1, len(clips)):
        if i == len(clips) - 1:
            # ponto onde a ULTIMA transicao (fecha o circulo) termina =
            # cumulative de ANTES dela comecar (offset) + a propria duracao
            # do flash = cumulative de antes, ja que offset = cumulative-flash.
            # Bug corrigido em 06/09/2026: a versao anterior recalculava
            # esse valor por fora do loop e descartava o flash de fechamento
            # inteiro (cortava no INICIO da transicao, nao no fim) -- o
            # video ja publicado hoje tem corte seco exatamente na emenda
            # que este flash existe pra mascarar.
            trim_duration = cumulative
        offset = cumulative - flash_seconds
        out_label = f"v{i}"
        filter_parts.append(
            f"[{prev_label}][{i}:v]xfade=transition=fadewhite:"
            f"duration={flash_seconds}:offset={offset:.3f}[{out_label}]"
        )
        cumulative = cumulative + durs[i] - flash_seconds
        prev_label = out_label

    full_output = output.parent / f"{output.stem}_full.mp4"
    subprocess.run([
        "ffmpeg", "-y"] + inputs + [
        "-filter_complex", ";".join(filter_parts),
        "-map", f"[{prev_label}]",
        "-c:v", "libx264", "-crf", "18", "-preset", "medium",
        str(full_output),
    ], check=True, capture_output=True)

    # loop unit real = so ate o fim da ultima transicao (fecha o circulo
    # primeiro->de novo); descarta o resto do clipe duplicado no final
    subprocess.run([
        "ffmpeg", "-y", "-i", str(full_output), "-t", str(trim_duration),
        "-c", "copy", str(output),
    ], check=True, capture_output=True)
    full_output.unlink(missing_ok=True)
    return output


def build_veo_angles_loop_unit(theme: dict, canonical_face_path: Path,
                                work_dir: Path, replicate_api_token: str,
                                flux_model: str = "black-forest-labs/flux-1.1-pro",
                                safety_tolerance: int = 5,
                                prompt_strength: float = 0.85) -> Path:
    """Ponta a ponta: gera as 5 imagens, os 5 clipes Veo, ping-pong+zoom de
    cada, repete conforme os ciclos de cada angulo, e a sequencia circular
    com flash. Retorna o video pronto pra virar o loop_clip de
    build_video_from_loop_clip() (ja e 1920x1080 h264, mas ainda passa pela
    normalizacao de GOP fechado de la -- o corte do trim aqui e por tempo,
    nao alinhado a keyframe).

    Caro (~$6+/video: 5 imagens Flux + 5 clipes Veo). Reservado pra
    segunda-feira -- ver [[project-umbra-sessions]] secao "Cadencia
    semanal"."""
    client = replicate.Client(api_token=replicate_api_token)
    theme = {**theme, **LANDMARK_OVERRIDES.get(theme["id"], {})}

    images = generate_angle_images(
        theme, canonical_face_path, work_dir / "angle_images", client,
        model=flux_model, safety_tolerance=safety_tolerance,
        prompt_strength=prompt_strength)
    clips = generate_angle_clips(images, work_dir / "angle_clips", client)

    pp_dir = work_dir / "angle_pingpong"
    pp_dir.mkdir(parents=True, exist_ok=True)
    pingpong = {}
    for angle in ANGLES:
        aid = angle["id"]
        pp_path = pp_dir / f"{aid}_pingpong.mp4"
        build_pingpong(clips[aid], pp_path)
        if angle["cycles"] > 1:
            repeated = pp_dir / f"{aid}_x{angle['cycles']}.mp4"
            _repeat_clip(pp_path, angle["cycles"], repeated)
            pingpong[aid] = repeated
        else:
            pingpong[aid] = pp_path

    loop_unit = work_dir / "veo_angles_loop_unit.mp4"
    build_circular_sequence(pingpong, loop_unit)
    return loop_unit
