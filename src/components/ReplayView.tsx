/**
 * Rug Replay view: Frost card with timeline, summary stats, wallet breakdown.
 */

import { useState } from "react";
import type {
  ReplayResult,
  TimelineEvent,
  TimelineEventType,
  WalletType,
  RugMethod,
} from "../lib/types";
import {
  C,
  mono,
  sans,
  EASE,
  ExportButton,
  Frost,
  Tag,
  HoverRow,
  truncAddr,
} from "./shared";
import { exportScanResult } from "../lib/export";

const EVENT_DOT_COLOR: Record<TimelineEventType, string> = {
  CREATION: C.text,
  INSIDER_BUY: C.red,
  BOT_ENTRY: C.sub,
  SNIPER_ENTRY: C.sub,
  ORGANIC_BUY: C.green,
  LARGE_SELL: C.red,
  LP_REMOVE: C.red,
  MASS_DUMP: C.red,
};

const EVENT_LABELS: Record<TimelineEventType, string> = {
  CREATION: "CREATION",
  INSIDER_BUY: "INSIDER BUY",
  BOT_ENTRY: "BOT ENTRY",
  SNIPER_ENTRY: "SNIPER",
  ORGANIC_BUY: "ORGANIC",
  LARGE_SELL: "LARGE SELL",
  LP_REMOVE: "LP REMOVED",
  MASS_DUMP: "MASS DUMP",
};

const RUG_METHOD_LABELS: Record<RugMethod, string> = {
  LP_PULL: "LP PULL",
  MASS_DUMP: "MASS DUMP",
  SELL_TAX: "SELL TAX",
  UNKNOWN: "UNKNOWN",
};

const SELL_EVENTS = new Set<TimelineEventType>(["LARGE_SELL", "LP_REMOVE", "MASS_DUMP"]);

interface ReplayViewProps {
  result: ReplayResult;
  onWalletClick: (address: string) => void;
}

export default function ReplayView({ result, onWalletClick }: ReplayViewProps) {
  const method = result.summary.rugMethod;
  const types: WalletType[] = ["INSIDER", "AGENT", "SNIPER", "COPY", "ORGANIC"];
  const totalWallets = types.reduce((s, t) => s + result.walletBreakdown[t], 0);

  return (
    <div style={{ animation: "fadeIn 0.5s ease-out", paddingBottom: 40 }}>
      <Frost>
        {/* Header */}
        <div style={{ padding: "14px 20px 10px", display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontFamily: sans, fontSize: 20, fontWeight: 700 }}>${result.token.symbol}</span>
          <span style={{ fontFamily: mono, fontSize: 13, color: C.dim }}>{truncAddr(result.token.mint)}</span>
          <Tag danger={method === "LP_PULL" || method === "MASS_DUMP"}>{RUG_METHOD_LABELS[method]}</Tag>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: mono, fontSize: 12, color: C.dim }}>
            {result.summary.lifespan} · {result.timeline.length} events
          </span>
          <ExportButton onClick={() => exportScanResult("replay", result, result.token.symbol)} />
        </div>

        <div style={{ height: 1, background: C.border }} />

        {/* Summary stats row */}
        <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
          {[
            { l: "PEAK HOLDERS", v: String(result.summary.peakHolders) },
            { l: "ORGANIC LOSS", v: `${result.summary.organicLossEstimate.toFixed(1)} SOL`, color: C.red },
            { l: "INSIDER PROFIT", v: `${result.summary.insiderProfitEstimate.toFixed(1)} SOL`, color: C.green },
          ].map((s, i) => (
            <div key={s.l} style={{ flex: 1, padding: "12px 20px", borderRight: i < 2 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ fontFamily: mono, fontSize: 11, color: C.dim, letterSpacing: "0.08em", marginBottom: 4 }}>{s.l}</div>
              <div style={{ fontFamily: sans, fontSize: 22, fontWeight: 700, lineHeight: 1, color: s.color || C.text }}>{s.v}</div>
            </div>
          ))}
        </div>

        {/* Timeline */}
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontFamily: mono, fontSize: 11, color: C.dim, letterSpacing: "0.08em", marginBottom: 14 }}>TIMELINE</div>
          <div style={{ position: "relative", paddingLeft: 28 }}>
            {/* Vertical line */}
            <div style={{ position: "absolute", left: 8, top: 0, bottom: 0, width: 2, background: "rgba(255,255,255,0.06)" }} />
            {result.timeline.map((event, i) => (
              <TimelineNode
                key={`${event.timestamp}-${event.type}-${i}`}
                event={event}
                index={i}
                onWalletClick={onWalletClick}
              />
            ))}
          </div>
        </div>

        {/* Wallet breakdown */}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${types.length}, 1fr)` }}>
          {types.map((type, i) => (
            <div key={type} style={{ padding: "12px 20px", borderRight: i < types.length - 1 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ fontFamily: mono, fontSize: 11, color: C.dim, letterSpacing: "0.08em", marginBottom: 4 }}>{type}</div>
              <div style={{ fontFamily: sans, fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{result.walletBreakdown[type]}</div>
              <div style={{ fontFamily: mono, fontSize: 10, color: C.dim, marginTop: 4 }}>
                {totalWallets > 0 ? `${Math.round((result.walletBreakdown[type] / totalWallets) * 100)}%` : "0%"}
              </div>
            </div>
          ))}
        </div>
      </Frost>
    </div>
  );
}

function TimelineNode({ event, index, onWalletClick }: { event: TimelineEvent; index: number; onWalletClick: (addr: string) => void }) {
  const [hovered, setHovered] = useState(false);
  const dotColor = EVENT_DOT_COLOR[event.type];
  const isSell = SELL_EVENTS.has(event.type);

  return (
    <div style={{ position: "relative", paddingBottom: 16, paddingLeft: 20, animation: `staggerIn 0.3s ${EASE} ${index * 30}ms both` }}>
      {/* Dot */}
      <div
        style={{
          position: "absolute", left: -22, top: 4, width: 10, height: 10, borderRadius: "50%",
          background: dotColor, boxShadow: isSell ? `0 0 10px ${dotColor}60` : "none", border: `2px solid ${C.bg}`,
        }}
      />
      {/* Content */}
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          padding: "8px 12px",
          background: hovered ? "rgba(255,255,255,0.015)" : "transparent",
          borderRadius: 6,
          transition: "background 0.15s",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontFamily: mono, fontSize: 10, color: C.ghost }}>{event.relativeTime}</span>
          <span style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: dotColor }}>
            {EVENT_LABELS[event.type]}
          </span>
          {event.wallet && (
            <>
              <span
                onClick={() => event.wallet && onWalletClick(event.wallet)}
                style={{ fontFamily: mono, fontSize: 11, color: hovered ? C.green : C.text, cursor: "pointer", transition: "color 0.15s" }}
              >
                {truncAddr(event.wallet)}
              </span>
              <Tag danger={event.walletType === "INSIDER"}>{event.walletType}</Tag>
            </>
          )}
          {event.amountSol != null && (
            <span style={{ fontFamily: mono, fontSize: 10, color: isSell ? C.red : C.green }}>
              {event.amountSol.toFixed(1)} SOL
            </span>
          )}
        </div>
        <div style={{ fontFamily: mono, fontSize: 12, color: C.dim, lineHeight: 1.5 }}>{event.detail}</div>
      </div>
    </div>
  );
}
