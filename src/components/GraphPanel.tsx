/**
 * Slide-down panel wrapper for the FundingGraph.
 * Not a modal — inline panel with close button.
 */

import { C, mono } from "./shared";
import FundingGraph from "./FundingGraph";
import type { GraphNode, GraphEdge } from "./FundingGraph";

interface GraphPanelProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (address: string) => void;
  onClose: () => void;
}

export default function GraphPanel({ nodes, edges, onNodeClick, onClose }: GraphPanelProps) {
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 3,
        overflow: "hidden",
        animation: "slideIn 0.3s ease-out",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 18px",
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        <span style={{ fontFamily: mono, fontSize: 11, color: C.dim, letterSpacing: "0.1em" }}>
          FUNDING GRAPH — {nodes.length} NODES · {edges.length} EDGES
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: `1px solid ${C.border}`,
            borderRadius: 2,
            color: C.dim,
            fontFamily: mono,
            fontSize: 11,
            padding: "4px 10px",
            cursor: "pointer",
            transition: "color 0.15s, border-color 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = C.text;
            e.currentTarget.style.borderColor = C.borderHov;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = C.dim;
            e.currentTarget.style.borderColor = C.border;
          }}
        >
          CLOSE ✕
        </button>
      </div>
      <FundingGraph nodes={nodes} edges={edges} onNodeClick={onNodeClick} />
    </div>
  );
}
