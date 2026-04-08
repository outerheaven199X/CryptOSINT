/**
 * Force-directed funding graph using d3-force rendered as SVG.
 * Shows wallet relationships: deployer/target at center, edges weighted by SOL.
 */

import { useRef, useEffect, useState, useCallback } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { scaleLinear } from "d3-scale";
import type { WalletType } from "../lib/types";
import { C, mono } from "./shared";

// ── Types ──

export interface GraphNode {
  id: string;
  type: WalletType | "DEPLOYER" | "TARGET";
  label: string;
  size: number;
  color: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  amountSol: number;
  label?: string;
}

export interface FundingGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (address: string) => void;
}

// ── Color mapping ──

const DIM_COLORS: Record<string, string> = {
  [C.red]: C.redDim,
  [C.sub]: C.accent,
  [C.sub]: C.accent,
  [C.sub]: C.accent,
  [C.green]: C.greenDim,
  [C.text]: "rgba(255,255,255,0.08)",
};

function dimColor(color: string): string {
  return DIM_COLORS[color] ?? "rgba(255,255,255,0.08)";
}

// ── Simulation node/link types ──

interface SimNode extends SimulationNodeDatum {
  id: string;
  type: GraphNode["type"];
  label: string;
  size: number;
  color: string;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  amountSol: number;
}

// ── Constants ──

const GRAPH_HEIGHT = 500;
const LINK_DISTANCE = 100;
const BODY_STRENGTH = -200;
const MIN_RADIUS = 5;
const MAX_RADIUS = 22;
const MIN_STROKE = 1;
const MAX_STROKE = 4;

// ── Component ──

export default function FundingGraph({ nodes, edges, onNodeClick }: FundingGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const [simLinks, setSimLinks] = useState<SimLink[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: SimNode } | null>(null);
  // Width is tracked via ref only — no state — so ResizeObserver updates
  // don't trigger re-renders or restart the simulation.
  const svgWidthRef = useRef(800);

  // Measure container width
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) svgWidthRef.current = w;
    });
    observer.observe(svg.parentElement!);
    svgWidthRef.current = svg.parentElement!.clientWidth;
    return () => observer.disconnect();
  }, []);

  // Run d3-force simulation — only restarts when nodes/edges change.
  // Width is read from a ref so ResizeObserver updates don't restart the sim.
  useEffect(() => {
    if (nodes.length === 0) return;

    // Read the live DOM width at setup time (most accurate on first render).
    const w = svgRef.current?.parentElement?.clientWidth ?? svgWidthRef.current;

    const simNodeList: SimNode[] = nodes.map((n) => ({
      ...n,
      x: w / 2 + (Math.random() - 0.5) * 100,
      y: GRAPH_HEIGHT / 2 + (Math.random() - 0.5) * 100,
    }));

    const nodeMap = new Map(simNodeList.map((n) => [n.id, n]));
    const simLinkList: SimLink[] = edges
      .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
      .map((e) => ({
        source: nodeMap.get(e.source)!,
        target: nodeMap.get(e.target)!,
        amountSol: e.amountSol,
      }));

    const sim = forceSimulation(simNodeList)
      .force("link", forceLink<SimNode, SimLink>(simLinkList).id((d) => d.id).distance(LINK_DISTANCE))
      .force("charge", forceManyBody().strength(BODY_STRENGTH))
      .force("center", forceCenter(w / 2, GRAPH_HEIGHT / 2))
      .force("collide", forceCollide<SimNode>().radius((d) => radiusScale(d.size) + 4))
      .alpha(0.8)
      .on("tick", () => {
        setSimNodes([...simNodeList]);
        setSimLinks([...simLinkList]);
      });

    return () => { sim.stop(); };
  }, [nodes, edges]); // svgWidth intentionally omitted — read via ref to avoid restart loop

  const radiusScale = useCallback(
    (size: number) => MIN_RADIUS + ((size - 1) / 9) * (MAX_RADIUS - MIN_RADIUS),
    [],
  );

  const maxSol = Math.max(...edges.map((e) => e.amountSol), 0.001);
  const strokeScale = scaleLinear().domain([0, maxSol]).range([MIN_STROKE, MAX_STROKE]).clamp(true);

  const connectedToHovered = new Set<string>();
  if (hoveredId) {
    for (const l of simLinks) {
      const srcId = typeof l.source === "object" ? (l.source as SimNode).id : String(l.source);
      const tgtId = typeof l.target === "object" ? (l.target as SimNode).id : String(l.target);
      if (srcId === hoveredId || tgtId === hoveredId) {
        connectedToHovered.add(srcId);
        connectedToHovered.add(tgtId);
      }
    }
  }

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg
        ref={svgRef}
        width="100%"
        height={GRAPH_HEIGHT}
        style={{ display: "block" }}
      >
        {/* Edges */}
        {simLinks.map((link, i) => {
          const src = link.source as SimNode;
          const tgt = link.target as SimNode;
          const isHighlighted = hoveredId && (connectedToHovered.has(src.id) && connectedToHovered.has(tgt.id));
          return (
            <line
              key={i}
              x1={src.x ?? 0}
              y1={src.y ?? 0}
              x2={tgt.x ?? 0}
              y2={tgt.y ?? 0}
              stroke={C.text}
              strokeWidth={strokeScale(link.amountSol)}
              strokeOpacity={isHighlighted ? 0.6 : 0.15}
              style={{ transition: "stroke-opacity 0.2s" }}
            />
          );
        })}

        {/* Nodes */}
        {simNodes.map((node, i) => {
          const r = radiusScale(node.size);
          const isHovered = hoveredId === node.id;
          const fadeDelay = i * 0.03;
          return (
            <g
              key={node.id}
              style={{
                cursor: "pointer",
                animation: `fadeIn 0.4s ease-out ${fadeDelay}s both`,
              }}
              onClick={() => onNodeClick(node.id)}
              onMouseEnter={() => {
                setHoveredId(node.id);
                setTooltip({ x: (node.x ?? 0) + r + 8, y: (node.y ?? 0) - 10, node });
              }}
              onMouseLeave={() => {
                setHoveredId(null);
                setTooltip(null);
              }}
            >
              <circle
                cx={node.x ?? 0}
                cy={node.y ?? 0}
                r={isHovered ? r + 2 : r}
                fill={dimColor(node.color)}
                stroke={node.color}
                strokeWidth={isHovered ? 2.5 : 1.5}
                style={{ transition: "r 0.15s, stroke-width 0.15s" }}
              />
              <text
                x={node.x ?? 0}
                y={(node.y ?? 0) + r + 12}
                textAnchor="middle"
                fill={C.dim}
                fontSize={9}
                fontFamily={mono}
              >
                {node.label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: "absolute",
            left: tooltip.x,
            top: tooltip.y,
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 3,
            padding: "8px 12px",
            pointerEvents: "none",
            zIndex: 10,
            maxWidth: 280,
          }}
        >
          <div style={{ fontFamily: mono, fontSize: 11, color: C.text, marginBottom: 4, wordBreak: "break-all" }}>
            {tooltip.node.id}
          </div>
          <div style={{ fontFamily: mono, fontSize: 10, color: tooltip.node.color, letterSpacing: "0.08em" }}>
            {tooltip.node.type}
          </div>
        </div>
      )}
    </div>
  );
}
