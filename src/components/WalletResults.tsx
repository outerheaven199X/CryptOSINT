/**
 * Renders wallet scan results in a single Frost card:
 * header (address + PNL), stats row, verdict, token table, funding graph.
 */

import { useState } from "react";
import type { WalletScanResult, WalletTokenEntry } from "../lib/types";
import {
  C,
  mono,
  sans,
  EASE,
  SeverityDot,
  ExportButton,
  Frost,
  Tag,
  HoverRow,
  truncAddr,
  pnlColor,
  fmtPnl,
} from "./shared";
import GraphPanel from "./GraphPanel";
import { buildWalletGraph } from "./graphData";
import { exportScanResult } from "../lib/export";

interface WalletResultsProps {
  result: WalletScanResult;
  onWalletClick: (address: string) => void;
}

type SortField = keyof WalletTokenEntry;
type SortDir = "asc" | "desc";

function sortTokens(tokens: WalletTokenEntry[], field: SortField, dir: SortDir): WalletTokenEntry[] {
  return [...tokens].sort((a, b) => {
    const aVal = a[field];
    const bVal = b[field];
    if (typeof aVal === "number" && typeof bVal === "number") {
      return dir === "asc" ? aVal - bVal : bVal - aVal;
    }
    return dir === "asc"
      ? String(aVal).localeCompare(String(bVal))
      : String(bVal).localeCompare(String(aVal));
  });
}

const TOKEN_COLS = "100px 80px 60px 1fr";

export default function WalletResults({ result, onWalletClick }: WalletResultsProps) {
  const [sortField, setSortField] = useState<SortField>("pnlSol");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showGraph, setShowGraph] = useState(false);

  const sorted = sortTokens(result.tokens, sortField, sortDir);

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const pnlPositive = result.wallet.totalPnlSol >= 0;

  return (
    <div style={{ animation: "fadeIn 0.5s ease-out", paddingBottom: 40 }}>
      <Frost>
        {/* Header: address + total PNL */}
        <div style={{ padding: "14px 20px 10px", display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: sans, fontSize: 20, fontWeight: 700 }}>
            {truncAddr(result.wallet.address)}
          </span>
          <span style={{ fontFamily: sans, fontSize: 16, fontWeight: 700, color: pnlColor(result.wallet.totalPnlSol) }}>
            {fmtPnl(result.wallet.totalPnlSol)}
          </span>
          <span style={{ flex: 1 }} />
          <ExportButton onClick={() => exportScanResult("wallet", result, result.wallet.address.slice(0, 8))} />
        </div>

        <div style={{ height: 1, background: C.border }} />

        {/* Stats row */}
        <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
          {[
            { l: "WIN RATE", v: `${result.wallet.winRate}%` },
            { l: "TOKENS", v: String(result.wallet.totalTokensTouched) },
            { l: "FUNDED", v: String(result.associations.fundedWallets.length) },
          ].map((s, i) => (
            <div key={s.l} style={{ flex: 1, padding: "12px 20px", borderRight: i < 2 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ fontFamily: mono, fontSize: 11, color: C.dim, letterSpacing: "0.08em", marginBottom: 4 }}>
                {s.l}
              </div>
              <div style={{ fontFamily: sans, fontSize: 22, fontWeight: 700, lineHeight: 1 }}>
                {s.v}
              </div>
            </div>
          ))}
        </div>

        {/* Verdict */}
        <div
          style={{
            padding: "12px 20px",
            borderBottom: `1px solid ${C.border}`,
            background: result.verdict.severity === "CRITICAL" ? C.redDim : "transparent",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <SeverityDot severity={result.verdict.severity} />
            <span
              style={{
                fontFamily: mono,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.06em",
                color: result.verdict.severity === "CRITICAL" ? C.red : C.sub,
              }}
            >
              {result.verdict.severity} RISK
            </span>
          </div>
          <p style={{ fontFamily: mono, fontSize: 12, color: C.sub, lineHeight: 1.7 }}>
            {result.verdict.summary}
          </p>
        </div>

        {/* Token table header */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: TOKEN_COLS,
            padding: "7px 20px",
            background: "rgba(255,255,255,0.01)",
            fontFamily: mono,
            fontSize: 11,
            color: C.dim,
          }}
        >
          {(
            [
              { label: "TOKEN", field: "symbol" as SortField },
              { label: "TYPE", field: "classification" as SortField },
              { label: "BLK", field: "entryBlock" as SortField },
              { label: "PNL", field: "pnlSol" as SortField },
            ] as const
          ).map((col) => {
            const active = sortField === col.field;
            const arrow = active ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : "";
            return (
              <span
                key={col.field}
                onClick={() => handleSort(col.field)}
                style={{ cursor: "pointer", userSelect: "none", color: active ? C.sub : C.dim }}
              >
                {col.label}{arrow}
              </span>
            );
          })}
        </div>

        {/* Token rows */}
        {sorted.map((t, i) => (
          <div key={t.mint} style={{ animation: `staggerIn 0.3s ${EASE} ${i * 30}ms both` }}>
            <HoverRow gridCols={TOKEN_COLS}>
              <span style={{ fontWeight: 500 }}>${t.symbol}</span>
              <span><Tag danger={t.classification === "INSIDER"}>{t.classification}</Tag></span>
              <span style={{ color: C.dim }}>#{t.entryBlock}</span>
              <span style={{ color: pnlColor(t.pnlSol), fontWeight: 500 }}>{fmtPnl(t.pnlSol)}</span>
            </HoverRow>
          </div>
        ))}

        <div style={{ height: 1, background: C.border }} />

        {/* Funding sections: side by side */}
        <div style={{ display: "flex" }}>
          {[
            { label: "FUNDED BY", data: result.associations.fundingSources },
            { label: "FUNDED", data: result.associations.fundedWallets },
          ].map((sec, si) => (
            <div key={sec.label} style={{ flex: 1, borderRight: si === 0 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ padding: "7px 20px", fontFamily: mono, fontSize: 11, color: C.dim, borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                {sec.label}
              </div>
              {sec.data.length > 0 ? (
                sec.data.map((f) => (
                  <HoverRow key={f.address} gridCols="1fr auto" onClick={() => onWalletClick(f.address)}>
                    <span>{truncAddr(f.address)}</span>
                    <span style={{ color: C.sub }}>{f.amountSol.toFixed(2)} SOL</span>
                  </HoverRow>
                ))
              ) : (
                <div style={{ padding: "8px 20px", fontFamily: mono, fontSize: 11, color: C.ghost }}>
                  None detected
                </div>
              )}
            </div>
          ))}
        </div>
      </Frost>

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
        {showGraph && (
          <div style={{ marginTop: 14 }}>
            <GraphPanel
              {...buildWalletGraph(result)}
              onNodeClick={onWalletClick}
              onClose={() => setShowGraph(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
