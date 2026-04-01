# EVE Online Tactical Intel Scanner

A high-performance, real-time intelligence dashboard for EVE Online pilots. This tool integrates the official CCP Static Data Export (SDE), EVE Swagger Interface (ESI), zKillboard API, and Eve-Scout signatures into a single tactical interface.

## Features

- **Real-Time Location Tracking** — Authenticate via EVE SSO to track your character's location automatically.
- **Neighborhood Intelligence** — Instantly view PvP activity (1h/24h) for all adjacent star systems.
- **Scout Mode** — Search and "remote scan" any system in New Eden without being physically present.
- **Tactical Overview** — Deep-dive into NPC kills, ship jumps, and active wormhole signatures.
- **Threat Detection** — Detect gate camps (via kill proximity to stargates), interdictor ships, heavy interdictors (HICs), and smartbomb usage from the last hour of kills.
- **Local Chat Parser** — Scan local chat (Ctrl+A, Ctrl+C) to identify pilot danger ratios, security status, and alliance affiliations.
- **Optimized Caching** — TTL-based in-memory caching for Eve-Scout, zKillboard, and sovereignty data to prevent API rate-limiting.
- **Automatic SDE Setup** — Downloads and extracts CCP Static Data Export on first boot.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, Vite, Tailwind CSS 4, Lucide Icons |
| Backend | Node.js, Express, TypeScript |
| Database | SQLite (via better-sqlite3) |
| HTTP Client | Axios with automatic retry on network errors |
| Validation | Zod schemas |
| SDE Data | CCP JSONL Static Data Export (auto-downloaded) |

## Prerequisites

- **Node.js 18+** — [Download](https://nodejs.org/)
- **npm** — bundled with Node.js
- An **[EVE Online Developer Application](https://developers.eveonline.com/)** with callback URL set to `http://localhost:8000/callback`

## Installation

### Quick Setup

**Windows:**
```cmd
setup.bat
```

**Linux/macOS:**
```bash
chmod +x setup.sh
./setup.sh
```

### Manual Setup

```bash
# Install frontend dependencies
npm install

# Install and build backend
cd backend
npm install
npm run build
cd ..
```

## Configuration

Create a `.env` file in the root directory with your EVE Online SSO credentials:

```env
CLIENT_ID=your_eve_client_id
SECRET_KEY=your_eve_secret_key
CALLBACK_URL=http://localhost:8000/callback
PORT=8000
```

## Running the Application

You need to start both the backend and frontend in separate terminals.

### Backend (port 8000)

```bash
cd backend
npm run dev       # development with hot-reload
npm run build     # compile TypeScript
npm start         # production mode
```

### Frontend (port 5173)

```bash
npm run dev       # development server (Vite)
npm run build     # production build
npm run preview   # preview production build
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/search/suggest?q=<query>` | Search solar systems by name |
| GET | `/user/location` | Get authenticated user's current system |
| GET | `/user/status` | Check login status |
| GET | `/system/scout/:system_id` | Get scout signatures for a system |
| GET | `/system/stats/:system_id` | Get kill stats (1h/24h) |
| GET | `/system/path/:system_id` | Get system and immediate connections |
| GET | `/system/threats/:system_id` | Detect gate camps, interdictors, smartbombs |
| GET | `/system/details/:system_id` | Get tactical details with sparkline data |
| POST | `/logout` | Clear authentication tokens |
| GET | `/login` | Redirect to EVE Online SSO |
| GET | `/callback?code=<code>` | SSO callback handler |

## Architecture

### Backend

The Express server handles all external API communication with EVE ESI, zKillboard, and Eve-Scout. Key design decisions:

- **Shared HTTPS agent** with keep-alive to prevent `ECONNRESET` errors under concurrent load
- **Automatic retries** (3 attempts, exponential backoff) for transient network failures
- **TTL-based caching** for all external data: zKill stats (5 min), sovereignty map (1 hr), scout signatures (10 min), tactical details (5 min), threats (10 min)
- **SQLite** via `better-sqlite3` for persistent SSO token storage
- **Zod** for request parameter validation

### Frontend

A React SPA built with Vite and Tailwind CSS. Communicates with the backend via fetch calls to `localhost:8000`.

## SDE Data

On first startup, the backend downloads the EVE Online Static Data Export (~50MB ZIP) from CCP and extracts `mapSolarSystems.jsonl` and `mapStargates.jsonl`. These files are cached in the `backend/` directory and loaded into memory for fast system lookups and jump graph traversal.

## Project Structure

```
.
├── backend/
│   ├── src/
│   │   ├── index.ts        # Express server + all routes
│   │   ├── database.ts     # SQLite setup and token CRUD
│   │   └── schemas.ts      # Zod validation schemas
│   ├── dist/               # Compiled JavaScript (generated)
│   ├── package.json
│   └── tsconfig.json
├── src/                    # React frontend source
├── public/                 # Static assets
├── setup.bat               # Windows setup script
├── setup.sh                # Linux/macOS setup script
└── .env                    # Environment variables (not committed)
```

## License

This project is not affiliated with or endorsed by CCP hf. EVE Online is a registered trademark of CCP hf.
