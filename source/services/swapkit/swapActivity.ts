// Which activity rows are legs of a swap. SwapKit lists every order of this
// wallet with the transactions its ledger recorded (funding, settlement,
// refund); a row whose transaction is one of them is named after the other
// side of that swap ("From Bitcoin", "To Euro") instead of an anonymous wallet.
import { useEffect, useState } from "react";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { t } from "../../lib/i18n";
import { getSwapKitV2RecoveryKey } from "./SwapKitV2RecoveryKey";
import { listSwapKitV2Orders } from "./SwapKitV2Service";

export type SwapLeg = { role: "funding" | "settlement" | "refund"; from: string; to: string };

const txKey = (hash: string) => hash.trim().toLowerCase().replace(/^0x/, "");

let legs: Map<string, SwapLeg> | null = null;
let loading: Promise<Map<string, SwapLeg>> | null = null;

async function loadSwapLegs(): Promise<Map<string, SwapLeg>> {
  const owner = await getEthereumAddress().catch((): null => null);
  const recoveryKey = await getSwapKitV2RecoveryKey().catch((): null => null);
  const map = new Map<string, SwapLeg>();
  if (!owner || !recoveryKey) return map;
  const listed = await listSwapKitV2Orders({ owner, recoveryKey });
  for (const order of listed.orders ?? []) {
    const accepted = (order.accepted ?? {}) as { from?: unknown; to?: unknown };
    const tx = (order.transactions ?? {}) as Record<string, unknown>;
    const from = String(accepted.from ?? "");
    const to = String(accepted.to ?? "");
    for (const role of ["funding", "settlement", "refund"] as const) {
      const hash = tx[role];
      if (typeof hash === "string" && hash) map.set(txKey(hash), { role, from, to });
    }
  }
  return map;
}

/** The swap legs of this wallet, loaded once per app run (a failed load is retried next mount). */
export function useSwapLegs(): Map<string, SwapLeg> {
  const [value, setValue] = useState<Map<string, SwapLeg>>(() => legs ?? new Map());
  useEffect(() => {
    let live = true;
    loading ??= loadSwapLegs()
      .then((map) => {
        legs = map;
        return map;
      })
      .catch(() => {
        loading = null;
        return legs ?? new Map<string, SwapLeg>();
      });
    void loading.then((map) => {
      if (live) setValue(map);
    });
    return () => {
      live = false;
    };
  }, []);
  return value;
}

export function swapLegFor(legs: Map<string, SwapLeg>, hash: string | null | undefined) {
  return hash ? (legs.get(txKey(hash)) ?? null) : null;
}

/** The asset as the home names it: Bitcoin, Euro, Dollar, or its ticker. */
function assetName(id: string): string {
  if (/^BTC(_|$)/.test(id)) return t("screen.HomeScreen.railBitcoin");
  if (id === "EURC_BASE") return t("screen.HomeScreen.railEuro");
  if (id === "USDC_BASE") return t("screen.HomeScreen.railDollar");
  return id.split(/[_@]/)[0] || id;
}

/** The other side of the swap this row belongs to: where money came from or went to. */
export function swapCounterpartName(leg: SwapLeg): string {
  // Money out funds the swap: it went TO what the swap buys. Money in is its
  // payout: it came FROM what the swap sold. A refund comes back from the swap.
  return assetName(leg.role === "funding" ? leg.to : leg.from);
}

/** "From Bitcoin" / "To Euro" for a row that is a leg of a swap, else null. */
export function swapRowTitle(
  legs: Map<string, SwapLeg>,
  hash: string | null | undefined,
  incoming: boolean,
): string | null {
  const leg = swapLegFor(legs, hash);
  return leg ? `${incoming ? "From" : "To"} ${swapCounterpartName(leg)}` : null;
}
