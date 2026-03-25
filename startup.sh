# activate the virtual environment
source python-dotenv/bin/activate

# start Python backend and web front end
python main.py & npm run dev --force
