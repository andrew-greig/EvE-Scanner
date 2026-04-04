import express, { Request, Response } from 'express';
import cors from 'cors';
import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getUserToken, upsertUserToken, deleteAllTokens } from './database';
import {
  SearchSuggestQuerySchema,
  SystemIdParamSchema,
  CallbackQuerySchema,
  TacticalDetailsQuerySchema,
} from './schemas';
import https from 'https';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CLIENT_ID = process.env.CLIENT_ID || '';
const SECRET_KEY = process.env.SECRET_KEY || '';
const CALLBACK_URL = process.env.CALLBACK_URL || '';

const ESI_URL = 'https://esi.evetech.net/latest';
const ZKILL_URL = 'https://zkillboard.com/api';
const EVESCOUT_URL = 'https://api.eve-scout.com/v2/public/signatures';
const USER_AGENT = 'EVE-Intel-Tactical-Scanner-v1';

const SDE_ZIP_URL = 'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip';

const ZKILL_CACHE_TTL = 300;
const SOV_CACHE_TTL = 3600;
const SCOUT_CACHE_TTL = 600;
const TAC_CACHE_TTL = 300;
const THREAT_CACHE_TTL = 600;

const GATE_CAMP_DIST_M = 5e5;

const DICTOR_SHIP_IDS = new Set([22456, 22464, 11174, 12013]);
const HIC_SHIP_IDS = new Set([12017, 12019, 12021, 12023]);
const SMARTBOMB_WEAPON_IDS = new Set([
  16441, 16443, 16445, 16447, 16449, 16451,
  28432, 28434, 28436, 28438, 28440, 28442,
  41155, 41157, 41159,
]);

// ---------------------------------------------------------------------------
// Cache structures
// ---------------------------------------------------------------------------

interface TokenCache {
  access_token: string | null;
  expiry: number;
}

interface ZKillCacheEntry {
  data: {
    id: number;
    k1h: number;
    k24h: number;
    kills_1h_raw: Array<{ id: number | undefined; hash: string }>;
  };
  expiry: number;
}

interface SystemInfo {
  name: string;
  id: number;
  sec: number;
}

interface GateData {
  to_sys_id: number;
  x: number;
  y: number;
  z: number;
}

interface ThreatResult {
  camped_gates: Array<{ to_sys_id: number; to_sys_name: string; kill_count: number }>;
  smartbombs: boolean;
  interdictors: boolean;
  hictors: boolean;
  camped: boolean;
}

interface TacticalDetails {
  npc_kills_1h: number;
  jumps_1h: number;
  camps: any[];
  signatures: Array<{ id: string; target: string; remaining: number }>;
  sparkline: number[] | null;
}

const TOKEN_CACHE: TokenCache = { access_token: null, expiry: 0 };
const Z_CACHE: Record<number, ZKillCacheEntry> = {};
const NAME_CACHE: Record<number, string> = {};
const SOV_MAP: Record<number, number | undefined> = {};
const TAC_CACHE: Record<number, { data: TacticalDetails; expiry: number }> = {};
const THREAT_CACHE: Record<number, { data: ThreatResult; expiry: number }> = {};
const SOV_NAME_CACHE: Record<number, string> = {};

let SOV_MAP_EXPIRY = 0;

const SYSTEM_INDEX: SystemInfo[] = [];
const JUMP_GRAPH: Record<number, number[]> = {};
const GATE_DATA: Record<number, GateData[]> = {};

let scoutCache: { data: any[] | null; expiry: number } = { data: null, expiry: 0 };

