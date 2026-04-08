import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { ScanResult, WalletScanResult, WalletType, ClassifiedWallet, ThreatEvent, ReplayResult } from "./lib/types";
import {
  C, mono, sans, heading, display, GLOBAL_CSS, EASE,
  SeverityDot, TypeWriter, ExportButton,
  Frost, Tag, HoverRow, ComingSoon, Donut,
  truncAddr, pnlColor, fmtPnl,
} from "./components/shared";
import WalletResults from "./components/WalletResults";
import GraphPanel from "./components/GraphPanel";
import CopyNetworkPanel from "./components/CopyNetworkPanel";
import ReplayView from "./components/ReplayView";
import LeaderboardView from "./components/LeaderboardView";
import { buildTokenGraph } from "./components/graphData";
import { exportScanResult } from "./lib/export";

const THREAT_POLL_INTERVAL_MS = 15_000;
const SIDEBAR_W = 200;

type ToolId = "token" | "wallet" | "replay" | "lp" | "copy" | "rep" | "board" | "threats" | "alerts" | "export";

interface ToolDef {
  id: ToolId;
  label: string;
  icon: string;
  section: string;
  ready: boolean;
}

const TOOLS: ToolDef[] = [
  { id: "token", label: "Token Scan", icon: "\u2295", section: "SCAN", ready: true },
  { id: "wallet", label: "Wallet Scan", icon: "\u25CE", section: "SCAN", ready: true },
  { id: "replay", label: "Rug Replay", icon: "\u21BA", section: "ANALYZE", ready: true },
  { id: "lp", label: "LP Monitor", icon: "\u25C8", section: "ANALYZE", ready: true },
  { id: "copy", label: "Copy Network", icon: "\u22B7", section: "ANALYZE", ready: true },
  { id: "rep", label: "Reputation", icon: "\u2726", section: "ANALYZE", ready: true },
  { id: "board", label: "Sniper Board", icon: "\u25A6", section: "INTEL", ready: true },
  { id: "threats", label: "Threat Feed", icon: "\u25C9", section: "INTEL", ready: true },
  { id: "alerts", label: "Whale Alerts", icon: "\u25B3", section: "INTEL", ready: true },
  { id: "export", label: "Export", icon: "\u2197", section: "UTIL", ready: true },
];

const SECTIONS = ["SCAN", "ANALYZE", "INTEL", "UTIL"];

// ── Sidebar nav item ──

function NavItem({ tool, active, onClick }: { tool: ToolDef; active: boolean; onClick: () => void }) {
  const [h, setH] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 14px",
        borderRadius: 7,
        cursor: "pointer",
        background: active ? "rgba(255,255,255,0.06)" : h ? "rgba(255,255,255,0.025)" : "transparent",
        border: active ? `1px solid ${C.border}` : "1px solid transparent",
        transition: `all 0.2s ${EASE}`,
        opacity: tool.ready ? 1 : 0.4,
      }}
    >
      <span style={{ fontSize: 16, lineHeight: 1, width: 20, textAlign: "center", color: active ? C.text : C.sub }}>
        {tool.icon}
      </span>
      <span style={{ fontFamily: mono, fontSize: 12, color: active ? C.text : C.sub, letterSpacing: "0.02em" }}>
        {tool.label}
      </span>
      {!tool.ready && (
        <span style={{ fontFamily: mono, fontSize: 9, color: C.dim, marginLeft: "auto", letterSpacing: "0.06em" }}>
          SOON
        </span>
      )}
    </div>
  );
}

// ── Threat row ──

