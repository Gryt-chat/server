@echo off
title Gryt Server

REM Create .env from config.env so all services can load it
if exist config.env copy /Y config.env .env >nul

REM Create data directory if it doesn't exist
if not exist data mkdir data

REM First-run: build native modules for the local Node.js version
if not exist .setup_done (
    echo First-time setup: building native modules for your Node.js version...
    echo.
    pushd server && call npm rebuild better-sqlite3 2>nul && popd
    pushd image-worker && call npm rebuild better-sqlite3 2>nul && popd
    echo. > .setup_done
    echo Setup complete.
    echo.
)

echo Starting Gryt Image Worker...
start "" /B node --env-file=.env image-worker\dist\index.js

echo Starting Gryt SFU...
start "" /B gryt_sfu.exe

echo Starting Gryt Server...
call gryt_server.bat

pause
