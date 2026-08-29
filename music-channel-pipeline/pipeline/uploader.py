import logging
import os
import pickle
from pathlib import Path
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

log = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
TOKEN_FILE = "data/youtube_token.pkl"

# Nome do arquivo de thumbnail dentro da pasta do vídeo. É o contrato entre
# quem gera (main.run_generate) e quem sobe (aqui), sem passar pelo banco.
THUMBNAIL_NAME = "thumbnail.jpg"
# Limite do YouTube para thumbnail personalizada.
THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024


def thumbnail_for(video_path: str | Path) -> Path:
    """A thumbnail mora ao lado do vídeo, na pasta temporária da geração."""
    return Path(video_path).parent / THUMBNAIL_NAME


def _fit_thumbnail(path: Path) -> Path:
    """Devolve um arquivo dentro do limite de 2 MB do YouTube.

    Sem isto a chamada falha com 400 e o vídeo fica no ar com um frame de
    paisagem sorteado pelo YouTube — sem a DJ, que é justamente o que a
    thumbnail existe para preservar.
    """
    if path.stat().st_size <= THUMBNAIL_MAX_BYTES:
        return path

    from PIL import Image
    shrunk = path.with_name("thumbnail_web.jpg")
    image = Image.open(path).convert("RGB")
    for quality in (90, 80, 70, 60):
        image.save(shrunk, "JPEG", quality=quality, optimize=True)
        if shrunk.stat().st_size <= THUMBNAIL_MAX_BYTES:
            log.info("Thumbnail recomprimida para q=%d (%d bytes)",
                     quality, shrunk.stat().st_size)
            return shrunk
    return shrunk


def _get_credentials(secrets_file: str):
    creds = None
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, "rb") as f:
            creds = pickle.load(f)
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    if not creds or not creds.valid:
        flow = InstalledAppFlow.from_client_secrets_file(secrets_file, SCOPES)
        creds = flow.run_local_server(port=0)
        with open(TOKEN_FILE, "wb") as f:
            pickle.dump(creds, f)
    return creds


def upload_video(
    file_path: str,
    title: str,
    description: str,
    tags: list[str],
    secrets_file: str,
    thumbnail_path: str | Path | None = None,
) -> tuple[str, str | None]:
    """Sobe o vídeo e devolve `(youtube_id, erro_da_thumbnail)`.

    O erro da thumbnail volta como valor em vez de exceção **de propósito**: se
    ele subisse, o `youtube_id` de um upload que já deu certo se perderia e o
    slot seguinte publicaria o mesmo vídeo de novo. Quem chama marca a fila e
    depois avisa sobre a thumbnail.

    Definir a thumbnail passou a ser obrigatório quando o fundo virou paisagem
    (29/08/2026): antes, todo frame do vídeo era a DJ e o frame automático do
    YouTube caía nela por acidente. Agora, sem esta chamada, a DJ some do card.
    """
    creds = _get_credentials(secrets_file)
    youtube = build("youtube", "v3", credentials=creds)
    body = {
        "snippet": {
            "title": title,
            "description": description,
            "tags": tags,
            "categoryId": "10",  # Music
        },
        "status": {"privacyStatus": "public"},
    }
    media = MediaFileUpload(file_path, chunksize=-1, resumable=True,
                            mimetype="video/mp4")
    request = youtube.videos().insert(
        part=",".join(body.keys()), body=body, media_body=media
    )
    response = None
    while response is None:
        _, response = request.next_chunk()
    video_id = response["id"]

    thumb_error = None
    if thumbnail_path is None:
        thumb_error = "Nenhuma thumbnail informada — o YouTube escolheu um frame."
    else:
        thumbnail_path = Path(thumbnail_path)
        if not thumbnail_path.exists():
            thumb_error = f"Thumbnail não encontrada em {thumbnail_path}."
        else:
            try:
                youtube.thumbnails().set(
                    videoId=video_id,
                    media_body=MediaFileUpload(str(_fit_thumbnail(thumbnail_path)),
                                               mimetype="image/jpeg"),
                ).execute()
                log.info("Thumbnail definida: %s", thumbnail_path)
            except Exception as e:
                thumb_error = f"Falha ao definir a thumbnail: {e}"

    if thumb_error:
        log.error("%s (vídeo %s)", thumb_error, video_id)
    return video_id, thumb_error
