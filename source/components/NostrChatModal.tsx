// @screen app.support-chat
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatBubble from "./ChatBubble";
import PasskeyWebAuthnPrfView, {
  type PasskeyWebAuthnPrfCreateResult,
} from "./PasskeyWebAuthnPrfView";
import { FlatList, View as RNView, StyleSheet } from "react-native";
import {
  Button,
  ButtonText,
  Footer,
  Header,
  IconButton,
  Text,
  TextField,
  TextFieldButton,
  TextFieldLabel,
  Topbar,
  TopbarContent,
  TopbarTrailing,
  View,
} from "@ds";
import DsSheetHost from "./DsSheetHost";
import { EventBus } from "../services/events/AppEventBusService";
import {
  NOSTR_CONTACT_PROTOCOLS_CACHE_KEY,
  NOSTR_CONTACTS_CACHE_KEY,
  NOSTR_LAST_SEEN_CACHE_KEY,
  NOSTR_MESSAGES_CACHE_KEY,
  NOSTR_LAST_READ_CACHE_KEY,
  NOSTR_PUBKEY_CACHE_KEY,
  NOSTR_SUPPORT_PENDING_EVENTS_CACHE_KEY,
} from "../lib/nostr/storage";
import {
  createNip04DirectMessage,
  createNip17GiftWrap,
  getOrCreateNostrKeypair,
  NOSTR_KINDS,
  normalizeNostrPubkey,
  openNip04DirectMessage,
  openNip17GiftWrap,
  toNpub,
  type NostrEvent,
  type NostrKeypair,
} from "../lib/nostr/nostr";
import { setCachedSupportUnreadCount, getSupportUnreadCount } from "../lib/nostr/unread";
import { getAuthData, getEthereumAddress, storeAuthData } from "../lib/secureKeyStorage";
import { ensureDmRelayListPublished } from "../services/nostr/NostrDmRelayListService";
import { sendSupportDump } from "../services/support/SupportDumpService";
import { requestUserLogout } from "../services/app/UserLogoutService";
import LogoutConfirmSheet from "./LogoutConfirmSheet";
import { logWithId, LOG_EMOJI } from "../lib/OperationLogUtils";
import { t } from "../lib/i18n";
import { getLoadedAppIdentity, JS_RELEASE_VERSION } from "../lib/loadedAppVersion";
import { formatWalletPasskeyLabel } from "../lib/passkeyLabels";
import { PRF_SALT } from "../config/constants";
import { WALLET_RP_ID } from "../config/passkey";
import { bytesToBase64url, normalizePrfOutput } from "../lib/crypto";
import {
  createWalletPasskey,
  isNativePasskeyLoginAvailable,
} from "../services/auth/PasskeyNativeModuleService";
import { V1_WALLET_MIGRATION_LINK } from "../lib/internalLinks";

type ChatMessage = {
  id: string;
  counterparty: string;
  content: string;
  createdAt: number;
  outgoing: boolean;
  senderEmail?: string;
};

type NostrContact = {
  pubkey: string;
  npub: string;
  label: string;
  addedAt: number;
};

type PendingSendState = {
  attemptedRelays: number;
  respondedRelays: Set<string>;
  okCount: number;
  rejectCount: number;
  lastRejectReason: string;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
};

type RelayPublishResult = {
  relayUrl: string;
  opened: boolean;
  ok: boolean;
  reason: string;
};

type ContactProtocol = "giftwrap" | "kind4";

type Props = {
  visible: boolean;
  onClose: () => void;
  supportPubkey: string;
  lockToSupport?: boolean;
  relayUrls?: string[];
  // When set, auto-sends this message once to support after the chat opens.
  autoSendMessage?: string;
  // When set, seeds the composer once after the chat opens. The user reads and
  // sends it themselves — nothing is transmitted until they tap send.
  prefillMessage?: string;
  // Identity to chat as, instead of reading/creating one via secure storage.
  // The blocked-restore path derives it from an in-memory Bitcoin key that is
  // never persisted, so getOrCreateNostrKeypair would find nothing and mint a
  // random identity. Also suppresses the pubkey cache write.
  keypairOverride?: NostrKeypair;
  onCreatePasskey?: (result: PasskeyWebAuthnPrfCreateResult) => void;
  showV1MigrationLink?: boolean;
};

const LOCAL_BACKUP_RELAY = String(process.env.EXPO_PUBLIC_NOSTR_BACKUP_RELAY || "").trim();

import { DEFAULT_NOSTR_RELAYS } from "../config/endpoints";
const DEFAULT_RELAYS = [LOCAL_BACKUP_RELAY, ...DEFAULT_NOSTR_RELAYS].filter(Boolean);

const SUPPORT_CONTACT_LABEL = "Nuri";
const MAX_CACHED_MESSAGES = 21000;
const DIRECT_PUBLISH_TIMEOUT_MS = 9000;
const RELAY_SUBSCRIPTION_WINDOW_SEC = 14 * 24 * 60 * 60;
const RELAY_SUBSCRIPTION_SKEW_SEC = 24 * 60 * 60;
const RELAY_SUBSCRIPTION_LIMIT = 1200;
const DECRYPT_FAILURE_LOG_WINDOW_MS = 30000;
const DECRYPT_FAILURE_LOG_SAMPLE_COUNT = 3;
// TODO: Move chat history to SQLite when message volume grows.
// TODO: Add a Nuri-owned relay for longer retention and reliability.

const toNpubSafe = (hex: string): string | null => {
  try {
    return toNpub(hex);
  } catch {
    return null;
  }
};

const shortHex = (value?: string | null, head = 8, tail = 6): string | null => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.length <= head + tail + 1) return raw;
  return `${raw.slice(0, head)}…${raw.slice(-tail)}`;
};

