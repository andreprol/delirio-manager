"""Alerta por e-mail dos slots do pipeline.

Existe porque falha silenciosa custou dois dias de canal mudo em 20-21/08/2026:
o refresh token do YouTube expirou, `run_upload` engoliu a exceção e a task do
Scheduler continuou marcando sucesso. Ninguém ficou sabendo.

Regra: **todo slot manda e-mail** — sucesso, falha ou nada a fazer. Assim a
ausência de e-mail também é sinal de problema.

Resend em free tier só entrega para o e-mail do dono da conta.
"""
import logging
import os
from datetime import datetime
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent.parent / ".env")

log = logging.getLogger(__name__)

TO_EMAIL = "andreprol1980@gmail.com"
FROM_EMAIL = "onboarding@resend.dev"

# Ler a chave DENTRO da função, nunca como constante de módulo: constante roda
# no import e pode preceder o load_dotenv de quem importa, virando string vazia.
UNDELIVERED_LOG = Path(__file__).parent.parent / "data" / "alerts_undelivered.log"

STATUS_STYLE = {
    "ok": ("#22c55e", "OK"),
    "warn": ("#f59e0b", "ATENÇÃO"),
    "fail": ("#ef4444", "FALHA"),
}


def _build_html(title: str, lines: list[str], status: str) -> str:
    color, label = STATUS_STYLE.get(status, STATUS_STYLE["warn"])
    body = "".join(
        f'<p style="margin:0 0 8px;color:#e2e8f0;font-family:monospace;'
        f'font-size:13px;line-height:1.6;">{line}</p>'
        for line in lines
    )
    return f"""
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0f0f1a;padding:32px;border-radius:8px;">
      <h1 style="color:#7c3aed;margin:0 0 4px;font-size:22px;">🎧 Umbra Sessions</h1>
      <p style="margin:0 0 20px;">
        <span style="background:{color};color:#0f0f1a;font-size:12px;font-weight:700;
                     padding:3px 10px;border-radius:3px;letter-spacing:1px;">{label}</span>
        <span style="color:#94a3b8;font-size:14px;margin-left:8px;">{title}</span>
      </p>
      <div style="padding:16px;background:#1a1a2e;border-left:4px solid {color};border-radius:4px;">
        {body}
      </div>
    </div>"""


def record_undelivered(title: str, lines: list[str]):
    """Registra em disco o alerta que não conseguiu sair.

    Último recurso: as tasks do Scheduler não redirecionam log, então um alerta
    perdido some sem deixar rastro. Este arquivo é o rastro.
    """
    try:
        UNDELIVERED_LOG.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().isoformat(timespec="seconds")
        with UNDELIVERED_LOG.open("a", encoding="utf-8") as fh:
            fh.write(f"[{stamp}] {title}\n")
            for line in lines:
                fh.write(f"    {line}\n")
    except Exception as e:  # nunca mascarar o erro original
        log.error("Não consegui nem gravar o alerta não entregue: %s", e)


def notify(title: str, lines: list[str], status: str = "ok") -> bool:
    """Manda o alerta. Nunca levanta exceção — falha de e-mail não pode
    mascarar o erro real que motivou o alerta."""
    RESEND_API_KEY = os.getenv("RESEND_API_KEY", "").strip()
    if not RESEND_API_KEY or RESEND_API_KEY.endswith("your_resend_key_here"):
        log.error("RESEND_API_KEY ausente — alerta NÃO enviado: %s", title)
        record_undelivered(title, lines)
        return False

    prefix = {"ok": "✅", "warn": "⚠️", "fail": "🔴"}.get(status, "⚠️")
    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}",
                     "Content-Type": "application/json"},
            json={
                "from": FROM_EMAIL,
                "to": [TO_EMAIL],
                "subject": f"{prefix} Umbra Sessions — {title}",
                "html": _build_html(title, lines, status),
            },
            timeout=15,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        log.error("Falha ao enviar alerta '%s': %s", title, e)
        record_undelivered(title, lines + [f"Erro no envio: {e}"])
        return False
