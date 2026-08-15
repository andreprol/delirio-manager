import os
import requests
from datetime import datetime

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
TO_EMAIL = "andreprol1980@gmail.com"
FROM_EMAIL = "onboarding@resend.dev"


def send_slot_summary(results: list[dict]) -> None:
    """
    Envia 1 e-mail por slot de upload.
    results: lista de dicts com keys: title, youtube_video_id (str|None), error (str|None)
    Se results vazio, envia aviso de fila vazia.
    """
    if not RESEND_API_KEY:
        return

    now = datetime.now().strftime("%d/%m/%Y %H:%M")

    if not results:
        subject = f"[Anatomia do Discurso] ⏸ Fila vazia — {now}"
        body = f"Slot de upload das {now} executou mas não havia vídeos na fila.\n\nHorário: {now}"
    else:
        ok = [r for r in results if r.get("youtube_video_id")]
        fail = [r for r in results if not r.get("youtube_video_id")]

        if fail:
            subject = f"[Anatomia do Discurso] ⚠️ {len(ok)} OK / {len(fail)} FALHA — {now}"
        else:
            subject = f"[Anatomia do Discurso] ✅ {len(ok)} publicado(s) — {now}"

        lines = [f"Slot {now}\n"]

        for r in ok:
            url = f"https://www.youtube.com/watch?v={r['youtube_video_id']}"
            lines.append(f"✅ {r['title']}\n   {url}")

        for r in fail:
            lines.append(f"❌ {r['title']}\n   Erro: {r.get('error', 'desconhecido')}")

        body = "\n\n".join(lines)

    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            json={"from": FROM_EMAIL, "to": [TO_EMAIL], "subject": subject, "text": body},
            timeout=15,
        )
        resp.raise_for_status()
    except Exception:
        pass


def send_upload_result(title: str, youtube_video_id: str | None, error: str | None = None):
    """Compatibilidade — delega para send_slot_summary."""
    send_slot_summary([{"title": title, "youtube_video_id": youtube_video_id, "error": error}])
