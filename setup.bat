@echo off
echo ============================================
echo EVE Intel Tactical Scanner - Windows Setup
echo ============================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed.
    echo Please install Node.js 18+ from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Node.js version:
node --version
echo npm version:
npm --version
echo.

REM Setup frontend
echo [1/3] Installing frontend dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Frontend dependency installation failed.
    pause
    exit /b 1
)
echo Frontend dependencies installed.
echo.

REM Setup backend
echo [2/3] Installing backend dependencies...
cd backend
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Backend dependency installation failed.
    pause
    exit /b 1
)
echo Backend dependencies installed.
echo.

echo [3/3] Building backend...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Backend build failed.
    pause
    exit /b 1
)
echo Backend built successfully.
cd ..
echo.

echo ============================================
echo Setup complete!
echo ============================================
echo.
echo To start the frontend:  npm run dev
echo To start the backend:   cd backend ^&^& npm run dev
echo.
pause
