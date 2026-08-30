"""
Detecta presença de música no áudio de um clipe.

Motivo: 6 dos 7 primeiros compilados publicados receberam reivindicação de
direitos autorais do Content ID, todas de ÁUDIO — músicas do BTS e trilhas
usadas nos Reels. As horas de exibição continuam contando para o YPP, mas a
receita desses vídeos vai para a gravadora. Saber antes de montar permite
separar o que serve para acumular hora do que pode render dinheiro.

Isto NÃO identifica a faixa — para isso seria preciso fingerprint contra um
acervo licenciado (ACRCloud, AudD). Aqui a pergunta é mais modesta e local:
"este áudio soa como música contínua ou como fala/ambiente?".

Discriminantes usados, todos via ffmpeg (sem dependência nova):
- continuidade de energia: música mantém nível; fala tem pausas entre frases
- desvio do RMS ao longo do tempo: alto em fala, baixo em música
- entropia espectral: música tem estrutura harmônica sustentada
"""
import json
import subprocess
from pathlib import Path

import numpy as np

# Quadro de análise. 0,5s é curto o bastante para pegar a pausa entre frases da
# fala e longo o bastante para não picotar uma nota sustentada.
FRAME_SECONDS = 0.5

# Abaixo disto o quadro é silêncio, não conteúdo.
SILENCIO_DBFS = -50.0


def _metadata_series(path, filtro: str, chaves: tuple[str, ...]) -> dict[str, np.ndarray]:
    """
    Roda um filtro de análise por quadro e devolve cada métrica como série.
    `metadata=print` escreve em nível info — com `-v error` a saída some e as
    séries voltam vazias.
    """
    proc = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", str(path),
         "-af", f"asetnsamples=n={int(44100 * FRAME_SECONDS)},{filtro},ametadata=print",
         "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
    )
    series = {k: [] for k in chaves}
    for line in (proc.stderr or "").splitlines():
        for k in chaves:
            marca = f".{k}="
            if marca in line:
                try:
                    series[k].append(float(line.split(marca)[1].split()[0]))
                except (ValueError, IndexError):
                    pass
    return {k: np.array(v, dtype=float) for k, v in series.items()}


def classificar(m: dict) -> tuple[str, float | None]:
    """
    Converte as métricas em estado, e só afirma o que dá para afirmar.

    Medi os clipes do compilado #7 (nenhuma reivindicação) contra os do #4
    (sete reivindicações de áudio) e as distribuições se sobrepõem em todas as
    métricas — fração audível, RMS, entropia, flatness e flux. Faz sentido: os
    dois grupos têm música. O que separa um do outro não é acústica, é a faixa
    estar ou não no acervo do Content ID, e isso exige fingerprint contra base
    licenciada.

    Por isso só existe uma conclusão honesta aqui: silêncio ou ausência de
    trilha é `sem_musica` com certeza; qualquer áudio audível fica
    `desconhecido` até que uma fonte de verdade diga o contrário. Chutar
    `sem_musica` num clipe com música transformaria o palpite em permissão
    para publicar.
    """
    from pipeline.queue import MUSIC_DESCONHECIDO, MUSIC_SEM_MUSICA

    if m.get("erro"):
        return MUSIC_DESCONHECIDO, None
    if m.get("sem_audio"):
        return MUSIC_SEM_MUSICA, 0.0

    fracao = m.get("fracao_audivel")
    if fracao is not None and fracao < 0.02:
        # Trilha existe mas é silêncio do começo ao fim.
        return MUSIC_SEM_MUSICA, float(fracao)

    return MUSIC_DESCONHECIDO, float(fracao) if fracao is not None else None


def analisar(path) -> dict:
    """
    Devolve as métricas brutas do áudio de um clipe. `sem_audio=True` quando o
    arquivo não tem trilha — caso comum nos Reels sem som.
    """
    p = Path(path)
    if not p.exists():
        return {"erro": "arquivo ausente"}

    tem_audio = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=codec_type", "-of", "json", str(p)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    try:
        if not json.loads(tem_audio.stdout or "{}").get("streams"):
            return {"sem_audio": True}
    except json.JSONDecodeError:
        return {"erro": "ffprobe ilegivel"}

    # `ametadata` (não `metadata`): em cadeia de áudio o ffmpeg recusa ligar o
    # filtro de vídeo e a série volta vazia sem erro visível.
    tempo = _metadata_series(p, "astats=metadata=1:reset=1", ("Overall.RMS_level",))
    # As chaves de aspectralstats vêm prefixadas pelo canal (`1.entropy`).
    espectro = _metadata_series(p, "aspectralstats", ("1.entropy", "1.flatness", "1.flux"))

    rms = tempo.get("Overall.RMS_level", np.array([]))
    rms = rms[np.isfinite(rms)]
    if rms.size < 4:
        return {"erro": "audio curto demais para medir"}

    audiveis = rms[rms > SILENCIO_DBFS]
    fracao_audivel = float(audiveis.size / rms.size)

    def limpa(chave):
        v = espectro.get(chave, np.array([]))
        return v[np.isfinite(v)]

    entropia, flatness, flux = limpa("1.entropy"), limpa("1.flatness"), limpa("1.flux")

    def par(v):
        if v.size == 0:
            return None, None
        return round(float(v.mean()), 5), (round(float(v.std()), 5) if v.size > 1 else None)

    ent_m, ent_d = par(entropia)
    fla_m, _ = par(flatness)
    flu_m, flu_d = par(flux)

    return {
        "quadros": int(rms.size),
        "fracao_audivel": round(fracao_audivel, 3),
        "rms_medio": round(float(audiveis.mean()), 2) if audiveis.size else None,
        "rms_desvio": round(float(audiveis.std()), 2) if audiveis.size > 1 else None,
        "entropia_media": ent_m,
        "entropia_desvio": ent_d,
        "flatness_media": fla_m,
        "flux_medio": flu_m,
        "flux_desvio": flu_d,
    }
