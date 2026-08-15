@echo off
cd /d "F:\RichClub\youtube-rhetoric-pipeline"
"F:\RichClub\youtube-rhetoric-pipeline\venv\Scripts\python.exe" main.py upload >> "F:\RichClub\youtube-rhetoric-pipeline\data\upload.log" 2>&1
