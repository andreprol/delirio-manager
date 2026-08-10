import json
import re
from pathlib import Path

NICHES_FILE = Path("config/niches.json")


def _load_niches() -> list[dict]:
    return json.loads(NICHES_FILE.read_text())["niches"]


def detect_content_type(text: str) -> str:
    """Detecta o tipo de conteúdo baseado em palavras-chave do texto."""
    text_lower = text.lower()
    niches = _load_niches()

    # Ordem importa: fanmeeting tem prioridade sobre review (mais específico)
    priority_order = ["fanmeeting", "ranking", "review", "short"]
    scores = {n["id"]: 0 for n in niches}

    for niche in niches:
        for kw in niche["keywords_trigger"]:
            if kw in text_lower:
                scores[niche["id"]] += 1

    for content_type in priority_order:
        if scores.get(content_type, 0) > 0:
            return content_type

    return "review"  # fallback


def parse_instagram_post(caption: str, post_url: str = None) -> dict:
    """Converte legenda de post do Instagram em um brief estruturado."""
    content_type = detect_content_type(caption)

    brief = {
        "type": content_type,
        "source": "instagram_post",
        "source_ref": post_url,
        "raw_notes": caption,
        "drama_title": _extract_drama_title(caption),
        "event_name": _extract_event_name(caption) if content_type == "fanmeeting" else None,
        "platform": _extract_platform(caption),
    }
    return brief


def create_manual_brief(
    content_type: str,
    notes: str,
    drama_title: str = None,
    event_name: str = None,
    artists: str = None,
    event_date: str = None,
    event_location: str = None,
    ticket_price: str = None,
    platform: str = None,
) -> dict:
    """Cria um brief manual sem passar pelo Instagram."""
    return {
        "type": content_type,
        "source": "manual",
        "raw_notes": notes,
        "drama_title": drama_title,
        "event_name": event_name,
        "artists": artists,
        "event_date": event_date,
        "event_location": event_location,
        "ticket_price": ticket_price,
        "platform": platform,
    }


def _extract_drama_title(text: str) -> str | None:
    """Tenta extrair o título do drama do texto."""
    # Padrões comuns: "assisti X", "terminei X", "review de X", texto entre aspas
    patterns = [
        r'"([^"]+)"',
        r"'([^']+)'",
        r"(?:assisti|terminei|review de|falando de|sobre)\s+([A-Za-z\s\-:]+?)(?:\s+e\s|\s+que|\s+foi|\s+é|$|\.|,|!|\?)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return None


def _extract_event_name(text: str) -> str | None:
    """Tenta extrair o nome do evento/fan meeting do texto."""
    patterns = [
        r"(?:fan\s?meeting|show|concerto|evento)\s+(?:do?s?\s+)?([A-Za-z\s\-]+?)(?:\s+foi|\s+é|$|\.|,|!|\?)",
        r'"([^"]+(?:fan\s?meeting|show|tour)[^"]*)"',
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return None


def _extract_platform(text: str) -> str | None:
    platforms = {
        "netflix": "Netflix",
        "viki": "Viki",
        "kocowa": "Kocowa",
        "amazon": "Amazon Prime",
        "globoplay": "Globoplay",
        "youtube": "YouTube",
    }
    text_lower = text.lower()
    for key, name in platforms.items():
        if key in text_lower:
            return name
    return None
