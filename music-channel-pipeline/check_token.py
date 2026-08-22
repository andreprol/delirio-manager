"""Checa a saúde do refresh token do YouTube e avisa antes do slot de upload.

Enquanto o app OAuth estiver com publishing status "Testing" no Google Cloud,
o Google expira o refresh token a cada 7 dias. Sem esta checagem, a descoberta
só acontece às 18:00, quando o upload do dia já falhou.

Rodar de manhã: tenta um refresh de verdade e manda e-mail se estiver quebrado,
deixando o dia inteiro para rodar `python reauth_youtube.py`.

Uso:
    python check_token.py     # exit 0 = token vivo, exit 1 = precisa reauth
"""

import os
import pickle
import sys
from pathlib import Path

from dotenv import load_dotenv
from google.auth.transport.requests import Request

load_dotenv(dotenv_path=Path(__file__).parent / ".env")

from pipeline.notifier import notify
from pipeline.uploader import TOKEN_FILE


def main():
    token_path = Path(TOKEN_FILE)
    if not token_path.exists():
        notify("Token do YouTube não existe",
               [f"Arquivo ausente: {token_path}",
                "Rodar: python reauth_youtube.py"],
               status="fail")
        sys.exit(1)

    with open(token_path, "rb") as f:
        creds = pickle.load(f)

    try:
        creds.refresh(Request())
    except Exception as e:
        notify("Token do YouTube expirou — upload de hoje vai falhar",
               [f"Erro: {e}",
                "Rodar antes das 18:00:",
                r"cd F:\RichClub\music-channel-pipeline && python reauth_youtube.py",
                "Na tela 2 do Google, escolher o canal Umbra Sessions.",
                "Causa: consent screen do projeto anatomia-do-discurso está em "
                "'Testing', e nesse modo o Google expira o refresh token a cada 7 dias."],
               status="fail")
        sys.exit(1)

    # Regravar: o refresh devolve um access token novo, e guardá-lo evita
    # que o uploader precise renovar de novo mais tarde.
    with open(token_path, "wb") as f:
        pickle.dump(creds, f)

    print("Token OK")


if __name__ == "__main__":
    main()
