# Automação de Download Suno via Studio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatizar o download das 8 faixas Suno/vídeo do Umbra Sessions via o fluxo "Studio" (Open in Studio → Single-track → Export → Full Song → Go to Song → download), que não conta na cota de 60 downloads/mês do plano Premier — hoje feito manualmente em 5 passos por faixa.

**Architecture:** Script de entrada `suno_downloader.py` (raiz do projeto, mesmo padrão de `check_token.py`/`reauth_youtube.py`), driblando o Suno via subprocess para o CLI `agent-browser` (já instalado, sessão persistida por `--session-name`). Lógica pura (ledger, sanitização de nome, seleção de faixas novas, parsing de snapshot) isolada em funções testáveis; a orquestração de browser em si é validada contra o Suno real numa tarefa de smoke test dedicada, não em teste automatizado (é integração com UI de terceiro sem API oficial).

**Tech Stack:** Python 3.12, `agent-browser` CLI (subprocess), `pytest` para os testes de lógica pura, Resend via `pipeline/notifier.py` já existente pra alerta de falha.

---

## Arquivos afetados

- **Novo**: `pipeline/suno_ledger.py` — persistência do ledger (módulo interno, mesmo nível de `pipeline/notifier.py`, `pipeline/queue.py`)
- **Novo**: `suno_downloader.py` — script de entrada, raiz do projeto (mesmo nível de `check_token.py`)
- **Novo**: `data/suno_downloaded.json` — ledger inicial `{}`, versionado no git
- **Novo**: `pytest.ini` — raiz do projeto, não existe ainda; necessário pra `pytest` achar os módulos (`pipeline.*` e `suno_downloader`) ao rodar da raiz
- **Novo**: `tests/test_suno_ledger.py`
- **Novo**: `tests/test_suno_downloader.py`
- **Depois dos testes passarem**: registrar task `\MusicChannel\SunoDownload` no Task Scheduler (não é arquivo de código — passo de infra local, Task 9)

---

### Task 1: `pytest.ini` — deixar `pytest` achar os módulos do projeto

**Files:**
- Create: `pytest.ini`

- [ ] **Step 1: Criar o arquivo**

```ini
[pytest]
pythonpath = .
testpaths = tests
```

- [ ] **Step 2: Confirmar que pytest reconhece a config**

Run: `python -m pytest --collect-only`
Expected: `collected 0 items` (sem erro de config, nenhum teste ainda existe)

- [ ] **Step 3: Commit**

```bash
git add pytest.ini
git commit -m "chore(umbra-sessions): configura pytest.ini pra achar modulos da raiz"
```

---

### Task 2: `pipeline/suno_ledger.py` — persistência do ledger

**Files:**
- Create: `pipeline/suno_ledger.py`
- Test: `tests/test_suno_ledger.py`

- [ ] **Step 1: Escrever os testes (falhando)**

```python
# tests/test_suno_ledger.py
from pipeline.suno_ledger import load_ledger, save_ledger, is_processed, mark_processed


def test_load_ledger_missing_file_returns_empty_dict(tmp_path):
    missing = tmp_path / "nao_existe.json"
    assert load_ledger(missing) == {}


def test_save_and_load_roundtrip(tmp_path):
    path = tmp_path / "ledger.json"
    save_ledger({"abc123": {"title": "Lagoon Hush", "downloaded_at": "2026-09-14T09:30:00"}}, path)
    assert load_ledger(path) == {"abc123": {"title": "Lagoon Hush", "downloaded_at": "2026-09-14T09:30:00"}}


def test_is_processed():
    ledger = {"abc123": {"title": "Lagoon Hush", "downloaded_at": "2026-09-14T09:30:00"}}
    assert is_processed(ledger, "abc123") is True
    assert is_processed(ledger, "outro-id") is False


def test_mark_processed_adds_entry():
    ledger = {}
    mark_processed(ledger, "abc123", "Lagoon Hush", "2026-09-14T09:30:00")
    assert ledger == {"abc123": {"title": "Lagoon Hush", "downloaded_at": "2026-09-14T09:30:00"}}
```

- [ ] **Step 2: Rodar e confirmar que falha (módulo não existe)**

Run: `python -m pytest tests/test_suno_ledger.py -v`
Expected: FAIL com `ModuleNotFoundError: No module named 'pipeline.suno_ledger'`

