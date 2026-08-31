"""Monta o segmento de slideshow que serve de fundo ao vídeo de 1 hora.

Substitui o clipe animado do Kling (decisão de 29/08/2026). O que o Kling
entregava e precisa ser preservado aqui é **a emenda invisível**: o vídeo de
60 min é um segmento curto repetido com `-c:v copy`, então o último frame do
segmento tem que casar com o primeiro.

Com slideshow isso não sai de graça — se o segmento terminasse na imagem 30 e
recomeçasse na 01, haveria um corte seco a cada volta. A solução é fechar o
ciclo dentro do próprio segmento:

    [img01 fase 2s→20s] ⇢ img02 ⇢ ... ⇢ img30 ⇢ [img01 fase 0s→2s]
                                                   └── crossfade de volta

O rabo é a imagem 01 de novo, mas só os 2 s iniciais do seu Ken Burns. O
crossfade final consome esses 2 s inteiros, então o segmento **termina** com a
imagem 01 na fase 2 s — exatamente onde ele **começa**. Emenda perfeita, e o
custo por vídeo cai de $0,45 (Kling) para zero.

Duração: 18 + 29×20 + 2 − 30×2 = 540 s (9 min), repetido ~6,7× na hora.
"""
import logging
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)

SLIDE_SECONDS = 20
XFADE_SECONDS = 2
FPS = 30
WIDTH, HEIGHT = 1920, 1080

# Imagem parada é o padrão desde 29/08/2026: André achou que o movimento lento
# atrapalhava mais do que ajudava. O Ken Burns continua aqui, atrás de um
# interruptor, porque a mecânica de fase da emenda depende dele.
KEN_BURNS = False

# O Ken Burns amplia 12% ao longo dos 20 s. O acervo sai do Flux em 2752×1536,
# então mesmo no zoom máximo o recorte (2457 px) ainda é maior que 1920 — a
# imagem nunca é ampliada, só reduzida. Nitidez preservada.
ZOOM_AMPLITUDE = 0.12
# Deriva lateral, em fração da folga disponível. Fica dentro de [0,1] por
# construção, então o recorte jamais sai da imagem.
PAN_AMPLITUDE = 0.35
# zoompan arredonda a origem do recorte para pixel inteiro. Trabalhar no dobro
# da resolução final e reduzir depois é o que impede o zoom lento de "pipocar".
SUPERSAMPLE = 2

# Margem de segurança descartada de cada borda antes de escalar.
#
# O Flux assina a foto mesmo com negativa explícita — 3 das 30 imagens do
# Hawaii na v3 saíram com "© HA'AUI", "Ahaui" e "©...huna", todas a menos de 5%
# da borda. Palavra no prompt não é mecanismo; recorte é. Sobra resolução para
# isso: 2752×1536 menos 12% ainda dá 2422×1351, acima de 1080p, então a imagem
# continua sendo só reduzida, nunca ampliada.
SAFE_MARGIN = 0.06

_CROP_MARGIN = (
    f"crop=iw*{1 - 2 * SAFE_MARGIN:.2f}:ih*{1 - 2 * SAFE_MARGIN:.2f}"
)

_FIT_STATIC = (
    f"{_CROP_MARGIN},"
    f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,"
    f"crop={WIDTH}:{HEIGHT},setsar=1,format=yuv420p"
)


def _ken_burns_filter(total_frames: int, offset_frames: int, span_frames: int,
                      zoom_in: bool, pan_dir: int, tilt_dir: int) -> str:
    """Filtro de um slide com movimento.

    `offset_frames`/`span_frames` posicionam este trecho dentro do Ken Burns
    completo da imagem — é isso que permite cortar a imagem 01 em cabeça e rabo
    sem que o movimento dê um salto na emenda.
    """
    # Fase normalizada dentro do movimento completo, em [0,1].
    phase = f"(on+{offset_frames})/{span_frames - 1}"
    zoom = (f"1+{ZOOM_AMPLITUDE}*{phase}" if zoom_in
            else f"1+{ZOOM_AMPLITUDE}*(1-{phase})")
    # Fração da folga: 0,5 no centro, deslizando ±PAN_AMPLITUDE.
    fx = f"(0.5+{pan_dir}*{PAN_AMPLITUDE}*(2*{phase}-1))"
    fy = f"(0.5+{tilt_dir}*{PAN_AMPLITUDE * 0.6}*(2*{phase}-1))"
    return (
        f"{_CROP_MARGIN},"
        f"scale={WIDTH * SUPERSAMPLE}:{HEIGHT * SUPERSAMPLE}:"
        f"force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={WIDTH * SUPERSAMPLE}:{HEIGHT * SUPERSAMPLE},setsar=1,"
        f"zoompan=z='{zoom}':x='(iw-iw/zoom)*{fx}':y='(ih-ih/zoom)*{fy}':"
        f"d={total_frames}:s={WIDTH}x{HEIGHT}:fps={FPS},"
        f"format=yuv420p"
    )


def _render_slide(image: Path, output: Path, total_frames: int,
                  offset_frames: int, span_frames: int,
                  zoom_in: bool, pan_dir: int, tilt_dir: int) -> Path:
    if KEN_BURNS:
        # zoompan gera os N frames a partir de UM frame de entrada, daí a
        # imagem entrar sem -loop.
        cmd = ["ffmpeg", "-y", "-i", str(image),
               "-vf", _ken_burns_filter(total_frames, offset_frames,
                                        span_frames, zoom_in, pan_dir, tilt_dir)]
    else:
        # Parado: repetir a mesma imagem pelos N frames. Sem zoompan não há
        # supersample a fazer — escalar direto para 1080p sai mais nítido, e
        # o x264 comprime frame idêntico a quase nada.
        cmd = ["ffmpeg", "-y", "-loop", "1", "-framerate", str(FPS),
               "-i", str(image), "-vf", _FIT_STATIC]

    subprocess.run(cmd + [
        "-frames:v", str(total_frames),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
        "-fps_mode", "cfr", "-r", str(FPS), "-an", str(output),
    ], check=True, capture_output=True)
    return output


