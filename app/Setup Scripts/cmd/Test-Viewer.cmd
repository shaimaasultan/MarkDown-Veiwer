@echo off
rem Tests the viewer page in app\source\ with the documents in docs\test\fixtures\, in Microsoft Edge without a window:
rem the breakdown must add up and nothing that could run code may get into the page. Changes nothing.
rem Extra documents: Test-Viewer.cmd -Folder C:\path\to\folder
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\test-viewer.ps1" %*
pause
