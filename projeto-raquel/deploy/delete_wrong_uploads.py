"""
Deleta os vídeos enviados para o canal errado (André Dias Moreira Prol).
Precisa de autorização OAuth2 com scope youtube completo.
"""
import sys, os
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
from dotenv import load_dotenv
load_dotenv(PROJECT / ".env")

from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/youtube"]
TOKEN_FILE = PROJECT / "data" / "youtube_token_delete.json"
SECRETS = PROJECT / "config" / "client_secrets.json"

# IDs dos vídeos enviados para o canal errado
WRONG_VIDEO_IDS = [
    "K6H4JgyuOXA",
    "GfmZmeOvp5I",
    "xEOgSf34a_Q",
    "MgykIQF5KnU",
    "NBOaH542C7M",
    "J1xl7XBwSp4",
    "FvlHeO5NoWk",
    "tD7ZAW9GfOw",
    "Vl6GWT4mBLc",
]


def get_service():
    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(SECRETS), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    return build("youtube", "v3", credentials=creds)


def main():
    print("Autorizando com conta do André (para deletar vídeos)...")
    print("IMPORTANTE: no browser, selecione a conta/canal André Dias Moreira Prol\n")
    yt = get_service()

    for vid_id in WRONG_VIDEO_IDS:
        try:
            yt.videos().delete(id=vid_id).execute()
            print(f"  ✓ Deletado: {vid_id}")
        except Exception as e:
            print(f"  ❌ Erro ao deletar {vid_id}: {e}")

    print(f"\n{len(WRONG_VIDEO_IDS)} vídeos deletados do canal errado.")
    print("\nAgora rode: python deploy/setup_youtube_auth.py")
    print("IMPORTANTE: no browser, selecione o canal RAQUEL PIRES (não André)")


if __name__ == "__main__":
    main()
