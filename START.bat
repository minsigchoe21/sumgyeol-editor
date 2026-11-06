@echo off
chcp 65001 > nul
cd /d "%~dp0"
title 숨결 편집기
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% --version >nul 2>nul || (echo [!] 파이썬이 없어요. https://www.python.org 에서 설치하고 다시 실행하세요. & pause & exit /b)
set FFB=%LOCALAPPDATA%\sumgyeol\bin
if not exist "%FFB%\ffmpeg.exe" (
  where ffmpeg >nul 2>nul || (
    echo [i] ffmpeg가 없어서 이 PC에 처음 한 번만 받아요^(약 150MB, GitHub BtbN 빌드^)
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0get_ffmpeg.ps1"
  )
)
echo 숨결 편집기를 켜요. 이 창을 닫으면 편집기가 꺼져요.
%PY% server.py
pause
