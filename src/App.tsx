import React, { useEffect, useState, useRef } from 'react';
import LocalParser from './components/LocalParser';
import { Crosshair, Zap, ArrowRightCircle, LogOut, Info, RefreshCcw, Wifi, Search, Loader2 } from 'lucide-react';

const getSecColor = (sec: number) => {
  if (sec >= 1.0) return '#2FEFEF';
  if (sec >= 0.8) return '#00EF47';
  if (sec >= 0.5) return '#EFBE00';
  if (sec >= 0.2) return '#EF2F00';
  return '#EF0000';
};

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

  // Ref always holds the latest scout system ID so the poll interval
  // closure never reads a stale value after a new search is made.
  const scoutSystemIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (scoutIntel?.current?.id) {
      scoutSystemIdRef.current = scoutIntel.current.id;
    }
  }, [scoutIntel]);

  const displayIntel = viewMode === 'LIVE' ? intel : scoutIntel;
  const activeSystem = displayIntel?.connections?.find((s:any) => s.id === selectedId)
    || (displayIntel?.current?.id === selectedId ? displayIntel?.current : null);

  const isCurrentSystemSelected = displayIntel?.current?.id === selectedId;

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
    if (!force) setIsDetailLoading(true);
    try {
      const res = await fetch(`http://127.0.0.1:8000/system/details/${id}${force ? '?force=true' : ''}`);
      setDetails(await res.json());
    } catch (e) { console.error(e); }
    finally { setIsDetailLoading(false); }
  };

  const refreshIntel = async () => {
    if (!isLoggedIn) return;
    try {
      const liveRes = await fetch("http://127.0.0.1:8000/user/location");
      const liveData = await liveRes.json();
      setIntel(liveData);

      // Use the ref so we always refresh whichever system was searched last,
      // not the one that was current when the interval was created.
      if (viewMode === 'SCOUT' && scoutSystemIdRef.current) {
        const scoutRes = await fetch(`http://127.0.0.1:8000/system/scout/${scoutSystemIdRef.current}`);
        setScoutIntel(await scoutRes.json());
      }

      if (selectedId) fetchTacticalDetails(selectedId, true);
      if (!selectedId && liveData.current && viewMode === 'LIVE') setSelectedId(liveData.current.id);
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

        {/* CONTAINER FOR INTEL & TACTICAL WITH LOADING OVERLAY */}
        <div className="col-span-9 grid grid-cols-9 gap-3 relative min-h-0">

          {/* SCANNING OVERLAY */}
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
                  <div className="h-full bg-blue-500 w-full animate-[loading-bar_1.5s_infinite_linear]"
                       style={{ transform: 'translateX(-100%)' }} />
               </div>
            </div>
          )}

          {/* SYSTEM & NEIGHBORHOOD */}
          <section className="col-span-5 flex flex-col gap-3 overflow-hidden">

            {/* Main system card — clickable to select it in the tactical overview */}
            <button
              onClick={() => displayIntel?.current && setSelectedId(displayIntel.current.id)}
              disabled={!displayIntel?.current}
              className={`bg-[#111] border rounded p-6 flex flex-col items-center relative w-full text-left transition-all
                ${isCurrentSystemSelected
                  ? 'border-blue-500 shadow-lg shadow-blue-900/20'
                  : 'border-gray-800 hover:border-gray-600 cursor-pointer'}`}
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
                  <div className="flex-1 bg-black/40 border border-gray-800 p-4 rounded text-center"><p className="text-xs text-gray-500 font-bold uppercase mb-1">1H PvP</p><p className="text-4xl font-mono font-black text-orange-500">{displayIntel?.current?.k1h || 0}</p></div>
                  <div className="flex-1 bg-black/40 border border-gray-800 p-4 rounded text-center"><p className="text-xs text-gray-500 font-bold uppercase mb-1">24H PvP</p><p className="text-4xl font-mono font-black text-red-600">{displayIntel?.current?.k24h || 0}</p></div>
               </div>
            </button>

            <div className="flex-1 bg-[#111] border border-gray-800 rounded p-4 flex flex-col overflow-hidden">
               <div className="flex items-center gap-2 mb-4 text-gray-400 border-b border-gray-800 pb-2 font-black uppercase text-sm tracking-widest"><Zap size={18} /> Neighborhood</div>
               <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                  {displayIntel?.connections?.map((sys: any) => (
                    <button key={sys.id} onClick={() => setSelectedId(sys.id)} className={`w-full flex items-center justify-between p-3 border rounded transition-all ${selectedId === sys.id ? 'border-blue-500 bg-blue-900/10' : 'border-gray-800 bg-black/40 hover:border-gray-700'}`}>
                      <div className="flex items-center gap-3">
                        <ArrowRightCircle size={22} className="text-gray-700" />
                        <div className="text-left">
                          <div className="flex items-center gap-2"><span className="text-[22px] font-black text-white">{sys.name}</span><span className="font-mono font-black text-[22px]" style={{ color: getSecColor(sys.sec) }}>{sys.sec.toFixed(1)}</span>{sys.has_scout && <Wifi size={16} className="text-cyan-400 animate-pulse" />}</div>
                          <p className="text-[12px] font-bold text-gray-600 uppercase tracking-widest">{sys.owner}</p>
                        </div>
                      </div>
                      <div className="flex gap-6 font-mono font-black text-center uppercase tracking-tighter">
                        <div><p className="text-[12px] text-gray-600">1H PvP</p><span className="text-orange-500 text-[20px]">{sys.k1h}</span></div>
                        <div><p className="text-[12px] text-gray-600">24H PvP</p><span className="text-red-600 text-[20px]">{sys.k24h}</span></div>
                      </div>
                    </button>
                  ))}
               </div>
            </div>
          </section>

          {/* TACTICAL OVERVIEW */}
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
                  <div className="bg-black/40 p-3 border border-gray-800 rounded"><p className="text-xs font-black text-gray-500 uppercase mb-1">PvP Kills (1H)</p><p className="text-3xl font-mono font-black text-orange-500">{activeSystem.k1h}</p></div>
                  <div className="bg-black/40 p-3 border border-gray-800 rounded"><p className="text-xs font-black text-gray-500 uppercase mb-1">PvP Kills (24H)</p><p className="text-3xl font-mono font-black text-red-600">{activeSystem.k24h}</p></div>
                </div>
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