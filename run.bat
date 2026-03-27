@echo off
REM Launch Synap locally
REM Usage: run.bat [config_file]
REM Examples:
REM   run.bat                          Opens with default config (configs/sample.json)
REM   run.bat configs/my-study.json    Opens with a specific config

set PORT=8000
set CONFIG=%~1
set URL=http://localhost:%PORT%

if not "%CONFIG%"=="" (
  set URL=%URL%?config=%CONFIG%
)

echo Starting Synap on %URL%
echo Press Ctrl+C to stop
echo.

start "" "%URL%"
python -m http.server %PORT%