- [ ] **Step 3: Implementar**

```python
# pipeline/suno_ledger.py
"""Ledger de faixas do Suno já baixadas via Studio.

Existe pra não rebaixar a mesma faixa em execuções diferentes do
suno_downloader.py — ele roda em polling (8x/dia), então precisa saber o
que já processou entre uma chamada e outra.
"""
import json
from pathlib import Path

LEDGER_PATH = Path(__file__).parent.parent / "data" / "suno_downloaded.json"


def load_ledger(path: Path = LEDGER_PATH) -> dict:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_ledger(ledger: dict, path: Path = LEDGER_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(ledger, f, indent=2, ensure_ascii=False, sort_keys=True)


def is_processed(ledger: dict, song_id: str) -> bool:
    return song_id in ledger


def mark_processed(ledger: dict, song_id: str, title: str, downloaded_at: str) -> None:
    ledger[song_id] = {"title": title, "downloaded_at": downloaded_at}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python -m pytest tests/test_suno_ledger.py -v`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add pipeline/suno_ledger.py tests/test_suno_ledger.py
git commit -m "feat(umbra-sessions): ledger de faixas Suno ja baixadas via Studio"
```

---

### Task 3: `suno_downloader.py` — `sanitize_filename`

**Files:**
- Create: `suno_downloader.py`
- Test: `tests/test_suno_downloader.py`

- [ ] **Step 1: Escrever os testes (falhando)**

```python
# tests/test_suno_downloader.py
from suno_downloader import sanitize_filename


def test_sanitize_filename_leaves_normal_title_untouched():
    assert sanitize_filename("Lagoon Hush") == "Lagoon Hush"


def test_sanitize_filename_replaces_invalid_chars_with_space():
    assert sanitize_filename('Song: "Test"/Mix') == "Song Test Mix"


def test_sanitize_filename_collapses_repeated_spaces():
    assert sanitize_filename("Mix*2026?") == "Mix 2026"


def test_sanitize_filename_blank_title_falls_back_to_untitled():
    assert sanitize_filename("   ") == "untitled"
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python -m pytest tests/test_suno_downloader.py -v`
Expected: FAIL com `ModuleNotFoundError: No module named 'suno_downloader'`

- [ ] **Step 3: Implementar (início do arquivo)**

```python
# suno_downloader.py
"""Baixa faixas novas do Suno via o fluxo Studio, que não conta na cota de
downloads do plano Premier (60/mês) — ver
docs/superpowers/specs/2026-09-14-suno-studio-download-automation-design.md.

Fluxo por faixa (replica os 5 passos manuais validados em 14/09/2026):
Open in Studio > Single-track > Export > Full Song > Go to Song > download.

Uso:
    python suno_downloader.py     # roda 1 ciclo: lista Library, baixa faixas novas
"""
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from pipeline.notifier import notify
from pipeline.suno_ledger import is_processed, load_ledger, mark_processed, save_ledger

AGENT_BROWSER_SESSION = "suno"
SUNO_LIBRARY_URL = "https://suno.com/me"
PENDING_DIR = Path(__file__).parent / "data" / "audio" / "pending"

# Textos e padrão de URL validados manualmente contra o Suno em 14/09/2026.
# Se o Suno mudar a UI do Studio ou da Library, ajustar aqui primeiro —
# ver Task 8 (smoke test) do plano de implementação.
TEXT_OPEN_IN_STUDIO = "Open in Studio"
TEXT_SINGLE_TRACK = "Single-track"
TEXT_EXPORT = "Export"
TEXT_FULL_SONG = "Full Song"
TEXT_SONG_SAVED = "Song Saved"
TEXT_GO_TO_SONG = "Go to Song"
SONG_URL_PATTERN = re.compile(r"/song/([a-zA-Z0-9_-]+)")

_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*]')


class AgentBrowserError(RuntimeError):
    """Um comando do agent-browser falhou (exit code != 0) ou devolveu algo
    que não é o JSON esperado."""


def sanitize_filename(title: str) -> str:
    cleaned = _INVALID_FILENAME_CHARS.sub(" ", title)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or "untitled"
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python -m pytest tests/test_suno_downloader.py -v`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add suno_downloader.py tests/test_suno_downloader.py
git commit -m "feat(umbra-sessions): sanitize_filename pro suno_downloader"
```

