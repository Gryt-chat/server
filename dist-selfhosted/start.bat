@echo off
title Gryt Server

REM Load config.env if it exists
if exist config.env (
    for /f "usebackq eol=# tokens=1* delims==" %%a in ("config.env") do (
        if not "%%a"=="" set "%%a=%%b"
    )
)

REM Create data directory if it doesn't exist
if not exist data mkdir data

echo Starting Gryt Image Worker...
start "" /B node image-worker\dist\index.js

echo Starting Gryt SFU...
start "" /B cmd /c "set PORT=%SFU_PORT% && gryt_sfu.exe"

echo Starting Gryt Server...
call gryt_server.bat

pause
