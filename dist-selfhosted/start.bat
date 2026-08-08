@echo off
title Gryt Server

REM Create data directory if it doesn't exist
if not exist data mkdir data

REM No first-run build step any more. It existed to rebuild better-sqlite3
REM against your Node.js version, and the server and image worker have both
REM moved to node:sqlite, which is part of Node itself. The only native module
REM left is sharp, and build-selfhosted.sh already fetches the Windows build of
REM it with npm install --os/--cpu, so there is nothing to compile here.
REM
REM This also means starting the server no longer needs npm on your PATH, only
REM node.

REM node:sqlite is only importable without a flag from Node 22.13 onwards. On
REM anything older both processes die with "No such built-in module:
REM node:sqlite", which does not tell you to upgrade Node, so check it here.
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit((a>22||(a===22&&b>=13))?0:1)" 2>nul
if errorlevel 1 (
    echo.
    echo Your Node.js is too old for this version of Gryt Server.
    echo.
    node -v
    echo Gryt needs Node.js 22.13 or later, because it now uses the SQLite
    echo support built into Node instead of a compiled module.
    echo.
    echo Download the current LTS from https://nodejs.org/ and run this again.
    echo.
    pause
    exit /b 1
)

echo Starting Gryt Image Worker...
start "" /B node --env-file=config.env image-worker\dist\index.js

echo Starting Gryt SFU...
start "" /B gryt_sfu.exe

echo Starting Gryt Server...
call gryt_server.bat

pause
