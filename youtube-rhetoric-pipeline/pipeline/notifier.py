import os
import logging
import requests
from datetime import datetime

log = logging.getLogger(__name__)

TO_EMAIL = "andreprol1980@gmail.com"
FROM_EMAIL = "onboarding@resend.dev"


def _api_key() -> str:
    """
    Lido a cada envio, nunca no import: este módulo é importado por main.py
    antes do load_dotenv(), então um valor capturado no import seria sempre
    string vazia e todo e-mail sairia descartado em silêncio.
    """
    return os.environ.get("RESEND_API_KEY", "")


def _send(subject: str, body: str) -> None:
    api_key = _api_key()
    if not api_key:
        log.warning("RESEND_API_KEY ausente — e-mail não enviado: %s", subject)
        return
    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"from": FROM_EMAIL, "to": [TO_EMAIL], "subject": subject, "text": body},
            timeout=15,
        )
        resp.raise_for_status()
    except Exception as exc:
        # Engolir a exceção mantém o run vivo, mas sem log seria outra falha
        # silenciosa — exatamente o que este módulo existe para evitar.
        log.warning("falha ao enviar e-mail '%s': %s", subject, exc)


def send_pipeline_failure(error: str, traceback_text: str = "") -> None:
    """
    Crash do run de processamento. Sem isto o pipeline morre antes de qualquer
    notificação e o canal simplesmente para de publicar sem aviso — foi o que
    aconteceu de 16/08 a 22/08/2026.
    """
    now = datetime.now().strftime("%d/%m/%Y %H:%M")
    body = f"O run de processamento das {now} falhou.\n\nErro: {error}"
    if traceback_text:
        body += f"\n\n--- Traceback ---\n{traceback_text}"
    _send(f"[Anatomia do Discurso] 🔴 PIPELINE FALHOU — {now}", body)


def send_upload_failure(error: str, traceback_text: str = "") -> None:
    """
    Crash do slot de upload antes do resumo — tipicamente OAuth `invalid_grant`,
    que neste projeto reaparece a cada 7 dias enquanto o app está em "Testing".
    """
    now = datetime.now().strftime("%d/%m/%Y %H:%M")
    body = f"O slot de upload das {now} falhou antes de publicar.\n\nErro: {error}"
    if traceback_text:
        body += f"\n\n--- Traceback ---\n{traceback_text}"
    _send(f"[Anatomia do Discurso] 🔴 UPLOAD FALHOU — {now}", body)


def send_pipeline_summary(produced: list[dict], errors: list[dict]) -> None:
    """Resumo do run de processamento: o que entrou na fila e o que falhou."""
    now = datetime.now().strftime("%d/%m/%Y %H:%M")

    if not produced and not errors:
        _send(
            f"[Anatomia do Discurso] ⏸ Nada novo para processar — {now}",
            f"O run das {now} rodou e não encontrou vídeos novos do creator.",
        )
        return

    if errors:
        subject = f"[Anatomia do Discurso] ⚠️ {len(produced)} processado(s) / {len(errors)} erro(s) — {now}"
    else:
        subject = f"[Anatomia do Discurso] 🎬 {len(produced)} vídeo(s) na fila — {now}"

    lines = [f"Run {now}\n"]
    for item in produced:
        lines.append(
            f"🎬 {item['title']}\n"
            f"   1 longo 16:9 + {item['shorts']} short(s) — próximo slot: {item['slot']}"
        )
    for item in errors:
        lines.append(f"❌ {item['source_video_id']}\n   Erro: {item['error']}")

    _send(subject, "\n\n".join(lines))


def send_slot_summary(results: list[dict]) -> None:
    """
    Envia 1 e-mail por slot de upload.
    results: lista de dicts com keys: title, youtube_video_id (str|None), error (str|None)
    Se results vazio, envia aviso de fila vazia.
    """
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

    _send(subject, body)


def send_upload_result(title: str, youtube_video_id: str | None, error: str | None = None):
    """Compatibilidade — delega para send_slot_summary."""
    send_slot_summary([{"title": title, "youtube_video_id": youtube_video_id, "error": error}])
