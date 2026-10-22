// lib/send/scannedSend.ts
// One scan's way to the amount screen (#1783). Everything it waits for (an ENS
// name, the Nuri-user check) runs inside the scanner session the scan started
// in: when the scanner closed or reopened meanwhile, the scan is over and
// nothing is routed. Pure: the session, the check and the routing are injected.

export type ScannedSendResult =
  | { kind: "stale" }
  | { kind: "refused"; message: string }
  | { kind: "unroutable" }
  | { kind: "routed" };

export async function scannedSend<R>(
  /** The recipient, or how to find it (a refusal message when it cannot be). */
  recipient: R | (() => Promise<R | string>),
  deps: {
    /** The scanner session now; each open and close starts a new one. */
    session: () => number;
    /** The send rules (a plain 0x... only for a Nuri user): the recipient, or why not. */
    check: (recipient: R) => Promise<R | string>;
    /** Opens the amount screen; false when no balance can pay. */
    route: (recipient: R) => boolean;
  },
): Promise<ScannedSendResult> {
  const session = deps.session();
  const current = () => deps.session() === session;
  const found =
    typeof recipient === "function" ? await (recipient as () => Promise<R | string>)() : recipient;
  if (!current()) return { kind: "stale" };
  if (typeof found === "string") return { kind: "refused", message: found };
  const checked = await deps.check(found);
  if (!current()) return { kind: "stale" };
  if (typeof checked === "string") return { kind: "refused", message: checked };
  return deps.route(checked) ? { kind: "routed" } : { kind: "unroutable" };
}
