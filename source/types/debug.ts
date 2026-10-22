// Centralized types for debug domain — extracted from screen files

export type DebugTarget = "app" | "wallet" | "card" | "bitcoin";

export type DebugActionItem = {
  target: DebugTarget;
  action: string;
  title: string;
  subtitle: string;
};

export type DebugModalProps = {
  visible: boolean;
  onClose: () => void;
  onRunAction: (target: DebugTarget, action: string) => void;
};

export type DebugArkadeProps = {
  visible: boolean;
  onClose: () => void;
};

export type DebugEoaKeyExportProps = {
  visible: boolean;
  onClose: () => void;
};

/** TEMPORARY — remove with the Satora collab-refund debug tool. */
export type DebugSatoraRefundProps = {
  visible: boolean;
  onClose: () => void;
};

export type DebugWirexWithdrawProps = {
  visible: boolean;
  onClose: () => void;
};

export type DebugRawAccountRotationCreatePayload = {
  prf: Uint8Array;
  credIdB64u: string;
  credPubkeyB64u: string;
};

export type DebugRawAccountRotationAssertionPayload = {
  prf: Uint8Array;
  credIdB64u: string;
  clientDataB64u: string;
  authDataB64u: string;
  sigB64u: string;
};

export type DebugDsReviewProps = {
  visible: boolean;
  onClose: () => void;
};

export type DebugNotificationsProps = {
  visible: boolean;
  onClose: () => void;
};

export type ArkadeUiActionState = {
  kind: "idle" | "running" | "success" | "error";
  label: string | null;
  detail: string | null;
  atMs: number;
};

export type DebugWirexSignUpProps = {
  visible: boolean;
  onClose: () => void;
  walletAddress: string;
};

export type DebugBankTxDumpProps = {
  visible: boolean;
  onClose: () => void;
  walletAddress: string;
};

export type AaPendingCredential = {
  credId: string;
  credPubkey: string;
  source: "native_existing" | "native_created" | "web_existing" | "web_created" | "pending_resume";
  capturedAtMs: number;
};

export type PrfOutput = {
  prfB64u: string;
  prfLen: number;
  prfHashHex: string;
  credIdB64u: string;
  credIdLen: number;
};

export type QrScannerProps = {
  visible: boolean;
  onClose: () => void;
  onResult: (text: string) => void;
  /** If set, only these parsed types are accepted. Mismatches show a message. */
  acceptTypes?: import("../lib/qr/types").QrParseResult["type"][];
  /** Called with the full parsed result when acceptTypes is set and the type matches.
   *  Return a string to show as an error message on the scanner (scanner stays open).
   *  Return undefined/void to close the scanner and proceed. */
  onParsedResult?: (
    result: import("../lib/qr/types").QrParseResult,
  ) => string | undefined | Promise<string | undefined>;
  /** Last chance for raw formats parseQr does not model (chain-prefixed URIs,
   * ENS, bare base58). Return null/undefined = handled (modal closes); a string
   * = reject with the invalid toast. Async resolution is supported. */
  onUnknown?: (raw: string) => string | null | undefined | Promise<string | null | undefined>;
  title?: string;
  pasteLabel?: string;
  /** When set, an empty/unusable clipboard on the paste button falls back to
   *  this (open manual recipient entry) instead of showing an error message. */
  onManualEntry?: () => void;
};
