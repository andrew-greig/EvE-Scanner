import os, base64, httpx, logging, asyncio, math, time, json, zipfile, io
from datetime import datetime, timezone
from typing import List, Dict, Optional
from fastapi import FastAPI, HTTPException
from fastapi.responses import RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, Column, Integer, String
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from pydantic import BaseModel
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

load_dotenv()
CLIENT_ID, SECRET_KEY, CALLBACK_URL = os.getenv("CLIENT_ID"), os.getenv("SECRET_KEY"), os.getenv("CALLBACK_URL")
ESI_URL, ZKILL_URL, EVESCOUT_URL = "https://esi.evetech.net/latest", "https://zkillboard.com/api", "https://api.eve-scout.com/v2/public/signatures"
USER_AGENT = "EVE-Intel-Tactical-Scanner-v1"

SDE_ZIP_URL = "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip"

# TTLs
ZKILL_CACHE_TTL = 600    # 10 minutes — kill counts don't shift dramatically per-minute
SOV_CACHE_TTL = 3600     # 1 hour — sov changes are infrequent
SCOUT_CACHE_TTL = 180    # 3 minutes — shared across all endpoints
TAC_CACHE_TTL = 300      # 5 minutes — NPC kills / jumps (ESI updates hourly anyway)

TOKEN_CACHE = {"access_token": None, "expiry": 0}
Z_CACHE: Dict = {}
NAME_CACHE: Dict = {}
SOV_MAP: Dict = {}
TAC_CACHE: Dict = {}

# Shared EVE-Scout cache — one fetch serves /user/location, /system/scout/, /system/details/
SCOUT_CACHE: Dict = {"data": None, "expiry": 0}

# Sovereignty owner name cache — alliance/faction names almost never change
SOV_NAME_CACHE: Dict = {}
SOV_MAP_EXPIRY: float = 0.0

SYSTEM_INDEX = []
JUMP_GRAPH = {}

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