function buildAuthHeader(): string {
  return Buffer.from(`${CLIENT_ID}:${SECRET_KEY}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Shared HTTPS agent with keep-alive to prevent ECONNRESET
// ---------------------------------------------------------------------------

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
  maxFreeSockets: 10,
  timeout: 60000,
});

// ---------------------------------------------------------------------------
// Axios client factory
// ---------------------------------------------------------------------------

function createClient(timeout = 15000): AxiosInstance {
  const client = axios.create({
    timeout,
    headers: { 'User-Agent': USER_AGENT },
    httpsAgent,
  });

  axiosRetry(client, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
      return (
        axiosRetry.isNetworkOrIdempotentRequestError(error) ||
        error.code === 'ECONNRESET' ||
        error.code === 'EPIPE' ||
        error.code === 'ETIMEDOUT'
      );
    },
  });

  return client;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

async function getScoutData(client: AxiosInstance): Promise<any[]> {
  const now = Date.now() / 1000;
  if (scoutCache.data !== null && scoutCache.expiry > now) {
    return scoutCache.data;
  }
  try {
    const res = await client.get(EVESCOUT_URL);
    scoutCache.data = res.status === 200 ? res.data : [];
  } catch {
    scoutCache.data = scoutCache.data || [];
  }
  scoutCache.expiry = now + SCOUT_CACHE_TTL;
  return scoutCache.data || [];
}

async function getSovMap(client: AxiosInstance): Promise<Record<number, number | undefined>> {
  const now = Date.now() / 1000;
  if (Object.keys(SOV_MAP).length > 0 && SOV_MAP_EXPIRY > now) {
    return SOV_MAP;
  }
  try {
    const res = await client.get(`${ESI_URL}/sovereignty/map/`);
    if (res.status === 200) {
      for (const item of res.data) {
        SOV_MAP[item.system_id] = item.alliance_id || item.faction_id;
      }
      SOV_MAP_EXPIRY = now + SOV_CACHE_TTL;
    }
  } catch {
    // ignore
  }
  return SOV_MAP;
}

async function getOwnerName(client: AxiosInstance, entityId: number): Promise<string> {
  if (SOV_NAME_CACHE[entityId]) {
    return SOV_NAME_CACHE[entityId];
  }
  try {
    const res = await client.post(`${ESI_URL}/universe/names/`, [entityId]);
    if (res.status === 200 && res.data.length > 0) {
      const name = res.data[0].name;
      SOV_NAME_CACHE[entityId] = name;
      return name;
    }
  } catch {
    // ignore
  }
  return 'Unclaimed';
}

function getJumpDistance(startId: number, endId: number): number {
  if (startId === endId) return 0;
  if (!JUMP_GRAPH[startId] || !JUMP_GRAPH[endId]) return -1;

  const queue: Array<[number, number]> = [[startId, 0]];
  const visited = new Set<number>([startId]);

  while (queue.length > 0) {
    const [curr, dist] = queue.shift()!;
    if (curr === endId) return dist;
    for (const nxt of JUMP_GRAPH[curr] || []) {
      if (!visited.has(nxt)) {
        visited.add(nxt);
        queue.push([nxt, dist + 1]);
      }
    }
  }
  return -1;
}

async function getValidToken(client: AxiosInstance, user: any): Promise<string> {
  const now = Date.now() / 1000;
  if (TOKEN_CACHE.access_token && TOKEN_CACHE.expiry > now + 120) {
    return TOKEN_CACHE.access_token!;
  }

  const authHeader = buildAuthHeader();
  const res = await client.post(
    'https://login.eveonline.com/v2/oauth/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user.refresh_token,
    }).toString(),
    {
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  const data = res.data;
  TOKEN_CACHE.access_token = data.access_token;
  TOKEN_CACHE.expiry = now + data.expires_in;
  return TOKEN_CACHE.access_token!;
}

async function getBaseSystem(
  client: AxiosInstance,
  systemId: number,
  scoutIds: Set<number>
): Promise<{ id: number; name: string; sec: number; owner: string; has_scout: boolean }> {
  const sysInfo = SYSTEM_INDEX.find((s) => s.id === systemId) || {
    name: NAME_CACHE[systemId] || `ID:${systemId}`,
    sec: 0.0,
  };

  const sov = await getSovMap(client);
  let ownerName = 'Unclaimed';
  if (sov[systemId]) {
    ownerName = await getOwnerName(client, sov[systemId]!);
  }

  return {
    id: systemId,
    name: sysInfo.name,
    sec: sysInfo.sec,
    owner: ownerName,
    has_scout: scoutIds.has(systemId),
  };
}

async function getStatsBundle(
  client: AxiosInstance,
  systemId: number
): Promise<{ id: number; k1h: number; k24h: number; kills_1h_raw: Array<{ id: number | undefined; hash: string }> } | null> {
  const now = Date.now() / 1000;
  if (Z_CACHE[systemId] && Z_CACHE[systemId].expiry > now) {
    return Z_CACHE[systemId].data;
  }

  try {
    const [r1, r2] = await Promise.all([
      client.get(`${ZKILL_URL}/solarSystemID/${systemId}/pastSeconds/3600/`),
      client.get(`${ZKILL_URL}/solarSystemID/${systemId}/pastSeconds/86400/`),
    ]);

    const kills1h = r1.status === 200 && Array.isArray(r1.data) ? r1.data : [];
    const kills24h = r2.status === 200 && Array.isArray(r2.data) ? r2.data : [];

    const data = {
      id: systemId,
      k1h: kills1h.length,
      k24h: kills24h.length,
      kills_1h_raw: kills1h
        .filter((k: any) => k.killmail_id)
        .map((k: any) => ({
          id: k.killmail_id,
          hash: k.zkb?.hash || '',
        })),
    };

    Z_CACHE[systemId] = { data, expiry: now + ZKILL_CACHE_TTL };
    return data;
  } catch {
    return null;
  }
}

async function getSystemWithConnections(
  client: AxiosInstance,
  systemId: number
): Promise<{ current: any; connections: any[] }> {
  const scoutData = await getScoutData(client);
  const scoutIds = new Set<number>();
  for (const s of scoutData) {
    if (s.in_system_id) scoutIds.add(s.in_system_id);
    if (s.out_system_id) scoutIds.add(s.out_system_id);
  }

  const current = await getBaseSystem(client, systemId, scoutIds);
  const connectionsPromises = (JUMP_GRAPH[systemId] || []).map((did) =>
    getBaseSystem(client, did, scoutIds)
  );
  const connections = (await Promise.all(connectionsPromises)).filter(Boolean);

  return { current, connections };
}

// ---------------------------------------------------------------------------
// SDE loading on startup
// ---------------------------------------------------------------------------

async function loadSDE(): Promise<void> {
  const client = createClient(600000);
  const backendDir = path.join(__dirname, '..');

  const systemsPath = path.join(backendDir, 'mapSolarSystems.jsonl');
  const gatesPath = path.join(backendDir, 'mapStargates.jsonl');

  if (!fs.existsSync(systemsPath) || !fs.existsSync(gatesPath)) {
    console.log('Downloading SDE data...');
    const r = await client.get(SDE_ZIP_URL, { responseType: 'arraybuffer' });
    const zip = new AdmZip(Buffer.from(r.data));
    const entries = zip.getEntries();

    for (const entry of entries) {
      const entryName = entry.entryName;
      if (entryName.includes('mapSolarSystems.jsonl')) {
        zip.extractEntryTo(entry, backendDir, false, true, false, 'mapSolarSystems.jsonl');
      }
      if (entryName.includes('mapStargates.jsonl')) {
        zip.extractEntryTo(entry, backendDir, false, true, false, 'mapStargates.jsonl');
      }
    }
    console.log('SDE data downloaded and extracted.');
  }

  console.log('Loading SDE data...');

  const systemsContent = fs.readFileSync(systemsPath, 'utf-8');
  for (const line of systemsContent.split('\n')) {
    if (!line.trim()) continue;
    const s = JSON.parse(line);
    const rawId = s._key || s.solarSystemID || s.id;
    if (rawId == null) continue;

    const sysId = parseInt(rawId, 10);
    const rawName = s.name;
    let sysName: string;
    if (typeof rawName === 'object' && rawName !== null) {
      sysName = rawName.en || `System ${sysId}`;
    } else {
      sysName = rawName || s.solarSystemName || `System ${sysId}`;
    }

    SYSTEM_INDEX.push({
      name: sysName,
      id: sysId,
      sec: Math.round(parseFloat(s.securityStatus || s.security || 0) * 10) / 10,
    });
    NAME_CACHE[sysId] = sysName;
  }

  const gatesContent = fs.readFileSync(gatesPath, 'utf-8');
  for (const line of gatesContent.split('\n')) {
    if (!line.trim()) continue;
    const g = JSON.parse(line);
    const fid = g.solarSystemID;
    if (!fid) continue;
    const dest = g.destination || {};
    const tid = dest.solarSystemID;
    if (!tid) continue;

    const fromId = parseInt(fid, 10);
    const toId = parseInt(tid, 10);

    if (!JUMP_GRAPH[fromId]) JUMP_GRAPH[fromId] = [];
    JUMP_GRAPH[fromId].push(toId);

    const pos = g.position || {};
    const gx = parseFloat(pos.x || 0);
    const gy = parseFloat(pos.y || 0);
    const gz = parseFloat(pos.z || 0);

    if (!GATE_DATA[fromId]) GATE_DATA[fromId] = [];
    GATE_DATA[fromId].push({ to_sys_id: toId, x: gx, y: gy, z: gz });
  }

  console.log(`Loaded ${SYSTEM_INDEX.length} systems and ${Object.keys(JUMP_GRAPH).length} jump connections.`);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/search/suggest', async (req: Request, res: Response) => {
  try {
    const { q, current_id } = SearchSuggestQuerySchema.parse(req.query);

    const queryLower = q.toLowerCase();
    
    // Filter and score matches by relevance
    const scoredMatches = SYSTEM_INDEX
      .filter((s) => s.name.toLowerCase().includes(queryLower))
      .map((s) => {
        const nameLower = s.name.toLowerCase();
        let score: number;
        
        if (nameLower === queryLower) {
          // Exact match - highest priority
          score = 0;
        } else if (nameLower.startsWith(queryLower)) {
          // Prefix match - second priority
          score = 1;
        } else {
          // Substring match - prioritize earlier positions in name
          const position = nameLower.indexOf(queryLower);
          score = 2 + position * 0.1; // Add small increment based on position
        }
        
        return { system: s, score };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, 5)
      .map(({ system }) => ({ ...system }));

    if (current_id) {
      for (const m of scoredMatches) {
        (m as any).jumps = getJumpDistance(current_id, m.id);
      }
    }

    res.json(scoredMatches);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/user/location', async (req: Request, res: Response) => {
  const user = getUserToken();
  if (!user) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const client = createClient();
  try {
    const token = await getValidToken(client, user);
    const locRes = await client.get(
      `${ESI_URL}/characters/${user.character_id}/location/`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const currId = locRes.data.solar_system_id;

    const { current, connections } = await getSystemWithConnections(client, currId);

    // Determine docked status from location response
    const stationId = locRes.data.station_id || null;
    const structureId = locRes.data.structure_id || null;
    let isDocked = false;
    let locationType: 'space' | 'station' | 'structure' = 'space';

    if (stationId) {
      isDocked = true;
      locationType = 'station';
    } else if (structureId) {
      isDocked = true;
      locationType = 'structure';
    }

    res.json({ 
      current, 
      connections,
      docked_status: {
        is_docked: isDocked,
        location_type: locationType,
        station_id: stationId,
        structure_id: structureId,
      }
    });
  } catch (err: any) {
    console.error(`/user/location error: ${err.message}`);
    if (err.response) {
      console.error(`  Status: ${err.response.status}, Data: ${JSON.stringify(err.response.data)}`);
    }
    res.status(500).json({ error: 'Failed to fetch location', detail: err.message });
  }
});

app.get('/system/scout/:system_id', async (req: Request, res: Response) => {
  try {
    const { system_id } = SystemIdParamSchema.parse(req.params);
    const client = createClient();

    const { current, connections } = await getSystemWithConnections(client, system_id);

    res.json({ current, connections });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/system/stats/:system_id', async (req: Request, res: Response) => {
  try {
    const { system_id } = SystemIdParamSchema.parse(req.params);
    const client = createClient();

    const data = await getStatsBundle(client, system_id);
    if (data) {
      res.json({ id: data.id, k1h: data.k1h, k24h: data.k24h });
    } else {
      res.json({ id: system_id, k1h: 0, k24h: 0 });
    }
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/system/path/:system_id', async (req: Request, res: Response) => {
  try {
    const { system_id } = SystemIdParamSchema.parse(req.params);
    const client = createClient();

    const { current, connections } = await getSystemWithConnections(client, system_id);

    res.json({ current, connections });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/system/threats/:system_id', async (req: Request, res: Response) => {
  const { system_id } = SystemIdParamSchema.parse(req.params);
  const now = Date.now() / 1000;

  if (THREAT_CACHE[system_id] && THREAT_CACHE[system_id].expiry > now) {
    return res.json(THREAT_CACHE[system_id].data);
  }

  const result: ThreatResult = {
    camped_gates: [],
    smartbombs: false,
    interdictors: false,
    hictors: false,
    camped: false,
  };

  try {
    const client = createClient(15000);

    let killsRaw: Array<{ id: number | undefined; hash: string }> = [];
    const cached = Z_CACHE[system_id];
    if (cached && cached.expiry > now) {
      killsRaw = cached.data.kills_1h_raw || [];
    } else {
      const r = await client.get(`${ZKILL_URL}/solarSystemID/${system_id}/pastSeconds/3600/`);
      if (r.status === 200 && Array.isArray(r.data)) {
        killsRaw = r.data
          .filter((k: any) => k.killmail_id)
          .map((k: any) => ({
            id: k.killmail_id,
            hash: k.zkb?.hash || '',
          }));

        if (!Z_CACHE[system_id] || Z_CACHE[system_id].expiry <= now) {
          Z_CACHE[system_id] = {
            data: {
              id: system_id,
              k1h: r.data.length,
              k24h: Z_CACHE[system_id]?.data?.k24h || 0,
              kills_1h_raw: killsRaw,
            },
            expiry: now + ZKILL_CACHE_TTL,
          };
        }
      }
    }

    if (killsRaw.length === 0) {
      THREAT_CACHE[system_id] = { data: result, expiry: now + THREAT_CACHE_TTL };
      return res.json(result);
    }

    const toFetch = killsRaw.filter((km) => km.id && km.hash).slice(0, 10);
    const esiResults = await Promise.all(
      toFetch.map((km) =>
        client.get(`${ESI_URL}/killmails/${km.id}/${km.hash}/`).catch((err) => err)
      )
    );

    const gates = GATE_DATA[system_id] || [];
    const killCountByGate: Record<number, number> = {};

    for (const res_ of esiResults) {
      if (res_ instanceof Error || res_.status !== 200) continue;
      try {
        const km = res_.data;

        const pos = km.position || {};
        const kx = parseFloat(pos.x || 0);
        const ky = parseFloat(pos.y || 0);
        const kz = parseFloat(pos.z || 0);

        if (kx !== 0 || ky !== 0 || kz !== 0) {
          for (const gate of gates) {
            const dist = Math.sqrt(
              (kx - gate.x) ** 2 + (ky - gate.y) ** 2 + (kz - gate.z) ** 2
            );
            if (dist <= GATE_CAMP_DIST_M) {
              const tid = gate.to_sys_id;
              killCountByGate[tid] = (killCountByGate[tid] || 0) + 1;
              break;
            }
          }
        }

        for (const attacker of km.attackers || []) {
          const shipId = attacker.ship_type_id || 0;
          const weaponId = attacker.weapon_type_id || 0;
          if (DICTOR_SHIP_IDS.has(shipId)) {
            result.interdictors = true;
          }
          if (HIC_SHIP_IDS.has(shipId)) {
            result.hictors = true;
          }
          if (SMARTBOMB_WEAPON_IDS.has(weaponId)) {
            result.smartbombs = true;
          }
        }
      } catch {
        continue;
      }
    }

    const CAMP_KILL_THRESHOLD = 2;
    for (const [toSysIdStr, count] of Object.entries(killCountByGate)) {
      if (count >= CAMP_KILL_THRESHOLD) {
        const toSysId = parseInt(toSysIdStr, 10);
        const toName = NAME_CACHE[toSysId] || `ID:${toSysId}`;
        result.camped_gates.push({
          to_sys_id: toSysId,
          to_sys_name: toName,
          kill_count: count,
        });
      }
    }

    result.camped = result.camped_gates.length > 0;
  } catch (err: any) {
    console.error(`Threat detection error for system ${req.params.system_id}: ${err.message}`);
  }

  THREAT_CACHE[system_id] = { data: result, expiry: now + THREAT_CACHE_TTL };
  res.json(result);
});

app.get('/system/details/:system_id', async (req: Request, res: Response) => {
  try {
    const { system_id } = SystemIdParamSchema.parse(req.params);
    const { force } = TacticalDetailsQuerySchema.parse(req.query);

    const now = Date.now() / 1000;
    if (!force && TAC_CACHE[system_id] && TAC_CACHE[system_id].expiry > now) {
      return res.json(TAC_CACHE[system_id].data);
    }

    const client = createClient();

    const [rSysKills, rSysJumps, rZ4h, rZ12h] = await Promise.all([
      client.get(`${ESI_URL}/universe/system_kills/`),
      client.get(`${ESI_URL}/universe/system_jumps/`),
      client.get(`${ZKILL_URL}/solarSystemID/${system_id}/pastSeconds/14400/`),
      client.get(`${ZKILL_URL}/solarSystemID/${system_id}/pastSeconds/43200/`),
    ]);

    const scoutData = await getScoutData(client);
    const sigs: Array<{ id: string; target: string; remaining: number }> = [];

    for (const s of scoutData) {
      const inId = s.in_system_id;
      const outId = s.out_system_id;
      if (inId === system_id || outId === system_id) {
        let sigId: string;
        let target: string;

        if (inId === system_id) {
          sigId = s.in_signature || '';
          target = s.out_system_name || 'Unknown';
        } else {
          sigId = s.out_signature || '';
          target = s.in_system_name || 'Unknown';
        }

        let remaining = 24.0;
        if (s.expires_at) {
          try {
            const expires = new Date(s.expires_at.replace('Z', '+00:00'));
            const nowDate = new Date();
            remaining = Math.max(0.0, (expires.getTime() - nowDate.getTime()) / 3600000);
          } catch {
            // ignore
          }
        }

        sigs.push({ id: sigId, target, remaining });
      }
    }

    const kData = (rSysKills.data as any[]).find((s: any) => s.system_id === system_id) || {};
    const jData = (rSysJumps.data as any[]).find((s: any) => s.system_id === system_id) || {};

    const zcache = Z_CACHE[system_id]?.data || { k1h: 0, k24h: 0 };
    const k1h = zcache.k1h || 0;
    const k24h = zcache.k24h || 0;
    const k4h =
      rZ4h.status === 200 && Array.isArray(rZ4h.data) ? rZ4h.data.length : k1h;
    const k12h =
      rZ12h.status === 200 && Array.isArray(rZ12h.data) ? rZ12h.data.length : k4h;

    const sparkline = [
      Math.max(0, k24h - k12h),
      Math.max(0, k12h - k4h),
      Math.max(0, k4h - k1h),
      k1h,
    ];

    const data: TacticalDetails = {
      npc_kills_1h: kData.npc_kills || 0,
      jumps_1h: jData.ship_jumps || 0,
      camps: [],
      signatures: sigs,
      sparkline,
    };

    TAC_CACHE[system_id] = { data, expiry: now + TAC_CACHE_TTL };
    res.json(data);
  } catch (err: any) {
    console.error(`Details error for ${req.params.system_id}: ${err.message}`);
    res.json({
      npc_kills_1h: 0,
      jumps_1h: 0,
      camps: [],
      signatures: [],
      sparkline: null,
    });
  }
});

app.post('/logout', (_req: Request, res: Response) => {
  deleteAllTokens();
  TOKEN_CACHE.access_token = null;
  res.json({ status: 'success' });
});

app.get('/user/status', (_req: Request, res: Response) => {
  const user = getUserToken();
  res.json({
    is_logged_in: user !== undefined,
    name: user?.character_name || 'Unknown',
  });
});

app.get('/login', (_req: Request, res: Response) => {
  const url = `https://login.eveonline.com/v2/oauth/authorize/?response_type=code&redirect_uri=${CALLBACK_URL}&client_id=${CLIENT_ID}&scope=esi-location.read_location.v1 esi-universe.read_structures.v1&state=123`;
  res.redirect(url);
});

app.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code } = CallbackQuerySchema.parse(req.query);
    const client = createClient();

    const authHeader = buildAuthHeader();

    const tRes = await client.post(
      'https://login.eveonline.com/v2/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const charRes = await client.get('https://login.eveonline.com/oauth/verify', {
      headers: { Authorization: `Bearer ${tRes.data.access_token}` },
    });

    upsertUserToken({
      character_id: charRes.data.CharacterID,
      character_name: charRes.data.CharacterName,
      refresh_token: tRes.data.refresh_token,
    });

    res.redirect('http://localhost:5173?login=success');
  } catch (err: any) {
    console.error(`Callback error: ${err.message}`);
    if (err.response) {
      console.error(`  Status: ${err.response.status}, Data: ${JSON.stringify(err.response.data)}`);
    }
    res.status(500).json({ error: 'Authentication failed', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    await loadSDE();
    const client = createClient(600000);
    await getSovMap(client);
    console.log('Startup complete.');
  } catch (err: any) {
    console.error(`Startup error: ${err.message}`);
  }
});

export default app;
