# Nuri Support Messaging: Technical Architecture and Runtime Flow

Date: 2026-03-05  
Scope: Nuri in-app support chat, Nostr relay sync, Telegram bridge, 0x interoperability.

## 1. Goal

This system provides one support conversation plane across:

1. Nuri app users.
2. Nuri support operators inside the Nuri app.
3. External Nostr clients (for example 0xChat).
4. Telegram support operations via bridge bot.

The support identity is the hardcoded support npub in the app (`App.tsx`), and all channels converge through Nostr events.

## 2. Core Components

1. Support modal UI and live relay session: `components/NostrChatModal.tsx`
2. App-level support key and unread wiring: `App.tsx`
3. Background unread sync loop: `services/NostrUnreadSync.ts`
4. Nostr crypto/protocol primitives: `lib/nostr/nostr.ts`
5. Telegram bridge runtime: `nuri-servers/server-nostr-telegram/src/index.js`
6. Telegram bridge Nostr transport: `nuri-servers/server-nostr-telegram/src/nostr.js`
7. Telegram bridge state persistence: `nuri-servers/server-nostr-telegram/src/state.js`
8. Telegram bridge config loading: `nuri-servers/server-nostr-telegram/src/config.js`
9. Optional local relay service: `nuri-servers/server-nostr-relay/index.js`
10. Optional local relay store: `nuri-servers/server-nostr-relay/src/store.js`

## 3. Identity and Trust Boundaries

1. Support identity is anchored by one support npub hardcoded in app config.
2. Any sender that publishes encrypted events to support pubkey can reach support.
3. Telegram bridge holds support secret (`NOSTR_SUPPORT_NSEC`) and acts as a support-side publisher/subscriber.
4. Public relays are untrusted transport; confidentiality depends on end-to-end encryption.
5. Metadata exposure remains possible on relays (timing, tags, event ids).

## 4. Protocol Model

### 4.1 Event Kinds

1. Primary modern path: NIP-17 giftwrap (`kind: 1059`).
2. Legacy compatibility path: NIP-04 direct message (`kind: 4`).

### 4.2 Implementation Primitives (`lib/nostr/nostr.ts`)

1. `createNip17GiftWrap(...)`
2. `openNip17GiftWrap(...)`
3. `createNip04DirectMessage(...)`
4. `openNip04DirectMessage(...)`
5. `NOSTR_KINDS` exposes constants used by modal/sync/bridge.

### 4.3 Sender Metadata

1. Optional sender email is attached as an `["email", "..."]` tag in outbound events.
2. UI/bridge can surface email label for support operators.

## 5. Nuri App Runtime Flow

### 5.1 Entry and Session Initialization

1. User taps Live Chat.
2. `NostrChatModal` loads/creates Nostr keypair.
3. Auth pubkey cache is updated for unread services.
4. Modal emits `support:chatActive` on open/close.

### 5.2 Relay Subscription Strategy

Current constants in `NostrChatModal`:

1. `RELAY_SUBSCRIPTION_WINDOW_SEC = 14 days`
2. `RELAY_SUBSCRIPTION_SKEW_SEC = 24 hours`
3. `RELAY_SUBSCRIPTION_LIMIT = 1200`

For each relay connection:

1. Compute `since` from last-seen cache with skew.
2. Clamp by rolling window.
3. Subscribe to:
4. Giftwrap where `#p` includes current user.
5. Kind4 where `#p` includes current user.
6. Kind4 authored by support pubkey (if configured).

This avoids unbounded `since=0` loading while still catching backdated relay arrivals.

### 5.3 Inbound Event Handling

`handleIncomingNostrEvent(...)` pipeline:

1. Drop unsupported kinds.
2. Deduplicate by event id (`seenIdsRef`).
3. Validate recipient tags:
4. Giftwrap: requires any `p` tag matching current pubkey.
5. Kind4: if `p` tags exist, at least one must match current pubkey.
6. Decrypt/open by kind.
7. On decrypt errors, log via throttled `logDecryptFailure(...)`.
8. Normalize sender pubkey to lowercase hex.
9. Upsert contact metadata and message object.
10. Update last-seen timestamps.

Important recent reliability changes:

1. Matching all `p` tags (not first tag only).
2. Throttled decrypt-failure logging.
3. Stale pending event filtering.

### 5.4 Outbound Send Flow

On send button:

1. Validate keys, recipient, email, non-empty content.
2. Select protocol:
3. If recipient protocol is known legacy kind4 and not support thread -> kind4.
4. Else default to giftwrap.
5. Build signed event payload.
6. Broadcast `["EVENT", ...]` to active sockets.
7. Track delivery state (`pending/sent/failed`) per event id.
8. Persist outbound locally as pending/in-message list.

### 5.5 Chat List Construction and Ordering

1. Build last-message index by counterparty.
2. Build list from contacts plus support special row.
3. For support users, include discovered counterparties from messages.
4. Sort order:
5. Latest message time descending.
6. Then contact added time descending.
7. Then label.

Unread counts do not reorder list ahead of recency.

### 5.6 Support Sync Indicator

For support user list view:

1. Header shows `loaded chats X`.
2. While relays still syncing, shows `loaded chats X · syncing done/total`.
3. Driven by relay EOSE progress state.

## 6. App-Level Unread Sync Service

`services/NostrUnreadSync.ts` runs background unread counting.

Core behavior:

