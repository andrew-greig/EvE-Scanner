import React, { useState } from 'react';
import { Users, Scan, Trash2, Loader2, AlertTriangle } from 'lucide-react';

// Custom CSS for the red threat pulse
const pulseStyle = `
  @keyframes threat-pulse {
    0%, 100% { background-color: rgba(153, 27, 27, 0.4); }
    50% { background-color: rgba(220, 38, 38, 0.8); }
  }
  .animate-threat {
    animation: threat-pulse 2s ease-in-out infinite;
  }
`;

export default function LocalParser() {
  const [rawText, setRawText] = useState("");
  const [pilots, setPilots] = useState<any[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  const playAlert = () => {
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.5);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {
      console.error("Audio playback failed", e);
    }
  };

  const handleScan = async () => {
    if (!rawText.trim()) return;
    setIsScanning(true);
    
    try {
      let chunkArray: any[] = [];
      if (typeof rawText === 'string') {
        chunkArray = rawText.split('\n').map(line => line.trim()).filter(Boolean);
      } else if (Array.isArray(rawText)) {
        chunkArray = rawText;
      } else if ((rawText as any)?.characters) {
        chunkArray = (rawText as any).characters;
      }

      const parsedNames = chunkArray.map((item: any) => typeof item === 'string' ? item.trim() : item?.name || '').filter(Boolean);
      const uniqueNames = Array.from(new Set(parsedNames));

      if (uniqueNames.length === 0) {
        setIsScanning(false);
        return;
      }

      const idRes = await fetch("https://esi.evetech.net/latest/universe/ids/", { method: "POST", body: JSON.stringify(uniqueNames) });
      const idData = await idRes.json();
      const characters = idData.characters || [];

      const charIds = characters.map((c: any) => c.id);
      const affilRes = await fetch("https://esi.evetech.net/latest/characters/affiliation/", { method: "POST", body: JSON.stringify(charIds) });
      const affilData = await affilRes.json();

      const corpIds = [...new Set(affilData.map((a: any) => a.corporation_id).filter(Boolean))];
      const allianceIds = [...new Set(affilData.map((a: any) => a.alliance_id).filter(Boolean))];
      
      const corpMap: Record<number, string> = {};
      const allianceMap: Record<number, string> = {};

      await Promise.all([
        ...corpIds.map(async (id: any) => {
          try {
            const res = await fetch(`https://esi.evetech.net/latest/corporations/${id}/`);
            corpMap[id] = (await res.json()).ticker;
          } catch (e) {}
        }),
        ...allianceIds.map(async (id: any) => {
          try {
            const res = await fetch(`https://esi.evetech.net/latest/alliances/${id}/`);
            allianceMap[id] = (await res.json()).ticker;
          } catch (e) {}
        })
      ]);

      let highDangerDetected = false;

      const fullProfiles = await Promise.all(characters.map(async (char: any) => {
        const affil = affilData.find((a: any) => a.character_id === char.id) || {};
        
        let secStatus = 0.0;
        let danger = 0;
        let recentKills = 0;

        try {
          const cRes = await fetch(`https://esi.evetech.net/latest/characters/${char.id}/`);
          secStatus = (await cRes.json()).security_status || 0.0;
        } catch (e) {}

        try {
          const zRes = await fetch(`https://zkillboard.com/api/stats/characterID/${char.id}/`);
          if (zRes.ok) {
            const zData = await zRes.json();
            danger = zData.dangerRatio || 0;
            const months = Object.values(zData.months || {});
            const latestMonth: any = months.pop();
            recentKills = latestMonth?.shipsDestroyed || 0;
          }
        } catch (e) {}

        // Threat criteria: Kills > 2 OR DGR > 70 OR Sec < 0.0
        const isThreat = recentKills > 2 || danger > 70 || secStatus < 0.0;
        if (isThreat) highDangerDetected = true;

        const isAlliance = !!affil.alliance_id;
        const groupId = affil.alliance_id || affil.corporation_id || 0;
        const ticker = isAlliance ? allianceMap[affil.alliance_id] : corpMap[affil.corporation_id];

        return {
          id: char.id,
          name: char.name,
          corpId: affil.corporation_id,
          allianceId: affil.alliance_id,
          groupId: groupId,
          ticker: ticker || "UNK",
          sec: secStatus,
          danger: danger,
          kills: recentKills,
          isThreat: isThreat
        };
      }));

      const groupCounts: Record<number, number> = {};
      fullProfiles.forEach(p => {
        groupCounts[p.groupId] = (groupCounts[p.groupId] || 0) + 1;
      });

      fullProfiles.forEach(p => {
        p.hasGroupmates = groupCounts[p.groupId] >= 2;
      });

      setPilots(fullProfiles);
      if (highDangerDetected) playAlert();

    } catch (error) {
      console.error("Local Parse Error:", error);
    } finally {
      setIsScanning(false);
    }
  };

  const clearAll = () => {
    setRawText("");
    setPilots([]);
  };

  return (
    <div className="flex flex-col h-full text-gray-300">
      <style>{pulseStyle}</style>
      <div className="flex items-center gap-2 mb-4 border-b border-gray-800 pb-2">
        <Users size={18} className="text-blue-500" />
        <h2 className="text-sm font-black uppercase tracking-widest text-white">Local Intel</h2>
        <span className="ml-auto text-[10px] font-mono bg-gray-800 px-2 py-0.5 rounded-lg text-gray-400">
          {pilots.length} IN SYSTEM
        </span>
      </div>

      <div className="flex-1 flex flex-col gap-3 min-h-0">
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder="Ctrl+A, Ctrl+C in Local Chat, then Ctrl+V here..."
          className="w-full h-32 bg-black/40 border border-gray-800 rounded p-3 text-xs font-mono text-gray-400 focus:outline-none focus:border-blue-500 transition-colors resize-none custom-scrollbar"
        />

        <div className="flex gap-2">
          <button
            onClick={handleScan}
            disabled={isScanning || !rawText.trim()}
            className="flex-1 flex items-center justify-center gap-2 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-800 disabled:text-gray-600 text-white py-2 rounded-lg font-black text-[10px] uppercase tracking-widest transition-colors"
          >
            {isScanning ? <Loader2 size={14} className="animate-spin" /> : <Scan size={14} />}
            Analyze Local
          </button>
          
          <button
            onClick={clearAll}
            disabled={isScanning || (!rawText && pilots.length === 0)}
            className="px-3 flex items-center justify-center bg-red-900/30 hover:bg-red-900/60 disabled:bg-gray-900/50 text-red-500 border border-red-900/50 rounded-lg transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto mt-2 space-y-2 custom-scrollbar pr-2">
          {pilots.length === 0 && !isScanning && (
            <div className="h-full flex flex-col items-center justify-center opacity-30 text-center">
              <Users size={32} className="mb-2" />
              <p className="text-[10px] font-black uppercase tracking-widest">Awaiting Intel</p>
            </div>
          )}
          
          {pilots.map((p) => {
            const allianceTint = p.hasGroupmates ? `hsla(${p.groupId % 360}, 50%, 15%, 0.5)` : 'rgba(0,0,0,0.4)';
            const logoUrl = p.allianceId 
              ? `https://images.evetech.net/alliances/${p.allianceId}/logo?size=32`
              : `https://images.evetech.net/corporations/${p.corpId}/logo?size=32`;

            return (
              <div 
                key={p.id} 
                className={`flex items-center justify-between p-2 border rounded-lg transition-all ${p.isThreat ? 'border-red-500 animate-threat' : 'border-gray-800 hover:border-gray-700'}`}
                style={!p.isThreat ? { backgroundColor: allianceTint } : {}}
              >
                <div className="flex items-center gap-3">
                  <img src={logoUrl} alt="Logo" className="w-8 h-8 rounded border border-gray-900 shadow-lg bg-black/20" />
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-black text-white">{p.name}</span>
                      {p.isThreat && <AlertTriangle size={12} className="text-white" />}
                    </div>
                    <span className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">[{p.ticker}]</span>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-right pr-1">
                  <div className="flex flex-col">
                    <span className="text-[9px] text-gray-400/60 font-black uppercase tracking-widest">Kills</span>
                    <span className="text-xs font-mono font-black text-white">{p.kills}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[9px] text-gray-400/60 font-black uppercase tracking-widest">DGR</span>
                    <span className="text-xs font-mono font-black text-white">{p.danger}%</span>
                  </div>
                  <div className="flex flex-col w-8">
                    <span className="text-[9px] text-gray-400/60 font-black uppercase tracking-widest">Sec</span>
                    <span className="text-xs font-mono font-black text-white">{p.sec.toFixed(1)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}