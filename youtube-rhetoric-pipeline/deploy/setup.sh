#!/bin/bash
set -e

PROJECT_DIR="/opt/youtube-rhetoric-pipeline"
PYTHON="python3.12"
VENV="$PROJECT_DIR/.venv"

echo "=== Deploy YouTube Rhetoric Pipeline ==="

apt-get update -qq
apt-get install -y ffmpeg python3.12 python3.12-venv git -qq

if [ -d "$PROJECT_DIR" ]; then
    cd "$PROJECT_DIR" && git pull
else
    git clone https://github.com/YOUR_USER/youtube-rhetoric-pipeline.git "$PROJECT_DIR"
    cd "$PROJECT_DIR"
fi

$PYTHON -m venv "$VENV"
"$VENV/bin/pip" install -q -r requirements.txt

mkdir -p data/temp assets

crontab deploy/crontab.txt
echo "=== Deploy concluído ==="
