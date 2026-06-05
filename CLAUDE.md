# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Context

This is the RichClub workspace directory, used as the base project for Claude Code sessions. It currently contains a standalone Python utility script for photo restoration via the Replicate API.

## Python Script: test_restore.py

Calls the Replicate API to restore old photos using the CodeFormer model (`sczhou/codeformer`).

**Run:**
```
python test_restore.py <path_to_image>
```

**Dependencies:**
```
pip install replicate requests
```

The script reads an image file, sends it to `sczhou/codeformer` on Replicate with face enhancement and 2x upscale, and saves the output as `foto_restaurada.png` in the current directory.

The `REPLICATE_API_TOKEN` is hardcoded in the file — replace it or set `REPLICATE_API_TOKEN` as an environment variable before running.

## Installed Skills

- `agent-browser` — browser automation CLI (CDP-based). Load usage guide with: `agent-browser skills get core`