Base = declarative_base()
engine = create_engine('sqlite:///eve_intel.db', connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

class UserToken(Base):
    __tablename__ = "tokens"
    character_id, character_name, refresh_token = Column(Integer, primary_key=True), Column(String), Column(String)

Base.metadata.create_all(bind=engine)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

async def get_scout_data(client: httpx.AsyncClient) -> list:
    """Return cached EVE-Scout signatures, refreshing at most every SCOUT_CACHE_TTL seconds."""
    now = time.time()
    if SCOUT_CACHE["data"] is not None and SCOUT_CACHE["expiry"] > now:
        return SCOUT_CACHE["data"]
    try:
        res = await client.get(EVESCOUT_URL)
        data = res.json() if res.status_code == 200 else []
    except Exception:
        data = SCOUT_CACHE["data"] or []
    SCOUT_CACHE["data"] = data
    SCOUT_CACHE["expiry"] = now + SCOUT_CACHE_TTL
    return data


async def get_sov_map(client: httpx.AsyncClient) -> dict:
    """Return sovereignty map, refreshing at most every SOV_CACHE_TTL seconds."""
    global SOV_MAP, SOV_MAP_EXPIRY
    now = time.time()
    if SOV_MAP and SOV_MAP_EXPIRY > now:
        return SOV_MAP
    try:
        res = await client.get(f"{ESI_URL}/sovereignty/map/")
        if res.status_code == 200:
            SOV_MAP = {}
            for item in res.json():
                SOV_MAP[item['system_id']] = item.get('alliance_id') or item.get('faction_id')
            SOV_MAP_EXPIRY = now + SOV_CACHE_TTL
            logging.info("Sovereignty map refreshed.")
    except Exception as e:
        logging.warning(f"Sov map refresh failed: {e}")
    return SOV_MAP


async def get_owner_name(client: httpx.AsyncClient, entity_id: int) -> str:
    """Return cached entity name, fetching from ESI only on first encounter."""
    if entity_id in SOV_NAME_CACHE:
        return SOV_NAME_CACHE[entity_id]
    try:
        res = await client.post(f"{ESI_URL}/universe/names/", json=[entity_id])
        if res.status_code == 200:
            name = res.json()[0]['name']
            SOV_NAME_CACHE[entity_id] = name
            return name
    except Exception:
        pass
    return "Unclaimed"


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup_event():
    global SYSTEM_INDEX, JUMP_GRAPH
    async with httpx.AsyncClient(timeout=600.0, follow_redirects=True) as client:
        # Pre-populate sov map on startup (sets SOV_MAP_EXPIRY so it won't refetch for 1h)
        await get_sov_map(client)

        try:
            if not os.path.exists("mapSolarSystems.jsonl") or not os.path.exists("mapStargates.jsonl"):
                r = await client.get(SDE_ZIP_URL)
                with zipfile.ZipFile(io.BytesIO(r.content)) as z:
                    for f in z.namelist():
                        if "mapSolarSystems.jsonl" in f:
                            with open("mapSolarSystems.jsonl", "wb") as out: out.write(z.read(f))
                        if "mapStargates.jsonl" in f:
                            with open("mapStargates.jsonl", "wb") as out: out.write(z.read(f))

            with open("mapSolarSystems.jsonl", "r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip(): continue
                    s = json.loads(line)
                    raw_id = s.get("_key") or s.get("solarSystemID") or s.get("id")
                    if raw_id is None: continue

                    sys_id = int(raw_id)
                    raw_name = s.get("name")
                    if isinstance(raw_name, dict): sys_name = raw_name.get("en", f"System {sys_id}")
                    else: sys_name = raw_name or s.get("solarSystemName", f"System {sys_id}")

                    SYSTEM_INDEX.append({
                        "name": sys_name,
                        "id": sys_id,
                        "sec": round(float(s.get("securityStatus", s.get("security", 0))), 1)
                    })
                    NAME_CACHE[sys_id] = sys_name

            with open("mapStargates.jsonl", "r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip(): continue
                    g = json.loads(line)
                    fid = g.get("solarSystemID")
                    if not fid: continue

                    dest = g.get("destination", {})
                    tid = dest.get("solarSystemID")
                    if not tid: continue

                    fid, tid = int(fid), int(tid)
                    if fid not in JUMP_GRAPH: JUMP_GRAPH[fid] = []
                    JUMP_GRAPH[fid].append(tid)

        except Exception as e:
            logging.error(f"SDE Setup Failed: {e}")


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def get_jump_distance(start_id: int, end_id: int) -> int:
    if start_id == end_id: return 0
    if start_id not in JUMP_GRAPH or end_id not in JUMP_GRAPH: return -1
    queue, visited = [(start_id, 0)], {start_id}
    while queue:
        curr, dist = queue.pop(0)
        if curr == end_id: return dist
        for nxt in JUMP_GRAPH.get(curr, []):
            if nxt not in visited:
                visited.add(nxt); queue.append((nxt, dist + 1))
    return -1


async def get_valid_token(client, user):
    now = time.time()
    if TOKEN_CACHE["access_token"] and TOKEN_CACHE["expiry"] > now + 120:
        return TOKEN_CACHE["access_token"]
    auth_header = base64.b64encode(f"{CLIENT_ID}:{SECRET_KEY}".encode()).decode()
    res = await client.post(
        "https://login.eveonline.com/v2/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": user.refresh_token},
        headers={"Authorization": f"Basic {auth_header}"}
    )
    data = res.json()
    TOKEN_CACHE["access_token"], TOKEN_CACHE["expiry"] = data["access_token"], now + data["expires_in"]
    return TOKEN_CACHE["access_token"]


async def get_stats_bundle(client, system_id):
    """Fetch zKill stats for a system, cached for ZKILL_CACHE_TTL (10 min)."""
    now = time.time()
    if system_id in Z_CACHE and Z_CACHE[system_id]["expiry"] > now:
        return Z_CACHE[system_id]["data"]
    try:
        t1, t2 = (
            client.get(f"{ZKILL_URL}/solarSystemID/{system_id}/pastSeconds/3600/"),
            client.get(f"{ZKILL_URL}/solarSystemID/{system_id}/pastSeconds/86400/")
        )
        r1, r2 = await asyncio.gather(t1, t2)
        sys_info = next((s for s in SYSTEM_INDEX if s["id"] == system_id),
                        {"name": NAME_CACHE.get(system_id, f"ID:{system_id}"), "sec": 0.0})

        sov = await get_sov_map(client)
        owner_name = "Unclaimed"
        if sov.get(system_id):
            owner_name = await get_owner_name(client, sov[system_id])

        data = {
            "id": system_id,
            "name": sys_info["name"],
            "sec": sys_info["sec"],
            "k1h": len(r1.json() if r1.status_code == 200 else []),
            "k24h": len(r2.json() if r2.status_code == 200 else []),
            "owner": owner_name
        }
        Z_CACHE[system_id] = {"data": data, "expiry": now + ZKILL_CACHE_TTL}
        return data
    except:
        return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/search/suggest")
async def suggest_system(q: str, current_id: Optional[int] = None):
    if len(q) < 2: return []
    matches = [s.copy() for s in SYSTEM_INDEX if q.lower() in s["name"].lower()][:5]
    if current_id:
        for m in matches: m["jumps"] = get_jump_distance(int(current_id), m["id"])
    return matches


@app.get("/user/location")
async def get_location():
    db = SessionLocal(); user = db.query(UserToken).first(); db.close()
    if not user: raise HTTPException(401)
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}) as client:
        token = await get_valid_token(client, user)
        loc_res = await client.get(
            f"{ESI_URL}/characters/{user.character_id}/location/",
            headers={"Authorization": f"Bearer {token}"}
        )
        curr_id = loc_res.json()["solar_system_id"]

        scout_data = await get_scout_data(client)
        scout_ids = {s.get('in_system_id') for s in scout_data} | {s.get('out_system_id') for s in scout_data}

        current = await get_stats_bundle(client, curr_id)
        if not current: return {"current": None, "connections": []}
        current["has_scout"] = curr_id in scout_ids
        connections = await asyncio.gather(*[get_stats_bundle(client, did) for did in JUMP_GRAPH.get(curr_id, [])])
        conn_list = [c for c in connections if c]
        for c in conn_list:
            c["has_scout"] = c["id"] in scout_ids
        return {"current": current, "connections": conn_list}


