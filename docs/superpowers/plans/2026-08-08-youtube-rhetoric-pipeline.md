# YouTube Rhetoric Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pipeline Python que monitora canal do Marçal, extrai clips, gera análise de retórica narrada por IA e publica 3 vídeos/dia automaticamente no YouTube.

**Architecture:** Cada módulo é independente com interface clara (input/output tipados). O orquestrador `main.py` encadeia os módulos. SQLite persiste estado entre execuções. Cron dispara `main.py` a cada 30 minutos no servidor.

**Tech Stack:** Python 3.12, pytest, yt-dlp, openai-whisper, anthropic SDK, ElevenLabs API, ffmpeg, google-api-python-client, SQLite

---

## File Map

| Arquivo | Responsabilidade |
|---|---|
| `pipeline/queue.py` | SQLite schema + CRUD (estado do pipeline) |
| `pipeline/monitor.py` | YouTube Data API — detecta vídeos novos |
| `pipeline/downloader.py` | yt-dlp — baixa vídeo MP4 |
| `pipeline/transcriber.py` | Whisper — transcreve com timestamps |
| `pipeline/analyzer.py` | Anthropic API — extrai retórica + gera script |
| `pipeline/narrator.py` | ElevenLabs — sintetiza narração MP3 |
| `pipeline/editor.py` | ffmpeg — monta vídeo final (16:9 + 9:16) |
| `pipeline/uploader.py` | YouTube Data API — faz upload com metadados |
| `main.py` | Orquestrador — encadeia módulos, lê config |
| `config/creators.json` | Lista de creators monitorados |
| `config/persona.json` | Nome, voz ID, tom da persona |
| `config/schedule.json` | Slots de upload diários |
| `prompts/rhetoric_analysis.txt` | Prompt base para Claude |
| `tests/test_queue.py` | Testa CRUD SQLite |
| `tests/test_monitor.py` | Testa detecção de vídeos (mock API) |
| `tests/test_downloader.py` | Testa download (mock subprocess) |
| `tests/test_transcriber.py` | Testa transcrição (mock whisper) |
| `tests/test_analyzer.py` | Testa análise IA (mock Anthropic) |
| `tests/test_narrator.py` | Testa narração (mock ElevenLabs) |
| `tests/test_editor.py` | Testa montagem (mock subprocess) |
| `tests/test_uploader.py` | Testa upload (mock YouTube API) |

---

## Task 1: Project Setup

**Files:**
- Create: `requirements.txt`
- Create: `.env.example`
- Create: `config/creators.json`
- Create: `config/persona.json`
- Create: `config/schedule.json`
- Create: `prompts/rhetoric_analysis.txt`
- Create: `pipeline/__init__.py`
- Create: `tests/__init__.py`

- [ ] **Step 1: Criar diretório do projeto e estrutura**

```bash
mkdir -p F:/RichClub/youtube-rhetoric-pipeline
cd F:/RichClub/youtube-rhetoric-pipeline
mkdir -p pipeline tests config prompts assets data
touch pipeline/__init__.py tests/__init__.py
git init
echo ".env" >> .gitignore
echo "data/" >> .gitignore
echo "*.mp4" >> .gitignore
echo "*.mp3" >> .gitignore
echo "__pycache__/" >> .gitignore
echo ".venv/" >> .gitignore
```

- [ ] **Step 2: Criar requirements.txt**

```
yt-dlp==2024.11.4
openai-whisper==20231117
anthropic==0.40.0
elevenlabs==1.9.0
google-api-python-client==2.155.0
google-auth-oauthlib==1.2.1
ffmpeg-python==0.2.0
python-dotenv==1.0.1
pytest==8.3.4
pytest-mock==3.14.0
```

- [ ] **Step 3: Criar .env.example**

```bash
YOUTUBE_API_KEY=your_youtube_data_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key
YOUTUBE_CLIENT_SECRETS_FILE=config/client_secrets.json
DB_PATH=data/pipeline.db
TEMP_DIR=data/temp
```

- [ ] **Step 4: Criar config/creators.json**

```json
[
  {
    "handle": "pablomarcall",
    "channel_id": "UCbroBIg8zvIH8-F4631wJhA",
    "name": "Pablo Marçal",
    "active": true
  }
]
```

- [ ] **Step 5: Criar config/persona.json**

```json
{
  "name": "Prof. Retórica",
  "voice_id": "REPLACE_WITH_ELEVENLABS_VOICE_ID",
  "tone": "analytical, educational, Brazilian Portuguese",
  "max_narration_chars": 800
}
```

- [ ] **Step 6: Criar config/schedule.json**

```json
{
  "upload_slots_brt": ["12:00", "18:00", "21:00"],
  "max_per_day": 3
}
```

- [ ] **Step 7: Criar prompts/rhetoric_analysis.txt**

```
Você é um especialista em retórica e comunicação persuasiva. Analise a transcrição abaixo de um vídeo de Pablo Marçal.

TAREFA:
1. Identifique o trecho mais rico em técnicas retóricas (60–100 segundos de duração)
2. Nomeie as técnicas usadas (ex: apelo à autoridade, ethos, storytelling, urgência, prova social)
3. Escreva um script de narração em português BR explicando essas técnicas (máximo 800 caracteres)
4. Crie um título chamativo para o YouTube (máximo 70 caracteres)
5. Crie uma descrição SEO (máximo 300 caracteres)
6. Liste 5 tags relevantes

TRANSCRIÇÃO:
{transcription}

Responda APENAS com JSON válido no formato:
{
  "clip_start": <float, segundos>,
  "clip_end": <float, segundos>,
  "techniques": ["técnica1", "técnica2"],
  "narration_script": "<texto de narração, máx 800 chars>",
  "title": "<título YouTube, máx 70 chars>",
  "description": "<descrição SEO, máx 300 chars>",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}
```

