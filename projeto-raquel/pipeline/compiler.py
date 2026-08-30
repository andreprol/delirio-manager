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

# Teto de duração: evento muito grande é dividido em mais de um vídeo.
TARGET_MAX_SECONDS = 15 * 60

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


# Piso de bitrate abaixo do qual o arquivo é download truncado, não vídeo ruim.
# Um Reel do Instagram em 720x1280 nunca desce de ~400 kbps; 34 KB para 16 s
# (17 kbps) era um MP4 com o header inteiro e o corpo pela metade — o ffprobe
# lia duração e dimensões normalmente e só o decode acusava "partial file".
MIN_CLIP_KBPS = 150


class CompilationError(RuntimeError):
    """
    Falha ao montar um compilado, carregando os clipes recusados no caminho.
    Sem isso o chamador não tem como pôr o clipe defeituoso de quarentena e a
    mesma falha volta em toda rodada agendada.
    """

    def __init__(self, message: str, rejected: list[dict] | None = None):
        super().__init__(message)
        self.rejected = rejected or []


def verify_playable(path, duration: float = 0.0) -> str | None:
    """
    Decodifica o arquivo inteiro para o muxer nulo. Devolve None se o clipe é
    íntegro, ou o motivo da recusa.

    `probe_duration` sozinho não serve de porteiro: ele lê o `moov`, que num
    download interrompido chega completo mesmo sem os frames. Só o decode real
    distingue vídeo curto de vídeo cortado.
    """
    p = Path(path)
    if not p.exists():
        return "arquivo ausente"

    size = p.stat().st_size
    if duration > 0:
        kbps = size * 8 / 1000 / duration
        if kbps < MIN_CLIP_KBPS:
            return f"download truncado ({size} bytes, {kbps:.0f} kbps para {duration:.1f}s)"

    try:
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-xerror", "-i", str(p), "-f", "null", "-"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
        )
    except subprocess.TimeoutExpired:
        # Estourar aqui não pode virar exceção solta: o preflight roda fora do
        # try do render, e a lista de recusados se perderia junto — o clipe
        # voltaria ao pool e travaria a rodada seguinte do mesmo jeito.
        return "decode travou (timeout de 300s)"
    if proc.returncode != 0:
        first = (proc.stderr or "").strip().splitlines()
        return f"decode falhou: {first[0] if first else 'sem detalhe'}"
    return None


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


# Um compilado 16:9 já é vídeo longo em qualquer duração — o limite de 3 min do
# Short só vale para vertical/quadrado. Por isso o piso aqui é baixo: junta só o
# que tem relação real entre si, em vez de esticar o grupo até bater 10 min.
MIN_EVENT_SECONDS = 3 * 60

# Palavras sem valor para identificar assunto.
_STOPWORDS = {
    "que", "com", "para", "por", "dos", "das", "uma", "meu", "minha", "muito",
    "mais", "esse", "essa", "isso", "não", "sim", "aqui", "ele", "ela", "eles",
    "foi", "vou", "tem", "the", "and", "you", "for", "gente", "hoje", "dia",
    "vídeo", "video", "link", "bio", "sobre", "todo", "toda", "tudo", "pra",
}


def _tokens(caption: str) -> set:
    """Hashtags e palavras longas da legenda — a impressão digital do assunto."""
    text = (caption or "").lower()
    tags = {t for t in re.findall(r"#(\w{3,})", text)}
    words = {w for w in re.findall(r"[a-zà-ÿ]{4,}", text) if w not in _STOPWORDS}
    return tags | words


def _day(clip: dict) -> str:
    """Data do post (YYYY-MM-DD), do timestamp ou do nome do arquivo."""
    taken = clip.get("taken_at") or ""
    if taken and len(taken) >= 10:
        return taken[:10]
    stem = Path(clip["file_path"]).stem
    d = stem.split("_")[0]
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else d


def _measure(clips: list[dict]) -> list[dict]:
    out = []
    for clip in clips:
        dur = clip.get("duration") or probe_duration(clip["file_path"])
        if dur > 0:
            clip["duration"] = dur
            out.append(clip)
    return out


