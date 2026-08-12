"""
Gera youtube_token.json via OAuth2.
Rodar uma vez no terminal — abre browser para autorizar.
"""
from pathlib import Path
import sys

project_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(project_root))

from dotenv import load_dotenv
load_dotenv(project_root / ".env")

from pipeline.uploader import _get_youtube_service, _TOKEN_FILE

print(f"Secrets: {project_root / 'config/client_secrets.json'}")
print(f"Token será salvo em: {_TOKEN_FILE}")
print()
print("Abrindo browser para autorizar o YouTube...")
_get_youtube_service("config/client_secrets.json")
print()
print(f"✅ Token salvo em: {_TOKEN_FILE}")
print("Agora o sync pode fazer upload automaticamente.")
