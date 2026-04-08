/**
 * Shared design system components, constants, and utilities.
 * Monochrome palette with Outfit + JetBrains Mono fonts.
 * Frosted glass aesthetic — minimal color, white on black.
 */

import { useState, useEffect } from "react";
import type { WalletType } from "../lib/types";

// ── Design tokens ──

export const C = {
  bg: "#08090c",
  surface: "rgba(255,255,255,0.025)",
  surfaceHov: "rgba(255,255,255,0.04)",
  border: "rgba(255,255,255,0.06)",
  borderHov: "rgba(255,255,255,0.12)",
  text: "#f0f0f0",
  sub: "rgba(255,255,255,0.55)",
  dim: "rgba(255,255,255,0.3)",
  ghost: "rgba(255,255,255,0.12)",
  accent: "rgba(255,255,255,0.08)",
  green: "#00e87b",
  greenDim: "rgba(0,232,123,0.08)",
  red: "#ff3b5c",
  redDim: "rgba(255,59,92,0.08)",
};

export const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Monochrome type config — only INSIDER gets red, rest are neutral. */
export const TYPE_CONFIG: Record<WalletType, { color: string; bg: string }> = {
  INSIDER: { color: C.red, bg: C.redDim },
  AGENT: { color: C.sub, bg: C.accent },
  SNIPER: { color: C.sub, bg: C.accent },
  COPY: { color: C.sub, bg: C.accent },
  ORGANIC: { color: C.sub, bg: C.accent },
};

export const mono = "'JetBrains Mono', monospace";
export const sans = "'Voltaire', sans-serif";
/** Londrina Solid — used for wordmarks, hero headings, and tool labels. */
export const heading = "'Londrina Solid', sans-serif";
/** @deprecated Use `sans` instead. Kept for compatibility during migration. */
export const display = sans;

export const GLOBAL_CSS = `
  @keyframes blink { 50% { opacity: 0; } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @keyframes slideIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes staggerIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes barFill { from { width: 0%; } }
  @keyframes scanPulse {
    0% { box-shadow: 0 0 0 0 rgba(255,255,255,0.03); }
    50% { box-shadow: 0 0 24px 0 rgba(255,255,255,0.015); }
    100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.03); }
  }
  @keyframes scanGlow {
    0% { box-shadow: 0 0 0 0 rgba(255,255,255,0.03); }
    50% { box-shadow: 0 0 24px 0 rgba(255,255,255,0.015); }
    100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.03); }
  }
`;

// ── Utilities ──

export function truncAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : addr;
}

export function severityColor(s: string): string {
  if (s === "CRITICAL") return C.red;
  if (s === "HIGH") return "rgba(255,255,255,0.45)";
  if (s === "MEDIUM") return "rgba(255,255,255,0.2)";
  return C.green;
}

export function pnlColor(n: number): string {
  return n >= 0 ? C.green : C.red;
}

export function fmtPnl(n: number): string {
  return n >= 0 ? `+$${n.toLocaleString()}` : `-$${Math.abs(n).toLocaleString()}`;
}

/** SVG donut chart showing wallet type composition. */
export function Donut({ data, size = 80 }: { data: Record<string, number>; size?: number }) {
  const total = Object.values(data).reduce((a, b) => a + b, 0);
  if (!total) return null;
  const OPS: Record<string, number> = { INSIDER: 1, AGENT: 0.7, SNIPER: 0.5, COPY: 0.3, ORGANIC: 0.15 };
  const GAP = 0.006;
  let cum = 0;
  const r = size / 2 - 5;
  const cx = size / 2;
  const cy = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={5} />
      {Object.entries(data)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => {
          const s = cum / total + GAP;
          cum += v;
          const e = cum / total - GAP;
          if (e <= s) return null;
          const la = e - s > 0.5 ? 1 : 0;
          const x1 = cx + r * Math.cos(2 * Math.PI * s - Math.PI / 2);
          const y1 = cy + r * Math.sin(2 * Math.PI * s - Math.PI / 2);
          const x2 = cx + r * Math.cos(2 * Math.PI * e - Math.PI / 2);
          const y2 = cy + r * Math.sin(2 * Math.PI * e - Math.PI / 2);
          return (
            <path
              key={k}
              d={`M ${x1} ${y1} A ${r} ${r} 0 ${la} 1 ${x2} ${y2}`}
              fill="none"
              stroke={`rgba(255,255,255,${OPS[k] ?? 0.15})`}
              strokeWidth={5}
              strokeLinecap="round"
            />
          );
        })}
    </svg>
  );
}

// ── Components ──

