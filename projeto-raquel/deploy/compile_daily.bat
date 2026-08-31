@echo off
:: Pipeline diário 16:9 — Projeto Raquel
:: Substitui sync_daily.bat: em vez de republicar Reels verticais (que o YouTube
:: classifica como Shorts e não geram horas de exibição), acumula os Reels num
:: pool e publica compilados horizontais de 10-15 min.
set PYTHONIOENCODING=utf-8
cd /d F:\RichClub\projeto-raquel

:: 1. Baixa Reels novos para o pool (não publica nada)
"C:\Program Files\Python312\python.exe" main.py fetch 25 > data\run_current.log 2>&1

:: 2. Monta no máximo 1 compilado por rodada (render é caro; pool sobra para amanhã)
"C:\Program Files\Python312\python.exe" main.py compile 1 >> data\run_current.log 2>&1

:: 3. Publica os compilados prontos
"C:\Program Files\Python312\python.exe" main.py publish >> data\run_current.log 2>&1

:: 4. Estado final do pool no log
"C:\Program Files\Python312\python.exe" main.py pool >> data\run_current.log 2>&1

:: 5. Acumula no log histórico e envia email com resumo
type data\run_current.log >> data\sync.log
"C:\Program Files\Python312\python.exe" deploy\notify_result.py >> data\sync.log 2>&1
