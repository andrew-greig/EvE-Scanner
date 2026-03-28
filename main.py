# main.py
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

ZKILL_CACHE_TTL = 300
SOV_CACHE_TTL = 3600
SCOUT_CACHE_TTL = 600
TAC_CACHE_TTL = 300
THREAT_CACHE_TTL = 600

TOKEN_CACHE = {"access_token": None, "expiry": 0}
Z_CACHE: Dict = {}
NAME_CACHE: Dict = {}
SOV_MAP: Dict = {}
TAC_CACHE: Dict = {}
THREAT_CACHE: Dict = {}

SCOUT_CACHE: Dict = {"data": None, "expiry": 0}
SOV_NAME_CACHE: Dict = {}
SOV_MAP_EXPIRY: float = 0.0

SYSTEM_INDEX = []
JUMP_GRAPH = {}
# Keyed by solar system id → list of gates in that system.
# Each gate: {"to_sys_id": int, "x": float, "y": float, "z": float}
# Positions are in metres (EVE SDE convention).
GATE_DATA: Dict[int, List[Dict]] = {}

# Kills within this distance of a gate structure are treated as gate-camp kills.
# 5 × 10^5 m = 500 km — generous enough to cover any realistic gate-camp radius
# while still excluding ratting / station kills on the other side of the system.
GATE_CAMP_DIST_M: float = 5e5

# Ship type IDs for threat detection
DICTOR_SHIP_IDS = {22456, 22464, 11174, 12013}   # Sabre, Flycatcher, Heretic, Eris
HIC_SHIP_IDS    = {12017, 12019, 12021, 12023}   # Phobos, Devoter, Onyx, Broadsword
# Smartbomb weapon type IDs (T1 and T2 across damage types)
SMARTBOMB_WEAPON_IDS = {
    16441, 16443, 16445, 16447, 16449, 16451,   # T1 smartbombs
    28432, 28434, 28436, 28438, 28440, 28442,   # T2 smartbombs
    41155, 41157, 41159,                         # Faction smartbombs
}

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

