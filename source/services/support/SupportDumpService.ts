import * as Application from "expo-application";
import * as Localization from "expo-localization";
import { Platform } from "react-native";
import {
  SUPPORT_MAX_LOG_ENTRIES,
  SUPPORT_MAX_LOG_ENTRY_CHARS,
  SUPPORT_MAX_LOG_ENTRY_CHARS_WARN,
  SUPPORT_MAX_LOG_ENTRY_CHARS_ERROR,
  MAX_SUPPORT_DUMP_TEXT_CHARS,
  SUPPORT_RELAY_TIMEOUT_MS,
} from "../../config/constants";
import { authStateManager } from "../auth/AuthStateService";
import { formatPasskeyCeremonyLines } from "../auth/passkeyCeremonyDiagnostics";
import { getNetworkStatus } from "../app/NetworkStatusService";
import { getBufferedLogs } from "../logging/DebugLogBuffer";
import { arkadeServerConfigService } from "../arkade/ArkadeServerConfigService";
import {
  getBitcoinAddress,
  getBitcoinPublicKey,
  getEthereumAddress,
  getEthereumPublicKey,
  getPrivateKey,
  hasAuthKey,
  hasNostrPrivateKey,
  hasStoredKey,
  storeBitcoinPublicKey,
  storeEthereumPublicKey,
} from "../../lib/secureKeyStorage";
import { BALANCE_CACHE_KEYS, getCachedBalance } from "../balance/BalanceCacheService";
import { getArkadeWalletSummarySnapshot } from "../arkade/ArkadeWalletService";
import { getArkadeLnurlStatusSnapshot } from "../arkade/ArkadeLnurlService";
import { wirexAccountService } from "../wirex/WirexAccountService";
import { wirexService } from "../wirex/WirexService";
import {
  createNip04DirectMessage,
  createNip17GiftWrap,
  normalizeNostrPubkey,
  toNpub,
} from "../../lib/nostr/nostr";
import { publishNostrEventToRelays } from "../../lib/nostr/relayPublish";
import { bytesToHex, secp256k1, schnorr, zeroize } from "../../lib/crypto";
import type { BufferedLogEntry } from "../logging/DebugLogBuffer";

export type SupportDumpAppSnapshot = {
  activeTab?: string;
  kycApproved?: boolean;
  isCardAuthed?: boolean;
  hasCard?: boolean | null;
  hasIban?: boolean;
  ethereumAddress?: string;
  bitcoinAddress?: string;
};

export type SupportDumpSendResult = {
  dumpId: string;
  senderNpub: string;
  usedEphemeralNostrKey: boolean;
  relaysTried: number;
  relaysOpened: number;
  relaysAckedOk: number;
  chunksSent: number;
};

type SendProgress = { sent: number; total: number };

import { DEFAULT_NOSTR_RELAYS as DEFAULT_RELAYS } from "../../config/endpoints";
import { SUPPORT_DUMP_PREFIX } from "../../config/constants";

