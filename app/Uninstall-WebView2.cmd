@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" -WebView2
pause
