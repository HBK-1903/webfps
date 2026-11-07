@echo off
REM ===================================================================
REM  SIFIR NOKTA - Windows desktop launcher ("app window" experience)
REM  Runs the offline single-file build in a dedicated Chrome/Edge
REM  window: no tabs, no address bar, no browser chrome.
REM ===================================================================
setlocal
set GAME=%~dp0..\dist\SifirNokta.html
if not exist "%GAME%" (
  echo [HATA] dist\SifirNokta.html bulunamadi.
  echo Once proje klasorunde "npm run build" calistir.
  pause
  exit /b 1
)
set URL=file:///%GAME:\=/%

set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set CHROME=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set CHROME=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe

if "%CHROME%"=="" (
  echo Chrome/Edge bulunamadi, varsayilan tarayicida aciliyor.
  start "" "%GAME%"
  exit /b 0
)

start "" "%CHROME%" --app="%URL%" --window-size=1600,900 --user-data-dir="%TEMP%\sifirnokta-profile" --no-first-run --disable-features=Translate --autoplay-policy=no-user-gesture-required
endlocal
