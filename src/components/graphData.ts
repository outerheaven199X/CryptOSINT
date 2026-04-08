/**
 * Build GraphNode/GraphEdge arrays from scan results for FundingGraph.
 */

import type { ScanResult, WalletScanResult, WalletType } from "../lib/types";
import type { GraphNode, GraphEdge } from "./FundingGraph";
import { C, TYPE_CONFIG, truncAddr } from "./shared";

const TYPE_NODE_COLOR: Record<WalletType, string> = {
  AGENT: C.sub,
  INSIDER: C.red,
  COPY: C.sub,
  SNIPER: C.sub,
  ORGANIC: C.green,
};

const MAX_NODE_SIZE = 10;
const MIN_NODE_SIZE = 2;

/** Build graph from a token scan — deployer at center, funded wallets around it. */
export function buildTokenGraph(result: ScanResult): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const deployer = result.token.deployerAddress;

  nodes.push({
    id: deployer,
    type: "DEPLOYER",
    label: truncAddr(deployer),
    size: MAX_NODE_SIZE,
    color: C.text,
  });

  const maxSupply = Math.max(...result.wallets.map((w) => w.supplyPercent), 1);

  for (const w of result.wallets) {
    if (w.address === deployer) continue;

    const sizeRatio = w.supplyPercent / maxSupply;
    nodes.push({
      id: w.address,
      type: w.type,
      label: truncAddr(w.address),
      size: Math.max(MIN_NODE_SIZE, Math.round(sizeRatio * MAX_NODE_SIZE)),
      color: TYPE_NODE_COLOR[w.type],
    });

    // Edge from deployer to each early-block wallet (insiders, snipers)
    if (w.entryBlock <= 3) {
      edges.push({
        source: deployer,
        target: w.address,
        amountSol: w.supplyPercent,
        label: `${w.supplyPercent.toFixed(2)}%`,
      });
    }
  }

  return { nodes, edges };
}

/** Build graph from a wallet scan — target wallet at center, funding flows in/out. */
export function buildWalletGraph(result: WalletScanResult): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const target = result.wallet.address;

  nodes.push({
    id: target,
    type: "TARGET",
    label: truncAddr(target),
    size: MAX_NODE_SIZE,
    color: C.green,
  });

  const allAmounts = [
    ...result.associations.fundingSources.map((f) => f.amountSol),
    ...result.associations.fundedWallets.map((f) => f.amountSol),
  ];
  const maxAmount = Math.max(...allAmounts, 0.001);

  for (const src of result.associations.fundingSources) {
    const sizeRatio = src.amountSol / maxAmount;
    nodes.push({
      id: src.address,
      type: "ORGANIC",
      label: truncAddr(src.address),
      size: Math.max(MIN_NODE_SIZE, Math.round(sizeRatio * MAX_NODE_SIZE)),
      color: C.dim,
    });
    edges.push({
      source: src.address,
      target,
      amountSol: src.amountSol,
      label: `${src.amountSol.toFixed(4)} SOL`,
    });
  }

  for (const dst of result.associations.fundedWallets) {
    if (nodes.some((n) => n.id === dst.address)) continue;
    const sizeRatio = dst.amountSol / maxAmount;
    nodes.push({
      id: dst.address,
      type: "ORGANIC",
      label: truncAddr(dst.address),
      size: Math.max(MIN_NODE_SIZE, Math.round(sizeRatio * MAX_NODE_SIZE)),
      color: C.dim,
    });
    edges.push({
      source: target,
      target: dst.address,
      amountSol: dst.amountSol,
      label: `${dst.amountSol.toFixed(4)} SOL`,
    });
  }

  return { nodes, edges };
}
