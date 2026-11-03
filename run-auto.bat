@echo off
REM Deprecated shim kept so existing shortcuts keep working.
REM
REM This file used to hardcode E:\Potential-gold\PluseOPS (deleted), a Python path
REM that may not exist, and keyed live mode off PULSEOPS_APPLY_LIVE - a variable
REM apply.mjs never reads, so the "live" branch never actually submitted anything.
REM
REM The real runner resolves its own binaries, takes a lock, writes a log and
REM passes the apply flags explicitly. See scripts\run-pulseops.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-pulseops.ps1" -Job daily %*
exit /b %ERRORLEVEL%
