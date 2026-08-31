"""
Lê o run_current.log e envia email com resultado via Resend.
Chamado pelo sync_daily.bat após o sync.
"""
import os
import re
import sys
from pathlib import Path
from datetime import datetime

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

LOG_PATH = Path(__file__).parent.parent / "data" / "run_current.log"
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
TO_EMAIL = "andreprol1980@gmail.com"
FROM_EMAIL = "onboarding@resend.dev"


def read_last_run_log() -> str:
    if not LOG_PATH.exists():
        return "(run_current.log não encontrado)"
    return LOG_PATH.read_text(encoding="utf-8", errors="replace").strip()


def parse_run(log: str) -> dict:
    """Extrai métricas estruturadas do log da run."""
    result = {
        "uploaded": [],           # URLs YouTube publicados com sucesso
        "yt_errors": [],          # linhas de erro de upload YouTube
        "ig_fetch_error": None,   # mensagem de erro ao buscar IG (ou None se OK)
        "ig_error_type": None,    # "401" | "429" | "other"
        "session_expired": False, # True se autenticação foi rejeitada
        "no_new": False,          # True se não havia vídeos novos
        "sync_done": False,       # True se sync completou normalmente
        "new_count": 0,           # vídeos publicados (do resumo final)
        "already_synced": 0,      # posts já no banco antes da run
        # Fluxo 16:9 (fetch → compile → publish)
        "pool_added": 0,          # Reels novos que entraram no pool
        "pool_free": 0,           # clipes livres no pool após a run
        "pool_minutes": 0.0,      # minutos livres no pool após a run
        "compiled": [],           # compilados montados nesta run
        "compile_short": False,   # pool abaixo do mínimo para fechar compilado
        "compile_errors": [],     # falhas ao montar compilado
        "quarantined": [],        # clipes retirados do pool por estarem ilegíveis
        "yt_token_dead": False,   # refresh token do YouTube revogado/expirado
        "raw": log,
    }

    for line in log.splitlines():
        l = line.strip()
        ll = l.lower()

        # Upload YouTube bem-sucedido
        if "✓ publicado:" in ll or "ok publicado:" in ll:
            url = re.search(r"https://youtu\.be/\S+", l)
            if url:
                result["uploaded"].append(url.group())

        # Erro de upload YouTube
        elif "erro no upload" in ll:
            result["yt_errors"].append(l)
            # invalid_grant não é falha de rede: o refresh token foi revogado e
            # nenhuma rodada futura vai passar até o André reautenticar. Ficou 7
            # dias como "erro de upload" genérico enquanto o canal parava.
            if "invalid_grant" in ll or "expired or revoked" in ll:
                result["yt_token_dead"] = True

        # Falha ao montar compilado (clipe ilegível, ffmpeg, disco)
        elif "falha ao montar compilado" in ll:
            result["compile_errors"].append(l)

        # Clipe retirado do pool por estar truncado/ilegível
        elif "quarentena" in ll:
            result["quarantined"].append(l)

        # Erro ao buscar Instagram (fetch/paginação falhou)
        elif ("erro ao buscar" in ll and "instagram" in ll) or \
             ("erro ao buscar backlog" in ll):
            result["ig_fetch_error"] = l
            if "401" in l:
                result["ig_error_type"] = "401"
                # require_login = session rejeitada pela API
                if "require_login" in l or "session" in ll:
                    result["session_expired"] = True
            elif "429" in l or "rate-limit" in ll:
                result["ig_error_type"] = "429"
            else:
                result["ig_error_type"] = "other"

        # Session explicitamente marcada como expirada
        elif "session_expirada" in ll or "sessionexpired" in ll:
            result["session_expired"] = True

        # Sem vídeos novos
        elif ("nenhum vídeo novo" in ll or "nenhum vídeo encontrado" in ll
              or "nenhum reel novo" in ll):
            result["no_new"] = True

        # Linha de conclusão do sync
        elif "sincronização concluída" in ll:
            result["sync_done"] = True
            m = re.search(r"(\d+) vídeo\(s\) publicado", l)
            if m:
                result["new_count"] = int(m.group(1))

        # Contador de posts já sincronizados no banco
        elif "posts já sincronizados no banco" in ll:
            m = re.search(r"(\d+) posts", l)
            if m:
                result["already_synced"] = int(m.group(1))

        # ── Fluxo 16:9 ──
        # "17 Reel(s) no pool. Disponível para compilar: 8.6 min."
        elif "reel(s) no pool" in ll:
            m = re.search(r"(\d+) Reel", l)
            if m:
                result["pool_added"] = int(m.group(1))

        # "✓ #3 pronto: data\compilations\comp_003.mp4 (12.4 min)"
        elif "pronto:" in ll and "#" in l:
            result["compiled"].append(l)

        # "Pool: 9 clipe(s) livres · 4.2 min"
        elif ll.startswith("pool:"):
            m = re.search(r"(\d+) clipe\(s\) livres.*?([\d.]+) min", l)
            if m:
                result["pool_free"] = int(m.group(1))
                result["pool_minutes"] = float(m.group(2))

        # "Pool tem só 4.2 min — abaixo do mínimo de 8 min por compilado."
        elif "abaixo do mínimo" in ll:
            result["compile_short"] = True

    # Garantir coerência: se uploaded tem itens, new_count reflete isso
    if result["uploaded"] and result["new_count"] == 0:
        result["new_count"] = len(result["uploaded"])

    return result


