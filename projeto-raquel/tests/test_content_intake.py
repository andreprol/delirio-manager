import pytest
from unittest.mock import patch, mock_open
import json

NICHES_DATA = json.dumps({"niches": [
    {"id": "review", "keywords_trigger": ["assisti", "terminei", "drama", "kdrama"], "target_duration_min": 8, "target_duration_max": 15, "shorts_count": 2, "evergreen": True},
    {"id": "fanmeeting", "keywords_trigger": ["fan meeting", "fanmeeting", "show", "evento"], "target_duration_min": 12, "target_duration_max": 20, "shorts_count": 3, "evergreen": False},
    {"id": "ranking", "keywords_trigger": ["top", "ranking", "melhores", "favoritos"], "target_duration_min": 6, "target_duration_max": 12, "shorts_count": 1, "evergreen": True},
    {"id": "short", "keywords_trigger": [], "target_duration_min": 0, "target_duration_max": 1, "shorts_count": 0, "evergreen": True},
]})


@patch("builtins.open", mock_open(read_data=NICHES_DATA))
@patch("pipeline.content_intake.NICHES_FILE")
def test_detect_review(mock_path, tmp_path):
    mock_path.read_text.return_value = NICHES_DATA
    from pipeline.content_intake import detect_content_type
    assert detect_content_type("terminei de assistir esse kdrama incrível") == "review"


@patch("pipeline.content_intake.NICHES_FILE")
def test_detect_fanmeeting(mock_path):
    mock_path.read_text.return_value = NICHES_DATA
    from pipeline.content_intake import detect_content_type
    assert detect_content_type("fui ao fan meeting do BTS ontem, que experiência!") == "fanmeeting"


@patch("pipeline.content_intake.NICHES_FILE")
def test_detect_ranking(mock_path):
    mock_path.read_text.return_value = NICHES_DATA
    from pipeline.content_intake import detect_content_type
    assert detect_content_type("top 10 melhores doramas de 2026") == "ranking"


@patch("pipeline.content_intake.NICHES_FILE")
def test_parse_instagram_post_extracts_platform(mock_path):
    mock_path.read_text.return_value = NICHES_DATA
    from pipeline.content_intake import parse_instagram_post
    result = parse_instagram_post("Assisti esse drama na Netflix e amei!")
    assert result["platform"] == "Netflix"


@patch("pipeline.content_intake.NICHES_FILE")
def test_parse_instagram_post_no_platform(mock_path):
    mock_path.read_text.return_value = NICHES_DATA
    from pipeline.content_intake import parse_instagram_post
    result = parse_instagram_post("Que drama lindo, super recomendo!")
    assert result["platform"] is None


def test_create_manual_brief_review():
    from pipeline.content_intake import create_manual_brief
    brief = create_manual_brief(
        content_type="review",
        notes="Drama incrível, chorei muito",
        drama_title="Crash Landing on You",
        platform="Netflix",
    )
    assert brief["type"] == "review"
    assert brief["drama_title"] == "Crash Landing on You"
    assert brief["platform"] == "Netflix"
    assert brief["source"] == "manual"


def test_create_manual_brief_fanmeeting():
    from pipeline.content_intake import create_manual_brief
    brief = create_manual_brief(
        content_type="fanmeeting",
        notes="Evento incrível no Rio",
        event_name="BTS Fan Meeting Brasil",
        artists="BTS",
        event_date="2026-08-10",
        event_location="Rio de Janeiro",
        ticket_price="R$ 350",
    )
    assert brief["type"] == "fanmeeting"
    assert brief["event_name"] == "BTS Fan Meeting Brasil"
    assert brief["ticket_price"] == "R$ 350"
