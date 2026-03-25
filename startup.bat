@echo off
:: Activate the virtual environment
call .\python-dotenv\Scripts\activate.bat

:: Start the Python Backend in a minimized or separate window
start "EVE-Intel-Backend" python main.py

:: Run the Frontend in the current window
npm run dev --force
