import type { QrParseResult } from "./types";

export type ProtocolId = "bitcoin" | "lightning" | "bolt12" | "evm" | "sepa" | "caip10";

export type ProtocolConfig = {
  id: ProtocolId;
  enabled: boolean;
  types: QrParseResult["type"][];
};

const protocols: ProtocolConfig[] = [
  { id: "bitcoin", enabled: true, types: ["bitcoin"] },
  {
    id: "lightning",
    enabled: true,
    types: ["lightning-invoice", "lightning-address", "lnurl"],
  },
  // BOLT-12 is parsed but has no send path: the corridor quotes a BOLT-11
  // invoice, so an offer is recognised and refused rather than offered.
  { id: "bolt12", enabled: false, types: ["bolt12-offer"] },
  { id: "evm", enabled: true, types: ["evm"] },
  { id: "sepa", enabled: true, types: ["sepa", "iban"] },
  { id: "caip10", enabled: false, types: ["caip10"] },
];

/**
 * Check if the protocol handling a given QR result type is enabled.
 * Returns false for unknown types.
 */
export function isProtocolEnabled(resultType: QrParseResult["type"]): boolean {
  const config = getProtocolForType(resultType);
  return config?.enabled ?? false;
}

/**
 * Enable or disable a protocol by its ID.
 */
export function setProtocolEnabled(id: ProtocolId, enabled: boolean): void {
  const config = protocols.find((p) => p.id === id);
  if (config) {
    config.enabled = enabled;
  }
}

/**
 * Find the protocol config that handles a given QR result type.
 */
export function getProtocolForType(resultType: QrParseResult["type"]): ProtocolConfig | undefined {
  return protocols.find((p) => p.types.includes(resultType));
}
