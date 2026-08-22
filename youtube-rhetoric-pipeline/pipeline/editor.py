"""
Montagem dos vídeos do canal.

Dois formatos saem do mesmo material:

- LONGO (1920x1080): narração + clipe de cada segmento retórico, concatenados.
  Mais largo que alto, então o YouTube trata como upload comum e as horas de
  exibição contam para as 4.000h do YouTube Partner Program.
- SHORT (1080x1920): um segmento isolado em vertical, para divulgação. Reusa a
  narração já sintetizada para o longo, sem custo adicional de ElevenLabs.

Todo segmento é reencodado para as mesmas specs (resolução, fps, pixel format,
sample rate) porque o concat demux com `-c copy` exige streams idênticos e
descarta o áudio de tudo se um dos segmentos vier sem trilha.
"""
import subprocess
from pathlib import Path

LONG_WIDTH, LONG_HEIGHT = 1920, 1080
SHORT_WIDTH, SHORT_HEIGHT = 1080, 1920
FPS = 30

# Teto do YouTube para Shorts é 3 min; a margem evita que arredondamento de
# duração de container jogue o arquivo para fora da classificação.
SHORT_MAX_SECONDS = 170.0
SHORT_MIN_CLIP_SECONDS = 15.0

_VIDEO_ENCODE = [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-r", str(FPS),
]
_AUDIO_ENCODE = ["-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2"]


def _run(cmd: list[str], timeout: int = 1800):
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout,
    )
    if result.returncode != 0:
        tail = (result.stderr or "").strip().splitlines()[-6:]
        raise RuntimeError(f"ffmpeg falhou ({result.returncode}): {' | '.join(tail)}")
    return result


def _even(value: int) -> int:
    """Dimensão ímpar em cadeia yuv420p depende de build do ffmpeg."""
    return value // 2 * 2


def _pad_filter(width: int, height: int, stream: str = "0:v", label: str = "v") -> str:
    """
    Encaixa qualquer proporção em width x height sem corte: o próprio vídeo
    desfocado preenche o fundo e o original entra centralizado.

    O desfoque roda em 1/8 da resolução: boxblur em 1920x1080 é o filtro mais
    caro do pipeline e roda 2x por segmento.
    """
    bw, bh = _even(width // 8), _even(height // 8)
    return (
        f"[{stream}]split=2[bgsrc][fgsrc];"
        f"[bgsrc]scale={bw}:{bh}:force_original_aspect_ratio=increase,"
        f"crop={bw}:{bh},boxblur=3:1,scale={width}:{height}[bg];"
        f"[fgsrc]scale={width}:{height}:force_original_aspect_ratio=decrease[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[{label}]"
    )


def _crop_filter(width: int, height: int, stream: str = "0:v", label: str = "v") -> str:
    """
    Preenche width x height cortando as laterais. Usado nos Shorts: tela cheia
    dá muito mais presença ao creator que a faixa central com fundo desfocado.
    """
    return (
        f"[{stream}]scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1[{label}]"
    )


def _fit_filter(width: int, height: int, fit: str = "pad",
                stream: str = "0:v", label: str = "v") -> str:
    builder = _crop_filter if fit == "crop" else _pad_filter
    return builder(width, height, stream, label)


def has_audio_stream(path: str) -> bool:
    """
    Falha do ffprobe é erro explícito, não 'sem áudio': tratar as duas coisas
    igual faria a intro/outro perder a trilha própria em silêncio.
    """
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
             "stream=index", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise RuntimeError(f"ffprobe indisponível ao inspecionar {path}: {e}") from e

    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe falhou em {path}: {proc.stderr.strip()}")
    return bool(proc.stdout.strip())


def _narration_segment(source_path: str, narration_path: str, clip_start: float,
                       width: int, height: int, out_path: Path,
                       fit: str = "pad") -> Path:
    """Trecho analisado rodando mudo ao fundo, com a voz da IA por cima."""
    # Teto explícito além do -shortest: narração truncada ou corrompida deixaria
    # o -stream_loop rodando até o timeout de 1800s antes de acusar o erro.
    narration_seconds = probe_duration(narration_path)
    if narration_seconds <= 0:
        raise RuntimeError(f"Narração ilegível ou vazia: {narration_path}")

    _run([
        "ffmpeg", "-y", "-noautorotate",
        "-stream_loop", "-1", "-ss", str(clip_start), "-i", source_path,
        "-i", narration_path,
        "-filter_complex", _fit_filter(width, height, fit),
        "-map", "[v]", "-map", "1:a:0",
        *_VIDEO_ENCODE, *_AUDIO_ENCODE,
        "-t", str(narration_seconds), "-shortest",
        str(out_path),
    ])
    return out_path


def _clip_segment(source_path: str, clip_start: float, clip_end: float,
                  width: int, height: int, out_path: Path,
                  fit: str = "pad") -> Path:
    """Creator falando com o áudio original preservado."""
    # 0:a:0 e não 0:a — o merge do yt-dlp costuma trazer a dublagem automática
    # como segunda trilha, e o concat demux exige a mesma contagem de streams.
    _run([
        "ffmpeg", "-y", "-noautorotate",
        "-ss", str(clip_start), "-i", source_path,
        "-t", str(clip_end - clip_start),
        "-filter_complex", _fit_filter(width, height, fit),
        "-map", "[v]", "-map", "0:a:0",
        *_VIDEO_ENCODE, *_AUDIO_ENCODE,
        str(out_path),
    ])
    return out_path


def _normalize_asset(asset_path: str, width: int, height: int, out_path: Path) -> Path:
    """
    Reencoda intro/outro para as specs do concat. Preserva a trilha do próprio
    asset quando existe; só cai no silêncio sintético quando o arquivo não tem
    áudio — sem isso o concat demux descarta o áudio do vídeo inteiro.
    """
    if has_audio_stream(asset_path):
        audio_input, audio_map = [], "0:a:0"
    else:
        audio_input = ["-f", "lavfi", "-t", "3600", "-i", "anullsrc=r=44100:cl=stereo"]
        audio_map = "1:a"

    _run([
        "ffmpeg", "-y", "-noautorotate", "-i", asset_path, *audio_input,
        "-filter_complex", _fit_filter(width, height),
        "-map", "[v]", "-map", audio_map,
        *_VIDEO_ENCODE, *_AUDIO_ENCODE, "-shortest",
        str(out_path),
    ])
    return out_path


def _concat(parts: list[str], out_path: Path, list_path: Path) -> Path:
    abs_parts = [str(Path(p).resolve()) for p in parts]
    list_path.write_text(
        "\n".join(f"file '{p}'" for p in abs_parts), encoding="utf-8"
    )
    _run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(list_path), "-c", "copy", str(out_path),
    ])
    return out_path


