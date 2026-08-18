"""
Monta compilados horizontais 16:9 a partir dos Reels verticais do Instagram.

Motivo: vídeo vertical ou quadrado com até 3 minutos é classificado
automaticamente como Short pelo YouTube, e horas assistidas no feed de Shorts
não contam para as 4.000 horas do YouTube Partner Program. Um compilado
1920x1080 de 10–15 min é um vídeo comum e gera horas de exibição válidas.

Cada Reel vira um segmento 1920x1080: o próprio vídeo desfocado preenche o
fundo e o original entra centralizado na altura cheia. Intro e outro são
gerados com áudio silencioso — concat demux descarta o áudio de todos os
segmentos se um deles vier sem trilha.
"""
import json
import os
import re
import subprocess
from pathlib import Path

WIDTH, HEIGHT, FPS = 1920, 1080, 30
INTRO_SECONDS = 5
OUTRO_SECONDS = 6

# Alvo de duração do compilado. Fecha o grupo ao passar de MIN; nunca ultrapassa MAX.
TARGET_MIN_SECONDS = 10 * 60
TARGET_MAX_SECONDS = 15 * 60
# Grupo com menos que isto fica pendente para a próxima rodada, em vez de virar
# um compilado curto demais para render horas de exibição.
ABSOLUTE_MIN_SECONDS = 8 * 60

FONT_FILE = "C:/Windows/Fonts/arialbd.ttf"
BG_COLOR = "0x14161C"
ACCENT = "0xE8B4C8"

_VIDEO_ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
_AUDIO_ENCODE = ["-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2"]


def _run(cmd: list, timeout: int = 900):
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-6:]
        raise RuntimeError(f"ffmpeg falhou ({proc.returncode}): {' | '.join(tail)}")
    return proc


def probe_duration(path) -> float:
    """Duração do arquivo em segundos. 0.0 se ilegível."""
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return 0.0


def _escape_drawtext(text: str) -> str:
    """Escapa texto para o filtro drawtext (ordem importa: barra invertida primeiro)."""
    out = text.replace("\\", "\\\\")
    for ch in (":", "'", "%", "[", "]", ",", ";"):
        out = out.replace(ch, "\\" + ch)
    return out


def _escape_fontfile(path: str) -> str:
    """`C:/...` precisa virar `C\\:/...` dentro de um filtro do ffmpeg."""
    return path.replace(":", "\\:")


def _wrap(text: str, width: int = 28) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        candidate = f"{cur} {w}".strip()
        if len(candidate) > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = candidate
    if cur:
        lines.append(cur)
    return lines[:4]


def make_card(text: str, subtext: str, dest: Path, seconds: int) -> Path:
    """Cartela estática com áudio silencioso (intro/outro)."""
    lines = _wrap(text)
    draws = []
    block_top = HEIGHT / 2 - (len(lines) * 96) / 2 - 40
    for i, line in enumerate(lines):
        draws.append(
            f"drawtext=fontfile='{_escape_fontfile(FONT_FILE)}':text='{_escape_drawtext(line)}'"
            f":fontcolor=white:fontsize=76:x=(w-text_w)/2:y={int(block_top + i * 96)}"
        )
    if subtext:
        draws.append(
            f"drawtext=fontfile='{_escape_fontfile(FONT_FILE)}':text='{_escape_drawtext(subtext)}'"
            f":fontcolor={ACCENT}:fontsize=46:x=(w-text_w)/2:y={int(block_top + len(lines) * 96 + 40)}"
        )

    _run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=c={BG_COLOR}:s={WIDTH}x{HEIGHT}:r={FPS}:d={seconds}",
        "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo:d={seconds}",
        "-vf", ",".join(draws),
        *_VIDEO_ENCODE, *_AUDIO_ENCODE,
        "-shortest", str(dest),
    ], timeout=180)
    return dest


def normalize_clip(src, dest: Path) -> Path:
    """
    Converte um Reel vertical em segmento 1920x1080: fundo desfocado do próprio
    vídeo + original centralizado. O blur roda em 320x180 e só depois sobe para
    1080p — mesmo resultado visual, uma fração do custo.
    """
    vf = (
        f"[0:v]scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,"
        f"crop={WIDTH}:{HEIGHT},scale=320:180,boxblur=12:2,scale={WIDTH}:{HEIGHT},setsar=1[bg];"
        f"[0:v]scale=-2:{HEIGHT}:force_original_aspect_ratio=decrease,setsar=1[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2,fps={FPS},format=yuv420p[v]"
    )
    _run([
        "ffmpeg", "-y", "-noautorotate", "-i", str(src),
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-filter_complex", vf,
        "-map", "[v]",
        # Usa o áudio do Reel; cai no silêncio gerado se o arquivo não tiver trilha.
        "-map", "0:a?", "-map", "1:a",
        "-map_metadata", "-1",
        *_VIDEO_ENCODE, *_AUDIO_ENCODE,
        "-shortest", str(dest),
    ], timeout=600)
    return dest


