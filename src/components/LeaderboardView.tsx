/**
 * Sniper Board: ranks wallets by classification frequency.
 * Type selector toggles between SNIPER, INSIDER, AGENT in a Frost card.
 */

import { useState, useEffect, useCallback } from "react";
import type { WalletType, LeaderboardResult } from "../lib/types";
import {
  C,
  mono,
  sans,
  EASE,
  Frost,
  Tag,
  HoverRow,
  truncAddr,
  pnlColor,
  fmtPnl,
} from "./shared";

interface LeaderboardViewProps {
  onWalletClick: (address: string) => void;
}

const BOARD_TYPES: WalletType[] = ["SNIPER", "INSIDER", "AGENT"];
const FETCH_LIMIT = 50;
const TOP_RANK_COUNT = 3;
const GRID_COLS = "50px 120px 70px 70px 70px 90px 90px";

export default function LeaderboardView({ onWalletClick }: LeaderboardViewProps) {
  const [activeType, setActiveType] = useState<WalletType>("SNIPER");
  const [data, setData] = useState<LeaderboardResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBoard = useCallback(async (type: WalletType) => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/leaderboard?type=${type}&limit=${FETCH_LIMIT}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const result: LeaderboardResult = await res.json();
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load leaderboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBoard(activeType);
  }, [activeType, fetchBoard]);

  return (
    <div style={{ animation: "fadeIn 0.4s ease-out" }}>
      <Frost>
        {/* Header + type selector */}
        <div style={{ padding: "14px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: mono, fontSize: 11, color: C.dim, letterSpacing: "0.08em", marginBottom: 2 }}>
              SNIPER BOARD
            </div>
            <span style={{ fontFamily: sans, fontSize: 18, fontWeight: 700 }}>
              Top {activeType}s
            </span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {BOARD_TYPES.map((type) => (
              <button
                key={type}
                onClick={() => setActiveType(type)}
                style={{
                  padding: "4px 12px",
                  background: activeType === type ? "rgba(255,255,255,0.06)" : "none",
                  border: `1px solid ${activeType === type ? C.border : "transparent"}`,
                  borderRadius: 4,
                  cursor: "pointer",
                  fontFamily: mono,
                  fontSize: 11,
                  letterSpacing: "0.06em",
                  color: activeType === type ? C.text : C.dim,
                  transition: `all 0.15s ${EASE}`,
                }}
              >
                {type}
              </button>
            ))}
          </div>
        </div>

        <div style={{ height: 1, background: C.border }} />

        {/* Loading — key={activeType} forces a fresh element (and fresh animation) on every new fetch */}
        {loading && (
          <div key={activeType} style={{ padding: "40px 20px", textAlign: "center" }}>
            <div style={{ fontFamily: mono, fontSize: 13, color: C.sub }}>LOADING...</div>
            <div style={{ width: 200, height: 2, background: C.ghost, borderRadius: 2, margin: "10px auto", overflow: "hidden" }}>
              <div style={{ height: "100%", background: C.text, borderRadius: 2, width: "60%", animation: `barFill 1.4s ${EASE} forwards` }} />
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ padding: "20px", fontFamily: mono, fontSize: 13, color: C.red }}>{error}</div>
        )}

        {/* Empty state */}
        {data && data.entries.length === 0 && (
          <div style={{ padding: "48px 20px", textAlign: "center" }}>
            <div style={{ fontFamily: mono, fontSize: 13, color: C.dim, marginBottom: 8 }}>
              No {activeType.toLowerCase()} wallets tracked yet.
            </div>
            <div style={{ fontFamily: mono, fontSize: 11, color: C.ghost }}>
              Scan tokens to populate the leaderboard.
            </div>
          </div>
        )}

        {/* Table */}
        {data && data.entries.length > 0 && (
          <>
            {/* Meta */}
            <div style={{ padding: "7px 20px", fontFamily: mono, fontSize: 10, color: C.ghost }}>
              {data.totalWalletsTracked} TRACKED &middot; {data.dataSpan.toUpperCase()}
            </div>

            {/* Header */}
            <div
              style={{
                display: "grid", gridTemplateColumns: GRID_COLS, padding: "7px 20px",
                background: "rgba(255,255,255,0.01)", fontFamily: mono, fontSize: 11,
                color: C.dim, letterSpacing: "0.06em",
              }}
            >
              <span>RANK</span><span>WALLET</span><span>TOKENS</span>
              <span>WIN %</span><span>AVG BLK</span><span>PNL</span><span>SEEN</span>
            </div>

            {/* Rows */}
            {data.entries.map((entry, i) => (
              <div key={entry.address} style={{ animation: `staggerIn 0.3s ${EASE} ${i * 30}ms both` }}>
                <HoverRow gridCols={GRID_COLS} onClick={() => onWalletClick(entry.address)}>
                  <span style={{ color: i < TOP_RANK_COUNT ? C.text : C.dim, fontWeight: i < TOP_RANK_COUNT ? 700 : 400 }}>
                    #{i + 1}
                  </span>
                  <span style={{ color: C.text }}>{truncAddr(entry.address)}</span>
                  <span style={{ fontWeight: 600 }}>{entry.appearances}</span>
                  <span style={{ color: entry.winRate > 60 ? C.green : entry.winRate > 30 ? C.sub : C.red }}>
                    {entry.winRate}%
                  </span>
                  <span style={{ color: entry.avgEntryBlock <= 3 ? C.text : C.dim }}>#{entry.avgEntryBlock}</span>
                  <span style={{ color: pnlColor(entry.totalEstimatedPnlSol), fontWeight: 500 }}>
                    {fmtPnl(entry.totalEstimatedPnlSol)}
                  </span>
                  <span style={{ color: C.ghost, fontSize: 10 }}>{formatLastSeen(entry.lastSeen)}</span>
                </HoverRow>
              </div>
            ))}
          </>
        )}
      </Frost>
    </div>
  );
}

function formatLastSeen(iso: string): string {
  if (!iso) return "—";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