@app.get("/system/scout/{system_id}")
async def get_scout_intel(system_id: int):
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}) as client:
        scout_data = await get_scout_data(client)
        scout_ids = {s.get('in_system_id') for s in scout_data} | {s.get('out_system_id') for s in scout_data}

        current = await get_stats_bundle(client, system_id)
        if not current: return {"current": None, "connections": []}
        current["has_scout"] = system_id in scout_ids
        connections = await asyncio.gather(*[get_stats_bundle(client, did) for did in JUMP_GRAPH.get(system_id, [])])
        conn_list = [c for c in connections if c]
        for c in conn_list:
            c["has_scout"] = c["id"] in scout_ids
        return {"current": current, "connections": conn_list}


@app.get("/system/details/{system_id}")
async def get_tactical_details(system_id: int, force: bool = False):
    now = time.time()
    if not force and system_id in TAC_CACHE and TAC_CACHE[system_id]["expiry"] > now:
        return TAC_CACHE[system_id]["data"]
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}) as client:
        try:
            t1, t2, t3 = (
                client.get(f"{ZKILL_URL}/solarSystemID/{system_id}/pastSeconds/3600/"),
                client.get(f"{ESI_URL}/universe/system_kills/"),
                client.get(f"{ESI_URL}/universe/system_jumps/")
            )
            r1, r2, r3 = await asyncio.gather(t1, t2, t3)

            # Use shared Scout cache — no extra HTTP call here
            scout_data = await get_scout_data(client)
            sigs = []
            for s in scout_data:
                in_id, out_id = s.get('in_system_id'), s.get('out_system_id')
                if in_id == system_id or out_id == system_id:
                    if in_id == system_id:
                        sig_id = s.get('in_signature', '')
                        target = s.get('out_system_name', 'Unknown')
                    else:
                        sig_id = s.get('out_signature', '')
                        target = s.get('in_system_name', 'Unknown')

                    remaining = 24.0
                    if s.get('expires_at'):
                        try:
                            expires = datetime.fromisoformat(s['expires_at'].replace('Z', '+00:00'))
                            remaining = max(0.0, (expires - datetime.now(timezone.utc)).total_seconds() / 3600)
                        except Exception:
                            pass

                    sigs.append({"id": sig_id, "target": target, "remaining": remaining})

            k_data = next((s for s in r2.json() if s['system_id'] == system_id), {})
            j_data = next((s for s in r3.json() if s['system_id'] == system_id), {})
            data = {
                "npc_kills_1h": k_data.get("npc_kills", 0),
                "jumps_1h": j_data.get("ship_jumps", 0),
                "camps": [],
                "signatures": sigs
            }
            TAC_CACHE[system_id] = {"data": data, "expiry": now + TAC_CACHE_TTL}
            return data
        except:
            return {"npc_kills_1h": 0, "jumps_1h": 0, "camps": [], "signatures": sigs if 'sigs' in locals() else []}


@app.post("/logout")
async def logout():
    db = SessionLocal(); db.query(UserToken).delete(); db.commit(); db.close()
    TOKEN_CACHE["access_token"] = None
    return {"status": "success"}


@app.get("/user/status")
async def user_status():
    db = SessionLocal(); user = db.query(UserToken).first(); db.close()
    return {"is_logged_in": user is not None, "name": user.character_name if user else "Unknown"}


@app.get("/login")
async def login():
    return RedirectResponse(
        f"https://login.eveonline.com/v2/oauth/authorize/?response_type=code&redirect_uri={CALLBACK_URL}"
        f"&client_id={CLIENT_ID}&scope=esi-location.read_location.v1 esi-universe.read_structures.v1&state=123"
    )


@app.get("/callback")
async def callback(code: str):
    auth_header = base64.b64encode(f"{CLIENT_ID}:{SECRET_KEY}".encode()).decode()
    async with httpx.AsyncClient() as client:
        t_res = await client.post(
            "https://login.eveonline.com/v2/oauth/token",
            data={"grant_type": "authorization_code", "code": code},
            headers={"Authorization": f"Basic {auth_header}"}
        )
        char_res = await client.get(
            "https://login.eveonline.com/oauth/verify",
            headers={"Authorization": f"Bearer {t_res.json()['access_token']}"}
        )
        db = SessionLocal()
        db.merge(UserToken(
            character_id=char_res.json()["CharacterID"],
            character_name=char_res.json()["CharacterName"],
            refresh_token=t_res.json()["refresh_token"]
        ))
        db.commit()
    return RedirectResponse("http://localhost:5173?login=success")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)