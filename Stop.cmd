@echo off
rem Stopt de Sonos Control-server die op poort 8420 luistert.
powershell -NoProfile -Command ^
  "Get-NetTCPConnection -LocalPort 8420 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; 'Sonos Control gestopt.'"