function ThreatRow({
  threat,
  onWalletClick,
  formatTime,
}: {
  threat: ThreatEvent;
  onWalletClick: (addr: string) => void;
  formatTime: (iso: string) => string;
}) {
  const [h, setH] = useState(false);
  return (
    <div
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        padding: "10px 20px",
        cursor: "pointer",
        background: h ? "rgba(255,255,255,0.012)" : "transparent",
        borderBottom: "1px solid rgba(255,255,255,0.03)",
        transition: "background 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <SeverityDot severity={threat.severity} />
        <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: threat.severity === "CRITICAL" ? C.red : C.sub }}>
          {threat.type}
        </span>
        <span style={{ fontFamily: sans, fontSize: 14, fontWeight: 600 }}>${threat.tokenSymbol}</span>
        {threat.lpRemovedSol != null && (
          <span style={{ fontFamily: mono, fontSize: 11, color: C.red }}>{threat.lpRemovedSol.toFixed(1)} SOL</span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: mono, fontSize: 12, color: C.dim }}>{formatTime(threat.timestamp)}</span>
      </div>
      <p style={{ fontFamily: mono, fontSize: 12, color: C.sub, lineHeight: 1.65, paddingLeft: 14 }}>
        {threat.detail}
      </p>
      {threat.wallet && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 14, marginTop: 4 }}>
          <span
            onClick={(e) => { e.stopPropagation(); onWalletClick(threat.wallet!); }}
            style={{ fontFamily: mono, fontSize: 10, color: C.dim, cursor: "pointer" }}
          >
            {truncAddr(threat.wallet)}
          </span>
          {threat.walletType && <Tag danger={threat.walletType === "INSIDER"}>{threat.walletType}</Tag>}
        </div>
      )}
    </div>
  );
}

// ── Main App ──

