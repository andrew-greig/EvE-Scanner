// App.tsx
import React, { useEffect, useState, useRef } from 'react';
import LocalParser from './components/LocalParser';
import { Crosshair, Zap, ArrowRightCircle, LogOut, Info, RefreshCcw, Wifi, Search, Loader2, BarChart2 } from 'lucide-react';

const getSecColor = (sec: number) => {
  if (sec >= 1.0) return '#2FEFEF';
  if (sec >= 0.8) return '#00EF47';
  if (sec >= 0.5) return '#EFBE00';
  if (sec >= 0.2) return '#EF2F00';
  return '#EF0000';
};

function speakIntel(currentStats: any, connectionsStats: any[]) {
  if (!window.speechSynthesis) return;

  const lines: string[] = [];

  if (currentStats?.k1h > 0) {
    lines.push(`There have been ${currentStats.k1h} local kill${currentStats.k1h === 1 ? '' : 's'} in the past hour.`);
  }

  (connectionsStats || []).forEach((sys: any) => {
    if (sys?.k1h > 0) {
      lines.push(`${sys.k1h} recent kill${sys.k1h === 1 ? '' : 's'} detected in ${sys.name}.`);
    }
  });

  if (lines.length === 0) return;

  window.speechSynthesis.cancel();

  lines.forEach((text) => {
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1.05;
    utt.pitch = 0.9;
    utt.volume = 1.0;
    window.speechSynthesis.speak(utt);
  });
}