- [ ] **Step 8: Instalar dependências**

```bash
python -m venv .venv
source .venv/bin/activate   # Linux/Mac
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

- [ ] **Step 9: Commit inicial**

```bash
git add .
git commit -m "chore: project setup — structure, requirements, config"
```

---

## Task 2: Database + Queue Manager

**Files:**
- Create: `pipeline/queue.py`
- Create: `tests/test_queue.py`

- [ ] **Step 1: Escrever test_queue.py**

```python
import pytest
import json
from pathlib import Path
from pipeline.queue import init_db, is_processed, mark_pending, mark_done, enqueue_output, get_due_uploads, mark_uploaded, next_upload_slot

@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    init_db()

def test_is_processed_returns_false_for_new_video():
    assert is_processed("vid123") is False

def test_mark_pending_then_done_marks_processed():
    mark_pending("vid123", "pablomarcall", "Test Title", "2026-08-08T12:00:00")
    assert is_processed("vid123") is False
    mark_done("vid123")
    assert is_processed("vid123") is True

def test_mark_pending_idempotent():
    mark_pending("vid123", "pablomarcall", "Title", "2026-08-08T12:00:00")
    mark_pending("vid123", "pablomarcall", "Title", "2026-08-08T12:00:00")  # no exception
    assert is_processed("vid123") is False

def test_enqueue_output_and_get_due_uploads():
    enqueue_output("vid123", 10.5, 70.0, "Título", "Desc", ["tag1"], "2000-01-01T12:00:00")
    due = get_due_uploads()
    assert len(due) == 1
    assert due[0]["title"] == "Título"
    assert due[0]["clip_start"] == 10.5
    assert json.loads(due[0]["tags"]) == ["tag1"]

def test_get_due_uploads_excludes_future():
    enqueue_output("vid123", 0.0, 60.0, "T", "D", [], "2099-12-31T23:59:00")
    assert get_due_uploads() == []

def test_mark_uploaded():
    enqueue_output("vid123", 0.0, 60.0, "T", "D", [], "2000-01-01T12:00:00")
    due = get_due_uploads()
    mark_uploaded(due[0]["id"], "yt-abc123")
    assert get_due_uploads() == []

def test_next_upload_slot_returns_first_free():
    schedule = ["12:00", "18:00", "21:00"]
    slot = next_upload_slot(schedule)
    assert "12:00" in slot

def test_next_upload_slot_skips_taken():
    schedule = ["12:00", "18:00", "21:00"]
    slot1 = next_upload_slot(schedule)
    enqueue_output("v1", 0, 60, "T", "D", [], slot1)
    slot2 = next_upload_slot(schedule)
    assert slot2 != slot1
```

- [ ] **Step 2: Rodar para confirmar falha**

```bash
pytest tests/test_queue.py -v
```
Expected: `ModuleNotFoundError: No module named 'pipeline.queue'`

- [ ] **Step 3: Implementar pipeline/queue.py**

```python
import sqlite3
import json
import os
from pathlib import Path
from datetime import datetime, timedelta

def _db_path() -> Path:
    return Path(os.getenv("DB_PATH", "data/pipeline.db"))

def _conn():
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    return con

def init_db():
    con = _conn()
    con.executescript("""
        CREATE TABLE IF NOT EXISTS source_videos (
            id TEXT PRIMARY KEY,
            creator TEXT NOT NULL,
            title TEXT,
            published_at TEXT,
            processed_at TEXT,
            status TEXT DEFAULT 'pending'
        );
        CREATE TABLE IF NOT EXISTS output_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_video_id TEXT,
            clip_start REAL,
            clip_end REAL,
            title TEXT,
            description TEXT,
            tags TEXT,
            scheduled_time TEXT,
            uploaded_at TEXT,
            youtube_video_id TEXT,
            status TEXT DEFAULT 'queued'
        );
    """)
    con.commit()
    con.close()

def is_processed(video_id: str) -> bool:
    con = _conn()
    row = con.execute(
        "SELECT id FROM source_videos WHERE id = ? AND status = 'done'", (video_id,)
    ).fetchone()
    con.close()
    return row is not None

def mark_pending(video_id: str, creator: str, title: str, published_at: str):
    con = _conn()
    con.execute(
        "INSERT OR IGNORE INTO source_videos (id, creator, title, published_at) VALUES (?, ?, ?, ?)",
        (video_id, creator, title, published_at),
    )
    con.commit()
    con.close()

def mark_done(video_id: str):
    con = _conn()
    con.execute(
        "UPDATE source_videos SET status = 'done', processed_at = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), video_id),
    )
    con.commit()
    con.close()

