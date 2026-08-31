@echo off
:: Sync diário Instagram → YouTube — Projeto Raquel
set PYTHONIOENCODING=utf-8
cd /d F:\RichClub\projeto-raquel

:: Re-upload de qualquer vídeo com youtube_video_id=NULL no banco (runs anteriores com falha)
"C:\Program Files\Python312\python.exe" deploy\reupload_failed.py > data\run_current.log 2>&1

:: Sync principal: baixa novos do Instagram e publica no YouTube
"C:\Program Files\Python312\python.exe" main.py sync-instagram >> data\run_current.log 2>&1

:: Acumula no log histórico e envia email com resumo
type data\run_current.log >> data\sync.log
"C:\Program Files\Python312\python.exe" deploy\notify_result.py >> data\sync.log 2>&1
