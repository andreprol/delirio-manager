"""Refaz um vídeo de um tema específico, fora da rotação diária.

Existe porque o Rio de 21/08/2026 saiu com franja no avatar (bug de prompt, já
corrigido em image_gen.py) e com trilha ruim. Refazer pelo `main.py generate`
normal não serve: ele pega o PRÓXIMO tema da rotação e marca tema e composição
como usados, empurrando o ciclo dos 12 destinos.

    python regenerate.py rio night_front

Consome os MP3s de data/audio/pending/ como qualquer geração — conferir que os
arquivos ali são mesmo os da trilha desejada antes de rodar.
"""
import sys

import main

USAGE = "uso: python regenerate.py <theme_id> [composition_id]"


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(USAGE)

    theme_id = sys.argv[1]
    composition_id = sys.argv[2] if len(sys.argv) > 2 else None

    main._preflight("generate")
    main.run_generate(
        theme_id=theme_id,
        composition_id=composition_id,
        mark_rotation=False,
    )