def detect_outcome(r: dict) -> tuple[str, str]:
    # Prioridade 0: token do YouTube revogado. Nada volta a publicar sozinho —
    # é o único estado em que o canal fica parado indefinidamente sem que
    # nenhuma rodada futura possa consertar.
    if r["yt_token_dead"]:
        return "🔴 TOKEN YOUTUBE REVOGADO — reautenticar", "critical"
    # Prioridade 1: autenticação rejeitada (401 / require_login)
    if r["session_expired"] or r["ig_error_type"] == "401":
        return "🔑 SESSION BLOQUEADA — ação necessária", "critical"
    # Prioridade 2: uploads OK (mesmo que parcial)
    if r["uploaded"]:
        return f"✅ {len(r['uploaded'])} vídeo(s) publicado(s)", "success"
    # Prioridade 3: sync concluído com publicações
    if r["sync_done"] and r["new_count"] > 0:
        return f"✅ {r['new_count']} vídeo(s) publicado(s)", "success"
    # Rate limit por IP
    if r["ig_error_type"] == "429":
        return "⏸️ Rate limit Instagram (IP bloqueado)", "warning"
    # Outro erro no Instagram
    if r["ig_fetch_error"]:
        return "❌ Falha ao buscar Instagram", "error"
    # Erro no YouTube
    if r["yt_errors"]:
        return "❌ Erro no upload YouTube", "error"
    # Render falhou: o pool cresce mas nenhum vídeo sai
    if r["compile_errors"]:
        return "❌ Falha ao montar compilado", "error"
    # Compilado montado mas ainda não publicado
    if r["compiled"]:
        return f"🎬 {len(r['compiled'])} compilado(s) montado(s)", "info"
    # Pool acumulando: run saudável, só falta conteúdo para fechar um compilado
    if r["compile_short"]:
        return f"📥 Pool acumulando ({r['pool_minutes']:.1f} min de {8} min)", "info"
    # Sem conteúdo novo
    if r["no_new"] or (r["sync_done"] and r["new_count"] == 0):
        return "ℹ️ Sem vídeos novos", "info"
    return "⚠️ Resultado incerto", "warning"


