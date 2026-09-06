import logging
import subprocess
import os
from pathlib import Path

log = logging.getLogger(__name__)

# Padrao de audio fechado em 06/09/2026: som nunca pode cair a zero entre
# faixas (o Suno ja exporta cada track com fade-out proprio -- ver metadata
# "[Fade to silence]" -- entao corte seco criava um vale de quase-silencio
# duplo). acrossfade sobrepoe D segundos de cada par em vez de cortar.
# Grave reforcado (bass boost + limiter pra nao estourar) e a assinatura
# sonora do canal, aplicado uma vez sobre o resultado ja com crossfade.
CROSSFADE_SECONDS = 8
# Teto de repeticoes no loop de preencher a hora -- um bloco de audio
# anormalmente curto (arquivo truncado/corrompido em pending/, ja aconteceu
# neste pipeline, ver feedback_arquivo_truncado_derruba_lote) nao pode gerar
# um filter_complex com centenas de -i.
MAX_LOOP_REPEATS = 30
BASS_BOOST_FILTER = "bass=gain=6:frequency=90:width_type=o:width=0.8,alimiter=limit=0.95"
MP3_ENCODE_ARGS = ["-c:a", "libmp3lame", "-q:a", "2"]


def _get_audio_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def _crossfade_chain(audio_files: list[Path], output: Path,
                      crossfade_seconds: float = CROSSFADE_SECONDS,
                      extra_filter: str | None = None,
                      trim_seconds: float | None = None) -> Path:
    """Concatena N faixas com crossfade real entre cada par -- o som nunca
    cai a zero. acrossfade so opera em pares, entao encadeia N-1 chamadas
    num filter_complex so. `extra_filter` (bass boost) e aplicado uma vez no
    fim da cadeia, nao em cada par. `crossfade_seconds` e reduzido sozinho se
    alguma faixa for curta demais pra suportar a janela pedida -- ja
    aconteceu MP3 truncado neste pipeline."""
    trim_args = ["-t", str(trim_seconds)] if trim_seconds else []

    if len(audio_files) == 1:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(audio_files[0]),
             "-af", extra_filter or "anull"] + trim_args + MP3_ENCODE_ARGS + [str(output)],
            check=True, capture_output=True,
        )
        return output

    durations = [_get_audio_duration(f) for f in audio_files]
    shortest = min(durations)
    if shortest <= 0:
        raise ValueError(f"Faixa de audio com duracao invalida (0s): {audio_files}")
    safe_crossfade = min(crossfade_seconds, shortest / 2)
    if safe_crossfade < crossfade_seconds:
        log.warning(
            "Crossfade reduzido de %.1fs para %.1fs -- faixa curta demais (%.1fs) entre %s",
            crossfade_seconds, safe_crossfade, shortest, [f.name for f in audio_files])

    inputs = []
    for f in audio_files:
        inputs += ["-i", str(f)]

    filter_parts = []
    prev_label = "0:a"
    for i in range(1, len(audio_files)):
        out_label = f"a{i}"
        filter_parts.append(
            f"[{prev_label}][{i}:a]acrossfade=d={safe_crossfade}:c1=tri:c2=tri[{out_label}]"
        )
        prev_label = out_label

    graph = ";".join(filter_parts)
    if extra_filter:
        graph += f";[{prev_label}]{extra_filter}[out]"
        map_label = "[out]"
    else:
        map_label = f"[{prev_label}]"

    subprocess.run(
        ["ffmpeg", "-y"] + inputs + [
            "-filter_complex", graph,
            "-map", map_label,
        ] + trim_args + MP3_ENCODE_ARGS + [str(output)],
        check=True, capture_output=True,
    )
    return output


def _concat_audio(audio_files: list[Path], output: Path) -> Path:
    """Concatena as tracks do dia com crossfade real + grave reforcado."""
    return _crossfade_chain(audio_files, output, extra_filter=BASS_BOOST_FILTER)


def _loops_needed(duration: float, target_seconds: float, crossfade_seconds: float) -> int:
    """Quantas repeticoes do bloco (com crossfade entre cada) cobrem
    target_seconds, capado em MAX_LOOP_REPEATS."""
    if duration <= 0:
        raise ValueError(f"Duracao de audio invalida: {duration}s")
    net_gain_per_loop = duration - crossfade_seconds
    loops = int(target_seconds / net_gain_per_loop) + 2
    return min(loops, MAX_LOOP_REPEATS)


