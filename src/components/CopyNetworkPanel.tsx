/**
 * Copy trade leader → follower relationships in a Frost card.
 */

import { useState } from "react";
import type { CopyRelationship } from "../lib/types";
import { C, mono, sans, EASE, Frost, Tag, truncAddr } from "./shared";

interface CopyNetworkPanelProps {
  relationships: CopyRelationship[];
  onWalletClick: (address: string) => void;
}

/** Group relationships by leader address. */
function groupByLeader(rels: CopyRelationship[]): Map<string, CopyRelationship[]> {
  const groups = new Map<string, CopyRelationship[]>();
  for (const rel of rels) {
    const existing = groups.get(rel.leader) ?? [];
    existing.push(rel);
    groups.set(rel.leader, existing);
  }
  return groups;
}

export default function CopyNetworkPanel({ relationships, onWalletClick }: CopyNetworkPanelProps) {
  const grouped = groupByLeader(relationships);

  return (
    <Frost>
      <div style={{ padding: "14px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontFamily: mono, fontSize: 11, color: C.dim, letterSpacing: "0.08em", marginBottom: 2 }}>
            COPY NETWORK
          </div>
          <span style={{ fontFamily: sans, fontSize: 16, fontWeight: 600 }}>
            {relationships.length} relationship{relationships.length !== 1 ? "s" : ""} detected
          </span>
        </div>
      </div>
      <div style={{ height: 1, background: C.border }} />

      {[...grouped.entries()].map(([leader, followers], gi) => (
        <LeaderGroup
          key={leader}
          leader={leader}
          followers={followers}
          index={gi}
          onWalletClick={onWalletClick}
        />
      ))}
    </Frost>
  );
}

function LeaderGroup({
  leader,
  followers,
  index,
  onWalletClick,
}: {
  leader: string;
  followers: CopyRelationship[];
  index: number;
  onWalletClick: (addr: string) => void;
}) {
  const [hoveredAddr, setHoveredAddr] = useState<string | null>(null);

  return (
    <div
      style={{
        padding: "12px 20px",
        borderBottom: `1px solid ${C.border}`,
        animation: `staggerIn 0.3s ${EASE} ${index * 30}ms both`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <Tag danger>LEADER</Tag>
        <span
          onClick={() => onWalletClick(leader)}
          onMouseEnter={() => setHoveredAddr(leader)}
          onMouseLeave={() => setHoveredAddr(null)}
          style={{
            fontFamily: mono, fontSize: 13, fontWeight: 600,
            color: hoveredAddr === leader ? C.green : C.text,
            cursor: "pointer", transition: "color 0.15s",
          }}
        >
          {truncAddr(leader)}
        </span>
        <span style={{ fontFamily: mono, fontSize: 10, color: C.ghost }}>
          {followers.length} follower{followers.length > 1 ? "s" : ""}
        </span>
      </div>

      {followers.map((rel) => (
        <div
          key={rel.follower}
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0 4px 24px" }}
        >
          <span style={{ fontFamily: mono, fontSize: 12, color: C.ghost }}>→</span>
          <Tag>+{rel.avgDelaySeconds}s</Tag>
          <span
            onClick={() => onWalletClick(rel.follower)}
            onMouseEnter={() => setHoveredAddr(rel.follower)}
            onMouseLeave={() => setHoveredAddr(null)}
            style={{
              fontFamily: mono, fontSize: 13,
              color: hoveredAddr === rel.follower ? C.green : C.text,
              cursor: "pointer", transition: "color 0.15s",
            }}
          >
            {truncAddr(rel.follower)}
          </span>
          {rel.matchCount > 1 && (
            <span style={{ fontFamily: mono, fontSize: 10, color: C.dim }}>
              {rel.matchCount} matches
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
