@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   PolyU 备忘录 · 本地预览
echo   地址：http://127.0.0.1:4173/
echo   关闭这个窗口就停止服务。
echo.
start "" "http://127.0.0.1:4173/"
python -m http.server 4173
pause
