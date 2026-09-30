// Shared list of "extra servers" (extra keychain service identifiers + extra
// AsyncStorage keys) that `wipeAllKeychainData` should clear on top of the
// canonical bitcoin/ethereum/auth slots. Used by both:
//   - SoftLogoutService.performSoftLogoutForRelogin (hint-preserving wipe)
//   - FactoryResetService.performFactoryReset (full wipe, no hint preserved)
// Keep this in sync; any leaky 3rd-party storage key MUST be added here, not
// inline at the call site.
import { BALANCE_CACHE_KEYS } from "../balance/BalanceCacheService";
import { WIREX_SNAPSHOT_CACHE_KEY } from "../wirex/WirexAccountService";
import { USERNAME_CLAIM_REQUIRED_KEY } from "../../lib/auth/usernameClaimSentinel";
import { V1_WALLET_MIGRATION_OLD_CREDENTIAL_ID_KEY } from "./V1WalletMigrationService";
import { DEV_DEVICES_STORAGE_KEY } from "../notifications/DevDeviceRegistry";
import {
  NOSTR_CONTACTS_CACHE_KEY,
  NOSTR_LAST_SEEN_CACHE_KEY,
  NOSTR_MESSAGES_CACHE_KEY,
  NOSTR_SENDER_EMAIL_CACHE_KEY,
  NOSTR_LAST_READ_CACHE_KEY,
  NOSTR_PUBKEY_CACHE_KEY,
  NOSTR_SUPPORT_UNREAD_CACHE_KEY,
  NOSTR_SUPPORT_SEEN_IDS_CACHE_KEY,
  NOSTR_SUPPORT_LAST_SYNC_CACHE_KEY,
  NOSTR_SUPPORT_PENDING_EVENTS_CACHE_KEY,
  NOSTR_CONTACT_PROTOCOLS_CACHE_KEY,
  NOSTR_ADDRESS_BOOK_CACHE_KEY,
} from "../../lib/nostr/storage";

export const WIPE_EXTRA_STORAGE_KEYS: string[] = [
  // legacy Gnosis/Monerium/migration cleanup (stacks removed)
  "gnosis_jwt_token",
  "gnosis_jwt_expiry",
  "gnosis_user_cards_cache",
  "monerium_access_token",
  "monerium_refresh_token",
  "monerium_access_token_expiry",
  "migration:pending:v1",
  V1_WALLET_MIGRATION_OLD_CREDENTIAL_ID_KEY,
  ...Object.values(BALANCE_CACHE_KEYS),
  WIREX_SNAPSHOT_CACHE_KEY,
  NOSTR_CONTACTS_CACHE_KEY,
  NOSTR_LAST_SEEN_CACHE_KEY,
  NOSTR_MESSAGES_CACHE_KEY,
  NOSTR_SENDER_EMAIL_CACHE_KEY,
  NOSTR_LAST_READ_CACHE_KEY,
  NOSTR_PUBKEY_CACHE_KEY,
  NOSTR_SUPPORT_UNREAD_CACHE_KEY,
  NOSTR_SUPPORT_SEEN_IDS_CACHE_KEY,
  NOSTR_SUPPORT_LAST_SYNC_CACHE_KEY,
  NOSTR_SUPPORT_PENDING_EVENTS_CACHE_KEY,
  NOSTR_CONTACT_PROTOCOLS_CACHE_KEY,
  NOSTR_ADDRESS_BOOK_CACHE_KEY,
  "wallet_mode", // legacy persisted flag; source module removed, key still wiped
  USERNAME_CLAIM_REQUIRED_KEY,
  DEV_DEVICES_STORAGE_KEY,
];

// NOTE: this list is passed to `wipeAllKeychainData`, which only resets Keychain
// entries — AsyncStorage is untouched by it. Anything living in AsyncStorage has
// to be cleared explicitly at the reset call sites (see
// `clearPushNotificationStorage`, `PendingPurchasesStore.clear`).