def _xfade_chain(clips: list[Path], durations: list[float], output: Path) -> Path:
    """Encadeia os slides com crossfade e grava o segmento final.

    GOP fechado (`-g`, `-sc_threshold 0`) é obrigatório: quem consome este
    arquivo repete ele com `-c:v copy`, e cópia de stream só produz vídeo
    válido se cada repetição começar num keyframe.
    """
    inputs = []
    for clip in clips:
        inputs += ["-i", str(clip)]

    steps, acc, label = [], durations[0], "0:v"
    for idx in range(1, len(clips)):
        offset = acc - XFADE_SECONDS
        out_label = f"v{idx}"
        steps.append(
            f"[{label}][{idx}:v]xfade=transition=fade:"
            f"duration={XFADE_SECONDS}:offset={offset:.4f}[{out_label}]"
        )
        label = out_label
        acc += durations[idx] - XFADE_SECONDS

    subprocess.run([
        "ffmpeg", "-y", *inputs,
        "-filter_complex", ";".join(steps),
        "-map", f"[{label}]",
        "-c:v", "libx264", "-preset", "slow", "-crf", "20",
        "-g", str(FPS * 4), "-keyint_min", str(FPS * 4), "-sc_threshold", "0",
        "-pix_fmt", "yuv420p", "-fps_mode", "cfr", "-r", str(FPS),
        "-an", str(output),
    ], check=True, capture_output=True)
    log.info("Segmento de slideshow: %s (%.1fs)", output, acc)
    return output


def build_loop_segment(images: list[Path], output_path: Path,
                       work_dir: Path = None) -> Path:
    """Monta o segmento que emenda consigo mesmo a partir do acervo do tema."""
    if len(images) < 2:
        raise ValueError(f"Slideshow precisa de pelo menos 2 imagens, veio {len(images)}.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    work_dir = work_dir or output_path.parent / "_slides"
    work_dir.mkdir(parents=True, exist_ok=True)

    span = SLIDE_SECONDS * FPS          # Ken Burns completo de uma imagem
    xfade_frames = XFADE_SECONDS * FPS

    # Ordem dos trechos: (imagem, frames, fase inicial, índice de movimento).
    #
    # O índice de movimento é o que decide zoom e deriva, e é **separado** da
    # posição no plano de propósito: cabeça e rabo são a mesma imagem 01 e
    # precisam do mesmo movimento, senão a emenda junta um trecho ampliando com
    # outro reduzindo. Custou 15,9/255 de diferença até ser corrigido.
    #
    # O rabo dura um frame a mais que o crossfade para que o segmento termine
    # num frame de imagem 01 pura — o último frame do crossfade ainda carrega
    # ~2% da imagem anterior. Esse frame extra fica na fase `xfade_frames`,
    # exatamente onde a cabeça começa.
    plan = [(images[0], span - xfade_frames, xfade_frames, 0)]
    plan += [(img, span, 0, i) for i, img in enumerate(images[1:], start=1)]
    plan.append((images[0], xfade_frames + 1, 0, 0))

    clips, durations = [], []
    for idx, (image, frames, offset, motion) in enumerate(plan):
        # Alternar sentido de zoom e de deriva evita que a hora inteira pareça
        # a mesma animação repetida 180 vezes.
        clip = _render_slide(
            image=image,
            output=work_dir / f"slide_{idx:03d}.mp4",
            total_frames=frames,
            offset_frames=offset,
            span_frames=span,
            zoom_in=(motion % 2 == 0),
            pan_dir=1 if motion % 4 < 2 else -1,
            tilt_dir=1 if motion % 3 == 0 else -1,
        )
        clips.append(clip)
        durations.append(frames / FPS)
        log.info("Slide %d/%d renderizado (%s)", idx + 1, len(plan), image.name)

    return _xfade_chain(clips, durations, output_path)


def measure_loop_seam(video: Path, work_dir: Path) -> float:
    """Diferença média entre o primeiro e o último frame, em 0-255.

    Mesma medição usada para aprovar o loop do Kling em 21/08 (1,4/255). Serve
    de prova de que a emenda é invisível — sem isso, "o loop está bom" é
    opinião.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    duration = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
        capture_output=True, text=True, check=True).stdout.strip())

    first, last = work_dir / "seam_first.png", work_dir / "seam_last.png"
    subprocess.run(["ffmpeg", "-y", "-i", str(video), "-frames:v", "1",
                    str(first)], check=True, capture_output=True)
    subprocess.run(["ffmpeg", "-y", "-sseof", "-0.2", "-i", str(video),
                    "-update", "1", str(last)], check=True, capture_output=True)

    from PIL import Image, ImageChops, ImageStat
    a, b = Image.open(first).convert("RGB"), Image.open(last).convert("RGB")
    diff = ImageStat.Stat(ImageChops.difference(a, b)).mean
    value = sum(diff) / len(diff)
    log.info("Emenda do loop: %.2f/255 (duração %.1fs)", value, duration)
    return value