function truncate(text: string, limit: number): string {
  const raw = String(text ?? "");
  if (!raw) return "";
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}...[truncated ${raw.length - limit}]`;
}

const NOISY_LOG_PATTERNS: RegExp[] = [
  /^&platform=/i,
  /^transform\./i,
  /^unstable_transformprofile=/i,
  /^Running 'main' with\b/i,
  /^stop undefined$/i,
  /^Closed$/i,
  /^\[NostrChatModal\]\s+Relay connected\b/i,
  /^\[NostrChatModal\]\s+Relay closed\b/i,
  /^\[NostrChatModal\]\s+Subscribed dm\+giftwrap\b/i,
  /^\[NostrChatModal\]\s+Relay message\b/i,
  /^\[NostrChatModal\]\s+Outbound event snapshot\b/i,
  /^\[NostrChatModal\]\s+Relay send attempt\b/i,
  /^\[NostrChatModal\]\s+Sent encrypted DM\b/i,
  /^\[NostrChatModal\]\s+Relay send summary\b/i,
  /^\[UI\]\s+Press\b/i,
  /^\[UI\]\s+Close\b/i,
  /^\[NetworkStats\]/i,
  /^(?:\S+\s+(DEBUG|INFO|WARN|ERROR|BUG)\s+grp=Network\s+evt=STATS\b|\S+\s+STATS\s+.+\|\s+lvl=(DEBUG|INFO|WARN|ERROR|BUG)\b.*\bevt=STATS\b.*\bgrp=Network\b)/i,
  /^\[ShakeService\]/i,
  /^iOS Bundled\b/i,
  /^Android Bundled\b/i,
];

function isNoisyLogEntry(entry: BufferedLogEntry): boolean {
  if (!entry?.message) return true;
  const msg = String(entry.message);
  return NOISY_LOG_PATTERNS.some((rx) => rx.test(msg));
}

function collapseConsecutiveLogs(entries: BufferedLogEntry[]): BufferedLogEntry[] {
  const out: BufferedLogEntry[] = [];
  let last: BufferedLogEntry | null = null;
  let dupCount = 0;

  const flush = () => {
    if (!last) return;
    const suffix = dupCount > 1 ? ` (x${dupCount})` : "";
    out.push({ ...last, message: `${last.message}${suffix}` });
    last = null;
    dupCount = 0;
  };

  for (const entry of entries) {
    if (!last) {
      last = entry;
      dupCount = 1;
      continue;
    }
    if (entry.level === last.level && entry.message === last.message) {
      dupCount += 1;
      continue;
    }
    flush();
    last = entry;
    dupCount = 1;
  }
  flush();
  return out;
}

function selectLogsForDump(
  raw: BufferedLogEntry[],
  opts: { maxIncluded: number },
): { logs: BufferedLogEntry[]; summary: any } {
  const cleaned = raw.filter((e) => !isNoisyLogEntry(e));
  const errorOrWarnIdx: number[] = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const lvl = cleaned[i]?.level;
    if (lvl === "error" || lvl === "warn") {
      errorOrWarnIdx.push(i);
    }
  }

  const includeIdx = new Set<number>();
  const ctxBefore = 6;
  const ctxAfter = 4;
  for (const idx of errorOrWarnIdx) {
    for (let j = idx - ctxBefore; j <= idx + ctxAfter; j += 1) {
      if (j >= 0 && j < cleaned.length) includeIdx.add(j);
    }
  }

  const tailCount = 60;
  for (let i = Math.max(0, cleaned.length - tailCount); i < cleaned.length; i += 1) {
    includeIdx.add(i);
  }

  const selected = Array.from(includeIdx)
    .sort((a, b) => a - b)
    .map((i) => cleaned[i]);

  const collapsed = collapseConsecutiveLogs(selected);

  const maxIncluded = Math.max(10, Math.floor(opts.maxIncluded));
  if (collapsed.length <= maxIncluded) {
    return {
      logs: collapsed,
      summary: {
        rawCount: raw.length,
        cleanedCount: cleaned.length,
        includedCount: collapsed.length,
        errors: collapsed.filter((l) => l.level === "error").length,
        warns: collapsed.filter((l) => l.level === "warn").length,
      },
    };
  }

  // Prefer errors/warns, then fill with latest remaining context.
  const picked: BufferedLogEntry[] = [];
  const seen = new Set<string>();
  const reversed = [...collapsed].reverse();
  const keyOf = (e: BufferedLogEntry) => `${e.ts}|${e.level}|${e.message}`;
  const add = (e: BufferedLogEntry) => {
    const k = keyOf(e);
    if (seen.has(k)) return;
    picked.push(e);
    seen.add(k);
  };

  for (const e of reversed) {
    if (picked.length >= maxIncluded) break;
    if (e.level === "error" || e.level === "warn") add(e);
  }
  for (const e of reversed) {
    if (picked.length >= maxIncluded) break;
    add(e);
  }

  picked.reverse();
  return {
    logs: picked,
    summary: {
      rawCount: raw.length,
      cleanedCount: cleaned.length,
      includedCount: picked.length,
      errors: picked.filter((l) => l.level === "error").length,
      warns: picked.filter((l) => l.level === "warn").length,
      truncated: true,
    },
  };
}

function newDumpId(): string {
  const a = Math.random().toString(16).slice(2);
  const b = Date.now().toString(16);
  return `${b}-${a}`.slice(0, 24);
}

function safeBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function maskIban(value: string | null | undefined): string | null {
  const normalized = String(value || "")
    .replace(/\s+/g, "")
    .toUpperCase();
  if (!normalized) return null;
  const country = normalized.slice(0, 2);
  const tail = normalized.slice(-4);
  return `${country || "**"}••••${tail}`;
}

function shaLike(input: string): string {
  // Simple non-crypto fingerprint to correlate without leaking raw IDs.
  // We avoid importing a hash here to keep this dump lightweight.
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv:${(h >>> 0).toString(16)}`;
}