def build_long_video(source_path: str, segments: list[dict], output_dir: str,
                     video_id: str, intro_path: str | None = None,
                     outro_path: str | None = None) -> str:
    """
    Vídeo principal 1920x1080.

    segments: dicts com clip_start, clip_end e narration_path. Cada um vira
    narração + clipe, na ordem recebida.
    """
    if not segments:
        raise ValueError("build_long_video exige ao menos 1 segmento")

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    parts: list[str] = []

    if intro_path:
        parts.append(str(_normalize_asset(
            intro_path, LONG_WIDTH, LONG_HEIGHT, out / f"{video_id}_long_intro.mp4"
        )))

    for index, segment in enumerate(segments):
        parts.append(str(_narration_segment(
            source_path, segment["narration_path"], segment["clip_start"],
            LONG_WIDTH, LONG_HEIGHT, out / f"{video_id}_long_{index}_narration.mp4",
        )))
        parts.append(str(_clip_segment(
            source_path, segment["clip_start"], segment["clip_end"],
            LONG_WIDTH, LONG_HEIGHT, out / f"{video_id}_long_{index}_clip.mp4",
        )))

    if outro_path:
        parts.append(str(_normalize_asset(
            outro_path, LONG_WIDTH, LONG_HEIGHT, out / f"{video_id}_long_outro.mp4"
        )))

    return str(_concat(
        parts,
        out / f"{video_id}_long.mp4",
        out / f"{video_id}_long_concat.txt",
    ))


def build_short(source_path: str, segment: dict, output_dir: str, video_id: str,
                index: int, outro_path: str | None = None) -> str:
    """
    Um segmento em 1080x1920, para o feed de Shorts.

    Acima de 3 minutos o YouTube para de classificar o arquivo vertical como
    Short e ele vira vídeo vertical comum no feed principal — o pior dos dois
    mundos. O clipe é recortado para caber no teto junto com narração e outro.
    """
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    narration_seconds = probe_duration(segment["narration_path"])
    outro_seconds = probe_duration(outro_path) if outro_path else 0.0
    clip_budget = SHORT_MAX_SECONDS - narration_seconds - outro_seconds
    if clip_budget < SHORT_MIN_CLIP_SECONDS:
        raise RuntimeError(
            f"Narração de {narration_seconds:.0f}s não deixa espaço para clipe "
            f"dentro do teto de {SHORT_MAX_SECONDS}s do Short"
        )

    clip_start = segment["clip_start"]
    clip_end = min(segment["clip_end"], clip_start + clip_budget)

    parts = [
        str(_narration_segment(
            source_path, segment["narration_path"], clip_start,
            SHORT_WIDTH, SHORT_HEIGHT, out / f"{video_id}_short{index}_narration.mp4",
            fit="crop",
        )),
        str(_clip_segment(
            source_path, clip_start, clip_end,
            SHORT_WIDTH, SHORT_HEIGHT, out / f"{video_id}_short{index}_clip.mp4",
            fit="crop",
        )),
    ]

    if outro_path:
        parts.append(str(_normalize_asset(
            outro_path, SHORT_WIDTH, SHORT_HEIGHT,
            out / f"{video_id}_short{index}_outro.mp4",
        )))

    return str(_concat(
        parts,
        out / f"{video_id}_short{index}.mp4",
        out / f"{video_id}_short{index}_concat.txt",
    ))


def probe_duration(path: str) -> float:
    """Duração do arquivo em segundos. 0.0 se ilegível."""
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        return float(proc.stdout.strip())
    except (ValueError, OSError, subprocess.SubprocessError):
        return 0.0
