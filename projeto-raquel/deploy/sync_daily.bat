@echo off
:: Sync diário Instagram → YouTube — Projeto Raquel
:: Configurar no Agendador de Tarefas do Windows para rodar diariamente

cd /d F:\delirio-manager\projeto-raquel
python main.py sync-instagram >> data\sync.log 2>&1
