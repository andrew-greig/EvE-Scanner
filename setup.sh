#!/usr/bin/env bash
set -e

echo "============================================"
echo "EVE Intel Tactical Scanner - Linux Setup"
echo "============================================"
echo

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed."
    echo "Please install Node.js 18+ from https://nodejs.org/"
    echo "Or use your package manager: sudo apt install nodejs npm"
    exit 1
fi

echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"
echo

# Setup frontend
echo "[1/3] Installing frontend dependencies..."
npm install
echo "Frontend dependencies installed."
echo

# Setup backend
echo "[2/3] Installing backend dependencies..."
cd backend
npm install
echo "Backend dependencies installed."
echo

echo "[3/3] Building backend..."
npm run build
echo "Backend built successfully."
cd ..
echo

echo "============================================"
echo "Setup complete!"
echo "============================================"
echo
echo "To start the frontend:  npm run dev"
echo "To start the backend:   cd backend && npm run dev"
echo
