export { parseQr } from "./universalQrParser";
export { resolveActions } from "./actionResolver";
export {
  isProtocolEnabled,
  setProtocolEnabled,
  getProtocolForType,
} from "./protocolRegistry";
export type { QrParseResult, SuggestedAction } from "./types";
export type { ProtocolId, ProtocolConfig } from "./protocolRegistry";

export function extractAddressFromQR(raw: string): string {
  const value = String(raw || "").trim();
  return value;
}
