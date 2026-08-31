"""Prepara o acervo de cenário de um ou mais temas, fora do horário do slot.

    python build_scenery.py hawaii          # um tema
    python build_scenery.py --all           # os 12, em ordem de rotação
    python build_scenery.py hawaii --images-only

As 30 imagens custam ~$1,80 por local e o segmento de 9 min leva alguns
minutos de ffmpeg. Rodar aqui, à mão, evita que o `Generate` das 10:00 estoure
o horário na primeira vez que um tema aparece — o slot só encontra tudo pronto
e monta o vídeo em ~1min30.

Seguro de repetir: imagem que já existe não é regerada nem recobrada, e o
segmento só é remontado se faltar (ou com --force-segment).
"""
import argparse
import json
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

from pipeline.scenery_gen import ensure_scenery, ensure_segment


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("themes", nargs="*", help="ids em config/themes.json")
    ap.add_argument("--all", action="store_true", help="todos os temas")
    ap.add_argument("--images-only", action="store_true", help="não montar o segmento")
    ap.add_argument("--force-segment", action="store_true", help="remontar o segmento")
    args = ap.parse_args()

    all_themes = json.loads(Path("config/themes.json").read_text(encoding="utf-8"))
    if args.all:
        selected = all_themes
    elif args.themes:
        by_id = {t["id"]: t for t in all_themes}
        unknown = [t for t in args.themes if t not in by_id]
        if unknown:
            sys.exit(f"Tema(s) inexistente(s) em config/themes.json: {', '.join(unknown)}")
        selected = [by_id[t] for t in args.themes]
    else:
        sys.exit("Informe ao menos um tema, ou --all.")

    for theme in selected:
        log.info("=== %s ===", theme["name"])
        images = ensure_scenery(theme)
        if not args.images_only:
            ensure_segment(theme, images, force=args.force_segment)


if __name__ == "__main__":
    main()