1. Relay set includes backup relay env + default public relays.
2. Poll interval: `30s`.
3. Sync window: `7 days`.
4. Last sync skew: `120s`.
5. Per-relay websocket request with timeout.
6. Pulls giftwrap + kind4 addressed to cached user pubkey.
7. Tracks seen ids and pending ids in secure storage.
8. Emits `support:unreadCount` through EventBus.

Lifecycle integration:

1. `App.tsx` starts/stops unread sync by app state.
2. Chat modal activity suppresses background unread drift via `support:chatActive`.

## 7. Telegram Bridge Architecture

### 7.1 Startup and Configuration

`nuri-servers/server-nostr-telegram/src/config.js`:

1. Requires `TELEGRAM_BOT_TOKEN`.
2. Requires `NOSTR_SUPPORT_NSEC`.
3. Loads relay list (`NOSTR_RELAYS` or fallback relay set).
4. Optional `NOSTR_LOCAL_RELAY_URL` prepended.
5. Defaults:
6. `nostrSyncWindowSec = 7 days`
7. `nostrSyncLimit = 120`
8. `telegramPollTimeoutSec = 25`

### 7.2 Persistent State

`state.js` stores:

1. `seenEventIds`
2. `topicByPubkey` and `pubkeyByTopic`
3. `pubkeyByTelegramMessageId`
4. `telegramOffset`
5. `telegramChatId`

This is the routing memory for thread/topic continuity.

### 7.3 Nostr -> Telegram

In `index.js`:

1. Bridge subscribes as support account.
2. For inbound event:
3. Deduplicate via `seenEventIds`.
4. Decrypt/open (giftwrap or kind4).
5. Resolve sender pubkey.
6. Find or create Telegram topic for sender.
7. Forward formatted text to Telegram.
8. Save mapping from Telegram message id -> sender pubkey.

### 7.4 Telegram -> Nostr

1. Receive Telegram updates.
2. Resolve target pubkey from:
3. Topic id mapping, or
4. Reply-to message mapping.
5. Publish encrypted reply via `publishGiftwrap(...)`.
6. Nuri app / 0x clients receive as standard support message.

## 8. Local Nostr Relay (Optional Service)

`nuri-servers/server-nostr-relay` provides:

1. Event ingestion (`EVENT`) with duplicate checks.
2. Query subscription (`REQ`) by filters.
3. Backlog replay followed by `EOSE`.
4. Acknowledgements via `OK`.
5. On-disk event storage with max-event bounds.

Useful for controlled environments and debugging; production can run on public relays.

## 9. End-to-End Message Paths

### 9.1 Nuri User -> Support

1. User sends from modal.
2. Event hits relays.
3. Support app and bridge subscriptions consume event.
4. Thread appears in support list sorted by newest message.

### 9.2 Support (Nuri) -> Nuri User

1. Support opens user thread.
2. Sends reply.
3. User receives/decrypts in app.

### 9.3 0x -> Support

1. 0x sends to support npub.
2. Bridge receives and forwards to Telegram topic.
3. Support app receives if in subscription window and decryptable.

### 9.4 Telegram Reply -> Nuri and 0x

1. Operator replies in mapped topic.
2. Bridge resolves recipient pubkey and publishes giftwrap.
3. Nuri and 0x clients subscribed to conversation receive reply.

## 10. Why Massive `Giftwrap open failed` Logs Happen

1. Public relays return many encrypted events unrelated to current private key.
2. Decrypt failures are expected noise unless valid recipient events consistently fail.
3. Modal now throttles failure logging to keep runtime readable.

## 11. Known Constraints

1. System prioritizes reliability for new/recent traffic.
2. Not optimized for full historical replay from all relays in one shot.
3. Large legacy history may not fully backfill under bounded windows.
4. Relay behavior is non-deterministic; multi-relay fanout is required.

## 12. Security Notes

1. Never log private keys, seed phrases, or passphrases.
2. Support nsec used by bridge must be protected as production secret.
3. State file (topic/pubkey mappings) should be backed up and protected.
4. Email tags are metadata and should be treated as user-provided content.

## 13. Operator Validation Checklist

1. Nuri user sends to support; appears in support Nuri list.
2. Same message appears in Telegram mapped topic.
3. Support reply from Nuri arrives back on user device.
4. Support reply from Telegram arrives in Nuri user chat.
5. 0x fresh account sends to support npub; appears in Telegram and Nuri.
6. Chat list remains newest-first with many threads.
7. Header sync hint advances (`syncing a/b`) then stabilizes.
8. No secret material appears in logs.

## 14. Troubleshooting Guide

1. Missing 0x message in Nuri but present in Telegram:
2. Verify support modal relay connections are active.
3. Confirm subscription window/skew covers event timestamp.
4. Confirm recipient pubkey is the support npub used in app.
5. Inspect decrypt failure rates for targeted event ids.

6. Cannot open older chats in very large lists:
7. Check relay sync progress indicator first.
8. Wait for EOSE completion across relays.
9. Consider reducing historical scope or increasing limit carefully.

10. Telegram reply not routed:
11. Verify topic/message mapping exists in bridge `state.json`.
12. Verify bridge is linked to correct Telegram chat id.
13. Verify bridge has valid support nsec and relay connectivity.

## 15. Files to Read First (Quick Onboarding)

1. `components/NostrChatModal.tsx`
2. `services/NostrUnreadSync.ts`
3. `lib/nostr/nostr.ts`
4. `nuri-servers/server-nostr-telegram/src/index.js`
5. `nuri-servers/server-nostr-telegram/src/state.js`
6. `App.tsx`