def _split_oversized(group: list[dict]) -> list[list[dict]]:
    """Evento gigante vira mais de um vídeo, respeitando o teto de 15 min."""
    if sum(c["duration"] for c in group) <= TARGET_MAX_SECONDS:
        return [group]
    parts, current, total = [], [], 0.0
    for clip in group:
        if current and total + clip["duration"] > TARGET_MAX_SECONDS:
            parts.append(current)
            current, total = [], 0.0
        current.append(clip)
        total += clip["duration"]
    if current:
        parts.append(current)
    return parts


def group_by_event(clips: list[dict]) -> tuple[list[list[dict]], list[dict]]:
    """
    Agrupa clipes do mesmo evento: mesma data, ou dias consecutivos que
    compartilham assunto na legenda (fan meeting à noite, post no dia seguinte).

    Retorna (eventos_com_material_suficiente, avulsos).
    """
    clips = _measure(clips)
    by_day: dict[str, list[dict]] = {}
    for clip in clips:
        by_day.setdefault(_day(clip), []).append(clip)

    # Funde dias vizinhos que falam do mesmo assunto.
    days = sorted(by_day)
    merged: list[list[dict]] = []
    for day in days:
        block = by_day[day]
        if merged:
            prev_day = _day(merged[-1][0])
            adjacent = abs((_to_ord(day) or 0) - (_to_ord(prev_day) or 0)) <= 1
            shared = _tokens_of(merged[-1]) & _tokens_of(block)
            if adjacent and shared:
                merged[-1].extend(block)
                continue
        merged.append(list(block))

    events, loose = [], []
    for block in merged:
        if sum(c["duration"] for c in block) >= MIN_EVENT_SECONDS and len(block) > 1:
            events.extend(_split_oversized(block))
        else:
            loose.extend(block)
    return events, loose


def _tokens_of(block: list[dict]) -> set:
    tokens = set()
    for clip in block:
        tokens |= _tokens(clip.get("caption", ""))
    return tokens


def _to_ord(day: str) -> int | None:
    try:
        y, m, d = day.split("-")
        return int(y) * 372 + int(m) * 31 + int(d)
    except (ValueError, AttributeError):
        return None


def group_by_topic(clips: list[dict]) -> tuple[list[list[dict]], list[dict]]:
    """
    Para os avulsos: junta clipes que falam do mesmo assunto, mesmo em datas
    distantes (vários Reels sobre o mesmo drama viram um vídeo só).

    Retorna (temas_com_material_suficiente, sobra).
    """
    remaining = _measure(clips)
    groups: list[list[dict]] = []
    exhausted: set[str] = set()

    while True:
        # Token mais frequente entre os que sobraram define o próximo tema.
        counts: dict[str, int] = {}
        for clip in remaining:
            for tok in _tokens(clip.get("caption", "")) - exhausted:
                counts[tok] = counts.get(tok, 0) + 1

        candidates = {t: c for t, c in counts.items() if c >= 2}
        if not candidates:
            break

        topic = max(candidates, key=candidates.get)
        exhausted.add(topic)  # sempre cresce: garante o fim do laço

        block = [c for c in remaining if topic in _tokens(c.get("caption", ""))]
        if sum(c["duration"] for c in block) < MIN_EVENT_SECONDS:
            continue

        for part in _split_oversized(block):
            part[0]["_topic"] = topic
            groups.append(part)
        taken = {id(c) for c in block}
        remaining = [c for c in remaining if id(c) not in taken]

    return groups, remaining


def group_clips(clips: list[dict]) -> tuple[list[list[dict]], list[dict]]:
    """
    Agrupa por evento primeiro; o que sobrar, tenta agrupar por assunto.
    Clipes que não se encaixam em nenhum dos dois ficam no pool para a próxima
    rodada — nunca são colados a esmo só para fechar duração.
    """
    events, loose = group_by_event(clips)
    topics, leftover = group_by_topic(loose)
    return events + topics, leftover