Base = declarative_base()
engine = create_engine('sqlite:///eve_intel.db', connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

class UserToken(Base):
    __tablename__ = "tokens"
    character_id, character_name, refresh_token = Column(Integer, primary_key=True), Column(String), Column(String)

Base.metadata.create_all(bind=engine)

async def get_scout_data(client: httpx.AsyncClient) -> list:
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
    global SOV_MAP, SOV_MAP_EXPIRY
    now = time.time()
    if SOV_MAP and SOV_MAP_EXPIRY > now:
        return SOV_MAP
    try:
        res = await client.get(f"{ESI_URL}/sovereignty/map/")
        if res.status_code == 200:
            SOV_MAP = {item['system_id']: item.get('alliance_id') or item.get('faction_id') for item in res.json()}
            SOV_MAP_EXPIRY = now + SOV_CACHE_TTL
    except Exception:
        pass
    return SOV_MAP

async def get_owner_name(client: httpx.AsyncClient, entity_id: int) -> str:
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

@app.on_event("startup")
async def startup_event():
    global SYSTEM_INDEX, JUMP_GRAPH
    async with httpx.AsyncClient(timeout=600.0, follow_redirects=True) as client:
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

                    SYSTEM_INDEX.append({"name": sys_name, "id": sys_id, "sec": round(float(s.get("securityStatus", s.get("security", 0))), 1)})
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
                    # Store gate position for gate-camp detection.
                    # SDE encodes position as a nested dict {"x":…,"y":…,"z":…}.
                    pos = g.get("position", {})
                    gx = float(pos.get("x", 0))
                    gy = float(pos.get("y", 0))
                    gz = float(pos.get("z", 0))
                    if fid not in GATE_DATA: GATE_DATA[fid] = []
                    GATE_DATA[fid].append({"to_sys_id": tid, "x": gx, "y": gy, "z": gz})

        except Exception as e:
            logging.error(f"SDE Setup Failed: {e}")

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

async def get_base_system(client, system_id: int, scout_ids: set) -> dict:
    """Returns static topology info immediately."""
    sys_info = next((s for s in SYSTEM_INDEX if s["id"] == system_id), {"name": NAME_CACHE.get(system_id, f"ID:{system_id}"), "sec": 0.0})
    sov = await get_sov_map(client)
    owner_name = "Unclaimed"
    if sov.get(system_id):
        owner_name = await get_owner_name(client, sov[system_id])

    return {"id": system_id, "name": sys_info["name"], "sec": sys_info["sec"], "owner": owner_name, "has_scout": system_id in scout_ids}

async def get_stats_bundle(client, system_id):
    """Fetch zKill stats for a system. Also caches the raw 1h kill list for threat analysis."""
    now = time.time()
    if system_id in Z_CACHE and Z_CACHE[system_id]["expiry"] > now:
        return Z_CACHE[system_id]["data"]
    try:
        t1, t2 = (
            client.get(f"{ZKILL_URL}/solarSystemID/{system_id}/pastSeconds/3600/"),
            client.get(f"{ZKILL_URL}/solarSystemID/{system_id}/pastSeconds/86400/")
        )
        r1, r2 = await asyncio.gather(t1, t2)
        kills_1h = r1.json() if r1.status_code == 200 and isinstance(r1.json(), list) else []
        kills_24h = r2.json() if r2.status_code == 200 and isinstance(r2.json(), list) else []
        data = {
            "id": system_id,
            "k1h": len(kills_1h),
            "k24h": len(kills_24h),
            # Cache the raw kill list (id + hash only) for threat detection reuse
            "kills_1h_raw": [
                {"id": k.get("killmail_id"), "hash": k.get("zkb", {}).get("hash", "")}
                for k in kills_1h if k.get("killmail_id")
            ],
        }
        Z_CACHE[system_id] = {"data": data, "expiry": now + ZKILL_CACHE_TTL}
        return data
    except:
        return None

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

        current = await get_base_system(client, curr_id, scout_ids)
        connections = await asyncio.gather(*[get_base_system(client, did, scout_ids) for did in JUMP_GRAPH.get(curr_id, [])])
        return {"current": current, "connections": [c for c in connections if c]}

@app.get("/system/scout/{system_id}")
async def get_scout_intel(system_id: int):
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}) as client:
        scout_data = await get_scout_data(client)
        scout_ids = {s.get('in_system_id') for s in scout_data} | {s.get('out_system_id') for s in scout_data}

        current = await get_base_system(client, system_id, scout_ids)
        connections = await asyncio.gather(*[get_base_system(client, did, scout_ids) for did in JUMP_GRAPH.get(system_id, [])])
        return {"current": current, "connections": [c for c in connections if c]}

@app.get("/system/stats/{system_id}")
async def get_system_stats(system_id: int):
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}) as client:
        data = await get_stats_bundle(client, system_id)
        if data:
            return {"id": data["id"], "k1h": data["k1h"], "k24h": data["k24h"]}
        return {"id": system_id, "k1h": 0, "k24h": 0}

# ---------------------------------------------------------------------------
# Legacy /system/path endpoint
# ---------------------------------------------------------------------------
# Historically the frontend expected a `/system/path/{system_id}` route that
# returned the current system and its directly connected neighbours. The
# implementation was accidentally removed during a refactor, resulting in a
# 404 error when the client attempted to fetch it. This lightweight endpoint
# re‑introduces the original behaviour by delegating to the existing
# `get_base_system` helper.

@app.get("/system/path/{system_id}")
async def get_system_path(system_id: int):
    """Return the current system and its immediate connections.

    The response structure mirrors the legacy API used by the frontend:

    .. code-block:: json

        {
            "current": { ... },
            "connections": [ {...}, ... ]
        }

    Parameters
    ----------
    system_id: int
        The solar system ID to query.
    """
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}) as client:
        # Fetch base info for the requested system
        scout_data = await get_scout_data(client)
        scout_ids = {s.get("in_system_id") for s in scout_data} | {s.get("out_system_id") for s in scout_data}
        current = await get_base_system(client, system_id, scout_ids)
        # Retrieve neighbours via the jump graph
        connections = await asyncio.gather(
            *[get_base_system(client, did, scout_ids) for did in JUMP_GRAPH.get(system_id, [])]
        )
        return {"current": current, "connections": [c for c in connections if c]}

