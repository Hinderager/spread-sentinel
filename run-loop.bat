@echo off
REM Wrapper for the "Stocks Hackathon Spread Sentinel" scheduled task (weekdays 07:20 MT).
REM Runs the agent's loop for the trading day: entry Fridays 14:00 ET, buy-back 10:30 ET on
REM expiry day, half-hourly marks in between. Exits itself after the close.
cd /d "%~dp0"
set LOG=%~dp0..\logs\hackathon.log
echo. >> "%LOG%"
echo ======== %DATE% %TIME% ======== >> "%LOG%"
node.exe agent.js loop >> "%LOG%" 2>&1
exit /b 0
