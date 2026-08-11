@echo off
:: Sync diário Instagram → YouTube — Projeto Raquel
cd /d F:\delirio-manager\projeto-raquel
"C:\Program Files\Python312\python.exe" main.py sync-instagram >> data\sync.log 2>&1
"C:\Program Files\Python312\python.exe" deploy\notify_result.py >> data\sync.log 2>&1
