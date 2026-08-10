import json
import os
import hmac
import hashlib
import urllib.request
import urllib.error
from pathlib import Path


SORO_CONFIG_FILE = Path("config/soro.json")


def _load_soro_config() -> dict:
    return json.loads(SORO_CONFIG_FILE.read_text())


def publish_article(article_data: dict) -> bool:
    """
    Publica artigo no blog via webhook.
    Retorna True se publicado com sucesso.

    Quando Soro IA estiver configurada, o webhook recebe o artigo e publica.
    Enquanto não estiver, salva localmente para publicação manual.
    """
    config = _load_soro_config()

    if not config.get("enabled"):
        _save_article_locally(article_data)
        return False

    webhook_url = config.get("publish_webhook_url") or os.getenv("SORO_WEBHOOK_URL")
    if not webhook_url:
        _save_article_locally(article_data)
        return False

    payload = json.dumps(article_data).encode("utf-8")
    headers = {"Content-Type": "application/json"}

    secret = os.getenv("SORO_WEBHOOK_SECRET")
    if secret:
        sig = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
        headers["X-Webhook-Signature"] = f"sha256={sig}"

    req = urllib.request.Request(webhook_url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status in (200, 201, 202)
    except urllib.error.URLError as e:
        raise RuntimeError(f"Falha ao publicar artigo no blog: {e}") from e


def _save_article_locally(article_data: dict):
    """Salva o artigo em data/articles/ para publicação manual."""
    output_dir = Path("data/articles")
    output_dir.mkdir(parents=True, exist_ok=True)
    slug = article_data.get("slug", "artigo")
    output_path = output_dir / f"{slug}.json"
    output_path.write_text(json.dumps(article_data, ensure_ascii=False, indent=2))
    print(f"  Artigo salvo localmente: {output_path}")
    print(f"  Configure config/soro.json para publicar automaticamente.")
