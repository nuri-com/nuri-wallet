// Refund material sent with the commit (swapkit #421, contract 2.5.0).
//
// An Arkade payment's server order asks the wallet for its refund material (the
// wallet's fixed Arkade refund key plus an opaque ref) before the solver is
// asked for the lockup. Sent with the commit, the server submits it in the same
// request and answers with the funding action: one round trip less before the
// passkey. It is the same material the `arkade_refund_material` action takes;
// when the server does not use it (older contract, or that step failed there),
// the action comes back and the wallet answers it as before.

export type V2RefundMaterial = { senderPublicKey: string; walletKeyRef: string };

/** The contract minor (within major 2) that accepts `refundMaterial` on commit. */
export const SWAPKIT_V2_REFUND_MATERIAL_MINOR = 5;

let materialSource: ((scope: string) => Promise<V2RefundMaterial>) | null = null;

/** The wallet's refund key, derived ahead (when its quote arrives) for one
 *  owner. It is one fixed key per wallet; only the ref carries the commit. */
const WARM_REUSE_MS = 10 * 60_000;
const WARM_SCOPE = "warm";
let warm: { owner: string; at: number; material: Promise<V2RefundMaterial> } | null = null;

/** Derive the refund material ahead for `owner`'s next Arkade commit. Never throws. */
export function warmV2CommitRefundMaterial(owner: string): void {
  if (!materialSource || !owner) return;
  const key = owner.toLowerCase();
  if (warm && warm.owner === key && Date.now() - warm.at < WARM_REUSE_MS) return;
  const material = materialSource(WARM_SCOPE);
  const entry = { owner: key, at: Date.now(), material };
  warm = entry;
  material.catch(() => {
    if (warm === entry) warm = null;
  });
}

/** Registered by the executors module, which owns the wallet's Arkade refund
 * key, so the transport does not pull the wallet modules into every importer. */
export function setV2CommitRefundMaterialSource(
  source: (scope: string) => Promise<V2RefundMaterial>,
): void {
  materialSource = source;
}

/** The material to send with a commit, or null when it should go out without:
 * the order is not an Arkade payment that asks for it, or the wallet cannot
 * derive it now (the action then asks, as before). Scoped to the commit's
 * idempotency key, the one id the wallet has before the order exists. */
export async function v2CommitRefundMaterial(args: {
  from: string;
  owner?: string;
  capabilities?: readonly string[];
  idempotencyKey: string;
}): Promise<V2RefundMaterial | null> {
  if (args.from !== "BTC_ARKADE" || !args.capabilities?.includes("arkade_refund_material"))
    return null;
  if (!materialSource) return null;
  const ahead = warm;
  if (
    ahead &&
    args.owner &&
    ahead.owner === args.owner.toLowerCase() &&
    Date.now() - ahead.at < WARM_REUSE_MS
  ) {
    const material = await ahead.material.catch((): null => null);
    const suffix = `:${WARM_SCOPE}`;
    if (material?.walletKeyRef.endsWith(suffix)) {
      return {
        senderPublicKey: material.senderPublicKey,
        walletKeyRef: `${material.walletKeyRef.slice(0, -suffix.length)}:${args.idempotencyKey}`,
      };
    }
  }
  return materialSource(args.idempotencyKey).catch((): null => null);
}

/** Whether the server's contract accepts `refundMaterial` on commit. */
export function v2AcceptsCommitRefundMaterial(contractVersion: string): boolean {
  const [major, minor] = String(contractVersion || "")
    .split(".")
    .map((part) => Number(part));
  return major === 2 && minor >= SWAPKIT_V2_REFUND_MATERIAL_MINOR;
}
