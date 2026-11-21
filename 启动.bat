@echo off
rem 音集 MusicHub — 一键启动（首次运行会自动安装依赖）
cd /d "%~dp0"
where npm >nul 2>nul || (echo 未找到 npm，请先安装 Node.js & pause & exit /b 1)
if not exist "node_modules\electron" (
  echo 首次运行，正在安装依赖…
  call npm install || (echo 安装失败 & pause & exit /b 1)
)
start "" npx electron .