def enqueue_output(source_video_id: str, clip_start: float, clip_end: float,
                   title: str, description: str, tags: list, scheduled_time: str):
    con = _conn()
    con.execute(
        """INSERT INTO output_queue
           (source_video_id, clip_start, clip_end, title, description, tags, scheduled_time)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (source_video_id, clip_start, clip_end, title, description, json.dumps(tags), scheduled_time),
    )
    con.commit()
    con.close()

def get_due_uploads() -> list[dict]:
    con = _conn()
    now = datetime.utcnow().isoformat()
    rows = con.execute(
        "SELECT * FROM output_queue WHERE status = 'queued' AND scheduled_time <= ? ORDER BY scheduled_time",
        (now,),
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]

def mark_uploaded(queue_id: int, youtube_video_id: str):
    con = _conn()
    con.execute(
        "UPDATE output_queue SET status = 'done', uploaded_at = ?, youtube_video_id = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), youtube_video_id, queue_id),
    )
    con.commit()
    con.close()

def next_upload_slot(schedule: list[str]) -> str:
    con = _conn()
    for days_ahead in range(7):
        day = (datetime.utcnow() + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
        for slot in schedule:
            scheduled_time = f"{day}T{slot}:00"
            if datetime.fromisoformat(scheduled_time) < datetime.utcnow():
                continue
            row = con.execute(
                "SELECT id FROM output_queue WHERE scheduled_time = ? AND status IN ('queued', 'uploading')",
                (scheduled_time,),
            ).fetchone()
            if not row:
                con.close()
                return scheduled_time
    con.close()
    raise RuntimeError("No available upload slot in next 7 days")
```

- [ ] **Step 4: Rodar testes**

```bash
pytest tests/test_queue.py -v
```
Expected: todos os testes PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/queue.py tests/test_queue.py
git commit -m "feat: SQLite queue manager with CRUD and slot scheduling"
```

---

## Task 3: Monitor — YouTube Data API

**Files:**
- Create: `pipeline/monitor.py`
- Create: `tests/test_monitor.py`

- [ ] **Step 1: Escrever test_monitor.py**

```python
import pytest
from unittest.mock import MagicMock, patch
from pipeline.monitor import fetch_new_videos

MOCK_RESPONSE = {
    "items": [
        {
            "id": {"videoId": "abc123"},
            "snippet": {
                "title": "Como Marçal usa gatilhos mentais",
                "publishedAt": "2026-08-08T10:00:00Z",
            },
        },
        {
            "id": {"videoId": "def456"},
            "snippet": {
                "title": "Técnica de oratória explicada",
                "publishedAt": "2026-08-07T18:00:00Z",
            },
        },
    ]
}

def test_fetch_new_videos_returns_list():
    with patch("pipeline.monitor.build") as mock_build:
        mock_service = MagicMock()
        mock_build.return_value = mock_service
        mock_service.search().list().execute.return_value = MOCK_RESPONSE

        videos = fetch_new_videos(
            api_key="fake-key",
            channel_id="UCbroBIg8zvIH8-F4631wJhA",
            max_results=5,
        )

    assert len(videos) == 2
    assert videos[0]["id"] == "abc123"
    assert videos[0]["title"] == "Como Marçal usa gatilhos mentais"
    assert videos[0]["published_at"] == "2026-08-08T10:00:00Z"

def test_fetch_new_videos_empty_channel():
    with patch("pipeline.monitor.build") as mock_build:
        mock_service = MagicMock()
        mock_build.return_value = mock_service
        mock_service.search().list().execute.return_value = {"items": []}

        videos = fetch_new_videos(api_key="fake-key", channel_id="UCxxx", max_results=5)

    assert videos == []
```

- [ ] **Step 2: Rodar para confirmar falha**

```bash
pytest tests/test_monitor.py -v
```
Expected: `ImportError`

- [ ] **Step 3: Implementar pipeline/monitor.py**

```python
from googleapiclient.discovery import build as _build

def fetch_new_videos(api_key: str, channel_id: str, max_results: int = 10) -> list[dict]:
    service = _build("youtube", "v3", developerKey=api_key)
    response = (
        service.search()
        .list(
            part="snippet",
            channelId=channel_id,
            order="date",
            type="video",
            maxResults=max_results,
        )
        .execute()
    )
    return [
        {
            "id": item["id"]["videoId"],
            "title": item["snippet"]["title"],
            "published_at": item["snippet"]["publishedAt"],
        }
        for item in response.get("items", [])
    ]
```

- [ ] **Step 4: Rodar testes**

```bash
pytest tests/test_monitor.py -v
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/monitor.py tests/test_monitor.py
git commit -m "feat: YouTube monitor — fetch new videos via Data API v3"
```

---

## Task 4: Downloader — yt-dlp

**Files:**
- Create: `pipeline/downloader.py`
- Create: `tests/test_downloader.py`

- [ ] **Step 1: Escrever test_downloader.py**

```python
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
from pipeline.downloader import download_video

def test_download_video_returns_path(tmp_path):
    with patch("pipeline.downloader.yt_dlp.YoutubeDL") as mock_ydl_cls:
        mock_ydl = MagicMock()
        mock_ydl_cls.return_value.__enter__.return_value = mock_ydl

        fake_path = tmp_path / "abc123.mp4"
        fake_path.touch()
        mock_ydl.prepare_filename.return_value = str(fake_path)

        result = download_video("abc123", output_dir=str(tmp_path))

    assert result == fake_path

def test_download_video_raises_on_failure(tmp_path):
    with patch("pipeline.downloader.yt_dlp.YoutubeDL") as mock_ydl_cls:
        mock_ydl = MagicMock()
        mock_ydl_cls.return_value.__enter__.return_value = mock_ydl
        mock_ydl.download.side_effect = Exception("Network error")

        with pytest.raises(RuntimeError, match="Download failed"):
            download_video("abc123", output_dir=str(tmp_path))
```

- [ ] **Step 2: Rodar para confirmar falha**

```bash
pytest tests/test_downloader.py -v
```
Expected: `ImportError`

- [ ] **Step 3: Implementar pipeline/downloader.py**

```python
from pathlib import Path
import yt_dlp

def download_video(video_id: str, output_dir: str) -> Path:
    url = f"https://www.youtube.com/watch?v={video_id}"
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    ydl_opts = {
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]",
        "outtmpl": str(out / f"{video_id}.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
            return Path(filename)
    except Exception as e:
        raise RuntimeError(f"Download failed for {video_id}: {e}") from e
```

- [ ] **Step 4: Rodar testes**

```bash
pytest tests/test_downloader.py -v
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/downloader.py tests/test_downloader.py
git commit -m "feat: yt-dlp downloader wrapper"
```

---

## Task 5: Transcriber — Whisper

**Files:**
- Create: `pipeline/transcriber.py`
- Create: `tests/test_transcriber.py`

- [ ] **Step 1: Escrever test_transcriber.py**

```python
import pytest
from unittest.mock import patch, MagicMock
from pipeline.transcriber import transcribe

MOCK_WHISPER_RESULT = {
    "segments": [
        {"start": 0.0, "end": 5.2, "text": "Olha, vou te contar uma coisa."},
        {"start": 5.2, "end": 12.0, "text": "Quando você domina a retórica, domina as pessoas."},
    ]
}

def test_transcribe_returns_segments(tmp_path):
    fake_video = tmp_path / "video.mp4"
    fake_video.touch()

    with patch("pipeline.transcriber.whisper.load_model") as mock_load:
        mock_model = MagicMock()
        mock_load.return_value = mock_model
        mock_model.transcribe.return_value = MOCK_WHISPER_RESULT

        result = transcribe(str(fake_video), model_size="small")

    assert len(result) == 2
    assert result[0]["start"] == 0.0
    assert result[0]["text"] == "Olha, vou te contar uma coisa."

def test_transcribe_raises_on_missing_file():
    with pytest.raises(FileNotFoundError):
        transcribe("/nonexistent/video.mp4", model_size="small")
```

- [ ] **Step 2: Rodar para confirmar falha**

```bash
pytest tests/test_transcriber.py -v
```
Expected: `ImportError`

- [ ] **Step 3: Implementar pipeline/transcriber.py**

```python
from pathlib import Path
import whisper

def transcribe(video_path: str, model_size: str = "medium") -> list[dict]:
    path = Path(video_path)
    if not path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    model = whisper.load_model(model_size)
    result = model.transcribe(str(path), language="pt", verbose=False)

    return [
        {"start": seg["start"], "end": seg["end"], "text": seg["text"].strip()}
        for seg in result["segments"]
    ]
```

- [ ] **Step 4: Rodar testes**

```bash
pytest tests/test_transcriber.py -v
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/transcriber.py tests/test_transcriber.py
git commit -m "feat: Whisper transcriber with segment timestamps"
```

---

## Task 6: Analyzer — Claude API

**Files:**
- Create: `pipeline/analyzer.py`
- Create: `tests/test_analyzer.py`

- [ ] **Step 1: Escrever test_analyzer.py**

```python
import pytest
import json
from unittest.mock import patch, MagicMock
from pipeline.analyzer import analyze_rhetoric

SEGMENTS = [
    {"start": 0.0, "end": 5.0, "text": "Sabe qual é o poder da repetição?"},
    {"start": 5.0, "end": 12.0, "text": "Quando você repete uma ideia três vezes, ela vira verdade na mente do ouvinte."},
]

MOCK_RESPONSE_JSON = {
    "clip_start": 0.0,
    "clip_end": 12.0,
    "techniques": ["repetição", "ancoragem"],
    "narration_script": "Marçal demonstra aqui a técnica de repetição deliberada.",
    "title": "Como Marçal usa repetição para persuadir",
    "description": "Análise da técnica retórica de repetição usada por Marçal.",
    "tags": ["retórica", "persuasão", "Marçal", "comunicação", "oratória"],
}

def test_analyze_rhetoric_returns_parsed_dict():
    with patch("pipeline.analyzer.anthropic.Anthropic") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_message = MagicMock()
        mock_message.content[0].text = json.dumps(MOCK_RESPONSE_JSON)
        mock_client.messages.create.return_value = mock_message

        result = analyze_rhetoric(
            segments=SEGMENTS,
            api_key="fake-key",
            prompt_template="Analise: {transcription}",
            max_narration_chars=800,
        )

    assert result["clip_start"] == 0.0
    assert result["clip_end"] == 12.0
    assert "repetição" in result["techniques"]
    assert len(result["narration_script"]) <= 800

def test_analyze_rhetoric_raises_on_invalid_json():
    with patch("pipeline.analyzer.anthropic.Anthropic") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_message = MagicMock()
        mock_message.content[0].text = "não é json"
        mock_client.messages.create.return_value = mock_message

        with pytest.raises(ValueError, match="Invalid JSON"):
            analyze_rhetoric(
                segments=SEGMENTS,
                api_key="fake-key",
                prompt_template="Analise: {transcription}",
                max_narration_chars=800,
            )
```

- [ ] **Step 2: Rodar para confirmar falha**

```bash
pytest tests/test_analyzer.py -v
```
Expected: `ImportError`

- [ ] **Step 3: Implementar pipeline/analyzer.py**

```python
import json
import anthropic

def analyze_rhetoric(segments: list[dict], api_key: str,
                     prompt_template: str, max_narration_chars: int) -> dict:
    transcription = "\n".join(
        f"[{s['start']:.1f}s–{s['end']:.1f}s] {s['text']}" for s in segments
    )
    prompt = prompt_template.replace("{transcription}", transcription)

    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = message.content[0].text.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON from Claude: {e}\nRaw: {raw}") from e

    if len(data.get("narration_script", "")) > max_narration_chars:
        data["narration_script"] = data["narration_script"][:max_narration_chars]

    return data
```

- [ ] **Step 4: Rodar testes**

```bash
pytest tests/test_analyzer.py -v
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/analyzer.py tests/test_analyzer.py
git commit -m "feat: Claude Haiku analyzer — rhetoric extraction + script generation"
```

---

## Task 7: Narrator — ElevenLabs

**Files:**
- Create: `pipeline/narrator.py`
- Create: `tests/test_narrator.py`

- [ ] **Step 1: Escrever test_narrator.py**

```python
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
from pipeline.narrator import synthesize_speech

def test_synthesize_speech_writes_mp3(tmp_path):
    fake_audio = b"fake-mp3-bytes"

    with patch("pipeline.narrator.ElevenLabs") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.text_to_speech.convert.return_value = iter([fake_audio])

        out_path = synthesize_speech(
            text="Marçal usa ethos para ganhar credibilidade.",
            voice_id="abc-voice",
            api_key="fake-key",
            output_dir=str(tmp_path),
            filename="narration",
        )

    assert out_path == tmp_path / "narration.mp3"
    assert out_path.read_bytes() == fake_audio

def test_synthesize_speech_raises_on_empty_text(tmp_path):
    with pytest.raises(ValueError, match="empty"):
        synthesize_speech(
            text="",
            voice_id="abc",
            api_key="fake",
            output_dir=str(tmp_path),
            filename="narration",
        )
```

- [ ] **Step 2: Rodar para confirmar falha**

```bash
pytest tests/test_narrator.py -v
```
Expected: `ImportError`

- [ ] **Step 3: Implementar pipeline/narrator.py**

```python
from pathlib import Path
from elevenlabs.client import ElevenLabs

def synthesize_speech(text: str, voice_id: str, api_key: str,
                      output_dir: str, filename: str) -> Path:
    if not text.strip():
        raise ValueError("narration text is empty")

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{filename}.mp3"

    client = ElevenLabs(api_key=api_key)
    chunks = client.text_to_speech.convert(
        text=text,
        voice_id=voice_id,
        model_id="eleven_multilingual_v2",
        output_format="mp3_44100_128",
    )

    with open(out_path, "wb") as f:
        for chunk in chunks:
            f.write(chunk)

    return out_path
```

- [ ] **Step 4: Rodar testes**

```bash
pytest tests/test_narrator.py -v
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/narrator.py tests/test_narrator.py
git commit -m "feat: ElevenLabs narrator — multilingual v2 TTS"
```

---

## Task 8: Editor — ffmpeg

**Files:**
- Create: `pipeline/editor.py`
- Create: `tests/test_editor.py`

- [ ] **Step 1: Escrever test_editor.py**

```python
import pytest
from pathlib import Path
from unittest.mock import patch, call, MagicMock
from pipeline.editor import build_video

def test_build_video_calls_ffmpeg_and_returns_paths(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    narration = tmp_path / "narration.mp3"
    narration.touch()
    intro = tmp_path / "intro.mp4"
    intro.touch()
    outro = tmp_path / "outro.mp4"
    outro.touch()

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0)

        result = build_video(
            source_path=str(source),
            narration_path=str(narration),
            intro_path=str(intro),
            outro_path=str(outro),
            clip_start=10.0,
            clip_end=70.0,
            output_dir=str(tmp_path),
            video_id="abc123",
        )

    assert mock_run.called
    assert "landscape" in result
    assert "portrait" in result

def test_build_video_raises_on_ffmpeg_failure(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    narration = tmp_path / "narration.mp3"
    narration.touch()

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1, stderr=b"error")

        with pytest.raises(RuntimeError, match="ffmpeg failed"):
            build_video(
                source_path=str(source),
                narration_path=str(narration),
                intro_path=None,
                outro_path=None,
                clip_start=10.0,
                clip_end=70.0,
                output_dir=str(tmp_path),
                video_id="abc123",
            )
```

- [ ] **Step 2: Rodar para confirmar falha**

```bash
pytest tests/test_editor.py -v
```
Expected: `ImportError`

- [ ] **Step 3: Implementar pipeline/editor.py**

```python
import subprocess
from pathlib import Path

def _run(cmd: list[str]):
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode()}")

def build_video(source_path: str, narration_path: str, intro_path: str | None,
                outro_path: str | None, clip_start: float, clip_end: float,
                output_dir: str, video_id: str) -> dict[str, str]:
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    clipped = out / f"{video_id}_clip.mp4"
    duration = clip_end - clip_start
    _run([
        "ffmpeg", "-y", "-ss", str(clip_start), "-i", source_path,
        "-t", str(duration), "-c:v", "libx264", "-c:a", "aac",
        "-preset", "ultrafast", str(clipped),
    ])

    # Combine narration over clipped video (narration audio replaces original)
    narrated = out / f"{video_id}_narrated.mp4"
    _run([
        "ffmpeg", "-y", "-i", str(clipped), "-i", narration_path,
        "-map", "0:v", "-map", "1:a", "-c:v", "copy",
        "-shortest", str(narrated),
    ])

    # Assemble with intro/outro if available
    parts = []
    if intro_path:
        parts.append(intro_path)
    parts.append(str(narrated))
    if outro_path:
        parts.append(outro_path)

    concat_list = out / f"{video_id}_concat.txt"
    concat_list.write_text("\n".join(f"file '{p}'" for p in parts))

    landscape = out / f"{video_id}_landscape.mp4"
    _run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(concat_list), "-c", "copy", str(landscape),
    ])

    # Portrait (9:16) version for Shorts — crop center
    portrait = out / f"{video_id}_portrait.mp4"
    _run([
        "ffmpeg", "-y", "-i", str(landscape),
        "-vf", "crop=ih*9/16:ih,scale=1080:1920",
        "-c:a", "copy", str(portrait),
    ])

    return {"landscape": str(landscape), "portrait": str(portrait)}
```

- [ ] **Step 4: Rodar testes**

```bash
pytest tests/test_editor.py -v
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/editor.py tests/test_editor.py
git commit -m "feat: ffmpeg editor — clip, narrate, concat, portrait crop"
```

---

## Task 9: Uploader — YouTube Data API

**Files:**
- Create: `pipeline/uploader.py`
- Create: `tests/test_uploader.py`

- [ ] **Step 1: Escrever test_uploader.py**

```python
import pytest
import json
from pathlib import Path
from unittest.mock import patch, MagicMock
from pipeline.uploader import upload_video

def test_upload_video_returns_video_id(tmp_path):
    fake_video = tmp_path / "video.mp4"
    fake_video.write_bytes(b"fake")

    with patch("pipeline.uploader._get_youtube_service") as mock_svc:
        mock_youtube = MagicMock()
        mock_svc.return_value = mock_youtube
        mock_youtube.videos().insert().execute.return_value = {"id": "yt-xyz"}

        video_id = upload_video(
            file_path=str(fake_video),
            title="Marçal usa ethos",
            description="Análise de retórica",
            tags=["retórica", "Marçal"],
            secrets_file="config/client_secrets.json",
        )

    assert video_id == "yt-xyz"

def test_upload_video_raises_on_missing_file():
    with pytest.raises(FileNotFoundError):
        upload_video(
            file_path="/nonexistent.mp4",
            title="T",
            description="D",
            tags=[],
            secrets_file="config/client_secrets.json",
        )
```

- [ ] **Step 2: Rodar para confirmar falha**

```bash
pytest tests/test_uploader.py -v
```
Expected: `ImportError`

- [ ] **Step 3: Implementar pipeline/uploader.py**

```python
from pathlib import Path
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google_auth_oauthlib.flow import InstalledAppFlow
import pickle
import os

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
TOKEN_FILE = "data/youtube_token.pkl"

def _get_youtube_service(secrets_file: str):
    creds = None
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, "rb") as f:
            creds = pickle.load(f)
    if not creds or not creds.valid:
        flow = InstalledAppFlow.from_client_secrets_file(secrets_file, SCOPES)
        creds = flow.run_local_server(port=0)
        Path(TOKEN_FILE).parent.mkdir(parents=True, exist_ok=True)
        with open(TOKEN_FILE, "wb") as f:
            pickle.dump(creds, f)
    return build("youtube", "v3", credentials=creds)

def upload_video(file_path: str, title: str, description: str,
                 tags: list[str], secrets_file: str) -> str:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Video not found: {file_path}")

    youtube = _get_youtube_service(secrets_file)
    body = {
        "snippet": {
            "title": title[:100],
            "description": description[:5000],
            "tags": tags,
            "categoryId": "27",  # Education
            "defaultLanguage": "pt",
        },
        "status": {"privacyStatus": "public"},
    }
    media = MediaFileUpload(str(path), chunksize=-1, resumable=True)
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
    response = request.execute()
    return response["id"]
```

- [ ] **Step 4: Rodar testes**

```bash
pytest tests/test_uploader.py -v
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/uploader.py tests/test_uploader.py
git commit -m "feat: YouTube uploader with OAuth2 token persistence"
```

---

## Task 10: Orquestrador Principal

**Files:**
- Create: `main.py`
- Create: `tests/test_main.py`

- [ ] **Step 1: Escrever test_main.py**

```python
import pytest
from unittest.mock import patch, MagicMock, call
from main import run_pipeline

@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "temp"))
    from pipeline import queue
    queue.init_db()

def test_run_pipeline_processes_new_video(tmp_path):
    with (
        patch("main.fetch_new_videos", return_value=[
            {"id": "vid1", "title": "Test", "published_at": "2026-08-08T12:00:00Z"}
        ]),
        patch("main.download_video", return_value=tmp_path / "vid1.mp4"),
        patch("main.transcribe", return_value=[{"start": 0.0, "end": 10.0, "text": "Texto"}]),
        patch("main.analyze_rhetoric", return_value={
            "clip_start": 0.0, "clip_end": 10.0,
            "techniques": ["ethos"],
            "narration_script": "Script de narração",
            "title": "Título do vídeo",
            "description": "Descrição",
            "tags": ["tag1"],
        }),
        patch("main.synthesize_speech", return_value=tmp_path / "narration.mp3"),
        patch("main.build_video", return_value={
            "landscape": str(tmp_path / "landscape.mp4"),
            "portrait": str(tmp_path / "portrait.mp4"),
        }),
        patch("main.enqueue_output") as mock_enqueue,
    ):
        run_pipeline(creator_handle="pablomarcall", channel_id="UCbroBIg8zvIH8-F4631wJhA")

    assert mock_enqueue.called

def test_run_pipeline_skips_processed_video(tmp_path):
    from pipeline.queue import mark_pending, mark_done
    mark_pending("vid1", "pablomarcall", "T", "2026-08-08T12:00:00Z")
    mark_done("vid1")

    with (
        patch("main.fetch_new_videos", return_value=[
            {"id": "vid1", "title": "Test", "published_at": "2026-08-08T12:00:00Z"}
        ]),
        patch("main.download_video") as mock_dl,
    ):
        run_pipeline(creator_handle="pablomarcall", channel_id="UCbroBIg8zvIH8-F4631wJhA")

    mock_dl.assert_not_called()
```

- [ ] **Step 2: Rodar para confirmar falha**

```bash
pytest tests/test_main.py -v
```
Expected: `ImportError`

- [ ] **Step 3: Implementar main.py**

```python
import json
import os
import logging
from pathlib import Path
from dotenv import load_dotenv

from pipeline.monitor import fetch_new_videos
from pipeline.downloader import download_video
from pipeline.transcriber import transcribe
from pipeline.analyzer import analyze_rhetoric
from pipeline.narrator import synthesize_speech
from pipeline.editor import build_video
from pipeline.uploader import upload_video
from pipeline.queue import (
    init_db, is_processed, mark_pending, mark_done,
    enqueue_output, get_due_uploads, mark_uploaded, next_upload_slot,
)

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

CREATORS_FILE = Path("config/creators.json")
PERSONA_FILE = Path("config/persona.json")
SCHEDULE_FILE = Path("config/schedule.json")
PROMPT_FILE = Path("prompts/rhetoric_analysis.txt")
ASSETS_DIR = Path("assets")


def _load_config():
    creators = json.loads(CREATORS_FILE.read_text())
    persona = json.loads(PERSONA_FILE.read_text())
    schedule = json.loads(SCHEDULE_FILE.read_text())
    prompt = PROMPT_FILE.read_text()
    return creators, persona, schedule, prompt


def run_pipeline(creator_handle: str = None, channel_id: str = None):
    init_db()
    creators, persona, schedule, prompt = _load_config()
    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp"))

    active = [c for c in creators if c["active"]]
    if creator_handle:
        active = [c for c in active if c["handle"] == creator_handle]
    if channel_id:
        active = [c for c in active if c["channel_id"] == channel_id]

    for creator in active:
        log.info(f"Checking {creator['handle']}")
        videos = fetch_new_videos(
            api_key=os.environ["YOUTUBE_API_KEY"],
            channel_id=creator["channel_id"],
            max_results=10,
        )

        for video in videos:
            if is_processed(video["id"]):
                log.info(f"Skip {video['id']} — already processed")
                continue

            log.info(f"Processing {video['id']}: {video['title']}")
            mark_pending(video["id"], creator["handle"], video["title"], video["published_at"])

            try:
                vid_path = download_video(video["id"], str(temp_dir / video["id"]))
                segments = transcribe(str(vid_path), model_size="medium")
                analysis = analyze_rhetoric(
                    segments=segments,
                    api_key=os.environ["ANTHROPIC_API_KEY"],
                    prompt_template=prompt,
                    max_narration_chars=persona["max_narration_chars"],
                )
                narration_path = synthesize_speech(
                    text=analysis["narration_script"],
                    voice_id=persona["voice_id"],
                    api_key=os.environ["ELEVENLABS_API_KEY"],
                    output_dir=str(temp_dir / video["id"]),
                    filename="narration",
                )
                intro = str(ASSETS_DIR / "intro.mp4") if (ASSETS_DIR / "intro.mp4").exists() else None
                outro = str(ASSETS_DIR / "outro.mp4") if (ASSETS_DIR / "outro.mp4").exists() else None
                video_files = build_video(
                    source_path=str(vid_path),
                    narration_path=str(narration_path),
                    intro_path=intro,
                    outro_path=outro,
                    clip_start=analysis["clip_start"],
                    clip_end=analysis["clip_end"],
                    output_dir=str(temp_dir / video["id"]),
                    video_id=video["id"],
                )
                slot = next_upload_slot(schedule["upload_slots_brt"])
                enqueue_output(
                    source_video_id=video["id"],
                    clip_start=analysis["clip_start"],
                    clip_end=analysis["clip_end"],
                    title=analysis["title"],
                    description=analysis["description"],
                    tags=analysis["tags"],
                    scheduled_time=slot,
                )
                mark_done(video["id"])
                log.info(f"Queued {video['id']} for {slot}")

            except Exception as e:
                log.error(f"Error processing {video['id']}: {e}")


def run_uploads():
    init_db()
    due = get_due_uploads()
    if not due:
        return

    secrets_file = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json")
    temp_dir = Path(os.getenv("TEMP_DIR", "data/temp"))

    for item in due:
        landscape = str(temp_dir / item["source_video_id"] / f"{item['source_video_id']}_landscape.mp4")
        try:
            yt_id = upload_video(
                file_path=landscape,
                title=item["title"],
                description=item["description"],
                tags=json.loads(item["tags"]),
                secrets_file=secrets_file,
            )
            mark_uploaded(item["id"], yt_id)
            log.info(f"Uploaded {item['title']} → {yt_id}")
        except Exception as e:
            log.error(f"Upload failed for queue item {item['id']}: {e}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "upload":
        run_uploads()
    else:
        run_pipeline()
```

- [ ] **Step 4: Rodar testes**

```bash
pytest tests/test_main.py -v
```
Expected: PASS

- [ ] **Step 5: Rodar todos os testes**

```bash
pytest -v
```
Expected: todos PASS

- [ ] **Step 6: Commit**

```bash
git add main.py tests/test_main.py
git commit -m "feat: pipeline orchestrator — monitor, process, queue, upload"
```

---

## Task 11: Deploy no Servidor

**Files:**
- Create: `deploy/setup.sh`
- Create: `deploy/crontab.txt`

- [ ] **Step 1: Criar deploy/setup.sh**

```bash
#!/bin/bash
set -e

PROJECT_DIR="/opt/youtube-rhetoric-pipeline"
PYTHON="python3.12"
VENV="$PROJECT_DIR/.venv"

echo "=== Deploy YouTube Rhetoric Pipeline ==="

# Instalar dependências do sistema
apt-get update -qq
apt-get install -y ffmpeg python3.12 python3.12-venv git -qq

# Clonar ou atualizar repositório
if [ -d "$PROJECT_DIR" ]; then
    cd "$PROJECT_DIR" && git pull
else
    git clone https://github.com/YOUR_USER/youtube-rhetoric-pipeline.git "$PROJECT_DIR"
    cd "$PROJECT_DIR"
fi

# Virtualenv + dependências
$PYTHON -m venv "$VENV"
"$VENV/bin/pip" install -q -r requirements.txt

# Criar diretórios de dados
mkdir -p data/temp assets

# Instalar crontab
crontab deploy/crontab.txt
echo "=== Deploy concluído ==="
```

- [ ] **Step 2: Criar deploy/crontab.txt**

```
# Monitor: verifica novos vídeos a cada 30 minutos
*/30 * * * * /opt/youtube-rhetoric-pipeline/.venv/bin/python /opt/youtube-rhetoric-pipeline/main.py >> /opt/youtube-rhetoric-pipeline/data/pipeline.log 2>&1

# Upload: verifica fila a cada 5 minutos
*/5 * * * * /opt/youtube-rhetoric-pipeline/.venv/bin/python /opt/youtube-rhetoric-pipeline/main.py upload >> /opt/youtube-rhetoric-pipeline/data/upload.log 2>&1
```

- [ ] **Step 3: Configurar OAuth2 do YouTube (uma vez, no servidor)**

```bash
# No servidor, com display ou via SSH port-forward:
cd /opt/youtube-rhetoric-pipeline
.venv/bin/python -c "from pipeline.uploader import _get_youtube_service; _get_youtube_service('config/client_secrets.json')"
# Abre browser → autoriza → salva token em data/youtube_token.pkl
```

- [ ] **Step 4: Copiar .env para o servidor**

```bash
scp .env usuario@servidor:/opt/youtube-rhetoric-pipeline/.env
scp config/client_secrets.json usuario@servidor:/opt/youtube-rhetoric-pipeline/config/
scp assets/intro.mp4 assets/outro.mp4 assets/logo.png usuario@servidor:/opt/youtube-rhetoric-pipeline/assets/
```

- [ ] **Step 5: Executar setup no servidor**

```bash
ssh usuario@servidor "bash /opt/youtube-rhetoric-pipeline/deploy/setup.sh"
```

- [ ] **Step 6: Verificar primeiro run manual**

```bash
ssh usuario@servidor "cd /opt/youtube-rhetoric-pipeline && .venv/bin/python main.py"
# Expected: INFO — Checking pablomarcall ... INFO — Processing <video_id> ...
```

- [ ] **Step 7: Commit final**

```bash
git add deploy/
git commit -m "chore: deploy scripts — setup.sh + crontab para Azure VM"
git push origin main
```

---

## Self-Review — Cobertura do Spec

| Requisito do Spec | Task |
|---|---|
| Monitor YouTube Data API a cada 30min | Task 3 + Task 11 (cron) |
| Download yt-dlp | Task 4 |
| Transcrição Whisper com timestamps | Task 5 |
| Análise Claude Haiku | Task 6 |
| Narração ElevenLabs max 800 chars | Task 7 + persona.json |
| Montagem ffmpeg (16:9 + 9:16) | Task 8 |
| Fila SQLite com slots 12h/18h/21h | Task 2 |
| Upload YouTube Data API | Task 9 |
| Orquestrador encadeia tudo | Task 10 |
| Deploy servidor existente + cron | Task 11 |
| Config `creators.json` para trocar creator | Task 1 |
| Narrações máx 55s (~800 chars) | Task 6 (trunca no analyzer) + Task 1 (persona.json) |
