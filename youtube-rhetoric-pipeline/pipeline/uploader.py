from pathlib import Path
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
import pickle
import os

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
TOKEN_FILE = "data/youtube_token.pkl"


def _get_youtube_service(secrets_file: str):
    creds = None
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, "rb") as f:
            creds = pickle.load(f)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        Path(TOKEN_FILE).parent.mkdir(parents=True, exist_ok=True)
        with open(TOKEN_FILE, "wb") as f:
            pickle.dump(creds, f)
    elif not creds or not creds.valid:
        flow = InstalledAppFlow.from_client_secrets_file(secrets_file, SCOPES)
        creds = flow.run_local_server(port=0)
        Path(TOKEN_FILE).parent.mkdir(parents=True, exist_ok=True)
        with open(TOKEN_FILE, "wb") as f:
            pickle.dump(creds, f)
    return build("youtube", "v3", credentials=creds)


def _sanitize(text: str) -> str:
    """A API do YouTube rejeita '<' e '>' em título e descrição com HTTP 400."""
    return text.replace("<", "(").replace(">", ")")


def upload_video(file_path: str, title: str, description: str,
                 tags: list[str], secrets_file: str) -> str:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Video not found: {file_path}")
    youtube = _get_youtube_service(secrets_file)
    body = {
        "snippet": {
            "title": _sanitize(title)[:100],
            "description": _sanitize(description)[:5000],
            "tags": tags,
            "categoryId": "27",
            "defaultLanguage": "pt",
        },
        "status": {"privacyStatus": "public"},
    }
    media = MediaFileUpload(str(path), chunksize=-1, resumable=True)
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
    response = request.execute()
    return response["id"]
