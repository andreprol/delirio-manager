import json
from pathlib import Path
import anthropic


PROMPTS_DIR = Path("prompts")
NICHES_FILE = Path("config/niches.json")


def _load_prompt(content_type: str) -> str:
    prompt_map = {
        "review": "script_review.txt",
        "fanmeeting": "script_fanmeeting.txt",
        "ranking": "script_review.txt",  # ranking usa template de review com adaptações
        "short": "script_review.txt",
    }
    filename = prompt_map.get(content_type, "script_review.txt")
    return (PROMPTS_DIR / filename).read_text()


def _get_niche_config(content_type: str) -> dict:
    niches = json.loads(NICHES_FILE.read_text())["niches"]
    return next((n for n in niches if n["id"] == content_type), niches[0])


def generate_script(brief: dict, api_key: str) -> dict:
    """
    Gera script completo a partir de um content brief usando Claude.
    Retorna dict com title, description, tags, chapters, script, shorts_hooks, blog_keywords.
    """
    content_type = brief.get("type", "review")
    niche = _get_niche_config(content_type)
    prompt_template = _load_prompt(content_type)

    # Preenche variáveis do template
    prompt = prompt_template.format(
        drama_title=brief.get("drama_title") or "Drama não especificado",
        event_name=brief.get("event_name") or "Evento não especificado",
        artists=brief.get("artists") or "Artista não especificado",
        event_date=brief.get("event_date") or "Data não informada",
        event_location=brief.get("event_location") or "Local não informado",
        ticket_price=brief.get("ticket_price") or "Não informado",
        platform=brief.get("platform") or "Plataforma de streaming",
        raw_notes=brief.get("raw_notes") or "",
        target_duration_min=niche["target_duration_min"],
        target_duration_max=niche["target_duration_max"],
    )

    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-sonnet-5",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    text_block = next(b for b in message.content if hasattr(b, "text"))
    raw = text_block.text.strip()
    raw = _strip_code_fences(raw)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"JSON inválido retornado pelo Claude: {e}\nRaw: {raw[:500]}") from e

    return data


def _strip_code_fences(text: str) -> str:
    if text.startswith("```"):
        lines = text.split("\n")
        # Remove primeira e última linha se forem fences
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return text