---

### Task 4: `select_new_songs` — filtra faixas já processadas

**Files:**
- Modify: `suno_downloader.py`
- Test: `tests/test_suno_downloader.py`

- [ ] **Step 1: Adicionar os testes (falhando)**

```python
# tests/test_suno_downloader.py (acrescentar)
from suno_downloader import select_new_songs


def test_select_new_songs_filters_out_ledger_entries():
    songs = [{"id": "a1", "title": "Lagoon Hush"}, {"id": "b2", "title": "Cabo Mix"}]
    ledger = {"a1": {"title": "Lagoon Hush", "downloaded_at": "2026-09-14T09:00:00"}}
    assert select_new_songs(songs, ledger) == [{"id": "b2", "title": "Cabo Mix"}]


def test_select_new_songs_empty_ledger_returns_all():
    songs = [{"id": "a1", "title": "Lagoon Hush"}]
    assert select_new_songs(songs, {}) == songs


def test_select_new_songs_empty_library_returns_empty():
    assert select_new_songs([], {"a1": {"title": "x", "downloaded_at": "y"}}) == []
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python -m pytest tests/test_suno_downloader.py -v -k select_new_songs`
Expected: FAIL com `ImportError: cannot import name 'select_new_songs'`

- [ ] **Step 3: Implementar (acrescentar depois de `sanitize_filename`)**

```python
def select_new_songs(library_songs: list[dict], ledger: dict) -> list[dict]:
    """library_songs: [{"id": str, "title": str}, ...] extraído da Library.
    Devolve só as que ainda não estão no ledger, na mesma ordem recebida."""
    return [s for s in library_songs if not is_processed(ledger, s["id"])]
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python -m pytest tests/test_suno_downloader.py -v -k select_new_songs`
Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add suno_downloader.py tests/test_suno_downloader.py
git commit -m "feat(umbra-sessions): select_new_songs filtra faixas ja no ledger"
```

---

### Task 5: `parse_library_songs` — extrai id/título dos refs do snapshot

**Files:**
- Modify: `suno_downloader.py`
- Test: `tests/test_suno_downloader.py`

**Nota:** o formato exato dos refs da Library real do Suno (padrão de URL,
que role tem o link da faixa) só é confirmado na Task 8 (smoke test contra
o Suno de verdade). Este teste fixa o contrato assumido — se a Task 8 achar
outro formato, volta aqui e ajusta `SONG_URL_PATTERN`/esta função antes de
seguir.

- [ ] **Step 1: Adicionar os testes (falhando)**

```python
# tests/test_suno_downloader.py (acrescentar)
from suno_downloader import parse_library_songs


def test_parse_library_songs_extracts_id_and_title_from_song_links():
    refs = {
        "e1": {"name": "Umbra Sessions", "role": "heading"},
        "e2": {"name": "Lagoon Hush", "role": "link", "url": "https://suno.com/song/abc-123"},
        "e3": {"name": "Cabo Mix", "role": "link", "url": "https://suno.com/song/def-456"},
        "e4": {"name": "Settings", "role": "link", "url": "https://suno.com/settings"},
    }
    assert parse_library_songs(refs) == [
        {"id": "abc-123", "title": "Lagoon Hush"},
        {"id": "def-456", "title": "Cabo Mix"},
    ]


def test_parse_library_songs_skips_links_without_name():
    refs = {"e1": {"role": "link", "url": "https://suno.com/song/abc-123"}}
    assert parse_library_songs(refs) == []


def test_parse_library_songs_empty_refs_returns_empty():
    assert parse_library_songs({}) == []
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python -m pytest tests/test_suno_downloader.py -v -k parse_library_songs`
Expected: FAIL com `ImportError: cannot import name 'parse_library_songs'`

- [ ] **Step 3: Implementar**

```python
def parse_library_songs(refs: dict) -> list[dict]:
    """refs: dict de refs do `agent-browser snapshot -i -u --json`
    (ref_id -> {"name", "role", "url"?, ...}). Filtra links cuja URL bate
    com o padrão de faixa do Suno e tem nome (título) visível."""
    songs = []
    for ref in refs.values():
        url = ref.get("url") or ""
        match = SONG_URL_PATTERN.search(url)
        if match and ref.get("name"):
            songs.append({"id": match.group(1), "title": ref["name"]})
    return songs
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python -m pytest tests/test_suno_downloader.py -v -k parse_library_songs`
Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add suno_downloader.py tests/test_suno_downloader.py
git commit -m "feat(umbra-sessions): parse_library_songs extrai faixas do snapshot"
```

