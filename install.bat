@echo off
echo ============================================
echo  Local LLM Client - Install and Build
echo ============================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm not found. Reinstall Node.js.
    pause
    exit /b 1
)

echo [1/4] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)
echo       Done.
echo.

echo [2/4] Building extension...
call npm run compile
if %errorlevel% neq 0 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)
echo       Done.
echo.

echo [3/4] Creating .vsix package...
where vsce >nul 2>&1
if %errorlevel% neq 0 (
    echo       Installing vsce...
    call npm install -g @vscode/vsce
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install vsce.
        pause
        exit /b 1
    )
)
call vsce package --no-dependencies
if %errorlevel% neq 0 (
    echo [ERROR] .vsix creation failed.
    pause
    exit /b 1
)
echo       Done.
echo.

echo [4/4] Installing extension into VSCode...
where code >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] VSCode CLI not found in PATH.
    echo        Open VSCode ^> Extensions ^> ... ^> Install from VSIX
    goto :done
)

set "VSIX_FILE="
for /f "delims=" %%f in ('dir /b "local-llm-client-*.vsix" 2^>nul') do set "VSIX_FILE=%%f"

if defined VSIX_FILE (
    call code --install-extension "%VSIX_FILE%" --force
    if %errorlevel% neq 0 (
        echo [WARN] Install failed. Try manually: Extensions ^> ... ^> Install from VSIX
    ) else (
        echo       Installed: %VSIX_FILE%
    )
) else (
    echo [ERROR] .vsix file not found.
    pause
    exit /b 1
)

:done
echo.
echo ============================================
echo  All done! Restart VSCode to activate.
echo ============================================
echo.
pause
