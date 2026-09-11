@echo off
setlocal
cd /d "%~dp0"

if exist "%~dp0K线训练.exe" (
  start "K线训练" "%~dp0K线训练.exe"
  exit /b 0
)

if exist "%~dp0K线训练-浏览器版.exe" (
  start "K线训练" "%~dp0K线训练-浏览器版.exe"
  exit /b 0
)

if exist "%~dp0dist-browser\K线训练-浏览器版.exe" (
  start "K线训练" "%~dp0dist-browser\K线训练-浏览器版.exe"
  exit /b 0
)

if exist "%~dp0dist-next\K线训练.exe" (
  start "K线训练" "%~dp0dist-next\K线训练.exe"
  exit /b 0
)

if exist "%~dp0dist\K线训练.exe" (
  start "K线训练" "%~dp0dist\K线训练.exe"
  exit /b 0
)

echo 未找到 K线训练.exe。
echo 请把此脚本和 K线训练.exe 放在同一个文件夹后再双击。
pause