/** Frosted glass container — the primary card surface. */
export function Frost({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.018)",
        backdropFilter: "blur(40px) saturate(1.1)",
        WebkitBackdropFilter: "blur(40px) saturate(1.1)",
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Monochrome tag badge — danger variant (red) only for INSIDER type. */
export function Tag({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        fontSize: 11,
        fontFamily: mono,
        fontWeight: 500,
        letterSpacing: "0.05em",
        color: danger ? C.red : C.sub,
        background: danger ? C.redDim : C.accent,
        border: `1px solid ${danger ? C.red + "20" : "rgba(255,255,255,0.06)"}`,
        borderRadius: 4,
      }}
    >
      {children}
    </span>
  );
}

/** Badge for wallet type — uses Tag internally. */
export function Badge({ type }: { type: WalletType }) {
  return <Tag danger={type === "INSIDER"}>{type}</Tag>;
}

export function SeverityDot({ severity }: { severity: string }) {
  const color = severity === "CRITICAL" ? C.red : severity === "HIGH" ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.2)";
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        boxShadow: severity === "CRITICAL" ? `0 0 8px ${C.red}50` : "none",
        animation: severity === "CRITICAL" ? "pulse 1.5s ease-in-out infinite" : "none",
      }}
    />
  );
}

export function GlowBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div style={{ width: "100%", height: 2, background: C.ghost, borderRadius: 2, overflow: "hidden" }}>
      <div
        style={{
          width: `${percent}%`,
          height: "100%",
          background: color,
          borderRadius: 2,
          transition: `width 1s ${EASE}`,
        }}
      />
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  color = C.text,
  large,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  large?: boolean;
}) {
  return (
    <Frost style={{ flex: 1, minWidth: large ? 220 : 140, padding: large ? "24px 28px" : "16px 20px", borderRadius: 12 }}>
      <div
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: C.dim,
          letterSpacing: "0.1em",
          marginBottom: 10,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: sans,
          fontSize: large ? 48 : 28,
          fontWeight: 700,
          color,
          lineHeight: 1,
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontFamily: mono, fontSize: 11, color: C.dim, marginTop: 8 }}>{sub}</div>
      )}
    </Frost>
  );
}

export function TypeWriter({ text, speed = 35, delay = 0 }: { text: string; speed?: number; delay?: number }) {
  const [displayed, setDisplayed] = useState("");
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  useEffect(() => {
    if (!started) return;
    let i = 0;
    const interval = setInterval(() => {
      if (i < text.length) {
        setDisplayed(text.slice(0, i + 1));
        i++;
      } else clearInterval(interval);
    }, speed);
    return () => clearInterval(interval);
  }, [started, text, speed]);

  return (
    <>
      {displayed}
      <span style={{ opacity: started && displayed.length < text.length ? 1 : 0, animation: "blink 1s step-end infinite" }}>
        ▌
      </span>
    </>
  );
}

export function ExportButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: "none",
        border: `1px solid ${hovered ? C.borderHov : C.border}`,
        borderRadius: 4,
        padding: "6px 16px",
        cursor: "pointer",
        fontFamily: mono,
        fontSize: 10,
        letterSpacing: "0.1em",
        color: hovered ? C.text : C.dim,
        transition: `all 0.15s ${EASE}`,
      }}
    >
      EXPORT
    </button>
  );
}

/** Animated view wrapper — fades in when show becomes true. */
export function AnimatedView({ show, children }: { show: boolean; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (show) {
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    } else {
      setVisible(false);
    }
  }, [show]);

  if (!show) return null;
  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(6px)",
        transition: `opacity 0.3s ${EASE}, transform 0.3s ${EASE}`,
      }}
    >
      {children}
    </div>
  );
}

/** Hoverable table row with grid layout. */
export function HoverRow({ children, gridCols, onClick }: { children: React.ReactNode; gridCols: string; onClick?: () => void }) {
  const [h, setH] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: "grid",
        gridTemplateColumns: gridCols,
        padding: "8px 20px",
        alignItems: "center",
        background: h ? "rgba(255,255,255,0.015)" : "transparent",
        borderBottom: "1px solid rgba(255,255,255,0.03)",
        cursor: onClick ? "pointer" : "default",
        transition: "background 0.15s",
        fontFamily: mono,
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

/** Coming soon placeholder for unreleased tools. */
export function ComingSoon({ label }: { label: string }) {
  return (
    <div style={{ padding: "80px 20px", textAlign: "center" }}>
      <Frost style={{ padding: "36px 40px", display: "inline-block" }}>
        <div style={{ fontFamily: mono, fontSize: 12, color: C.dim, letterSpacing: "0.1em", marginBottom: 6 }}>
          COMING SOON
        </div>
        <div style={{ fontFamily: sans, fontSize: 20, fontWeight: 600 }}>{label}</div>
        <p style={{ fontFamily: mono, fontSize: 12, color: C.sub, marginTop: 10, lineHeight: 1.6 }}>
          This module is in development.
        </p>
      </Frost>
    </div>
  );
}
