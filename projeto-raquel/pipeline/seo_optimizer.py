import json
from pathlib import Path
import anthropic


BLOG_PROMPT_FILE = Path("prompts/blog_article.txt")


def generate_blog_article(
    brief: dict,
    script_data: dict,
    youtube_url: str,
    api_key: str,
) -> dict:
    """
    Gera artigo de blog SEO a partir do brief + script do vídeo.
    Retorna dict com slug, meta_title, meta_description, h1, article_html.
    """
    prompt_template = BLOG_PROMPT_FILE.read_text()

    content_type = brief.get("type", "review")
    subject = brief.get("drama_title") or brief.get("event_name") or "Conteúdo"

    blog_keywords = script_data.get("blog_keywords", [])
    primary_keyword = blog_keywords[0] if blog_keywords else f"review {subject}"
    secondary_keywords = ", ".join(blog_keywords[1:]) if len(blog_keywords) > 1 else primary_keyword

    # Excerpt do script para contexto (primeiros 1500 chars)
    script_excerpt = (script_data.get("script") or "")[:1500]

    prompt = prompt_template.format(
        content_type=content_type,
        subject=subject,
        primary_keyword=primary_keyword,
        secondary_keywords=secondary_keywords,
        video_script_excerpt=script_excerpt,
        youtube_url=youtube_url,
    )

    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-sonnet-5",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = message.content[0].text.strip()
    if raw.startswith("```"):
        lines = raw.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        raw = "\n".join(lines).strip()

    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"JSON inválido do artigo: {e}\nRaw: {raw[:500]}") from e


def build_youtube_description(script_data: dict, channel_config: dict) -> str:
    """Monta a descrição final do YouTube com capítulos + hashtags + CTA."""
    description = script_data.get("description", "")

    chapters = script_data.get("chapters", [])
    if chapters:
        chapters_text = "\n".join(f"{c['time']} {c['title']}" for c in chapters)
        description += f"\n\n⏱️ Capítulos:\n{chapters_text}"

    hashtags = channel_config.get("branding", {}).get("default_hashtags", [])
    tags_from_script = script_data.get("tags", [])
    all_tags = tags_from_script[:5] + hashtags
    hashtag_line = " ".join(f"#{t.lstrip('#')}" for t in all_tags[:8])
    description += f"\n\n{hashtag_line}"

    return description.strip()
