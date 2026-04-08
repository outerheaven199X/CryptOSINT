/**
 * Client-side JSON export for scan results.
 * Wraps data in a metadata envelope and triggers browser download.
 */

import type { ScanResult, WalletScanResult, ReplayResult } from "./types";

const TOOL_NAME = "CryptOSINT";
const VERSION = "0.3";

type ScanType = "token" | "wallet" | "replay";
type ExportData = ScanResult | WalletScanResult | ReplayResult;

interface ExportEnvelope {
  tool: string;
  version: string;
  exportedAt: string;
  scanType: ScanType;
  result: ExportData;
}

/**
 * Build the filename from scan type and a symbol/address identifier.
 */
function buildFilename(scanType: ScanType, identifier: string): string {
  const safe = identifier.replace(/[^a-zA-Z0-9_-]/g, "");
  return `cryptosint-${scanType}-${safe}-${Date.now()}.json`;
}

/**
 * Trigger a browser download of a JSON file containing the scan result.
 */
export function exportScanResult(
  scanType: ScanType,
  data: ExportData,
  identifier: string,
): void {
  const envelope: ExportEnvelope = {
    tool: TOOL_NAME,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    scanType,
    result: data,
  };

  const json = JSON.stringify(envelope, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = buildFilename(scanType, identifier);
  anchor.click();

  URL.revokeObjectURL(url);
}