@app.get("/system/threats/{system_id}")
async def get_system_threats(system_id: int):
    """
    Detect gate camps (by kill position proximity to gate structures),
    interdictors, and smartbombs from the last hour of kills.

    Gate camp logic:
      - Fetch up to 10 recent ESI killmails for the system.
      - Each killmail includes the kill position (x, y, z) in metres.
      - Compare that position to every stargate in GATE_DATA[system_id].
      - Kills within GATE_CAMP_DIST_M (~500 km) of a gate count toward
        a camp on that gate.  Two or more kills near the same gate = CAMPED.
      - Returns camped_gates: list of {to_sys_id, to_sys_name, kill_count}.

    Attacker-ship / weapon analysis runs over the same killmails with no
    extra API calls, giving us DICTOR and SB flags for free.

    All results are cached for THREAT_CACHE_TTL (600 s) and the raw 1-hour
    kill list is re-used from Z_CACHE whenever it is still fresh.
    """
    now = time.time()
    if system_id in THREAT_CACHE and THREAT_CACHE[system_id]["expiry"] > now:
        return THREAT_CACHE[system_id]["data"]

    result = {"camped_gates": [], "smartbombs": False, "interdictors": False, "camped": False}

    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=15.0) as client:
        try:
            # --- Step 1: get 1-hour kill list (reuse Z_CACHE if fresh) ---
            cached = Z_CACHE.get(system_id)
            if cached and cached["expiry"] > now:
                kills_raw = cached["data"].get("kills_1h_raw", [])
            else:
                r = await client.get(f"{ZKILL_URL}/solarSystemID/{system_id}/pastSeconds/3600/")
                if r.status_code == 200 and isinstance(r.json(), list):
                    raw = r.json()
                    kills_raw = [
                        {"id": k.get("killmail_id"), "hash": k.get("zkb", {}).get("hash", "")}
                        for k in raw if k.get("killmail_id")
                    ]
                    if system_id not in Z_CACHE or Z_CACHE[system_id]["expiry"] <= now:
                        Z_CACHE[system_id] = {
                            "data": {
                                "id": system_id,
                                "k1h": len(raw),
                                "k24h": Z_CACHE.get(system_id, {}).get("data", {}).get("k24h", 0),
                                "kills_1h_raw": kills_raw,
                            },
                            "expiry": now + ZKILL_CACHE_TTL,
                        }
                else:
                    kills_raw = []

            if not kills_raw:
                THREAT_CACHE[system_id] = {"data": result, "expiry": now + THREAT_CACHE_TTL}
                return result

            # --- Step 2: fetch up to 10 full ESI killmails concurrently ---
            to_fetch = [km for km in kills_raw if km.get("id") and km.get("hash")][:10]
            esi_results = await asyncio.gather(
                *[client.get(f"{ESI_URL}/killmails/{km['id']}/{km['hash']}/") for km in to_fetch],
                return_exceptions=True,
            )

            # --- Step 3: analyse each killmail ---
            gates = GATE_DATA.get(system_id, [])
            # kill_count_by_gate[to_sys_id] = number of kills within threshold
            kill_count_by_gate: Dict[int, int] = {}

            for res in esi_results:
                if isinstance(res, Exception) or res.status_code != 200:
                    continue
                try:
                    km = res.json()
                except Exception:
                    continue

                # -- Position-based gate proximity check --
                pos = km.get("position", {})
                kx = float(pos.get("x", 0))
                ky = float(pos.get("y", 0))
                kz = float(pos.get("z", 0))
                # Only run the check if we actually got a non-zero position.
                if kx != 0 or ky != 0 or kz != 0:
                    for gate in gates:
                        dist = math.sqrt(
                            (kx - gate["x"]) ** 2 +
                            (ky - gate["y"]) ** 2 +
                            (kz - gate["z"]) ** 2
                        )
                        if dist <= GATE_CAMP_DIST_M:
                            tid = gate["to_sys_id"]
                            kill_count_by_gate[tid] = kill_count_by_gate.get(tid, 0) + 1
                            break  # one kill can only be near one gate

                # -- Attacker ship / weapon type check --
                for attacker in km.get("attackers", []):
                    ship_id   = attacker.get("ship_type_id", 0)
                    weapon_id = attacker.get("weapon_type_id", 0)
                    if ship_id in DICTOR_SHIP_IDS:
                        result["interdictors"] = True
                    if weapon_id in SMARTBOMB_WEAPON_IDS:
                        result["smartbombs"] = True

            # --- Step 4: build camped_gates list ---
            # Require ≥2 kills near the same gate to flag it as camped — a single
            # kill could be coincidental (e.g. a solo hunter).
            CAMP_KILL_THRESHOLD = 2
            for to_sys_id, count in kill_count_by_gate.items():
                if count >= CAMP_KILL_THRESHOLD:
                    to_name = NAME_CACHE.get(to_sys_id, f"ID:{to_sys_id}")
                    result["camped_gates"].append({
                        "to_sys_id":   to_sys_id,
                        "to_sys_name": to_name,
                        "kill_count":  count,
                    })

            result["camped"] = len(result["camped_gates"]) > 0

        except Exception as e:
            logging.error(f"Threat detection error for system {system_id}: {e}")

    THREAT_CACHE[system_id] = {"data": result, "expiry": now + THREAT_CACHE_TTL}
    return result

