@echo off
REM PulseOps twice-daily runner — 09:00 and 18:00 IST via Task Scheduler
cd /d "E:\Potential-gold\PluseOPS"
set PY=C:\Users\trex2\AppData\Local\Programs\Python\Python312\python.exe
set LOG=logs\auto-%date:~10,4%%date:~4,2%%date:~7,2%-%time:~0,2%%time:~3,2%.log
%PY% -m pulseops_pipeline.main >> "%LOG%" 2>&1
set CODE=%ERRORLEVEL%
if "%PULSEOPS_APPLY_LIVE%"=="1" (
  "C:\Program Files\nodejs\node.exe" apps\browser-apply\apply.mjs --live --auto >> "%LOG%" 2>&1
) else (
  "C:\Program Files\nodejs\node.exe" apps\browser-apply\apply.mjs --dry-run >> "%LOG%" 2>&1
)
exit /b %CODE%
