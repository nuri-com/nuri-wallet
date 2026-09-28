export type ArkadeReceiveStageStatus =
  | "idle"
  | "pending"
  | "claimable"
  | "claiming"
  | "awaiting_settlement"
  | "settled"
  | "failed";

export type ArkadeReceiveStageSnapshot = {
  status: ArkadeReceiveStageStatus;
  pendingCount: number;
  claimableCount: number;
  claimedCount: number;
  settledCount: number;
  failedCount: number;
  updatedAtMs: number;
  detail: string;
};
