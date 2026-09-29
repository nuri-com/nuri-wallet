// One emoji per source file — the file's visual identity in the logs.
// You see the emoji, you know which file fired the line. Grep the emoji here or
// in the logs to jump to the owning file.
//
// This is the ONE app-specific file in lib/log. To add a file: give it a NEW,
// unique emoji below. Uniqueness is the whole point — assertUniqueEmojis()
// enforces it at startup. Emojis are themed by domain so logs bundle at a glance.

export const DEFAULT_EMOJI = "🧩"; // shown for any file not registered below

export const FILE_EMOJI: Record<string, string> = {
  // ── Bitcoin / balance ──────────────────────────────────────────────
  "services/bitcoin/BitcoinBalanceStore.ts": "₿",
  "services/bitcoin/BlockchainService.ts": "⛓️",
  "services/bitcoin/WalletService.ts": "🪙",
  "services/bitcoin/BitcoinBootstrapService.ts": "🥾",
  "services/balance/BalanceCacheService.ts": "🧊",
  "services/balance/MultiCurrencyBalanceService.ts": "💰",
  "screens/bitcoin/modals/BitcoinSendScreen.tsx": "📤",
  "screens/bitcoin/modals/BitcoinTransactionsModal.tsx": "📜",

  // ── Arkade (VTXO / receive / swap / signing) ───────────────────────
  "services/arkade/ArkadeReceiveUnlockService.ts": "🔓",
  "services/arkade/internal/signingKeyVault.ts": "👤",
  "services/arkade/ArkadeRemoteIdentity.ts": "🪪",
  "services/arkade/ArkadeApiService.ts": "🛰️",
  "services/arkade/internal/assertionCache.ts": "🎫",
  "services/arkade/internal/walletSummary.ts": "📇",
  "services/arkade/internal/receiveAutoClaim.ts": "📥",
  "services/arkade/internal/receiveAutoSweep.ts": "🧹",
  "services/arkade/internal/receiveAutoRecover.ts": "♻️",
  "services/arkade/internal/reverseSwapClaim.ts": "🔁",
  "services/arkade/internal/resumeLightningClaims.ts": "⚡",
  "services/arkade/internal/lightningHelpers.ts": "💡",
  "services/arkade/ArkadeLightningSendService.ts": "🌩️",
  "services/arkade/ArkadeSendService.ts": "🚀",
  "services/arkade/internal/ArkadeSpendApprovalFlow.ts": "✅",
  "services/arkade/internal/subscriptions.ts": "📡",
  "services/arkade/ArkadeRecoveryBackupService.ts": "💾",
  "services/arkade/ArkadeDeprecatedSignerMigrationService.ts": "🪦",
  "services/arkade/internal/storageAdapter.ts": "🗄️",
  "services/arkade/internal/recoveryDefaults.ts": "🌱",
  "services/arkade/internal/walletPatches.ts": "🩹",
  "services/arkade/internal/walletCache.ts": "🧺",
  "services/arkade/internal/browserApproval.ts": "🌍",
  "services/arkade/internal/logging.ts": "🧵",
  "services/arkade/debug/ArkadeRecoveryAndLabService.ts": "🧪",

  // ── Auth / security / app / logger ─────────────────────────────────
  "services/auth/AuthStateService.ts": "🔐",
  "lib/secureKeyStorage.ts": "🔒",
  "components/BiometricLockModal.tsx": "🫆",
  "services/app/SoftLogoutService.ts": "🚪",
  "services/app/FactoryResetService.ts": "🧨",
  "App.tsx": "🏁",
  "services/logging/NetworkLogger.ts": "📨",

  // ── Card / KYC / IBAN ──────────────────────────────────────────────
  "screens/card/hooks/useCardKyc.ts": "📋",
  "screens/card/hooks/useCardAuth.ts": "🗝️",
  "screens/card/hooks/useCardActions.ts": "🎛️",
  "screens/card/hooks/useCardProvisioning.ts": "🎬",
  "screens/card/hooks/useCardBalance.ts": "💶",
  "screens/card/hooks/useCardUser.ts": "🙋",
  "screens/card/helpers/cardAuthFlows.ts": "🧭",
  "screens/card/modals/CardTopUpWithStablecoinModal.tsx": "🔝",

  // ── Wallet / Wirex / pricing / swap / misc ─────────────────────────
  "services/wirex/WirexService.ts": "💠",
  "services/pricing/FxRateService.ts": "📊",
  "screens/wallet/modals/WalletSendStablecoinModal.tsx": "💸",
  "services/swapkit/StableToBtcSwapService.ts": "🔀",
  "services/swapkit/SwapKitCardTopupService.ts": "🥞",
  "components/NostrChatModal.tsx": "💬",
};

// Basename → emoji, derived once from FILE_EMOJI, for resolving legacy log lines
// that carry a `src=…#fn` or `op=Module.fn` tag instead of a full registered path.
const BASENAME_EMOJI: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [path, emoji] of Object.entries(FILE_EMOJI)) {
    const base = path
      .split("/")
      .pop()
      ?.replace(/\.(tsx?|jsx?)$/, "");
    if (base && !(base in out)) out[base] = emoji;
  }
  return out;
})();

// Resolve a file emoji from a legacy source/op tag ("services/x/Foo.ts#fn",
// "Foo#fn", "Foo.tsx#fn", op "Foo.fn"). Returns null when unknown so the caller
// can fall back to the line's group emoji.
export function emojiForSource(source: string | null | undefined): string | null {
  if (!source) return null;
  let token = source.split("#")[0].split(" ")[0];
  token = token.split("/").pop() ?? token; // basename
  token = token.replace(/:\d+.*$/, ""); // drop :line
  token = token.replace(/\.(tsx|ts|jsx|js)$/i, ""); // drop file extension
  if (token.includes(".")) token = token.split(".")[0]; // op "Module.fn" → Module
  if (!token || token === "index" || token === "bundle" || token === "unknown") return null;
  return BASENAME_EMOJI[token] ?? null;
}

const warnedMissing = new Set<string>();

export function emojiFor(file: string): string {
  const emoji = FILE_EMOJI[file];
  if (emoji) return emoji;
  if (!warnedMissing.has(file)) {
    warnedMissing.add(file);
    // eslint-disable-next-line no-console
    console.warn(`[log] no emoji for "${file}" — add it to lib/log/fileEmoji.ts`);
  }
  return DEFAULT_EMOJI;
}

// Uniqueness is the point. Returns collision descriptions (empty = all unique).
// Call once at startup; log the result.
export function assertUniqueEmojis(): string[] {
  const byEmoji = new Map<string, string[]>();
  for (const [file, emoji] of Object.entries(FILE_EMOJI)) {
    const files = byEmoji.get(emoji) ?? [];
    files.push(file);
    byEmoji.set(emoji, files);
  }
  const collisions: string[] = [];
  for (const [emoji, files] of byEmoji) {
    if (files.length > 1) collisions.push(`${emoji} → ${files.join(", ")}`);
  }
  return collisions;
}
