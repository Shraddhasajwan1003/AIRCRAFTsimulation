  @echo off
title JADO Simulation Launcher
color 0A

if not exist "lib\three.min.js" (
  color 0E
  echo.
  echo  Libraries not found. Please run setup.bat first!
  echo.
  pause
  exit /b 1
)

echo  Launching JADO Aircraft War Simulation...
start "" "%~dp0index.html"
  