"""
Lê o sync.log e envia email com resultado via Resend.
Chamado pelo sync_daily.bat após o sync.
"""
import os
import sys
from pathlib import Path
from datetime import datetime

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

LOG_PATH = Path(__file__).parent.parent / "data" / "sync.log"
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
TO_EMAIL = "andreprol1980@gmail.com"
FROM_EMAIL = "onboarding@resend.dev"


def read_last_run_log() -> str:
    if not LOG_PATH.exists():
        return "(sync.log não encontrado)"
    lines = LOG_PATH.read_text(encoding="utf-8", errors="replace").strip().splitlines()
    # Últimas 50 linhas
    return "\n".join(lines[-50:])


def detect_outcome(log: str) -> tuple[str, str]:
    log_lower = log.lower()
    if "uploaded" in log_lower or "publicado" in log_lower or "youtu.be" in log_lower:
        return "✅ Sucesso", "success"
    if "nenhum vídeo novo" in log_lower or "already synced" in log_lower or "nenhum novo" in log_lower:
        return "ℹ️ Nenhum vídeo novo", "info"
    if "429" in log or "rate limit" in log_lower:
        return "⚠️ Rate limit Instagram (429)", "warning"
    if "error" in log_lower or "traceback" in log_lower or "exception" in log_lower:
        return "❌ Erro", "error"
    return "⚠️ Resultado incerto", "warning"


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
    status_label, _ = detect_outcome(log)
    date_str = datetime.now().strftime("%d/%m/%Y %H:%M")

    subject = f"[Projeto Raquel] Sync Instagram → YouTube — {status_label} — {date_str}"
    body = f"""Projeto Raquel — Resultado do sync diário
Data: {date_str}
Status: {status_label}

--- LOG (últimas 50 linhas) ---
{log}
"""
    send_email(subject, body)


if __name__ == "__main__":
    main()
