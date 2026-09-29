import type { QrParseResult, SuggestedAction } from "./types";
import { isProtocolEnabled } from "./protocolRegistry";
import { groupCount } from "../formatting";

/**
 * Given a parsed QR result, return a list of suggested user actions.
 * Actions have placeholder onPress callbacks — wiring happens in a later task.
 */
export function resolveActions(result: QrParseResult): SuggestedAction[] {
  if (result.type === "unknown") return [];

  if (!isProtocolEnabled(result.type)) {
    return [
      {
        label: formatDisabledLabel(result),
        sublabel: "Not yet supported",
        icon: "🚫",
        onPress: () => {},
      },
    ];
  }

  switch (result.type) {
    case "bitcoin":
      return buildBitcoinActions(result);
    case "lightning-invoice":
      return buildLightningInvoiceActions(result);
    case "lightning-address":
      return [
        {
          label: `Pay ${result.address}`,
          icon: "⚡",
          onPress: () => {},
        },
      ];
    case "lnurl":
      return [
        {
          label: "Open LNURL",
          icon: "⚡",
          onPress: () => {},
        },
      ];
    case "evm":
      return buildEvmActions(result);
    case "sepa":
      return buildSepaActions(result);
    case "iban":
      return [
        {
          label: `Send to ${truncate(result.iban, 16)}`,
          icon: "🏦",
          onPress: () => {},
        },
      ];
    case "bolt12-offer":
      return [
        {
          label: "Pay Lightning Offer",
          icon: "⚡",
          onPress: () => {},
        },
      ];
    case "caip10":
      return [
        {
          label: `Send to ${truncate(result.address, 12)}`,
          sublabel: `${result.namespace}:${result.chainRef}`,
          icon: "🔗",
          onPress: () => {},
        },
      ];
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function buildBitcoinActions(result: QrParseResult & { type: "bitcoin" }): SuggestedAction[] {
  const actions: SuggestedAction[] = [
    {
      label: "Send Bitcoin",
      sublabel: truncate(result.address, 12),
      icon: "₿",
      onPress: () => {},
    },
  ];

  if (result.lightning) {
    actions.push({
      label: "Pay via Lightning",
      icon: "⚡",
      onPress: () => {},
    });
  }

  return actions;
}

function buildLightningInvoiceActions(
  result: QrParseResult & { type: "lightning-invoice" },
): SuggestedAction[] {
  const sublabel = result.amountSats != null ? `${groupCount(result.amountSats)} sats` : undefined;

  return [
    {
      label: "Pay Lightning Invoice",
      sublabel,
      icon: "⚡",
      onPress: () => {},
    },
  ];
}

function buildEvmActions(result: QrParseResult & { type: "evm" }): SuggestedAction[] {
  let chainLabel: string | undefined;
  if (result.chainId === 8453) chainLabel = "on Base";
  else if (result.chainId === 1) chainLabel = "on Ethereum";
  else if (result.chainId === 137) chainLabel = "on Polygon";
  else if (result.chainId != null) chainLabel = `on chain ${result.chainId}`;

  return [
    {
      label: "Send",
      sublabel: chainLabel || truncate(result.address, 12),
      icon: "💎",
      onPress: () => {},
    },
  ];
}

function buildSepaActions(result: QrParseResult & { type: "sepa" }): SuggestedAction[] {
  const target = result.name || truncate(result.iban, 16);
  const sublabel =
    result.amount != null ? `${result.amount} ${result.currency || "EUR"}` : undefined;

  return [
    {
      label: `Send EUR to ${target}`,
      sublabel,
      icon: "🏦",
      onPress: () => {},
    },
  ];
}

function formatDisabledLabel(result: QrParseResult): string {
  switch (result.type) {
    case "lightning-invoice":
      return "Lightning invoice detected";
    case "lightning-address":
      return "Lightning address detected";
    case "lnurl":
      return "LNURL detected";
    case "bolt12-offer":
      return "Lightning offer detected";
    case "caip10":
      return "Multi-chain address detected";
    default:
      return "QR code detected";
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const half = Math.floor((maxLen - 3) / 2);
  return `${s.slice(0, half)}...${s.slice(-half)}`;
}
