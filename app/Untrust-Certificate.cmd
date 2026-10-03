@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0trust.ps1" -Remove
pause
