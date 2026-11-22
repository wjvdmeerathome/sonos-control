@echo off
rem Start de Sonos Control-server onzichtbaar op de achtergrond (als hij nog niet draait)
rem en opent de app in een eigen Edge-venster.
cd /d "%~dp0"
powershell -NoProfile -WindowStyle Hidden -Command ^
  "try { Invoke-WebRequest http://127.0.0.1:8420/icon.svg -UseBasicParsing -TimeoutSec 1 | Out-Null } catch { Start-Process node -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden; Start-Sleep -Milliseconds 800 }"
start "" msedge --app=http://localhost:8420
