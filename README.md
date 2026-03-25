# EVE Online Tactical Intel Scanner

A high-performance, real-time intelligence dashboard for EVE Online pilots. This tool integrates the official CCP Static Data Export (SDE), EVE Swagger Interface (ESI), zKillboard API, and Eve-Scout signatures into a single tactical interface.

## 🚀 Features

* **Real-Time Location Tracking:** Authenticate via EVE SSO to track your character's location automatically.
* **Neighborhood Intelligence:** Instantly view PvP activity (1h/24h) for all adjacent star systems.
* **Scout Mode:** Search and "remote scan" any system in New Eden without being physically present.
* **Tactical Overview:** Deep-dive into NPC kills, ship jumps, and active signatures.
* **Local Chat Parser:** Scan local chat (Ctrl+A, Ctrl+C) to identify pilot danger ratios, security status, and alliance affiliations.
* **Threat Detection:** Visual pulsing alerts and audio cues when high-danger pilots are detected.
* **Optimized Caching:** Background workers refresh Eve-Scout every 5 minutes and cache zKillboard stats to prevent API rate-limiting.

---

## 🛠️ Technical Stack

* **Frontend:** React, Vite, Tailwind CSS, Lucide Icons.
* **Backend:** FastAPI (Python), SQLAlchemy, Httpx.
* **Database:** SQLite (Local storage for SSO tokens).
* **Data:** Official CCP JSONL SDE (Automatic download on first boot).

---

## 📥 Installation

### 1. Prerequisites
* [Python 3.10+](https://www.python.org/downloads/)
* [Node.js & NPM](https://nodejs.org/)
* An [EVE Online Developer Application](https://developers.eveonline.com/) (Set Callback to `http://localhost:8000/callback`).

### 2. Environment Setup
Create a `.env` file in the root directory:
```env
CLIENT_ID=your_eve_client_id
SECRET_KEY=your_eve_secret_key
CALLBACK_URL=http://localhost:8000/callback
```

### 3. Dependencies

#### Backend
```python
python -m venv python-dotenv
source python-dotenv/bin/activate  # Windows: .\python-dotenv\Scripts\activate
pip install fastapi uvicorn httpx sqlalchemy python-dotenv
```

#### Frontend
```
npm install
```

### 4. Startup
Run `startup.bat` for Windows or `startup.sh` for Linux installations.