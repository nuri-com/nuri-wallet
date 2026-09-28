// Internal shared types used by both prod-tier and debug-tier arkade code.
import type { Wallet } from "@arkade-os/sdk";
// The retired `@arkade-os/boltz-swap` package is gone. Live code only reaches
// through this object for the wallet/identity (to open a signing scope) and
// calls `getLimits`/`dispose` defensively, so it is described structurally
// rather than dragging the dead package back in for a type.
type RetiredArkadeSwapManager = {
  wallet?: unknown;
  identity?: unknown;
  getLimits?: () => Promise<unknown>;
  dispose?: () => Promise<void> | void;
};
import type { ArkadeWalletSummary } from "../types/wallet";

export type ArkadeWallet = Wallet;
export type ArkadeLightning = RetiredArkadeSwapManager;

export type ArkadeWalletDebugTrace = {
  atMs: number;
  op: string;
  status: string;
  id?: string;
  detail?: string;
};

export type ArkadeOutgoingPayTrace = {
  opId: string;
  paymentHash: string;
  requestKind: string;
  requestedTarget: string;
  amountSats: number;
  startedAtMs: number;
  swapId?: string;
  finalStatus?: string;
};

export type ArkadeRecoveryCsvStatus = Pick<
  ArkadeWalletSummary,
  | "recoveryCsvStatus"
  | "recoveryCsvArkadeLabel"
  | "recoveryCsvNuriServerLabel"
  | "recoveryCsvDetail"
>;

export type ArkadeDebugBalance = {
  boarding?: {
    confirmed?: number;
    unconfirmed?: number;
    total?: number;
  };
  settled?: number;
  preconfirmed?: number;
  /** Settled, but still inside the server's min expiry gap — not spendable yet. */
  tooFresh?: number;
  available?: number;
  recoverable?: number;
  total?: number;
};