@app.get("/system/details/{system_id}")
async def get_tactical_details(system_id: int, force: bool = False):
    now = time.time()
    if not force and system_id in TAC_CACHE and TAC_CACHE[system_id]["expiry"] > now:
        return TAC_CACHE[system_id]["data"]
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}) as client:
        try:
            # Fetch ESI activity data + zkill windows for sparkline concurrently.
            # We already have k1h/k24h in Z_CACHE; fetch 4h and 12h windows for the
            # sparkline (2 extra zkill calls, cached in TAC_CACHE for TAC_CACHE_TTL).
            t_sys_kills, t_sys_jumps, t_z4h, t_z12h = (
                client.get(f"{ESI_URL}/universe/system_kills/"),
                client.get(f"{ESI_URL}/universe/system_jumps/"),
                client.get(f"{ZKILL_URL}/solarSystemID/{system_id}/pastSeconds/14400/"),
                client.get(f"{ZKILL_URL}/solarSystemID/{system_id}/pastSeconds/43200/"),
            )
            r_sys_kills, r_sys_jumps, r_z4h, r_z12h = await asyncio.gather(t_sys_kills, t_sys_jumps, t_z4h, t_z12h)

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
                        except Exception: pass
                    sigs.append({"id": sig_id, "target": target, "remaining": remaining})

            k_data = next((s for s in r_sys_kills.json() if s['system_id'] == system_id), {})
            j_data = next((s for s in r_sys_jumps.json() if s['system_id'] == system_id), {})

            # Build sparkline: 4 buckets ordered oldest→newest
            # [12-24h kills, 4-12h kills, 1-4h kills, 0-1h kills]
            zcache = Z_CACHE.get(system_id, {}).get("data", {})
            k1h  = zcache.get("k1h", 0)
            k24h = zcache.get("k24h", 0)
            k4h  = len(r_z4h.json())  if r_z4h.status_code  == 200 and isinstance(r_z4h.json(),  list) else k1h
            k12h = len(r_z12h.json()) if r_z12h.status_code == 200 and isinstance(r_z12h.json(), list) else k4h
            sparkline = [
                max(0, k24h - k12h),   # 12–24h ago
                max(0, k12h - k4h),    # 4–12h ago
                max(0, k4h  - k1h),    # 1–4h ago
                k1h,                   # last hour
            ]

            data = {
                "npc_kills_1h": k_data.get("npc_kills", 0),
                "jumps_1h": j_data.get("ship_jumps", 0),
                "camps": [],
                "signatures": sigs,
                "sparkline": sparkline,
            }
            TAC_CACHE[system_id] = {"data": data, "expiry": now + TAC_CACHE_TTL}
            return data
        except Exception as e:
            logging.error(f"Details error for {system_id}: {e}")
            return {"npc_kills_1h": 0, "jumps_1h": 0, "camps": [], "signatures": [], "sparkline": None}

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