def _loop_audio_to_duration(audio: Path, target_seconds: float, output: Path) -> Path:
    """Repete o bloco ja concatenado ate cobrir target_seconds, crossfadando
    cada repeticao consigo mesma -- a emenda da hora fechando tambem nao
    pode cair a zero. Bass boost ja foi aplicado uma vez em _concat_audio,
    entao aqui e so crossfade puro (nao reaplicar, acumularia ganho)."""
    duration = _get_audio_duration(audio)
    crossfade = min(CROSSFADE_SECONDS, duration / 2) if duration > 0 else CROSSFADE_SECONDS
    loops = _loops_needed(duration, target_seconds, crossfade)

    covered = duration + (loops - 1) * (duration - crossfade)
    if covered < target_seconds:
        log.warning(
            "Loop capado em %d repeticoes cobre so %.0fs de %.0fs pedidos "
            "(bloco de audio anormalmente curto: %.1fs)", loops, covered, target_seconds, duration)

    return _crossfade_chain([audio] * loops, output,
                             crossfade_seconds=crossfade, trim_seconds=target_seconds)


def _prepare_audio(audio_files: list[Path], output_dir: Path,
                   video_id: str, target_seconds: float) -> Path:
    """Concatena as tracks e repete o resultado até cobrir target_seconds."""
    if len(audio_files) == 1:
        raw_audio = audio_files[0]
    else:
        raw_audio = output_dir / f"{video_id}_concat.mp3"
        _concat_audio(audio_files, raw_audio)

    if _get_audio_duration(raw_audio) < target_seconds:
        final_audio = output_dir / f"{video_id}_looped.mp3"
        return _loop_audio_to_duration(raw_audio, target_seconds, final_audio)
    return raw_audio


def _normalize_loop_unit(clip_path: Path, output: Path) -> Path:
    """Reencoda o clipe para 1920x1080 exato com GOP fechado.

    Os modelos devolvem dimensões próprias (o Kling entrega 1904x1088), e o
    loop por cópia de stream só produz vídeo válido se cada repetição começar
    num keyframe — daí `-g` fixo e `-sc_threshold 0`.
    """
    subprocess.run([
        "ffmpeg", "-y", "-i", str(clip_path),
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,"
               "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
        "-c:v", "libx264", "-preset", "slow", "-crf", "20",
        "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
        "-an", str(output),
    ], check=True, capture_output=True)
    return output


def build_video_from_loop_clip(
    clip_path: Path,
    audio_files: list[Path],
    output_dir: Path,
    video_id: str,
    target_minutes: int = 60,
    already_normalized: bool = False,
) -> Path:
    """Monta o vídeo de 60 min repetindo um clipe que emenda consigo mesmo.

    O clipe é normalizado uma vez e depois repetido com `-c:v copy`, sem
    reencodar as 60 min — 1h de 1080p sai em ~1min30 em vez de dezenas de
    minutos.

    `already_normalized` pula a normalização para quem já entrega 1920×1080 com
    GOP fechado — é o caso do segmento de slideshow, que sai assim do
    `slideshow.py`. Reencodar 9 min à toa em todo slot é desperdício, e a
    segunda passada só degradaria a imagem.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    target_seconds = target_minutes * 60

    loop_unit = clip_path if already_normalized else _normalize_loop_unit(
        clip_path, output_dir / f"{video_id}_loop_unit.mp4")
    final_audio = _prepare_audio(audio_files, output_dir, video_id, target_seconds)

    output_path = output_dir / f"{video_id}.mp4"
    subprocess.run([
        "ffmpeg", "-y",
        "-stream_loop", "-1", "-i", str(loop_unit),
        "-i", str(final_audio),
        "-t", str(int(target_seconds)),
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "256k",
        "-shortest", "-movflags", "+faststart",
        str(output_path),
    ], check=True, capture_output=True)

    return output_path


def build_video(
    image_path: Path,
    audio_files: list[Path],
    output_dir: Path,
    video_id: str,
    target_minutes: int = 60,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    target_seconds = target_minutes * 60

    # Consolidate audio
    if len(audio_files) == 1:
        raw_audio = audio_files[0]
    else:
        raw_audio = output_dir / f"{video_id}_concat.mp3"
        _concat_audio(audio_files, raw_audio)

    # Loop if total duration < target
    duration = _get_audio_duration(raw_audio)
    if duration < target_seconds:
        final_audio = output_dir / f"{video_id}_looped.mp3"
        _loop_audio_to_duration(raw_audio, target_seconds, final_audio)
    else:
        final_audio = raw_audio

    # Build final video: image loop + audio
    output_path = output_dir / f"{video_id}.mp4"
    cmd = [
        "ffmpeg", "-y",
        "-loop", "1", "-framerate", "1",
        "-i", str(image_path),
        "-i", str(final_audio),
        "-t", str(min(_get_audio_duration(final_audio), target_seconds)),
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,"
               "pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
        "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "256k",
        "-shortest",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return output_path