function sanitizeAuthState(
  state: any,
  options?: { hasEthereumKey?: boolean; hasBitcoinKey?: boolean },
) {
  const userId = typeof state?.userId === "string" ? state.userId : "";
  const signedInFromKeys = Boolean(options?.hasEthereumKey || options?.hasBitcoinKey);
  return {
    isSignedIn: signedInFromKeys || Boolean(state?.isSignedIn),
    hasPasskey: Boolean(state?.hasPasskey),
    hasCosignerKey: Boolean(state?.hasCosignerKey),
    isRegistered: Boolean(state?.isRegistered),
    userIdFingerprint: userId ? shaLike(userId) : null,
  };
}

function createEphemeralNostrKeypair(): { sk: Uint8Array; pkHex: string; npub: string } {
  const sk = secp256k1.utils.randomSecretKey();
  const pkBytes = schnorr.getPublicKey(sk);
  const pkHex = bytesToHex(pkBytes);
  return { sk, pkHex, npub: toNpub(pkHex) };
}

type DumpProtocol = "giftwrap" | "kind4";

async function sendTextEncrypted(
  recipientHex: string,
  text: string,
  relayUrls: string[],
  sender: { sk: Uint8Array; pkHex: string; npub: string },
  protocol: DumpProtocol,
  senderEmail?: string,
): Promise<{ tried: number; opened: number; ackedOk: number }> {
  const nostrEvent =
    protocol === "kind4"
      ? createNip04DirectMessage(text, recipientHex, sender.sk, senderEmail)
      : createNip17GiftWrap(text, recipientHex, sender.sk, senderEmail);

  if (!relayUrls.some((u) => String(u || "").trim())) {
    throw new Error("No relay URLs configured");
  }

  return await publishNostrEventToRelays(relayUrls, nostrEvent, SUPPORT_RELAY_TIMEOUT_MS);
}

