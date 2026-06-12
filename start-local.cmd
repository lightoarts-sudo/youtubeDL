@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  pause
  exit /b 1
)

where yt-dlp >nul 2>nul
if errorlevel 1 (
  if not exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\yt-dlp.exe" (
    echo Installing yt-dlp...
    winget install --id yt-dlp.yt-dlp --exact --accept-package-agreements --accept-source-agreements
  )
)

start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:3000"
node server.js

endlocal
