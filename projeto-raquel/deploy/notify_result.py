"""
Lê o run_current.log e envia email com resultado via Resend.
Chamado pelo sync_daily.bat após o sync.
"""
import os
import re
from pathlib import Path
from datetime import datetime

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

LOG_PATH = Path(__file__).parent.parent / "data" / "run_current.log"
ARCHIVE_LOG = Path(__file__).parent.parent / "data" / "sync.log"
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
        "uploaded": [],
        "errors": [],
        "no_new": False,
        "session_expired": False,
        "rate_limited": False,
        "already_synced": 0,
        "raw": log,
    }

    for line in log.splitlines():
        line_lower = line.lower()
        if "ok publicado: https://youtu.be/" in line_lower:
            url = re.search(r"https://youtu\.be/\S+", line)
            if url:
                result["uploaded"].append(url.group())
        elif "session_expirada" in line_lower or "401" in line and "session" in line_lower:
            result["session_expired"] = True
        elif "429" in line or "rate-limited" in line_lower:
            result["rate_limited"] = True
        elif "nenhum vídeo novo" in line_lower:
            result["no_new"] = True
        elif "erro" in line_lower and ("upload" in line_lower or "traceback" in line_lower):
            result["errors"].append(line.strip())
        elif "posts já sincronizados no banco" in line_lower:
            m = re.search(r"(\d+) posts", line)
            if m:
                result["already_synced"] = int(m.group(1))

    return result


def detect_outcome(r: dict) -> tuple[str, str]:
    if r["session_expired"]:
        return "🔑 SESSION EXPIRADA — ação necessária", "critical"
    if r["uploaded"]:
        return f"✅ {len(r['uploaded'])} vídeo(s) publicado(s)", "success"
    if r["rate_limited"]:
        return "⚠️ Rate limit Instagram (429)", "warning"
    if r["errors"]:
        return "❌ Erro no upload", "error"
    if r["no_new"]:
        return "ℹ️ Nenhum vídeo novo", "info"
    return "⚠️ Resultado incerto", "warning"


def build_body(r: dict, status_label: str, date_str: str) -> str:
    lines = [
        f"Projeto Raquel — Resultado do sync diário",
        f"Data: {date_str}",
        f"Status: {status_label}",
        f"Já sincronizados no banco: {r['already_synced']}",
        "",
    ]

    if r["session_expired"]:
        lines += [
            "AÇÃO NECESSÁRIA:",
            "  1. Abra o Chrome e acesse instagram.com",
            "  2. F12 > Application > Cookies > instagram.com",
            "  3. Copie o valor de 'sessionid'",
            "  4. Atualize INSTAGRAM_SESSION_ID no .env",
            "",
        ]

    if r["uploaded"]:
        lines.append(f"Publicados ({len(r['uploaded'])}):")
        for url in r["uploaded"]:
            lines.append(f"  {url}")
        lines.append("")

    if r["errors"]:
        lines.append("Erros:")
        for e in r["errors"][:5]:
            lines.append(f"  {e}")
        lines.append("")

    lines += [
        "--- LOG COMPLETO ---",
        r["raw"],
    ]

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


def main():
    log = read_last_run_log()
    r = parse_run(log)
    status_label, _ = detect_outcome(r)
    date_str = datetime.now().strftime("%d/%m/%Y %H:%M")

    subject = f"[Raquel] {status_label} — {date_str}"
    body = build_body(r, status_label, date_str)
    send_email(subject, body)


if __name__ == "__main__":
    main()
