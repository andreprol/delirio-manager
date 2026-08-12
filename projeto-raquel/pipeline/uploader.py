"""
Faz upload de vídeos para o YouTube via OAuth2.
Token armazenado em data/youtube_token.json (gerado na primeira execução).
"""
import os
import json
from pathlib import Path

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_TOKEN_FILE = _PROJECT_ROOT / "data" / "youtube_token.json"


def _get_youtube_service(secrets_file: str):
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build

    creds = None
    if _TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(_TOKEN_FILE), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            abs_secrets = Path(secrets_file) if Path(secrets_file).is_absolute() else _PROJECT_ROOT / secrets_file
            flow = InstalledAppFlow.from_client_secrets_file(str(abs_secrets), SCOPES)
            creds = flow.run_local_server(port=0)
        _TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        _TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    return build("youtube", "v3", credentials=creds)


def upload_video(
    file_path: str,
    title: str,
    description: str,
    tags: list,
    secrets_file: str = None,
    made_for_kids: bool = False,
    privacy: str = "public",
) -> str:
    """
    Faz upload de um vídeo para o YouTube.
    Retorna o ID do vídeo publicado.
    Na primeira execução abre browser para autorizar OAuth2.
    """
    from googleapiclient.http import MediaFileUpload

    secrets_file = secrets_file or os.getenv(
        "YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json"
    )
    # YouTube rejects < > in descriptions (treated as invalid HTML)
    description = description.replace("<", "(").replace(">", ")")
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Vídeo não encontrado: {file_path}")

    youtube = _get_youtube_service(secrets_file)
    body = {
        "snippet": {
            "title": title[:100],
            "description": description[:5000],
            "tags": tags,
            "categoryId": "27",
            "defaultLanguage": "pt",
        },
        "status": {
            "privacyStatus": privacy,
            "madeForKids": made_for_kids,
        },
    }
    media = MediaFileUpload(str(path), chunksize=-1, resumable=True)
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
    response = request.execute()
    return response["id"]
