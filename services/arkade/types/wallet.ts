// Prod-tier arkade wallet types.

export type ArkadeWalletSummary = {
  arkAddress: string;
  boardingAddress: string;
  balanceTotalSats: string;
  balanceBoardingConfirmedSats: string;
  balanceBoardingUnconfirmedSats: string;
  balanceBoardingTotalSats: string;
  balanceAvailableSats: string;
  balanceSettledSats: string;
  /** Settled, but inside the server's min-expiry gap: it cannot be used as a
   * SETTLEMENT input (offboard, re-settle) and can be spent offchain like any
   * other settled VTXO. */
  balanceTooFreshSats: string;
  balancePreconfirmedSats: string;
  balanceRecoverableSats: string;
  balanceAvailableLabel: string;
  balanceSettledLabel: string;
  balancePreconfirmedLabel: string;
  balanceNote: string;
  recoveryCsvStatus: "matched" | "mismatch" | "missing" | "unknown";
  recoveryCsvArkadeLabel: string;
  recoveryCsvNuriServerLabel: string;
  recoveryCsvDetail: string;
  debugVtxoCount: number;
  debugVtxoSettledCount: number;
  debugVtxoPreconfirmedCount: number;
  debugVtxoRecoverableCount: number;
  debugVtxoTotalSats: string;
  debugVtxoAvailableSats: string;
  debugVtxoDetails: string[];
  debugPendingVtxoCount: number;
  debugPendingVtxoTotalSats: string;
  debugPendingVtxoDetails: string[];
  contractDiagnosticsStatus: "ok" | "warning" | "not_checked";
  contractDiagnosticsLine: string;
};

export type ArkadeWalletSummaryOptions = {
  scheduleAutoClaim?: boolean;
  scheduleAutoRecover?: boolean;
  scheduleAutoSettle?: boolean;
  scheduleAutoBoardingSweep?: boolean;
  /**
   * Bypass the cooldown that normally short-circuits repeat calls within
   * WALLET_SUMMARY_MIN_INTERVAL_MS. Use only when the caller has signal that
   * state actually changed (event-driven), not for polling.
   */
  forceFresh?: boolean;
};