---

### Task 6: `find_download_ref` — acha o botão de download na página da faixa

**Files:**
- Modify: `suno_downloader.py`
- Test: `tests/test_suno_downloader.py`

**Mesma nota da Task 5:** o rótulo real do botão de download dentro da
página da faixa (depois de "Go to Song") é assumido como contendo a palavra
"download" no nome acessível — confirmar/ajustar na Task 8.

- [ ] **Step 1: Adicionar os testes (falhando)**

```python
# tests/test_suno_downloader.py (acrescentar)
from suno_downloader import find_download_ref


def test_find_download_ref_matches_button_with_download_in_name():
    refs = {
        "e1": {"name": "Lagoon Hush", "role": "heading"},
        "e2": {"name": "Share", "role": "button"},
        "e3": {"name": "Download", "role": "button"},
    }
    assert find_download_ref(refs) == "e3"


def test_find_download_ref_case_insensitive():
    refs = {"e1": {"name": "DOWNLOAD MP3", "role": "button"}}
    assert find_download_ref(refs) == "e1"


def test_find_download_ref_ignores_non_button_roles():
    refs = {"e1": {"name": "Download instructions", "role": "link"}}
    assert find_download_ref(refs) is None


def test_find_download_ref_returns_none_when_absent():
    refs = {"e1": {"name": "Share", "role": "button"}}
    assert find_download_ref(refs) is None
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python -m pytest tests/test_suno_downloader.py -v -k find_download_ref`
Expected: FAIL com `ImportError: cannot import name 'find_download_ref'`

- [ ] **Step 3: Implementar**

```python
def find_download_ref(refs: dict) -> str | None:
    """refs: dict de refs do `agent-browser snapshot -i --json` na página
    de uma faixa aberta via 'Go to Song'. Devolve o ref (ex: 'e3') do botão
    de download, ou None se não achar."""
    for ref_id, ref in refs.items():
        if ref.get("role") == "button" and "download" in (ref.get("name") or "").lower():
            return ref_id
    return None
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python -m pytest tests/test_suno_downloader.py -v -k find_download_ref`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add suno_downloader.py tests/test_suno_downloader.py
git commit -m "feat(umbra-sessions): find_download_ref localiza botao de download"
```

---

### Task 7: `run_agent_browser` — wrapper do subprocess com erro tratado

**Files:**
- Modify: `suno_downloader.py`
- Test: `tests/test_suno_downloader.py`

- [ ] **Step 1: Adicionar os testes (falhando)**

```python
# tests/test_suno_downloader.py (acrescentar)
import subprocess
import pytest
from suno_downloader import run_agent_browser, AgentBrowserError


def test_run_agent_browser_returns_parsed_json_on_success(monkeypatch):
    def fake_run(cmd, capture_output, text, timeout):
        assert cmd[0] == "agent-browser"
        assert "--session-name" in cmd and "suno" in cmd
        assert cmd[-1] == "-i"
        return subprocess.CompletedProcess(cmd, 0, stdout='{"success":true,"data":{"refs":{}}}', stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    result = run_agent_browser("snapshot", "-i")
    assert result == {"success": True, "data": {"refs": {}}}


def test_run_agent_browser_raises_on_nonzero_exit(monkeypatch):
    def fake_run(cmd, capture_output, text, timeout):
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="Element not found: @e5")

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(AgentBrowserError, match="Element not found"):
        run_agent_browser("click", "@e5")


