import os
import requests
from datetime import datetime

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
TO_EMAIL = "andreprol1980@gmail.com"
FROM_EMAIL = "onboarding@resend.dev"


def send_upload_result(title: str, youtube_video_id: str | None, error: str | None = None):
    if not RESEND_API_KEY:
        return

    now = datetime.now().strftime("%d/%m/%Y %H:%M")

    if youtube_video_id:
        subject = f"[Anatomia do Discurso] ✅ Upload OK — {now}"
        body = (
            f"Vídeo publicado com sucesso!\n\n"
            f"Título: {title}\n"
            f"URL: https://www.youtube.com/watch?v={youtube_video_id}\n"
            f"Horário: {now}"
        )
    else:
        subject = f"[Anatomia do Discurso] ❌ Upload FALHOU — {now}"
        body = (
            f"Falha ao publicar vídeo.\n\n"
            f"Título: {title}\n"
            f"Erro: {error}\n"
            f"Horário: {now}"
        )

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