export default function App() {
  const [activeTool, setActiveTool] = useState<ToolId>("token");
  const [inputMode, setInputMode] = useState<"TOKEN" | "WALLET">("TOKEN");
  const [inputVal, setInputVal] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanPhase, setScanPhase] = useState("");
  const [scanProgress, setScanProgress] = useState(0);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [walletResult, setWalletResult] = useState<WalletScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const tokenGraphData = useMemo(() => (result ? buildTokenGraph(result) : null), [result]);
  const [inputShake, setInputShake] = useState(false);
  const scanInFlightRef = useRef(false);
  const [time, setTime] = useState(new Date());
  const [threats, setThreats] = useState<ThreatEvent[]>([]);
  const [threatsLoading, setThreatsLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [replayInput, setReplayInput] = useState("");
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);
  const [replayScanning, setReplayScanning] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayPhase, setReplayPhase] = useState("");
  const [replayProgress, setReplayProgress] = useState(0);
  const [watching, setWatching] = useState(false);
  const [watchLoading, setWatchLoading] = useState(false);

  // ── Browser history (back button support) ──

  const navigateTo = useCallback((tool: ToolId) => {
    setActiveTool(tool);
    if (tool === "token") setInputMode("TOKEN");
    if (tool === "wallet") setInputMode("WALLET");
    history.pushState({ tool }, "");
  }, []);

  useEffect(() => {
    // Seed history so the first back press goes to the current tool, not the previous page.
    history.replaceState({ tool: "token" }, "");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const tool = (e.state as { tool?: ToolId } | null)?.tool;
      if (tool && TOOLS.some((t) => t.id === tool)) {
        setActiveTool(tool);
        if (tool === "token") setInputMode("TOKEN");
        if (tool === "wallet") setInputMode("WALLET");
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const fetchThreats = useCallback(async () => {
    try {
      setThreatsLoading(true);
      const res = await fetch("/api/threats");
      if (res.ok) {
        const data: ThreatEvent[] = await res.json();
        setThreats(data);
      }
    } catch {
      /* silent — threat feed is best-effort */
    } finally {
      setThreatsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTool !== "threats") {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    fetchThreats();
    pollRef.current = setInterval(fetchThreats, THREAT_POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeTool, fetchThreats]);

  // Check watch status when token scan result changes
  useEffect(() => {
    if (!result) { setWatching(false); return; }
    fetch(`/api/watch?mint=${result.token.mint}`)
      .then((r) => r.json())
      .then((d: { watched?: boolean }) => setWatching(d.watched === true))
      .catch(() => setWatching(false));
  }, [result]);

  const toggleWatch = useCallback(async () => {
    if (!result) return;
    setWatchLoading(true);
    try {
      const action = watching ? "remove" : "add";
      const res = await fetch("/api/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mint: result.token.mint,
          symbol: result.token.symbol,
          action,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { watched: boolean };
        setWatching(data.watched);
      }
    } catch { /* silent */ }
    finally { setWatchLoading(false); }
  }, [result, watching]);

  const doReplay = useCallback(async () => {
    const mint = replayInput.trim();
    if (!mint) return;

    setReplayScanning(true);
    setReplayError(null);
    setReplayResult(null);
    setReplayProgress(0);

    const phases = [
      "FETCHING TRANSACTION HISTORY...",
      "CLASSIFYING WALLETS...",
      "RECONSTRUCTING TIMELINE...",
      "DETECTING RUG METHOD...",
      "COMPUTING LOSSES...",
    ];
    let phaseIdx = 0;
    const phaseInterval = setInterval(() => {
      if (phaseIdx < phases.length) {
        setReplayPhase(phases[phaseIdx]);
        setReplayProgress(((phaseIdx + 1) / phases.length) * 90);
        phaseIdx++;
      }
    }, 700);

    try {
      const res = await fetch("/api/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mint }),
      });

      clearInterval(phaseInterval);
      setReplayPhase("REPLAY COMPLETE");
      setReplayProgress(100);

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error((errBody as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      const data: ReplayResult = await res.json();
      setReplayResult(data);
    } catch (err: unknown) {
      setReplayError(err instanceof Error ? err.message : "Replay failed");
    } finally {
      clearInterval(phaseInterval);
      setReplayScanning(false);
    }
  }, [replayInput]);

  const doScan = useCallback(async (overrideAddress?: string) => {
    if (scanInFlightRef.current) return;
    const addr = (overrideAddress ?? inputVal).trim();
    if (!addr) {
      setInputShake(true);
      setTimeout(() => setInputShake(false), 500);
      return;
    }

    const isWallet = overrideAddress ? true : inputMode === "WALLET";

    scanInFlightRef.current = true;
    setScanning(true);
    setError(null);
    setResult(null);
    setWalletResult(null);
    setShowGraph(false);
    setScanProgress(0);

    const phases = isWallet
      ? ["RESOLVING WALLET...", "FETCHING TRANSACTION HISTORY...", "GROUPING TOKEN INTERACTIONS...", "CLASSIFYING PER-TOKEN BEHAVIOR...", "ANALYZING FUNDING GRAPH...", "GENERATING VERDICT..."]
      : ["RESOLVING TOKEN MINT...", "FETCHING TRANSACTION HISTORY...", "ANALYZING WALLET CLUSTERS...", "DETECTING AGENT SIGNATURES...", "CLASSIFYING BEHAVIOR PATTERNS...", "COMPUTING ORGANIC SCORE..."];

    let phaseIdx = 0;
    const phaseInterval = setInterval(() => {
      if (phaseIdx < phases.length) {
        setScanPhase(phases[phaseIdx]);
        setScanProgress(((phaseIdx + 1) / phases.length) * 90);
        phaseIdx++;
      }
    }, 800);

    try {
      const endpoint = isWallet ? "/api/wallet" : "/api/scan";
      const body = isWallet ? { address: addr } : { mint: addr };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      clearInterval(phaseInterval);
      setScanPhase("SCAN COMPLETE");
      setScanProgress(100);

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error((errBody as unknown as { error: string }).error || `HTTP ${res.status}`);
      }

      if (isWallet) {
        const data: WalletScanResult = await res.json();
        setWalletResult(data);
      } else {
        const data: ScanResult = await res.json();
        setResult(data);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      clearInterval(phaseInterval);
      scanInFlightRef.current = false;
      setScanning(false);
    }
  }, [inputVal, inputMode]);

  const handleWalletClick = useCallback((addr: string) => {
    navigateTo("wallet");
    setInputVal(addr);
    doScan(addr);
  }, [navigateTo, doScan]);

  const formatThreatTime = (iso: string): string => {
    const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  /** Map activeTool to the old view concept for content rendering. */
  const isTokenScan = activeTool === "token";
  const isWalletScan = activeTool === "wallet";
  const isScanView = isTokenScan || isWalletScan;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: sans }}>
      <style>{GLOBAL_CSS}</style>

      {/* ── SIDEBAR ── */}
      <div
        style={{
          width: SIDEBAR_W,
          position: "fixed",
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 50,
          background: "rgba(255,255,255,0.012)",
          backdropFilter: "blur(40px)",
          borderRight: `1px solid ${C.border}`,
          display: "flex",
          flexDirection: "column",
          padding: "16px 12px",
          overflowY: "auto",
        }}
      >
        {/* Hero + Logo */}
        <div style={{ padding: "0 8px", marginBottom: 20, textAlign: "center" }}>
          <div
            style={{
              width: "100%",
              aspectRatio: "1",
              borderRadius: 12,
              overflow: "hidden",
              marginBottom: 10,
              border: `1px solid ${C.border}`,
              background: "rgba(0,0,0,0.3)",
            }}
          >
            <img
              src="/detective.png"
              alt="CryptOSINT"
              style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center top" }}
            />
          </div>
          <span style={{ fontFamily: heading, fontSize: 18, fontWeight: 400, color: C.text, letterSpacing: "0.02em" }}>
            CryptOSINT
          </span>
          <div style={{ fontFamily: mono, fontSize: 9, color: C.dim, letterSpacing: "0.08em", marginTop: 3 }}>
            ON-CHAIN INTELLIGENCE
          </div>
        </div>

        {/* Nav sections */}
        {SECTIONS.map((section) => (
          <div key={section} style={{ marginBottom: 16 }}>
            <div
              style={{
                fontFamily: mono,
                fontSize: 10,
                color: C.dim,
                letterSpacing: "0.1em",
                padding: "0 14px",
                marginBottom: 6,
              }}
            >
              {section}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {TOOLS.filter((t) => t.section === section).map((tool) => (
                <NavItem
                  key={tool.id}
                  tool={tool}
                  active={activeTool === tool.id}
                  onClick={() => {
                    if (!tool.ready) return;
                    navigateTo(tool.id);
                  }}
                />
              ))}
            </div>
          </div>
        ))}

        <div style={{ flex: 1 }} />

        {/* Status */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px" }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.green, boxShadow: `0 0 6px ${C.green}40` }} />
          <span style={{ fontFamily: mono, fontSize: 11, color: C.dim }}>Mainnet · Live</span>
        </div>
      </div>

      {/* ── MAIN CONTENT ── */}
      <div style={{ marginLeft: SIDEBAR_W }}>

        {/* TOP BAR — search + clock */}
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 20px",
            height: 48,
            background: `${C.bg}ee`,
            backdropFilter: "blur(16px)",
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <span style={{ fontFamily: heading, fontSize: 20, fontWeight: 400 }}>
            {TOOLS.find((t) => t.id === activeTool)?.label || ""}
          </span>

          {/* Search bar — only visible for scan tools */}
          {isScanView && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                background: C.surface,
                border: `1px solid ${inputShake ? C.red : C.border}`,
                borderRadius: 7,
                overflow: "hidden",
                width: 420,
                animation: inputShake ? "shake 0.4s ease-out" : scanning ? "scanPulse 2s ease-in-out infinite" : "none",
                transition: "border-color 0.2s",
              }}
            >
              <button
                onClick={() => {
                  if (scanning) return;
                  navigateTo(inputMode === "TOKEN" ? "wallet" : "token");
                }}
                style={{
                  padding: "0 12px",
                  height: 34,
                  background: "rgba(255,255,255,0.025)",
                  border: "none",
                  borderRight: `1px solid ${C.border}`,
                  cursor: scanning ? "default" : "pointer",
                  fontFamily: mono,
                  fontSize: 11,
                  color: C.sub,
                  letterSpacing: "0.06em",
                  minWidth: 66,
                }}
              >
                {inputMode}
              </button>
              <input
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doScan()}
                placeholder={inputMode === "TOKEN" ? "Token mint..." : "Wallet address..."}
                disabled={scanning}
                style={{
                  flex: 1,
                  padding: "0 12px",
                  height: 34,
                  background: "transparent",
                  border: "none",
                  color: C.text,
                  fontFamily: mono,
                  fontSize: 12,
                }}
              />
              <button
                onClick={() => doScan()}
                disabled={scanning}
                style={{
                  padding: "0 16px",
                  height: 34,
                  background: scanning ? "rgba(255,255,255,0.05)" : C.text,
                  border: "none",
                  cursor: scanning ? "default" : "pointer",
                  fontFamily: mono,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  color: scanning ? C.sub : C.bg,
                  transition: `all 0.25s ${EASE}`,
                }}
              >
                {scanning ? "···" : "SCAN"}
              </button>
            </div>
          )}

          <span style={{ fontFamily: mono, fontSize: 11, color: C.dim }}>
            {time.toLocaleTimeString("en-US", { hour12: false })}
          </span>
        </div>

        {/* CONTENT */}
        <div style={{ padding: "12px 16px" }}>
        {/* ── SCAN VIEW ── */}
        {isScanView && (
          <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 28px" }}>
            {/* Hero — only when the active tool has no result yet */}
            {!scanning && !error && (isTokenScan ? !result : !walletResult) && (
              <div style={{ paddingTop: 140, paddingBottom: 80, animation: "fadeIn 0.8s ease-out" }}>
                <div
                  style={{
                    fontFamily: mono,
                    fontSize: 11,
                    color: C.green,
                    letterSpacing: "0.15em",
                    marginBottom: 20,
                  }}
                >
                  <TypeWriter text="CRYPTO ENTITY CLASSIFICATION SYSTEM" speed={22} />
                </div>
                <h1
                  style={{
                    fontFamily: heading,
                    fontSize: "clamp(56px, 9vw, 96px)",
                    fontWeight: 400,
                    lineHeight: 0.95,
                    letterSpacing: "-0.02em",
                    marginBottom: 28,
                    maxWidth: 750,
                  }}
                >
                  See who's
                  <br />
                  <span style={{ color: C.green }}>really</span> in it.
                </h1>
                <p
                  style={{
                    fontFamily: mono,
                    fontSize: 14,
                    color: C.dim,
                    lineHeight: 1.7,
                    maxWidth: 560,
                    marginBottom: 56,
                  }}
                >
                  Paste a token or wallet address. CryptOSINT classifies every wallet — agents,
                  insiders, copy traders, snipers, and the humans left holding the bag. One
                  number tells you the truth.
                </p>
              </div>
            )}

            {/* Scanning progress */}
            {scanning && (
              <div style={{ maxWidth: 400, margin: "40px auto", textAlign: "center" }}>
                <div style={{ fontFamily: mono, fontSize: 13, color: C.sub, marginBottom: 10 }}>
                  {scanPhase}
                </div>
                <div style={{ width: "100%", height: 2, background: C.ghost, borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: C.text, borderRadius: 2, width: `${scanProgress}%`, transition: `width 0.8s ${EASE}` }} />
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div
                style={{
                  margin: "20px 0",
                  padding: "14px 18px",
                  background: C.redDim,
                  border: `1px solid ${C.red}20`,
                  borderRadius: 8,
                  fontFamily: mono,
                  fontSize: 13,
                  color: C.red,
                }}
              >
                {error}
              </div>
            )}

            {/* Results — Frost card layout */}
            {isTokenScan && result && (
              <div style={{ animation: "fadeIn 0.5s ease-out", paddingBottom: 40 }}>
                <Frost>
                  {/* Token header */}
                  <div style={{ padding: "14px 20px 10px", display: "flex", alignItems: "baseline", gap: 10 }}>
                    <span style={{ fontFamily: sans, fontSize: 20, fontWeight: 700 }}>${result.token.symbol}</span>
                    <span style={{ fontFamily: mono, fontSize: 13, color: C.dim }}>{result.token.name || truncAddr(result.token.mint)}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: mono, fontSize: 12, color: C.dim }}>
                      {result.token.age} · {result.token.totalHolders} holders
                    </span>
                    <button
                      onClick={toggleWatch}
                      disabled={watchLoading}
                      style={{
                        background: watching ? C.greenDim : "none",
                        border: `1px solid ${watching ? C.green + "40" : C.border}`,
                        borderRadius: 4,
                        padding: "4px 12px",
                        cursor: watchLoading ? "default" : "pointer",
                        fontFamily: mono,
                        fontSize: 10,
                        letterSpacing: "0.08em",
                        color: watching ? C.green : C.dim,
                        transition: "all 0.15s",
                      }}
                    >
                      {watchLoading ? "..." : watching ? "WATCHING" : "WATCH"}
                    </button>
                    <ExportButton onClick={() => exportScanResult("token", result, result.token.symbol)} />
                  </div>

                  <div style={{ height: 1, background: C.border }} />

                  {/* Donut + counts + verdict row */}
                  <div style={{ display: "flex" }}>
                    {/* Donut + classification counts */}
                    <div style={{ padding: "14px 20px", display: "flex", alignItems: "center", gap: 14, borderRight: `1px solid ${C.border}` }}>
                      <div style={{ position: "relative" }}>
                        <Donut data={result.counts} />
                        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", textAlign: "center" }}>
                          <div style={{ fontFamily: sans, fontSize: 18, fontWeight: 700, lineHeight: 1, color: result.organicScore < 30 ? C.red : C.text }}>
                            {result.organicScore}%
                          </div>
                          <div style={{ fontFamily: mono, fontSize: 8, color: C.dim, letterSpacing: "0.08em" }}>ORGANIC</div>
                        </div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {(Object.entries(result.counts) as [WalletType, number][]).map(([type, count]) => (
                          <div key={type} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontFamily: mono, fontSize: 11, color: C.dim, minWidth: 54 }}>{type}</span>
                            <span style={{ fontFamily: sans, fontSize: 14, fontWeight: 600, minWidth: 20 }}>{count}</span>
                            <div style={{ height: 2, width: 40, background: C.ghost, borderRadius: 1 }}>
                              <div style={{ height: "100%", borderRadius: 1, width: `${result.token.totalHolders > 0 ? (count / result.token.totalHolders) * 100 : 0}%`, background: type === "INSIDER" ? C.red : "rgba(255,255,255,0.35)" }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Verdict */}
                    <div style={{ padding: "14px 20px", flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                        <SeverityDot severity={result.verdict.severity} />
                        <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: result.verdict.severity === "CRITICAL" ? C.red : C.sub }}>
                          {result.verdict.severity} RISK
                        </span>
                      </div>
                      <p style={{ fontFamily: mono, fontSize: 12, color: C.sub, lineHeight: 1.7 }}>
                        {result.verdict.summary}
                      </p>
                    </div>
                  </div>

                  <div style={{ height: 1, background: C.border }} />

                  {/* Wallet table header */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "110px 80px 40px 80px 68px 44px 1fr",
                      padding: "7px 20px",
                      background: "rgba(255,255,255,0.01)",
                      fontFamily: mono,
                      fontSize: 11,
                      color: C.dim,
                      letterSpacing: "0.06em",
                    }}
                  >
                    <span>WALLET</span>
                    <span>TYPE</span>
                    <span>REP</span>
                    <span>PNL</span>
                    <span>SUPPLY</span>
                    <span>BLK</span>
                    <span>SIGNATURE</span>
                  </div>

                  {/* Wallet rows */}
                  {result.wallets.map((w: ClassifiedWallet, i: number) => (
                    <div key={w.address} style={{ animation: `staggerIn 0.3s ${EASE} ${i * 30}ms both` }}>
                      <HoverRow gridCols="110px 80px 40px 80px 68px 44px 1fr" onClick={() => handleWalletClick(w.address)}>
                        <span style={{ color: C.text }}>{truncAddr(w.address)}</span>
                        <span><Tag danger={w.type === "INSIDER"}>{w.type}</Tag></span>
                        <span
                          title={w.reputation ? `${w.reputation.grade}\n${w.reputation.factors.join("\n")}` : "No history"}
                          style={{ color: w.reputation && w.reputation.score >= 81 ? C.red : C.ghost, fontWeight: w.reputation && w.reputation.score >= 56 ? 700 : 400, cursor: w.reputation ? "help" : "default" }}
                        >
                          {w.reputation ? w.reputation.score : "—"}
                        </span>
                        <span style={{ color: pnlColor(w.pnlSol), fontWeight: 500 }}>
                          {fmtPnl(w.pnlSol)}
                        </span>
                        <span style={{ color: C.sub }}>{w.supplyPercent.toFixed(2)}%</span>
                        <span style={{ color: w.entryBlock <= 3 ? C.text : C.dim }}>#{w.entryBlock}</span>
                        <span style={{ fontSize: 11, color: C.dim }}>{w.tag || "—"}</span>
                      </HoverRow>
                    </div>
                  ))}
                </Frost>

                {/* Copy Network — below the main card */}
                {result.copyNetwork && result.copyNetwork.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <CopyNetworkPanel
                      relationships={result.copyNetwork}
                      onWalletClick={handleWalletClick}
                    />
                  </div>
                )}

                {/* Graph toggle */}
                <div style={{ marginTop: 16 }}>
                  <button
                    onClick={() => setShowGraph((v) => !v)}
                    style={{
                      background: showGraph ? C.greenDim : "none",
                      border: `1px solid ${showGraph ? C.green + "40" : C.border}`,
                      borderRadius: 4,
                      padding: "8px 18px",
                      cursor: "pointer",
                      fontFamily: mono,
                      fontSize: 11,
                      letterSpacing: "0.08em",
                      color: showGraph ? C.green : C.dim,
                      transition: "all 0.2s",
                    }}
                  >
                    {showGraph ? "HIDE GRAPH" : "VIEW GRAPH"}
                  </button>
                  {showGraph && tokenGraphData && (
                    <div style={{ marginTop: 14 }}>
                      <GraphPanel
                        nodes={tokenGraphData.nodes}
                        edges={tokenGraphData.edges}
                        onNodeClick={handleWalletClick}
                        onClose={() => setShowGraph(false)}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Wallet results */}
            {isWalletScan && walletResult && (
              <WalletResults result={walletResult} onWalletClick={handleWalletClick} />
            )}

            {/* Feature cards — empty state */}
            {!scanning && !error && (isTokenScan ? !result : !walletResult) && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: 12,
                  marginTop: 48,
                }}
              >
                {[
                  { label: "WALLET FORENSICS", desc: "Classify every holder by behavior pattern", delay: 0 },
                  { label: "AGENT DETECTION", desc: "Identify AI-driven trading bots by cadence", delay: 60 },
                  { label: "BUNDLE ANALYSIS", desc: "Expose coordinated launch buying clusters", delay: 120 },
                  { label: "COPY TRADE MAPPING", desc: "Find wallets tailing insider addresses", delay: 180 },
                ].map((item) => (
                  <Frost
                    key={item.label}
                    style={{
                      padding: "20px 24px",
                      animation: `staggerIn 0.4s ${EASE} ${item.delay}ms both`,
                    }}
                  >
                    <div style={{ fontFamily: mono, fontSize: 10, color: C.green, letterSpacing: "0.12em", marginBottom: 8 }}>
                      {item.label}
                    </div>
                    <div style={{ fontFamily: mono, fontSize: 13, color: C.dim, lineHeight: 1.5 }}>
                      {item.desc}
                    </div>
                  </Frost>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── REPLAY VIEW ── */}
        {activeTool === "replay" && (
          <div style={{ animation: "fadeIn 0.4s ease-out" }}>
            {/* Replay input bar */}
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  display: "flex",
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 7,
                  overflow: "hidden",
                  animation: replayScanning ? "scanPulse 2s ease-in-out infinite" : "none",
                }}
              >
                <input
                  value={replayInput}
                  onChange={(e) => setReplayInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && doReplay()}
                  placeholder="Paste rugged token mint..."
                  disabled={replayScanning}
                  style={{ flex: 1, padding: "0 12px", height: 34, background: "transparent", border: "none", color: C.text, fontFamily: mono, fontSize: 12 }}
                />
                <button
                  onClick={doReplay}
                  disabled={replayScanning}
                  style={{
                    padding: "0 16px", height: 34,
                    background: replayScanning ? "rgba(255,255,255,0.05)" : C.text,
                    border: "none", cursor: replayScanning ? "default" : "pointer",
                    fontFamily: mono, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em",
                    color: replayScanning ? C.sub : C.bg, transition: `all 0.25s ${EASE}`,
                  }}
                >
                  {replayScanning ? "···" : "REPLAY"}
                </button>
              </div>
            </div>

            {/* Scanning progress */}
            {replayScanning && (
              <div style={{ maxWidth: 400, margin: "40px auto", textAlign: "center" }}>
                <div style={{ fontFamily: mono, fontSize: 13, color: C.sub, marginBottom: 10 }}>{replayPhase}</div>
                <div style={{ width: "100%", height: 2, background: C.ghost, borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: C.text, borderRadius: 2, width: `${replayProgress}%`, transition: `width 0.8s ${EASE}` }} />
                </div>
              </div>
            )}

            {/* Error */}
            {replayError && (
              <div style={{ margin: "20px 0", padding: "14px 18px", background: C.redDim, border: `1px solid ${C.red}20`, borderRadius: 8, fontFamily: mono, fontSize: 13, color: C.red }}>
                {replayError}
              </div>
            )}

            {/* Results */}
            {replayResult && (
              <ReplayView result={replayResult} onWalletClick={handleWalletClick} />
            )}
          </div>
        )}

        {/* ── BOARD VIEW ── */}
        {activeTool === "board" && (
          <LeaderboardView onWalletClick={handleWalletClick} />
        )}

        {/* ── THREATS VIEW ── */}
        {activeTool === "threats" && (
          <div style={{ animation: "fadeIn 0.4s ease-out" }}>
            <Frost>
              {/* Header */}
              <div style={{ padding: "14px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontFamily: mono, fontSize: 11, color: C.dim, letterSpacing: "0.08em", marginBottom: 2 }}>
                    LIVE THREAT FEED
                  </div>
                  <span style={{ fontFamily: sans, fontSize: 18, fontWeight: 700 }}>
                    Agent-Driven Attacks
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <SeverityDot severity={threats.length > 0 ? "CRITICAL" : "LOW"} />
                  <span style={{ fontFamily: mono, fontSize: 11, color: C.dim }}>
                    {threatsLoading ? "POLLING" : "MONITORING"}
                  </span>
                </div>
              </div>

              <div style={{ height: 1, background: C.border }} />

              {/* Empty state */}
              {threats.length === 0 && !threatsLoading && (
                <div style={{ padding: "48px 20px", textAlign: "center" }}>
                  <div style={{ fontFamily: mono, fontSize: 13, color: C.dim, marginBottom: 8 }}>
                    No threats detected yet.
                  </div>
                  <div style={{ fontFamily: mono, fontSize: 11, color: C.ghost }}>
                    Scan a token first — monitored tokens appear here when LP events are detected.
                  </div>
                </div>
              )}

              {/* Threat rows */}
              {threats.map((threat, i) => (
                <div key={threat.id} style={{ animation: `staggerIn 0.3s ${EASE} ${i * 30}ms both` }}>
                  <ThreatRow
                    threat={threat}
                    onWalletClick={handleWalletClick}
                    formatTime={formatThreatTime}
                  />
                </div>
              ))}
            </Frost>
          </div>
        )}

        {/* ── EXPORT VIEW ── */}
        {activeTool === "export" && (
          <Frost style={{ padding: "36px 40px", textAlign: "center", maxWidth: 400, margin: "40px auto" }}>
            <div style={{ fontFamily: mono, fontSize: 12, color: C.dim, letterSpacing: "0.1em", marginBottom: 10 }}>
              EXPORT
            </div>
            <div style={{ fontFamily: sans, fontSize: 18, fontWeight: 600, marginBottom: 16 }}>
              Download Last Scan
            </div>
            {result ? (
              <button
                onClick={() => exportScanResult("token", result, result.token.symbol)}
                style={{
                  padding: "10px 24px", background: C.text, border: "none", borderRadius: 6,
                  cursor: "pointer", fontFamily: mono, fontSize: 12, fontWeight: 600,
                  letterSpacing: "0.06em", color: C.bg, transition: `all 0.2s ${EASE}`,
                }}
              >
                EXPORT TOKEN SCAN
              </button>
            ) : walletResult ? (
              <button
                onClick={() => exportScanResult("wallet", walletResult, walletResult.wallet.address.slice(0, 8))}
                style={{
                  padding: "10px 24px", background: C.text, border: "none", borderRadius: 6,
                  cursor: "pointer", fontFamily: mono, fontSize: 12, fontWeight: 600,
                  letterSpacing: "0.06em", color: C.bg, transition: `all 0.2s ${EASE}`,
                }}
              >
                EXPORT WALLET SCAN
              </button>
            ) : (
              <p style={{ fontFamily: mono, fontSize: 12, color: C.sub, lineHeight: 1.6 }}>
                Run a scan first — export will be available after results load.
              </p>
            )}
          </Frost>
        )}

        {/* ── COMING SOON — unreleased tools ── */}
        {(["lp", "copy", "rep", "alerts"] as ToolId[]).map((id) => (
          activeTool === id ? (
            <ComingSoon key={id} label={TOOLS.find((t) => t.id === id)?.label || id} />
          ) : null
        ))}

        </div>{/* end content padding */}
      </div>{/* end main content */}
    </div>
  );
}