def title_from_caption(caption: str, max_len: int = 90) -> str:
    """
    Título a partir da legenda da própria autora, preservando a escrita dela:
    tira só hashtags e espaço sobrando. Corta em fronteira de palavra — o limite
    do YouTube é 100 caracteres.
    """
    first = (caption or "").strip().split("\n")[0]
    clean = re.sub(r"#\w+", "", first)
    clean = re.sub(r"\s+", " ", clean).strip(" .,-–—")
    if len(clean) <= max_len:
        return clean
    cut = clean[:max_len].rsplit(" ", 1)[0].rstrip(" .,-–—")
    return f"{cut}..." if cut else clean[:max_len]


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

    # Carrossel: todos os clipes vêm de um post só e repetem a legenda. Uma lista
    # com a mesma frase N vezes não ajuda a navegar e ainda parece spam.
    body = [label for _, label in chapters[1:]]
    if len(set(body)) <= 1:
        return []

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

    # Conferência antes de renderizar qualquer coisa: um clipe truncado no meio
    # do lote fazia o ffmpeg abortar e jogava fora o trabalho dos outros 36.
    # Verificar primeiro custa segundos e mantém os capítulos coerentes com o
    # que de fato entrou no vídeo.
    usable, rejected = [], []
    for i, clip in enumerate(group, start=1):
        reason = verify_playable(clip["file_path"], clip.get("duration") or 0.0)
        if reason:
            print(f"  [{i}/{len(group)}] descartado {Path(clip['file_path']).name}: {reason}", flush=True)
            rejected.append({"instagram_id": clip["instagram_id"],
                             "file_path": clip["file_path"], "reason": reason})
        else:
            usable.append(clip)

    if not usable:
        raise CompilationError(
            f"nenhum clipe íntegro no grupo ({len(rejected)} descartado(s))", rejected
        )

    try:
        intro = make_card(title, subtitle, work_dir / "00_intro.mp4", INTRO_SECONDS)
        segments.append(intro)

        rendered = []
        for i, clip in enumerate(usable, start=1):
            seg = work_dir / f"{i:02d}_clip.mp4"
            print(f"  [{i}/{len(usable)}] normalizando {Path(clip['file_path']).name}...", flush=True)
            try:
                segments.append(normalize_clip(clip["file_path"], seg))
            except Exception as e:
                # Decodifica mas não renderiza (dimensão exótica, stream defeituoso).
                # Vai para a quarentena igual ao truncado: clipe que não vira
                # segmento não pode segurar o lote inteiro refém.
                print(f"      descartado na normalização: {e}", flush=True)
                rejected.append({"instagram_id": clip["instagram_id"],
                                 "file_path": clip["file_path"],
                                 "reason": f"normalização falhou: {e}"})
                Path(seg).unlink(missing_ok=True)
                continue
            rendered.append(clip)

        if not rendered:
            raise CompilationError(
                f"nenhum clipe renderizável no grupo ({len(rejected)} descartado(s))", rejected
            )

        outro = make_card(outro_text, outro_sub, work_dir / "99_outro.mp4", OUTRO_SECONDS)
        segments.append(outro)

        print(f"  concatenando {len(segments)} segmentos...", flush=True)
        concat_segments(segments, out_path)
    except CompilationError:
        raise
    except Exception as e:
        raise CompilationError(str(e), rejected) from e
    finally:
        for seg in segments:
            Path(seg).unlink(missing_ok=True)

    group = rendered
    return {
        "path": str(out_path),
        "duration": probe_duration(out_path),
        "chapters": build_chapters(group),
        "clips": [c["instagram_id"] for c in group],
        "rejected": rejected,
    }


def build_description(
    chapters: list[tuple[str, str]],
    instagram_handle: str = "@raquelpiiires",
    intro_line: str = "K-dramas, C-dramas e fan meetings — direto do meu Instagram.",
) -> str:
    lines = [intro_line]
    if chapters:
        lines += ["", "CAPÍTULOS"]
        lines += [f"{stamp} {label}" for stamp, label in chapters]
    # Sem hashtags fixas: o canal é da criadora e o assunto é dela. Só entram as
    # que ela mesma escreveu na legenda.
    tags = sorted({f"#{t}" for t in re.findall(r"#(\w{2,})", intro_line or "")})
    lines += [
        "",
        f"📸 Instagram: https://www.instagram.com/{instagram_handle.lstrip('@')}/",
    ]
    if tags:
        lines += ["", " ".join(tags)]
    return "\n".join(lines)
