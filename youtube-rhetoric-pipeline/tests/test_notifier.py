from unittest.mock import patch, MagicMock
from pipeline import notifier


def _post():
    return patch("pipeline.notifier.requests.post")


def test_api_key_is_read_at_send_time_not_at_import(monkeypatch):
    """
    main.py importa este módulo antes do load_dotenv(). Capturar a chave no
    import faria todo e-mail ser descartado em silêncio — foi o que aconteceu
    desde que o notifier existe.
    """
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    assert notifier._api_key() == ""

    monkeypatch.setenv("RESEND_API_KEY", "re_definida_depois_do_import")
    with _post() as mock_post:
        mock_post.return_value = MagicMock(raise_for_status=lambda: None)
        notifier.send_pipeline_failure("boom")

    assert mock_post.called
    header = mock_post.call_args.kwargs["headers"]["Authorization"]
    assert header == "Bearer re_definida_depois_do_import"


def test_no_email_without_key(monkeypatch):
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    with _post() as mock_post:
        notifier.send_slot_summary([])
    mock_post.assert_not_called()


def test_empty_queue_still_sends_email(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "re_fake")
    with _post() as mock_post:
        mock_post.return_value = MagicMock(raise_for_status=lambda: None)
        notifier.send_slot_summary([])
    assert "Fila vazia" in mock_post.call_args.kwargs["json"]["subject"]


def test_upload_failure_email_carries_traceback(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "re_fake")
    with _post() as mock_post:
        mock_post.return_value = MagicMock(raise_for_status=lambda: None)
        notifier.send_upload_failure("invalid_grant", "Traceback: linha 1")

    payload = mock_post.call_args.kwargs["json"]
    assert "UPLOAD FALHOU" in payload["subject"]
    assert "invalid_grant" in payload["text"]
    assert "Traceback: linha 1" in payload["text"]


def test_pipeline_summary_lists_long_and_shorts(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "re_fake")
    with _post() as mock_post:
        mock_post.return_value = MagicMock(raise_for_status=lambda: None)
        notifier.send_pipeline_summary(
            [{"title": "Vídeo longo", "shorts": 2, "slot": "2026-08-23T12:00:00"}], []
        )

    text = mock_post.call_args.kwargs["json"]["text"]
    assert "Vídeo longo" in text
    assert "2 short(s)" in text


def test_send_failure_is_logged_not_swallowed(monkeypatch, caplog):
    monkeypatch.setenv("RESEND_API_KEY", "re_fake")
    with _post() as mock_post:
        mock_post.side_effect = RuntimeError("resend fora do ar")
        notifier.send_slot_summary([])

    assert "resend fora do ar" in caplog.text