def concat_segments(segments: list[Path], dest: Path) -> Path:
    """Junta segmentos já normalizados sem recodificar."""
    listfile = dest.with_suffix(".txt")
    # Caminho absoluto: o concat demux resolve paths relativos ao arquivo de lista,
    # não ao diretório de trabalho.
    listfile.write_text(
        "\n".join(f"file '{Path(s).resolve().as_posix()}'" for s in segments),
        encoding="utf-8",
    )
    try:
        _run([
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(listfile),
            "-c", "copy", "-movflags", "+faststart", str(dest),
        ], timeout=600)
    finally:
        listfile.unlink(missing_ok=True)
    return dest


def group_clips(clips: list[dict]) -> tuple[list[list[dict]], list[dict]]:
    """
    Divide os clipes em grupos de 10–15 min. Retorna (grupos_fechados, sobra).
    Cada clipe precisa de `file_path`; `duration` é medida se ausente.
    """
    groups, current, total = [], [], 0.0

    for clip in clips:
        dur = clip.get("duration") or probe_duration(clip["file_path"])
        if dur <= 0:
            continue
        clip["duration"] = dur

        if current and total + dur > TARGET_MAX_SECONDS:
            groups.append(current)
            current, total = [], 0.0

        current.append(clip)
        total += dur

        if total >= TARGET_MIN_SECONDS:
            groups.append(current)
            current, total = [], 0.0

    if total >= ABSOLUTE_MIN_SECONDS:
        groups.append(current)
        current = []

    return groups, current


def _clip_label(caption: str, index: int) -> str:
    """Primeira linha da legenda, sem hashtags — vira o nome do capítulo."""
    first = (caption or "").strip().split("\n")[0]
    clean = re.sub(r"#\w+", "", first)
    clean = re.sub(r"[^\w\sÀ-ÿ!?.,-]", "", clean)
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean[:70] if clean else f"Parte {index}"


MIN_CHAPTER_SECONDS = 10


def build_chapters(group: list[dict], intro_seconds: int = INTRO_SECONDS) -> list[tuple[str, str]]:
    """
    Timestamps de capítulo para a descrição do YouTube.

    Duas regras do YouTube derrubam a lista inteira se violadas: o primeiro
    capítulo tem que começar em 00:00 e nenhum pode durar menos de 10s. Clipes
    curtos são absorvidos pelo capítulo anterior em vez de virarem um próprio.
    Menos de 3 capítulos também é rejeitado — nesse caso não devolve nenhum.
    """
    chapters = [("00:00", "Início")]
    t = float(intro_seconds)
    last_start = 0.0

    for i, clip in enumerate(group, start=1):
        if t - last_start >= MIN_CHAPTER_SECONDS:
            m, s = divmod(int(t), 60)
            h, m = divmod(m, 60)
            stamp = f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"
            chapters.append((stamp, _clip_label(clip.get("caption", ""), i)))
            last_start = t
        t += clip["duration"]

    # O último capítulo também precisa de 10s de duração até o fim do vídeo.
    if len(chapters) > 1 and t - last_start < MIN_CHAPTER_SECONDS:
        chapters.pop()

    return chapters if len(chapters) >= 3 else []


def build_compilation(
    group: list[dict],
    out_path: Path,
    title: str,
    work_dir: Path,
    subtitle: str = "Raquel Pires",
    outro_text: str = "Inscreva-se no canal",
    outro_sub: str = "Vídeos novos toda semana",
) -> dict:
    """
    Renderiza um compilado 16:9 completo (intro + clipes + outro).
    Retorna dict com path, duração e capítulos.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    segments = []

    try:
        intro = make_card(title, subtitle, work_dir / "00_intro.mp4", INTRO_SECONDS)
        segments.append(intro)

        for i, clip in enumerate(group, start=1):
            seg = work_dir / f"{i:02d}_clip.mp4"
            print(f"  [{i}/{len(group)}] normalizando {Path(clip['file_path']).name}...", flush=True)
            segments.append(normalize_clip(clip["file_path"], seg))

        outro = make_card(outro_text, outro_sub, work_dir / "99_outro.mp4", OUTRO_SECONDS)
        segments.append(outro)

        print(f"  concatenando {len(segments)} segmentos...", flush=True)
        concat_segments(segments, out_path)
    finally:
        for seg in segments:
            Path(seg).unlink(missing_ok=True)

    return {
        "path": str(out_path),
        "duration": probe_duration(out_path),
        "chapters": build_chapters(group),
        "clips": [c["instagram_id"] for c in group],
    }


def build_description(chapters: list[tuple[str, str]], instagram_handle: str = "@raquelpiiires") -> str:
    lines = [
        "Compilado dos melhores momentos do meu Instagram — K-dramas, C-dramas e fan meetings.",
        "",
    ]
    if chapters:
        lines.append("CAPÍTULOS")
        lines += [f"{stamp} {label}" for stamp, label in chapters]
    lines += [
        "",
        f"📸 Instagram: https://www.instagram.com/{instagram_handle.lstrip('@')}/",
        "",
        "#kdrama #cdrama #kpop #fanmeeting #dorama",
    ]
    return "\n".join(lines)
