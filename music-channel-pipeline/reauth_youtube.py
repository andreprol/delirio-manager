"""Refaz o OAuth do YouTube e regrava data/youtube_token.pkl.

Necessário quando o refresh token morre ('invalid_grant: Token has been
expired or revoked'). Enquanto o app OAuth estiver com publishing status
"Testing" no Google Cloud, o refresh token expira a cada 7 dias.

Uso:
    python reauth_youtube.py

Não abre o browser sozinho — imprime a URL para ser aberta manualmente.
Na tela de seleção de canal, escolher o brand account **Umbra Sessions**.
"""

import pickle
import sys
from google_auth_oauthlib.flow import InstalledAppFlow

from pipeline.uploader import SCOPES, TOKEN_FILE

SECRETS_FILE = "config/client_secrets.json"
PORT = 8765


def main():
    flow = InstalledAppFlow.from_client_secrets_file(SECRETS_FILE, SCOPES)
    creds = flow.run_local_server(
        port=PORT,
        open_browser=False,
        access_type="offline",
        prompt="consent",
        authorization_prompt_message="AUTHURL={url}",
        success_message="OAuth concluido. Pode fechar esta aba.",
    )
    if not creds.refresh_token:
        print("ERRO: Google nao devolveu refresh_token.", file=sys.stderr)
        sys.exit(1)
    with open(TOKEN_FILE, "wb") as f:
        pickle.dump(creds, f)
    print(f"Token salvo em {TOKEN_FILE}")


if __name__ == "__main__":
    main()
