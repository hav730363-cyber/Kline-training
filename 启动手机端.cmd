@echo off
setlocal
cd /d "%~dp0"

echo.
echo ========================================
echo KLINE TRAINING - PHONE ACCESS
echo ========================================
echo Connect the phone and computer to the same Wi-Fi.
echo Find the WLAN IPv4 address below, then open this on the phone:
ipconfig | findstr /i "IPv4"
echo http://YOUR_IPV4_ADDRESS:8001/
echo.
echo Closing this window stops the phone server.
echo ========================================
echo.

set "HOST=0.0.0.0"
set "PORT=8001"
python server.py
pause