def build_body(r: dict, status_label: str, date_str: str) -> str:
    SEP = "─" * 50

    # ── Resumo operacional ──
    if r["ig_fetch_error"]:
        ig_status = f"FALHOU ({r['ig_error_type'] or 'erro'})"
    elif r["uploaded"] or r["sync_done"]:
        ig_status = "OK"
    else:
        ig_status = "desconhecido"

    if r["ig_fetch_error"] and not r["uploaded"]:
        yt_status = "não chegou (Instagram falhou antes)"
    elif r["uploaded"]:
        yt_status = f"OK — {len(r['uploaded'])} publicado(s)"
    elif r["yt_errors"]:
        yt_status = f"FALHOU — {len(r['yt_errors'])} erro(s)"
    elif r["no_new"]:
        yt_status = "nada a publicar (sem vídeos novos)"
    else:
        yt_status = "desconhecido"

    lines = [
        "Projeto Raquel — Resultado do sync diário",
        f"Data: {date_str}",
        f"Status: {status_label}",
        SEP,
        "",
        "📊 RESUMO",
        f"  Banco local   : {r['already_synced']} vídeos já sincronizados",
        f"  Instagram     : {ig_status}",
        f"  YouTube upload: {yt_status}",
        "",
    ]

    # ── Pool e compilados (fluxo 16:9) ──
    if r["pool_added"] or r["pool_free"] or r["compiled"] or r["compile_short"]:
        lines += [
            "🎬 COMPILADOS 16:9",
            f"  Reels novos no pool : {r['pool_added']}",
            f"  Pool livre agora    : {r['pool_free']} clipe(s) · {r['pool_minutes']:.1f} min",
        ]
        if r["compiled"]:
            lines.append(f"  Montados nesta run  : {len(r['compiled'])}")
            for c in r["compiled"]:
                lines.append(f"    {c.strip()}")
        elif r["compile_short"]:
            lines.append("  Nenhum montado — pool ainda abaixo de 8 min")
        lines.append("")

    if r["quarantined"]:
        lines += ["🧪 CLIPES EM QUARENTENA (ilegíveis, fora do pool)"]
        lines += [f"    {q.strip()}" for q in r["quarantined"][:10]]
        lines.append("")

    # ── Diagnóstico de erro ──
    if r["yt_token_dead"]:
        lines += [
            "🔴 CAUSA: TOKEN DO YOUTUBE REVOGADO",
            "  invalid_grant — o refresh token morreu. Nenhuma rodada futura",
            "  publica nada até isto ser refeito à mão. O pool continua crescendo.",
            "",
            "  AÇÃO NECESSÁRIA:",
            "  1. console.cloud.google.com > projeto anatomia-do-discurso",
            "     > APIs e Serviços > Tela de consentimento OAuth > PUBLICAR APP",
            "     (em 'Testing' o refresh token expira em 7 dias e isto se repete)",
            "  2. cd F:\\RichClub\\projeto-raquel",
            "     python deploy\\setup_youtube_auth.py",
            "  3. Na tela de escolha de conta, confirmar que é o canal Raquel Pires",
            "",
        ]
    elif r["compile_errors"]:
        lines += ["❌ CAUSA: FALHA AO MONTAR COMPILADO"]
        lines += [f"  {e.strip()}" for e in r["compile_errors"][:5]]
        lines.append("")

    if r["session_expired"] or r["ig_error_type"] == "401":
        lines += [
            "🔑 CAUSA: AUTENTICAÇÃO REJEITADA (401)",
            "  Instagram recusou o sessionid — expirou ou foi bloqueado por uso intenso.",
            "",
            "  AÇÃO NECESSÁRIA:",
            "  1. Chrome > instagram.com > F12 > Application > Cookies > instagram.com",
            "  2. Copiar valores de: sessionid, csrftoken, ds_user_id",
            "  3. Atualizar .env em F:\\RichClub\\projeto-raquel\\",
            "     INSTAGRAM_SESSION_ID=<novo valor>",
            "     INSTAGRAM_CSRFTOKEN=<novo valor>",
            "     INSTAGRAM_DS_USER_ID=<novo valor>",
            "",
        ]
    elif r["ig_error_type"] == "429":
        lines += [
            "⏸️ CAUSA: RATE LIMIT POR IP",
            "  Instagram bloqueou temporariamente o IP por excesso de requisições.",
            "  Aguardar 30–60 min e tentar novamente.",
            "  Dica: proxy residencial já está configurado — verificar INSTAGRAM_PROXY.",
            "",
        ]
    elif r["ig_fetch_error"]:
        lines += [
            "❌ CAUSA: ERRO AO BUSCAR INSTAGRAM",
            f"  {r['ig_fetch_error']}",
            "",
        ]

    if r["yt_errors"]:
        lines += ["❌ ERROS YOUTUBE:"]
        for e in r["yt_errors"][:5]:
            lines.append(f"  {e}")
        lines.append("")

    # ── Vídeos publicados ──
    if r["uploaded"]:
        lines.append(f"✅ PUBLICADOS ({len(r['uploaded'])}):")
        for url in r["uploaded"]:
            lines.append(f"  {url}")
        lines.append("")

    lines += [SEP, "LOG COMPLETO:", r["raw"]]
    return "\n".join(lines)


def send_email(subject: str, body: str) -> bool:
    if not RESEND_API_KEY:
        print("RESEND_API_KEY não configurada — email não enviado.")
        return False

    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            json={"from": FROM_EMAIL, "to": [TO_EMAIL], "subject": subject, "text": body},
            timeout=15,
        )
        resp.raise_for_status()
        print(f"Email enviado. id={resp.json().get('id')}")
        return True
    except requests.HTTPError as e:
        print(f"Erro ao enviar email: {e.response.status_code} {e.response.text}")
        return False


def main() -> int:
    log = read_last_run_log()
    r = parse_run(log)
    status_label, severity = detect_outcome(r)
    date_str = datetime.now().strftime("%d/%m/%Y %H:%M")

    subject = f"[Raquel] {status_label} — {date_str}"
    body = build_body(r, status_label, date_str)
    send_email(subject, body)

    # O .bat termina neste script, então este código é o "Last Result" que o
    # Task Scheduler mostra. Enquanto ele era sempre 0, o painel dizia sucesso
    # com o canal parado há uma semana.
    return {"critical": 2, "error": 1}.get(severity, 0)


if __name__ == "__main__":
    sys.exit(main())