const relayHost = (url: string): string => {
  const raw = String(url || "").trim();
  if (!raw) return "relay";
  try {
    return new URL(raw).host || raw;
  } catch {
    return raw.replace(/^wss?:\/\//i, "").split("/")[0] || raw;
  }
};

const formatMessageMetaTime = (value: number): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const dateLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const timeLabel = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${dateLabel} ${timeLabel}`;
};

const publishEventToRelay = async (
  relayUrl: string,
  nostrEvent: NostrEvent,
  timeoutMs = DIRECT_PUBLISH_TIMEOUT_MS,
): Promise<RelayPublishResult> => {
  return await new Promise((resolve) => {
    let opened = false;
    let done = false;
    const eventId = String(nostrEvent.id || "").trim();
    const ws = new WebSocket(relayUrl);
    const finalize = (ok: boolean, reason: string) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {}
      resolve({
        relayUrl,
        opened,
        ok,
        reason: String(reason || "").trim(),
      });
    };

    const timer = setTimeout(
      () => {
        finalize(false, "timeout");
      },
      Math.max(1000, timeoutMs),
    );

    ws.onopen = () => {
      opened = true;
      try {
        ws.send(JSON.stringify(["EVENT", nostrEvent]));
      } catch (error: unknown) {
        clearTimeout(timer);
        finalize(false, (error instanceof Error ? error.message : String(error)) || "send-error");
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      finalize(false, "socket-error");
    };

    ws.onclose = () => {
      clearTimeout(timer);
      finalize(false, "closed");
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      const type = parsed[0];
      if (type === "OK") {
        const okId = String(parsed[1] || "");
        if (eventId && okId !== eventId) return;
        const ok = Boolean(parsed[2]);
        const reason = typeof parsed[3] === "string" ? parsed[3] : "";
        clearTimeout(timer);
        finalize(ok, reason);
        return;
      }
      if (type === "NOTICE") {
        const notice = typeof parsed[1] === "string" ? parsed[1] : "relay notice";
        clearTimeout(timer);
        finalize(false, notice);
      }
    };
  });
};

const trimMessages = (items: ChatMessage[]): ChatMessage[] => {
  const ordered = [...items].sort((a, b) => a.createdAt - b.createdAt);
  if (ordered.length <= MAX_CACHED_MESSAGES) return ordered;
  return ordered.slice(ordered.length - MAX_CACHED_MESSAGES);
};

const normalizeCachedMessage = (item: unknown): ChatMessage | null => {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const id = String(record.id || "").trim();
  const counterparty = String(record.counterparty || "").toLowerCase();
  const content = String(record.content ?? "");
  const createdAt = Number(record.createdAt);
  const outgoing = Boolean(record.outgoing);
  const senderEmailRaw = String(record.senderEmail ?? "").trim();
  const senderEmail = senderEmailRaw ? senderEmailRaw : undefined;
  if (!id) return null;
  if (!/^[0-9a-f]{64}$/.test(counterparty)) return null;
  if (!Number.isFinite(createdAt)) return null;
  return { id, counterparty, content, createdAt, outgoing, senderEmail };
};

const NostrChatModal: React.FC<Props> = ({
  visible,
  onClose,
  supportPubkey,
  lockToSupport = false,
  relayUrls,
  autoSendMessage,
  prefillMessage,
  keypairOverride,
  onCreatePasskey,
  showV1MigrationLink,
}) => {
  const [keys, setKeys] = useState<{ sk: Uint8Array; pkHex: string; npub: string } | null>(null);
  const [activeRecipient, setActiveRecipient] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [status, _setStatus] = useState<string | null>(null);
  const [statusTransient, setStatusTransient] = useState(false);
  const setStatus = useCallback((msg: string | null) => {
    _setStatus(msg);
    setStatusTransient(false);
  }, []);
  const setTransientStatus = useCallback((msg: string) => {
    _setStatus(msg);
    setStatusTransient(true);
  }, []);
  const [, setContacts] = useState<NostrContact[]>([]);
  const [_lastSeenByPubkey, setLastSeenByPubkey] = useState<Record<string, number>>({});
  const [lastSeenLoaded, setLastSeenLoaded] = useState(false);
  const [senderEoaAddress, setSenderEoaAddress] = useState<string | null>(null);
  const [supportDumpState, setSupportDumpState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [switchingPasskey, setSwitchingPasskey] = useState(false);
  const [showSwitchPasskeyConfirm, setShowSwitchPasskeyConfirm] = useState(false);
  const [protocolByContact, setProtocolByContact] = useState<Record<string, ContactProtocol>>({});
  const [deliveryByMessageId, setDeliveryByMessageId] = useState<
    Record<string, "pending" | "sent" | "failed">
  >({});
  const [lastReadByCounterparty, setLastReadByCounterparty] = useState<Record<string, number>>({});
  const [lastReadLoaded, setLastReadLoaded] = useState(false);

  const listRef = useRef<FlatList<ChatMessage>>(null);
  const newPasskeyLabel = useMemo(() => formatWalletPasskeyLabel(), []);
  const [nativePasskeyBusy, setNativePasskeyBusy] = useState(false);
  // Android routes passkey creation through the compiled-in native module
  // (same ceremony as login) — the shipped binaries lack WebView WebAuthn, so
  // the in-chat WebView button would report "not supported" there.
  const handleNativeCreatePasskey = useCallback(async () => {
    if (nativePasskeyBusy || !onCreatePasskey) return;
    setStatus(null);
    setNativePasskeyBusy(true);
    try {
      const result = await createWalletPasskey(WALLET_RP_ID, PRF_SALT, newPasskeyLabel);
      const prf = normalizePrfOutput(result.prfB64 || "");
      if (!prf.length) throw new Error("error:passkey_native:empty_prf");
      onCreatePasskey({
        kind: "create",
        prf,
        prfB64u: bytesToBase64url(prf),
        credIdB64u: result.credIdB64u ?? "",
        credPubkeyB64u: result.credPubkeyB64u ?? "",
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setNativePasskeyBusy(false);
    }
  }, [nativePasskeyBusy, onCreatePasskey, newPasskeyLabel, setStatus]);
  const socketsRef = useRef<Map<string, WebSocket>>(new Map());
  const seenIdsRef = useRef<Set<string>>(new Set());
  const pendingSendStateRef = useRef<Map<string, PendingSendState>>(new Map());
  const pendingSendMetaRef = useRef<
    Map<string, { fromHex: string; fromNpub: string; toHex: string; toNpub: string; len: number }>
  >(new Map());
  const initRef = useRef(false);
  const supportDumpResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relayLifecycleLogRef = useRef<Map<string, number>>(new Map());
  const relayEoseSeenRef = useRef<Set<string>>(new Set());
  const decryptFailureLogRef = useRef<
    Map<ContactProtocol, { windowStartMs: number; count: number }>
  >(new Map());

  const supportHex = useMemo(() => normalizeNostrPubkey(supportPubkey), [supportPubkey]);
  const relayList = useMemo(() => {
    const base = relayUrls && relayUrls.length > 0 ? relayUrls : DEFAULT_RELAYS;
    const unique = Array.from(
      new Set([LOCAL_BACKUP_RELAY, ...base].map((url) => String(url || "").trim()).filter(Boolean)),
    );
    return unique;
  }, [relayUrls]);
  const isSupportUser = Boolean(
    keys?.pkHex && supportHex && keys.pkHex.toLowerCase() === supportHex,
  );
  const isOutgoingSupportDump = useCallback((msg: ChatMessage) => {
    return Boolean(
      msg?.outgoing &&
        typeof msg.content === "string" &&
        msg.content.startsWith("NURI_SUPPORT_DUMP_"),
    );
  }, []);

  const unreadCountByCounterparty = useMemo(() => {
    const counts: Record<string, number> = {};
    messages.forEach((message) => {
      if (message.outgoing) return;
      const key = message.counterparty;
      const lastRead = lastReadByCounterparty[key] || 0;
      if (message.createdAt > lastRead) {
        counts[key] = (counts[key] || 0) + 1;
      }
    });
    return counts;
  }, [lastReadByCounterparty, messages]);

  const supportUnreadCount = useMemo(() => {
    if (!supportHex) return 0;
    return unreadCountByCounterparty[supportHex] || 0;
  }, [supportHex, unreadCountByCounterparty]);

  const visibleMessages = useMemo(() => {
    const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
    const cleaned = ordered.filter((msg) => !isOutgoingSupportDump(msg));
    if (lockToSupport) return cleaned;
    if (!activeRecipient) return [];
    return cleaned.filter((msg) => msg.counterparty === activeRecipient);
  }, [activeRecipient, isOutgoingSupportDump, lockToSupport, messages]);

  const scrollToLatest = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated });
    });
  }, []);

  useEffect(() => {
    if (visible) {
      scrollToLatest(false);
    }
  }, [visible, scrollToLatest]);

  const persistContacts = useCallback(async (next: NostrContact[]) => {
    try {
      await storeAuthData(NOSTR_CONTACTS_CACHE_KEY, JSON.stringify(next));
    } catch {
      // Best-effort cache write
    }
  }, []);

  const persistProtocols = useCallback(async (next: Record<string, ContactProtocol>) => {
    try {
      await storeAuthData(NOSTR_CONTACT_PROTOCOLS_CACHE_KEY, JSON.stringify(next));
    } catch {
      // Best-effort cache write
    }
  }, []);

  const markContactProtocol = useCallback(
    (pubkeyHex: string, protocol: ContactProtocol) => {
      const normalized = String(pubkeyHex || "")
        .trim()
        .toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalized)) return;
      setProtocolByContact((prev) => {
        if (prev[normalized] === protocol) return prev;
        const next: Record<string, ContactProtocol> = { ...prev, [normalized]: protocol };
        void persistProtocols(next);
        return next;
      });
    },
    [persistProtocols],
  );

  const markMessageDelivery = useCallback(
    (messageId: string, status: "pending" | "sent" | "failed") => {
      const normalized = String(messageId || "").trim();
      if (!normalized) return;
      setDeliveryByMessageId((prev) => {
        if (prev[normalized] === status) return prev;
        return { ...prev, [normalized]: status };
      });
    },
    [],
  );

  const logDecryptFailure = useCallback(
    (
      protocol: ContactProtocol,
      details: {
        eventId?: string;
        pubkey?: string;
        error?: string;
      },
    ) => {
      const now = Date.now();
      const existing = decryptFailureLogRef.current.get(protocol);
      if (!existing || now - existing.windowStartMs > DECRYPT_FAILURE_LOG_WINDOW_MS) {
        decryptFailureLogRef.current.set(protocol, { windowStartMs: now, count: 1 });
        logWithId(`${LOG_EMOJI.auth} Nostr.inbound`, `decrypt failed ${protocol}`, details, {
          context: "background",
        });
        return;
      }

      existing.count += 1;
      if (existing.count <= DECRYPT_FAILURE_LOG_SAMPLE_COUNT) {
        logWithId(
          `${LOG_EMOJI.auth} Nostr.inbound`,
          `decrypt failed ${protocol}`,
          {
            ...details,
            countInWindow: existing.count,
          },
          { context: "background" },
        );
        return;
      }

      if (existing.count === DECRYPT_FAILURE_LOG_SAMPLE_COUNT + 1) {
        logWithId(
          `${LOG_EMOJI.auth} Nostr.inbound`,
          `decrypt failures muted ${protocol}`,
          {
            windowMs: DECRYPT_FAILURE_LOG_WINDOW_MS,
            sampled: DECRYPT_FAILURE_LOG_SAMPLE_COUNT,
          },
          { context: "background" },
        );
      }
    },
    [],
  );

  const updateLastSeen = useCallback((pubkeyHex: string, createdAtSec: number) => {
    if (!pubkeyHex || !createdAtSec || Number.isNaN(createdAtSec)) return;
    const normalized = pubkeyHex.toLowerCase();
    setLastSeenByPubkey((prev) => {
      const current = typeof prev[normalized] === "number" ? prev[normalized] : 0;
      if (createdAtSec <= current) return prev;
      const next = { ...prev, [normalized]: createdAtSec };
      void storeAuthData(NOSTR_LAST_SEEN_CACHE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateLastRead = useCallback((pubkeyHex: string, createdAtMs: number) => {
    if (!pubkeyHex || !createdAtMs || Number.isNaN(createdAtMs)) return;
    const normalized = pubkeyHex.toLowerCase();
    setLastReadByCounterparty((prev) => {
      const current = typeof prev[normalized] === "number" ? prev[normalized] : 0;
      if (createdAtMs <= current) return prev;
      const next = { ...prev, [normalized]: createdAtMs };
      void storeAuthData(NOSTR_LAST_READ_CACHE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const upsertContact = useCallback(
    (pubkeyHex: string, label?: string) => {
      const npub = toNpubSafe(pubkeyHex);
      if (!npub) return;
      setContacts((prev) => {
        const existingIndex = prev.findIndex((contact) => contact.pubkey === pubkeyHex);
        const next = [...prev];
        if (existingIndex >= 0) {
          const existing = next[existingIndex];
          const nextLabel =
            label?.trim() ||
            existing.label ||
            (npub
              ? t("screen.NostrChatModal.userWithSuffix", { suffix: npub.slice(-5) })
              : existing.label);
          next[existingIndex] = { ...existing, npub, label: nextLabel };
        } else {
          const nextLabel =
            label?.trim() || t("screen.NostrChatModal.userWithSuffix", { suffix: npub.slice(-5) });
          next.push({
            pubkey: pubkeyHex,
            npub,
            label: nextLabel,
            addedAt: Date.now(),
          });
        }
        next.sort((a, b) => b.addedAt - a.addedAt);
        void persistContacts(next);
        return next;
      });
    },
    [persistContacts],
  );

  // Both inbound protocols end the same way: the sender becomes a contact and
  // the decrypted body becomes a message. Only the protocol label differs.
  const acceptOpenedMessage = useCallback(
    (
      protocol: "giftwrap" | "kind4",
      eventId: string,
      opened: { content: string; senderPubkey: string; createdAt: number; senderEmail?: string },
      eventCreatedAt: number | undefined,
    ): boolean => {
      const myPubkey = (keys?.pkHex || "").toLowerCase();
      const sender = opened.senderPubkey.toLowerCase();
      if (sender === myPubkey) return true;
      markContactProtocol(sender, protocol);
      if (supportHex && sender === supportHex) {
        upsertContact(sender, SUPPORT_CONTACT_LABEL);
      } else {
        upsertContact(sender, opened.senderEmail);
      }
      const createdAt = (opened.createdAt || eventCreatedAt || 0) * 1000;
      setMessages((prev) =>
        trimMessages([
          ...prev,
          {
            id: eventId,
            counterparty: sender,
            content: opened.content,
            createdAt,
            outgoing: false,
            senderEmail: opened.senderEmail,
          },
        ]),
      );
      return true;
    },
    [keys, markContactProtocol, supportHex, upsertContact],
  );

  const handleIncomingNostrEvent = useCallback(
    (event: NostrEvent): boolean => {
      const logSkip = (reason: string, extra?: Record<string, unknown>) => {
        if (reason === "duplicate-event") return;
        logWithId(
          `${LOG_EMOJI.auth} Nostr.inbound`,
          `skip ${reason}`,
          {
            kind: Number(event.kind),
            eventId: shortHex(String(event.id || ""), 8, 6),
            pubkey: shortHex(String(event.pubkey || ""), 8, 6),
            ...(extra || {}),
          },
          { context: "background" },
        );
      };
      if (!keys || !event || !event.pubkey) {
        logSkip("missing-keys-or-event");
        return false;
      }
      const kind = Number(event.kind);
      if (kind !== NOSTR_KINDS.GIFT_WRAP && kind !== NOSTR_KINDS.DM) {
        logSkip("unsupported-kind");
        return false;
      }

      const myPubkey = keys.pkHex.toLowerCase();
      const eventId = String(event.id || `${event.pubkey}:${event.created_at}:${kind}`).trim();
      if (!eventId) {
        logSkip("empty-event-id");
        return false;
      }
      if (seenIdsRef.current.has(eventId)) {
        logSkip("duplicate-event");
        return false;
      }

      if (kind === NOSTR_KINDS.GIFT_WRAP) {
        if (!Array.isArray(event.tags)) {
          logSkip("giftwrap-no-tags");
          return false;
        }
        const recipientTags = event.tags
          .filter((tag) => tag?.[0] === "p")
          .map((tag) => String(tag?.[1] || "").toLowerCase())
          .filter(Boolean);
        if (!recipientTags.includes(myPubkey)) {
          logSkip("giftwrap-recipient-mismatch", { recipientTag: recipientTags[0], myPubkey });
          return false;
        }
        seenIdsRef.current.add(eventId);

        if (typeof event.created_at === "number") {
          updateLastSeen(myPubkey, event.created_at);
        }

        let opened: {
          content: string;
          senderPubkey: string;
          createdAt: number;
          senderEmail?: string;
        };
        try {
          opened = openNip17GiftWrap(event, keys.sk);
        } catch (error: unknown) {
          logDecryptFailure("giftwrap", {
            eventId: event.id,
            pubkey: event.pubkey,
            error: (error instanceof Error ? error.message : null) || "unknown",
          });
          return true;
        }

        return acceptOpenedMessage("giftwrap", eventId, opened, event.created_at);
      }

      if (Array.isArray(event.tags)) {
        const recipientTags = event.tags
          .filter((tag) => tag?.[0] === "p")
          .map((tag) => String(tag?.[1] || "").toLowerCase())
          .filter(Boolean);
        if (recipientTags.length > 0 && !recipientTags.includes(myPubkey)) {
          logSkip("kind4-recipient-mismatch", { recipientTag: recipientTags[0], myPubkey });
          return false;
        }
      }
      seenIdsRef.current.add(eventId);

      if (typeof event.created_at === "number") {
        updateLastSeen(myPubkey, event.created_at);
      }

      let opened: {
        content: string;
        senderPubkey: string;
        createdAt: number;
        senderEmail?: string;
      };
      try {
        opened = openNip04DirectMessage(event, keys.sk);
      } catch (error: unknown) {
        logDecryptFailure("kind4", {
          eventId: event.id,
          pubkey: event.pubkey,
          error: (error instanceof Error ? error.message : null) || "unknown",
        });
        return true;
      }

      return acceptOpenedMessage("kind4", eventId, opened, event.created_at);
    },
    [acceptOpenedMessage, keys, logDecryptFailure, updateLastSeen],
  );

  useEffect(() => {
    let cancelled = false;
    if (!visible) return;
    logWithId(
      `${LOG_EMOJI.auth} Support.chat`,
      "opened",
      {
        lockToSupport,
        supportNpub: shortHex(supportPubkey, 10, 6),
      },
      { context: "user" },
    );
    setStatus(null);
    (async () => {
      try {
        const pair = keypairOverride ?? (await getOrCreateNostrKeypair());
        if (!cancelled) {
          if (!keypairOverride) {
            try {
              await storeAuthData(NOSTR_PUBKEY_CACHE_KEY, pair.pkHex);
            } catch {
              // Best-effort cache write
            }
          }
          setKeys(pair);
          void ensureDmRelayListPublished(pair.sk);
          logWithId(
            `${LOG_EMOJI.auth} Support.chat`,
            "keys ready",
            {
              npub: shortHex(pair.npub, 12, 8),
              pubkey: shortHex(pair.pkHex),
            },
            { context: "background" },
          );
        }
      } catch (e: unknown) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : null;
          setStatus(
            msg
              ? t("screen.NostrChatModal.keyErrorWithMessage", { message: msg })
              : t("screen.NostrChatModal.keyError"),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keypairOverride, lockToSupport, setStatus, supportPubkey, visible]);

  useEffect(() => {
    EventBus.emit("support:chatActive", { active: visible });
  }, [visible]);

  useEffect(() => {
    if (!visible || !supportHex || !messagesLoaded || !lastReadLoaded) return;
    void setCachedSupportUnreadCount(supportUnreadCount);
    EventBus.emit("support:unreadCount", supportUnreadCount);
  }, [lastReadLoaded, messagesLoaded, supportHex, supportUnreadCount, visible]);

  useEffect(() => {
    let cancelled = false;
    if (!visible) {
      setLastReadLoaded(false);
      return;
    }
    (async () => {
      try {
        const raw = await getAuthData(NOSTR_LAST_READ_CACHE_KEY);
        if (cancelled) return;
        const next: Record<string, number> = {};
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
              if (!/^[0-9a-f]{64}$/.test(key)) return;
              if (typeof value !== "number") return;
              next[key.toLowerCase()] = value;
            });
          }
        }
        setLastReadByCounterparty(next);
      } catch {
        if (!cancelled) setLastReadByCounterparty({});
      } finally {
        if (!cancelled) setLastReadLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  useEffect(() => {
    if (!activeRecipient) return;
    const latestIncoming = messages
      .filter((message) => !message.outgoing && message.counterparty === activeRecipient)
      .reduce((max, msg) => Math.max(max, msg.createdAt), 0);
    if (latestIncoming) {
      updateLastRead(activeRecipient, latestIncoming);
    }
  }, [activeRecipient, messages, updateLastRead]);

  useEffect(() => {
    let cancelled = false;
    if (!visible) return;
    (async () => {
      try {
        const eoa = await getEthereumAddress();
        if (!cancelled && eoa) {
          setSenderEoaAddress(eoa);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  useEffect(() => {
    let cancelled = false;
    if (!visible || messagesLoaded) return;
    (async () => {
      try {
        const raw = await getAuthData(NOSTR_MESSAGES_CACHE_KEY);
        let next: ChatMessage[] = [];
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            next = parsed.map(normalizeCachedMessage).filter(Boolean) as ChatMessage[];
          }
        }
        const trimmed = trimMessages(next);
        if (!cancelled) {
          if (trimmed.length > 0) {
            setMessages(trimmed);
            seenIdsRef.current = new Set(trimmed.map((msg) => msg.id));
          }
          setMessagesLoaded(true);
        }
      } catch {
        if (!cancelled) setMessagesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messagesLoaded, visible]);

  useEffect(() => {
    let cancelled = false;
    if (!visible || !supportHex) return;
    (async () => {
      const count = await getSupportUnreadCount(supportHex);
      if (!cancelled) {
        void setCachedSupportUnreadCount(count);
        EventBus.emit("support:unreadCount", count);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supportHex, visible]);

  useEffect(() => {
    let cancelled = false;
    if (!visible) return;
    (async () => {
      try {
        const raw = await getAuthData(NOSTR_CONTACT_PROTOCOLS_CACHE_KEY);
        if (cancelled || !raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return;
        const next: Record<string, ContactProtocol> = {};
        Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
          const normalized = String(key || "")
            .trim()
            .toLowerCase();
          if (!/^[0-9a-f]{64}$/.test(normalized)) return;
          if (value !== "giftwrap" && value !== "kind4") return;
          next[normalized] = value;
        });
        if (!cancelled) {
          setProtocolByContact(next);
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  useEffect(() => {
    if (!messagesLoaded) return;
    const trimmed = trimMessages(messages);
    void storeAuthData(NOSTR_MESSAGES_CACHE_KEY, JSON.stringify(trimmed));
  }, [messages, messagesLoaded]);

  useEffect(() => {
    let cancelled = false;
    if (!visible || !keys || !messagesLoaded) return;
    (async () => {
      try {
        const raw = await getAuthData(NOSTR_SUPPORT_PENDING_EVENTS_CACHE_KEY);
        if (cancelled || !raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        const remaining: NostrEvent[] = [];
        let updated = false;
        const minCreatedAtSec = Math.floor(Date.now() / 1000) - RELAY_SUBSCRIPTION_WINDOW_SEC;
        parsed.forEach((item) => {
          if (!item || typeof item !== "object") {
            updated = true;
            return;
          }
          const event = item as NostrEvent;
          if (typeof event.created_at !== "number" || event.created_at < minCreatedAtSec) {
            updated = true;
            return;
          }
          const eventId = String(event.id || "").trim();
          if (!eventId) {
            updated = true;
            return;
          }
          const kind = Number(event.kind);
          if (kind !== NOSTR_KINDS.GIFT_WRAP && kind !== NOSTR_KINDS.DM) {
            updated = true;
            return;
          }
          if (seenIdsRef.current.has(eventId)) {
            updated = true;
            return;
          }
          const consumed = handleIncomingNostrEvent(event);
          if (!consumed) {
            remaining.push(event);
          } else {
            updated = true;
          }
        });
        if (!cancelled && updated) {
          await storeAuthData(NOSTR_SUPPORT_PENDING_EVENTS_CACHE_KEY, JSON.stringify(remaining));
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [handleIncomingNostrEvent, keys, messagesLoaded, visible]);

  useEffect(() => {
    let cancelled = false;
    if (!visible) {
      setLastSeenLoaded(false);
      return;
    }
    (async () => {
      try {
        const raw = await getAuthData(NOSTR_LAST_SEEN_CACHE_KEY);
        if (cancelled) return;
        const next: Record<string, number> = {};
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
              if (!/^[0-9a-f]{64}$/.test(key)) return;
              if (typeof value !== "number") return;
              next[key.toLowerCase()] = value;
            });
          }
        }
        setLastSeenByPubkey(next);
      } catch {
        if (!cancelled) setLastSeenByPubkey({});
      } finally {
        if (!cancelled) setLastSeenLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  useEffect(() => {
    let cancelled = false;
    if (!visible) return;
    (async () => {
      try {
        const raw = await getAuthData(NOSTR_CONTACTS_CACHE_KEY);
        let next: NostrContact[] = [];
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            next = parsed
              .map((item: unknown) => {
                if (!item || typeof item !== "object") return null;
                const record = item as Record<string, unknown>;
                const pubkey = String(record.pubkey || "").toLowerCase();
                if (!/^[0-9a-f]{64}$/.test(pubkey)) return null;
                const npub = toNpubSafe(pubkey);
                if (!npub) return null;
                const label =
                  String(record.label || "").trim() ||
                  t("screen.NostrChatModal.userWithSuffix", { suffix: npub.slice(-5) });
                const addedAt = typeof record.addedAt === "number" ? record.addedAt : Date.now();
                return { pubkey, npub, label, addedAt };
              })
              .filter(Boolean) as NostrContact[];
          }
        }
        if (supportHex) {
          const supportNpub = toNpubSafe(supportHex);
          if (supportNpub) {
            const existingIndex = next.findIndex((contact) => contact.pubkey === supportHex);
            if (existingIndex >= 0) {
              next[existingIndex] = {
                ...next[existingIndex],
                label: SUPPORT_CONTACT_LABEL,
                npub: supportNpub,
              };
            } else {
              next.push({
                pubkey: supportHex,
                npub: supportNpub,
                label: SUPPORT_CONTACT_LABEL,
                addedAt: Date.now(),
              });
            }
          }
        }
        next.sort((a, b) => b.addedAt - a.addedAt);
        if (!cancelled) {
          setContacts(next);
        }
        void persistContacts(next);
      } catch {
        if (!cancelled) setContacts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persistContacts, supportHex, visible]);

  useEffect(() => {
    if (!visible) {
      initRef.current = false;
      setMessageInput("");
      setStatus(null);
      if (supportDumpResetTimerRef.current) {
        clearTimeout(supportDumpResetTimerRef.current);
        supportDumpResetTimerRef.current = null;
      }
      setSupportDumpState("idle");
      pendingSendStateRef.current.forEach((state) => {
        if (state.timeoutHandle) {
          clearTimeout(state.timeoutHandle);
        }
      });
      pendingSendStateRef.current.clear();
      pendingSendMetaRef.current.clear();
      logWithId(`${LOG_EMOJI.auth} Support.chat`, "closed", undefined, { context: "user" });
      return;
    }
    if (initRef.current) return;
    initRef.current = true;
    if (supportHex) {
      setActiveRecipient(supportHex);
      upsertContact(supportHex, SUPPORT_CONTACT_LABEL);
      logWithId(
        `${LOG_EMOJI.auth} Support.chat`,
        "recipient set",
        {
          recipientHex: shortHex(supportHex),
          recipientNpub: shortHex(toNpubSafe(supportHex), 12, 8),
        },
        { context: "user" },
      );
    } else if (lockToSupport) {
      setStatus(
        String(supportPubkey || "").trim()
          ? t("screen.NostrChatModal.supportKeyInvalid")
          : t("screen.NostrChatModal.supportKeyNotConfigured"),
      );
      console.warn("[NostrChatModal] Support key missing/invalid", { supportPubkey });
    } else if (String(supportPubkey || "").trim()) {
      setStatus(t("screen.NostrChatModal.supportKeyInvalid"));
      console.warn("[NostrChatModal] Support key invalid", { supportPubkey });
    }
  }, [lockToSupport, setStatus, supportHex, supportPubkey, upsertContact, visible]);

  const handleSendSupportDump = useCallback(async () => {
    if (supportDumpState === "sending") return;
    if (!supportHex || activeRecipient !== supportHex) {
      setStatus(t("screen.NostrChatModal.openNuriChatToShareLogs"));
      return;
    }
    if (!keys) {
      setStatus(t("screen.NostrChatModal.keysNotReadyYet"));
      return;
    }

    if (supportDumpResetTimerRef.current) {
      clearTimeout(supportDumpResetTimerRef.current);
      supportDumpResetTimerRef.current = null;
    }
    setSupportDumpState("sending");

    try {
      console.log("[NostrChatModal] Support dump requested", {
        recipient: `${supportHex.slice(0, 12)}…${supportHex.slice(-6)}`,
        relays: relayList.length,
      });

      const res = await sendSupportDump({
        supportPubkey,
        relayUrls: relayList,
        senderKeypair: keys,
        senderIdentifierOverride: senderEoaAddress ?? undefined,
        includePersonalData: true,
        appSnapshot: { activeTab: "support_chat" },
      });

      if (res.relaysAckedOk <= 0) {
        throw new Error(t("screen.NostrChatModal.relayAcceptanceUnconfirmed"));
      }

      setSupportDumpState("sent");
      supportDumpResetTimerRef.current = setTimeout(() => {
        setSupportDumpState("idle");
        supportDumpResetTimerRef.current = null;
      }, 1500);
      console.log("[NostrChatModal] Support dump sent", {
        dumpId: res.dumpId,
        chunksSent: res.chunksSent,
        relaysAckedOk: res.relaysAckedOk,
        usedEphemeralNostrKey: res.usedEphemeralNostrKey,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? String(e.message) : "Send failed";
      setSupportDumpState("error");
      supportDumpResetTimerRef.current = setTimeout(() => {
        setSupportDumpState("idle");
        supportDumpResetTimerRef.current = null;
      }, 2000);
      console.warn("[NostrChatModal] Support dump failed", { error: msg });
    }
  }, [
    activeRecipient,
    keys,
    relayList,
    senderEoaAddress,
    setStatus,
    supportHex,
    supportPubkey,
    supportDumpState,
  ]);

  useEffect(() => {
    if (!visible || !supportHex || !keys) return;
    if (isSupportUser) {
      if (activeRecipient === supportHex) {
        setActiveRecipient(null);
      }
      return;
    }
    if (!activeRecipient) {
      setActiveRecipient(supportHex);
      upsertContact(supportHex, SUPPORT_CONTACT_LABEL);
    }
  }, [activeRecipient, isSupportUser, keys, supportHex, upsertContact, visible]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: _lastSeenByPubkey is intentionally omitted — it's only read on initial connect and including it would tear down all relay sockets on every incoming message
  useEffect(() => {
    if (!visible || !keys || !lastSeenLoaded) return;
    const subId = `dm-${keys.pkHex.slice(0, 8)}-${Date.now()}`;
    relayEoseSeenRef.current = new Set();

    const handleMessage = (raw: string, relayUrl: string) => {
      const finalizePendingSend = (
        eventId: string,
        status: "accepted" | "rejected" | "timeout",
        state: PendingSendState,
      ) => {
        if (state.timeoutHandle) {
          clearTimeout(state.timeoutHandle);
          state.timeoutHandle = null;
        }
        pendingSendStateRef.current.delete(eventId);
        const meta = pendingSendMetaRef.current.get(eventId);
        pendingSendMetaRef.current.delete(eventId);

        if (status === "accepted") {
          markMessageDelivery(eventId, "sent");
          setTransientStatus(
            t("screen.NostrChatModal.sentRelayAccepted", {
              ok: state.okCount,
              attempted: state.attemptedRelays,
            }),
          );
        } else if (status === "rejected") {
          markMessageDelivery(eventId, "failed");
          const reason = state.lastRejectReason || t("screen.NostrChatModal.unknownReason");
          setStatus(t("screen.NostrChatModal.relayRejected", { reason }));
        } else {
          markMessageDelivery(eventId, "pending");
          setStatus(
            t("screen.NostrChatModal.deliveryPendingNoAck", {
              attempted: state.attemptedRelays,
            }),
          );
        }

        logWithId(
          `${LOG_EMOJI.network} Nostr.send`,
          `relay ${status}`,
          {
            eventId: shortHex(eventId, 8, 6),
            attempted: state.attemptedRelays,
            responded: state.respondedRelays.size,
            ok: state.okCount,
            rejected: state.rejectCount,
            reason: state.lastRejectReason || undefined,
            from: shortHex(meta?.fromHex || "", 8, 6),
            to: shortHex(meta?.toHex || "", 8, 6),
          },
          { context: "background" },
        );
      };

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        logWithId(
          `${LOG_EMOJI.network} Nostr.relay`,
          "parse failed",
          { relay: relayHost(relayUrl) },
          { context: "background" },
        );
        return;
      }
      if (!Array.isArray(parsed) || parsed.length < 3) return;
      const type = parsed[0];
      if (type === "EVENT") {
        handleIncomingNostrEvent(parsed[2] as NostrEvent);
        return;
      }
      if (type === "EOSE") {
        if (!relayEoseSeenRef.current.has(relayUrl)) {
          relayEoseSeenRef.current.add(relayUrl);
        }
        return;
      }
      if (type === "OK") {
        const eventId = typeof parsed[1] === "string" ? parsed[1] : "";
        const ok = Boolean(parsed[2]);
        const reason = typeof parsed[3] === "string" ? parsed[3] : "";
        const pending = pendingSendStateRef.current.get(eventId);

        if (!eventId || !pending) {
          return;
        }

        if (!pending.respondedRelays.has(relayUrl)) {
          pending.respondedRelays.add(relayUrl);
          if (ok) {
            pending.okCount += 1;
          } else {
            pending.rejectCount += 1;
            pending.lastRejectReason = String(reason || "").trim() || pending.lastRejectReason;
          }
        }

        if (pending.okCount > 0) {
          finalizePendingSend(eventId, "accepted", pending);
          return;
        }

        if (pending.respondedRelays.size >= pending.attemptedRelays) {
          finalizePendingSend(eventId, "rejected", pending);
          return;
        }
        return;
      }
      if (type === "NOTICE") {
        const notice =
          typeof parsed[1] === "string" ? parsed[1] : t("screen.NostrChatModal.relayNotice");
        setStatus(notice);
        return;
      }
    };

    const sockets = new Map<string, WebSocket>();
    const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let disposed = false;

    const logRelayLifecycle = (
      stage: "connected" | "subscribed" | "closed",
      url: string,
      extra?: Record<string, unknown>,
    ) => {
      const host = relayHost(url);
      const key = `${stage}:${host}`;
      const now = Date.now();
      const previous = relayLifecycleLogRef.current.get(key) || 0;
      if (now - previous < 15_000) return;
      relayLifecycleLogRef.current.set(key, now);
      if (relayLifecycleLogRef.current.size > 120) {
        const entries = Array.from(relayLifecycleLogRef.current.entries())
          .sort((a, b) => a[1] - b[1])
          .slice(0, 30);
        entries.forEach(([k]) => relayLifecycleLogRef.current.delete(k));
      }
      logWithId(`${LOG_EMOJI.auth} Nostr.relay`, `${stage} ${host}`, extra, {
        context: "background",
      });
    };

    const scheduleReconnect = (url: string, delayMs = 2500) => {
      if (disposed) return;
      const prev = reconnectTimers.get(url);
      if (prev) {
        clearTimeout(prev);
      }
      const timer = setTimeout(() => {
        reconnectTimers.delete(url);
        connectRelay(url);
      }, delayMs);
      reconnectTimers.set(url, timer);
    };

    const connectRelay = (url: string) => {
      if (disposed) return;
      try {
        const ws = new WebSocket(url);
        sockets.set(url, ws);
        socketsRef.current.set(url, ws);
        ws.onopen = () => {
          if (disposed) return;
          logRelayLifecycle("connected", url);
          const nowSec = Math.floor(Date.now() / 1000);
          const selfPubkey = keys.pkHex.toLowerCase();
          const cachedSinceRaw =
            typeof _lastSeenByPubkey[selfPubkey] === "number" ? _lastSeenByPubkey[selfPubkey] : 0;
          const cachedSince = Math.max(0, Math.floor(cachedSinceRaw) - RELAY_SUBSCRIPTION_SKEW_SEC);
          const windowSince = Math.max(0, nowSec - RELAY_SUBSCRIPTION_WINDOW_SEC);
          const since = cachedSince > 0 ? Math.max(windowSince, cachedSince) : windowSince;
          const filters: Array<Record<string, unknown>> = [
            {
              kinds: [NOSTR_KINDS.GIFT_WRAP],
              "#p": [keys.pkHex],
              since,
              limit: RELAY_SUBSCRIPTION_LIMIT,
            },
            {
              kinds: [NOSTR_KINDS.DM],
              "#p": [keys.pkHex],
              since,
              limit: RELAY_SUBSCRIPTION_LIMIT,
            },
          ];
          if (supportHex) {
            filters.push({
              kinds: [NOSTR_KINDS.DM],
              authors: [supportHex],
              since,
              limit: RELAY_SUBSCRIPTION_LIMIT,
            });
          }
          ws.send(JSON.stringify(["REQ", subId, ...filters]));
          logRelayLifecycle("subscribed", url, {
            filters: filters.length,
            since,
            limit: RELAY_SUBSCRIPTION_LIMIT,
            pubkey: shortHex(keys.pkHex),
          });
        };
        ws.onclose = () => {
          sockets.delete(url);
          socketsRef.current.delete(url);
          logRelayLifecycle("closed", url);
          scheduleReconnect(url);
        };
        ws.onerror = () => {
          console.warn("[NostrChatModal] Relay error", url);
        };
        ws.onmessage = (event) => {
          if (typeof event.data === "string") handleMessage(event.data, url);
        };
      } catch {
        console.warn("[NostrChatModal] Relay init failed", url);
        scheduleReconnect(url, 3000);
      }
    };

    socketsRef.current = new Map();
    relayList.forEach((url) => connectRelay(url));

    return () => {
      disposed = true;
      reconnectTimers.forEach((timer) => clearTimeout(timer));
      reconnectTimers.clear();
      sockets.forEach((ws) => {
        try {
          ws.close();
        } catch {}
      });
      sockets.clear();
      socketsRef.current = new Map();
    };
  }, [
    handleIncomingNostrEvent,
    keys,
    lastSeenLoaded,
    markMessageDelivery,
    relayList,
    supportHex,
    visible,
  ]);

  const handleSend = (override?: unknown) => {
    if (!keys) {
      setStatus(t("screen.NostrChatModal.keysNotReady"));
      console.warn("[NostrChatModal] Send failed: keys not ready");
      return;
    }
    if (!activeRecipient) {
      setStatus(t("screen.NostrChatModal.pickRecipient"));
      console.warn("[NostrChatModal] Send failed: no recipient");
      return;
    }
    if (activeRecipient === keys.pkHex.toLowerCase()) {
      setStatus(t("screen.NostrChatModal.cannotMessageYourself"));
      console.warn("[NostrChatModal] Send blocked: recipient is self");
      return;
    }
    const text = (typeof override === "string" ? override : messageInput).trim();
    if (!text) return;

    // Fallback when the EOA hasn't been bootstrapped yet — should be rare in
    // practice, but we still let the message through so the user can reach support.
    const senderIdentifier = senderEoaAddress ?? "undefined_user";

    const isSupportRecipient = Boolean(supportHex && activeRecipient === supportHex);
    const useKind4 = Boolean(!isSupportRecipient && protocolByContact[activeRecipient] === "kind4");
    let outboundEvent: NostrEvent;
    let outboundProtocol: ContactProtocol;
    // TODO: rename the 4th arg + nostr rumor tag from "email" to "address" across
    // lib/nostr/nostr.ts and the nostr-telegram bridge (now in nuri-servers; currently
    // we pass an EOA through a parameter still named senderEmail).
    try {
      if (useKind4) {
        outboundEvent = createNip04DirectMessage(text, activeRecipient, keys.sk, senderIdentifier);
        outboundProtocol = "kind4";
        markContactProtocol(activeRecipient, "kind4");
      } else {
        outboundEvent = createNip17GiftWrap(text, activeRecipient, keys.sk, senderIdentifier);
        outboundProtocol = "giftwrap";
        markContactProtocol(activeRecipient, "giftwrap");
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : null;
      setStatus(
        errMsg
          ? t("screen.NostrChatModal.sendErrorWithMessage", { message: errMsg })
          : t("screen.NostrChatModal.sendError"),
      );
      return;
    }

    const eventId = outboundEvent.id || `${keys.pkHex}:${activeRecipient}:${Date.now()}`;
    logWithId(
      `${LOG_EMOJI.network} Nostr.send`,
      "outbound prepared",
      {
        eventId: shortHex(eventId, 8, 6),
        kind: outboundEvent.kind,
        protocol: outboundProtocol,
        to: shortHex(activeRecipient, 8, 6),
        messageLength: text.length,
      },
      { context: "user" },
    );
    markMessageDelivery(eventId, "pending");
    const payload = JSON.stringify(["EVENT", outboundEvent]);
    const pendingState: PendingSendState = {
      attemptedRelays: 0,
      respondedRelays: new Set<string>(),
      okCount: 0,
      rejectCount: 0,
      lastRejectReason: "",
      timeoutHandle: null,
    };

    let sent = false;
    socketsRef.current.forEach((ws, relayUrl) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
          sent = true;
          pendingState.attemptedRelays += 1;
        } catch (error: unknown) {
          logWithId(
            `${LOG_EMOJI.network} Nostr.send`,
            "relay send failed",
            {
              relay: relayHost(relayUrl),
              eventId: shortHex(eventId, 8, 6),
              error: (error instanceof Error ? error.message : null) || "unknown",
            },
            { context: "background" },
          );
        }
      }
    });

    if (!sent || pendingState.attemptedRelays <= 0) {
      // Sockets often aren't connected yet on the very first send (e.g. auto-report
      // right when the chat opens). The direct-publish fallback below delivers it,
      // so show a plain "Sending…" instead of a scary "no relay" status.
      setStatus(t("screen.NostrChatModal.sending"));
      logWithId(
        `${LOG_EMOJI.network} Nostr.send`,
        "no live socket; direct publish fallback",
        { eventId: shortHex(eventId, 8, 6) },
        { context: "background" },
      );
      void (async () => {
        const directRelayUrls = Array.from(
          new Set(relayList.map((url) => String(url || "").trim()).filter(Boolean)),
        );
        if (directRelayUrls.length <= 0) {
          markMessageDelivery(eventId, "failed");
          setStatus(t("screen.NostrChatModal.noRelayUrlsConfigured"));
          return;
        }
        const results = await Promise.all(
          directRelayUrls.map((relayUrl) => publishEventToRelay(relayUrl, outboundEvent)),
        );
        const opened = results.filter((result) => result.opened).length;
        const okCount = results.filter((result) => result.ok).length;
        if (okCount > 0) {
          markMessageDelivery(eventId, "sent");
          setTransientStatus(
            t("screen.NostrChatModal.sentRelayAccepted", {
              ok: okCount,
              attempted: results.length,
            }),
          );
        } else if (opened > 0) {
          markMessageDelivery(eventId, "pending");
          setStatus(t("screen.NostrChatModal.deliveryPendingNoAck", { attempted: results.length }));
        } else {
          markMessageDelivery(eventId, "failed");
          setStatus(t("screen.NostrChatModal.noRelayConnectionAvailable"));
        }
        const failures = results.filter((result) => !result.ok).length;
        logWithId(
          `${LOG_EMOJI.network} Nostr.send`,
          "direct publish result",
          {
            eventId: shortHex(eventId, 8, 6),
            protocol: outboundProtocol,
            tried: results.length,
            opened,
            ok: okCount,
            failed: failures,
          },
          { context: "background" },
        );
      })();
    } else {
      pendingSendMetaRef.current.set(eventId, {
        fromHex: keys.pkHex,
        fromNpub: keys.npub,
        toHex: activeRecipient,
        toNpub: toNpubSafe(activeRecipient) || "",
        len: text.length,
      });
      pendingState.timeoutHandle = setTimeout(() => {
        const state = pendingSendStateRef.current.get(eventId);
        if (!state) return;
        if (state.timeoutHandle) {
          clearTimeout(state.timeoutHandle);
          state.timeoutHandle = null;
        }
        pendingSendStateRef.current.delete(eventId);
        pendingSendMetaRef.current.delete(eventId);
        if (state.okCount > 0) {
          markMessageDelivery(eventId, "sent");
          setTransientStatus(
            t("screen.NostrChatModal.sentRelayAccepted", {
              ok: state.okCount,
              attempted: state.attemptedRelays,
            }),
          );
        } else {
          markMessageDelivery(eventId, "pending");
          setStatus(
            t("screen.NostrChatModal.deliveryPendingNoAck", {
              attempted: state.attemptedRelays,
            }),
          );
        }
        logWithId(
          `${LOG_EMOJI.network} Nostr.send`,
          "relay ack timeout",
          {
            eventId: shortHex(eventId, 8, 6),
            attempted: state.attemptedRelays,
            responded: state.respondedRelays.size,
            ok: state.okCount,
            rejected: state.rejectCount,
            reason: state.lastRejectReason || undefined,
          },
          { context: "background" },
        );
      }, 9000);
      pendingSendStateRef.current.set(eventId, pendingState);
      setTransientStatus(t("screen.NostrChatModal.sending"));
      logWithId(
        `${LOG_EMOJI.network} Nostr.send`,
        "encrypted message sent",
        {
          eventId: shortHex(eventId, 8, 6),
          protocol: outboundProtocol,
          from: shortHex(keys.pkHex, 8, 6),
          to: shortHex(activeRecipient, 8, 6),
          relays: pendingState.attemptedRelays,
          messageLength: text.length,
        },
        { context: "user" },
      );
    }

    setMessages((prev) =>
      trimMessages([
        ...prev,
        {
          id: eventId,
          counterparty: activeRecipient,
          content: text,
          createdAt: Date.now(),
          outgoing: true,
          senderEmail: senderIdentifier,
        },
      ]),
    );
    if (typeof override !== "string") setMessageInput("");
  };

  // Auto-send a one-off support message (e.g. from reportErrorToSupport) once the chat is ready.
  const autoSentRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleSend is recreated each render; deps cover send readiness
  useEffect(() => {
    if (!visible) {
      autoSentRef.current = false;
      return;
    }
    const msg = autoSendMessage?.trim();
    if (!msg || autoSentRef.current) return;
    if (!keys || !supportHex || activeRecipient !== supportHex) return;
    autoSentRef.current = true;
    handleSend(msg);
  }, [visible, autoSendMessage, keys, supportHex, activeRecipient]);

  // Seed the composer once per open. Guarded so it can't clobber what the user
  // has already typed on a re-render.
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (!visible) {
      prefilledRef.current = false;
      return;
    }
    const msg = prefillMessage?.trim();
    if (!msg || prefilledRef.current) return;
    prefilledRef.current = true;
    setMessageInput(msg);
  }, [visible, prefillMessage]);

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const deliveryState = item.outgoing ? deliveryByMessageId[item.id] : undefined;
    const metaTime = formatMessageMetaTime(item.createdAt);
    const isIncomingSupport =
      !item.outgoing && Boolean(supportHex && item.counterparty === supportHex);

    return (
      <ChatBubble
        outgoing={item.outgoing}
        highlight={isIncomingSupport}
        timestamp={metaTime || undefined}
        deliveryState={deliveryState as "pending" | "sent" | "failed" | undefined}
      >
        {item.content}
      </ChatBubble>
    );
  };

  const displayStatus = statusTransient ? null : status;
  const isSupportChatActive = Boolean(supportHex && activeRecipient === supportHex);
  const shareLogsLabel =
    supportDumpState === "sent"
      ? t("screen.NostrChatModal.shareLogsSent")
      : supportDumpState === "sending"
        ? t("screen.NostrChatModal.shareLogsSending")
        : supportDumpState === "error"
          ? t("screen.NostrChatModal.shareLogsFailed")
          : t("screen.NostrChatModal.shareLogsLabel");

  const handleSwitchPasskey = () => {
    if (switchingPasskey) return;
    setSwitchingPasskey(true);
    void requestUserLogout().then((result) => {
      if (result === "failed") setSwitchingPasskey(false);
    });
  };

  return (
    <DsSheetHost visible={visible} onClose={onClose} mode="full">
      <Header safeAreaTop chrome="canvas">
        {/* The content lane shrinks to keep Close reachable on narrow screens. */}
        <Topbar surface="transparent" layout="fluid">
          {isSupportChatActive ? (
            <TopbarContent>
              <View direction="row" align="center" gap="xs" fill="grow-shrink">
                <Text
                  size="xs"
                  accessibilityLabel={t("screen.NostrChatModal.loadedVersion", {
                    version: getLoadedAppIdentity(),
                  })}
                  testID="support-loaded-version"
                >
                  {JS_RELEASE_VERSION}
                </Text>
                <Button
                  size="sm"
                  variant="soft"
                  fill="even"
                  disabled={switchingPasskey}
                  accessibilityLabel={t("screen.NostrChatModal.switchPasskey")}
                  onPress={() => setShowSwitchPasskeyConfirm(true)}
                >
                  <ButtonText>
                    {t(
                      switchingPasskey
                        ? "screen.NostrChatModal.switchingPasskey"
                        : "screen.NostrChatModal.switchPasskey",
                    )}
                  </ButtonText>
                </Button>
                <Button
                  size="sm"
                  variant="soft"
                  fill="even"
                  disabled={!keys || supportDumpState === "sending" || switchingPasskey}
                  onPress={() => void handleSendSupportDump()}
                  accessibilityLabel={t("screen.NostrChatModal.shareLogsAccessibilityLabel")}
                >
                  <ButtonText>{shareLogsLabel}</ButtonText>
                </Button>
              </View>
            </TopbarContent>
          ) : null}
          <TopbarTrailing>
            <IconButton
              icon="cross"
              variant="soft"
              accessibilityLabel={t("common.close")}
              onPress={onClose}
            />
          </TopbarTrailing>
        </Topbar>
      </Header>

      {/* Structural: FlatList is its own scroller, so it can't live inside the
        DS Scroll. The Header and the composer are flow siblings, so this body
        is exactly the box they leave over — the scroll viewport is already
        bounded above the composer and no message can render behind it. */}
      <RNView style={styles.body}>
        <FlatList
          data={visibleMessages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          contentContainerStyle={styles.messageList}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.messageListContainer}
          ref={listRef}
          onContentSizeChange={() => scrollToLatest(false)}
          ListFooterComponent={
            showV1MigrationLink ? (
              <Button
                size="lg"
                variant="solid"
                accent="lilac"
                onPress={() => EventBus.emit("app:openInternalLink", V1_WALLET_MIGRATION_LINK)}
              >
                <ButtonText>Migrate Funds</ButtonText>
              </Button>
            ) : keypairOverride && onCreatePasskey && autoSentRef.current ? (
              <View direction="column" align="stretch" gap="sm">
                <ChatBubble outgoing={false} highlight>
                  We updated Nuri, please create a new passkey here.
                </ChatBubble>
                {isNativePasskeyLoginAvailable() ? (
                  <Button
                    size="lg"
                    variant="solid"
                    accent="lilac"
                    disabled={nativePasskeyBusy}
                    onPress={() => void handleNativeCreatePasskey()}
                  >
                    <ButtonText>Create Passkey Wallet</ButtonText>
                  </Button>
                ) : (
                  <PasskeyWebAuthnPrfView
                    mode="create"
                    buttonLabel="Create Passkey Wallet"
                    label={newPasskeyLabel}
                    onAttemptStart={() => setStatus(null)}
                    onCreateResult={onCreatePasskey}
                    onError={setStatus}
                  />
                )}
              </View>
            ) : null
          }
        />
      </RNView>

      {/* The composer is a direct panel child, not wrapped in a manual
        keyboard-padding view: the DS Modal already shrinks the panel by the
        keyboard, so any padding here would double-offset it. */}
      <Footer
        safeAreaBottom
        chrome="canvas"
        direction="column"
        align="stretch"
        gap="sm"
        paddingBottom="sm"
        paddingX="lg"
      >
        {displayStatus ? (
          <Text size="md" muted align="center">
            {displayStatus}
          </Text>
        ) : null}
        <TextField
          value={messageInput}
          onChangeText={setMessageInput}
          onFocus={() => {
            setTimeout(() => scrollToLatest(false), 40);
          }}
          autoCapitalize="sentences"
        >
          {/* The DS TextField requires the label slot; the composer reuses the
            placeholder copy for it (a ghost placeholder would be redundant). */}
          <TextFieldLabel>{t("screen.NostrChatModal.typeMessagePlaceholder")}</TextFieldLabel>
          <TextFieldButton
            accessibilityLabel={t("screen.NostrChatModal.sendMessageAccessibilityLabel")}
            disabled={!messageInput.trim()}
            onPress={() => handleSend()}
          >
            {t("screen.NostrChatModal.sendButtonLabel")}
          </TextFieldButton>
        </TextField>
      </Footer>
      <LogoutConfirmSheet
        visible={showSwitchPasskeyConfirm}
        busy={switchingPasskey}
        onClose={() => setShowSwitchPasskeyConfirm(false)}
        onConfirm={handleSwitchPasskey}
      />
    </DsSheetHost>
  );
};

const styles = StyleSheet.create({
  body: {
    flex: 1,
    // Web: a flex child does not shrink below its content unless told to, which
    // is what lets the message list push the panel past the viewport.
    minHeight: 0,
  },
  messageListContainer: {
    flex: 1,
    minHeight: 0,
  },
  messageList: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    flexGrow: 1,
  },
});

export default NostrChatModal;