export async function sendSupportDump(opts: {
  supportPubkey: string;
  note?: string;
  // When true, skip deriving uncached pubkeys (avoids the biometric prompt). Sending still works via ephemeral key.
  skipBiometricUnlock?: boolean;
  appSnapshot?: SupportDumpAppSnapshot;
  relayUrls?: string[];
  maxLogEntries?: number;
  onProgress?: (p: SendProgress) => void;
  senderKeypair?: { sk: Uint8Array; pkHex: string; npub: string };
  senderIdentifierOverride?: string;
  // Only set from an explicit "Share Info" action. Automatic error reports
  // stay limited to diagnostics and public wallet identifiers.
  includePersonalData?: boolean;
}): Promise<SupportDumpSendResult> {
  const supportHex = normalizeNostrPubkey(opts.supportPubkey);
  if (!supportHex) {
    throw new Error("Support pubkey invalid");
  }

  const dumpId = newDumpId();
  const createdAtIso = new Date().toISOString();

  try {
    console.log("[SupportDump] Starting", { dumpId, createdAt: createdAtIso });
  } catch {}

  const [hasEthKey, hasBtcKey, hasNostrKey, hasAuthKeyPresent] = await Promise.all([
    hasStoredKey("ethereum"),
    hasStoredKey("bitcoin"),
    hasNostrPrivateKey(),
    hasAuthKey(),
  ]);
  const [ethAddress, btcAddress, storedEthPubkey, storedBtcPubkey] = await Promise.all([
    getEthereumAddress(),
    getBitcoinAddress(),
    getEthereumPublicKey(),
    getBitcoinPublicKey(),
  ]);

  const authStateRaw = authStateManager.getState();

  let ethEoaPubkey: string | null = storedEthPubkey;
  let btcPubkey: string | null = storedBtcPubkey;

  if (!btcPubkey) {
    const userExternal =
      typeof (authStateRaw as any)?.walletPublicKeys?.userExternal === "string"
        ? String((authStateRaw as any).walletPublicKeys.userExternal).trim()
        : "";
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(userExternal)) {
      btcPubkey = userExternal.toLowerCase();
      try {
        await storeBitcoinPublicKey(btcPubkey);
      } catch {}
    }
  }

  if (!opts.skipBiometricUnlock && !ethEoaPubkey && hasEthKey) {
    const ethKeyBytes = await getPrivateKey("ethereum");
    try {
      const pubBytes = secp256k1.getPublicKey(ethKeyBytes, false);
      ethEoaPubkey = `0x${bytesToHex(pubBytes)}`.toLowerCase();
      try {
        await storeEthereumPublicKey(ethEoaPubkey);
      } catch {}
    } finally {
      zeroize(ethKeyBytes);
    }
  }

  if (!opts.skipBiometricUnlock && !btcPubkey && hasBtcKey) {
    const btcKeyBytes = await getPrivateKey("bitcoin");
    try {
      const pubBytes = secp256k1.getPublicKey(btcKeyBytes, true);
      btcPubkey = bytesToHex(pubBytes).toLowerCase();
      try {
        await storeBitcoinPublicKey(btcPubkey);
      } catch {}
    } finally {
      zeroize(btcKeyBytes);
    }
  }
  const authStateSafe = sanitizeAuthState(authStateRaw, {
    hasEthereumKey: hasEthKey,
    hasBitcoinKey: hasBtcKey,
  });
  const network = getNetworkStatus();

  const [cachedCardBalance, cachedWalletBalance, cachedBitcoinBalance] = await Promise.all([
    getCachedBalance(BALANCE_CACHE_KEYS.card),
    getCachedBalance(BALANCE_CACHE_KEYS.wallet),
    getCachedBalance(BALANCE_CACHE_KEYS.bitcoin),
  ]);
  const wirexSnapshot = opts.includePersonalData ? wirexAccountService.getSnapshot() : null;
  const wirexEmail =
    opts.includePersonalData && ethAddress
      ? await wirexService.getOnboardEmail(ethAddress).catch((): null => null)
      : null;

  const maxLogEntries = Math.max(20, Math.floor(opts.maxLogEntries ?? SUPPORT_MAX_LOG_ENTRIES));
  const scanLimit = Math.min(1200, Math.max(250, maxLogEntries * 8));
  const rawLogs = getBufferedLogs({ maxEntries: scanLimit });
  const selected = selectLogsForDump(rawLogs, { maxIncluded: maxLogEntries });
  const logs = selected.logs.map((entry) => {
    const limit =
      entry.level === "error"
        ? SUPPORT_MAX_LOG_ENTRY_CHARS_ERROR
        : entry.level === "warn"
          ? SUPPORT_MAX_LOG_ENTRY_CHARS_WARN
          : SUPPORT_MAX_LOG_ENTRY_CHARS;
    return {
      ts: entry.ts,
      level: entry.level,
      message: truncate(entry.message, limit),
    };
  });

  const dump = {
    type: "nuri_support_dump_v2",
    dumpId,
    createdAt: createdAtIso,
    app: {
      applicationId: Application.applicationId ?? null,
      nativeApplicationVersion: Application.nativeApplicationVersion ?? null,
      nativeBuildVersion: Application.nativeBuildVersion ?? null,
    },
    platform: {
      os: Platform.OS,
      version: String(Platform.Version ?? ""),
      isDev: typeof __DEV__ === "boolean" ? __DEV__ : null,
    },
    locale: {
      locale: (Localization as any).locale ?? null,
      timezone: (Localization as any).timezone ?? null,
      region: (Localization as any).region ?? null,
      is24Hour:
        typeof (Localization as any).is24Hour === "boolean" ? (Localization as any).is24Hour : null,
    },
    network,
    keys: {
      hasEthereumKey: hasEthKey,
      hasBitcoinKey: hasBtcKey,
      hasNostrKey,
      hasAuthKey: hasAuthKeyPresent,
    },
    auth: authStateSafe,
    balances: {
      card: cachedCardBalance,
      wallet: cachedWalletBalance,
      bitcoin: cachedBitcoinBalance,
    },
    ui: {
      activeTab:
        typeof opts.appSnapshot?.activeTab === "string" ? opts.appSnapshot?.activeTab : null,
      kycApproved: safeBool(opts.appSnapshot?.kycApproved),
      isCardAuthed: safeBool(opts.appSnapshot?.isCardAuthed),
      hasCard: typeof opts.appSnapshot?.hasCard === "boolean" ? opts.appSnapshot?.hasCard : null,
      hasIban: safeBool(opts.appSnapshot?.hasIban),
      ethereumAddress:
        typeof opts.appSnapshot?.ethereumAddress === "string"
          ? truncate(opts.appSnapshot.ethereumAddress, 64)
          : null,
      bitcoinAddress:
        typeof opts.appSnapshot?.bitcoinAddress === "string"
          ? truncate(opts.appSnapshot.bitcoinAddress, 128)
          : null,
    },
    logSummary: selected.summary,
    logs,
  };

  const relayUrls = opts.relayUrls && opts.relayUrls.length > 0 ? opts.relayUrls : DEFAULT_RELAYS;

  const usedEphemeralNostrKey = !opts.senderKeypair;
  const sender = opts.senderKeypair ?? createEphemeralNostrKeypair();

  const senderIdentifier = opts.senderIdentifierOverride?.trim() || undefined;

  const safeText = (value: unknown): string => {
    const raw = String(value ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    // Strip most control chars to keep forwarding reliable across clients.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars
    return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  };

  const formatLogTime = (ts: number): string => {
    try {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return "??:??:??";
      return d.toISOString().slice(11, 19);
    } catch {
      return "??:??:??";
    }
  };

  const formatNetwork = () => {
    const type = network?.type ? String(network.type) : "?";
    const conn = network?.isConnected ? "1" : "0";
    const inet =
      typeof network?.isInternetReachable === "boolean"
        ? network.isInternetReachable
          ? "1"
          : "0"
        : "?";
    const off = network?.isOffline ? "1" : "0";
    const wait = network?.isWaitingForNetwork ? "1" : "0";
    const streak = Number.isFinite(network?.failureStreak) ? String(network.failureStreak) : "?";
    return `${type} conn=${conn} inet=${inet} off=${off} wait=${wait} streak=${streak}`;
  };

  const formatBalance = (b: any): string => {
    if (!b || typeof b !== "object") return "?";
    const amt = typeof b.amount === "number" && Number.isFinite(b.amount) ? b.amount : null;
    const cur = typeof b.currency === "string" ? b.currency : "";
    if (amt == null) return "?";
    const rounded = Math.abs(amt) >= 1 ? amt.toFixed(2) : String(amt);
    return `${rounded}${cur ? ` ${cur}` : ""}`;
  };

  const buildDumpText = (): string => {
    const lines: string[] = [];
    const b01 = (value: boolean | null | undefined): string => {
      if (value === null || value === undefined) return "?";
      return value ? "1" : "0";
    };
    lines.push(`${SUPPORT_DUMP_PREFIX} ${dumpId} ${createdAtIso}`);
    if (opts.note?.trim()) {
      lines.push("User note:");
      lines.push(safeText(opts.note.trim()));
    }
    lines.push(
      `App ${dump.app.nativeApplicationVersion || "?"} (${dump.app.nativeBuildVersion || "?"}) ${dump.app.applicationId || "?"}`,
    );
    lines.push(`Nuri cosigner=${truncate(arkadeServerConfigService.getSignerServerUrl(), 200)}`);
    lines.push(
      `Platform ${dump.platform.os} ${dump.platform.version} dev=${dump.platform.isDev ? "1" : "0"}`,
    );
    lines.push(
      `Locale ${dump.locale.locale || "?"} tz=${dump.locale.timezone || "?"} region=${dump.locale.region || "?"} 24h=${dump.locale.is24Hour === null ? "?" : dump.locale.is24Hour ? "1" : "0"}`,
    );
    lines.push(`Network ${formatNetwork()}`);
    lines.push(
      `Auth signedIn=${dump.auth.isSignedIn ? "1" : "0"} registered=${dump.auth.isRegistered ? "1" : "0"} passkey=${dump.auth.hasPasskey ? "1" : "0"} cosignerKey=${dump.auth.hasCosignerKey ? "1" : "0"} authKey=${dump.keys.hasAuthKey ? "1" : "0"} user=${dump.auth.userIdFingerprint || "?"}`,
    );
    lines.push(
      `Keys eth=${dump.keys.hasEthereumKey ? "1" : "0"} btc=${dump.keys.hasBitcoinKey ? "1" : "0"} nostr=${dump.keys.hasNostrKey ? "1" : "0"}`,
    );
    lines.push(
      `UI tab=${dump.ui.activeTab || "?"} kycApproved=${b01(dump.ui.kycApproved)} cardAuthed=${b01(dump.ui.isCardAuthed)} hasCard=${b01(dump.ui.hasCard)} hasIban=${b01(dump.ui.hasIban)}`,
    );

    if (opts.includePersonalData) {
      lines.push("Consent user_initiated_share_info=1");
    }
    if (wirexEmail) {
      lines.push(`User email=${wirexEmail}`);
    }
    if (wirexSnapshot) {
      lines.push(
        `Wirex verification=${wirexSnapshot.verificationStatus || "?"} approved=${b01(wirexSnapshot.isApproved)} rejected=${b01(wirexSnapshot.isRejected)}`,
      );
      if (wirexSnapshot.smartAccountAddress) {
        lines.push(`Address WIREX_SMART_ACCOUNT ${wirexSnapshot.smartAccountAddress}`);
      }
      const maskedIban = maskIban(wirexSnapshot.iban?.iban);
      if (maskedIban) {
        lines.push(
          `Wirex IBAN ${maskedIban} status=${wirexSnapshot.iban?.status || "?"} bic=${wirexSnapshot.iban?.bic || "?"}`,
        );
      }
      if (wirexSnapshot.card) {
        lines.push(
          `Wirex card last4=${wirexSnapshot.card.last4 || "?"} status=${wirexSnapshot.card.status || "?"}`,
        );
      }
    }

    const cosignerPubkey =
      typeof (authStateRaw as any)?.cosignerPubkey === "string"
        ? String((authStateRaw as any).cosignerPubkey).trim()
        : "";
    if (cosignerPubkey) {
      lines.push(`Cosigner pubkey ${cosignerPubkey}`);
    }

    const walletPublicKeys = (authStateRaw as any)?.walletPublicKeys;
    if (walletPublicKeys && typeof walletPublicKeys === "object") {
      const ue =
        typeof walletPublicKeys.userExternal === "string" ? walletPublicKeys.userExternal : "";
      const ui =
        typeof walletPublicKeys.userInternal === "string" ? walletPublicKeys.userInternal : "";
      const ae =
        typeof walletPublicKeys.aggregatedExternal === "string"
          ? walletPublicKeys.aggregatedExternal
          : "";
      const ai =
        typeof walletPublicKeys.aggregatedInternal === "string"
          ? walletPublicKeys.aggregatedInternal
          : "";
      const co = typeof walletPublicKeys.cosigner === "string" ? walletPublicKeys.cosigner : "";
      const credIdLen =
        typeof walletPublicKeys.walletPasskeyCredIdB64u === "string"
          ? walletPublicKeys.walletPasskeyCredIdB64u.length
          : 0;
      const credPubLen =
        typeof walletPublicKeys.walletPasskeyCredPubkeyB64u === "string"
          ? walletPublicKeys.walletPasskeyCredPubkeyB64u.length
          : 0;

      if (ue) lines.push(`Wallet pubkey userExternal ${ue}`);
      if (ui) lines.push(`Wallet pubkey userInternal ${ui}`);
      if (ae) lines.push(`Wallet pubkey aggregatedExternal ${ae}`);
      if (ai) lines.push(`Wallet pubkey aggregatedInternal ${ai}`);
      if (co) lines.push(`Wallet pubkey cosigner ${co}`);
      if (credIdLen || credPubLen) {
        lines.push(`Wallet passkey cred idLen=${credIdLen} pubLen=${credPubLen}`);
      }
      // The ceremony outcome. A blocked restore only posts support text and a
      // ceremony that dies before the platform shows UI reaches no handler, so
      // this is often the only trace a "cannot sign in" report can carry.
      for (const line of formatPasskeyCeremonyLines()) {
        lines.push(line);
      }
    }

    // Addresses help correlate support reports with onchain state.
    const walletAddrRaw = cachedWalletBalance?.address
      ? String(cachedWalletBalance.address).trim()
      : "";
    const cardAddrRaw = cachedCardBalance?.address ? String(cachedCardBalance.address).trim() : "";
    const ethAddr = ethAddress || "?";
    const walletBalAddr = walletAddrRaw || "?";
    const cardBalAddr = cardAddrRaw || "?";

    lines.push(`Address ETH_EOA ${ethAddr}`);
    if (ethEoaPubkey) {
      lines.push(`Pubkey ETH_EOA ${ethEoaPubkey}`);
    }
    lines.push(`Address WalletBalance ${walletBalAddr}`);
    lines.push(`Address CardBalance ${cardBalAddr}`);
    lines.push(`Address BTC ${btcAddress || "?"}`);
    if (btcPubkey) {
      lines.push(`Pubkey BTC ${btcPubkey}`);
    }

    const arkadeSummary = getArkadeWalletSummarySnapshot();
    const arkAddr = arkadeSummary?.arkAddress ? String(arkadeSummary.arkAddress).trim() : "";
    const boardingAddr = arkadeSummary?.boardingAddress
      ? String(arkadeSummary.boardingAddress).trim()
      : "";
    if (arkAddr) lines.push(`Address ARKADE_ARK ${arkAddr}`);
    if (boardingAddr) lines.push(`Address ARKADE_BOARDING ${boardingAddr}`);
    const lnurlStatus = getArkadeLnurlStatusSnapshot();
    const lightningAddress = lnurlStatus?.lightningAddress
      ? String(lnurlStatus.lightningAddress).trim()
      : "";
    const lnurlpUrl = lnurlStatus?.lnurlpUrl ? String(lnurlStatus.lnurlpUrl).trim() : "";
    if (lightningAddress) lines.push(`Lightning address ${lightningAddress}`);
    if (lnurlpUrl) lines.push(`LNURL ${lnurlpUrl}`);

    lines.push(`Nostr sender ${sender.npub} pk=${sender.pkHex}`);

    lines.push(
      `Balances wallet=${formatBalance(cachedWalletBalance)} card=${formatBalance(cachedCardBalance)} btc=${formatBalance(cachedBitcoinBalance)}`,
    );

    const formatLogMessage = (
      entry: { level: string; message: string },
      maxChars: number,
    ): string => {
      const raw = safeText(entry.message || "").trim();
      if (!raw) return "";
      const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const isIssue = entry.level === "error" || entry.level === "warn";
      if (!isIssue) {
        return truncate(normalized.replace(/\s+/g, " ").trim(), Math.max(80, maxChars));
      }

      const linesIn = normalized.split("\n").map((l) => l.replace(/\s+$/g, ""));
      while (linesIn.length > 0 && !linesIn[0].trim()) linesIn.shift();
      while (linesIn.length > 0 && !linesIn[linesIn.length - 1].trim()) linesIn.pop();
      const collapsed: string[] = [];
      for (const line of linesIn) {
        if (!line.trim()) {
          if (collapsed.length > 0 && !collapsed[collapsed.length - 1].trim()) continue;
        }
        collapsed.push(truncate(line, 260));
      }
      return truncate(collapsed.join("\n"), Math.max(160, maxChars));
    };

    const formatLogEntry = (
      entry: { ts: number; level: string; message: string },
      maxChars: number,
    ): string => {
      const lvl = entry.level ? String(entry.level).slice(0, 1).toUpperCase() : "?";
      const prefix = `${formatLogTime(entry.ts)} ${lvl}`;
      const msg = formatLogMessage(entry, maxChars);
      const parts = msg.split("\n");
      if (parts.length <= 1) return `${prefix} ${msg}`;
      return [`${prefix} ${parts[0]}`, ...parts.slice(1).map((l) => `  ${l}`)].join("\n");
    };

    const issueEntries = logs.filter((entry) => entry.level === "error" || entry.level === "warn");
    const recentIssues = issueEntries.slice(-2);
    if (recentIssues.length > 0) {
      lines.push(`Recent issues (${recentIssues.length}/${issueEntries.length}):`);
      recentIssues.forEach((entry) => {
        lines.push(formatLogEntry(entry, 720));
      });
    }

    const logLines = logs.map((entry) =>
      formatLogEntry(entry, entry.level === "error" ? 1200 : entry.level === "warn" ? 900 : 220),
    );

    const header = `${lines.join("\n")}\nLogs ${selected.summary.includedCount}/${selected.summary.cleanedCount}/${selected.summary.rawCount} err=${selected.summary.errors} warn=${selected.summary.warns}:`;

    const max = MAX_SUPPORT_DUMP_TEXT_CHARS;
    if (header.length >= max) {
      return safeText(header.slice(0, max));
    }

    const remaining = max - header.length - 1;
    const picked: string[] = [];
    let used = 0;
    for (let i = logLines.length - 1; i >= 0; i -= 1) {
      const line = logLines[i];
      const next = used === 0 ? line.length : used + 1 + line.length;
      if (next > remaining) break;
      picked.push(line);
      used = next;
    }
    picked.reverse();

    const logBody = picked.join("\n");
    const combined = `${header}\n${logBody}`;
    return safeText(combined);
  };

  const text = buildDumpText();

  let relaysTriedTotal = 0;
  let relaysOpenedMax = 0;
  let relaysAckedOkMax = 0;

  if (opts.onProgress) {
    try {
      opts.onProgress({ sent: 0, total: 1 });
    } catch {}
  }

  const res = await sendTextEncrypted(
    supportHex,
    text,
    relayUrls,
    sender,
    "giftwrap",
    senderIdentifier,
  );
  relaysTriedTotal = Math.max(relaysTriedTotal, res.tried);
  relaysOpenedMax = Math.max(relaysOpenedMax, res.opened);
  relaysAckedOkMax = Math.max(relaysAckedOkMax, res.ackedOk);

  if (opts.onProgress) {
    try {
      opts.onProgress({ sent: 1, total: 1 });
    } catch {}
  }

  if (usedEphemeralNostrKey) {
    try {
      zeroize(sender.sk);
    } catch {}
  }

  try {
    console.log("[SupportDump] Finished", {
      dumpId,
      chunks: 1,
      relaysTried: relaysTriedTotal,
      relaysOpened: relaysOpenedMax,
      relaysAckedOk: relaysAckedOkMax,
      senderNpub: sender.npub,
    });
  } catch {}

  return {
    dumpId,
    senderNpub: sender.npub,
    usedEphemeralNostrKey,
    relaysTried: relaysTriedTotal,
    relaysOpened: relaysOpenedMax,
    relaysAckedOk: relaysAckedOkMax,
    chunksSent: 1,
  };
}
