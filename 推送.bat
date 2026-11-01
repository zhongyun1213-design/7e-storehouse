@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   第一次推送需要登录 GitHub（会弹出浏览器或凭据窗口）。
echo   登录一次之后，这台电脑就记住了。
echo.
git push -u origin main
echo.
if %errorlevel%==0 (
  echo   推送成功。
  echo   接下来去 GitHub 仓库 Settings -^> Pages：
  echo   Source 选 Deploy from a branch，分支 main，目录 / (root)，保存。
  echo   大约一分钟后地址是：https://zhongyun1213-design.github.io/7e-storehouse/
) else (
  echo   推送失败，把上面的报错截图发给小女仆。
)
echo.
pause
