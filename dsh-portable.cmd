@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
set "SCRIPT=%~dp0dsh-portable.mjs"
set "NODE_EXE="

if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "D:\DeepseekHarness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=D:\DeepseekHarness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"

if not defined NODE_EXE (
  echo.
  echo Node.js runtime was not found.
  echo Install and launch DeepSeek Harness once, or install Node.js 22.15+ and retry.
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "%SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  pause
)
exit /b %EXIT_CODE%