// Mini sparkline bar chart for the tactical overview.
// `data` is [12-24h kills, 4-12h kills, 1-4h kills, 0-1h kills] (oldest → newest).
function ActivitySparkline({ data }: { data: number[] | null | undefined }) {
  if (!data) return null;
  const labels = ['12-24H', '4-12H', '1-4H', '0-1H'];
  const maxVal = Math.max(...data, 1);
  const BAR_H = 36; // max bar height px

  return (
    <div>
      <p className="text-[10px] font-black text-gray-600 uppercase tracking-widest mb-2 flex items-center gap-1.5">
        <BarChart2 size={10} /> Activity (24H)
      </p>
      <div className="flex items-end gap-1" style={{ height: `${BAR_H + 28}px` }}>
        {data.map((v, i) => {
          const barH = Math.max(2, Math.round((v / maxVal) * BAR_H));
          // Opacity ramps up toward the most-recent bar (rightmost)
          const alpha = 0.3 + (i / (data.length - 1)) * 0.7;
          const isLatest = i === data.length - 1;
          return (
            <div key={i} className="flex-1 flex flex-col items-center justify-end gap-0.5">
              {/* kill count label above bar */}
              <span
                className="text-[8px] font-mono font-black leading-none"
                style={{ color: v > 0 ? `rgba(249,115,22,${alpha})` : 'transparent' }}
              >
                {v > 0 ? v : '·'}
              </span>
              {/* bar */}
              <div
                style={{
                  height: `${barH}px`,
                  width: '100%',
                  borderRadius: '2px 2px 0 0',
                  backgroundColor: isLatest
                    ? '#f97316'
                    : `rgba(249,115,22,${alpha})`,
                  boxShadow: isLatest ? '0 0 6px rgba(249,115,22,0.4)' : 'none',
                  minHeight: '2px',
                }}
              />
              {/* time label below bar */}
              <span className="text-[7px] font-mono text-gray-700 leading-none mt-0.5">
                {labels[i]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Inline threat badge used in the neighborhood list.
function ThreatBadge({ label, color }: { label: string; color: string }) {
  const styles: Record<string, string> = {
    red:    'bg-red-900/60 text-red-400 border-red-800/60',
    amber:  'bg-amber-900/60 text-amber-400 border-amber-800/60',
    violet: 'bg-violet-900/60 text-violet-400 border-violet-800/60',
  };
  return (
    <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border uppercase tracking-wide ${styles[color]}`}>
      {label}
    </span>
  );
}

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [pilotName, setPilotName] = useState("");
  const [intel, setIntel] = useState<any>(null);
  const [viewMode, setViewMode] = useState<'LIVE' | 'SCOUT'>('LIVE');
  const [scoutIntel, setScoutIntel] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [details, setDetails] = useState<any>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [progress, setProgress] = useState(100);

  // Track asynchronously loaded killboard stats per system
  const [killStats, setKillStats] = useState<Record<number, {k1h: number, k24h: number, loading: boolean}>>({});

  // Threat data keyed by system id: { camped, smartbombs, interdictors }
  const [threatData, setThreatData] = useState<Record<number, { camped: boolean; smartbombs: boolean; interdictors: boolean }>>({});

  const scoutSystemIdRef = useRef<number | null>(null);
  const lastSpokenSystemRef = useRef<number | null>(null);

  // --- Bug fixes ---
  // (1) Keep a ref to selectedId so that the 15s interval closure always reads
  //     the current value, not the stale one captured when the effect first ran.
  const selectedIdRef = useRef<number | null>(null);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  // (2) Track which system id the in-flight details fetch was issued for, so that
  //     a result arriving late (after the user has already switched systems) is
  //     silently discarded rather than overwriting the correct system's data.
  const detailsFetchIdRef = useRef<number | null>(null);
  // -----------------

  useEffect(() => {
    if (scoutIntel?.current?.id) {
      scoutSystemIdRef.current = scoutIntel.current.id;
    }
  }, [scoutIntel]);

  const displayIntel = viewMode === 'LIVE' ? intel : scoutIntel;
  const activeSystem = displayIntel?.connections?.find((s: any) => s.id === selectedId)
    || (displayIntel?.current?.id === selectedId ? displayIntel?.current : null);

  const isCurrentSystemSelected = displayIntel?.current?.id === selectedId;

  const fetchSystemStats = async (id: number) => {
    setKillStats(prev => ({ ...prev, [id]: { ...(prev[id] || { k1h: 0, k24h: 0 }), loading: true } }));
    try {
      const res = await fetch(`http://127.0.0.1:8000/system/stats/${id}`);
      const data = await res.json();
      setKillStats(prev => ({ ...prev, [id]: { k1h: data.k1h, k24h: data.k24h, loading: false } }));
    } catch (e) {
      setKillStats(prev => ({ ...prev, [id]: { ...(prev[id] || { k1h: 0, k24h: 0 }), loading: false } }));
    }
  };

  useEffect(() => {
    if (!displayIntel || !displayIntel.current) return;
    const systemsToFetch = [displayIntel.current.id, ...(displayIntel.connections || []).map((c: any) => c.id)];
    systemsToFetch.forEach(id => { fetchSystemStats(id); });
  }, [displayIntel]);

  // Fetch threat intel for the current system and all its connections.
  // Backend caches results for 600 s, so the extra HTTP hops are cheap.
  useEffect(() => {
    if (!displayIntel?.current) return;
    const ids: number[] = [
      displayIntel.current.id,
      ...(displayIntel.connections || []).map((c: any) => c.id),
    ];
    ids.forEach(async (id) => {
      try {
        const res = await fetch(`http://127.0.0.1:8000/system/threats/${id}`);
        if (!res.ok) return;
        const data = await res.json();
        setThreatData(prev => ({ ...prev, [id]: data }));
      } catch (_) {}
    });
  }, [displayIntel]);

  // Handle Intel TTS only after all stats resolve
  useEffect(() => {
    if (!displayIntel || !displayIntel.current) return;
    const currId = displayIntel.current.id;
    const allIds = [currId, ...(displayIntel.connections || []).map((c: any) => c.id)];
    const allLoaded = allIds.every(id => killStats[id] && !killStats[id].loading);

    if (allLoaded && currId !== lastSpokenSystemRef.current) {
      lastSpokenSystemRef.current = currId;
      const curStats = killStats[currId];
      const connStats = displayIntel.connections.map((c: any) => ({ name: c.name, k1h: killStats[c.id]?.k1h || 0 }));
      speakIntel(curStats, connStats);
    }
  }, [killStats, displayIntel]);

  const handleLogout = async () => {
    await fetch("http://127.0.0.1:8000/logout", { method: "POST" });
    window.location.reload();
  };

  const selectScoutSystem = async (system: any) => {
    setIsSearching(true);
    setSuggestions([]);
    setSearchQuery("");
    try {
      const res = await fetch(`http://127.0.0.1:8000/system/scout/${system.id}`);
      const data = await res.json();
      setScoutIntel(data);
      setViewMode('SCOUT');
      setSelectedId(system.id);
    } catch (e) { console.error(e); }
    finally {
      setTimeout(() => setIsSearching(false), 800);
    }
  };

  useEffect(() => {
    const fetchSuggestions = async () => {
      if (searchQuery.length < 2) { setSuggestions([]); return; }
      const res = await fetch(`http://127.0.0.1:8000/search/suggest?q=${searchQuery}&current_id=${intel?.current?.id || ''}`);
      if (res.ok) setSuggestions(await res.json());
    };
    const timer = setTimeout(fetchSuggestions, 200);
    return () => clearTimeout(timer);
  }, [searchQuery, intel]);

  const fetchTacticalDetails = async (id: number, force: boolean = false) => {
    // Mark this as the authoritative fetch. Any prior in-flight fetch for a
    // different id will see the mismatch and drop its result.
    detailsFetchIdRef.current = id;
    if (!force) setIsDetailLoading(true);
    try {
      const res = await fetch(`http://127.0.0.1:8000/system/details/${id}${force ? '?force=true' : ''}`);
      const data = await res.json();
      // Only apply the result if the user hasn't navigated away mid-flight.
      if (detailsFetchIdRef.current === id) {
        setDetails(data);
      }
    } catch (e) { console.error(e); }
    finally {
      if (detailsFetchIdRef.current === id) setIsDetailLoading(false);
    }
  };

  const refreshIntel = async () => {
    if (!isLoggedIn) return;
    try {
      const liveRes = await fetch("http://127.0.0.1:8000/user/location");
      const liveData = await liveRes.json();
      setIntel(liveData);

      if (viewMode === 'SCOUT' && scoutSystemIdRef.current) {
        const scoutRes = await fetch(`http://127.0.0.1:8000/system/scout/${scoutSystemIdRef.current}`);
        setScoutIntel(await scoutRes.json());
      }

      // Use the ref — not the closed-over state variable — so the interval always
      // fetches details for whichever system the user has currently selected.
      const currentSelectedId = selectedIdRef.current;
      if (currentSelectedId) fetchTacticalDetails(currentSelectedId, true);
      if (!currentSelectedId && liveData.current && viewMode === 'LIVE') setSelectedId(liveData.current.id);
      setProgress(100);
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    const init = async () => {
      const res = await fetch("http://127.0.0.1:8000/user/status");
      const data = await res.json();
      if (data.is_logged_in) { setIsLoggedIn(true); setPilotName(data.name); }
    };
    init();
  }, []);

  useEffect(() => {
    if (isLoggedIn) {
      refreshIntel();
      const pollTimer = setInterval(refreshIntel, 15000);
      const progressTimer = setInterval(() => setProgress((prev) => Math.max(0, prev - (100 / 15))), 1000);
      return () => { clearInterval(pollTimer); clearInterval(progressTimer); };
    }
  }, [isLoggedIn, viewMode]);

  useEffect(() => { if (selectedId) fetchTacticalDetails(selectedId); }, [selectedId]);

  const activeStats = selectedId ? killStats[selectedId] : null;

  return (
    <main className={`h-screen w-screen flex flex-col p-3 gap-3 bg-[#080808] text-gray-300 font-sans ${!isLoggedIn ? 'overflow-hidden' : ''}`}>
      <header className="flex justify-between items-center px-4 py-2 bg-[#111] border border-gray-800 rounded">
        <div className="flex items-center gap-4">
           <div className={`w-2 h-2 rounded-full ${isLoggedIn ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
           <span className="text-xs font-mono uppercase tracking-widest">{pilotName || "Offline"}</span>
           {isLoggedIn && (
             <div className="relative ml-4">
               <form onSubmit={(e) => { e.preventDefault(); if (suggestions.length > 0) selectScoutSystem(suggestions[0]); }} className="flex items-center bg-black/40 border border-gray-800 rounded overflow-hidden">
                 <Search size={14} className="ml-3 text-gray-600" />
                 <input
                   type="text"
                   value={searchQuery}
                   onChange={(e) => setSearchQuery(e.target.value)}
                   placeholder="Scout system..."
                   className="bg-transparent text-xs font-mono text-gray-300 px-3 py-2 w-48 focus:outline-none focus:w-64 transition-all placeholder-gray-700"
                 />
               </form>
               {suggestions.length > 0 && (
                 <div className="absolute top-full left-0 mt-1 w-72 bg-[#111] border border-gray-700 rounded shadow-2xl z-50 overflow-hidden">
                   {suggestions.map((s) => (
                     <button key={s.id} onClick={() => selectScoutSystem(s)} className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-blue-900/20 transition-colors border-b border-gray-800 last:border-0">
                       <div className="flex items-center gap-3">
                         <span className="text-sm font-black text-white">{s.name}</span>
                         <span className="font-mono text-sm font-black" style={{ color: getSecColor(s.sec) }}>{s.sec.toFixed(1)}</span>
                       </div>
                       {s.jumps !== undefined && (
                         <span className="text-[10px] font-mono text-gray-500">{s.jumps === -1 ? '?' : s.jumps} jumps</span>
                       )}
                     </button>
                   ))}
                 </div>
               )}
             </div>
           )}
           {viewMode === 'SCOUT' && (
             <button onClick={() => { setViewMode('LIVE'); scoutSystemIdRef.current = null; setSelectedId(intel?.current?.id || null); }} className="ml-2 text-[10px] font-black uppercase tracking-widest bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded transition-all animate-pulse shadow-lg shadow-blue-900/20">Live: {intel?.current?.name}</button>
           )}
        </div>
        <div className="flex items-center gap-4">
           <div className="w-32 h-1 bg-gray-900 rounded overflow-hidden border border-gray-800"><div className="h-full bg-blue-600 transition-all duration-1000" style={{ width: isLoggedIn ? `${progress}%` : '0%' }} /></div>
           {isLoggedIn && <button onClick={handleLogout} className="text-gray-600 hover:text-red-500 transition-colors ml-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest"><LogOut size={14} /> Log Out</button>}
           {!isLoggedIn && (
             <button onClick={() => window.location.href = "http://127.0.0.1:8000/login"} className="ml-2 hover:opacity-80 transition-opacity">
               <img src="https://web.ccpgamescdn.com/eveonlineassets/developers/eve-sso-login-black-small.png" alt="Log in with EVE Online" className="h-6" />
             </button>
           )}
        </div>
      </header>

      <div className={`flex-1 grid grid-cols-12 gap-3 min-h-0 ${!isLoggedIn ? 'opacity-40 pointer-events-none grayscale-[0.5]' : ''}`}>
        <section className="col-span-3 bg-[#111] border border-gray-800 rounded p-4 overflow-hidden flex flex-col"><LocalParser /></section>

        <div className="col-span-9 grid grid-cols-9 gap-3 relative min-h-0">

          {isSearching && (
            <div className="absolute inset-0 z-50 bg-[#080808]/80 backdrop-blur-sm flex flex-col items-center justify-center rounded border border-blue-500/30 overflow-hidden">
               <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,_transparent_0%,_rgba(30,58,138,0.1)_100%)] animate-pulse" />
               <div className="relative">
                  <Loader2 size={48} className="text-blue-500 animate-spin mb-4" />
                  <div className="absolute inset-0 text-blue-400 blur-md animate-pulse">
                    <Loader2 size={48} />
                  </div>
               </div>
               <p className="text-sm font-black text-blue-400 uppercase tracking-[0.3em] animate-pulse">Establishing Uplink...</p>
               <div className="mt-4 w-48 h-[2px] bg-gray-900 overflow-hidden">
                  <div className="h-full bg-blue-500 w-full animate-[loading-bar_1.5s_infinite_linear]" style={{ transform: 'translateX(-100%)' }} />
               </div>
            </div>
          )}

          <section className="col-span-5 flex flex-col gap-3 overflow-hidden">

            <button
              onClick={() => displayIntel?.current && setSelectedId(displayIntel.current.id)}
              disabled={!displayIntel?.current}
              className={`bg-[#111] border rounded p-6 flex flex-col items-center relative w-full text-left transition-all ${isCurrentSystemSelected ? 'border-blue-500 shadow-lg shadow-blue-900/20' : 'border-gray-800 hover:border-gray-600 cursor-pointer'}`}
            >
               {viewMode === 'SCOUT' && (
                 <div className="absolute top-4 left-4 text-[10px] font-black bg-orange-900/40 text-orange-400 px-2 py-1 rounded border border-orange-800/50 uppercase">Scouting Mode</div>
               )}
               {isCurrentSystemSelected && (
                 <div className="absolute top-4 right-4 text-[10px] font-black bg-blue-900/40 text-blue-400 px-2 py-1 rounded border border-blue-800/50 uppercase tracking-widest">Selected</div>
               )}
               <div className="flex items-baseline gap-3 mb-1">
                  <h1 className="text-6xl font-black text-white tracking-tighter">{displayIntel?.current?.name || "..."}</h1>
                  <span className="text-5xl font-black font-mono" style={{ color: getSecColor(displayIntel?.current?.sec || 0) }}>{displayIntel?.current?.sec?.toFixed(1)}</span>
                  {displayIntel?.current?.has_scout && <Wifi size={24} className="text-cyan-400 animate-pulse ml-4 self-center" />}
               </div>
               <p className="text-xs font-bold text-gray-600 uppercase tracking-widest mb-6">Sov: {displayIntel?.current?.owner}</p>
               <div className="flex gap-4 w-full">
                  <div className="flex-1 bg-black/40 border border-gray-800 p-4 rounded text-center">
                    <p className="text-xs text-gray-500 font-bold uppercase mb-1">1H PvP</p>
                    <div className="h-10 flex items-center justify-center">
                      {killStats[displayIntel?.current?.id]?.loading ? <Loader2 className="animate-spin text-orange-500/50" size={32} /> : <p className="text-4xl font-mono font-black text-orange-500">{killStats[displayIntel?.current?.id]?.k1h ?? 0}</p>}
                    </div>
                  </div>
                  <div className="flex-1 bg-black/40 border border-gray-800 p-4 rounded text-center">
                    <p className="text-xs text-gray-500 font-bold uppercase mb-1">24H PvP</p>
                    <div className="h-10 flex items-center justify-center">
                      {killStats[displayIntel?.current?.id]?.loading ? <Loader2 className="animate-spin text-red-600/50" size={32} /> : <p className="text-4xl font-mono font-black text-red-600">{killStats[displayIntel?.current?.id]?.k24h ?? 0}</p>}
                    </div>
                  </div>
               </div>
            </button>

            <div className="flex-1 bg-[#111] border border-gray-800 rounded p-4 flex flex-col overflow-hidden">
               <div className="flex items-center gap-2 mb-4 text-gray-400 border-b border-gray-800 pb-2 font-black uppercase text-sm tracking-widest"><Zap size={18} /> Neighborhood</div>
               <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                  {displayIntel?.connections?.map((sys: any) => {
                    const threats = threatData[sys.id];
                    return (
                      <button key={sys.id} onClick={() => setSelectedId(sys.id)} className={`w-full flex items-center justify-between p-3 border rounded transition-all ${selectedId === sys.id ? 'border-blue-500 bg-blue-900/10' : 'border-gray-800 bg-black/40 hover:border-gray-700'}`}>
                        <div className="flex items-center gap-3">
                          <ArrowRightCircle size={22} className="text-gray-700" />
                          <div className="text-left">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[22px] font-black text-white">{sys.name}</span>
                              <span className="font-mono font-black text-[22px]" style={{ color: getSecColor(sys.sec) }}>{sys.sec.toFixed(1)}</span>
                              {sys.has_scout && <Wifi size={16} className="text-cyan-400 animate-pulse" />}
                              {/* Threat badges — only rendered once backend data arrives */}
                              {threats?.camped      && <ThreatBadge label="CAMPED" color="red"    />}
                              {threats?.interdictors && !threats?.camped && <ThreatBadge label="DICTOR" color="violet" />}
                              {threats?.smartbombs  && <ThreatBadge label="SB"     color="amber"  />}
                            </div>
                            <p className="text-[12px] font-bold text-gray-600 uppercase tracking-widest">{sys.owner}</p>
                          </div>
                        </div>
                        <div className="flex gap-6 font-mono font-black text-center uppercase tracking-tighter">
                          <div>
                            <p className="text-[12px] text-gray-600">1H PvP</p>
                            <div className="h-6 flex items-center justify-center">
                              {killStats[sys.id]?.loading ? <Loader2 className="animate-spin text-orange-500/50" size={20} /> : <span className="text-orange-500 text-[20px]">{killStats[sys.id]?.k1h ?? 0}</span>}
                            </div>
                          </div>
                          <div>
                            <p className="text-[12px] text-gray-600">24H PvP</p>
                            <div className="h-6 flex items-center justify-center">
                              {killStats[sys.id]?.loading ? <Loader2 className="animate-spin text-red-600/50" size={20} /> : <span className="text-red-600 text-[20px]">{killStats[sys.id]?.k24h ?? 0}</span>}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
               </div>
            </div>
          </section>

          <section className="col-span-4 bg-[#111] border border-gray-800 rounded p-5 flex flex-col overflow-hidden relative">
            {activeSystem ? (
              <div className={`flex flex-col h-full gap-5 transition-opacity duration-300 ${isDetailLoading ? 'opacity-40' : 'opacity-100'}`}>
                <div className="border-b border-gray-800 pb-3 flex justify-between items-center">
                  <h2 className="text-xl font-black text-white flex items-center gap-2 uppercase tracking-tighter"><Crosshair size={18} className="text-blue-500" /> Tactical Overview: {activeSystem.name}</h2>
                  <button onClick={() => fetchTacticalDetails(selectedId!, true)} disabled={isDetailLoading} className="p-1.5 hover:bg-gray-800 rounded text-gray-500 hover:text-blue-400 transition-colors disabled:opacity-50"><RefreshCcw size={16} className={isDetailLoading ? 'animate-spin' : ''} /></button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-black/40 p-3 border border-gray-800 rounded"><p className="text-xs font-black text-gray-500 uppercase mb-1">NPC Kills (1H)</p><p className="text-3xl font-mono font-black text-green-500">{details?.npc_kills_1h ?? '...'}</p></div>
                  <div className="bg-black/40 p-3 border border-gray-800 rounded"><p className="text-xs font-black text-gray-500 uppercase mb-1">Jumps (1H)</p><p className="text-3xl font-mono font-black text-blue-400">{details?.jumps_1h ?? '...'}</p></div>
                  <div className="bg-black/40 p-3 border border-gray-800 rounded">
                    <p className="text-xs font-black text-gray-500 uppercase mb-1">PvP Kills (1H)</p>
                    <div className="h-9 flex items-center">
                      {activeStats?.loading ? <Loader2 className="animate-spin text-orange-500/50" size={28} /> : <p className="text-3xl font-mono font-black text-orange-500">{activeStats?.k1h ?? 0}</p>}
                    </div>
                  </div>
                  <div className="bg-black/40 p-3 border border-gray-800 rounded">
                    <p className="text-xs font-black text-gray-500 uppercase mb-1">PvP Kills (24H)</p>
                    <div className="h-9 flex items-center">
                      {activeStats?.loading ? <Loader2 className="animate-spin text-red-600/50" size={28} /> : <p className="text-3xl font-mono font-black text-red-600">{activeStats?.k24h ?? 0}</p>}
                    </div>
                  </div>
                </div>

                {/* Activity sparkline — shown when details have loaded */}
                {details?.sparkline && (
                  <div className="bg-black/40 border border-gray-800 rounded p-3">
                    <ActivitySparkline data={details.sparkline} />
                  </div>
                )}

                <div className="bg-cyan-900/10 border border-cyan-800/50 rounded p-4">
                   <p className="text-xs font-black text-cyan-400 uppercase mb-3 flex items-center gap-2"><Wifi size={14} /> EVE-Scout Intelligence</p>
                   {details?.signatures?.length > 0 ? (
                      <div className="space-y-2">{details.signatures.map((sig: any) => (<div key={sig.id} className="flex items-center justify-between bg-black/40 p-2 rounded border-l-2 border-cyan-500"><div><p className="text-[11px] font-black text-white">{sig.target} Portal</p><p className="text-[10px] text-gray-500 font-mono">ID: {sig.id}</p></div><div className="text-right"><p className="text-[10px] text-cyan-500 font-black">~{sig.remaining.toFixed(1)}H</p></div></div>))}</div>
                   ) : <p className="text-xs text-gray-600 italic">No signatures detected.</p>}
                </div>
                <div className="flex flex-col gap-2 mt-auto">
                  <a href={`https://zkillboard.com/system/${activeSystem.id}/`} target="_blank" rel="noreferrer" className="w-full flex items-center justify-center gap-2 bg-blue-700 hover:bg-blue-600 text-white py-3 rounded font-black text-xs uppercase tracking-widest shadow-lg">zKillboard Feed</a>
                  <a href={`https://evemaps.dotlan.net/system/${activeSystem.name}`} target="_blank" rel="noreferrer" className="w-full flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-700 text-white py-3 rounded font-black text-xs uppercase tracking-widest">Dotlan Intel</a>
                </div>
              </div>
            ) : <div className="h-full flex flex-col items-center justify-center opacity-20"><Info size={40} /><p className="text-xs font-black uppercase mt-4">Select System</p></div>}
          </section>
        </div>
      </div>
    </main>
  );
}