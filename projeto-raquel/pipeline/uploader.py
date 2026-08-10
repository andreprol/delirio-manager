"""
Uploader para o canal Raquel Pires.
Reutiliza a lógica de autenticação OAuth2 do youtube-rhetoric-pipeline.
"""
import sys
import os
from pathlib import Path

# Permite importar o uploader do pipeline irmão quando rodando do mesmo repo
_sibling = Path(__file__).resolve().parents[2] / "youtube-rhetoric-pipeline"
if _sibling.exists() and str(_sibling) not in sys.path:
    sys.path.insert(0, str(_sibling))

try:
    from pipeline.uploader import upload_video as _upload_video  # type: ignore
    _USE_SIBLING = True
except ImportError:
    _USE_SIBLING = False


def upload_video(
    file_path: str,
    title: str,
    description: str,
    tags: list[str],
    secrets_file: str = None,
    made_for_kids: bool = False,
    privacy: str = "public",
) -> str:
    """
    Faz upload de um vídeo para o canal Raquel Pires no YouTube.
    Retorna o ID do vídeo publicado.
    """
    secrets_file = secrets_file or os.getenv(
        "YOUTUBE_CLIENT_SECRETS_FILE", "config/client_secrets.json"
    )

    if _USE_SIBLING:
        return _upload_video(
            file_path=file_path,
            title=title,
            description=description,
            tags=tags,
            secrets_file=secrets_file,
        )

    # Fallback: stub para desenvolvimento sem o módulo irmão
    raise NotImplementedError(
        "Uploader não disponível. "
        "Certifique-se de que youtube-rhetoric-pipeline está no mesmo repositório, "
        "ou instale google-api-python-client e implemente upload_video aqui."
    )
