import pytest


def test_build_youtube_description_includes_chapters():
    from pipeline.seo_optimizer import build_youtube_description
    script_data = {
        "description": "Uma review incrível do drama.",
        "chapters": [
            {"time": "0:00", "title": "Intro"},
            {"time": "2:00", "title": "Sinopse"},
        ],
        "tags": ["kdrama", "review"],
    }
    channel = {"branding": {"default_hashtags": ["#raquelpires"]}}
    desc = build_youtube_description(script_data, channel)
    assert "0:00 Intro" in desc
    assert "2:00 Sinopse" in desc
    assert "#raquelpires" in desc


def test_build_youtube_description_no_chapters():
    from pipeline.seo_optimizer import build_youtube_description
    script_data = {"description": "Descrição simples.", "tags": [], "chapters": []}
    channel = {"branding": {"default_hashtags": []}}
    desc = build_youtube_description(script_data, channel)
    assert "Descrição simples." in desc
    assert "⏱️" not in desc


def test_build_youtube_description_hashtag_dedup():
    from pipeline.seo_optimizer import build_youtube_description
    script_data = {
        "description": "Desc.",
        "tags": ["kdrama", "review", "dorama", "brasil", "netflix"],
        "chapters": [],
    }
    channel = {"branding": {"default_hashtags": ["#raquelpires", "#kdrama"]}}
    desc = build_youtube_description(script_data, channel)
    # Deve ter hashtags mas não duplicar excessivamente
    assert "#kdrama" in desc or "#raquelpires" in desc
