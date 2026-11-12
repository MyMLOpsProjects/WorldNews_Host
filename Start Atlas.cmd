@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto use_python
py -3 server.py --open
goto finished
:use_python
python server.py --open
:finished
if errorlevel 1 pause