def test_run_agent_browser_raises_on_invalid_json(monkeypatch):
    def fake_run(cmd, capture_output, text, timeout):
        return subprocess.CompletedProcess(cmd, 0, stdout="not json", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(AgentBrowserError, match="não-JSON"):
        run_agent_browser("snapshot", "-i")
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python -m pytest tests/test_suno_downloader.py -v -k run_agent_browser`
Expected: FAIL com `ImportError: cannot import name 'run_agent_browser'`

- [ ] **Step 3: Implementar**

```python
def run_agent_browser(*args: str, timeout: int = 40) -> dict:
    """Roda um comando agent-browser na sessão persistida do Suno (login
    feito 1x manualmente, cookies salvos em disco pelo --session-name).
    Devolve o JSON já parseado. Levanta AgentBrowserError em qualquer falha
    — nunca deixa uma exceção genérica do subprocess vazar pro chamador."""
    cmd = ["agent-browser", "--session-name", AGENT_BROWSER_SESSION, "--json", *args]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise AgentBrowserError(
            f"agent-browser {' '.join(args)} falhou (exit {result.returncode}): "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise AgentBrowserError(
            f"agent-browser {' '.join(args)} devolveu saída não-JSON: {result.stdout[:200]!r}"
        ) from e
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python -m pytest tests/test_suno_downloader.py -v -k run_agent_browser`
Expected: `3 passed`

- [ ] **Step 5: Rodar a suíte inteira antes de seguir**

Run: `python -m pytest tests/ -v`
Expected: todos os testes das Tasks 2-7 passando (17 testes: 4 ledger + 13 downloader)

- [ ] **Step 6: Commit**

```bash
git add suno_downloader.py tests/test_suno_downloader.py
git commit -m "feat(umbra-sessions): run_agent_browser encapsula subprocess com erro tratado"
```

---

### Task 8: Orquestração — `list_library_songs`, `download_track`, `main`

Sem novos testes automatizados nesta task: a partir daqui o código só
encadeia as funções já testadas (Tasks 2-7) com chamadas reais ao
`agent-browser`, que dependem do Suno de verdade no ar — validado
manualmente na Task 9 (smoke test), não com mocks (um mock aqui testaria
a suposição, não o comportamento real do Suno).

**Files:**
- Modify: `suno_downloader.py`

- [ ] **Step 1: Implementar `list_library_songs`**

```python
def list_library_songs() -> list[dict]:
    """Abre a Library do Suno (sessão já logada) e devolve as faixas
    disponíveis como [{"id", "title"}, ...]."""
    run_agent_browser("open", SUNO_LIBRARY_URL)
    run_agent_browser("wait", "--load", "networkidle")
    payload = run_agent_browser("snapshot", "-i", "-u")
    return parse_library_songs(payload["data"]["refs"])
```

- [ ] **Step 2: Implementar `download_track`**

```python
def download_track(song: dict) -> Path:
    """Replica os 5 passos manuais validados: Open in Studio > Single-track
    > Export > Full Song > Go to Song > download. Devolve o path do arquivo
    baixado em data/audio/pending/."""
    run_agent_browser("find", "text", TEXT_OPEN_IN_STUDIO, "click")
    run_agent_browser("wait", "--text", TEXT_SINGLE_TRACK)
    run_agent_browser("find", "text", TEXT_SINGLE_TRACK, "click")
    run_agent_browser("wait", "--text", TEXT_EXPORT)
    run_agent_browser("find", "text", TEXT_EXPORT, "click")
    run_agent_browser("wait", "--text", TEXT_FULL_SONG)
    run_agent_browser("find", "text", TEXT_FULL_SONG, "click")
    run_agent_browser("wait", "--text", TEXT_SONG_SAVED)
    run_agent_browser("find", "text", TEXT_GO_TO_SONG, "click")
    run_agent_browser("wait", "--load", "networkidle")

    payload = run_agent_browser("snapshot", "-i")
    download_ref = find_download_ref(payload["data"]["refs"])
    if download_ref is None:
        raise AgentBrowserError(f"Botão de download não encontrado na página de '{song['title']}'")

    PENDING_DIR.mkdir(parents=True, exist_ok=True)
    dest = PENDING_DIR / f"{sanitize_filename(song['title'])}.mp3"
    run_agent_browser("download", f"@{download_ref}", str(dest))

    if not dest.exists() or dest.stat().st_size == 0:
        raise AgentBrowserError(f"Download de '{song['title']}' não gerou arquivo válido em {dest}")
    return dest
```

- [ ] **Step 3: Implementar `main`**

```python
def main() -> int:
    ledger = load_ledger()
    try:
        songs = list_library_songs()
    except Exception as e:
        notify("Suno Downloader — falha ao listar Library",
               [f"Erro: {e}",
                "Faixas novas não foram baixadas neste ciclo.",
                "Sessão do Suno pode ter expirado — checar login "
                "(agent-browser --session-name suno --headed open https://suno.com)."],
               status="fail")
        return 1

    new_songs = select_new_songs(songs, ledger)
    if not new_songs:
        print("Nenhuma faixa nova.")
        return 0

    downloaded, failed = [], []
    for song in new_songs:
        try:
            dest = download_track(song)
            mark_processed(ledger, song["id"], song["title"], datetime.now().isoformat(timespec="seconds"))
            save_ledger(ledger)  # grava a cada sucesso, não só no fim — não perde progresso se travar no meio
            downloaded.append(dest.name)
        except Exception as e:
            failed.append((song["title"], str(e)))

    if failed:
        notify("Suno Downloader — algumas faixas falharam",
               [f"Baixadas: {len(downloaded)} — {', '.join(downloaded) or 'nenhuma'}",
                f"Falharam: {len(failed)}"] + [f"  - {title}: {err}" for title, err in failed],
               status="warn" if downloaded else "fail")
    else:
        print(f"{len(downloaded)} faixa(s) baixada(s): {', '.join(downloaded)}")

    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Rodar a suíte inteira — nada deve ter quebrado**

Run: `python -m pytest tests/ -v`
Expected: mesmos 17 testes de antes, todos passando (`main`/`list_library_songs`/`download_track` não têm teste automatizado, só precisam não quebrar o import)

- [ ] **Step 5: Criar o ledger inicial versionado**

```bash
echo '{}' > data/suno_downloaded.json
```

- [ ] **Step 6: Commit**

```bash
git add suno_downloader.py data/suno_downloaded.json
git commit -m "feat(umbra-sessions): orquestracao do suno_downloader (list/download/main)"
```

---

### Task 9: Smoke test contra o Suno real (manual, com André)

Não dá pra automatizar esta task — precisa do login do André na conta Suno
real. Sem isso, os textos/seletores das Tasks 5, 6 e 8 (`TEXT_OPEN_IN_STUDIO`,
`SONG_URL_PATTERN`, `find_download_ref`) são suposições, não fatos.

- [ ] **Step 1: Login único na sessão persistida**

```bash
agent-browser --session-name suno --headed open https://suno.com
```

Pedir pro André logar na janela que abrir. Depois de logado:

```bash
agent-browser --session-name suno state save
```

(Não digitar a senha do André em lugar nenhum — login é sempre feito por ele
na janela do browser.)

- [ ] **Step 2: Rodar `list_library_songs` isolado e inspecionar**

```bash
python -c "from suno_downloader import list_library_songs; import json; print(json.dumps(list_library_songs(), indent=2, ensure_ascii=False))"
```

Expected: lista de `{"id", "title"}` com pelo menos 1 faixa real do André.
**Se vier vazia:** rodar `agent-browser --session-name suno snapshot -i -u`
direto e conferir manualmente qual é o padrão real de URL/role dos links de
faixa na Library — ajustar `SONG_URL_PATTERN` em `suno_downloader.py`
(Task 5) até bater.

- [ ] **Step 3: Rodar `download_track` com 1 faixa real**

```bash
python -c "
from suno_downloader import list_library_songs, download_track
songs = list_library_songs()
print(download_track(songs[0]))
"
```

Expected: caminho de um `.mp3` em `data/audio/pending/`, tamanho > 0.
**Se algum passo falhar** (`Element not found`, texto não achado): rodar o
comando `agent-browser` daquele passo isolado com `--headed` pra ver a tela
e achar o texto/role certo, ajustar a constante correspondente em
`suno_downloader.py` (Tasks 3 e 6), repetir este Step.

- [ ] **Step 4: Confirmar que não consumiu a cota**

Abrir `suno.com` no navegador normal do André, checar o contador de
"Downloads" (mesmo card do início desta conversa) — **não pode ter
mudado**. Se mudou, o fluxo não está passando pelo Studio de verdade —
revisar os passos antes de prosseguir (não plugar no Scheduler até isso
bater).

- [ ] **Step 5: Rodar `main()` completo pra validar o ciclo inteiro**

```bash
python suno_downloader.py
```

Expected: baixa o resto das faixas novas da Library, imprime
`N faixa(s) baixada(s): ...`, exit code 0.

- [ ] **Step 6: Rodar de novo imediatamente — confirmar idempotência**

```bash
python suno_downloader.py
```

Expected: `Nenhuma faixa nova.`, exit code 0 (ledger já marcou tudo da
rodada anterior).

- [ ] **Step 7: Commit se algum ajuste de seletor foi necessário**

```bash
git add suno_downloader.py
git commit -m "fix(umbra-sessions): ajusta seletores do suno_downloader apos smoke test real"
```

(Pular este commit se nada precisou mudar nas Tasks 3/5/6/8.)

---

### Task 10: Task Scheduler — `\MusicChannel\SunoDownload`

Classificação MEDIUM (config/infra local, não destrutivo, reversível
deletando a task) — registrar em `.claude/decision.log` do projeto.

- [ ] **Step 1: Registrar a task com os 8 horários (08:00–11:45, de 30 em 30)**

```powershell
$pythonExe = (Get-Command python).Source
$scriptPath = "F:\RichClub\music-channel-pipeline\suno_downloader.py"
$workDir = "F:\RichClub\music-channel-pipeline"

$times = @("08:00","08:30","09:00","09:30","10:00","10:30","11:00","11:30","11:45")
$triggers = $times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }

$action = New-ScheduledTaskAction -Execute $pythonExe -Argument "`"$scriptPath`"" -WorkingDirectory $workDir
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -DontStopOnIdleEnd

Register-ScheduledTask -TaskName "SunoDownload" -TaskPath "\MusicChannel\" `
  -Action $action -Trigger $triggers -Settings $settings -Description `
  "Baixa faixas novas do Suno via Studio (nao conta na cota de downloads). Polling 08:00-11:45."
```

**Nota:** a lista `$times` tem 9 horários, não 8 — a spec pedia "a cada 30
min, 08:00-11:45", que dá 08:00, 08:30, ..., 11:30 (8 horários de 30 em 30)
mais o 11:45 fora do passo de 30 min pra garantir 1 check bem colado antes
do `Generate` das 12:00 (mesma folga que a spec já justificou pro
`Generate` ter migrado de 10:00→12:00). Se preferir exatamente 8 execuções
redondas, tirar o "11:45" da lista.

- [ ] **Step 2: Confirmar registrada**

```powershell
Get-ScheduledTask -TaskPath "\MusicChannel\" -TaskName "SunoDownload" | Select-Object TaskName, State
```

Expected: `SunoDownload` / `Ready`

- [ ] **Step 3: Rodar manualmente 1x pelo Scheduler (não só via `python` direto) pra confirmar o ambiente da task bate**

```powershell
Start-ScheduledTask -TaskPath "\MusicChannel\" -TaskName "SunoDownload"
Start-Sleep -Seconds 30
Get-ScheduledTask -TaskPath "\MusicChannel\" -TaskName "SunoDownload" | Get-ScheduledTaskInfo | Select-Object LastTaskResult
```

Expected: `LastTaskResult` = `0`

- [ ] **Step 4: Registrar a decisão MEDIUM**

Anexar a `F:\RichClub\.claude\decision.log`:

```
[2026-09-14 HH:MM] MEDIUM | Register-ScheduledTask SunoDownload (\MusicChannel\) | razão: nova automação de infra local, não destrutiva, reversível (Unregister-ScheduledTask desfaz)
```

- [ ] **Step 5: Commit final (se `decision.log` for versionado — conferir se já está no git)**

```bash
git status --short .claude/decision.log
```

Se rastreado:
```bash
git add .claude/decision.log
git commit -m "chore(umbra-sessions): registra task SunoDownload no Task Scheduler"
```

Se não rastreado (arquivo local de operação, não código), pular o commit.

---

## Resumo de cobertura da spec

| Requisito da spec | Task |
|---|---|
| Ledger de idempotência | 2 |
| Sanitização de nome de arquivo | 3 |
| Filtro de faixas novas | 4 |
| Parse da Library (snapshot) | 5, validado na 9 |
| Localizar botão de download | 6, validado na 9 |
| Wrapper de subprocess com erro tratado | 7 |
| Fluxo completo de 5 passos + orquestração | 8 |
| Alerta por e-mail em falha (`notifier.py`) | 8 |
| Não alertar quando não há faixa nova | 8 |
| Validação manual contra Suno real, contador de downloads intacto | 9 |
| Task Scheduler, polling 08:00-11:45 | 10 |
